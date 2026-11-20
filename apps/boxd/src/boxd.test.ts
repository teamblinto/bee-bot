import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createBoxd } from "./boxd.ts";
import { type Egress, noEgress } from "./egress.ts";
import { boxNames } from "./policy.ts";
import {
  Kind,
  type Response,
  boxToken,
  egressId,
  frameReader,
  jsonFrame,
  frame,
} from "./protocol.ts";
import { createFakePodman, testRunSpec, testStateDir } from "./testing.ts";

const secret = Buffer.alloc(32, 3);
const box = { prefix: "beebot", owner: "env-1", botId: "bot-1" };
const names = boxNames(box);

function harness(fake = createFakePodman(), egress?: Egress, stateDir = testStateDir()) {
  const responses = new Map<number, (response: Response) => void>();
  const output: { channel: number; kind: number; payload: Buffer }[] = [];
  const read = frameReader((channel, kind, payload) => {
    if (channel === 0) {
      const response = JSON.parse(String(payload)) as Response;
      responses.get(response.id)?.(response);
    } else {
      output.push({ channel, kind, payload: Buffer.from(payload) });
    }
  });
  const boxd = createBoxd({
    podman: fake.podman,
    egress: egress ?? noEgress,
    secret,
    owner: box.owner,
    prefix: box.prefix,
    labels: { "beebot-dev": "1" },
    runSpec: testRunSpec,
    seccomp: "/opt/boxd/seccomp-chromium.json",
    stateDir,
    send: read,
  });
  let nextId = 1;
  const call = (verb: string, extra: object = {}, token = boxToken(secret, box.botId)) =>
    new Promise<Response>((resolve) => {
      const id = nextId++;
      responses.set(id, resolve);
      boxd.onFrame(
        0,
        Kind.json,
        jsonFrame({ id, verb, botId: box.botId, token, ...extra }).subarray(9),
      );
    });
  return { boxd, call, output, fake, stateDir };
}

