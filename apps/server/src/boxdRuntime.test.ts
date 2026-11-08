import { createFakePodman, serveInProcess } from "@beebot/boxd/testing";
import { describe, expect, it } from "vite-plus/test";

import { connectBoxd, podmanEnv } from "./boxdRuntime.ts";

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
    const transport = serveInProcess(fake.podman);
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
    const linux = { PATH: "/usr/bin" };
    expect(podmanEnv(linux, "linux")).toBe(linux);
  });
});
