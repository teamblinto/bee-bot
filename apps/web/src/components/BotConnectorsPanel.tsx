import {
  type Bot,
  type Connector,
  type ConnectorGrant,
  type ConnectorTool,
  connectorUsable,
} from "@beebot/contracts";
import { useEffect, useRef, useState } from "react";

import { connectorStatusLine } from "../labels";
import { postCommand } from "../serverConnection";

const metaClass = "text-label text-ink-faint";

// Read vs write as the broker sees it: only the owner's mark makes a tool read-only.
const isReadOnly = (connector: Connector, tool: ConnectorTool) =>
  !tool.destructiveHint && connector.readOnlyTools.includes(tool.name);

function ConnectorGrantRow({
  bot,
  connector,
  disabled,
  onSend,
}: {
  bot: Bot;
  connector: Connector;
  disabled: boolean;
  onSend: (grant: Omit<ConnectorGrant, "botId"> & { on: boolean }) => void;
}) {
  const grant = connector.grants.find(({ botId }) => botId === bot.id);
  const [open, setOpen] = useState(false);
  const tools = connector.tools.filter(({ excluded }) => excluded === null);
  const chosen = (name: string) =>
    grant !== undefined && (grant.tools === "*" || grant.tools.includes(name));
  const current = { tools: grant?.tools ?? "*", allowWrites: grant?.allowWrites ?? [] };

  function setTool(name: string, on: boolean) {
    const listed = current.tools === "*" ? tools.map((tool) => tool.name) : current.tools;
    const next = on ? [...new Set([...listed, name])] : listed.filter((entry) => entry !== name);
    onSend({
      on: true,
      tools: next.length === tools.length ? "*" : next,
      allowWrites: current.allowWrites,
    });
  }

  function setWrite(name: string, allow: boolean) {
    const allowWrites = allow
      ? [...new Set([...current.allowWrites, name])]
      : current.allowWrites.filter((entry) => entry !== name);
    onSend({ on: true, tools: current.tools, allowWrites });
  }

  const reviewNote = connectorUsable(connector)
    ? ""
    : " Its tools reach the bot once you review them on the Usage page.";

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          aria-label={`${connector.name} on for ${bot.name}`}
          checked={grant !== undefined}
          disabled={disabled}
          onChange={(event) => onSend({ on: event.target.checked, tools: "*", allowWrites: [] })}
        />
        <div className="min-w-0 flex-1">
          <p className="text-name font-medium">
            {connector.name}
            {connector.ownerBotId && <span className={`ml-2 ${metaClass}`}>Only this bot</span>}
          </p>
          <p className={metaClass}>
            {connectorStatusLine(connector)}
            {reviewNote}
          </p>
        </div>
        {grant && tools.length > 0 && (
          <button
            type="button"
            className="button shrink-0"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Tools
          </button>
        )}
      </div>
      {grant && open && (
        <ul className="ml-6 flex flex-col gap-2">
          {tools.map((tool) => {
            const readOnly = isReadOnly(connector, tool);
            return (
              <li key={tool.name} className="flex items-center gap-2 text-small">
                <input
                  type="checkbox"
                  aria-label={`${bot.name} may use ${tool.name}`}
                  checked={chosen(tool.name)}
                  disabled={disabled}
                  onChange={(event) => setTool(tool.name, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate" title={tool.description}>
                  {tool.name}
                </span>
                {readOnly ? (
                  <span className={metaClass}>Reads</span>
                ) : (
                  <select
                    className="field w-auto shrink-0 text-ink"
                    aria-label={`When ${bot.name} uses ${tool.name}`}
                    value={current.allowWrites.includes(tool.name) ? "allow" : "ask"}
                    disabled={disabled || !chosen(tool.name)}
                    onChange={(event) => setWrite(tool.name, event.target.value === "allow")}
                  >
                    <option value="ask">Ask me</option>
                    <option value="allow">Allow</option>
                  </select>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function BotConnectorsPanel({
  bot,
  connectors,
  connected,
  onClose,
}: {
  bot: Bot;
  connectors: Connector[];
  connected: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const visible = connectors.filter(
    ({ ownerBotId }) => ownerBotId === null || ownerBotId === bot.id,
  );

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  async function send(connectorId: string, grant: Omit<ConnectorGrant, "botId"> & { on: boolean }) {
    setBusy(true);
    setError(undefined);
    const result = await postCommand({
      type: "set-bot-connector",
      botId: bot.id,
      connectorId,
      ...grant,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`${bot.name} connectors`}
      className="dialog m-auto max-h-[80dvh] w-[min(560px,calc(100vw-32px))] flex-col gap-3 p-5 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold">Connectors</h2>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <p className="text-small text-ink-secondary">
        Apps this bot may use. Tools that write ask you first unless you allow them here. Add apps
        on the Usage page, under Connectors.
      </p>
      {visible.length === 0 && <p className="text-small text-ink-secondary">No connectors yet.</p>}
      <ul className="scroller flex min-h-0 flex-col gap-3 overflow-y-auto">
        {visible.map((connector) => (
          <ConnectorGrantRow
            key={connector.id}
            bot={bot}
            connector={connector}
            disabled={busy || !connected}
            onSend={(grant) => void send(connector.id, grant)}
          />
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
    </dialog>
  );
}
