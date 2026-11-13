import {
  type Connector,
  type ConnectorStatus,
  type ConnectorTool,
  connectorToolPrefix,
} from "@beebot/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Decide, decide as policyDecide } from "./broker.ts";
import type { BoxRuntime } from "./boxRuntime.ts";
import { boxedArgv, BoxStdioTransport, connectorBoxId } from "./connectorBox.ts";
import { createConnectorOauth, oauthSecretValues } from "./connectorOauth.ts";
import {
  capMiddle,
  checkUrl,
  type ConnectorStore,
  connectorRule,
  ConnectorUrlError,
  exposedName,
  exposedTools,
  flattenContent,
  granted,
  guardedFetch,
  holdsSecret,
  ListedTool,
  parseSecret,
  prepareTools,
  redact,
  requestHeaders,
  secretName,
  secretValues,
  untrustedResult,
} from "./connectors.ts";
import { type BrokerRun, type Policy, refusedText } from "./policy.ts";
import type { Vault } from "./vault.ts";

const defaultIdleMs = 10 * 60_000;
const connectMs = 15_000;
const callMs = 60_000;
const staleMs = 24 * 60 * 60_000;
// A run waits this long for a stale list, then goes on with the cached one.
const staleWaitMs = 5000;
const maxPages = 50;
const maxErrorChars = 200;
const maxStderrChars = 400;
const maxShownChars = 4000;
const firstBackoffMs = 30_000;
const maxBackoffMs = 5 * 60_000;
// An MCP server's JSON-RPC answer, sent with HTTP 200, that it wants a sign-in.
const authRequiredCode = -32302;

type Lookup = (host: string) => Promise<string[]>;

export type ExposedTool = { name: string; description: string; inputSchema: object };

class ConnectorError extends Error {
  readonly status: ConnectorStatus;
  constructor(status: ConnectorStatus, message: string) {
    super(message);
    this.status = status;
  }
}

// Refused without a request while the connector backs off. It leaves the status as it was.
class BackingOff extends ConnectorError {}

const waitsForOwner = ({ status }: Connector) =>
  status === "needs_sign_in" || status === "needs_client";

// What the bot reads in place of a connector's tools. Never the owner's error text or a sign-in URL.
const unavailableWhy: Record<ConnectorStatus, string> = {
  ok: "",
  needs_sign_in: "its sign-in has ended, and only the owner can sign in again",
  needs_client: "the owner has to give Bee Bot a client ID for it first",
  unreachable: "it can't be reached right now",
  error: "it isn't working",
};
const unavailableText = (connector: Connector) =>
  `${connector.name} is unavailable: ${unavailableWhy[connector.status]}. Don't retry. Tell the owner, and ask them to fix it under Connectors in Bee Bot's settings.`;
const reconnectNotice = (connector: Connector) =>
  `Reconnect ${connector.name}: its sign-in has ended, so bots can't use it. Sign in again under Connectors in Settings.`;

const httpCode = (error: unknown) =>
  error instanceof StreamableHTTPError ? error.code : undefined;

// The status a failure leaves, and plain words for the owner. No secret reaches these: requests
// carry them only in headers, which errors don't quote, and the text is redacted besides.
function failureOf(error: unknown): { status: ConnectorStatus; message: string } {
  if (error instanceof ConnectorError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof ConnectorUrlError) {
    return { status: "error", message: `The address isn't allowed (${error.message}).` };
  }
  if (
    error instanceof UnauthorizedError ||
    httpCode(error) === 401 ||
    (error instanceof McpError && error.code === authRequiredCode)
  ) {
    return { status: "needs_sign_in", message: "The server wants a sign-in or a valid token." };
  }
  const text = error instanceof Error ? error.message : String(error);
  return { status: "unreachable", message: text.slice(0, maxErrorChars) || "No answer." };
}

type Live = {
  client: Client;
  inflight: number;
  idle: NodeJS.Timeout | undefined;
  // A local server's stderr so far, which it prints only once it has exited.
  stderr?: (() => string) | undefined;
};

