import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

import type { Egress } from "./egress.ts";
import type { Child, Podman } from "./podman.ts";
import {
  type Bind,
  type Box,
  type ContainerFacts,
  type Role,
  type RunSpec,
  boxNames,
  boxState,
  cdpArgv,
  containerSpec,
  copyInArgs,
  copyOutArgs,
  createArgs,
  downloadName,
  execArgs,
  execKillArgs,
  execReapArgs,
  networkArgs,
  ownedBy,
  ownershipLabels,
  roles,
  volumeArgs,
} from "./policy.ts";
import {
  type ExecRequest,
  Kind,
  type Request,
  type Response,
  accountPattern,
  botFileName,
  botIdPattern,
  boxToken,
  boxdChannels,
  egressId,
  frame,
  jsonFrame,
  sameHex,
} from "./protocol.ts";

export type BoxdOptions = {
  podman: Podman;
  egress: Egress;
  secret: Uint8Array;
  owner: string;
  prefix: string;
  labels: Record<string, string>;
  runSpec: RunSpec;
  seccomp: string;
  // In the Linux host: per-bot read-only directories and per-account credential directories.
  stateDir: string;
  send: (frame: Buffer) => void;
};

type Attached = { child: Child; botId: string; stop: () => Promise<void> };

const verbs = new Set<string>([
  "create",
  "start",
  "stop",
  "snapshot",
  "exec",
  "cdp",
  "egress",
  "put",
  "collect",
]);

const maxBotFile = 1024 * 1024;

export const botDirTarget = "/run/bee/bot";
export const credentialTarget = "/run/bee/credential";

function parseRequest(payload: Buffer): Request | { id: number; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(String(payload));
  } catch {
    return { id: -1, error: "bad request" };
  }
  const get = (key: string) =>
    value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const id = get("id");
  const verb = get("verb");
  const botId = get("botId");
  const token = get("token");
  if (typeof id !== "number") {
    return { id: -1, error: "bad request" };
  }
  if (
    typeof verb !== "string" ||
    !verbs.has(verb) ||
    typeof botId !== "string" ||
    typeof token !== "string"
  ) {
    return { id, error: "bad request" };
  }
  const base = { id, verb: verb as Request["verb"], botId, token };
  const isChannel = (channel: unknown): channel is number =>
    typeof channel === "number" &&
    Number.isInteger(channel) &&
    channel >= 1 &&
    channel < boxdChannels;
  const field = (object: unknown, key: string) =>
    object && typeof object === "object" ? Reflect.get(object, key) : undefined;
  switch (verb) {
    case "create": {
      const account = get("account");
      if (account === undefined) {
        return base;
      }
      return typeof account === "string" && accountPattern.test(account)
        ? { ...base, account }
        : { id, error: "bad account" };
    }
    case "cdp":
    case "egress": {
      const channel = get("channel");
      return isChannel(channel) ? { ...base, channel } : { id, error: "bad channel" };
    }
    case "put": {
      const put = get("put");
      const name = field(put, "name");
      const content = field(put, "content");
      return typeof name === "string" &&
        botFileName.test(name) &&
        typeof content === "string" &&
        Buffer.byteLength(content) <= maxBotFile
        ? { ...base, put: { name, content } }
        : { id, error: "bad file" };
    }
    case "collect": {
      const collect = get("collect");
      const file = field(collect, "file");
      const name = field(collect, "name");
      return typeof file === "string" &&
        /^[A-Za-z0-9-]{1,64}$/.test(file) &&
        typeof name === "string" &&
        downloadName.test(name)
        ? { ...base, collect: { file, name } }
        : { id, error: "bad download" };
    }
    case "exec":
      break;
    default:
      return base;
  }
  const exec = get("exec");
  const argv = field(exec, "argv");
  const env = field(exec, "env");
  const cwd = field(exec, "cwd");
  const channel = field(exec, "channel");
  const validEnv =
    env !== null &&
    typeof env === "object" &&
    Object.entries(env).every(
      ([key, item]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string" && !/[\n\0]/.test(item),
    );
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((part) => typeof part === "string") ||
    !validEnv ||
    (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/"))) ||
    !isChannel(channel)
  ) {
    return { id, error: "bad exec request" };
  }
  const request: ExecRequest = { argv, env: env as Record<string, string>, channel };
  if (typeof cwd === "string") {
    request.cwd = cwd;
  }
  return { ...base, exec: request };
}

