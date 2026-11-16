import {
  type Bot,
  type Connector,
  type ConnectorGrant,
  type ConnectorTool,
  connectorUsable,
} from "@beebot/contracts";
import { Plug } from "lucide-react";
import { useState } from "react";

import { connectorStatusLine } from "../labels";
import { postCommand } from "../serverConnection";
import { badgeClass, checkboxClass, EmptyState, errorClass, SidePanel } from "./SidePanel";

const metaClass = "text-caption text-ink-secondary";

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
    <li className="flex flex-col gap-3 border-b border-edge-subtle pb-4">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className={checkboxClass}
          aria-label={`${connector.name} on for ${bot.name}`}
          checked={grant !== undefined}
          disabled={disabled}
          onChange={(event) => onSend({ on: event.target.checked, tools: "*", allowWrites: [] })}
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-body-s font-medium">
            {connector.name}
            {connector.ownerBotId && <span className={badgeClass}>Only this bot</span>}
          </p>
          <p className={metaClass}>
            {connectorStatusLine(connector)}
            {reviewNote}
          </p>
        </div>
        {grant && tools.length > 0 && (
          <button
            type="button"
            className="button button-sm shrink-0"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Tools
          </button>
        )}
      </div>
      {grant && open && (
        <ul className="ml-7 flex flex-col gap-2">
          {tools.map((tool) => {
            const readOnly = isReadOnly(connector, tool);
            return (
              <li key={tool.name} className="flex min-h-8 items-center gap-3 text-body-s">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-brand-fill"
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
                    className="field h-7 w-auto shrink-0 py-0 text-label"
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const visible = connectors.filter(
    ({ ownerBotId }) => ownerBotId === null || ownerBotId === bot.id,
  );

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
    <SidePanel
      label={`${bot.name} connectors`}
      botName={bot.name}
      title="Connectors"
      onClose={onClose}
    >
      <p className="text-body-s text-ink-secondary">
        Apps this bot may use. Tools that write ask you first unless you allow them here. Add apps
        on the Usage page, under Connectors.
      </p>
      {visible.length === 0 && <EmptyState icon={Plug} title="No connectors yet" />}
      <ul className="flex flex-col gap-4">
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
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </SidePanel>
  );
}
