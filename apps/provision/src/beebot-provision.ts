#!/usr/bin/node
// Root helper for Bee Bot cells, run by the gateway through sudo (system/sudoers). Node's own
// type stripping runs this file as it is, with no dependencies, so root executes one reviewed file.
// It never runs a shell: every argument is matched against a fixed pattern before anything happens.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

export const cellPattern = /^bb[0-9a-f]{10}$/;
const quotaPatterns = {
  "--memory": /^[1-9][0-9]{0,5}[KMGT]$/,
  "--cpu": /^[1-9][0-9]{0,4}%$/,
  "--tasks": /^[1-9][0-9]{0,6}$/,
};
const defaultQuota = { memory: "4G", cpu: "200%", tasks: "4096" };

// Cell uids are 50000 + slot, and slot also fixes the subordinate id range, so the fence
// (system/fence.nft) can name every cell, and every id a cell maps, with two uid ranges.
export const cellIdBase = 50000;
export const cellSlots = 1000;
export const subidBase = 100_000_000;
export const subidCount = 2_000_000;

const paths = {
  cells: "/var/lib/beebot/cells",
  sockets: "/run/beebot/cells",
  creds: "/etc/beebot/creds",
  units: "/etc/systemd/system",
  passwd: "/etc/passwd",
  group: "/etc/group",
  subuid: "/etc/subuid",
  subgid: "/etc/subgid",
  denied: ["/etc/cron.deny", "/etc/at.deny"],
};
const gatewayGroup = "beebot-gw";

export class Refusal extends Error {}

type Quota = typeof defaultQuota;
export type Command =
  | { verb: "add" | "suspend" | "resume" | "status" | "delete"; cell: string }
  | { verb: "quota"; cell: string; quota: Quota };

export function parseArgs(argv: readonly string[]): Command {
  const [group, verb, cell, ...rest] = argv;
  if (group !== "user" || cell === undefined || !cellPattern.test(cell)) {
    throw new Refusal("usage: user <add|suspend|resume|status|delete|quota> <cell> ...");
  }
  if (
    (verb === "add" || verb === "suspend" || verb === "resume" || verb === "status") &&
    rest.length === 0
  ) {
    return { verb, cell };
  }
  if (verb === "delete" && rest.length === 1 && rest[0] === "--confirm") {
    return { verb, cell };
  }
  if (verb === "quota" && rest.length === 6) {
    const given = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const [flag = "", value = ""] = rest.slice(index, index + 2);
      if (!Object.hasOwn(quotaPatterns, flag) || given.has(flag)) {
        throw new Refusal(`unexpected argument for quota`);
      }
      if (!quotaPatterns[flag as keyof typeof quotaPatterns].test(value)) {
        throw new Refusal(`bad value for ${flag}`);
      }
      given.set(flag, value);
    }
    const quota = {
      memory: given.get("--memory") ?? "",
      cpu: given.get("--cpu") ?? "",
      tasks: given.get("--tasks") ?? "",
    };
    return { verb, cell, quota };
  }
  throw new Refusal(`bad arguments for ${verb ?? "user"}`);
}

type Range = { start: number; count: number };
type IdEntry = Range & { name: string };

// /etc/subuid and /etc/subgid: name:start:count.
export function parseSubids(text: string): IdEntry[] {
  return text
    .split("\n")
    .map((line) => line.split(":"))
    .filter((fields) => fields.length === 3)
    .map(([name = "", start = "", count = ""]) => ({
      name,
      start: Number(start),
      count: Number(count),
    }));
}

// /etc/passwd (name:x:uid:gid:gecos:home:shell) and /etc/group (name:x:gid:members).
export function parseIds(text: string) {
  return text
    .split("\n")
    .map((line) => line.split(":"))
    .filter((fields) => fields.length >= 3)
    .map(([name = "", , id = "", gid = "", , home = ""]) => ({
      name,
      id: Number(id),
      gid: Number(gid),
      home,
    }));
}

export const subidRange = (slot: number): Range => ({
  start: subidBase + slot * subidCount,
  count: subidCount,
});

const overlaps = (a: Range, b: Range) => a.start < b.start + b.count && b.start < a.start + a.count;

// The lowest slot whose uid nobody holds and whose subordinate range overlaps no one's.
export function freeSlot(takenIds: ReadonlySet<number>, takenRanges: readonly Range[]) {
  for (let slot = 0; slot < cellSlots; slot++) {
    if (
      !takenIds.has(cellIdBase + slot) &&
      !takenRanges.some((r) => overlaps(r, subidRange(slot)))
    ) {
      return slot;
    }
  }
  throw new Refusal("no free cell slot");
}

const safeEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };

