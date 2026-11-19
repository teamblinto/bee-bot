import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { type Auth, createPasswordUser, passwordProblem } from "./auth.ts";
import { log } from "./log.ts";
import {
  invitePage,
  loginPage,
  logoutPage,
  messagePage,
  type QuotaValues,
  userPage,
  usersPage,
} from "./pages.ts";
import {
  addMember,
  cellPattern,
  claimInvite,
  createInvite,
  deleteMember,
  findMember,
  findMemberByCell,
  listUsers,
  newCellName,
  openInvite,
  retryFailedMember,
  setMemberState,
} from "./store.ts";

export type ProvisionReply = { ok: true; [field: string]: unknown } | { ok: false; error: string };

// The arguments after `user`, like ["quota", cell, "--memory", "4G", ...].
export type Provision = (args: string[], timeoutMs?: number) => Promise<ProvisionReply>;

// The root helper prints one JSON object: {"ok":true,...} or {"ok":false,"error":"..."}.
export const sudoProvision: Provision = (args, timeoutMs = 5 * 60_000) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "sudo",
      ["-n", "/usr/local/sbin/beebot-provision", "user", ...args],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        let reply: { ok?: unknown; error?: unknown } | undefined;
        try {
          reply = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        } catch {}
        resolve(
          !error && reply?.ok === true
            ? { ...reply, ok: true }
            : {
                ok: false,
                error: String(reply?.error ?? (stderr.trim() || error?.message || "no reply")),
              },
        );
      },
    );
  });

type Options = {
  auth: Auth;
  db: DatabaseSync;
  origin: string;
  webDir: string;
  cellsDir: string;
  provision: Provision;
};