describe("boxd", () => {
  it("refuses a request without this box's token", async () => {
    const { call, fake } = harness();
    expect(await call("create", {}, boxToken(secret, "bot-2"))).toMatchObject({
      ok: false,
      error: "bad box token",
    });
    expect(await call("create", {}, boxToken(Buffer.alloc(32, 4), box.botId))).toMatchObject({
      ok: false,
    });
    expect(fake.calls).toEqual([]);
  });

  it("creates two containers on two isolated networks with separate volumes", async () => {
    const egress: Egress = {
      ...noEgress,
      attach: async ({ role }) => ({
        dns: `10.0.${role === "engine" ? 1 : 2}.2`,
        env: { HTTPS_PROXY: "http://proxy:3128" },
      }),
    };
    const { call, fake } = harness(createFakePodman(), egress);
    expect(await call("create")).toMatchObject({ ok: true });
    expect(await call("snapshot")).toMatchObject({ ok: true, state: "stopped" });
    expect([...fake.resources.network.keys()]).toEqual([
      names.network.engine,
      names.network.browser,
    ]);
    expect([...fake.resources.volume.keys()]).toEqual([
      names.volume("engine", "home"),
      names.volume("engine", "workspace"),
      names.volume("browser", "profile"),
    ]);
    for (const network of fake.resources.network.values()) {
      expect(network.args).toContain("isolate=true");
      expect(network.labels["beebot-dev"]).toBe("1");
    }
    const engine = fake.resources.container.get(names.container.engine)!;
    expect(engine.args.join(" ")).toContain("--dns 10.0.1.2");
    const engineCreate = fake.calls.find(
      (entry) => entry.args.includes(names.container.engine) && entry.args[0] === "create",
    );
    expect(engineCreate?.env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(await call("create")).toMatchObject({ ok: false, error: "box bot-1 is stopped" });
  });

  it("mounts the bot's read-only directory and its account's credentials into the engine", async () => {
    const { call, fake, stateDir } = harness();
    expect(await call("create", { account: "../x" })).toMatchObject({ error: "bad account" });
    expect(await call("create", { account: "claude" })).toMatchObject({ ok: true });
    const engine = fake.resources.container.get(names.container.engine)!.args.join(" ");
    const browser = fake.resources.container.get(names.container.browser)!.args.join(" ");
    const botDir = NodePath.join(stateDir, "bots", box.botId, "box");
    expect(engine).toContain(`${botDir}:/run/bee/bot:ro,`);
    expect(engine).toContain(
      `${NodePath.join(stateDir, "credentials", "claude")}:/run/bee/credential:`,
    );
    expect(browser).not.toContain(stateDir);
    expect(
      await call("put", { put: { name: "persona.md", content: "You are Bee." } }),
    ).toMatchObject({ ok: true });
    expect(NodeFs.readFileSync(NodePath.join(botDir, "persona.md"), "utf8")).toBe("You are Bee.");
    expect(await call("put", { put: { name: "../evil", content: "" } })).toMatchObject({
      error: "bad file",
    });
  });

  it("says whether an account's login exists, through podman's user namespace and with no box", async () => {
    const { call, fake, stateDir } = harness();
    expect(await call("login", { account: "../x" })).toMatchObject({ error: "bad account" });
    expect(await call("login")).toMatchObject({ error: "bad account" });
    expect(await call("login", { account: "claude" })).toEqual({ id: 3, ok: true, login: false });
    const folder = NodePath.join(stateDir, "credentials", "claude");
    NodeFs.mkdirSync(folder, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(folder, ".credentials.json"), "{}");
    expect(await call("login", { account: "claude" })).toMatchObject({ ok: true, login: true });
    expect(fake.calls.map(({ args }) => args.slice(0, 3))).toEqual([
      ["unshare", "test", "-e"],
      ["unshare", "test", "-e"],
    ]);
    expect(await call("snapshot")).toMatchObject({ state: "absent" });
  });

  it("keeps only the listed skills in the bot's read-only skills mount", async () => {
    const { call, fake, stateDir } = harness();
    await call("create");
    const engine = fake.resources.container.get(names.container.engine)!.args.join(" ");
    const skills = NodePath.join(stateDir, "bots", box.botId, "skills");
    expect(engine).toContain(`${skills}:/run/bee/skills:ro,nosuid,nodev,noexec`);
    const sha256 = "a".repeat(64);
    const data = Buffer.from("x").toString("base64");
    const skill = (path: string) => ({ skill: { name: "pdf", sha256, files: [{ path, data }] } });
    for (const path of ["../evil", "a/../../evil", ".hidden", "a//b"]) {
      expect(await call("skill", skill(path))).toMatchObject({ error: "bad skill" });
    }
    expect(await call("skills", { keep: [{ name: "../x", sha256 }] })).toMatchObject({
      error: "bad skills",
    });
    expect(await call("skills", { keep: [{ name: "pdf", sha256 }] })).toMatchObject({
      missing: ["pdf"],
    });
    expect(await call("skill", skill("ref/a.md"))).toMatchObject({ ok: true });
    expect(NodeFs.readFileSync(NodePath.join(skills, "pdf", "ref", "a.md"), "utf8")).toBe("x");
    expect(await call("skills", { keep: [{ name: "pdf", sha256 }] })).toMatchObject({
      missing: [],
    });
    expect(await call("skills", { keep: [] })).toMatchObject({ missing: [] });
    expect(NodeFs.readdirSync(skills)).toEqual([]);
  });

  it("opens the proxy's control socket only with its own token", async () => {
    const { call } = harness();
    const request = (botId: string, token: string) => call("egress", { botId, channel: 5 }, token);
    expect(await request(egressId, boxToken(secret, box.botId))).toMatchObject({
      error: "bad box token",
    });
    expect(await request(box.botId, boxToken(secret, box.botId))).toMatchObject({
      error: "bad box token",
    });
    expect(await request(egressId, boxToken(secret, egressId))).toMatchObject({
      error: "egress control unavailable",
    });
  });

  it("retires a box made from an older image and keeps its volumes", async () => {
    const { call, fake } = harness();
    await call("create");
    await call("start");
    expect(await call("snapshot")).toMatchObject({ state: "running" });
    const browser = fake.resources.container.get(names.container.browser)!;
    browser.args = browser.args.map((arg) =>
      arg.startsWith("localhost/") ? "localhost/old:1" : arg,
    );
    expect(await call("snapshot")).toMatchObject({ ok: true, state: "absent" });
    expect(fake.resources.container.size).toBe(0);
    expect(fake.resources.volume.size).toBe(3);
    expect(await call("create")).toMatchObject({ ok: true });
  });

  it("destroys only its own box, volumes and directories, taking the proxy off first", async () => {
    const detached: string[] = [];
    const egress: Egress = {
      ...noEgress,
      detach: async (network) => {
        detached.push(network);
      },
    };
    const { call, fake, stateDir } = harness(createFakePodman(), egress);
    await call("create", { account: "claude" });
    await call("start");
    const foreign = names.volume("browser", "profile");
    fake.resources.volume.set(foreign, { labels: {}, args: [], running: false });

    expect(await call("destroy")).toMatchObject({ ok: true });

    expect(fake.resources.container.size).toBe(0);
    expect(fake.resources.network.size).toBe(0);
    expect([...fake.resources.volume.keys()]).toEqual([foreign]);
    expect(detached).toEqual([names.network.engine, names.network.browser]);
    expect(NodeFs.existsSync(NodePath.join(stateDir, "bots", box.botId))).toBe(false);
    expect(NodeFs.existsSync(NodePath.join(stateDir, "credentials", "claude"))).toBe(true);
    expect(await call("destroy")).toMatchObject({ ok: true });
  });

  it("rolls back a half-made box", async () => {
    const { call, fake } = harness(
      createFakePodman({ failCreate: (name) => name.endsWith("-browser") }),
    );
    expect(await call("create")).toMatchObject({ ok: false, error: "Error: image not known" });
    expect(fake.resources.container.size).toBe(0);
    expect(await call("snapshot")).toMatchObject({ state: "absent" });
  });

  it("will not touch containers whose labels it did not sign", async () => {
    const { call, fake } = harness();
    for (const name of Object.values(names.container)) {
      fake.resources.container.set(name, {
        labels: {
          "beebot.owner": box.owner,
          "beebot.bot": box.botId,
          "beebot.mac": "0".repeat(64),
        },
        args: [],
        running: false,
      });
    }
    expect(await call("start")).toMatchObject({
      ok: false,
      error: "box bot-1 is failed: container not owned by this boxd",
    });
    expect(fake.resources.container.get(names.container.engine)?.running).toBe(false);
  });

  it("refuses an existing volume it does not own", async () => {
    const { call, fake } = harness();
    fake.resources.volume.set(names.volume("engine", "home"), {
      labels: {},
      args: [],
      running: false,
    });
    expect(await call("create")).toMatchObject({
      ok: false,
      error: `volume ${names.volume("engine", "home")} is not owned by this boxd`,
    });
  });

  it("streams an exec and kills it when the attach drops", async () => {
    const { call, output, boxd } = harness();
    await call("create");
    expect(await call("exec", { exec: { argv: ["x"], env: {}, channel: 1 } })).toMatchObject({
      ok: false,
      error: "box bot-1 is stopped",
    });
    await call("start");
    const exec = (channel: number, script: string) =>
      call("exec", {
        exec: {
          argv: [process.execPath, "-e", script],
          env: { PATH: process.env.PATH ?? "" },
          channel,
        },
      });
    expect(await exec(1, "process.stdin.pipe(process.stdout)")).toMatchObject({ ok: true });
    boxd.onFrame(1, Kind.data, frame(1, Kind.data, "hi").subarray(9));
    boxd.onFrame(1, Kind.eof, Buffer.alloc(0));
    expect(await exec(2, "setInterval(() => {}, 1000)")).toMatchObject({ ok: true });
    boxd.onFrame(2, Kind.kill, Buffer.alloc(0));
    await expect.poll(() => output.filter((entry) => entry.kind === Kind.exit).length).toBe(2);
    const of = (channel: number, kind: number) =>
      output.filter((entry) => entry.channel === channel && entry.kind === kind);
    expect(String(of(1, Kind.data)[0]?.payload)).toBe("hi");
    expect(JSON.parse(String(of(1, Kind.exit)[0]?.payload))).toBe(0);
    expect(JSON.parse(String(of(2, Kind.exit)[0]?.payload))).not.toBe(0);
  });

  it("routes a view to the view-only socket, and control only to a lease's own socket", async () => {
    const { call, fake } = harness();
    const lease = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    await call("create");
    await call("start");
    const browserExecs = () =>
      fake.calls.filter(
        (entry) => entry.args[0] === "exec" && entry.args.includes(names.container.browser),
      );
    expect(await call("display", { mode: "view" })).toMatchObject({ error: "bad channel" });
    expect(await call("display", { channel: 3 })).toMatchObject({ error: "bad mode" });
    expect(await call("display", { channel: 3, mode: "control" })).toMatchObject({
      error: "bad mode",
    });
    for (const bad of ["../../etc/x", `${lease} -viewonly`, lease.toUpperCase()]) {
      expect(await call("display", { channel: 3, mode: "control", lease: bad })).toMatchObject({
        error: "bad mode",
      });
      expect(await call("control", { channel: 3, lease: bad })).toMatchObject({
        error: "bad lease",
      });
    }
    expect(browserExecs()).toEqual([]);

    expect(await call("display", { channel: 3, mode: "view", lease })).toMatchObject({ ok: true });
    expect(browserExecs()[0]?.args.slice(0, 3)).toEqual(["exec", "-i", names.container.browser]);
    expect(browserExecs()[0]?.args.slice(-3)).toEqual([
      "socat",
      "STDIO",
      "UNIX-CONNECT:/tmp/bee-display/view.sock,retry=50,interval=0.1",
    ]);
    expect(await call("display", { channel: 4, mode: "control", lease })).toMatchObject({
      ok: true,
    });
    expect(browserExecs()[1]?.args.at(-1)).toBe(
      `UNIX-CONNECT:/tmp/bee-display/control-${lease}.sock,retry=50,interval=0.1`,
    );
    expect(await call("control", { channel: 5, lease })).toMatchObject({ ok: true });
    const server = browserExecs()[2]?.args ?? [];
    expect(server.at(-1)).toBe(`/tmp/bee-display/control-${lease}.sock`);
    expect(server.join(" ")).toContain("x11vnc -display :1");
    expect(server.join(" ")).not.toMatch(/-viewonly|-shared/);
  });

  it("captures the desktop only with its own fixed argv, in the browser container", async () => {
    const { call, fake } = harness();
    await call("create");
    await call("start");
    expect(await call("capture", {})).toMatchObject({ error: "bad channel" });
    expect(
      await call("capture", { channel: 3, exec: { argv: ["sh"], env: {}, channel: 3 } }),
    ).toMatchObject({ ok: true });
    const execs = fake.calls.filter((entry) => entry.args[0] === "exec");
    expect(execs).toHaveLength(1);
    expect(execs[0]?.args.slice(0, 3)).toEqual(["exec", "-i", names.container.browser]);
    expect(execs[0]?.args.slice(-10)).toEqual([
      "import",
      "-display",
      ":1",
      "-window",
      "root",
      "-resize",
      "400x",
      "-quality",
      "70",
      "jpeg:-",
    ]);
    expect(execs[0]?.env).toEqual({});
    expect(await call("capture", { channel: 4, full: "yes" })).toMatchObject({
      error: "bad capture",
    });
    expect(await call("capture", { channel: 4, full: true })).toMatchObject({ ok: true });
    expect(fake.calls.at(-1)?.args.slice(-6)).toEqual([
      "import",
      "-display",
      ":1",
      "-window",
      "root",
      "png:-",
    ]);
  });

  it("runs input as the xdotool argv it builds itself, never one it is sent", async () => {
    const { call, fake } = harness();
    await call("create");
    await call("start");
    const before = fake.calls.length;
    expect(
      await call("input", { channel: 3, input: [{ type: "move", x: 1, y: 2 }, "sh -c id"] }),
    ).toMatchObject({ error: "bad input" });
    expect(await call("input", { input: [{ type: "move", x: 1, y: 2 }] })).toMatchObject({
      error: "bad channel",
    });
    expect(fake.calls).toHaveLength(before);
    expect(
      await call("input", {
        channel: 3,
        input: [
          { type: "move", x: 10, y: 20 },
          { type: "click", button: 1 },
        ],
        exec: { argv: ["sh"], env: {}, channel: 3 },
      }),
    ).toMatchObject({ ok: true });
    const exec = fake.calls.at(-1);
    expect(exec?.args.slice(0, 3)).toEqual(["exec", "-i", names.container.browser]);
    expect(exec?.args.slice(-9)).toEqual(
      "xdotool mousemove -- 10 20 click --repeat 1 1".split(" "),
    );
    expect(exec?.env).toEqual({ DISPLAY: ":1" });
  });

  it("removes a lease's socket file once its control server is gone", async () => {
    const { call, fake, output } = harness();
    const lease = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    await call("create");
    await call("start");
    expect(await call("control", { channel: 5, lease })).toMatchObject({ ok: true });
    await expect.poll(() => output.some((entry) => entry.kind === Kind.exit)).toBe(true);
    expect(fake.calls.map(({ args }) => args)).toContainEqual([
      "exec",
      names.container.browser,
      "rm",
      "-f",
      `/tmp/bee-display/control-${lease}.sock`,
    ]);
  });

  it("kills every attached turn when the server goes away", async () => {
    const { call, output, boxd } = harness();
    await call("create");
    await call("start");
    await call("exec", {
      exec: { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], env: {}, channel: 1 },
    });
    await boxd.close();
    await expect.poll(() => output.some((entry) => entry.kind === Kind.exit)).toBe(true);
  });
});