function run(command: string, args: string[], input?: string | Buffer) {
  const result = NodeChildProcess.spawnSync(command, args, {
    input,
    env: safeEnv,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "").trim().split("\n").at(-1);
    throw new Error(`${command} ${args[0] ?? ""} failed: ${reason}`);
  }
  return result.stdout;
}

const read = (path: string) => (NodeFs.existsSync(path) ? NodeFs.readFileSync(path, "utf8") : "");

// Root acts only below directories nobody else can change, so no one can swap a link into its path.
export function assertRootOwned(dir: string) {
  for (let path = dir; ; path = NodePath.dirname(path)) {
    const stat = NodeFs.lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Refusal(`${path} must be a root-owned directory only root can write`);
    }
    if (path === "/") {
      return;
    }
  }
}

// The home is made and handed over through a handle that refuses a link, and nothing inside it is
// touched: the cell writes there, so beebotd makes its own folders.
export function prepareHome(path: string, uid: number, gid: number) {
  try {
    NodeFs.mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = NodeFs.constants;
  const fd = NodeFs.openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    NodeFs.fchownSync(fd, uid, gid);
    NodeFs.fchmodSync(fd, 0o700);
  } finally {
    NodeFs.closeSync(fd);
  }
}

// GNU rm walks with openat and never follows a link, even one a process swaps in mid-walk.
export const removeTree = (path: string) => run("rm", ["-rf", "--one-file-system", "--", path]);

// Cron and at would start a cell's processes outside its slice and its fence. A line is only ever
// added: a deleted cell's name stays denied.
function denyScheduling(cell: string) {
  for (const file of paths.denied) {
    const text = read(file);
    if (!text.split("\n").includes(cell)) {
      const exists = NodeFs.existsSync(file);
      // Appended in place, so the file keeps the owner and mode at and cron read it with.
      NodeFs.appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${cell}\n`);
      if (!exists) {
        NodeFs.chmodSync(file, 0o644);
      }
    }
  }
}

const unit = (cell: string) => `beebotd@${cell}.service`;
const slice = (cell: string) => `beebot-${cell}.slice`;
const home = (cell: string) => NodePath.join(paths.cells, cell);
const credFile = (cell: string) => NodePath.join(paths.creds, `${cell}.vault-key.cred`);
const quotaDir = (cell: string) => NodePath.join(paths.units, `${slice(cell)}.d`);

function lookup(cell: string) {
  const user = parseIds(read(paths.passwd)).find((entry) => entry.name === cell);
  if (!user) {
    return undefined;
  }
  const slot = user.id - cellIdBase;
  if (slot < 0 || slot >= cellSlots || user.home !== home(cell)) {
    throw new Refusal(`${cell} exists and is not a cell`);
  }
  return { uid: user.id, gid: user.gid, slot };
}

function writeQuota(cell: string, quota: Quota) {
  assertRootOwned(paths.units);
  const dir = quotaDir(cell);
  NodeFs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const text = `[Slice]\nMemoryMax=${quota.memory}\nCPUQuota=${quota.cpu}\nTasksMax=${quota.tasks}\n`;
  NodeFs.writeFileSync(NodePath.join(dir, ".quota.conf.new"), text, { mode: 0o644 });
  NodeFs.renameSync(NodePath.join(dir, ".quota.conf.new"), NodePath.join(dir, "quota.conf"));
}

function add(cell: string) {
  if (!parseIds(read(paths.group)).some((entry) => entry.name === gatewayGroup)) {
    throw new Refusal(`group ${gatewayGroup} is missing; install first`);
  }
  let found = lookup(cell);
  const created = found === undefined;
  if (!found) {
    const ids = new Set(parseIds(read(paths.passwd)).map((entry) => entry.id));
    const ranges = [...parseSubids(read(paths.subuid)), ...parseSubids(read(paths.subgid))];
    const slot = freeSlot(ids, ranges);
    // One command, and it refuses a taken uid, so two adds racing for one slot cannot both get it.
    run("useradd", [
      "--system",
      "--uid",
      String(cellIdBase + slot),
      "--user-group",
      "--home-dir",
      home(cell),
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      cell,
    ]);
    found = lookup(cell);
    if (!found) {
      throw new Error(`useradd did not create ${cell}`);
    }
  }
  const { uid, gid, slot } = found;
  // An existing range is kept, so a re-add never moves the ids a cell's files are owned by.
  for (const [file, flag] of [
    [paths.subuid, "--add-subuids"],
    [paths.subgid, "--add-subgids"],
  ] as const) {
    const entries = parseSubids(read(file));
    if (!entries.some((entry) => entry.name === cell)) {
      const range = subidRange(slot);
      if (entries.some((entry) => overlaps(entry, range))) {
        throw new Refusal(`${cell}'s subordinate id range is taken`);
      }
      run("usermod", [flag, `${range.start}-${range.start + range.count - 1}`, cell]);
    }
  }
  denyScheduling(cell);
  run("loginctl", ["disable-linger", cell]);
  assertRootOwned(paths.cells);
  prepareHome(home(cell), uid, gid);
  // A cred that exists is never replaced: the cell's vault is sealed with it.
  assertRootOwned(paths.creds);
  if (!NodeFs.existsSync(credFile(cell))) {
    const partial = `${credFile(cell)}.new`;
    // The key goes to systemd-creds over a pipe and only its sealed form is written.
    run(
      "systemd-creds",
      ["encrypt", "--name=vault-key", "-", partial],
      NodeCrypto.randomBytes(32).toString("base64"),
    );
    NodeFs.renameSync(partial, credFile(cell));
  }
  if (!NodeFs.existsSync(NodePath.join(quotaDir(cell), "quota.conf"))) {
    writeQuota(cell, defaultQuota);
  }
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", "--now", unit(cell)]);
  return { cell, uid, subid: subidRange(slot).start, created };
}

