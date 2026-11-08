import * as NodeDgram from "node:dgram";
import * as NodeDns from "node:dns";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import type { Duplex } from "node:stream";

import { createPolicyTable, parseControl } from "./control.ts";
import { dnsReply } from "./dns.ts";
import {
  apiTarget,
  decideConnect,
  decideResolved,
  hostAllowed,
  keyHeader,
  type Vendor,
  vendorApi,
  vendors,
} from "./policy.ts";

export type EgressConfig = {
  // Addresses the boxes see. Each gets DNS, the CONNECT proxy and the API lane, and DNS answers
  // allowed names with the address the query arrived on.
  listen: string[];
  dnsPort: number;
  proxyPort: number;
  apiPort: number;
  // Unix socket path (a named pipe on Windows, for tests).
  control: string;
  // Tests only: a plain-HTTP stand-in that receives what would go to the vendor's API host.
  testUpstreams?: Partial<Record<Vendor, string>>;
};

export type LogLine = { ev: string } & Record<string, string | number | null>;

const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 65535;

export function parseConfig(value: unknown): EgressConfig | string {
  if (typeof value !== "object" || value === null) {
    return "config is not an object";
  }
  const { listen, dnsPort, proxyPort, apiPort, control, testUpstreams } = value as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(listen) ||
    listen.length === 0 ||
    !listen.every((address) => typeof address === "string" && NodeNet.isIP(address) !== 0)
  ) {
    return "listen needs IP addresses";
  }
  if (!isPort(dnsPort) || !isPort(proxyPort) || !isPort(apiPort)) {
    return "dnsPort, proxyPort and apiPort need port numbers";
  }
  if (typeof control !== "string" || control === "") {
    return "control needs a socket path";
  }
  const config: EgressConfig = { listen, dnsPort, proxyPort, apiPort, control };
  if (testUpstreams === undefined) {
    return config;
  }
  const upstreams: Partial<Record<Vendor, string>> = {};
  for (const [vendor, url] of Object.entries(testUpstreams ?? {})) {
    const known = vendors.find((name) => name === vendor);
    if (known === undefined || typeof url !== "string" || !url.startsWith("http://")) {
      return "testUpstreams maps a vendor to an http:// URL";
    }
    upstreams[known] = url;
  }
  return { ...config, testUpstreams: upstreams };
}

const hopByHop = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

function forwardHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  const out: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hopByHop.has(name) && !named.has(name)) {
      out[name] = value;
    }
  }
  return out;
}

async function resolvePublic(host: string) {
  const addresses = (await NodeDns.promises.lookup(host, { all: true })).map(
    ({ address }) => address,
  );
  return { addresses, decision: decideResolved(addresses) };
}

const maxControlLine = 64 * 1024;

