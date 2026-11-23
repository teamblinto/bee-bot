import {
  type ChatState,
  EngineAccountId,
  limitCeilings,
  type Limits,
  type LimitOverrides,
  type Task,
} from "@beebot/contracts";
import type { FormEvent } from "react";

import { sendCommand } from "../serverConnection";

const minute = 60_000;

const limitFields: ReadonlyArray<{ key: keyof Limits; label: string; unit: number }> = [
  { key: "hop", label: "Hops per chain", unit: 1 },
  { key: "depth", label: "Delegation depth", unit: 1 },
  { key: "fanOut", label: "Tasks per turn", unit: 1 },
  { key: "mentions", label: "Bots one message can wake", unit: 1 },
  { key: "posts", label: "Bot posts per window", unit: 1 },
  { key: "postWindowMs", label: "Post window (minutes)", unit: minute },
  { key: "chainTurns", label: "Turns per chain", unit: 1 },
  { key: "chainWallMs", label: "Chain time (minutes)", unit: minute },
];

const statusLabels: Record<Task["status"], string> = {
  queued: "Queued",
  open: "Working",
  waiting: "Waiting",
  needs_input: "Needs input",
  done: "Done",
  refused: "Refused",
  failed: "Failed",
  cancelled: "Cancelled",
};

const rowClass = "flex items-center gap-3 border-b border-edge-subtle py-3";
const numberClass = "field w-20 text-ink tabular-nums";

function Heading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-body-s font-medium">{title}</h3>
      <p className="text-caption text-ink-secondary">{detail}</p>
    </div>
  );
}

export function TeamPanel({ chat }: { chat: ChatState }) {
  const botName = (id: string) => chat.bots.find((bot) => bot.id === id)?.name ?? "Removed bot";
  const owners = [...new Set(chat.tasks.map((task) => task.ownerBotId))];

  function saveLimits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const limits: LimitOverrides = {};
    for (const { key, unit } of limitFields) {
      limits[key] = Math.round(Number(form.get(key)) * unit);
    }
    void sendCommand({ type: "set-limits", limits });
  }

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="Bots working at once" className="flex flex-col gap-2">
        <Heading
          title="Bots working at once"
          detail="How many bots on each account can run a turn at the same time."
        />
        <ul className="flex flex-col">
          {chat.accounts
            .filter(({ id }) => id !== "fake")
            .map((account) => (
              <li key={account.id} className={rowClass}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <label htmlFor={`concurrency-${account.id}`} className="text-body-s font-medium">
                    {account.label}
                  </label>
                  {account.id === "codex" && (
                    <span className="text-caption text-ink-secondary">
                      Box bots on a Codex subscription still take turns.
                    </span>
                  )}
                </span>
                <input
                  id={`concurrency-${account.id}`}
                  type="number"
                  min={1}
                  max={8}
                  className={numberClass}
                  defaultValue={account.maxConcurrentRuns}
                  onChange={(event) => {
                    if (event.target.value !== "" && event.target.validity.valid) {
                      void sendCommand({
                        type: "set-account-concurrency",
                        accountId: EngineAccountId.parse(account.id),
                        maxConcurrentRuns: event.target.valueAsNumber,
                      });
                    }
                  }}
                />
              </li>
            ))}
        </ul>
      </section>
      <section aria-label="Coordination limits" className="flex flex-col gap-2">
        <Heading
          title="Coordination limits"
          detail="How far bots can hand work to each other before they stop and wait for you."
        />
        <form key={JSON.stringify(chat.limits)} className="flex flex-col" onSubmit={saveLimits}>
          {limitFields.map(({ key, label, unit }) => (
            <span key={key} className={rowClass}>
              <label htmlFor={`limit-${key}`} className="flex-1 text-body-s font-medium">
                {label}
              </label>
              <input
                id={`limit-${key}`}
                name={key}
                type="number"
                required
                min={0}
                max={limitCeilings[key] / unit}
                className={numberClass}
                defaultValue={chat.limits[key] / unit}
              />
            </span>
          ))}
          <button type="submit" className="button button-sm button-primary mt-3 w-fit">
            Save limits
          </button>
        </form>
      </section>
      <section aria-label="Work in progress" className="flex flex-col gap-2">
        <h3 className="text-body-s font-medium">Work in progress</h3>
        {owners.length === 0 ? (
          <p className="text-caption text-ink-secondary">No tasks right now.</p>
        ) : (
          owners.map((ownerId) => (
            <div key={ownerId} className="flex flex-col">
              <h4 className="pt-2 text-label font-medium text-ink-secondary">{botName(ownerId)}</h4>
              <ul className="flex flex-col">
                {chat.tasks
                  .filter((task) => task.ownerBotId === ownerId)
                  .map((task) => (
                    <li
                      key={task.id}
                      className="truncate border-b border-edge-subtle py-2 text-body-s"
                    >
                      {`${statusLabels[task.status]} · ${task.goal.split("\n")[0]} · from ${botName(task.requesterBotId)}`}
                    </li>
                  ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
