import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createAuth, sessionCookie } from "./auth.ts";
import { createGateway, type Provision, safeNext } from "./gateway.ts";
import { createInvite, findMember, inviteTtlMs, openGatewayDb } from "./store.ts";

const origin = "https://bee.example.test";
const password = "correct horse battery";
const unixSockets = process.platform !== "win32";

let dir: string;
let db: DatabaseSync;
let base: string;
let provisioned: string[];
let provisionResult: Awaited<ReturnType<Provision>>;
// Sign-in is rate limited per client address, so each test is its own client.
let clientIp = 0;
const cleanups: Array<() => unknown> = [];

// A stand-in beebotd: says which cell it is and what reached it.
async function fakeCell(cell: string) {
  const socketPath = NodePath.join(dir, "cells", cell, "beebotd.sock");
  NodeFS.mkdirSync(NodePath.dirname(socketPath), { recursive: true });
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ cell, path: request.url, headers: request.headers }));
  });
  server.on("upgrade", (request, socket: NodeNet.Socket) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Cell: ${cell}\r\n\r\n`,
    );
    socket.pipe(socket);
  });
  server.listen(socketPath);
  await once(server, "listening");
  cleanups.push(() => server.close());
}

beforeEach(async () => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-gateway-"));
  NodeFS.mkdirSync(NodePath.join(dir, "web", "assets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "web", "index.html"), "<!doctype html>app");
  NodeFS.writeFileSync(NodePath.join(dir, "web", "assets", "app.js"), "app()");
  NodeFS.writeFileSync(NodePath.join(dir, "secret.txt"), "not served");
  db = openGatewayDb(NodePath.join(dir, "gateway.db"));
  provisioned = [];
  clientIp += 1;
  provisionResult = { ok: true };
  const server = createGateway({
    auth: await createAuth(db, { secret: "s".repeat(32), origin }),
    db,
    origin,
    webDir: NodePath.join(dir, "web"),
    cellsDir: NodePath.join(dir, "cells"),
    provision: async (cell) => {
      provisioned.push(cell);
      if (provisionResult.ok && unixSockets) {
        await fakeCell(cell);
      }
      return provisionResult;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  db.close();
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

function post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": `10.0.0.${clientIp}`,
      ...headers,
    },
    body: new URLSearchParams(form),
  });
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${sessionCookie}=`))
    ?.split(";")[0];

async function signUp(email: string) {
  const response = await post(`/invite/${createInvite(db, email, false)}`, { password });
  expect(response.status).toBe(303);
  const cookie = cookieOf(response);
  expect(cookie).toBeDefined();
  return cookie!;
}