export function createBoxd(options: BoxdOptions) {
  const { podman, egress, secret, owner, prefix, labels, runSpec, seccomp, stateDir, send } =
    options;
  const attached = new Map<number, Attached>();
  const relays = new Map<number, Duplex>();
  const queues = new Map<string, Promise<unknown>>();
  let nextRelay = boxdChannels;

  // create, start and stop for one bot run one at a time.
  function serially<T>(botId: string, work: () => Promise<T>) {
    const run = (queues.get(botId) ?? Promise.resolve()).then(work, work);
    queues.set(
      botId,
      run.catch(() => {}),
    );
    return run;
  }

  async function podmanOk(args: string[], env?: Record<string, string>) {
    const result = await podman.run(args, env);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `podman ${args[0]} failed`);
    }
    return result.stdout;
  }

  async function inspect(kind: "container" | "network" | "volume", name: string) {
    const result = await podman.run([kind, "inspect", name]);
    if (result.code !== 0) {
      if (/no such|not found/i.test(result.stderr)) {
        return null;
      }
      throw new Error(result.stderr.trim() || `podman ${kind} inspect failed`);
    }
    const [item]: unknown[] = JSON.parse(result.stdout);
    return item && typeof item === "object" ? item : null;
  }

  function labelsOf(item: object) {
    const config: unknown = Reflect.get(item, "Config");
    const raw: unknown =
      (config && typeof config === "object" ? Reflect.get(config, "Labels") : undefined) ??
      Reflect.get(item, "Labels") ??
      Reflect.get(item, "labels");
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : null;
  }

  async function facts(box: Box, name: string): Promise<ContainerFacts | null> {
    const item = await inspect("container", name);
    if (item === null) {
      return null;
    }
    const state: unknown = Reflect.get(item, "State");
    const flag = (key: string) =>
      state !== null && typeof state === "object" && Reflect.get(state, key) === true;
    return {
      owned: ownedBy(secret, box, name, labelsOf(item)),
      running: flag("Running"),
      oomKilled: flag("OOMKilled"),
    };
  }

  async function state(box: Box) {
    const names = boxNames(box);
    const [engine, browser] = await Promise.all([
      facts(box, names.container.engine),
      facts(box, names.container.browser),
    ]);
    return boxState(engine, browser);
  }

  async function requireOwned(box: Box) {
    const current = await state(box);
    if (current.state === "absent" || current.reason !== null) {
      throw new Error(
        `box ${box.botId} is ${current.state}${current.reason === null ? "" : `: ${current.reason}`}`,
      );
    }
    return current.state;
  }

  async function requireRunning(box: Box) {
    if ((await requireOwned(box)) !== "running") {
      throw new Error(`box ${box.botId} is stopped`);
    }
  }

  async function ensure(kind: "network" | "volume", box: Box, role: Role, name: string) {
    const existing = await inspect(kind, name);
    if (existing !== null) {
      if (!ownedBy(secret, box, name, labelsOf(existing))) {
        throw new Error(`${kind} ${name} is not owned by this boxd`);
      }
      return;
    }
    const resourceLabels = { ...labels, ...ownershipLabels(secret, box, role, name) };
    await podmanOk(
      kind === "network" ? networkArgs(name, resourceLabels) : volumeArgs(name, resourceLabels),
    );
  }

  const botDir = (botId: string) => NodePath.join(stateDir, "bots", botId, "box");

  // The engine user must own its credential directory; boxd's own user is root in the box.
  async function engineBinds(botId: string, account: string | undefined): Promise<Bind[]> {
    await NodeFs.mkdir(botDir(botId), { recursive: true, mode: 0o755 });
    const binds: Bind[] = [{ source: botDir(botId), target: botDirTarget, readOnly: true }];
    if (account !== undefined) {
      const dir = NodePath.join(stateDir, "credentials", account);
      await NodeFs.mkdir(dir, { recursive: true, mode: 0o700 });
      await podmanOk(["unshare", "chown", runSpec.engine.user, dir]);
      binds.push({ source: dir, target: credentialTarget, readOnly: false });
    }
    return binds;
  }

  async function create(box: Box, account: string | undefined) {
    const current = await state(box);
    if (current.state !== "absent") {
      throw new Error(`box ${box.botId} is ${current.state}`);
    }
    const names = boxNames(box);
    const made: string[] = [];
    try {
      for (const role of roles) {
        for (const key of Object.keys(runSpec[role].volumes)) {
          await ensure("volume", box, role, names.volume(role, key));
        }
        await ensure("network", box, role, names.network[role]);
        const attachment = await egress.attach({
          botId: box.botId,
          role,
          name: names.network[role],
        });
        const spec = containerSpec(role, {
          box,
          secret,
          runSpec,
          seccomp,
          egress: attachment,
          labels,
          binds: role === "engine" ? await engineBinds(box.botId, account) : [],
        });
        await podmanOk(createArgs(spec), spec.env);
        made.push(spec.name);
      }
    } catch (error) {
      if (made.length > 0) {
        await podman.run(["rm", "-f", "-t", "0", ...made]);
      }
      throw error;
    }
  }

  // Each box address, on its own network, as the egress proxy sees it.
  async function addresses(box: Box) {
    const names = boxNames(box);
    const found: string[] = [];
    for (const role of roles) {
      const item = await inspect("container", names.container[role]);
      const networks: unknown = Reflect.get(
        Reflect.get(item ?? {}, "NetworkSettings") ?? {},
        "Networks",
      );
      const address: unknown = Reflect.get(
        (networks && typeof networks === "object"
          ? Reflect.get(networks, names.network[role])
          : undefined) ?? {},
        "IPAddress",
      );
      if (typeof address === "string" && address !== "") {
        found.push(address);
      }
    }
    return found;
  }

  async function bind(box: Box) {
    for (const address of await addresses(box)) {
      await egress.bind(address, box.botId);
    }
  }

  async function start(box: Box) {
    await requireOwned(box);
    const names = boxNames(box);
    await podmanOk(["start", names.container.engine, names.container.browser]);
    await bind(box);
  }

  async function stop(box: Box) {
    await requireOwned(box);
    await Promise.all(
      [...attached.values()].filter((entry) => entry.botId === box.botId).map(stopAttached),
    );
    for (const address of await addresses(box)) {
      await egress.unbind(address);
    }
    const names = boxNames(box);
    await podmanOk(["stop", "-t", "5", names.container.engine, names.container.browser]);
  }

  async function stopAttached(entry: Attached) {
    await entry.stop();
    entry.child.kill();
  }

  function attach(channel: number, botId: string, child: Child, stop: () => Promise<void>) {
    attached.set(channel, { child, botId, stop });
    child.stdout.on("data", (chunk: Buffer) => send(frame(channel, Kind.data, chunk)));
    child.stdout.on("end", () => send(frame(channel, Kind.eof)));
    void child.exited.then((code) => {
      attached.delete(channel);
      send(frame(channel, Kind.exit, JSON.stringify(code)));
    });
  }

  async function exec(box: Box, role: Role, request: ExecRequest) {
    if (attached.has(request.channel)) {
      throw new Error(`channel ${request.channel} in use`);
    }
    await requireRunning(box);
    const container = boxNames(box).container[role];
    const execId = NodeCrypto.randomUUID();
    const child = podman.spawn(execArgs(container, execId, request), request.env);
    attach(request.channel, box.botId, child, async () => {
      await podman.run(execKillArgs(container, execId));
    });
  }

  async function put(box: Box, name: string, content: string) {
    const dir = botDir(box.botId);
    await NodeFs.mkdir(dir, { recursive: true, mode: 0o755 });
    const temp = NodePath.join(dir, `.${name}.${NodeCrypto.randomUUID()}`);
    await NodeFs.writeFile(temp, content, { mode: 0o644 });
    await NodeFs.rename(temp, NodePath.join(dir, name));
  }

  async function collect(box: Box, file: string, name: string) {
    await requireRunning(box);
    const names = boxNames(box);
    const workspace = runSpec.engine.volumes.workspace ?? runSpec.engine.home;
    const from = podman.spawn(copyOutArgs(names.container.browser, file), {});
    const into = podman.spawn(
      copyInArgs(names.container.engine, `${workspace}/downloads`, name),
      {},
    );
    from.stdout.pipe(into.stdin);
    into.stdout.resume();
    const [read, written] = await Promise.all([from.exited, into.exited]);
    if (read !== 0 || written !== 0) {
      throw new Error("download copy failed");
    }
  }

  async function handle(request: Request): Promise<Response> {
    const { id, verb, botId, token } = request;
    if (verb === "egress") {
      if (botId !== egressId || !sameHex(token, boxToken(secret, egressId))) {
        return { id, ok: false, error: "bad box token" };
      }
      const channel = request.channel ?? 0;
      const child = attached.has(channel) ? null : egress.control();
      if (child === null) {
        return { id, ok: false, error: "egress control unavailable" };
      }
      attach(channel, egressId, child, async () => {});
      return { id, ok: true };
    }
    if (!botIdPattern.test(botId) || !sameHex(token, boxToken(secret, botId))) {
      return { id, ok: false, error: "bad box token" };
    }
    const box = { prefix, owner, botId };
    try {
      switch (verb) {
        case "create":
          await serially(botId, () => create(box, request.account));
          return { id, ok: true };
        case "start":
          await serially(botId, () => start(box));
          return { id, ok: true };
        case "stop":
          await serially(botId, () => stop(box));
          return { id, ok: true };
        case "snapshot":
          return { id, ok: true, state: (await state(box)).state };
        case "exec":
          if (request.exec === undefined) {
            return { id, ok: false, error: "bad exec request" };
          }
          await exec(box, "engine", request.exec);
          return { id, ok: true };
        case "cdp":
          await exec(box, "browser", { argv: cdpArgv, env: {}, channel: request.channel ?? 0 });
          return { id, ok: true };
        case "put":
          if (request.put === undefined) {
            return { id, ok: false, error: "bad file" };
          }
          await put(box, request.put.name, request.put.content);
          return { id, ok: true };
        case "collect":
          if (request.collect === undefined) {
            return { id, ok: false, error: "bad download" };
          }
          await collect(box, request.collect.file, request.collect.name);
          return { id, ok: true };
        case "display":
          return { id, ok: false, error: "no display in this box" };
      }
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function owned(role: Role) {
    const result = await podman.run([
      "ps",
      "--filter",
      `label=beebot.owner=${owner}`,
      "--filter",
      `label=beebot.role=${role}`,
      "--format",
      "json",
    ]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "podman ps failed");
    }
    const listed: unknown = JSON.parse(result.stdout || "[]");
    const found: { name: string; botId: string }[] = [];
    for (const item of Array.isArray(listed) ? listed : []) {
      const names: unknown = Reflect.get(item, "Names");
      const name = Array.isArray(names) ? names[0] : undefined;
      const itemLabels = labelsOf(item);
      const botId = itemLabels?.["beebot.bot"];
      if (
        typeof name === "string" &&
        botId !== undefined &&
        ownedBy(secret, { prefix, owner, botId }, name, itemLabels)
      ) {
        found.push({ name, botId });
      }
    }
    return found;
  }

  return {
    onFrame(channel: number, kind: Kind, payload: Buffer) {
      if (channel === 0 && kind === Kind.json) {
        const request = parseRequest(payload);
        if ("error" in request) {
          send(jsonFrame({ id: request.id, ok: false, error: request.error } satisfies Response));
          return;
        }
        void handle(request).then((response) => send(jsonFrame(response)));
        return;
      }
      const relay = relays.get(channel);
      if (relay !== undefined) {
        if (kind === Kind.data) {
          relay.write(payload);
        } else if (kind === Kind.eof) {
          relay.end();
        } else if (kind === Kind.kill) {
          relay.destroy();
        }
        return;
      }
      const entry = attached.get(channel);
      if (entry === undefined) {
        return;
      }
      if (kind === Kind.data) {
        entry.child.stdin.write(payload);
      } else if (kind === Kind.eof) {
        entry.child.stdin.end();
      } else if (kind === Kind.kill) {
        void stopAttached(entry);
      }
    },

    // One connection from the egress proxy's `/bee/*` lane, carried to beebotd.
    relay(socket: Duplex) {
      const channel = nextRelay++;
      relays.set(channel, socket);
      send(frame(channel, Kind.open));
      socket.on("data", (chunk: Buffer) => send(frame(channel, Kind.data, chunk)));
      socket.on("end", () => send(frame(channel, Kind.eof)));
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        relays.delete(channel);
        send(frame(channel, Kind.kill));
      });
    },

    async reapOrphans() {
      for (const { name } of await owned("engine")) {
        await podman.run(execReapArgs(name));
      }
    },

    // Boxes still running from before this boxd: the new proxy learns their addresses again.
    async rebind() {
      for (const { botId } of await owned("engine")) {
        await bind({ prefix, owner, botId });
      }
    },

    // The server is gone: no turn outlives its attach.
    async close() {
      for (const relay of relays.values()) {
        relay.destroy();
      }
      await Promise.all([...attached.values()].map(stopAttached));
    },
  };
}