// Only these leave with a proxied request: the rest describe this hop, or are the gateway's own
// credentials, which a cell never sees.
const dropped = new Set([
  "authorization",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const forwardable = (headers: NodeHttp.IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !dropped.has(name) && name !== "set-cookie"),
  );

// A cell is untrusted. It sets no cookie on this origin, and a page it serves (a workspace file,
// say) gets an opaque origin, so its script can't reach the session or /admin/api.
const fromCell = (headers: NodeHttp.IncomingHttpHeaders) => ({
  ...forwardable(headers),
  "content-security-policy": "sandbox",
  "x-content-type-options": "nosniff",
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const pageSecurity = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "cache-control": "no-store",
};

const healthTimeoutMs = 2000;

const within = <T>(ms: number, work: Promise<T>, late: T) =>
  Promise.race([work, new Promise<T>((resolve) => setTimeout(resolve, ms, late).unref())]);

// beebotd answers GET /health on its socket without a token.
function answers(socketPath: string) {
  return new Promise<boolean>((resolve) => {
    const request = NodeHttp.get(
      // A fresh connection each time, so a pooled one can't answer for a socket that's gone.
      { socketPath, path: "/health", timeout: healthTimeoutMs, agent: false },
      (reply) => {
        reply.resume();
        resolve(reply.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

type UserVerb = "suspend" | "resume" | "quota" | "delete";

const refusal = (status: number, code: string, error: string) => ({
  status,
  body: { ok: false as const, code, error },
});

// The helper's own patterns, matched here too, so no value can pass as another flag.
const quotaFields = {
  memory: /^[1-9][0-9]{0,5}[KMGT]$/,
  cpu: /^[1-9][0-9]{0,4}%$/,
  tasks: /^[1-9][0-9]{0,6}$/,
  boxes: /^[0-9]{1,4}$/,
  "budget-usd": /^[0-9]{1,6}(\.[0-9]{1,2})?$/,
};

export function quotaArgs(form: URLSearchParams) {
  const args: string[] = [];
  for (const [name, pattern] of Object.entries(quotaFields)) {
    let value = form.get(name)?.trim() ?? "";
    if (name === "cpu" && /^\d+$/.test(value)) {
      value += "%";
    }
    // Boxes and budget are sent only when the form has them, which it does when status reports them.
    if (value === "" && (name === "boxes" || name === "budget-usd")) {
      continue;
    }
    if (!pattern.test(value)) {
      return undefined;
    }
    args.push(`--${name}`, value);
  }
  return args;
}

const memoryUnits = [
  ["T", 2 ** 40],
  ["G", 2 ** 30],
  ["M", 2 ** 20],
  ["K", 2 ** 10],
] as const;

// From `status`: MemoryMax in bytes and CPUQuotaPerSecUSec like "2s" or "500ms", as systemd shows them.
function quotaValues(status: Record<string, unknown>): QuotaValues {
  const bytes = Number(status.memoryMax);
  const unit = memoryUnits.find(([, size]) => bytes > 0 && bytes % size === 0);
  const cpu = /^(\d+(?:\.\d+)?)(s|ms)$/.exec(String(status.cpuQuotaPerSec));
  const optional = (value: unknown) => (value == null ? undefined : String(value));
  return {
    memory: unit ? `${bytes / unit[1]}${unit[0]}` : "",
    cpu: cpu ? `${Math.round(Number(cpu[1]) * (cpu[2] === "s" ? 100 : 0.1))}%` : "",
    tasks: /^\d+$/.test(String(status.tasksMax)) ? String(status.tasksMax) : "",
    boxes: optional(status.boxes),
    "budget-usd": optional(status.budgetUsd),
  };
}

// Only a path on this origin: `/`, then anything but a second slash or a backslash.
export function safeNext(next: string | null | undefined) {
  if (!next || !next.startsWith("/") || /^\/[/\\]|[\\\u0000-\u001f]/.test(next)) {
    return "/";
  }
  const url = URL.parse(next, "http://gateway.invalid");
  return url?.origin === "http://gateway.invalid" && url.pathname !== "/login" ? next : "/";
}

function toHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const item of [value ?? []].flat()) {
      result.append(name, item);
    }
  }
  return result;
}

function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendPage(
  response: NodeHttp.ServerResponse,
  status: number,
  html: string,
  cookies: string[] = [],
) {
  response.writeHead(status, {
    ...pageSecurity,
    "content-type": "text/html; charset=utf-8",
    "set-cookie": cookies,
  });
  response.end(html);
}

function redirect(response: NodeHttp.ServerResponse, location: string, cookies: string[] = []) {
  response.writeHead(303, { location, "set-cookie": cookies, "cache-control": "no-store" });
  response.end();
}

function refuseUpgrade(socket: NodeNet.Socket, status: number, code: string) {
  const body = JSON.stringify({ code });
  socket.end(
    `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

async function readForm(request: NodeHttp.IncomingMessage, limit = 16 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) {
      throw new RangeError("form too large");
    }
  }
  return request.headers["content-type"]?.startsWith("application/json")
    ? new URLSearchParams(JSON.parse(body) as Record<string, string>)
    : new URLSearchParams(body);
}

const rawHeaderLines = (raw: string[]) =>
  raw
    .flatMap((item, index) => (index % 2 ? [] : [[item, raw[index + 1]] as const]))
    .filter(([name]) => name.toLowerCase() !== "set-cookie")
    .reduce((lines, [name, value]) => `${lines}${name}: ${value}\r\n`, "");

export function createGateway({ auth, db, origin, webDir, cellsDir, provision }: Options) {
  const webRoot = NodePath.resolve(webDir);

  const cellSocket = (cell: string) => {
    // The name comes from our database, never the request; checked again before it names a path.
    if (!cellPattern.test(cell)) {
      throw new Error("invalid cell name in the database");
    }
    return NodePath.join(cellsDir, cell, "beebotd.sock");
  };

  // Open proxied sockets by user, so logout and suspend can end them.
  const sockets = new Map<string, Set<{ sessionId: string; socket: NodeNet.Socket }>>();

  function closeSockets(userId: string, sessionId?: string) {
    for (const open of sockets.get(userId) ?? []) {
      if (sessionId === undefined || open.sessionId === sessionId) {
        open.socket.destroy();
      }
    }
  }

  async function provisionCell(userId: string, cell: string) {
    const provisioned = await provision(["add", cell]);
    if (provisioned.ok) {
      setMemberState(db, userId, "ready");
      log("info", "cell provisioned", { userId, cell });
    } else {
      setMemberState(db, userId, "failed", provisioned.error);
      log("error", "provision failed", { userId, cell, error: provisioned.error });
    }
    return provisioned;
  }

  async function signIn(
    request: NodeHttp.IncomingMessage,
    email: string,
    password: string,
  ): Promise<{ cookies: string[] } | { status: number; error: string }> {
    const headers = new Headers({ "content-type": "application/json", origin });
    for (const name of ["user-agent", "x-forwarded-for"]) {
      const value = request.headers[name];
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    // Through Better Auth's handler, not its server API, so its sign-in rate limit applies.
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password, rememberMe: true }),
      }),
    );
    if (response.status === 429) {
      return { status: 429, error: "Too many attempts. Wait a minute and try again." };
    }
    if (!response.ok) {
      return { status: 401, error: "That email and password don't match an account." };
    }
    const { token, user } = (await response.json()) as { token: string; user: { id: string } };
    let member = findMember(db, user.id);
    // A cell that failed to set up is tried again at each sign-in, and stays closed until it works.
    if (member?.state === "failed" && retryFailedMember(db, user.id)) {
      await provisionCell(user.id, member.cell);
      member = findMember(db, user.id);
    }
    if (member?.state !== "ready") {
      await (await auth.$context).internalAdapter.deleteSession(token);
      return {
        status: 403,
        error:
          member?.state === "suspended"
            ? "This account is suspended."
            : "This account isn't set up yet. Try again later, or ask your admin.",
      };
    }
    return { cookies: response.headers.getSetCookie() };
  }

  async function handleLogin(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    url: URL,
  ) {
    if (request.method !== "POST") {
      sendPage(response, 200, loginPage(safeNext(url.searchParams.get("next"))));
      return;
    }
    const form = await readForm(request);
    const next = safeNext(form.get("next"));
    const result = await signIn(request, form.get("email") ?? "", form.get("password") ?? "");
    if ("error" in result) {
      log("info", "sign-in refused", { status: result.status });
      sendPage(response, result.status, loginPage(next, result.error));
      return;
    }
    redirect(response, next, result.cookies);
  }

  async function handleInvite(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    token: string,
  ) {
    const invite = openInvite(db, token);
    if (!invite) {
      sendPage(
        response,
        410,
        messagePage("Invite unavailable", "This invite link was already used or has expired."),
      );
      return;
    }
    if (request.method !== "POST") {
      sendPage(response, 200, invitePage(invite.email));
      return;
    }
    const password = (await readForm(request)).get("password") ?? "";
    const problem = await passwordProblem(auth, password);
    if (problem) {
      sendPage(response, 400, invitePage(invite.email, problem));
      return;
    }
    if (await (await auth.$context).internalAdapter.findUserByEmail(invite.email)) {
      sendPage(
        response,
        409,
        messagePage("Account exists", "An account with this email already exists."),
      );
      return;
    }
    if (!claimInvite(db, token)) {
      sendPage(
        response,
        410,
        messagePage("Invite unavailable", "This invite link was already used or has expired."),
      );
      return;
    }
    const user = await createPasswordUser(auth, invite.email, password);
    const cell = newCellName();
    addMember(db, user.id, cell, invite.admin);
    log("info", "account created", { userId: user.id, cell });
    const provisioned = await provisionCell(user.id, cell);
    if (!provisioned.ok) {
      sendPage(
        response,
        502,
        messagePage(
          "Setup failed",
          `Your account was created, but its space couldn't be set up, so it can't be used yet: ${provisioned.error}. Signing in tries again.`,
        ),
      );
      return;
    }
    const signedIn = await signIn(request, invite.email, password);
    if ("error" in signedIn) {
      redirect(response, "/login");
      return;
    }
    redirect(response, "/", signedIn.cookies);
  }

  async function handleLogout(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    if (request.method !== "POST") {
      sendPage(response, 200, logoutPage());
      return;
    }
    const headers = toHeaders(request.headers);
    const session = await auth.api.getSession({ headers }).catch(() => null);
    const signedOut = await auth.api
      .signOut({ headers, returnHeaders: true })
      .catch(() => undefined);
    if (session) {
      closeSockets(session.user.id, session.session.id);
    }
    redirect(response, "/login", signedOut?.headers.getSetCookie() ?? []);
  }

  // Bounded, so one dead cell can't hold up the users page.
  const cellStatus = (cell: string) =>
    within(healthTimeoutMs, provision(["status", cell], healthTimeoutMs), {
      ok: false,
      error: "timed out",
    });

  const unitOf = (status: ProvisionReply) =>
    status.ok ? String(status.active ?? "unknown") : "unknown";

  async function showUsers(
    response: NodeHttp.ServerResponse,
    status: number,
    selfCell: string,
    notice: { invite?: string; error?: string } = {},
  ) {
    const users = await Promise.all(
      listUsers(db).map(async (user) => {
        const [unit, answering] = await Promise.all([
          cellStatus(user.cell),
          answers(cellSocket(user.cell)),
        ]);
        return { ...user, unit: unitOf(unit), answering };
      }),
    );
    sendPage(response, status, usersPage(users, selfCell, notice));
  }

  async function showUser(
    response: NodeHttp.ServerResponse,
    status: number,
    cell: string,
    notice: { error?: string; saved?: boolean } = {},
  ) {
    const member = cellPattern.test(cell) ? findMemberByCell(db, cell) : undefined;
    if (!member) {
      sendJson(response, 404, { code: "not_found" });
      return;
    }
    const reply = await cellStatus(cell);
    sendPage(
      response,
      status,
      userPage(member, unitOf(reply), quotaValues(reply.ok ? reply : {}), notice),
    );
  }

  async function changeUser(actorId: string, verb: UserVerb, form: URLSearchParams) {
    const cell = form.get("cell") ?? "";
    const member = cellPattern.test(cell) ? findMemberByCell(db, cell) : undefined;
    if (!member) {
      return refusal(404, "not_found", "There's no such user.");
    }
    // Only an unsuspended admin gets here, so refusing their own account always leaves an admin.
    if ((verb === "suspend" || verb === "delete") && member.user_id === actorId) {
      return refusal(409, "self", "You can't suspend or delete your own account.");
    }
    if (verb === "resume" && member.state !== "suspended") {
      return refusal(409, "not_suspended", "This user isn't suspended.");
    }
    if (verb === "delete" && form.get("confirm")?.trim().toLowerCase() !== member.email) {
      return refusal(400, "unconfirmed", `Type ${member.email} to delete this user.`);
    }
    const quota = verb === "quota" ? quotaArgs(form) : [];
    if (!quota) {
      return refusal(
        400,
        "bad_quota",
        "Use memory like 4G, CPU like 200%, and whole numbers for tasks and boxes.",
      );
    }
    // Fails closed: the gateway stops proxying before the cell stops, and starts after it starts.
    if (verb === "suspend" || verb === "delete") {
      setMemberState(db, member.user_id, "suspended");
      closeSockets(member.user_id);
    }
    const result = await provision(
      verb === "delete" ? ["delete", cell, "--confirm"] : [verb, cell, ...quota],
    );
    if (result.ok && verb === "resume") {
      setMemberState(db, member.user_id, "ready");
    }
    if (result.ok && verb === "delete") {
      await (await auth.$context).internalAdapter.deleteUser(member.user_id);
      deleteMember(db, member.user_id);
    }
    log(result.ok ? "info" : "error", `${verb} ${result.ok ? "done" : "failed"}`, {
      cell,
      ...(!result.ok && { error: result.error }),
    });
    return result.ok
      ? { status: 200, body: result }
      : refusal(502, "provision_failed", `The cell didn't change: ${result.error}`);
  }

  async function handleAdmin(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    url: URL,
    actor: { userId: string; cell: string },
  ) {
    const api = url.pathname.startsWith("/admin/api/");
    const route = url.pathname.slice(api ? "/admin/api".length : "/admin".length) || "/";
    const verb = /^\/users\/(suspend|resume|quota|delete)$/.exec(route)?.[1] as
      | UserVerb
      | undefined;
    const managed = /^\/users\/(bb[0-9a-f]{10})$/.exec(route)?.[1];
    if (request.method === "GET" && api && route === "/users") {
      sendJson(response, 200, { users: listUsers(db) });
    } else if (request.method === "GET" && !api && route === "/") {
      await showUsers(response, 200, actor.cell);
    } else if (request.method === "GET" && !api && managed) {
      await showUser(response, 200, managed, { saved: url.searchParams.has("saved") });
    } else if (request.method === "POST" && route === "/invites") {
      const form = await readForm(request);
      const email = form.get("email")?.trim() ?? "";
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
        if (api) {
          sendJson(response, 400, { code: "bad_request" });
        } else {
          await showUsers(response, 400, actor.cell, { error: "Enter an email address." });
        }
        return;
      }
      const invite = `${origin}/invite/${createInvite(db, email, form.get("admin") === "true")}`;
      log("info", "invite created", { by: actor.userId });
      if (api) {
        sendJson(response, 201, { url: invite });
      } else {
        await showUsers(response, 200, actor.cell, { invite });
      }
    } else if (request.method === "POST" && verb) {
      const form = await readForm(request);
      const result = await changeUser(actor.userId, verb, form);
      if (api) {
        sendJson(response, result.status, result.body);
      } else if (result.body.ok) {
        redirect(response, verb === "quota" ? `/admin/users/${form.get("cell")}?saved` : "/admin");
      } else if (verb === "quota" || verb === "delete") {
        await showUser(response, result.status, form.get("cell") ?? "", {
          error: result.body.error,
        });
      } else {
        await showUsers(response, result.status, actor.cell, { error: result.body.error });
      }
    } else {
      sendJson(response, 404, { code: "not_found" });
    }
  }

  async function staticFile(pathname: string) {
    let relative: string;
    try {
      relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    } catch {
      return undefined;
    }
    const file = NodePath.resolve(webRoot, relative);
    if (!file.startsWith(webRoot + NodePath.sep)) {
      return undefined;
    }
    const stat = await NodeFS.promises.stat(file).catch(() => undefined);
    return stat?.isFile() ? { file, size: stat.size } : undefined;
  }

  function proxy(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    socketPath: string,
  ) {
    const upstream = NodeHttp.request(
      {
        socketPath,
        method: request.method,
        path: request.url,
        headers: forwardable(request.headers),
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, fromCell(reply.headers));
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 503, { code: "cell_unreachable" });
      }
    });
    request.pipe(upstream);
  }

  function proxyUpgrade(
    request: NodeHttp.IncomingMessage,
    socket: NodeNet.Socket,
    head: Buffer,
    socketPath: string,
  ) {
    const upstream = NodeHttp.request({
      socketPath,
      method: request.method,
      path: request.url,
      headers: {
        ...forwardable(request.headers),
        connection: "Upgrade",
        upgrade: request.headers.upgrade,
      },
    });
    upstream.on("upgrade", (reply, cellSocket, cellHead) => {
      // Logged out or suspended while the cell answered.
      if (socket.destroyed) {
        cellSocket.destroy();
        return;
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaderLines(reply.rawHeaders)}\r\n`);
      socket.write(cellHead);
      cellSocket.write(head);
      cellSocket.on("error", () => socket.destroy());
      socket.on("close", () => cellSocket.destroy());
      cellSocket.on("close", () => socket.destroy());
      cellSocket.pipe(socket).pipe(cellSocket);
    });
    // The cell refused the upgrade itself (origin, protocol version): pass its answer on.
    upstream.on("response", (reply) => {
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${rawHeaderLines(reply.rawHeaders)}\r\n`,
      );
      reply.pipe(socket);
    });
    upstream.on("error", () => refuseUpgrade(socket, 503, "cell_unreachable"));
    upstream.end();
  }

  // Fails closed: the cell comes only from the signed-in user's row, and anything short of a
  // ready cell is refused, never sent elsewhere.
  async function resolveCell(headers: NodeHttp.IncomingHttpHeaders) {
    const session = await auth.api.getSession({ headers: toHeaders(headers) });
    if (!session) {
      return { status: 401, code: "unauthorized" } as const;
    }
    const member = findMember(db, session.user.id);
    if (!member) {
      return { status: 401, code: "unauthorized" } as const;
    }
    if (member.state !== "ready") {
      return { status: 503, code: "cell_unavailable", member, session } as const;
    }
    return { member, session, socketPath: cellSocket(member.cell) };
  }

  async function handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const url = URL.parse(request.url ?? "", origin);
    if (!url || !request.url?.startsWith("/")) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }
    const safe = request.method === "GET" || request.method === "HEAD";
    if (!safe && request.headers.origin !== origin) {
      sendJson(response, 403, { code: "origin_refused" });
      return;
    }
    if (safe && url.pathname === "/_gateway/health") {
      let ok = false;
      try {
        db.prepare("SELECT 1 FROM member LIMIT 1").get();
        ok = true;
      } catch {}
      sendJson(response, ok ? 200 : 503, { ok });
      return;
    }
    if (url.pathname.startsWith("/_gateway/")) {
      sendJson(response, 404, { code: "not_found" });
      return;
    }
    if (url.pathname === "/login") {
      return handleLogin(request, response, url);
    }
    if (url.pathname === "/logout") {
      return handleLogout(request, response);
    }
    const invite = /^\/invite\/([\w-]{20,100})$/.exec(url.pathname);
    if (invite) {
      return handleInvite(request, response, invite[1]!);
    }

    const resolved = await resolveCell(request.headers);
    // The gateway's own, never a cell's: anyone but an unsuspended admin finds nothing here.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (resolved.status === 401 && safe && url.pathname === "/admin") {
        redirect(response, "/login?next=%2Fadmin");
      } else if (
        resolved.status === 401 ||
        !resolved.member.admin ||
        resolved.member.state === "suspended"
      ) {
        sendJson(response, 404, { code: "not_found" });
      } else {
        await handleAdmin(request, response, url, {
          userId: resolved.session.user.id,
          cell: resolved.member.cell,
        });
      }
      return;
    }
    if (resolved.status === 401) {
      if (safe && (url.pathname === "/" || url.pathname === "/index.html")) {
        redirect(response, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      } else {
        sendJson(response, 401, { code: "unauthorized" });
      }
      return;
    }
    if (resolved.status === 503) {
      sendJson(response, 503, { code: resolved.code });
      return;
    }
    const file = safe ? await staticFile(url.pathname) : undefined;
    if (file) {
      response.writeHead(200, {
        "content-type": contentTypes[NodePath.extname(file.file)] ?? "application/octet-stream",
        "content-length": file.size,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        NodeFS.createReadStream(file.file).pipe(response);
      }
      return;
    }
    proxy(request, response, resolved.socketPath);
  }

  async function upgrade(request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) {
    socket.on("error", () => socket.destroy());
    if (request.headers.origin !== origin) {
      refuseUpgrade(socket, 403, "origin_refused");
      return;
    }
    const resolved = await resolveCell(request.headers);
    if (resolved.status !== undefined) {
      refuseUpgrade(socket, resolved.status, resolved.code);
      return;
    }
    const userId = resolved.session.user.id;
    const open = { sessionId: resolved.session.session.id, socket };
    const mine = sockets.get(userId) ?? new Set();
    sockets.set(userId, mine.add(open));
    socket.on("close", () => {
      mine.delete(open);
      if (mine.size === 0 && sockets.get(userId) === mine) {
        sockets.delete(userId);
      }
    });
    proxyUpgrade(request, socket, head, resolved.socketPath);
  }

  const server = NodeHttp.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log("error", "request failed", { error: (error as Error)?.message });
      if (!response.headersSent) {
        sendJson(response, 500, { code: "internal_error" });
      } else {
        response.destroy();
      }
    });
  });
  server.on(
    "upgrade",
    (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => {
      upgrade(request, socket, head).catch((error: unknown) => {
        log("error", "upgrade failed", { error: (error as Error)?.message });
        socket.destroy();
      });
    },
  );
  return server;
}
