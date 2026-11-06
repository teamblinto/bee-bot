import type { MemoryItem } from "@beebot/contracts";
import { expect, it } from "vite-plus/test";

import { memoryReview, visibleDetail } from "./labels";

it("shows characters that would hide or reorder a command, and leaves layout alone", () => {
  expect(visibleDetail("ls\n\tcat ‮gpj.exe\u0000")).toBe("ls\n\tcat [U+202E]gpj.exe[U+0000]");
});

const memory = (id: string, fields: Partial<MemoryItem>): MemoryItem => ({
  id,
  botId: "bot",
  type: "user",
  source: "agent",
  sourceRef: "run:run",
  status: "pending",
  created: "2026-11-06T10:15:00.000Z",
  supersededBy: null,
  text: id,
  ...fields,
});

it("shows what a pending request would do to its target", () => {
  const target = memory("t", { status: "active", text: "Likes tea" });
  const texts = (item: MemoryItem) => memoryReview(item, [target]).lines.map(({ text }) => text);

  expect(texts(memory("plain", { text: "Likes coffee" }))).toEqual(["Likes coffee"]);
  expect(texts(memory("s", { sourceRef: "supersede:t", text: "Likes coffee" }))).toEqual([
    "Likes tea",
    "Likes coffee",
  ]);
  expect(texts(memory("f", { sourceRef: "forget:t", text: "Out of date" }))).toEqual([
    "Likes tea",
    "Out of date",
  ]);
});

it("says so when the target of a pending request is no longer active", () => {
  const gone = [memory("t", { status: "pending", text: "Likes tea" })];
  const supersede = memoryReview(memory("s", { sourceRef: "supersede:t" }), gone);
  const forget = memoryReview(memory("f", { sourceRef: "forget:t" }), []);

  expect(supersede.title).toContain("adds this as new");
  expect(supersede.lines.map(({ text }) => text)).toEqual(["s"]);
  expect(forget.title).toContain("changes nothing");
});
