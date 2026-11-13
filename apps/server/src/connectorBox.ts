import { finished } from "node:stream";

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { BoxAttach } from "./boxRuntime.ts";

// A local server runs in a box of its own, never a bot's: an engine beside it could read the
// server's environment from /proc.
const boxPrefix = "connector-";
export const connectorBoxId = (connectorId: string) => `${boxPrefix}${connectorId}`;
export const connectorOfBox = (boxId: string) =>
  boxId.startsWith(boxPrefix) ? boxId.slice(boxPrefix.length) : undefined;

export const maxStderrBytes = 4096;
// Never raw in JSON, which escapes every control character, so it can't end a message early.
const stderrMark = 0x1e;

// A box exec has no stderr channel. The shell keeps the last 4 KB of it and prints that on stdout
// once the server has exited, after the mark.
export const boxedArgv = (command: string, args: readonly string[]) => [
  "sh",
  "-c",
  `exec 3>&1; err=$("$@" 2>&1 1>&3 3>&- | tail -c ${maxStderrBytes}); printf '\\036%s' "$err"`,
  "sh",
  command,
  ...args,
];

// The SDK's newline-delimited JSON over a box exec's stream.
export class BoxStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  // The process ended without being asked to, with the tail of its stderr.
  onexit?: (stderr: string) => void;

  readonly #open: () => Promise<BoxAttach>;
  readonly #read = new ReadBuffer();
  #attach: BoxAttach | undefined;
  #stderr: string | undefined;
  #closing = false;
  #closed = false;

  constructor(open: () => Promise<BoxAttach>) {
    this.#open = open;
  }

  // Whatever the process printed to stderr, once it has exited.
  get stderr() {
    return this.#stderr ?? "";
  }

  async start() {
    const attach = await this.#open();
    this.#attach = attach;
    if (this.#closing) {
      attach.stream.destroy();
      return;
    }
    attach.stream.on("data", (chunk: Buffer) => this.#data(chunk));
    attach.stream.on("error", () => {});
    finished(attach.stream, { writable: false }, () => this.#end());
  }

  #data(chunk: Buffer) {
    let rest = chunk;
    if (this.#stderr === undefined) {
      const at = chunk.indexOf(stderrMark);
      this.#read.append(at < 0 ? chunk : chunk.subarray(0, at));
      this.#drain();
      if (at < 0) {
        return;
      }
      this.#stderr = "";
      rest = chunk.subarray(at + 1);
    }
    this.#stderr = (this.#stderr + rest.toString("utf8")).slice(-maxStderrBytes);
  }

  #drain() {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#read.readMessage();
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) {
        return;
      }
      this.onmessage?.(message);
    }
  }

  #end() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#attach?.stream.destroy();
    this.#read.clear();
    if (!this.#closing) {
      this.onexit?.(this.stderr);
    }
    this.onclose?.();
  }

  send(message: JSONRPCMessage) {
    const stream = this.#attach?.stream;
    if (!stream || this.#closed) {
      return Promise.reject(new Error("The server isn't running."));
    }
    return new Promise<void>((resolve, reject) => {
      stream.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close() {
    this.#closing = true;
    if (this.#attach) {
      this.#end();
    }
  }
}