function existing(cell: string) {
  const found = lookup(cell);
  if (!found) {
    throw new Refusal(`no cell ${cell}`);
  }
  return found;
}

function show(name: string, properties: string[]) {
  const text = run("systemctl", ["show", name, ...properties.flatMap((p) => ["-p", p])]);
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function status(cell: string) {
  const found = lookup(cell);
  if (!found) {
    return { cell, exists: false };
  }
  const service = show(unit(cell), ["ActiveState", "SubState", "UnitFileState"]);
  const limits = show(slice(cell), [
    "MemoryMax",
    "CPUQuotaPerSecUSec",
    "TasksMax",
    "MemoryCurrent",
  ]);
  return {
    cell,
    exists: true,
    uid: found.uid,
    active: service.ActiveState,
    sub: service.SubState,
    enabled: service.UnitFileState,
    memoryMax: limits.MemoryMax,
    cpuQuotaPerSec: limits.CPUQuotaPerSecUSec,
    tasksMax: limits.TasksMax,
    memoryCurrent: limits.MemoryCurrent,
  };
}

// Irreversible. Each step tolerates an earlier, interrupted delete having done it already.
function remove(cell: string) {
  const found = lookup(cell);
  run("systemctl", ["disable", "--now", unit(cell)]);
  // Stopping the slice ends anything left in it, by cgroup, never by name.
  run("systemctl", ["stop", slice(cell)]);
  if (found) {
    for (const [file, flag] of [
      [paths.subuid, "--del-subuids"],
      [paths.subgid, "--del-subgids"],
    ] as const) {
      for (const entry of parseSubids(read(file)).filter((e) => e.name === cell)) {
        run("usermod", [flag, `${entry.start}-${entry.start + entry.count - 1}`, cell]);
      }
    }
    // userdel refuses while the user still runs a process anywhere, which keeps the uid from
    // being reused under a live process.
    run("userdel", [cell]);
  }
  if (parseIds(read(paths.group)).some((entry) => entry.name === cell)) {
    run("groupdel", [cell]);
  }
  assertRootOwned(paths.cells);
  removeTree(home(cell));
  if (NodeFs.existsSync(paths.sockets)) {
    assertRootOwned(paths.sockets);
    removeTree(NodePath.join(paths.sockets, cell));
  }
  NodeFs.rmSync(credFile(cell), { force: true });
  NodeFs.rmSync(quotaDir(cell), { recursive: true, force: true });
  run("systemctl", ["daemon-reload"]);
  return { cell, deleted: true };
}

export function execute(command: Command) {
  switch (command.verb) {
    case "add":
      return add(command.cell);
    case "suspend": {
      const { uid } = existing(command.cell);
      run("loginctl", ["disable-linger", command.cell]);
      run("systemctl", ["disable", "--now", unit(command.cell)]);
      // Ends whatever the cell left running, in its slice or in a session, by cgroup.
      run("systemctl", ["stop", slice(command.cell), `user-${uid}.slice`]);
      return { cell: command.cell, suspended: true };
    }
    case "resume":
      existing(command.cell);
      run("systemctl", ["enable", "--now", unit(command.cell)]);
      return { cell: command.cell, suspended: false };
    case "status":
      return status(command.cell);
    case "delete":
      return remove(command.cell);
    case "quota":
      existing(command.cell);
      writeQuota(command.cell, command.quota);
      run("systemctl", ["daemon-reload"]);
      return { cell: command.cell, ...command.quota };
  }
}

function main() {
  process.umask(0o077);
  try {
    if (process.getuid?.() !== 0) {
      throw new Refusal("must run as root");
    }
    const result = execute(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = error instanceof Refusal ? 2 : 1;
  }
}

const entry = process.argv[1];
if (entry && NodeFs.realpathSync(entry) === NodeUrl.fileURLToPath(import.meta.url)) {
  main();
}
