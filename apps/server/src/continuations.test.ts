import { DatabaseSync } from "node:sqlite";

import type { EventBody } from "@beebot/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { type NewContinuation, openContinuations } from "./continuations.ts";
import { migrate } from "./store.ts";

let events: EventBody[];
let repo: ReturnType<typeof openContinuations>;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  events = [];
  repo = openContinuations(db, {
    transaction: (work) => work(),
    emit: (body) => events.push(body),
  });
});

const fields: NewContinuation = {
  botId: "bot",
  runId: "run",
  sessionId: "session",
  toolUseId: "tool-use",
  kind: "approval",
  tool: "send_mail",
  request: "{}",
  payload: '{"to":"ada@example.com"}',
  shown: "Send mail to ada@example.com",
  digest: "d1",
  ttlMs: 60_000,
};

describe("continuations", () => {
  it("runs an approved action once and resumes once", () => {
    const { id } = repo.openContinuation(fields);
    expect(repo.decideContinuation(id, "d1", "approve")).toBe("approved");
    expect(repo.decideContinuation(id, "d1", "approve")).toBe("closed");
    expect(repo.claimContinuation(id)?.status).toBe("claimed");
    expect(repo.claimContinuation(id)).toBeUndefined();
    expect(repo.finishContinuation(id, "succeeded", "sent")?.status).toBe("succeeded");
    expect(repo.unresumedContinuations().map((row) => row.id)).toEqual([id]);
    expect(repo.markResumed(id, "run-2")?.resumeRunId).toBe("run-2");
    expect(repo.markResumed(id, "run-3")).toBeUndefined();
    expect(repo.unresumedContinuations()).toEqual([]);
  });

  it("refuses a decision on anything but what was shown", () => {
    const { id } = repo.openContinuation(fields);
    expect(repo.decideContinuation(id, "other", "approve")).toBe("digest_mismatch");
    expect(repo.decideContinuation("missing", "d1", "approve")).toBe("not_found");
    expect(repo.getContinuation(id)?.status).toBe("waiting");
  });

  it("treats expiry as a denial, and a late answer changes nothing", () => {
    const { id } = repo.openContinuation({ ...fields, ttlMs: -1 });
    expect(repo.decideContinuation(id, "d1", "approve")).toBe("closed");
    expect(repo.expireContinuations().map((row) => row.status)).toEqual(["expired"]);
    expect(repo.claimContinuation(id)).toBeUndefined();
  });

  it("marks an action cut off by a restart unknown, and keeps waiting ones", () => {
    const claimed = repo.openContinuation(fields);
    const waiting = repo.openContinuation({ ...fields, digest: "d2" });
    repo.decideContinuation(claimed.id, "d1", "approve");
    repo.claimContinuation(claimed.id);
    expect(repo.recoverContinuations().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: claimed.id, status: "unknown" },
    ]);
    expect(repo.claimContinuation(claimed.id)).toBeUndefined();
    expect(repo.waitingContinuations().map(({ id }) => id)).toEqual([waiting.id]);
  });

  it("never runs a hand_off: the owner's approval records it as done", () => {
    const { id } = repo.openContinuation({ ...fields, kind: "hand_off" });
    expect(repo.decideContinuation(id, "d1", "approve")).toBe("succeeded");
    expect(repo.claimContinuation(id)).toBeUndefined();
  });

  it("keeps the payload out of its events", () => {
    repo.openContinuation(fields);
    expect(JSON.stringify(events)).not.toContain('"to"');
    expect(events[0]).toMatchObject({ type: "continuation.changed" });
  });
});
