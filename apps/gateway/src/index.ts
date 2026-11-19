#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { createAuth } from "./auth.ts";
import { createGateway, sudoProvision } from "./gateway.ts";
import { log } from "./log.ts";
import { createInvite, openGatewayDb } from "./store.ts";

const usage = `usage:
  beebot-gateway serve
  beebot-gateway invite <email> [--admin]
  beebot-gateway admin create <email>`;

function fail(message: string): never {
  log("error", message);
  process.exit(1);
}

function required(name: string) {
  return process.env[name] || fail(`${name} is required`);
}

const origin = required("BEEBOT_PUBLIC_ORIGIN");
if (URL.parse(origin)?.origin !== origin || !origin.startsWith("https://")) {
  fail("BEEBOT_PUBLIC_ORIGIN must be an https origin, like https://bee.example.com");
}
const db = openGatewayDb(required("GATEWAY_DB"));
const [command = "serve", ...args] = process.argv.slice(2);

function invite(email: string | undefined, admin: boolean) {
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    fail(usage);
  }
  process.stdout.write(`${origin}/invite/${createInvite(db, email, admin)}\n`);
}

async function serve() {
  const secret = required("GATEWAY_AUTH_SECRET");
  if (secret.length < 32) {
    fail("GATEWAY_AUTH_SECRET must be at least 32 characters");
  }
  const socketPath = process.env.GATEWAY_SOCKET || "/run/beebot/gateway.sock";
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const server = createGateway({
    auth: await createAuth(db, { secret, origin }),
    db,
    origin,
    webDir: process.env.GATEWAY_WEB_DIR || NodePath.resolve(here, "../../web/dist"),
    cellsDir: process.env.BEEBOT_CELLS_DIR || "/run/beebot/cells",
    provision: sudoProvision,
  });
  // A crash leaves the old socket behind, and listen refuses an existing path.
  if (NodeFS.lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket()) {
    NodeFS.unlinkSync(socketPath);
  }
  // Caddy reaches the socket through its group; nobody else may.
  const umask = process.umask(0o117);
  server.listen(socketPath, () => {
    process.umask(umask);
    NodeFS.chmodSync(socketPath, 0o660);
    log("info", "listening", { socket: socketPath, origin });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
      db.close();
      process.exit(0);
    });
  }
}

if (command === "serve") {
  await serve();
} else if (command === "invite") {
  invite(
    args.find((arg) => arg !== "--admin"),
    args.includes("--admin"),
  );
} else if (command === "admin" && args[0] === "create") {
  invite(args[1], true);
} else {
  fail(usage);
}
