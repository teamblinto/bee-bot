import type { Bot, Run, RunReason } from "@beebot/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useState, useSyncExternalStore } from "react";

import {
  type ConnectionState,
  createBot,
  getConnectionState,
  isActive,
  sendCommand,
  subscribeToConnection,
} from "../serverConnection";

const statusLabels: Record<ConnectionState["status"], string> = {
  unconfigured: "No server. Open Bee Bot from the desktop app.",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected, retrying",
  incompatible: "Incompatible server",
};

const reasonLabels: Record<RunReason, string> = {
  unattended: "Refused: no client was connected when this was sent.",
  bot_paused: "Refused: this bot is paused. Resume it, then send again.",
  daily_cap: "Refused: this bot reached its daily run cap.",
  engine_failed: "Failed: the engine could not finish this turn. Send again to retry.",
  limited: "Limited: the account hit a limit. This retries when it clears, unless stopped.",
  auth_failed: "Failed: the engine could not be verified, so this bot was paused.",
  timeout: "Failed: the turn ran past its time limit. Send again to retry.",
  stopped: "Stopped.",
  server_restarted: "Interrupted: the server restarted during this turn. Nothing was repeated.",
};

const pauseLabels: Record<NonNullable<Bot["pauseReason"]>, string> = {
  owner: "Paused",
  auth_failed: "Paused: Claude login could not be verified. Log in with the CLI, then Resume.",
  cli_missing: "Paused: the Claude CLI was not found. Install it, then Resume.",
  cli_version: "Paused: this Claude CLI version is untested. Install 2.1.318, then Resume.",
  config_dir:
    "Paused: CLAUDE_CONFIG_DIR is set, and Bee Bot ignores it, so Claude looks logged out. Log in to the default config, then Resume.",
};

const buttonClass = "rounded border border-neutral-300 px-2 py-1 text-sm disabled:opacity-50";
const fieldClass = "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm";
const tagClass = "rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-700";

function runLabel(run: Run | undefined) {
  if (!run || run.status === "Completed") {
    return undefined;
  }
  return run.reason ? reasonLabels[run.reason] : run.status;
}

function BotFields({
  name,
  personality,
  onName,
  onPersonality,
}: {
  name: string;
  personality: string;
  onName: (value: string) => void;
  onPersonality: (value: string) => void;
}) {
  return (
    <>
      <input
        className={fieldClass}
        aria-label="Bot name"
        placeholder="Name"
        maxLength={80}
        value={name}
        onChange={(event) => onName(event.target.value)}
      />
      <textarea
        className={fieldClass}
        aria-label="Bot personality"
        placeholder="Personality"
        maxLength={4000}
        rows={3}
        value={personality}
        onChange={(event) => onPersonality(event.target.value)}
      />
    </>
  );
}

function CreateBotForm({ onCreated }: { onCreated: (bot: Bot) => void }) {
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [engine, setEngine] = useState<"claude" | "fake">("claude");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const bot = await createBot(name, personality, engine);
    if (bot) {
      setName("");
      setPersonality("");
      onCreated(bot);
    }
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <BotFields
        name={name}
        personality={personality}
        onName={setName}
        onPersonality={setPersonality}
      />
      {import.meta.env.DEV && (
        <label className="flex flex-col gap-1 text-sm">
          Engine
          <select
            className={fieldClass}
            value={engine}
            onChange={(event) => setEngine(event.target.value === "fake" ? "fake" : "claude")}
          >
            <option value="claude">Claude</option>
            <option value="fake">Test engine</option>
          </select>
        </label>
      )}
      <button type="submit" className={buttonClass} disabled={!name.trim()}>
        Create bot
      </button>
    </form>
  );
}

function EditBotForm({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const [name, setName] = useState(bot.name);
  const [personality, setPersonality] = useState(bot.personality);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await sendCommand({ type: "update-bot", botId: bot.id, name, personality });
    if (saved) {
      onDone();
    }
  }

  return (
    <form
      className="flex flex-col gap-2 border-b border-neutral-300 p-3"
      onSubmit={(event) => void submit(event)}
    >
      <BotFields
        name={name}
        personality={personality}
        onName={setName}
        onPersonality={setPersonality}
      />
      <div className="flex gap-2">
        <button type="submit" className={buttonClass} disabled={!name.trim()}>
          Save
        </button>
        <button type="button" className={buttonClass} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Composer({ bot, disabled }: { bot: Bot; disabled: boolean }) {
  const [body, setBody] = useState("");
  // Kept across a failed send, so resending the same text can't duplicate it.
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());

  async function send() {
    if (disabled || !body.trim()) {
      return;
    }
    const sentBody = body;
    const sent = await sendCommand({
      type: "send-message",
      messageId,
      roomId: bot.roomId,
      body: sentBody,
    });
    if (sent) {
      setBody((current) => (current === sentBody ? "" : current));
      setMessageId(crypto.randomUUID());
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <form
      className="flex gap-2 border-t border-neutral-300 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        className={fieldClass}
        aria-label="Message"
        placeholder={`Message ${bot.name}`}
        rows={2}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          setMessageId(crypto.randomUUID());
        }}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className={buttonClass} disabled={disabled || !body.trim()}>
        Send
      </button>
    </form>
  );
}

