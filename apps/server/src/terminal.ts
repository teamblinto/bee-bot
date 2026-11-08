import type { IncomingMessage } from "node:http";
import { type Duplex, PassThrough } from "node:stream";

import type { Bot } from "@beebot/contracts";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

import { type BoxOptions, credentialMapping, supportsSecureStorageDir } from "./boxEngine.ts";
import { prepareCodexHome } from "./codex.ts";

// R20: a login terminal is its own channel. What passes through it can hold a secret, so nothing
// here touches the store, the event log or the audit, and nothing is logged: bytes live only in
// the two streams it joins.

const session = "bee-login";
const maxInputBytes = 64 * 1024;

export type TerminalSize = { cols: number; rows: number };

export function parseSize(value: unknown): TerminalSize | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { cols, rows } = value as Record<string, unknown>;
  const fits = (n: unknown, max: number): n is number =>
    Number.isInteger(n) && Number(n) >= 2 && Number(n) <= max;
  return fits(cols, 500) && fits(rows, 200) ? { cols, rows } : undefined;
}

const loginCommands = {
  claude: ["claude", "auth", "login", "--claudeai"],
  // The browser can't reach a callback port inside the box, so a device code it is.
  codex: ["codex", "login", "--device-auth"],
};
export type LoginEngine = keyof typeof loginCommands;

// tmux control mode needs no terminal on the exec, which a box attach doesn't have: output comes
// back as `%output` lines and input goes in as `send-keys`.
export function attachArgs(
  engine: LoginEngine,
  { cols, rows }: TerminalSize,
  home: string,
  env: Record<string, string>,
) {
  return [
    "tmux",
    "-C",
    "new-session",
    "-s",
    session,
    "-c",
    home,
    "-x",
    String(cols),
    "-y",
    String(rows),
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...loginCommands[engine],
  ];
}

export const resizeCommand = ({ cols, rows }: TerminalSize) =>
  `refresh-client -C ${cols}x${rows}\n`;

// ASCII goes as hex, so nothing typed is ever parsed as a tmux command. Other characters go as a
// literal in single quotes, which no non-ASCII character can close.
export function keysCommand(text: string) {
  const runs = text.match(/[\x00-\x7f]+|[^\x00-\x7f]+/g) ?? [];
  return runs
    .map((run) =>
      /^[\x00-\x7f]/.test(run)
        ? `send-keys -t ${session} -H ${[...run].map((char) => char.charCodeAt(0).toString(16)).join(" ")}\n`
        : `send-keys -t ${session} -l '${run}'\n`,
    )
    .join("");
}

// Control mode writes bytes below 32 and the backslash as three octal digits, so a line is a line.
export function createControlParser(onOutput: (data: Buffer) => void) {
  let rest = "";
  return (chunk: Buffer) => {
    const lines = (rest + chunk.toString("latin1")).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const payload = /^%output %\d+ (.*)$/s.exec(line)?.[1];
      if (payload !== undefined) {
        const raw = payload.replace(/\\([0-7]{3})/g, (_, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        );
        onOutput(Buffer.from(raw, "latin1"));
      }
    }
  };
}

type Refusal = { status: number; body: { code: string } };

type Options = BoxOptions & {
  dataDir: string;
  bot: (botId: string) => Pick<Bot, "boundary" | "engineAccountId"> | undefined;
};

export function createTerminals({ runtime, layout, dataDir, bot }: Options) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxInputBytes });
  const live = new Set<() => void>();

  const run = async (botId: string, argv: string[]) => {
    const { stream, exited } = await runtime.execAttach(botId, { argv, env: layout.env });
    stream.resume();
    stream.end();
    return exited;
  };

  async function loginEnv(botId: string, engine: LoginEngine, accountId: string) {
    if (engine === "codex") {
      const codexHome = `${layout.home}/.codex`;
      const mapping = credentialMapping({
        engine,
        accountId,
        dataDir,
        layout,
        secureStorageDir: false,
      });
      const link = mapping.kind === "shared" ? mapping.link : undefined;
      if ((await run(botId, prepareCodexHome(codexHome, link))) !== 0) {
        throw new Error("could not prepare CODEX_HOME");
      }
      return { CODEX_HOME: codexHome };
    }
    const found = await supportsSecureStorageDir(runtime, botId, layout.claudeBinary, layout.env);
    const mapping = credentialMapping({
      engine,
      accountId,
      dataDir,
      layout,
      secureStorageDir: found,
    });
    return mapping.kind === "shared" ? mapping.env : {};
  }

  function serve(
    client: WebSocket,
    botId: string,
    engine: LoginEngine,
    accountId: string,
    size: TerminalSize,
  ) {
    const input = new PassThrough();
    let stream: Duplex | undefined;
    let ended = false;

    function end() {
      if (ended) {
        return;
      }
      ended = true;
      live.delete(end);
      input.destroy();
      stream?.destroy();
      client.close(1000);
      // Nothing of the login may linger in tmux's scrollback either.
      void run(botId, ["tmux", "kill-session", "-t", session]).catch(() => {});
    }
    live.add(end);

    client.on("message", (data: RawData, isBinary) => {
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : data;
      if (isBinary) {
        input.write(keysCommand(bytes.toString("utf8")));
        return;
      }
      let resize: TerminalSize | undefined;
      try {
        resize = parseSize(JSON.parse(bytes.toString("utf8")));
      } catch {
        resize = undefined;
      }
      if (resize) {
        input.write(resizeCommand(resize));
      }
    });
    client.on("close", end);
    client.on("error", end);

    void (async () => {
      const env = await loginEnv(botId, engine, accountId);
      await run(botId, ["tmux", "kill-session", "-t", session]);
      const attach = await runtime.execAttach(botId, {
        argv: attachArgs(engine, size, layout.home, env),
        env: layout.env,
        cwd: layout.home,
      });
      if (ended) {
        attach.stream.destroy();
        return;
      }
      stream = attach.stream;
      stream.write(resizeCommand(size));
      input.pipe(stream);
      const parse = createControlParser((output) => client.send(output, { binary: true }));
      stream.on("data", parse);
      stream.on("error", end);
      stream.on("close", end);
    })().catch(() => {
      if (!ended) {
        client.close(1011, "box unavailable");
        end();
      }
    });
  }

  return {
    // Called once the token and origin have passed.
    upgrade: (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      url: URL,
    ): Refusal | undefined => {
      const botId = url.searchParams.get("botId") ?? "";
      const found = bot(botId);
      const engine = found?.engineAccountId;
      if (found?.boundary !== "box" || (engine !== "claude" && engine !== "codex")) {
        return { status: 404, body: { code: "not_found" } };
      }
      const size = parseSize({
        cols: Number(url.searchParams.get("cols")),
        rows: Number(url.searchParams.get("rows")),
      });
      if (!size) {
        return { status: 400, body: { code: "bad_request" } };
      }
      sockets.handleUpgrade(request, socket, head, (client) =>
        serve(client, botId, engine, found.engineAccountId, size),
      );
      return undefined;
    },
    close: () => {
      for (const end of live) {
        end();
      }
    },
  };
}
export type Terminals = ReturnType<typeof createTerminals>;
