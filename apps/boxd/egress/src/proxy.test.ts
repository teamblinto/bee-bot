import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeDns from "node:dns";
import { once } from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, type MockInstance, vi } from "vite-plus/test";

import { dnsQuery } from "./dns.ts";
import { type LogLine, startEgress } from "./proxy.ts";

const canary = "sk-ant-canary-must-only-reach-the-vendor";
const cleanups: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

type Seen = { url: string; headers: NodeHttp.IncomingHttpHeaders };

async function recorder(
  handle: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
) {
  const seen: Seen[] = [];
  const server = NodeHttp.createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    handle(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { seen, port: (server.address() as NodeNet.AddressInfo).port };
}

const socketPath = (name: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\beebot-${name}-${NodeCrypto.randomUUID()}`
    : // macOS caps a socket path at 104 bytes and its tmpdir alone is ~50, so no full UUID here.
      NodePath.join(
        NodeOS.tmpdir(),
        `beebot-${name}-${NodeCrypto.randomBytes(4).toString("hex")}.sock`,
      );

async function startProxy(vendorPort: number, bee?: string) {
  const control = socketPath("egress-test");
  const logs: LogLine[] = [];
  const egress = await startEgress(
    {
      listen: ["127.0.0.1"],
      dnsPort: 0,
      proxyPort: 0,
      apiPort: 0,
      control,
      ...(bee !== undefined && { bee }),
      testUpstreams: { anthropic: `http://127.0.0.1:${vendorPort}` },
    },
    (line) => logs.push(line),
  );
  cleanups.push(() => egress.close());
  const ports = egress.ports[0] ?? { dns: 0, proxy: 0, api: 0 };
  return { control, logs, ports };
}

async function controlClient(path: string) {
  const socket = NodeNet.connect(path);
  await once(socket, "connect");
  socket.setEncoding("utf8");
  cleanups.push(() => {
    socket.destroy();
  });
  let buffered = "";
  const waiting: ((line: string) => void)[] = [];
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      waiting.shift()?.(line);
    }
  });
  return {
    socket,
    send: (message: object) =>
      new Promise<unknown>((resolve) => {
        waiting.push((line) => resolve(JSON.parse(line)));
        socket.write(`${JSON.stringify(message)}\n`);
      }),
  };
}

function boxRequest(port: number, path: string, headers: NodeHttp.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: string; headers: NodeHttp.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port, path, headers, agent: false },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    },
  );
}

