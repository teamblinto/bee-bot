import type { Task } from "@beebot/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ListTodo } from "lucide-react";

import { boardColumnNames, boardColumns } from "../board";
import { shortTime } from "../labels";
import type { ConnectionState } from "../serverConnection";
import { iconProps } from "./ui";

function Card({
  task,
  blocked,
  nameOf,
}: {
  task: Task;
  blocked: boolean;
  nameOf: (id: string) => string;
}) {
  const summary = task.outcome?.summary;
  return (
    <li className="flex flex-col gap-1 rounded-row border border-edge-subtle bg-background p-3 text-caption text-ink-secondary">
      <p className="text-body-s font-medium text-ink">{task.goal.split("\n")[0]}</p>
      <p>
        {nameOf(task.ownerBotId)} ← {nameOf(task.requesterBotId)}
        {task.origin !== "human" && ` · ${task.origin}`}
      </p>
      {task.doneWhen && <p>Done when {task.doneWhen}</p>}
      {task.progressAt && <p>Last progress {shortTime(task.progressAt)}</p>}
      {blocked && <p>Blocked by {task.blockedBy.length}</p>}
      {summary && <p>{summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}</p>}
    </li>
  );
}

export function BoardPage({ connection }: { connection: ConnectionState }) {
  const { bots, tasks } = connection.chat;
  const columns = boardColumns(tasks);
  const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? "Unknown bot";

  return (
    <main className="flex h-dvh flex-col bg-background text-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge-subtle px-6 max-md:px-3">
        <Link to="/" className="button button-sm button-outline">
          <ArrowLeft {...iconProps} />
          Back to chats
        </Link>
        <h2 className="text-title-s font-semibold">Board</h2>
      </header>
      {tasks.length === 0 ? (
        <div className="m-auto flex flex-col items-center gap-4 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-sidebar">
            <ListTodo {...iconProps} size={24} />
          </span>
          <p className="text-body-s text-ink-secondary">No work in progress.</p>
        </div>
      ) : (
        <div className="scroller grid min-h-0 flex-1 gap-4 overflow-y-auto p-6 max-md:p-3 md:grid-cols-5">
          {Object.entries(boardColumnNames).map(([key, title]) => {
            const column = columns[key as keyof typeof columns];
            return (
              <section key={key} aria-label={title} className="flex min-w-0 flex-col gap-2">
                <h3 className="text-label font-medium text-ink-secondary">
                  {title} · {column.length}
                </h3>
                <ul className="flex flex-col gap-2">
                  {column.map((task) => (
                    <Card key={task.id} task={task} blocked={key === "blocked"} nameOf={nameOf} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
