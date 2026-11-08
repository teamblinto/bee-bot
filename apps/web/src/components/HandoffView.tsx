import {
  type Bot,
  type HandoffClientMessage,
  type HandoffReason,
  HandoffServerMessage,
} from "@beebot/contracts";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";

import { socketUrl } from "../serverConnection";
import { keyInput, mouseInput } from "./HandoffMapping";

type Lease = Extract<HandoffServerMessage, { type: "lease" }>;
type Frame = Omit<Extract<HandoffServerMessage, { type: "frame" }>, "type">;

const requestLines: Record<HandoffReason, (note: string) => string> = {
  login: (note) => `${note} wants a sign-in.`,
  captcha: (note) => `${note} wants a person to solve a challenge.`,
  hand_off: (note) => `This step is yours to do: ${note}.`,
};

function parse(data: unknown) {
  try {
    return HandoffServerMessage.safeParse(JSON.parse(String(data))).data;
  } catch {
    return undefined;
  }
}

export function HandoffView({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const socket = useRef<WebSocket>(null);
  const pressed = useRef(false);
  const [lease, setLease] = useState<Lease>();
  const [frame, setFrame] = useState<Frame>();
  const [unavailable, setUnavailable] = useState(false);
  const [privateText, setPrivateText] = useState("");

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  useEffect(() => {
    const url = socketUrl("/browser");
    url.searchParams.set("botId", bot.id);
    const opened = new WebSocket(url);
    socket.current = opened;
    opened.onmessage = ({ data }) => {
      const message = parse(data);
      if (message?.type === "lease") {
        setLease(message);
      } else if (message?.type === "frame") {
        setFrame(message);
      } else if (message?.type === "unavailable") {
        setUnavailable(true);
      }
    };
    opened.onclose = () => setLease(undefined);
    return () => opened.close();
  }, [bot.id]);

  const mine = lease?.mine === true;

  function send(message: HandoffClientMessage) {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(message));
    }
  }

  function sendMouse(
    action: "down" | "up" | "move" | "wheel",
    event: PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>,
  ) {
    if (!mine || !frame) {
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    send({ type: "input", input: mouseInput(action, event, box, frame) });
  }

  function sendKey(action: "down" | "up", event: KeyboardEvent<HTMLImageElement>) {
    const input = mine && keyInput(action, event);
    if (input) {
      event.preventDefault();
      send({ type: "input", input });
    }
  }

  function typePrivately(event: FormEvent) {
    event.preventDefault();
    if (privateText) {
      send({ type: "text", text: privateText });
      setPrivateText("");
    }
  }

  const status = unavailable
    ? `${bot.name} has no browser running.`
    : !lease
      ? "Connecting…"
      : mine
        ? `You have control. ${bot.name} waits until you give it back.`
        : lease.holder === "human"
          ? "Someone else has control in another window."
          : `${bot.name} has control. Take it to click and type.`;

  return (
    <dialog
      ref={dialog}
      aria-label={`${bot.name} browser`}
      className="dialog m-auto max-h-[90dvh] w-[min(960px,calc(100vw-32px))] flex-col gap-3 p-5 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold">Browser</h2>
        <div className="flex gap-2">
          {lease && !unavailable && (
            <button
              type="button"
              className={mine ? "button button-primary" : "button"}
              disabled={lease.holder === "human" && !mine}
              onClick={() => send({ type: mine ? "give" : "take" })}
            >
              {mine ? `Give back to ${bot.name}` : "Take control"}
            </button>
          )}
          <button type="button" className="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </div>
      {lease?.requested && (
        <p className="rounded-md border border-honey/40 px-3 py-2 text-small">
          {requestLines[lease.requested](lease.note ?? "A site")}
        </p>
      )}
      <p className="text-small text-ink-secondary">{status}</p>
      <div className="scroller min-h-0 overflow-auto">
        {frame?.data ? (
          <img
            alt={`${bot.name}'s browser`}
            src={`data:image/jpeg;base64,${frame.data}`}
            tabIndex={mine ? 0 : -1}
            draggable={false}
            className={`w-full rounded-md border border-edge outline-none ${mine ? "cursor-default focus:border-honey" : "opacity-90"}`}
            onPointerDown={(event) => {
              pressed.current = true;
              event.currentTarget.focus();
              sendMouse("down", event);
            }}
            onPointerUp={(event) => {
              pressed.current = false;
              sendMouse("up", event);
            }}
            onPointerMove={(event) => pressed.current && sendMouse("move", event)}
            onWheel={(event) => sendMouse("wheel", event)}
            onKeyDown={(event) => sendKey("down", event)}
            onKeyUp={(event) => sendKey("up", event)}
            onContextMenu={(event) => event.preventDefault()}
          />
        ) : (
          !unavailable && <p className="text-small text-ink-faint">Waiting for the page…</p>
        )}
      </div>
      {mine && (
        <form className="flex items-center gap-2" onSubmit={typePrivately}>
          <input
            type="password"
            autoComplete="off"
            aria-label="Private text"
            placeholder="Click a field in the page, then type here"
            className="field min-w-0 flex-1 text-ink"
            value={privateText}
            onChange={(event) => setPrivateText(event.target.value)}
          />
          <button type="submit" className="button" disabled={!privateText}>
            Type into page
          </button>
        </form>
      )}
      <p className="text-label text-ink-faint">
        What you type here never reaches {bot.name}, its logs or the audit log. The page itself may
        still show your account to {bot.name} later. Native dialogs and the browser's own menus
        don't appear in this view.
      </p>
    </dialog>
  );
}
