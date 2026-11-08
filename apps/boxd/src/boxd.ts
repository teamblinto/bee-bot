import * as NodeCrypto from "node:crypto";

import type { Egress } from "./egress.ts";
import type { Child, Podman } from "./podman.ts";
import {
  type Box,
  type ContainerFacts,
  type RunSpec,
  boxNames,
  boxState,
  containerSpec,
  createArgs,
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
  boxToken,
  botIdPattern,
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
  send: (frame: Buffer) => void;
};

type Exec = { child: Child; botId: string; container: string; execId: string };

const verbs = new Set(["create", "start", "stop", "snapshot", "exec"]);

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
  if (verb !== "exec") {
    return { id, verb: verb as Request["verb"], botId, token };
  }
  const exec = get("exec");
  const field = (key: string) =>
    exec && typeof exec === "object" ? Reflect.get(exec, key) : undefined;
  const argv = field("argv");
  const env = field("env");
  const cwd = field("cwd");
  const channel = field("channel");
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
    typeof channel !== "number" ||
    !Number.isInteger(channel) ||
    channel < 1
  ) {
    return { id, error: "bad exec request" };
  }
  const request: ExecRequest = { argv, env: env as Record<string, string>, channel };
  if (typeof cwd === "string") {
    request.cwd = cwd;
  }
  return { id, verb: "exec", botId, token, exec: request };
}

export function createBoxd(options: BoxdOptions) {
  const { podman, egress, secret, owner, prefix, labels, runSpec, seccomp, send } = options;
  const execs = new Map<number, Exec>();
  const queues = new Map<string, Promise<unknown>>();

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

  async function ensure(
    kind: "network" | "volume",
    box: Box,
    role: (typeof roles)[number],
    name: string,
  ) {
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

  async function create(box: Box) {
    const current = await state(box);
    if (current.state !== "absent") {
      throw new Error(`box ${box.botId} is ${current.state}`);
    }
    const names = boxNames(box);
    const made: string[] = [];
    try {
      for (const role of roles) {
        await ensure("volume", box, role, names.volume[role]);
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

  async function killExec(exec: Exec) {
    await podman.run(execKillArgs(exec.container, exec.execId));
    exec.child.kill();
  }

  async function start(box: Box) {
    await requireOwned(box);
    const names = boxNames(box);
    await podmanOk(["start", names.container.engine, names.container.browser]);
  }

  async function stop(box: Box) {
    await requireOwned(box);
    await Promise.all([...execs.values()].filter((exec) => exec.botId === box.botId).map(killExec));
    const names = boxNames(box);
    await podmanOk(["stop", "-t", "5", names.container.engine, names.container.browser]);
  }

  async function exec(box: Box, request: ExecRequest) {
    if (execs.has(request.channel)) {
      throw new Error(`channel ${request.channel} in use`);
    }
    if ((await requireOwned(box)) !== "running") {
      throw new Error(`box ${box.botId} is stopped`);
    }
    const container = boxNames(box).container.engine;
    const execId = NodeCrypto.randomUUID();
    const child = podman.spawn(execArgs(container, execId, request), request.env);
    const { channel } = request;
    execs.set(channel, { child, botId: box.botId, container, execId });
    child.stdout.on("data", (chunk: Buffer) => send(frame(channel, Kind.data, chunk)));
    child.stdout.on("end", () => send(frame(channel, Kind.eof)));
    void child.exited.then((code) => {
      execs.delete(channel);
      send(frame(channel, Kind.exit, JSON.stringify(code)));
    });
  }

  async function handle(request: Request): Promise<Response> {
    const { id, verb, botId, token } = request;
    if (!botIdPattern.test(botId) || !sameHex(token, boxToken(secret, botId))) {
      return { id, ok: false, error: "bad box token" };
    }
    const box = { prefix, owner, botId };
    try {
      switch (verb) {
        case "create":
          await serially(botId, () => create(box));
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
          await exec(box, request.exec);
          return { id, ok: true };
      }
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
      const exec = execs.get(channel);
      if (exec === undefined) {
        return;
      }
      if (kind === Kind.data) {
        exec.child.stdin.write(payload);
      } else if (kind === Kind.eof) {
        exec.child.stdin.end();
      } else if (kind === Kind.kill) {
        void killExec(exec);
      }
    },

    async reapOrphans() {
      const result = await podman.run([
        "ps",
        "--filter",
        `label=beebot.owner=${owner}`,
        "--filter",
        "label=beebot.role=engine",
        "--format",
        "json",
      ]);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "podman ps failed");
      }
      const listed: unknown = JSON.parse(result.stdout || "[]");
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
          await podman.run(execReapArgs(name));
        }
      }
    },

    // The server is gone: no turn outlives its attach.
    async close() {
      await Promise.all([...execs.values()].map(killExec));
    },
  };
}
