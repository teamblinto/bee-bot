import type { Task } from "@beebot/contracts";
import { expect, it } from "vite-plus/test";

import { boardColumns } from "./board";

const task = (id: string, status: Task["status"], createdAt: string, blockedBy: string[] = []) =>
  ({ id, status, createdAt, blockedBy }) as Task;

it("puts a queued task with an active blocker in Blocked, and back in Queued once the blocker is gone", () => {
  const blocker = task("a", "open", "2026-01-01T00:00:00Z");
  const queued = task("b", "queued", "2026-01-01T00:01:00Z", ["a"]);
  const columns = boardColumns([blocker, queued]);
  expect(columns.blocked).toEqual([queued]);
  expect(columns.queued).toEqual([]);
  expect(columns.open).toEqual([blocker]);
  expect(boardColumns([queued]).queued).toEqual([queued]);
  expect(boardColumns([queued]).blocked).toEqual([]);
});

it("sorts each column oldest first", () => {
  const late = task("a", "waiting", "2026-01-01T00:02:00Z");
  const early = task("b", "waiting", "2026-01-01T00:01:00Z");
  const asking = task("c", "needs_input", "2026-01-01T00:00:00Z");
  const columns = boardColumns([late, asking, early]);
  expect(columns.waiting).toEqual([early, late]);
  expect(columns.needs_input).toEqual([asking]);
});
