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
import { createGateway, type ProvisionReply, safeNext } from "./gateway.ts";
import { createInvite, inviteTtlMs, openGatewayDb, openInvite } from "./store.ts";

const origin = "https://bee.example.test";
const password = "correct horse battery";

let dir: string;
let cellsDir: string;
let db: DatabaseSync;
let base: string;
let provisioned: string[];
let provisionCalls: string[][];
let provisionResult: ProvisionReply;
let statusOf: (cell: string) => Promise<ProvisionReply>;
let cells: Map<string, NodeHttp.Server>;
// Sign-in is rate limited per client address, so each test is its own client.
let clientIp = 0;
const cleanups: Array<() => unknown> = [];

// A stand-in beebotd: says which cell it is and what reached it, and tries to set a cookie and its
// own policy on the gateway's origin.
async function fakeCell(cell: string) {
  if (cells.has(cell)) {
    return;
  }
  const socketPath = NodePath.join(cellsDir, `${cell}.sock`);
  // Windows has no unix socket at a file path, so there the cells are named pipes.
  if (process.platform !== "win32") {
    NodeFS.mkdirSync(cellsDir, { recursive: true });
  }
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("set-cookie", "stolen=1; Path=/");
    response.setHeader("content-security-policy", "default-src *");
    response.setHeader("access-control-allow-origin", "https://evil.example");
    response.setHeader("clear-site-data", '"cookies"');
    if (request.url?.endsWith(".html")) {
      response.setHeader("content-type", "text/html");
      response.end("<script>fetch('/admin/api/users')</script>");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ cell, path: request.url, headers: request.headers }));
  });
  server.on("upgrade", (request, socket: NodeNet.Socket) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Cell: ${cell}\r\nSet-Cookie: stolen=1\r\nClear-Site-Data: "*"\r\nContent-Security-Policy: default-src *\r\n\r\n`,
    );
    socket.pipe(socket);
  });
  server.listen(socketPath);
  await once(server, "listening");
  cells.set(cell, server);
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
}

beforeEach(async () => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-gateway-"));
  cellsDir =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${NodePath.basename(dir)}`
      : NodePath.join(dir, "cells");
  NodeFS.mkdirSync(NodePath.join(dir, "web", "assets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "web", "index.html"), "<!doctype html>app");
  NodeFS.writeFileSync(NodePath.join(dir, "web", "assets", "app.js"), "app()");
  NodeFS.writeFileSync(NodePath.join(dir, "secret.txt"), "not served");
  db = openGatewayDb(NodePath.join(dir, "gateway.db"));
  provisioned = [];
  provisionCalls = [];
  cells = new Map();
  clientIp += 1;
  provisionResult = { ok: true };
  statusOf = async (cell) => ({
    ok: true,
    cell,
    active: "active",
    memoryMax: String(4 * 2 ** 30),
    cpuQuotaPerSec: "2s",
    tasksMax: "4096",
  });
  const server = createGateway({
    auth: await createAuth(db, { secret: "s".repeat(32), origin }),
    db,
    origin,
    webDir: NodePath.join(dir, "web"),
    cellsDir,
    provision: async (args) => {
      const [verb, cell = ""] = args;
      provisionCalls.push(args);
      if (verb === "status") {
        return statusOf(cell);
      }
      if (verb === "add") {
        provisioned.push(cell);
      }
      if (provisionResult.ok && (verb === "add" || verb === "resume")) {
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

async function signUp(email: string, admin = false) {
  const response = await post(`/invite/${createInvite(db, email, admin)}`, { password });
  expect(response.status).toBe(303);
  const cookie = cookieOf(response);
  expect(cookie).toBeDefined();
  return cookie!;
}

// An upgraded socket, left open, and a promise that settles when the gateway closes it.
function openSocket(cookie: string) {
  return new Promise<{ socket: NodeNet.Socket; closed: Promise<unknown> }>((resolve, reject) => {
    const request = NodeHttp.request(`${base}/ws`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": NodeCrypto.randomBytes(16).toString("base64"),
        cookie,
        origin,
      },
    });
    request.on("upgrade", (_reply, socket: NodeNet.Socket) => {
      socket.resume();
      cleanups.push(() => socket.destroy());
      resolve({ socket, closed: once(socket, "close") });
    });
    request.on("response", (reply) => reject(new Error(`not upgraded: ${reply.statusCode}`)));
    request.end();
  });
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

  it("retry a failed cell at sign-in, and let the user in once it's set up", async () => {
    provisionResult = { ok: false, error: "useradd failed" };
    await post(`/invite/${createInvite(db, "bea@example.test", false)}`, { password });
    const [cell] = provisioned;
    const wrong = await post("/login", { email: "bea@example.test", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    expect(provisioned).toEqual([cell]);

    provisionResult = { ok: true };
    const login = await post("/login", { email: "bea@example.test", password, next: "/" });
    expect(login.status).toBe(303);
    expect(provisioned).toEqual([cell, cell]);
    const health = await fetch(`${base}/health`, { headers: { cookie: cookieOf(login)! } });
    expect((await health.json()).cell).toBe(cell);
  });

  it("retry a cell a gateway restart left provisioning", async () => {
    await signUp("bi@example.test");
    const [cell] = provisioned;
    // As a gateway that died during `add` leaves it.
    db.prepare("UPDATE member SET state = 'provisioning'").run();
    const login = await post("/login", { email: "bi@example.test", password, next: "/" });
    expect(login.status).toBe(303);
    expect(provisioned).toEqual([cell, cell]);
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

  it("end on logout, closing that session's sockets only", async () => {
    const cookie = await signUp("fi@example.test");
    const other = cookieOf(await post("/login", { email: "fi@example.test", password }))!;
    const mine = await openSocket(cookie);
    const theirs = await openSocket(other);
    const out = await post("/logout", {}, { cookie });
    expect(out.status).toBe(303);
    expect((await fetch(`${base}/assets/app.js`, { headers: { cookie } })).status).toBe(401);
    await mine.closed;
    // The other session's socket still reaches its cell, which echoes.
    const echoed = once(theirs.socket, "data");
    theirs.socket.write("ping");
    expect(String((await echoed)[0])).toBe("ping");
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
    // Not a file, so the cell is asked for it, as for any other path.
    const escape = await fetch(`${base}/..%2fsecret.txt`, { headers: { cookie } });
    expect((await escape.json()).path).toBe("/..%2fsecret.txt");
  });

  it("is 503 when the cell isn't answering, never another cell", async () => {
    await signUp("ia@example.test");
    const cookie = await signUp("io@example.test");
    // Its socket goes away, as when the unit is stopped.
    await new Promise((resolve) => {
      const server = cells.get(provisioned[1]!)!;
      server.close(resolve);
      server.closeAllConnections();
    });
    expect((await fetch(`${base}/health`, { headers: { cookie } })).status).toBe(503);
  });

  it("is 503 for a suspended member", async () => {
    const cookie = await signUp("jo@example.test");
    db.prepare("UPDATE member SET state = 'suspended'").run();
    expect((await fetch(`${base}/health`, { headers: { cookie } })).status).toBe(503);
    expect((await upgrade("/ws", { cookie, origin })).status).toBe(503);
  });
});

describe("admin", () => {
  it("suspends a user, ending their sockets, and resumes them", async () => {
    const admin = await signUp("ada@example.test", true);
    const user = await signUp("uma@example.test");
    const cell = provisioned[1]!;
    const socket = await openSocket(user);
    const act = (verb: string, headers: Record<string, string> = { cookie: admin }) =>
      post(`/admin/api/users/${verb}`, { cell }, headers);

    expect((await act("suspend", { cookie: admin, origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await act("suspend", { cookie: user })).status).toBe(404);
    expect(socket.socket.destroyed).toBe(false);

    expect((await act("suspend")).status).toBe(200);
    await socket.closed;
    expect(provisionCalls.at(-1)).toEqual(["suspend", cell]);
    expect((await fetch(`${base}/health`, { headers: { cookie: user } })).status).toBe(503);
    expect((await post("/login", { email: "uma@example.test", password })).status).toBe(403);

    expect((await act("resume")).status).toBe(200);
    expect(provisionCalls.at(-1)).toEqual(["resume", cell]);
    expect((await fetch(`${base}/health`, { headers: { cookie: user } })).status).toBe(200);
    expect((await act("resume")).status).toBe(409);
  });

  it("keeps a user suspended when their cell won't resume", async () => {
    const admin = await signUp("abe@example.test", true);
    const user = await signUp("una@example.test");
    const cell = provisioned[1]!;
    expect((await post("/admin/api/users/suspend", { cell }, { cookie: admin })).status).toBe(200);
    provisionResult = { ok: false, error: "systemctl failed" };
    expect((await post("/admin/api/users/resume", { cell }, { cookie: admin })).status).toBe(502);
    expect((await fetch(`${base}/health`, { headers: { cookie: user } })).status).toBe(503);
  });

  it("lists users only to its own origin", async () => {
    const admin = await signUp("ari@example.test", true);
    const users = await fetch(`${base}/admin/api/users`, {
      headers: { cookie: admin, origin: "https://evil.example" },
    });
    expect(users.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("admin pages", () => {
  const page = (path: string, cookie: string) =>
    fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });

  it("are not found by anyone but an admin, and never reach a cell", async () => {
    const admin = await signUp("ava@example.test", true);
    const user = await signUp("ul@example.test");
    const cell = provisioned[1]!;
    for (const path of ["/admin", "/admin/api/users", `/admin/users/${cell}`, "/admin/x"]) {
      const reply = await page(path, user);
      expect(reply.status).toBe(404);
      expect(await reply.json()).toEqual({ code: "not_found" });
    }
    expect((await post("/admin/users/suspend", { cell }, { cookie: user })).status).toBe(404);
    expect(
      (await post("/admin/invites", { email: "x@example.test" }, { cookie: user })).status,
    ).toBe(404);
    expect((await fetch(`${base}/admin/api/users`)).status).toBe(404);
    const signedOut = await fetch(`${base}/admin`, { redirect: "manual" });
    expect(signedOut.headers.get("location")).toBe("/login?next=%2Fadmin");
    // The admin's own unknown path is the gateway's 404, not their cell's.
    expect(await (await page("/admin/x", admin)).json()).toEqual({ code: "not_found" });
    expect(provisionCalls.filter(([verb]) => verb === "suspend")).toEqual([]);
  });

  it("list users and their cells' health, with a policy that runs no script", async () => {
    const admin = await signUp("ali@example.test", true);
    await signUp("ux@example.test");
    const reply = await page("/admin", admin);
    expect(reply.status).toBe(200);
    const policy = reply.headers.get("content-security-policy")!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("script-src");
    const html = await reply.text();
    expect(html).not.toContain("<script");
    expect(html).toContain(provisioned[1]);
    expect(html.match(/<td>active<\/td>\n<td>answering<\/td>/g)).toHaveLength(2);
  });

  it("create an invite and show its link once", async () => {
    const admin = await signUp("amy@example.test", true);
    const reply = await post(
      "/admin/invites",
      { email: "new@example.test", admin: "true" },
      {
        cookie: admin,
      },
    );
    expect(reply.status).toBe(200);
    const token = /\/invite\/([\w-]+)"/.exec(await reply.text())![1]!;
    expect(openInvite(db, token)).toEqual({ email: "new@example.test", admin: true });
    expect(await (await page("/admin", admin)).text()).not.toContain(token);
  });

  it("refuse a form post from another origin, or with none", async () => {
    const admin = await signUp("axe@example.test", true);
    await signUp("uz@example.test");
    const cell = provisioned[1]!;
    const evil = await post(
      "/admin/users/suspend",
      { cell },
      {
        cookie: admin,
        origin: "https://evil.example",
      },
    );
    expect(evil.status).toBe(403);
    const none = await fetch(`${base}/admin/invites`, {
      method: "POST",
      headers: { cookie: admin, "content-type": "application/x-www-form-urlencoded" },
      body: "email=x%40example.test",
    });
    expect(none.status).toBe(403);
    expect(provisionCalls.filter(([verb]) => verb === "suspend")).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM invite").get()).toEqual({ n: 2 });
  });

  it("won't let an admin suspend or delete themselves, and close to a suspended admin", async () => {
    const first = await signUp("ann@example.test", true);
    const second = await signUp("ben@example.test", true);
    const [firstCell, secondCell] = provisioned;
    const self = await post("/admin/users/suspend", { cell: firstCell! }, { cookie: first });
    expect(self.status).toBe(409);
    expect(await self.text()).toContain("your own account");
    const deleted = await post(
      "/admin/users/delete",
      { cell: firstCell!, confirm: "ann@example.test" },
      { cookie: first },
    );
    expect(deleted.status).toBe(409);
    expect(provisionCalls.some(([verb]) => verb === "suspend" || verb === "delete")).toBe(false);

    expect(
      (await post("/admin/users/suspend", { cell: secondCell! }, { cookie: first })).status,
    ).toBe(303);
    // A suspended admin's open session is no longer an admin's.
    expect((await page("/admin", second)).status).toBe(404);
    expect(
      (await post("/admin/users/suspend", { cell: firstCell! }, { cookie: second })).status,
    ).toBe(404);
  });

  it("set a quota from a checked form, with the helper's exact arguments", async () => {
    const admin = await signUp("ari@example.test", true);
    await signUp("uq@example.test");
    const cell = provisioned[1]!;
    const form = await (await page(`/admin/users/${cell}`, admin)).text();
    expect(form).toContain('name="memory" value="4G"');
    expect(form).toContain('name="cpu" value="200%"');
    expect(form).toContain('name="tasks" value="4096"');
    // Unset, yet there to fill in: a new cell has no cap or budget of its own.
    expect(form).toContain('name="boxes" value=""');
    expect(form).toContain('name="budget-usd" value=""');

    const quota = (fields: Record<string, string>) =>
      post("/admin/users/quota", { cell, ...fields }, { cookie: admin });
    const saved = await quota({ memory: "8G", cpu: "150", tasks: "2048" });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/admin/users/${cell}?saved`);
    expect(provisionCalls.at(-1)).toEqual([
      "quota",
      cell,
      "--memory",
      "8G",
      "--cpu",
      "150%",
      "--tasks",
      "2048",
    ]);
    await quota({ memory: "1T", cpu: "50%", tasks: "64", boxes: "3", "budget-usd": "25.50" });
    expect(provisionCalls.at(-1)).toEqual([
      "quota",
      cell,
      "--memory",
      "1T",
      "--cpu",
      "50%",
      "--tasks",
      "64",
      "--boxes",
      "3",
      "--budget-usd",
      "25.50",
    ]);

    const calls = provisionCalls.length;
    for (const bad of [
      { memory: "--confirm", cpu: "100%", tasks: "1" },
      { memory: "8G --confirm", cpu: "100%", tasks: "1" },
      { memory: "8g", cpu: "100%", tasks: "1" },
      { memory: "8G", cpu: "0%", tasks: "1" },
      { memory: "8G", cpu: "100%", tasks: "" },
      { memory: "8G", cpu: "100%", tasks: "1", boxes: "-1" },
    ]) {
      const refused = await quota(bad);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain('role="alert"');
    }
    expect(provisionCalls.slice(calls).filter(([verb]) => verb === "quota")).toEqual([]);

    // As beebot-provision's `status` reports them.
    statusOf = async () => ({
      ok: true,
      active: "active",
      maxActiveBoxes: "5",
      monthlyBudgetUsd: "10",
    });
    const extra = await (await page(`/admin/users/${cell}`, admin)).text();
    expect(extra).toContain('name="boxes" value="5"');
    expect(extra).toContain('name="budget-usd" value="10"');
  });

  it("delete a user only once their email is typed", async () => {
    const admin = await signUp("abi@example.test", true);
    const user = await signUp("ud@example.test");
    const cell = provisioned[1]!;
    const socket = await openSocket(user);
    const wrong = await post("/admin/users/delete", { cell, confirm: "nope" }, { cookie: admin });
    expect(wrong.status).toBe(400);
    expect(provisionCalls.some(([verb]) => verb === "delete")).toBe(false);

    const done = await post(
      "/admin/users/delete",
      { cell, confirm: "UD@example.test" },
      { cookie: admin },
    );
    expect(done.status).toBe(303);
    expect(provisionCalls.at(-1)).toEqual(["delete", cell, "--confirm"]);
    await socket.closed;
    expect(db.prepare(`SELECT count(*) AS n FROM "user"`).get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM member").get()).toEqual({ n: 1 });
    expect((await fetch(`${base}/health`, { headers: { cookie: user } })).status).toBe(401);
    expect((await post("/login", { email: "ud@example.test", password })).status).toBe(401);
  });

  it("aren't held up by a cell that never answers", async () => {
    const admin = await signUp("ace@example.test", true);
    await signUp("uh@example.test");
    const cell = provisioned[1]!;
    await new Promise((resolve) => {
      const server = cells.get(cell)!;
      server.close(resolve);
      server.closeAllConnections();
    });
    const hung = NodeHttp.createServer(() => {});
    hung.listen(NodePath.join(cellsDir, `${cell}.sock`));
    await once(hung, "listening");
    cleanups.push(() => {
      hung.closeAllConnections();
      hung.close();
    });
    const answered = statusOf;
    statusOf = (asked) => (asked === cell ? new Promise(() => {}) : answered(asked));

    const started = Date.now();
    const reply = await page("/admin", admin);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(reply.status).toBe(200);
    const html = await reply.text();
    expect(html).toContain("<td>active</td>\n<td>answering</td>");
    expect(html).toContain("<td>unknown</td>\n<td>not answering</td>");
  });
});

describe("gateway health", () => {
  it("is ok while its database is usable, and says nothing else", async () => {
    const reply = await fetch(`${base}/_gateway/health`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ ok: true });
    db.close();
    const down = await fetch(`${base}/_gateway/health`);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false });
    db = openGatewayDb(NodePath.join(dir, "gateway.db"));
  });
});

describe("proxy to cells", () => {
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
    await signUp("la@example.test");
    const cookie = await signUp("lu@example.test");
    const reply = await upgrade("/ws?protocolVersion=1", { cookie, origin });
    expect(reply.status).toBe(101);
    expect(reply.headers["x-cell"]).toBe(provisioned[1]);
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(reply.headers["clear-site-data"]).toBeUndefined();
    expect(reply.headers["content-security-policy"]).toBe("sandbox");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves a cell's page in an opaque origin, and lets it set no cookie", async () => {
    const cookie = await signUp("ma@example.test");
    for (const path of ["/files/shared.html", "/health"]) {
      const reply = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(reply.headers.get("content-security-policy")).toBe("sandbox");
      expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
      expect(reply.headers.getSetCookie()).toEqual([]);
      expect(reply.headers.get("access-control-allow-origin")).toBeNull();
      expect(reply.headers.get("clear-site-data")).toBeNull();
    }
  });

  it("refuses a cell name the database shouldn't hold", async () => {
    const cookie = await signUp("mo@example.test");
    db.prepare("UPDATE member SET cell = ?").run(`../${provisioned[0]}`);
    expect((await fetch(`${base}/health`, { headers: { cookie } })).status).toBe(500);
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
