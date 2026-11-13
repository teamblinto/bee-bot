import type { Connector, ConnectorStatus, ConnectorTool } from "@beebot/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Decide, decide as policyDecide } from "./broker.ts";
import {
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

type Lookup = (host: string) => Promise<string[]>;

export type ExposedTool = { name: string; description: string; inputSchema: object };

class ConnectorError extends Error {
  readonly status: ConnectorStatus;
  constructor(status: ConnectorStatus, message: string) {
    super(message);
    this.status = status;
  }
}

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
  if (error instanceof UnauthorizedError || httpCode(error) === 401) {
    return { status: "needs_sign_in", message: "The server wants a sign-in or a valid token." };
  }
  const text = error instanceof Error ? error.message : String(error);
  return { status: "unreachable", message: text.slice(0, maxErrorChars) || "No answer." };
}

type Live = { client: Client; inflight: number; idle: NodeJS.Timeout | undefined };

type Options = {
  connectors: ConnectorStore;
  policy: Policy;
  vault: Vault;
  decide?: Decide | undefined;
  lookup?: Lookup | undefined;
  idleMs?: number | undefined;
  // A tool call that needs the owner. Without it, the call is refused.
  requestApproval?:
    | ((run: BrokerRun, tool: string, input: Record<string, unknown>) => string)
    | undefined;
};

export function createConnectorHub({
  connectors,
  policy,
  vault,
  decide = policyDecide,
  lookup,
  idleMs = defaultIdleMs,
  requestApproval,
}: Options) {
  const live = new Map<string, Promise<Live>>();
  const refreshing = new Map<string, Promise<void>>();
  const fetchGuarded = guardedFetch(lookup);

  // Every saved secret, so no result echoes one and no call carries one out.
  async function allSecrets() {
    const values: string[] = [];
    for (const name of connectors.secretNames()) {
      const text = await vault.get(name).catch(() => undefined);
      if (name.startsWith("api_key:")) {
        values.push(...(text ? [text] : []));
      } else {
        values.push(...secretValues(parseSecret(text)));
      }
    }
    return values;
  }

  async function connect(connector: Connector) {
    if (connector.transport !== "http" || !connector.url) {
      throw new ConnectorError("error", "Local servers aren't supported yet.");
    }
    const url = new URL(connector.url);
    await checkUrl(url, lookup);
    const headers = requestHeaders(parseSecret(await vault.get(secretName(connector.id))));
    const options = { fetch: fetchGuarded, requestInit: { headers } };
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
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void refresh(connector.id);
    });
    return client;
  }

  function forget(id: string) {
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
    let entry = live.get(connector.id);
    if (!entry) {
      entry = connect(connector).then((client): Live => {
        client.onclose = () => {
          if (live.get(connector.id) === entry) {
            live.delete(connector.id);
          }
        };
        return { client, inflight: 0, idle: undefined };
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
      held.idle = setTimeout(() => forget(id), idleMs);
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
        if (attempt > 0 || httpCode(error) !== 404) {
          throw error;
        }
        forget(connector.id);
      } finally {
        release(connector.id, held);
      }
    }
  }

  async function fail(connector: Connector, error: unknown) {
    const { status, message } = failureOf(error);
    connectors.setConnectorStatus(connector.id, status, redact(message, await allSecrets()));
    forget(connector.id);
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
    const now = Date.now();
    const stale = connectors
      .connectorGrants(botId)
      .filter(
        ({ connector }) =>
          connector.transport === "http" &&
          (connector.refreshedAt === null || now - Date.parse(connector.refreshedAt) > staleMs),
      );
    if (stale.length > 0) {
      const waited = new Promise((resolve) => setTimeout(resolve, staleWaitMs).unref());
      await Promise.race([
        Promise.all(stale.map(({ connector }) => refresh(connector.id))),
        waited,
      ]);
    }
    return connectors.connectorGrants(botId).flatMap(({ connector, grant }) =>
      exposedTools(connector, grant).map((tool) => ({
        name: exposedName(connector.slug, tool.name),
        description: `${connector.name}: ${tool.description}`.trim(),
        inputSchema: tool.inputSchema,
      })),
    );
  }

  // Only connectors this bot could ever see, so another bot's private one stays unknown.
  function resolve(botId: string, name: string) {
    for (const connector of connectors.listConnectors()) {
      if (connector.ownerBotId !== null && connector.ownerBotId !== botId) {
        continue;
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
    try {
      const result = await withClient(connector, (client) =>
        client.callTool({ name: tool.name, arguments: args }, undefined, {
          timeout: callMs,
          ...(signal && { signal }),
        }),
      );
      const text = flattenContent(result.content, result.structuredContent);
      const isError = result.isError === true;
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
    const input = z.record(z.string(), z.unknown()).safeParse(args ?? {}).data;
    let refusal: string | undefined;
    if (!grant || !granted(grant, tool.name)) {
      refusal = "not_granted";
    } else if (!exposedTools(connector, grant).includes(tool)) {
      refusal = tool.excluded ? "tool_excluded" : "not_reviewed";
    } else if (!input) {
      refusal = "bad_input";
    } else if (holdsSecret(input, await allSecrets())) {
      refusal = "secret_in_input";
    }
    const rule = connectorRule(connector, tool, grant ?? { allowWrites: [] });
    const decideCall: Decide = refusal ? () => ({ kind: "deny", reason: refusal }) : decide;
    const decision = policy.check(run, name, args, decideCall, rule);
    if (decision.kind === "deny" || decision.kind === "hand_off") {
      return refusedText(decision);
    }
    if (!input) {
      return refusedText({ kind: "deny", reason: "bad_input" });
    }
    if (decision.kind === "approve") {
      return requestApproval ? requestApproval(run, name, input) : refusedText(decision);
    }
    return (await execute(connector, tool, input, signal)).output;
  }

  return {
    refresh,
    forget,
    toolsFor,
    call,
    // An approved write, run once after the owner said yes.
    runApproved: async (botId: string, name: string, input: Record<string, unknown>) => {
      const found = resolve(botId, name);
      const grant = found?.connector.grants.find((entry) => entry.botId === botId);
      if (!found || !grant || !exposedTools(found.connector, grant).includes(found.tool)) {
        return { ok: false, output: "This tool is no longer granted to the bot." };
      }
      return execute(found.connector, found.tool, input);
    },
    close: () => {
      for (const id of live.keys()) {
        forget(id);
      }
    },
  };
}

export type ConnectorHub = ReturnType<typeof createConnectorHub>;
