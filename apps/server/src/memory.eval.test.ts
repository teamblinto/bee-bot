import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MemoryType } from "@beebot/contracts";
import { expect, it } from "vite-plus/test";
import { z } from "zod";

import { writeMemoryFile } from "./memory.ts";
import { openEventStore } from "./store.ts";

const k = 3;
// "coffee order" misses on purpose: no shared word with "flat whites", which only an embedder bridges.
const minRecall = 0.9;

const Eval = z.object({
  memories: z.array(z.object({ key: z.string(), type: MemoryType, text: z.string() })),
  queries: z.array(z.object({ query: z.string(), relevant: z.array(z.string()).min(1) })),
});

// BM25 alone, the floor every install has: no embedder, no model.
it(`finds the right memory in the top ${k} by keyword alone`, () => {
  const fixture = Eval.parse(
    JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "fixtures", "memory-eval.json"),
        "utf8",
      ),
    ),
  );
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-eval-"));
  const store = openEventStore(dataDir);
  try {
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    const keys = new Map<string, string>();
    for (const { key, type, text } of fixture.memories) {
      const id = NodeCrypto.randomUUID();
      keys.set(id, key);
      writeMemoryFile(dataDir, {
        id,
        botId: bot.id,
        type,
        source: "user",
        sourceRef: "owner",
        status: "active",
        created: "2026-11-01T00:00:00.000Z",
        supersededBy: null,
        text,
        scope: "bot",
      });
    }
    store.rebuildIndex();

    const misses: string[] = [];
    const recalls = fixture.queries.map(({ query, relevant }) => {
      const top = store
        .searchMemory(bot.id, query)
        .flatMap((line) => keys.get(/^\[memory ([^ ]+) \|/.exec(line)?.[1] ?? "") ?? [])
        .slice(0, k);
      const found = relevant.filter((key) => top.includes(key)).length;
      if (found < relevant.length) {
        misses.push(`${query} -> ${top.join(", ")}`);
      }
      return found / relevant.length;
    });
    const recall = recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
    expect(recall, misses.join("\n")).toBeGreaterThanOrEqual(minRecall);
  } finally {
    store.close();
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  }
});
