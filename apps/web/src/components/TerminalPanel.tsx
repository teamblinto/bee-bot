import "@xterm/xterm/css/xterm.css";

import type { Bot } from "@beebot/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CircleX, LoaderCircle, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { terminalSocketUrl } from "../serverConnection";
import { SidePanel } from "./SidePanel";
import { iconProps } from "./ui";

type Status = "connecting" | "open" | "closed";

// The vendor's login, run in the bot's box. What is typed here can be a secret, so it lives only
// in this view and the socket: nothing is kept once the panel closes.
function LoginScreen({ botId, onStatus }: { botId: string; onStatus: (status: Status) => void }) {
  const screen = useRef<HTMLDivElement>(null);

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
    const socket = new WebSocket(terminalSocketUrl(botId, terminal.cols, terminal.rows));
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    socket.onopen = () => {
      onStatus("open");
      terminal.focus();
    };
    socket.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(data));
      }
    };
    socket.onclose = () => onStatus("closed");
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
  }, [botId, onStatus]);

  return (
    <div
      ref={screen}
      className="min-h-80 flex-1 overflow-hidden rounded-card border border-edge-subtle bg-black p-3"
    />
  );
}

export function TerminalPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [attempt, setAttempt] = useState(0);

  const engine = bot.engineAccountId === "codex" ? "Codex" : "Claude";
  return (
    <SidePanel
      label={`Log in for ${bot.name}`}
      botName={bot.name}
      title="Log in"
      wide
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center gap-2 text-body-s font-medium">
        {status === "connecting" && (
          <>
            <LoaderCircle {...iconProps} className="animate-spin text-success-status" />
            Connecting…
          </>
        )}
        {status === "open" && (
          <>
            <SquareTerminal {...iconProps} className="text-ink-secondary" />
            Follow the {engine} login below
          </>
        )}
        {status === "closed" && (
          <>
            <CircleX {...iconProps} className="text-danger-status" />
            The login session ended.
            <button
              type="button"
              className="button button-sm button-outline"
              onClick={() => {
                setStatus("connecting");
                setAttempt(attempt + 1);
              }}
            >
              Try again
            </button>
          </>
        )}
      </div>
      <LoginScreen key={attempt} botId={bot.id} onStatus={setStatus} />
      <p className="text-caption text-ink-secondary">
        This runs the {engine} login inside the bot's box. Bee keeps nothing you type or see here.
      </p>
    </SidePanel>
  );
}
