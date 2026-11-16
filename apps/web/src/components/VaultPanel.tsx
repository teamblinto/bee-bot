import { ApiKeyAccountId, type ChatState } from "@beebot/contracts";
import { ChevronDown, Eye, EyeOff, KeyRound, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

import { postCommand } from "../serverConnection";
import { iconProps } from "./ui";

const accounts: Record<ApiKeyAccountId, { name: string; usedBy: string }> = {
  claude: { name: "Anthropic", usedBy: "Used by bots that run in a box with Claude" },
  codex: { name: "OpenAI", usedBy: "Used by bots that run in a box with Codex" },
};

export function AutomatedAccessNotice() {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 text-ink-secondary">
      <li>A bot that runs on its own, on a schedule or while you're away, uses your API key.</li>
      <li>
        Bee Bot keeps the key encrypted on this computer and adds it to the bot's requests itself.
        The bot never sees it. You pay the vendor's normal API rates.
      </li>
      <li>
        Anthropic's consumer terms don't allow automated access to a Claude subscription unless
        Anthropic permits it, and OpenAI says to use API keys for automation. Nobody has said
        whether a bot that runs all day on a subscription is allowed.
      </li>
      <li>
        If you run one on your subscription anyway, the risk to your account is yours. Those terms
        bind you, not Bee Bot.
      </li>
    </ul>
  );
}

function KeyRow({ accountId, saved }: { accountId: ApiKeyAccountId; saved: boolean }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { name, usedBy } = accounts[accountId];
  const inputId = `api-key-${accountId}`;

  async function run(command: Parameters<typeof postCommand>[0]) {
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    setBusy(false);
    if (result.ok) {
      setKey("");
      setEditing(false);
    } else {
      setError(result.message);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (key.trim()) {
      void run({ type: "store-api-key", engineAccountId: accountId, key });
    }
  }

  function cancel() {
    setEditing(false);
    setKey("");
    setError(undefined);
  }

  return (
    <li className="flex flex-col gap-2 border-b border-edge-subtle py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <KeyRound {...iconProps} className="shrink-0 self-start text-ink-secondary mt-1" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body-s font-medium">{name}</span>
          <span className="text-caption text-ink-secondary">{usedBy}</span>
        </span>
        {!editing && (
          <span className="flex items-center gap-2">
            <span className="text-caption text-ink-secondary">
              {saved ? "Saved" : "No key saved"}
            </span>
            {saved ? (
              <>
                <button
                  type="button"
                  className="button button-sm button-outline"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="button button-sm button-danger"
                  disabled={busy}
                  onClick={() => void run({ type: "delete-api-key", engineAccountId: accountId })}
                >
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button button-sm button-outline"
                onClick={() => setEditing(true)}
              >
                <Plus {...iconProps} />
                Add key
              </button>
            )}
          </span>
        )}
      </div>
      {editing && (
        <form className="flex flex-col gap-2" onSubmit={save}>
          <label htmlFor={inputId} className="field-label">
            {name} API key
          </label>
          <span className="relative flex items-center">
            <input
              id={inputId}
              type={visible ? "text" : "password"}
              className="field pr-10 text-ink"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
              placeholder={saved ? "Paste a new key to replace it" : "Paste an API key"}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <button
              type="button"
              aria-label={visible ? "Hide key" : "Show key"}
              className="button button-icon button-sm absolute right-1.5"
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff {...iconProps} /> : <Eye {...iconProps} />}
            </button>
          </span>
          {error && (
            <p id={`${inputId}-error`} role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
          <span className="flex items-center gap-2">
            <button
              type="submit"
              className="button button-sm button-primary"
              disabled={busy || !key.trim()}
            >
              {busy ? "Checking…" : "Save key"}
            </button>
            <button type="button" className="button button-sm" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {!editing && error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export function VaultPanel({ chat }: { chat: ChatState }) {
  const acknowledgedAt = chat.automatedAccessAcknowledgedAt;
  return (
    <section aria-label="API keys" className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium">API keys</h3>
        <p className="text-caption text-ink-secondary">
          Bots that run on their own use these. Bee Bot shows whether a key is saved, never the key.
        </p>
      </div>
      <ul className="flex flex-col">
        {ApiKeyAccountId.options.map((accountId) => (
          <KeyRow
            key={accountId}
            accountId={accountId}
            saved={chat.vault.apiKeys.includes(accountId)}
          />
        ))}
      </ul>
      <details className="group text-body-s">
        <summary className="button button-sm w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          Why not my subscription?
          <ChevronDown {...iconProps} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2 flex flex-col gap-2 rounded-card bg-sidebar p-4">
          <AutomatedAccessNotice />
          {acknowledgedAt && (
            <p className="text-caption text-ink-secondary">
              You read this on {new Date(acknowledgedAt).toLocaleDateString()}.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
