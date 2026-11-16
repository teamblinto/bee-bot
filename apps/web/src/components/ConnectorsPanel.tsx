import {
  type Bot,
  type ChatState,
  type Command,
  type Connector,
  connectorUsable,
} from "@beebot/contracts";
import { Plug, Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { connectorStatusLine } from "../labels";
import { postCommand } from "../serverConnection";
import { HostList } from "./BotForm";
import { iconProps } from "./ui";

// A short list of remote servers that need no setup but a sign-in or a token.
const catalog = [
  { name: "Notion", url: "https://mcp.notion.com/mcp" },
  { name: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp" },
  { name: "GitHub", url: "https://api.githubcopilot.com/mcp/" },
];

const metaClass = "text-caption text-ink-secondary";
const labelClass = "flex flex-col gap-2 text-body-s font-medium";
const badgeClass = "inline-flex h-[22px] items-center rounded-xs px-2 text-label font-medium";
const errorClass = "text-caption text-danger";

type Send = (command: Command) => Promise<unknown>;

function useSend() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send: Send = async (command) => {
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return undefined;
    }
    return result.body;
  };
  return { busy, error, setError, send };
}

function ReviewDialog({ connector, onClose }: { connector: Connector; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { busy, error, send } = useSend();
  const before = new Map(connector.reviewedTools.map(({ name, sha256 }) => [name, sha256]));
  const removed = connector.reviewedTools.filter(
    ({ name }) => !connector.tools.some((tool) => tool.name === name),
  );
  const firstReview = connector.reviewedHash === null;
  // The owner's marks stand. A tool never marked starts from the server's hint.
  const [readOnly, setReadOnly] = useState(
    () =>
      new Set(
        connector.tools
          .filter(({ name, readOnlyHint, destructiveHint }) =>
            destructiveHint
              ? false
              : before.has(name)
                ? connector.readOnlyTools.includes(name)
                : readOnlyHint,
          )
          .map(({ name }) => name),
      ),
  );

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  function toggle(name: string, on: boolean) {
    const next = new Set(readOnly);
    if (on) {
      next.add(name);
    } else {
      next.delete(name);
    }
    setReadOnly(next);
  }

  async function confirm() {
    const body = await send({
      type: "review-connector",
      connectorId: connector.id,
      toolsHash: connector.toolsHash ?? "",
      readOnly: [...readOnly],
    });
    if (body) {
      dialog.current?.close();
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`Review ${connector.name}`}
      className="dialog m-auto max-h-[80dvh] w-[min(640px,calc(100vw-32px))] flex-col gap-4 p-6 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <h2 className="text-title-s font-semibold">Review {connector.name}</h2>
      <p className="text-body-s text-ink-secondary">
        These are the tools {connector.name} offers. Bots you allow can call them. Tick a tool only
        if it just reads: every other tool asks you before it runs, unless you allow it for a bot.
      </p>
      <ul className="scroller flex min-h-0 flex-col gap-3 overflow-y-auto">
        {connector.tools.map((tool) => {
          const was = before.get(tool.name);
          const tag = firstReview
            ? ""
            : was === undefined
              ? "New"
              : was !== tool.sha256
                ? "Changed"
                : "";
          return (
            <li key={tool.name} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand-fill"
                aria-label={`${tool.name} only reads`}
                checked={readOnly.has(tool.name)}
                disabled={tool.destructiveHint || tool.excluded !== null}
                onChange={(event) => toggle(tool.name, event.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <p className="text-body-s font-medium">
                  {tool.name}
                  {tag && (
                    <span className={`ml-2 ${badgeClass} bg-brand-surface text-brand`}>{tag}</span>
                  )}
                </p>
                <p className="text-caption wrap-anywhere text-ink-secondary">{tool.description}</p>
                {tool.excluded && <p className={metaClass}>Left out: {tool.excluded}</p>}
                {tool.destructiveHint && (
                  <p className={metaClass}>The server says this can delete or overwrite.</p>
                )}
              </div>
            </li>
          );
        })}
        {removed.map(({ name }) => (
          <li key={name} className="text-body-s text-ink-disabled line-through">
            {name} <span className="no-underline">(removed)</span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="button button-outline"
          onClick={() => dialog.current?.close()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || connector.toolsHash === null}
          onClick={() => void confirm()}
        >
          Mark as reviewed
        </button>
      </div>
    </dialog>
  );
}

function SecretForm({
  connector,
  send,
  busy,
}: {
  connector: Connector;
  send: Send;
  busy: boolean;
}) {
  const [token, setToken] = useState("");
  if (
    connector.transport !== "http" ||
    connector.auth === "oauth" ||
    connector.auth === "headers"
  ) {
    return null;
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void send({ type: "set-connector-secret", connectorId: connector.id, bearer: token }).then(
      (body) => body && setToken(""),
    );
  }
  return (
    <form className="flex items-center gap-2" onSubmit={save}>
      <input
        type="password"
        aria-label={`${connector.name} token`}
        className="field min-w-0 flex-1 text-ink"
        autoComplete="off"
        spellCheck={false}
        placeholder={
          connector.hasSecret ? "Paste a new token to replace it" : "Paste a token, if it needs one"
        }
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <button type="submit" className="button button-outline" disabled={busy || !token.trim()}>
        Save
      </button>
    </form>
  );
}

function EnvField({
  connector,
  name,
  send,
  busy,
}: {
  connector: Connector;
  name: string;
  send: Send;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  function save(event: FormEvent) {
    event.preventDefault();
    void send({
      type: "set-connector-secret",
      connectorId: connector.id,
      env: { [name]: value },
    }).then((body) => body && setValue(""));
  }
  return (
    <form className="flex items-center gap-2" onSubmit={save}>
      <label className="w-40 shrink-0 truncate font-mono text-code text-ink-secondary">
        {name}
      </label>
      <input
        type="password"
        aria-label={`${connector.name} ${name}`}
        className="field min-w-0 flex-1 text-ink"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste a new value to replace it"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="button button-outline" disabled={busy || !value}>
        Save
      </button>
    </form>
  );
}

// A local server runs in its own box: its env values, and the only sites that box may reach.
function LocalServerForm({
  connector,
  send,
  busy,
}: {
  connector: Connector;
  send: Send;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {connector.envKeys.map((name) => (
        <EnvField key={name} connector={connector} name={name} send={send} busy={busy} />
      ))}
      <div className={labelClass}>
        Sites it may reach
        <HostList
          hosts={connector.egressHosts}
          onChange={(hosts) =>
            void send({ type: "update-connector", connectorId: connector.id, egressHosts: hosts })
          }
        />
      </div>
    </div>
  );
}

// The web app opens the sign-in page: beebotd never drives a browser.
async function signIn(connector: Connector, send: Send) {
  const body = await send({ type: "start-connector-oauth", connectorId: connector.id });
  if (typeof body === "object" && body !== null && "authorizationUrl" in body) {
    window.open(String(body.authorizationUrl), "_blank", "noopener");
  }
}

// For a server that can't register Bee Bot itself: the owner makes a client and pastes it here.
function ClientForm({
  connector,
  send,
  busy,
}: {
  connector: Connector;
  send: Send;
  busy: boolean;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = await send({
      type: "set-connector-secret",
      connectorId: connector.id,
      clientId: clientId.trim(),
      ...(clientSecret && { clientSecret }),
    });
    if (body) {
      setClientId("");
      setClientSecret("");
      await signIn(connector, send);
    }
  }
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void save(event)}>
      <input
        aria-label={`${connector.name} client ID`}
        className="field min-w-0 flex-1 text-ink"
        autoComplete="off"
        spellCheck={false}
        placeholder="Client ID"
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
      />
      <input
        type="password"
        aria-label={`${connector.name} client secret`}
        className="field min-w-0 flex-1 text-ink"
        autoComplete="off"
        spellCheck={false}
        placeholder="Client secret, if it has one"
        value={clientSecret}
        onChange={(event) => setClientSecret(event.target.value)}
      />
      <button type="submit" className="button button-outline" disabled={busy || !clientId.trim()}>
        Save and sign in
      </button>
    </form>
  );
}

function ConnectorRow({ connector, owner }: { connector: Connector; owner: Bot | undefined }) {
  const { busy, error, send } = useSend();
  const [reviewing, setReviewing] = useState(false);
  const where = connector.url ?? [connector.command, ...connector.args].join(" ");
  const needsReview = connector.toolsHash !== null && !connectorUsable(connector);
  // A token the owner pasted is fixed by pasting another, not by signing in.
  const signsIn =
    connector.transport === "http" &&
    (connector.auth === "oauth" ||
      (connector.auth === "none" && connector.status === "needs_sign_in"));

  function remove() {
    const bots = connector.grants.length;
    const also = bots > 0 ? ` ${bots} ${bots === 1 ? "bot loses" : "bots lose"} it.` : "";
    if (window.confirm(`Delete ${connector.name}? Its saved keys go with it.${also}`)) {
      void send({ type: "delete-connector", connectorId: connector.id });
    }
  }

  return (
    <li className="flex flex-col gap-3 border-b border-edge-subtle py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Plug {...iconProps} className="mt-0.5 shrink-0 text-ink-secondary" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2 text-body-s font-medium">
            {connector.name}
            {owner && <span className={`${badgeClass} bg-raised text-ink`}>Only {owner.name}</span>}
          </p>
          <p className="truncate text-caption text-ink-secondary">{where}</p>
          <p className="text-caption text-ink-secondary">{connectorStatusLine(connector)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {connector.tools.length > 0 && (
            <button
              type="button"
              className={`button button-sm ${needsReview ? "button-primary" : "button-outline"}`}
              onClick={() => setReviewing(true)}
            >
              Review
            </button>
          )}
          {signsIn && (
            <button
              type="button"
              className={`button button-sm ${connector.status === "needs_sign_in" ? "button-primary" : "button-outline"}`}
              disabled={busy}
              onClick={() => void signIn(connector, send)}
            >
              {connector.authStatus === "signed_in" ? "Reconnect" : "Sign in"}
            </button>
          )}
          <button
            type="button"
            className="button button-sm button-outline"
            disabled={busy}
            onClick={() => void send({ type: "refresh-connector", connectorId: connector.id })}
          >
            Refresh
          </button>
          {connector.authStatus !== "not_needed" && (
            <button
              type="button"
              className="button button-sm button-outline"
              disabled={busy}
              onClick={() => void send({ type: "disconnect-connector", connectorId: connector.id })}
            >
              Disconnect
            </button>
          )}
          <button
            type="button"
            className="button button-sm button-danger"
            disabled={busy}
            onClick={remove}
          >
            Delete
          </button>
        </div>
      </div>
      <SecretForm connector={connector} send={send} busy={busy} />
      {connector.transport === "stdio" && (
        <LocalServerForm connector={connector} send={send} busy={busy} />
      )}
      {connector.status === "needs_client" && (
        <ClientForm connector={connector} send={send} busy={busy} />
      )}
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
      {reviewing && <ReviewDialog connector={connector} onClose={() => setReviewing(false)} />}
    </li>
  );
}

type AddMode = "catalog" | "url" | "json";

function AddConnector({ bots }: { bots: Bot[] }) {
  const { busy, error, setError, send } = useSend();
  const [mode, setMode] = useState<AddMode>("catalog");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [json, setJson] = useState("");
  const [ownerBotId, setOwnerBotId] = useState("");
  const owner = ownerBotId || null;

  async function add(command: Command) {
    const body = await send(command);
    if (!body) {
      return;
    }
    setName("");
    setUrl("");
    setToken("");
    if (command.type === "import-connectors") {
      const refused = (body as { refused?: Array<{ key: string }> }).refused ?? [];
      setJson("");
      if (refused.length > 0) {
        setError(`Not added: ${refused.map(({ key }) => key).join(", ")}. Check those entries.`);
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "json") {
      void add({ type: "import-connectors", json, ownerBotId: owner });
    } else {
      void add({
        type: "add-connector",
        name: name.trim() || new URL(url).hostname,
        url,
        ownerBotId: owner,
        ...(token.trim() && { bearer: token }),
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex rounded-field bg-raised p-0.5"
          role="tablist"
          aria-label="Add a connector"
        >
          {(
            [
              ["catalog", "Catalog"],
              ["url", "URL"],
              ["json", "Paste JSON"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className="h-7 rounded-xs px-3 text-label whitespace-nowrap text-ink-secondary transition-colors hover:text-ink aria-selected:bg-card aria-selected:font-medium aria-selected:text-ink aria-selected:shadow-composer forced-colors:aria-selected:outline-2"
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-body-s text-ink-secondary">
          For
          <select
            className="field w-auto text-ink"
            value={ownerBotId}
            onChange={(event) => setOwnerBotId(event.target.value)}
          >
            <option value="">Any bot you allow</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                Only {bot.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {mode === "catalog" ? (
        <ul className="flex flex-wrap gap-2">
          {catalog.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                className="button button-sm button-outline"
                disabled={busy}
                onClick={() => void add({ type: "add-connector", ...entry, ownerBotId: owner })}
              >
                <Plus {...iconProps} />
                Add {entry.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {mode === "url" ? (
            <>
              <label className={labelClass}>
                Server URL
                <input
                  className="field text-ink"
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <label className={`${labelClass} flex-1`}>
                  Name
                  <input
                    className="field text-ink"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className={`${labelClass} flex-1`}>
                  Token (optional)
                  <input
                    type="password"
                    className="field text-ink"
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </label>
              </div>
            </>
          ) : (
            <label className={labelClass}>
              Paste an mcpServers block, as Claude Desktop, Cursor or Claude Code write it
              <textarea
                className="field resize-none font-mono text-code text-ink"
                rows={5}
                spellCheck={false}
                placeholder={
                  '{\n  "mcpServers": {\n    "linear": { "url": "https://mcp.linear.app/mcp" }\n  }\n}'
                }
                value={json}
                onChange={(event) => setJson(event.target.value)}
              />
            </label>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              className="button button-primary"
              disabled={busy || (mode === "url" ? !URL.canParse(url) : !json.trim())}
            >
              Add
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

export function ConnectorsPanel({ chat }: { chat: ChatState }) {
  const bots = chat.bots.filter(({ archivedAt }) => !archivedAt);
  return (
    <section aria-label="Connectors" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium">Connectors</h3>
        <p className="text-caption text-ink-secondary">
          Apps your bots can use through MCP. Bee Bot keeps their keys and makes every call itself,
          so a bot only ever gets the tools you allow it.
        </p>
      </div>
      {chat.connectors.length > 0 && (
        <ul className="flex flex-col">
          {chat.connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              owner={chat.bots.find(({ id }) => id === connector.ownerBotId)}
            />
          ))}
        </ul>
      )}
      <AddConnector bots={bots} />
    </section>
  );
}