function boxConnect(port: number, authority: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      reply += chunk;
    });
    socket.on("close", () => resolve(reply.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

async function boxDns(port: number, name: string) {
  const socket = NodeDgram.createSocket("udp4");
  cleanups.push(() => {
    socket.close();
  });
  socket.send(dnsQuery(7, name), port, "127.0.0.1");
  const [reply] = (await once(socket, "message")) as [Buffer];
  return { rcode: reply.readUInt16BE(2) & 0xf, answers: reply.readUInt16BE(6) };
}

describe("egress proxy on real sockets", () => {
  it("carries /bee/* to beebotd for a known box, with its own token and no key", async () => {
    const vendor = await recorder((_request, response) => response.end("vendor"));
    const bee = socketPath("bee-test");
    const seen: Seen[] = [];
    const beebotd = NodeHttp.createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      response.end("bee-ok");
    });
    beebotd.listen(bee);
    await once(beebotd, "listening");
    cleanups.push(() => new Promise((resolve) => beebotd.close(resolve)));
    const { control, ports } = await startProxy(vendor.port, bee);
    const auth = { authorization: "Bearer box-token" };

    expect((await boxRequest(ports.api, "/bee/mcp", auth)).status).toBe(403);
    const client = await controlClient(control);
    await client.send({ type: "bind", address: "127.0.0.1", botId: "b1" });
    expect(await boxRequest(ports.api, "/bee//evil", auth)).toMatchObject({ status: 400 });
    expect(await boxRequest(ports.api, "/bee/mcp?x=1", auth)).toMatchObject({
      status: 200,
      body: "bee-ok",
    });
    expect(seen).toEqual([
      expect.objectContaining({
        url: "/mcp?x=1",
        headers: expect.objectContaining({ authorization: "Bearer box-token" }),
      }),
    ]);
    expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
    expect(vendor.seen).toEqual([]);
  });

  it("sends the API key only to the vendor's API host, whatever the box asks", async () => {
    const attacker = await recorder((_request, response) => response.end("stolen"));
    const vendor = await recorder((request, response) => {
      if (request.url === "/v1/redirect") {
        response.writeHead(302, { location: `http://127.0.0.1:${attacker.port}/followed` });
        return response.end();
      }
      response.end("vendor ok");
    });
    const { control, logs, ports } = await startProxy(vendor.port);
    const client = await controlClient(control);
    expect(await client.send({ type: "bind", address: "127.0.0.1", botId: "b1" })).toEqual({
      ok: true,
    });
    expect(
      await client.send({
        type: "policy",
        botId: "b1",
        hosts: ["pypi.org"],
        subscription: null,
        api: { vendor: "anthropic", key: canary },
      }),
    ).toEqual({ ok: true });

    const ok = await boxRequest(ports.api, "/anthropic/v1/messages?beta=true", {
      "x-api-key": "box-placeholder",
      authorization: "Bearer box-placeholder",
    });
    expect(ok).toMatchObject({ status: 200, body: "vendor ok" });
    expect(vendor.seen).toEqual([
      expect.objectContaining({
        url: "/v1/messages?beta=true",
        headers: expect.objectContaining({ "x-api-key": canary, host: "api.anthropic.com" }),
      }),
    ]);
    expect(vendor.seen[0]?.headers.authorization).toBeUndefined();

    const target = `127.0.0.1:${attacker.port}`;
    for (const path of [
      `/anthropic//${target}/steal`,
      `/anthropic/\\\\${target}/steal`,
      `/anthropic/\\${target}/steal`,
      `/openai//${target}/steal`,
      `/openai/v1/responses`,
      `//${target}/anthropic/v1/messages`,
      `/${target}/anthropic/v1/messages`,
    ]) {
      // Refused before any upstream is tried: a 502 would mean the proxy attempted to go there.
      const denied = await boxRequest(ports.api, path);
      expect([400, 403], path).toContain(denied.status);
    }
    const redirected = await boxRequest(ports.api, "/anthropic/v1/redirect");
    expect(redirected.status).toBe(302);
    for (const authority of [target, `127.0.0.1:443`, `localhost:${attacker.port}`]) {
      expect(await boxConnect(ports.proxy, authority)).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(await boxRequest(ports.proxy, `http://${target}/steal`)).toMatchObject({ status: 403 });

    expect(attacker.seen).toEqual([]);
    expect(vendor.seen.map(({ url }) => url)).toEqual(["/v1/messages?beta=true", "/v1/redirect"]);
    expect(JSON.stringify(logs)).not.toContain(canary);
    expect(JSON.stringify(logs)).not.toContain("box-placeholder");
    expect(logs).toContainEqual(
      expect.objectContaining({
        ev: "api",
        bot: "b1",
        host: "api.anthropic.com",
        decision: "allow",
        bytesDown: "vendor ok".length,
      }),
    );
  });

  it("denies everything once the control connection is gone, and cuts open requests", async () => {
    const vendor = await recorder((request, response) => {
      if (request.url !== "/v1/hold") {
        response.end("ok");
      }
    });
    const { control, ports } = await startProxy(vendor.port);
    const client = await controlClient(control);
    await client.send({ type: "bind", address: "127.0.0.1", botId: "b1" });
    await client.send({
      type: "policy",
      botId: "b1",
      hosts: ["pypi.org"],
      subscription: null,
      api: { vendor: "anthropic", key: canary },
    });
    expect((await boxRequest(ports.api, "/anthropic/v1/messages")).status).toBe(200);
    expect(await boxDns(ports.dns, "pypi.org")).toEqual({ rcode: 0, answers: 1 });
    expect(await boxDns(ports.dns, "example.com")).toEqual({ rcode: 3, answers: 0 });

    const held = boxRequest(ports.api, "/anthropic/v1/hold");
    while (vendor.seen.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    client.socket.destroy();
    await expect(held).rejects.toThrow();

    expect(await boxRequest(ports.api, "/anthropic/v1/messages")).toMatchObject({ status: 403 });
    expect(await boxDns(ports.dns, "pypi.org")).toEqual({ rcode: 3, answers: 0 });
    expect(await boxConnect(ports.proxy, "api.anthropic.com:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(vendor.seen).toHaveLength(2);
  });

  it("lets an any-site bot look up any name, but not connect where it resolves privately", async () => {
    const vendor = await recorder((_request, response) => response.end("ok"));
    const { control, logs, ports } = await startProxy(vendor.port);
    const client = await controlClient(control);
    await client.send({ type: "bind", address: "127.0.0.1", botId: "b1" });
    await client.send({
      type: "policy",
      botId: "b1",
      hosts: [],
      anySite: true,
      subscription: null,
      api: { vendor: "anthropic", key: canary },
    });
    expect(await boxDns(ports.dns, "example.com")).toEqual({ rcode: 0, answers: 1 });
    expect(await boxDns(ports.dns, "api.anthropic.com")).toEqual({ rcode: 3, answers: 0 });

    // A public name whose DNS answers with a private address, as in DNS rebinding.
    // The proxy calls the `all: true` overload, which spyOn's inferred type can't pick.
    const lookup = vi.spyOn(NodeDns.promises, "lookup") as unknown as MockInstance<
      () => Promise<NodeDns.LookupAddress[]>
    >;
    cleanups.push(() => lookup.mockRestore());
    for (const address of ["10.1.2.3", "169.254.169.254", "127.0.0.1", "100.64.0.1"]) {
      lookup.mockResolvedValueOnce([{ address, family: 4 }]);
      expect(await boxConnect(ports.proxy, "rebind.example:443")).toBe("HTTP/1.1 403 Forbidden");
      expect(logs.at(-1)).toMatchObject({
        host: "rebind.example:443",
        ip: address,
        reason: "resolved to denied range",
      });
    }
    expect(await boxConnect(ports.proxy, "169.254.169.254:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await boxConnect(ports.proxy, "api.anthropic.com:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(vendor.seen).toEqual([]);
  });

  it("connects to the address it checked, and refuses a socket that lands somewhere private", async () => {
    const local = await recorder((_request, response) => response.end("ok"));
    const { control, logs, ports } = await startProxy(local.port);
    const client = await controlClient(control);
    await client.send({ type: "bind", address: "127.0.0.1", botId: "b1" });
    await client.send({
      type: "policy",
      botId: "b1",
      hosts: ["rebind.example"],
      subscription: null,
      api: null,
    });

    // DNS rebinding: public on the check, loopback on any second look.
    const lookup = vi.spyOn(NodeDns.promises, "lookup") as unknown as MockInstance<
      () => Promise<NodeDns.LookupAddress[]>
    >;
    lookup.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }]);
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    // Whatever route the network takes, the socket ends up on loopback.
    const original = NodeNet.Socket.prototype.connect;
    const targets: unknown[] = [];
    const connect = vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (
      this: NodeNet.Socket,
      ...args: unknown[]
    ) {
      const options: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (
        options &&
        typeof options === "object" &&
        Reflect.get(options, "host") === "93.184.215.14"
      ) {
        targets.push(Reflect.get(options, "host"));
        Object.assign(options, { host: "127.0.0.1", port: local.port });
      }
      return Reflect.apply(original, this, args) as NodeNet.Socket;
    });
    cleanups.push(() => {
      connect.mockRestore();
      lookup.mockRestore();
    });

    expect(await boxConnect(ports.proxy, "rebind.example:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(targets).toEqual(["93.184.215.14"]);
    expect(logs.at(-1)).toMatchObject({ ip: "127.0.0.1", reason: "connected to denied range" });
    expect(local.seen).toEqual([]);
  });

  it("denies a source that no bot is bound to, and a bot with no API key", async () => {
    const vendor = await recorder((_request, response) => response.end("ok"));
    const { control, ports } = await startProxy(vendor.port);
    expect((await boxRequest(ports.api, "/anthropic/v1/messages")).status).toBe(403);
    expect(await boxDns(ports.dns, "api.anthropic.com")).toEqual({ rcode: 3, answers: 0 });

    const client = await controlClient(control);
    await client.send({ type: "bind", address: "127.0.0.1", botId: "b1" });
    await client.send({
      type: "policy",
      botId: "b1",
      hosts: ["api.anthropic.com"],
      subscription: null,
      api: null,
    });
    expect((await boxRequest(ports.api, "/anthropic/v1/messages")).status).toBe(403);
    expect(
      await client.send({
        type: "policy",
        botId: "b1",
        hosts: ["1.2.3.4"],
        subscription: null,
        api: null,
      }),
    ).toEqual({ ok: false, error: "policy has a bad host" });
    expect(vendor.seen).toEqual([]);
  });
});