function upgrade(path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders }>((resolve) => {
    const request = NodeHttp.request(`${base}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": NodeCrypto.randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    request.on("upgrade", (reply, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: reply.headers });
    });
    request.on("response", (reply) => {
      reply.resume();
      resolve({ status: reply.statusCode!, headers: reply.headers });
    });
    request.end();
  });
}

describe("invites", () => {
  it("open once and create an account with a cell", async () => {
    const token = createInvite(db, "Ann@Example.test", false);
    expect((await fetch(`${base}/invite/${token}`)).status).toBe(200);
    const accepted = await post(`/invite/${token}`, { password });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/");
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatch(/^bb[0-9a-f]{10}$/);

    expect((await fetch(`${base}/invite/${token}`)).status).toBe(410);
    expect((await post(`/invite/${token}`, { password })).status).toBe(410);
    expect(provisioned).toHaveLength(1);
  });

  it("expire", async () => {
    const token = createInvite(db, "late@example.test", false, Date.now() - inviteTtlMs - 1);
    expect((await post(`/invite/${token}`, { password })).status).toBe(410);
    expect(provisioned).toEqual([]);
  });

  it("are the only way to sign up", async () => {
    const forged = NodeCrypto.randomBytes(32).toString("base64url");
    expect((await post(`/invite/${forged}`, { password })).status).toBe(410);
    const direct = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "x@example.test", password, name: "x" }),
    });
    expect(direct.status).toBe(401);
    expect(db.prepare(`SELECT count(*) AS n FROM "user"`).get()).toEqual({ n: 0 });
  });

  it("leave the account unusable when its cell can't be provisioned", async () => {
    provisionResult = { ok: false, error: "useradd failed" };
    const response = await post(`/invite/${createInvite(db, "bo@example.test", false)}`, {
      password,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("useradd failed");
    expect(cookieOf(response)).toBeUndefined();

    const login = await post("/login", { email: "bo@example.test", password, next: "/" });
    expect(login.status).toBe(403);
    expect(cookieOf(login)).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 0 });
  });
});

describe("sessions", () => {
  it("are stored only as hashes", async () => {
    const cookie = await signUp("cy@example.test");
    const raw = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
    const stored = db
      .prepare("SELECT token FROM session")
      .all()
      .map(({ token }) => token);
    expect(stored).toEqual([NodeCrypto.createHash("sha256").update(raw).digest("base64url")]);
    expect(JSON.stringify(db.prepare("SELECT * FROM session").all())).not.toContain(raw);
    // And the hashed row still signs its owner in.
    expect((await fetch(`${base}/assets/app.js`, { headers: { cookie } })).status).toBe(200);
  });

  it("set a __Host- cookie that is Secure, HttpOnly and Lax", async () => {
    const response = await post(`/invite/${createInvite(db, "di@example.test", false)}`, {
      password,
    });
    const header = response.headers.getSetCookie().find((c) => c.startsWith(sessionCookie))!;
    expect(header).toMatch(/; Secure/i);
    expect(header).toMatch(/; HttpOnly/i);
    expect(header).toMatch(/; SameSite=Lax/i);
    expect(header).toMatch(/; Path=\//i);
    expect(header).not.toMatch(/; Domain/i);
  });

  it("sign in, back to a safe next, and refuse a wrong password", async () => {
    await signUp("ed@example.test");
    const wrong = await post("/login", { email: "ed@example.test", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    const right = await post("/login", {
      email: "ed@example.test",
      password,
      next: "/?x=1#/bots/a",
    });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/?x=1#/bots/a");
    expect(cookieOf(right)).toBeDefined();
  });

  it("end on logout", async () => {
    const cookie = await signUp("fi@example.test");
    const out = await post("/logout", {}, { cookie });
    expect(out.status).toBe(303);
    expect((await fetch(`${base}/assets/app.js`, { headers: { cookie } })).status).toBe(401);
  });
});

describe("without a session", () => {
  it("refuses the API and the socket, and sends the app to sign in", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(401);
    expect((await upgrade("/ws", { origin })).status).toBe(401);
    const app = await fetch(`${base}/`, { redirect: "manual" });
    expect(app.status).toBe(303);
    expect(app.headers.get("location")).toBe("/login?next=%2F");
    expect((await fetch(`${base}/login`)).status).toBe(200);
  });

  it("refuses a forged cookie", async () => {
    const cookie = `${sessionCookie}=${"a".repeat(32)}.${"b".repeat(44)}`;
    expect((await fetch(`${base}/health`, { headers: { cookie } })).status).toBe(401);
  });
});

describe("with a session", () => {
  it("refuses a write or a socket from another origin", async () => {
    const cookie = await signUp("gu@example.test");
    const headers = { cookie, "content-type": "application/json" };
    const elsewhere = await fetch(`${base}/commands`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: "{}",
    });
    expect(elsewhere.status).toBe(403);
    const none = await fetch(`${base}/commands`, { method: "POST", headers, body: "{}" });
    expect(none.status).toBe(403);
    expect((await upgrade("/ws", { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await upgrade("/ws", { cookie })).status).toBe(403);
  });

  it("serves the app but no file outside it", async () => {
    const cookie = await signUp("ha@example.test");
    const index = await fetch(`${base}/`, { headers: { cookie } });
    expect(await index.text()).toBe("<!doctype html>app");
    const escape = await fetch(`${base}/..%2fsecret.txt`, { headers: { cookie } });
    expect(await escape.text()).not.toContain("not served");
  });

  it("is 503 when the cell isn't answering, never another cell", async () => {
    provisionResult = { ok: true };
    const token = createInvite(db, "io@example.test", false);
    const original = provisioned.length;
    const accepted = await post(`/invite/${token}`, { password });
    const cookie = cookieOf(accepted)!;
    const cell = provisioned[original]!;
    // Its socket goes away, as when the unit is stopped.
    NodeFS.rmSync(NodePath.join(dir, "cells", cell), { recursive: true, force: true });
    expect((await fetch(`${base}/health`, { headers: { cookie } })).status).toBe(503);
  });

  it("is 503 for a suspended member", async () => {
    const cookie = await signUp("jo@example.test");
    db.prepare("UPDATE member SET state = 'suspended'").run();
    expect((await fetch(`${base}/health`, { headers: { cookie } })).status).toBe(503);
    expect((await upgrade("/ws", { cookie, origin })).status).toBe(503);
  });
});

describe.skipIf(!unixSockets)("proxy to cells", () => {
  it("reaches only the signed-in user's own cell", async () => {
    const alice = await signUp("alice@example.test");
    const bob = await signUp("bob@example.test");
    const [aliceCell, bobCell] = provisioned;
    const asAlice = await (
      await fetch(`${base}/health?protocolVersion=1`, {
        headers: { cookie: alice, authorization: "Bearer leak" },
      })
    ).json();
    expect(asAlice.cell).toBe(aliceCell);
    expect(asAlice.path).toBe("/health?protocolVersion=1");
    expect(asAlice.headers.cookie).toBeUndefined();
    expect(asAlice.headers.authorization).toBeUndefined();
    expect((await (await fetch(`${base}/state`, { headers: { cookie: bob } })).json()).cell).toBe(
      bobCell,
    );
  });

  it("forwards a write with its origin", async () => {
    const cookie = await signUp("kim@example.test");
    const reply = await fetch(`${base}/commands`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    });
    expect((await reply.json()).headers.origin).toBe(origin);
  });

  it("upgrades a same-origin socket to the user's own cell", async () => {
    const cookie = await signUp("lu@example.test");
    const reply = await upgrade("/ws?protocolVersion=1", { cookie, origin });
    expect(reply.status).toBe(101);
    expect(reply.headers["x-cell"]).toBe(provisioned[0]);
  });
});

it("follows next only to a path on this origin", () => {
  expect(safeNext("/?x=1#/bots/a")).toBe("/?x=1#/bots/a");
  expect(safeNext("/#/settings")).toBe("/#/settings");
  for (const hostile of [
    null,
    "",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil",
    "/\tevil",
    "/login",
  ]) {
    expect(safeNext(hostile)).toBe("/");
  }
});

it("keeps the cell from the database, not the request", async () => {
  await signUp("mo@example.test");
  const { user_id: userId } = db.prepare("SELECT user_id FROM member").get() as { user_id: string };
  expect(findMember(db, userId)?.cell).toBe(provisioned[0]);
});
