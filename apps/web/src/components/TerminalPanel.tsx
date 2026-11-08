import "@xterm/xterm/css/xterm.css";

import type { Bot } from "@beebot/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { terminalSocketUrl } from "../serverConnection";

type Status = "connecting" | "open" | "closed";

// The vendor's login, run in the bot's box. What is typed here can be a secret, so it lives only
// in this view and the socket: nothing is kept once the panel closes.
export function TerminalPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  // Synchronizes with two outside systems: the xterm instance and the terminal socket.
  useEffect(() => {
    const element = screen.current;
    if (!element) {
      return undefined;
    }
    const terminal = new Terminal({ cursorBlink: true, scrollback: 500, fontSize: 13 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    const socket = new WebSocket(terminalSocketUrl(bot.id, terminal.cols, terminal.rows));
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    socket.onopen = () => {
      setStatus("open");
      terminal.focus();
    };
    socket.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(data));
      }
    };
    socket.onclose = () => setStatus("closed");
    const typed = terminal.onData((text) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(text));
      }
    });
    const resized = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cols, rows }));
      }
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    return () => {
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [bot.id]);

  return (
    <dialog
      ref={dialog}
      aria-label={`Log in for ${bot.name}`}
      className="dialog m-auto h-[min(560px,80dvh)] w-[min(860px,calc(100vw-32px))] flex-col gap-3 p-5 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-title font-semibold">Log in</h2>
        <span className="text-label text-ink-faint">
          {status === "connecting" ? "Connecting…" : status === "closed" ? "Ended" : bot.name}
        </span>
        <span className="flex-1" />
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <p className="text-small text-ink-secondary">
        This runs the {bot.engineAccountId === "codex" ? "Codex" : "Claude"} login inside the bot's
        box. Bee keeps nothing you type or see here.
      </p>
      <div ref={screen} className="min-h-0 flex-1 overflow-hidden rounded bg-black p-2" />
    </dialog>
  );
}