export async function startEgress(
  config: EgressConfig,
  log: (line: LogLine) => void = (line) =>
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`),
) {
  const table = createPolicyTable();
  const open = new Map<string, Set<Duplex>>();

  const track = (botId: string, socket: Duplex) => {
    const sockets = open.get(botId) ?? new Set();
    open.set(botId, sockets.add(socket));
    socket.once("close", () => sockets.delete(socket));
  };
  // A bot whose policy changed or went away loses its open tunnels and requests.
  const endBots = (botIds: string[]) => {
    for (const botId of botIds) {
      for (const socket of open.get(botId) ?? []) {
        socket.destroy();
      }
      open.delete(botId);
    }
  };

  function onConnect(request: NodeHttp.IncomingMessage, client: Duplex, head: Buffer) {
    const remote = request.socket.remoteAddress;
    const { botId, policy } = table.lookup(remote);
    const target = request.url ?? "";
    client.on("error", () => client.destroy());
    const deny = (reason: string, ip: string | null = null) => {
      log({ ev: "connect", bot: botId, host: target, ip, decision: "deny", reason });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    };
    if (botId === null || policy === null) {
      return deny(botId === null ? "unknown source" : "no policy");
    }
    const decision = decideConnect(policy.hosts, target);
    if (!decision.allow) {
      return deny(decision.reason);
    }
    track(botId, client);
    resolvePublic(decision.host).then(
      ({ addresses, decision: resolved }) => {
        if (client.destroyed) {
          return;
        }
        if (!resolved.allow) {
          return deny(resolved.reason, addresses.join(","));
        }
        // Connect to the address that was checked, never the name again: no rebinding race.
        const upstream = NodeNet.connect({ host: resolved.address, port: decision.port });
        track(botId, upstream);
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => upstream.destroy());
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => {
          client.destroy();
          log({
            ev: "connect",
            bot: botId,
            host: decision.host,
            ip: resolved.address,
            decision: "allow",
            bytesUp: upstream.bytesWritten,
            bytesDown: upstream.bytesRead,
          });
        });
      },
      () => deny("resolve failed"),
    );
  }

  function onApi(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const { botId, policy } = table.lookup(request.socket.remoteAddress);
    const vendor = vendors.find((name) => (request.url ?? "").startsWith(`/${name}/`));
    const host = vendor === undefined ? null : vendorApi[vendor].host;
    const deny = (status: number, reason: string) => {
      log({ ev: "api", bot: botId, host, ip: null, decision: "deny", reason, status });
      response.writeHead(status, { connection: "close" }).end();
    };
    if (botId === null || policy === null) {
      return deny(403, botId === null ? "unknown source" : "no policy");
    }
    if (vendor === undefined || policy.api === null || policy.api.vendor !== vendor) {
      return deny(403, "no API lane for this vendor");
    }
    const url = apiTarget(vendor, request.url ?? "");
    if (url === null) {
      return deny(400, "path escapes upstream");
    }
    const key = keyHeader(vendor, url, policy.api.key);
    if (key === null) {
      return deny(403, "key refused for host");
    }
    track(botId, request.socket);
    const headers = { ...forwardHeaders(request.headers), host: url.host, [key[0]]: key[1] };
    let ip: string | null = null;
    let bytesUp = 0;
    let bytesDown = 0;
    // The stand-in replaces only the vendor host's connection, so any other host goes out as it
    // would in production.
    const test = url.hostname === host ? config.testUpstreams?.[vendor] : undefined;
    const options = { method: request.method, path: `${url.pathname}${url.search}`, headers };
    const upstream = test
      ? NodeHttp.request({
          ...options,
          host: new URL(test).hostname,
          port: new URL(test).port || 80,
        })
      : NodeHttps.request({
          ...options,
          host: url.hostname,
          port: 443,
          servername: url.hostname,
          lookup: (hostname, lookupOptions, callback) => {
            resolvePublic(hostname).then(
              ({ decision }) => {
                if (!decision.allow) {
                  return callback(new Error(decision.reason), "", 4);
                }
                ip = decision.address;
                const family = NodeNet.isIPv4(decision.address) ? 4 : 6;
                if (lookupOptions.all) {
                  return callback(null, [{ address: decision.address, family }]);
                }
                callback(null, decision.address, family);
              },
              (error: NodeJS.ErrnoException) => callback(error, "", 4),
            );
          },
        });
    upstream.on("socket", (socket) => {
      socket.once("connect", () => {
        ip ??= socket.remoteAddress ?? null;
      });
    });
    upstream.on("response", (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.on("data", (chunk: Buffer) => {
        bytesDown += chunk.length;
      });
      answer.pipe(response);
      answer.once("end", () => {
        log({
          ev: "api",
          bot: botId,
          host,
          ip,
          decision: "allow",
          status: answer.statusCode ?? null,
          bytesUp,
          bytesDown,
        });
      });
    });
    upstream.on("error", (error) => {
      log({
        ev: "api",
        bot: botId,
        host,
        ip,
        decision: "deny",
        reason: error.message,
        status: 502,
      });
      if (!response.headersSent) {
        response.writeHead(502, { connection: "close" });
      }
      response.end();
    });
    request.on("data", (chunk: Buffer) => {
      bytesUp += chunk.length;
    });
    request.on("error", () => upstream.destroy());
    response.once("close", () => {
      if (!response.writableFinished) {
        upstream.destroy();
      }
    });
    request.pipe(upstream);
  }

  function onDns(socket: NodeDgram.Socket, self: string) {
    socket.on("message", (message, from) => {
      const { botId, policy } = table.lookup(from.address);
      const result = dnsReply(message, (name) =>
        policy !== null && hostAllowed(policy.hosts, name) ? { address: self } : null,
      );
      if (result === null) {
        return;
      }
      socket.send(result.reply, from.port, from.address);
      log({
        ev: "dns",
        bot: botId,
        host: result.name,
        ip: null,
        decision: result.answer === "NXDOMAIN" || result.answer === "REFUSED" ? "deny" : "allow",
        reason: result.answer,
        type: result.type,
      });
    });
  }

  const controls = new Set<NodeNet.Socket>();
  function onControl(connection: NodeNet.Socket) {
    const owner = {};
    controls.add(connection);
    let buffered = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > maxControlLine && !buffered.includes("\n")) {
        connection.destroy();
        return;
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        const message = parseControl(line);
        if (typeof message === "string") {
          log({ ev: "control", decision: "deny", reason: message });
          connection.write(`${JSON.stringify({ ok: false, error: message })}\n`);
          continue;
        }
        endBots(table.apply(owner, message));
        log({
          ev: "control",
          decision: "allow",
          type: message.type,
          bot: "botId" in message ? message.botId : null,
        });
        connection.write(`${JSON.stringify({ ok: true })}\n`);
      }
    });
    connection.on("error", () => connection.destroy());
    connection.once("close", () => {
      controls.delete(connection);
      endBots(table.dropOwner(owner));
      log({ ev: "control", decision: "deny", reason: "control connection closed" });
    });
  }

  const servers: NodeNet.Server[] = [];
  const sockets: NodeDgram.Socket[] = [];
  const ports: { dns: number; proxy: number; api: number }[] = [];
  for (const address of config.listen) {
    const dns = NodeDgram.createSocket(NodeNet.isIPv6(address) ? "udp6" : "udp4");
    onDns(dns, address);
    dns.bind(config.dnsPort, address);
    await once(dns, "listening");
    sockets.push(dns);

    const proxy = NodeHttp.createServer((request, response) => {
      const { botId } = table.lookup(request.socket.remoteAddress);
      log({ ev: "connect", bot: botId, host: null, decision: "deny", reason: "plain HTTP" });
      response.writeHead(403, { connection: "close" }).end();
    });
    proxy.on("connect", onConnect);
    const api = NodeHttp.createServer(onApi);
    for (const [server, port] of [
      [proxy, config.proxyPort],
      [api, config.apiPort],
    ] as const) {
      server.on("clientError", (_error, socket) => socket.destroy());
      server.listen(port, address);
      await once(server, "listening");
      servers.push(server);
    }
    ports.push({
      dns: dns.address().port,
      proxy: (proxy.address() as NodeNet.AddressInfo).port,
      api: (api.address() as NodeNet.AddressInfo).port,
    });
  }

  const control = NodeNet.createServer(onControl);
  if (process.platform !== "win32") {
    NodeFS.rmSync(config.control, { force: true });
  }
  // Only the owner may connect: the socket is created 0600.
  const umask = process.platform === "win32" ? null : process.umask(0o177);
  try {
    control.listen(config.control);
    await once(control, "listening");
  } finally {
    if (umask !== null) {
      process.umask(umask);
    }
  }
  servers.push(control);

  if (config.testUpstreams !== undefined) {
    log({ ev: "start", warning: "testUpstreams set: API keys go to a stand-in" });
  }

  return {
    ports,
    close: async () => {
      endBots([...open.keys()]);
      for (const connection of controls) {
        connection.destroy();
      }
      for (const socket of sockets) {
        socket.close();
      }
      for (const server of servers) {
        (server as NodeHttp.Server).closeAllConnections?.();
      }
      await Promise.all(
        servers.map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
      );
    },
  };
}
