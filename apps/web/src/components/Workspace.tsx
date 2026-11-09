import RFB from "@novnc/novnc";
import {
  type Bot,
  type BoxAvailability,
  browserGrant,
  DisplayTicket,
  type HandoffClientMessage,
  type HandoffReason,
  HandoffServerMessage,
  type Run,
} from "@beebot/contracts";
import { ArrowLeft, ArrowRight, Globe, Monitor, RotateCw, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";

import {
  type BotActivity,
  displaySocketUrl,
  hasComputer,
  isActive,
  type LiveTool,
  postCommand,
  socketUrl,
} from "../serverConnection";
import { ActivityOverlay } from "./ActivityOverlay";
import { keyInput, mouseInput } from "./HandoffMapping";
import { iconProps } from "./ui";

export type WorkspaceTab = "computer" | "browser";

const tabs = [
  { id: "computer", label: "Computer", Icon: Monitor },
  { id: "browser", label: "Browser", Icon: Globe },
] as const;

export const minWidth = 360;
export const maxWidth = 960;
const widthStep = 40;
const widthKey = "beebot.workspaceWidth";
const tabKey = (botId: string) => `beebot.workspaceTab.${botId}`;

// Storage can be blocked, and the panel works without it.
function load(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const clampWidth = (width: number) => Math.min(maxWidth, Math.max(minWidth, width));

function loadWidth() {
  const stored = Number(load(widthKey));
  return stored ? clampWidth(stored) : 480;
}

// Bee's tools reach the engine as `mcp__bee__computer_click` and the like.
export function screenTab(toolName: string): WorkspaceTab | undefined {
  const tool = toolName.split("__").at(-1) ?? "";
  return tool.startsWith("computer_")
    ? "computer"
    : tool.startsWith("browser_")
      ? "browser"
      : undefined;
}

// Opens on the bot's own use of its screen, unless the owner closed the panel during this run.
export function useWorkspace(
  bot: Bot,
  run: Run | undefined,
  tools: LiveTool[],
  activity: BotActivity | undefined,
  openOnComputer: boolean,
) {
  const [open, setOpen] = useState(openOnComputer);
  const [tab, setTab] = useState<WorkspaceTab>(() =>
    openOnComputer || load(tabKey(bot.id)) !== "browser" ? "computer" : "browser",
  );
  const [closedIn, setClosedIn] = useState<{ runId: string | undefined }>();
  const takeover = bot.pauseReason === "browser_session";
  const used = isActive(run)
    ? tools.flatMap((tool) => {
        const toolTab = screenTab(tool.name);
        return toolTab ? [{ ...tool, tab: toolTab }] : [];
      })
    : [];
  const latest = used.at(-1);
  const liveTab = takeover ? "computer" : used.findLast(({ status }) => status === "running")?.tab;
  const cue = takeover
    ? { key: "takeover", tab: "computer" as const }
    : latest
      ? { key: latest.id, tab: latest.tab }
      : activity && { key: `activity ${activity.seq}`, tab: "computer" as const };
  const [seenCue, setSeenCue] = useState(cue?.key);

  if (cue?.key !== seenCue) {
    setSeenCue(cue?.key);
    if (cue && !open && !(closedIn && closedIn.runId === run?.id)) {
      setOpen(true);
      setTab(cue.tab);
    }
  }

  return {
    open,
    tab,
    liveTab,
    choose(next: WorkspaceTab) {
      setTab(next);
      save(tabKey(bot.id), next);
    },
    show(next?: WorkspaceTab) {
      setOpen(true);
      if (next) {
        setTab(next);
      }
    },
    close() {
      setOpen(false);
      setClosedIn({ runId: run?.id });
    },
  };
}

export function Workspace({
  bot,
  boxes,
  activity,
  tab,
  liveTab,
  onTab,
  onClose,
  onEdit,
}: {
  bot: Bot;
  boxes: BoxAvailability | undefined;
  activity: BotActivity | undefined;
  tab: WorkspaceTab;
  liveTab: WorkspaceTab | undefined;
  onTab: (tab: WorkspaceTab) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  const drag = useRef<{ x: number; width: number }>(null);
  const wantsScreen = bot.boundary === "box" || bot.manifest.includes(browserGrant);

  function endDrag() {
    if (drag.current) {
      drag.current = null;
      save(widthKey, String(width));
    }
  }

  return (
    <aside
      aria-label={`${bot.name}'s computer`}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-edge bg-sidebar max-md:absolute max-md:inset-0 max-md:z-30 max-md:!w-full"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-honey-surface focus-visible:bg-honey-surface max-md:hidden"
        onKeyDown={(event) => {
          const delta =
            event.key === "ArrowLeft" ? widthStep : event.key === "ArrowRight" ? -widthStep : 0;
          if (delta) {
            event.preventDefault();
            const next = clampWidth(width + delta);
            setWidth(next);
            save(widthKey, String(next));
          }
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (from) {
            setWidth(clampWidth(from.width + from.x - event.clientX));
          }
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-3">
        <div
          role="tablist"
          aria-label="Views"
          className="flex gap-0.5 rounded-full bg-raised p-0.5"
        >
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === tab}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-small transition-colors ${id === tab ? "bg-background text-ink shadow-composer" : "text-ink-secondary hover:text-ink"}`}
              onClick={() => onTab(id)}
            >
              <Icon {...iconProps} size={14} />
              {label}
              {id === liveTab && (
                <span
                  role="img"
                  aria-label="In use"
                  className="size-1.5 animate-pulse rounded-full bg-honey-fill"
                />
              )}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close computer"
          className="button !px-2"
          onClick={onClose}
        >
          <X {...iconProps} />
        </button>
      </header>
      {hasComputer(bot, boxes) ? (
        <Screen bot={bot} tab={tab} activity={activity} />
      ) : wantsScreen ? (
        <SetUp boxes={boxes} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-small text-ink-secondary">
            {bot.name} has no computer or browser. Turn on Computer and browser in its settings.
          </p>
          <button type="button" className="button button-outline" onClick={onEdit}>
            Edit {bot.name}
          </button>
        </div>
      )}
    </aside>
  );
}

// Bots' computers run in boxes, so the first one is set up from here rather than from Usage.
function SetUp({ boxes }: { boxes: BoxAvailability | undefined }) {
  const [error, setError] = useState<string>();
  const settingUp = boxes?.settingUp === true;

  async function setUp() {
    setError(undefined);
    const result = await postCommand({ type: "set-up-boxes" });
    if (!result.ok) {
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-small text-ink-secondary">
        {!boxes
          ? "This server can't run computers for bots."
          : settingUp
            ? (boxes.problem ?? "Setting up computers…")
            : `Computers for your bots aren't set up yet. ${boxes.problem ?? ""}`}
      </p>
      {boxes && (
        <button
          type="button"
          className="button button-primary"
          disabled={settingUp}
          onClick={() => void setUp()}
        >
          {settingUp ? "Setting up…" : "Set up computers"}
        </button>
      )}
      {error && <p className="text-small text-danger">{error}</p>}
    </div>
  );
}

type Lease = Extract<HandoffServerMessage, { type: "lease" }>;
type Frame = Extract<HandoffServerMessage, { type: "frame" }>;
type Page = Extract<HandoffServerMessage, { type: "page" }>;

const requestLines: Record<HandoffReason, (note: string) => string> = {
  login: (note) => `${note} wants a sign-in.`,
  captcha: (note) => `${note} wants a person to solve a challenge.`,
  hand_off: (note) => `This step is yours to do: ${note}.`,
  takeover: (note) => `Asked you to take over: ${note}.`,
};

function parse(data: unknown) {
  try {
    return HandoffServerMessage.safeParse(JSON.parse(String(data))).data;
  } catch {
    return undefined;
  }
}

const withScheme = (address: string) =>
  /^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`;

// Both tabs share the one handoff socket, so the lease is the same whichever is shown.
function Screen({
  bot,
  tab,
  activity,
}: {
  bot: Bot;
  tab: WorkspaceTab;
  activity: BotActivity | undefined;
}) {
  const socket = useRef<WebSocket>(null);
  const screen = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const [lease, setLease] = useState<Lease>();
  const [frame, setFrame] = useState<Frame>();
  const [page, setPage] = useState<Page>();
  const [unavailable, setUnavailable] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [privateText, setPrivateText] = useState("");
  const [address, setAddress] = useState<string>();

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
      } else if (message?.type === "page") {
        setPage(message);
      } else if (message?.type === "unavailable") {
        setUnavailable(true);
      }
    };
    opened.onclose = () => setLease(undefined);
    return () => opened.close();
  }, [bot.id]);

  const mine = lease?.mine === true;
  const controlLease = mine ? (lease?.leaseId ?? null) : null;

  // The whole desktop when the box has one, else the screencast stays the view. Holding the lease
  // swaps the view-only stream for the lease's input server, and giving it back swaps it again.
  useEffect(() => {
    const ended = new AbortController();
    const opening = postCommand(
      controlLease === null
        ? { type: "display-ticket", botId: bot.id, mode: "view" }
        : { type: "display-ticket", botId: bot.id, mode: "control", leaseId: controlLease },
    ).then((result) => {
      const ticket = result.ok ? DisplayTicket.safeParse(result.body).data : undefined;
      if (!ticket || !screen.current || ended.signal.aborted) {
        return undefined;
      }
      const rfb = new RFB(screen.current, displaySocketUrl(ticket.ticket).href);
      rfb.viewOnly = controlLease === null;
      rfb.scaleViewport = true;
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;
      rfb.addEventListener("connect", () => ended.signal.aborted || setDesktop(true));
      rfb.addEventListener("disconnect", () => ended.signal.aborted || setDesktop(false));
      return rfb;
    });
    return () => {
      ended.abort();
      setDesktop(false);
      void opening.then((rfb) => rfb?.disconnect());
    };
  }, [bot.id, controlLease]);

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

  function navigate(event: FormEvent) {
    event.preventDefault();
    const typed = address?.trim();
    if (mine && typed) {
      send({ type: "navigate", url: withScheme(typed) });
      setAddress(undefined);
    }
  }

  const showDesktop = desktop && tab === "computer";
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
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
        <p className="min-w-0 flex-1 text-small text-ink-secondary">{status}</p>
        {lease && !unavailable && (
          <button
            type="button"
            className={mine ? "button button-primary" : "button button-outline"}
            disabled={lease.holder === "human" && !mine}
            onClick={() => send({ type: mine ? "give" : "take" })}
          >
            {mine ? `Give back to ${bot.name}` : "Take control"}
          </button>
        )}
      </div>
      {lease?.requested && (
        <p className="mx-3 mt-3 rounded-md border border-honey/40 px-3 py-2 text-small">
          {requestLines[lease.requested](lease.note ?? "A site")}
        </p>
      )}
      {tab === "browser" && (
        <form
          className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5"
          onSubmit={navigate}
        >
          <button
            type="button"
            aria-label="Back"
            className="button !px-2"
            disabled={!mine || !page?.canGoBack}
            onClick={() => send({ type: "history", direction: "back" })}
          >
            <ArrowLeft {...iconProps} />
          </button>
          <button
            type="button"
            aria-label="Forward"
            className="button !px-2"
            disabled={!mine || !page?.canGoForward}
            onClick={() => send({ type: "history", direction: "forward" })}
          >
            <ArrowRight {...iconProps} />
          </button>
          <button
            type="button"
            aria-label="Reload"
            className="button !px-2"
            disabled={!mine || !page}
            onClick={() => send({ type: "reload" })}
          >
            <RotateCw {...iconProps} />
          </button>
          <input
            aria-label="Address"
            title={page?.title || undefined}
            className="field min-w-0 flex-1 !py-1 !text-small text-ink"
            readOnly={!mine}
            spellCheck={false}
            placeholder={mine ? "Type an address" : undefined}
            value={address ?? page?.url ?? ""}
            onChange={(event) => setAddress(event.target.value)}
            onBlur={() => setAddress(undefined)}
          />
        </form>
      )}
      <div className="scroller min-h-0 flex-1 overflow-auto px-2 py-3">
        <div className="relative">
          {tab === "computer" && <ActivityOverlay activity={activity} />}
          <div
            ref={screen}
            role="img"
            aria-label={`${bot.name}'s desktop`}
            className={`aspect-[16/10] w-full overflow-hidden rounded-md border border-edge ${showDesktop ? "" : "hidden"}`}
          />
          {showDesktop || unavailable ? null : frame?.data ? (
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
            <p className="text-small text-ink-faint">Waiting for the page…</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-edge px-3 py-3">
        {mine && showDesktop && (
          <p className="text-small text-ink-secondary">
            Type passwords in the private field below, not on the desktop.
          </p>
        )}
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
          What you type in the private field never reaches {bot.name}, its logs or the audit log.
          What you type on the desktop goes to the page as you type it, and {bot.name} may read it
          there later. The page itself may still show your account to {bot.name} later.
          {!showDesktop && " Native dialogs and the browser's own menus don't appear in this view."}
        </p>
      </div>
    </>
  );
}