// Where local servers run. `env` is the box's fixed HOME, PATH and proxy variables.
export type ConnectorBoxes = { runtime: BoxRuntime; env: Record<string, string> };
const noBoxes =
  "Local servers run in a box of their own, and boxes aren't set up. Set them up in Settings.";

type Options = {
  connectors: ConnectorStore;
  policy: Policy;
  vault: Vault;
  box?: ConnectorBoxes | undefined;
  decide?: Decide | undefined;
  lookup?: Lookup | undefined;
  idleMs?: number | undefined;
  // A tool call that needs the owner. Without it, the call is refused.
  requestApproval?:
    | ((run: BrokerRun, tool: string, input: Record<string, unknown>, shown: string) => string)
    | undefined;
  // A line for the owner in the run's room.
  notify?: ((run: BrokerRun, text: string) => void) | undefined;
  now?: (() => number) | undefined;
};

export function createConnectorHub({
  connectors,
  policy,
  vault,
  box,
  decide = policyDecide,
  lookup,
  idleMs = defaultIdleMs,
  requestApproval,
  notify = () => {},
  now = Date.now,
}: Options) {
  const live = new Map<string, Promise<Live>>();
  const refreshing = new Map<string, Promise<void>>();
  const backoff = new Map<string, { until: number; delayMs: number }>();
  // Run and connector pairs already told to reconnect.
  const noticed = new Set<string>();
  const fetchGuarded = guardedFetch(lookup);
  const oauth = createConnectorOauth({ connectors, vault, fetchFn: fetchGuarded, now });

  // Every saved secret, so no result echoes one and no call carries one out.
  async function allSecrets() {
    const values: string[] = [];
    for (const name of connectors.secretNames()) {
      const text = await vault.get(name).catch(() => undefined);
      if (name.startsWith("api_key:")) {
        values.push(...(text ? [text] : []));
      } else if (name.endsWith(":oauth")) {
        values.push(...oauthSecretValues(text));
      } else {
        values.push(...secretValues(parseSecret(text)));
      }
    }
    return values;
  }

  // The stderr tail, redacted, for the owner.
  async function stderrText(stderr: string) {
    return redact(stderr.trim(), await allSecrets()).slice(-maxStderrChars);
  }

  // Never on this computer: only in the connector's own box, with only the env it was given.
  async function connectBoxed(connector: Connector, command: string) {
    if (!box) {
      throw new ConnectorError("error", noBoxes);
    }
    const { env = {} } = parseSecret(await vault.get(secretName(connector.id)));
    const transport = new BoxStdioTransport(() =>
      box.runtime.execAttach(connectorBoxId(connector.id), {
        argv: boxedArgv(command, connector.args),
        env: { ...env, ...box.env },
      }),
    );
    const client = new Client({ name: "bee-bot", version: "1" });
    try {
      await client.connect(transport, { timeout: connectMs });
    } catch (error) {
      await client.close();
      const stderr = await stderrText(transport.stderr);
      throw new ConnectorError("error", stderr || failureOf(error).message);
    }
    // It ended on its own: the next call starts it again, and the owner sees why it stopped.
    transport.onexit = (stderr) => {
      void stderrText(stderr || "The server stopped.").then((text) => {
        const current = connectors.getConnector(connector.id);
        if (current) {
          connectors.setConnectorStatus(connector.id, current.status, text);
        }
      });
    };
    return { client, stderr: () => transport.stderr };
  }

  async function connect(connector: Connector): Promise<{ client: Client; stderr?: () => string }> {
    if (connector.transport === "stdio" && connector.command) {
      return connectBoxed(connector, connector.command);
    }
    if (!connector.url) {
      throw new ConnectorError("error", "It has no address.");
    }
    const url = new URL(connector.url);
    await checkUrl(url, lookup);
    const headers = requestHeaders(parseSecret(await vault.get(secretName(connector.id))));
    // The token is read for each request, so a refresh reaches a connection already open.
    const signedFetch = async (input: string | URL, init?: RequestInit) => {
      const signed = new Headers(init?.headers);
      signed.set("Authorization", `Bearer ${await oauth.accessToken(connector)}`);
      return fetchGuarded(input, { ...init, headers: signed });
    };
    const options = {
      fetch: connector.auth === "oauth" ? signedFetch : fetchGuarded,
      requestInit: { headers },
    };
    const client = new Client({ name: "bee-bot", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, options), { timeout: connectMs });
    } catch (error) {
      const code = httpCode(error);
      // An older server speaks HTTP+SSE: it refuses the POST that streamable HTTP starts with.
      if (code === undefined || code === 401 || code >= 500) {
        throw error;
      }
      await client.connect(new SSEClientTransport(url, options), { timeout: connectMs });
    }
    return { client };
  }

  function drop(id: string) {
    const entry = live.get(id);
    live.delete(id);
    void entry?.then(
      ({ client, idle }) => {
        clearTimeout(idle);
        return client.close();
      },
      () => {},
    );
  }

  async function acquire(connector: Connector) {
    const wait = backoff.get(connector.id);
    if (wait && now() < wait.until) {
      const seconds = Math.ceil((wait.until - now()) / 1000);
      throw new BackingOff("unreachable", `Not tried again for ${seconds} s.`);
    }
    let entry = live.get(connector.id);
    if (!entry) {
      entry = connect(connector).then(({ client, stderr }): Live => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          void refresh(connector.id);
        });
        client.onclose = () => {
          if (live.get(connector.id) === entry) {
            live.delete(connector.id);
          }
        };
        return { client, inflight: 0, idle: undefined, stderr };
      });
      live.set(connector.id, entry);
      entry.catch(() => live.get(connector.id) === entry && live.delete(connector.id));
    }
    const held = await entry;
    held.inflight += 1;
    clearTimeout(held.idle);
    return held;
  }

  function release(id: string, held: Live) {
    held.inflight -= 1;
    if (held.inflight === 0) {
      held.idle = setTimeout(() => {
        drop(id);
        // The process first, then its box.
        if (held.stderr) {
          box?.runtime.stop(connectorBoxId(id)).catch(() => {});
        }
      }, idleMs);
      held.idle.unref();
    }
  }

  // An expired session (404) gets one fresh connection and one more try.
  async function withClient<T>(connector: Connector, work: (client: Client) => Promise<T>) {
    for (let attempt = 0; ; attempt += 1) {
      const held = await acquire(connector);
      try {
        return await work(held.client);
      } catch (error) {
        // A local server that failed says why on stderr, if it said anything.
        if (held.stderr && !(error instanceof ConnectorError)) {
          const stderr = await stderrText(held.stderr());
          throw new ConnectorError("error", stderr || failureOf(error).message);
        }
        if (attempt > 0 || httpCode(error) !== 404) {
          throw error;
        }
        drop(connector.id);
      } finally {
        release(connector.id, held);
      }
    }
  }

  // An unreachable server waits 30 s, then twice as long each time, up to 5 min. A sign-in that
  // ended waits for the owner, so nothing retries it.
  async function fail(connector: Connector, error: unknown) {
    if (error instanceof BackingOff) {
      return;
    }
    const { status, message } = failureOf(error);
    connectors.setConnectorStatus(connector.id, status, redact(message, await allSecrets()));
    drop(connector.id);
    if (status === "unreachable") {
      const before = backoff.get(connector.id)?.delayMs;
      const delayMs = before === undefined ? firstBackoffMs : Math.min(before * 2, maxBackoffMs);
      backoff.set(connector.id, { until: now() + delayMs, delayMs });
    }
  }

  function noticeOnce(run: BrokerRun, connector: Connector) {
    const key = `${run.id} ${connector.id}`;
    if (connector.status !== "needs_sign_in" || noticed.has(key)) {
      return;
    }
    // shortcut: forgets every pair past 1000, so a long-lived run may be told twice.
    if (noticed.size >= 1000) {
      noticed.clear();
    }
    noticed.add(key);
    notify(run, reconnectNotice(connector));
  }

  // `initialize` and every page of `tools/list`. One at a time per connector.
  function refresh(id: string) {
    const running = refreshing.get(id);
    if (running) {
      return running;
    }
    const work = (async () => {
      const connector = connectors.getConnector(id);
      if (!connector) {
        return;
      }
      try {
        const listed: unknown[] = [];
        await withClient(connector, async (client) => {
          let cursor: string | undefined;
          for (let page = 0; page < maxPages; page += 1) {
            const result = await client.listTools(cursor ? { cursor } : {}, { timeout: callMs });
            listed.push(...result.tools);
            cursor = result.nextCursor;
            if (!cursor) {
              break;
            }
          }
        });
        const tools = listed.flatMap((tool) => ListedTool.safeParse(tool).data ?? []);
        backoff.delete(id);
        connectors.saveTools(id, prepareTools(connector.slug, tools));
      } catch (error) {
        await fail(connector, error);
      }
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, work);
    return work;
  }

  // Grants are read afresh on every list: a tool listed is not a tool granted.
  async function toolsFor(botId: string): Promise<ExposedTool[]> {
    const at = now();
    const stale = connectors
      .connectorGrants(botId)
      .filter(
        ({ connector }) =>
          !waitsForOwner(connector) &&
          (connector.refreshedAt === null || at - Date.parse(connector.refreshedAt) > staleMs),
      );
    if (stale.length > 0) {
      const waited = new Promise((resolve) => setTimeout(resolve, staleWaitMs).unref());
      await Promise.race([
        Promise.all(stale.map(({ connector }) => refresh(connector.id))),
        waited,
      ]);
    }
    return connectors.connectorGrants(botId).flatMap(({ connector, grant }) =>
      connector.status === "ok"
        ? exposedTools(connector, grant).map((tool) => ({
            name: exposedName(connector.slug, tool.name),
            description: `${connector.name}: ${tool.description}`.trim(),
            inputSchema: tool.inputSchema,
          }))
        : [
            {
              name: unavailableName(connector),
              description: unavailableText(connector),
              inputSchema: { type: "object", properties: {} },
            },
          ],
    );
  }

  const unavailableName = (connector: Connector) => `${connector.slug}_unavailable`;

  // Only connectors this bot could ever see, so another bot's private one stays unknown.
  function resolve(botId: string, name: string) {
    for (const connector of connectors.listConnectors()) {
      if (connector.ownerBotId !== null && connector.ownerBotId !== botId) {
        continue;
      }
      if (connector.status !== "ok" && name === unavailableName(connector)) {
        return { connector, tool: undefined };
      }
      const tool = connector.tools.find(
        (entry) => exposedName(connector.slug, entry.name) === name,
      );
      if (tool) {
        return { connector, tool };
      }
    }
    return undefined;
  }

  async function execute(
    connector: Connector,
    tool: ConnectorTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (waitsForOwner(connector)) {
      return { ok: false, output: unavailableText(connector) };
    }
    try {
      const result = await withClient(connector, (client) =>
        client.callTool({ name: tool.name, arguments: args }, undefined, {
          timeout: callMs,
          ...(signal && { signal }),
        }),
      );
      const text = flattenContent(result.content, result.structuredContent);
      const isError = result.isError === true;
      backoff.delete(connector.id);
      return {
        ok: !isError,
        output: untrustedResult(connector.name, redact(text, await allSecrets()), isError),
      };
    } catch (error) {
      if (signal?.aborted) {
        return { ok: false, output: "The call was stopped." };
      }
      await fail(connector, error);
      const { message } = failureOf(error);
      return {
        ok: false,
        output: `${connector.name} couldn't take the call: ${redact(message, await allSecrets())}`,
      };
    }
  }

  // Authorized, decided, audited once, then run.
  async function call(run: BrokerRun, name: string, args: unknown, signal: AbortSignal) {
    const found = resolve(run.botId, name);
    if (!found) {
      // A tool no table knows is denied, and the denial is audited.
      const unknown = policy.check(run, name, args, decide);
      return refusedText(
        unknown.kind === "allow" ? { kind: "deny", reason: "unknown_tool" } : unknown,
      );
    }
    const { connector, tool } = found;
    const grant = connector.grants.find((entry) => entry.botId === run.botId);
    if (!tool) {
      const reason = grant ? "connector_unavailable" : "not_granted";
      policy.check(run, name, args, () => ({ kind: "deny", reason }));
      if (grant) {
        noticeOnce(run, connector);
      }
      return grant ? unavailableText(connector) : refusedText({ kind: "deny", reason });
    }
    const input = z.record(z.string(), z.unknown()).safeParse(args ?? {}).data;
    let refusal: string | undefined;
    if (!grant || !granted(grant, tool.name)) {
      refusal = "not_granted";
    } else if (!exposedTools(connector, grant).includes(tool)) {
      refusal = tool.excluded ? "tool_excluded" : "not_reviewed";
    } else if (waitsForOwner(connector)) {
      refusal = "connector_unavailable";
    } else if (!input) {
      refusal = "bad_input";
    } else if (holdsSecret(input, await allSecrets())) {
      refusal = "secret_in_input";
    }
    const rule = connectorRule(connector, tool, grant ?? { allowWrites: [] });
    const decideCall: Decide = refusal ? () => ({ kind: "deny", reason: refusal }) : decide;
    const decision = policy.check(run, name, args, decideCall, rule);
    if (refusal === "connector_unavailable") {
      noticeOnce(run, connector);
    }
    if (decision.kind === "deny" || decision.kind === "hand_off") {
      return refusedText(decision);
    }
    if (!input) {
      return refusedText({ kind: "deny", reason: "bad_input" });
    }
    if (decision.kind === "approve") {
      if (!requestApproval) {
        return refusedText(decision);
      }
      const shownInput = redact(JSON.stringify(input, null, 2), await allSecrets());
      const shown = `${connector.name}: ${tool.name}\n${capMiddle(shownInput, maxShownChars)}`;
      return requestApproval(run, `${connectorToolPrefix}${name}`, input, shown);
    }
    const result = await execute(connector, tool, input, signal);
    const after = result.ok ? undefined : connectors.getConnector(connector.id);
    if (after) {
      noticeOnce(run, after);
    }
    return result.output;
  }

  // A tool the bot may use right now, by the name its engine calls it.
  function grantedTool(botId: string, prefixed: string) {
    if (!prefixed.startsWith(connectorToolPrefix)) {
      return undefined;
    }
    const found = resolve(botId, prefixed.slice(connectorToolPrefix.length));
    const grant = found?.connector.grants.find((entry) => entry.botId === botId);
    return found?.tool && grant && exposedTools(found.connector, grant).includes(found.tool)
      ? { connector: found.connector, tool: found.tool }
      : undefined;
  }

  return {
    oauth,
    refresh,
    // The owner changed something: connect afresh, and try now.
    forget: (id: string) => {
      backoff.delete(id);
      drop(id);
    },
    toolsFor,
    call,
    // A deleted connector's box goes with it.
    destroyBox: async (id: string) => {
      await box?.runtime.destroy(connectorBoxId(id));
    },
    granted: (botId: string, prefixed: string) => grantedTool(botId, prefixed) !== undefined,
    // "Always allow": this write stops asking for this bot.
    allowAlways: (botId: string, prefixed: string) => {
      const found = grantedTool(botId, prefixed);
      if (found) {
        connectors.allowConnectorWrite(botId, found.connector.id, found.tool.name);
      }
      return found !== undefined;
    },
    // An approved write, run once after the owner said yes.
    runApproved: async (botId: string, prefixed: string, input: Record<string, unknown>) => {
      const found = grantedTool(botId, prefixed);
      if (!found) {
        return { ok: false, output: "This tool is no longer granted to the bot." };
      }
      return execute(found.connector, found.tool, input);
    },
    close: () => {
      for (const id of live.keys()) {
        drop(id);
      }
    },
  };
}

export type ConnectorHub = ReturnType<typeof createConnectorHub>;
