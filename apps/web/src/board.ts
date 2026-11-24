import type { Task } from "@beebot/contracts";

export const boardColumnNames = {
  queued: "Queued",
  blocked: "Blocked",
  open: "Open",
  waiting: "Waiting",
  needs_input: "Needs input",
};

// The client holds only active tasks, so a blocker that isn't among them has ended.
export function boardColumns(tasks: Task[]) {
  const active = new Set(tasks.map(({ id }) => id));
  const columns: Record<keyof typeof boardColumnNames, Task[]> = {
    queued: [],
    blocked: [],
    open: [],
    waiting: [],
    needs_input: [],
  };
  for (const task of [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (task.status === "queued" && task.blockedBy.some((id) => active.has(id))) {
      columns.blocked.push(task);
    } else if (task.status in columns) {
      columns[task.status as keyof typeof columns].push(task);
    }
  }
  return columns;
}
