import type { ServerEvent } from "@beebot/contracts";
import { beforeAll, expect, it, vi } from "vite-plus/test";

import type { ConnectionState } from "./serverConnection";

const event = (seq: number): ServerEvent => ({ seq, type: "diagnostic", createdAt: "now" });

const state = (seq: number): ConnectionState => ({
  status: "connected",
  notice: undefined,
  seq,
  events: seq ? [event(seq)] : [],
  lastCommandSeq: undefined,
  commandError: undefined,
});

let applyServerMessage: typeof import("./serverConnection").applyServerMessage;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { search: "" } });
  ({ applyServerMessage } = await import("./serverConnection"));
});

it("drops replayed and live events it already has", () => {
  const replayed = applyServerMessage(state(2), {
    type: "replay",
    events: [event(1), event(2), event(3)],
  });
  expect(replayed.seq).toBe(3);
  expect(replayed.events.map(({ seq }) => seq)).toEqual([2, 3]);

  const live = applyServerMessage(replayed, { type: "event", event: event(3) });
  expect(live.events.map(({ seq }) => seq)).toEqual([2, 3]);
});

it("replaces its state on a snapshot, even when the cursor moves back", () => {
  const next = applyServerMessage(state(9), { type: "snapshot", seq: 4, events: [event(4)] });
  expect(next.seq).toBe(4);
  expect(next.events).toEqual([event(4)]);
});
