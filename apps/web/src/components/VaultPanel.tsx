import { ApiKeyAccountId, type ChatState } from "@beebot/contracts";
import { type FormEvent, useState } from "react";

import { postCommand } from "../serverConnection";

const accountNames: Record<ApiKeyAccountId, string> = {
  claude: "Anthropic (Claude)",
  codex: "OpenAI (Codex)",
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
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = accountNames[accountId];

  async function run(command: Parameters<typeof postCommand>[0]) {
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    setBusy(false);
    if (result.ok) {
      setKey("");
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

  return (
    <form className="flex flex-col gap-2" onSubmit={save}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-small font-medium">{name}</span>
        <span className="text-label text-ink-faint">{saved ? "Saved" : "Not saved"}</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="password"
          aria-label={`${name} API key`}
          className="field min-w-0 flex-1 text-ink"
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? "Paste a new key to replace it" : "Paste an API key"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button type="submit" className="button button-primary" disabled={busy || !key.trim()}>
          Save
        </button>
        {saved && (
          <button
            type="button"
            className="button button-outline"
            disabled={busy}
            onClick={() => void run({ type: "delete-api-key", engineAccountId: accountId })}
          >
            Delete
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
    </form>
  );
}

export function VaultPanel({ chat }: { chat: ChatState }) {
  const acknowledgedAt = chat.automatedAccessAcknowledgedAt;
  return (
    <section aria-label="API keys" className="flex flex-col gap-4 border-t border-edge pt-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-name font-medium">API keys</h3>
        <p className="text-small text-ink-secondary">
          Bots that run on their own use these. Bee Bot shows whether a key is saved, never the key.
        </p>
      </div>
      {ApiKeyAccountId.options.map((accountId) => (
        <KeyRow
          key={accountId}
          accountId={accountId}
          saved={chat.vault.apiKeys.includes(accountId)}
        />
      ))}
      <details className="text-small">
        <summary className="cursor-pointer text-ink-secondary">
          Automated access and your subscription
        </summary>
        <div className="flex flex-col gap-2 pt-2">
          <AutomatedAccessNotice />
          {acknowledgedAt && (
            <p className="text-label text-ink-faint">
              You read this on {new Date(acknowledgedAt).toLocaleDateString()}.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