function ChatView({ bot, connection }: { bot: Bot; connection: ConnectionState }) {
  const [editing, setEditing] = useState(false);
  const { chat, drafts, status } = connection;
  const connected = status === "connected";
  const messages = chat.messages.filter(({ roomId }) => roomId === bot.roomId);
  const run = chat.runs.find(({ botId }) => botId === bot.id);
  const account = chat.accounts.find(({ id }) => id === bot.engineAccountId);
  const draft = run ? drafts[run.id] : undefined;
  const label = runLabel(run);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Chat with ${bot.name}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-300 p-3">
        <h2 className="text-lg font-semibold">{bot.name}</h2>
        <span className={tagClass}>Attended only</span>
        {account && <span className={tagClass}>{account.label}</span>}
        {bot.pauseReason && <span className={tagClass}>{pauseLabels[bot.pauseReason]}</span>}
        <span className="flex-1" />
        <button type="button" className={buttonClass} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!connected}
          onClick={() =>
            void sendCommand({
              type: "set-bot-paused",
              botId: bot.id,
              paused: bot.status === "ready",
            })
          }
        >
          {bot.status === "ready" ? "Pause" : "Resume"}
        </button>
      </header>
      {editing && <EditBotForm bot={bot} onDone={() => setEditing(false)} />}
      {bot.personality && (
        <p className="border-b border-neutral-200 px-3 py-2 text-sm text-neutral-600">
          {bot.personality}
        </p>
      )}
      {/* Reversed so the browser keeps the view pinned to the newest message. */}
      <div className="flex flex-1 flex-col-reverse overflow-y-auto p-3">
        <ol className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.id}
              data-author={message.author}
              className={`max-w-[80%] rounded px-3 py-2 text-sm whitespace-pre-wrap ${
                message.author === "human" ? "self-end bg-amber-100" : "self-start bg-neutral-200"
              }`}
            >
              {message.body}
            </li>
          ))}
          {draft && (
            <li
              data-author="draft"
              className="max-w-[80%] self-start rounded bg-neutral-100 px-3 py-2 text-sm whitespace-pre-wrap"
            >
              {draft}
            </li>
          )}
        </ol>
      </div>
      <div className="flex min-h-10 items-center gap-2 px-3 text-sm" role="status">
        {account?.blockedUntil && (
          <span>Limited until {new Date(account.blockedUntil).toLocaleTimeString()}.</span>
        )}
        {label && <span data-run-status={run?.status}>{label}</span>}
        {(isActive(run) || (run?.reason === "limited" && account?.blockedUntil)) && (
          <button
            type="button"
            className={buttonClass}
            disabled={!connected}
            onClick={() => void sendCommand({ type: "stop-bot", botId: bot.id })}
          >
            Stop
          </button>
        )}
        {(run?.status === "Interrupted" || run?.status === "Cancelled") && (
          <button
            type="button"
            className={buttonClass}
            disabled={!connected}
            onClick={() => void sendCommand({ type: "continue-run", runId: run.id })}
          >
            Continue
          </button>
        )}
      </div>
      <Composer bot={bot} disabled={!connected} />
    </section>
  );
}

function Home() {
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState);
  const { status, notice, chat, commandError } = connection;
  const [selectedId, setSelectedId] = useState<string>();
  const selected = chat.bots.find(({ id }) => id === selectedId) ?? chat.bots[0];

  return (
    <main className="flex h-screen bg-neutral-50 text-neutral-900">
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-neutral-300 p-3">
        <h1 className="text-xl font-bold">Bee Bot</h1>
        <p className="text-sm" data-status={status}>
          {statusLabels[status]}
        </p>
        {notice && (
          <p role="alert" className="text-sm text-red-700">
            {notice}
          </p>
        )}
        <nav aria-label="Bots">
          <ul className="flex flex-col gap-1">
            {chat.bots.map((bot) => (
              <li key={bot.id}>
                <button
                  type="button"
                  aria-current={bot.id === selected?.id}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm aria-[current=true]:bg-amber-100"
                  onClick={() => setSelectedId(bot.id)}
                >
                  <span className="truncate">{bot.name}</span>
                  <span className="text-xs text-neutral-600">
                    Attended only{bot.status === "paused" && " · Paused"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <button
          type="button"
          className={buttonClass}
          disabled={status !== "connected"}
          onClick={() => void sendCommand({ type: "stop-all" })}
        >
          Stop all
        </button>
        <CreateBotForm onCreated={(bot) => setSelectedId(bot.id)} />
        {commandError && (
          <p role="alert" className="text-sm text-red-700">
            {commandError}
          </p>
        )}
      </aside>
      {selected ? (
        <ChatView key={selected.id} bot={selected} connection={connection} />
      ) : (
        <p className="m-auto text-neutral-600">Create a bot to start.</p>
      )}
    </main>
  );
}

export const Route = createFileRoute("/")({ component: Home });
