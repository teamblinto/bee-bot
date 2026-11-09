import * as NodeCrypto from "node:crypto";

import type { BoxState } from "@beebot/contracts";

// boxd speaks over its own stdin and stdout, because wsl.exe and `podman machine ssh` drop every
// other file descriptor (S3). Frames multiplex the control channel (0) with one channel per exec.
// Frame: u32 length of the rest, u32 channel, u8 kind, payload. The server numbers its channels
// from 1; boxd opens channels toward beebotd (`open`) numbered from `boxdChannels`.
export const Kind = { json: 0, data: 1, eof: 2, exit: 3, kill: 4, open: 5 } as const;
export const boxdChannels = 0x80000000;
export type Kind = (typeof Kind)[keyof typeof Kind];

const maxFrame = 16 * 1024 * 1024;

export function frame(channel: number, kind: Kind, payload: Uint8Array | string = "") {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(9);
  head.writeUInt32BE(body.length + 5, 0);
  head.writeUInt32BE(channel, 4);
  head.writeUInt8(kind, 8);
  return Buffer.concat([head, body]);
}

export function jsonFrame(message: unknown) {
  return frame(0, Kind.json, JSON.stringify(message));
}

export function frameReader(onFrame: (channel: number, kind: Kind, payload: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length < 5 || length > maxFrame) {
        throw new Error(`bad frame length ${length}`);
      }
      if (pending.length < length + 4) {
        return;
      }
      const kind = pending.readUInt8(8);
      if (!Object.values(Kind).some((known) => known === kind)) {
        throw new Error(`bad frame kind ${kind}`);
      }
      onFrame(pending.readUInt32BE(4), kind as Kind, pending.subarray(9, length + 4));
      pending = pending.subarray(length + 4);
    }
  };
}

// The first frame boxd reads. `secret` signs box tokens and ownership labels, so it must stay the
// same across restarts or boxd disowns every box it made.
export type Bootstrap = {
  secret: string;
  owner: string;
  prefix: string;
  labels: Record<string, string>;
  // Tests only: the egress proxy sends vendor API calls to these stand-ins.
  testUpstreams?: Record<string, string>;
};

// `cdp` attaches to the sidecar's DevTools, `capture` streams one small JPEG of its desktop (or,
// with `full`, a full-size PNG), `input` runs one chain of mouse and keyboard actions on it,
// `display` to its view-only VNC socket (or, with a lease,
// to that lease's input socket), `control` runs a lease's input-capable VNC server for as long as
// the attach lasts, `egress` to the proxy's control socket, `put` writes a file into the bot's
// read-only directory, and `collect` copies a download into the workspace.
export type Verb =
  | "create"
  | "start"
  | "stop"
  | "snapshot"
  | "exec"
  | "cdp"
  | "capture"
  | "display"
  | "egress"
  | "put"
  | "collect"
  | "control"
  | "input";

export type ExecRequest = {
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  channel: number;
};

export type Request = {
  id: number;
  verb: Verb;
  botId: string;
  token: string;
  exec?: ExecRequest;
  account?: string;
  channel?: number;
  mode?: "view" | "control";
  lease?: string;
  put?: { name: string; content: string };
  collect?: { file: string; name: string };
  input?: InputAction[];
  full?: boolean;
};

export const screenSize = { width: 1280, height: 800 } as const;
export const maxTypedText = 2000;

// boxd builds the xdotool argv from these itself; `key` and `type` may only end a chain.
export type InputAction =
  | { type: "move"; x: number; y: number }
  | { type: "click"; button: 1 | 2 | 3; count?: number }
  | { type: "down" | "up"; button: 1 | 2 | 3 }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right"; amount: number }
  | { type: "wait"; ms: number }
  | { type: "key"; keys: string }
  | { type: "type"; text: string };

const modifiers = new Set(["ctrl", "control", "alt", "shift", "super", "meta"]);

// One X keysym, optionally after modifiers: "Return", "ctrl+s", "ctrl+shift+Tab".
export function validKeys(keys: string) {
  if (!/^[A-Za-z0-9_+]{1,64}$/.test(keys)) {
    return false;
  }
  const parts = keys.split("+");
  return parts.every(
    (part, index) => part !== "" && (index === parts.length - 1 || modifiers.has(part)),
  );
}

export type Response =
  | { id: number; ok: true; state?: BoxState }
  | { id: number; ok: false; error: string };

export type Hello = { ready: true } | { fatal: string };

export const botIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const accountPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const botFileName = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// A takeover lease ID names a socket file, so only a lowercase UUID passes.
export const leasePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Not a bot ID, so no bot's token opens the proxy's control socket.
export const egressId = "-egress";

function hmac(secret: Uint8Array, ...parts: string[]) {
  return NodeCrypto.createHmac("sha256", secret).update(parts.join("\n")).digest("hex");
}

// Per-box: a holder of one box's token can act on that box and no other.
export function boxToken(secret: Uint8Array, botId: string) {
  return hmac(secret, "token", botId);
}

// Signs the ownership labels of one resource, so a container made by anyone else with copied
// labels is still refused.
export function labelMac(secret: Uint8Array, owner: string, botId: string, name: string) {
  return hmac(secret, "label", owner, botId, name);
}

export function sameHex(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}
