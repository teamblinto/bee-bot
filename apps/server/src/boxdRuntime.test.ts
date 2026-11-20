import { PassThrough } from "node:stream";

import { maxTypedText } from "@beebot/boxd/protocol";
import { createFakePodman, serveInProcess } from "@beebot/boxd/testing";
import { describe, expect, it } from "vite-plus/test";

import { connectBoxd, inputTimeoutMs, machineSsh, podmanEnv } from "./boxdRuntime.ts";

const node = (script: string) => ({
  argv: [process.execPath, "-e", script],
  env: { PATH: process.env.PATH ?? "" },
});

async function read(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return String(Buffer.concat(chunks));
}

describe("boxd adapter", () => {
  async function connect() {
    const fake = createFakePodman();
    // xdotool isn't here: input runs a process that never ends instead.
    const transport = serveInProcess({
      ...fake.podman,
      spawn: (args, env) => {
        const at = args.indexOf("-c") + 3;
        // A process that exits while a descendant still holds its stdout open.
        if (args[at] === "held-stdout") {
          const stdout = new PassThrough();
          stdout.write("bye");
          const exited = new Promise<number>((resolve) => setImmediate(() => resolve(0)));
          return { stdin: new PassThrough(), stdout, kill: () => {}, exited };
        }
        return fake.podman.spawn(
          args[at] === "xdotool"
            ? [...args.slice(0, at), process.execPath, "-e", "setInterval(() => {}, 1000)"]
            : args,
          env,
        );
      },
    });
    const { runtime, closed } = await connectBoxd(transport, {
      secret: Buffer.alloc(32, 1),
      owner: "env-1",
    });
    return { runtime, closed, transport, fake };
  }

  it("runs the box lifecycle through boxd", async () => {
    const { runtime } = await connect();
    expect(await runtime.snapshot("bot-1")).toBe("absent");
    await runtime.create("bot-1");
    await expect(runtime.execAttach("bot-1", node(""))).rejects.toThrow("stopped");
    await runtime.start("bot-1");
    expect(await runtime.snapshot("bot-1")).toBe("running");
    await runtime.stop("bot-1");
    expect(await runtime.snapshot("bot-1")).toBe("stopped");
    await expect(runtime.create("Bad/Id")).rejects.toThrow("bad box token");
  });

  it("streams stdin and stdout", async () => {
    const { runtime } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach(
      "bot-1",
      node("process.stdin.pipe(process.stdout)"),
    );
    stream.end("hello");
    expect(await read(stream)).toBe("hello");
    expect(await exited).toBe(0);
  });

  it("ends stdout at exit even while a descendant holds it open", async () => {
    const { runtime } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach("bot-1", {
      argv: ["held-stdout"],
      env: {},
    });
    expect(await exited).toBe(0);
    expect(await read(stream)).toBe("bye");
  });

  it("kills the process when the stream drops", async () => {
    const { runtime } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach(
      "bot-1",
      node("setInterval(() => {}, 1000)"),
    );
    stream.destroy();
    expect(await exited).not.toBe(0);
  });

  it("kills the bot's input in the box when it is aborted", async () => {
    const { runtime } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const controller = new AbortController();
    const typing = runtime.input("bot-1", [{ type: "type", text: "a" }], controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(typing).rejects.toThrow("aborted");
  });

  it("gives typing time to finish, even the longest text on a slow machine", () => {
    const longest = inputTimeoutMs([{ type: "type", text: "x".repeat(maxTypedText) }]);
    // Twice the 15 s that 2000 characters took in the Podman machine.
    expect(longest).toBeGreaterThan(2 * 15_000);
    expect(inputTimeoutMs([{ type: "wait", ms: 500 }])).toBe(10_500);
  });

  it("ends every attach when boxd goes away", async () => {
    const { runtime, transport, closed } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach(
      "bot-1",
      node("setInterval(() => {}, 1000)"),
    );
    transport.destroy();
    await closed;
    expect(await exited).toBeNull();
    expect(stream.destroyed).toBe(true);
    await expect(runtime.snapshot("bot-1")).rejects.toThrow("connection lost");
  });
});

describe("podman environment", () => {
  it("puts the OpenSSH that ships with Windows first on PATH", () => {
    const env = podmanEnv({ Path: "C:\\tools\\usr\\bin", SystemRoot: "C:\\Windows" }, "win32");
    expect(env.Path).toBe("C:\\Windows\\System32\\OpenSSH;C:\\tools\\usr\\bin");
    const mac = { PATH: "/usr/bin" };
    expect(podmanEnv(mac, "darwin")).toBe(mac);
  });

  it("lets Podman on Linux find gvproxy and virtiofsd where distros install them", () => {
    expect(podmanEnv({ PATH: "/usr/bin" }, "linux")).toEqual({
      PATH: "/usr/bin:/usr/libexec:/usr/lib",
      CONTAINERS_HELPER_BINARY_DIR: "/usr/bin",
    });
    const own = podmanEnv(
      { PATH: "/usr/bin", CONTAINERS_HELPER_BINARY_DIR: "/opt/podman" },
      "linux",
    );
    expect(own.CONTAINERS_HELPER_BINARY_DIR).toBe("/opt/podman");
  });

  it("logs in to a rootful machine as its rootless user, not root", () => {
    const inspect = JSON.stringify([{ Rootful: true, SSHConfig: { RemoteUsername: "user" } }]);
    expect(machineSsh(inspect, "m")).toEqual(["machine", "ssh", "--username", "user", "m"]);
    expect(machineSsh("", "m")).toEqual(["machine", "ssh", "m"]);
  });
});
