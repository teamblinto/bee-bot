import RFB from "@novnc/novnc";
import {
  type Bot,
  type BotControl,
  type BoxAvailability,
  DisplayTicket,
  type HandoffClientMessage,
  type HandoffReason,
  HandoffServerMessage,
  HostFrame,
  type HostControlAvailability,
  type Run,
} from "@beebot/contracts";
import { ArrowLeft, ArrowRight, Globe, Hand, Maximize2, Monitor, RotateCw, X } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
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
  hasBoxScreen,
  isActive,
  type LiveTool,
  postCommand,
  socketUrl,
} from "../serverConnection";
import { ActivityOverlay } from "./ActivityOverlay";
import { controlOptions, controlOrder } from "./controlOptions";
import { SetupProgress } from "./SetupProgress";
import { keyInput, mouseInput } from "./HandoffMapping";
import { iconProps } from "./ui";

export type WorkspaceTab = "computer" | "browser" | "host";

const tabInfo = {
  computer: { label: "Screen", Icon: Monitor },
  browser: { label: "Browser", Icon: Globe },
  host: { label: "Screen", Icon: Monitor },
} as const;

// Every bot has a Screen tab, where the owner picks where it works.
const controlTabs: Record<BotControl, WorkspaceTab[]> = {
  browser: ["computer", "browser"],
  computer: ["computer", "browser"],
  host: ["host"],
  none: ["computer"],
};

// Where the bot's own use of its screen shows, and where the panel opens by default.
const mainTab: Record<BotControl, WorkspaceTab> = {
  browser: "browser",
  computer: "computer",
  host: "host",
  none: "computer",
};

const hostPollMs = { working: 1000, idle: 5000 };

// The tab the bot actually has for `wanted`. A host bot's computer is the owner's own screen.
function tabFor(control: BotControl, wanted: string | null | undefined): WorkspaceTab {
  return controlTabs[control].find((tab) => tab === wanted) ?? mainTab[control];
}

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

// Below lg the panel covers the chat, so it waits to be asked (the header's Watch).
const roomBeside = () =>
  typeof matchMedia !== "function" || matchMedia("(min-width: 1024px)").matches;

// Bee's tools reach the engine as `mcp__bee__computer_click` and the like.
export function screenTab(toolName: string, control: BotControl): WorkspaceTab | undefined {
  const tool = toolName.split("__").at(-1) ?? "";
  const tab = tool.startsWith("computer_")
    ? "computer"
    : tool.startsWith("browser_")
      ? "browser"
      : undefined;
  return tab && tabFor(control, tab);
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
  const [chosen, setChosen] = useState<string | null>(() =>
    openOnComputer ? "computer" : load(tabKey(bot.id)),
  );
  // Derived, so a change of the bot's control mode never leaves a tab it no longer has.
  const tab = tabFor(bot.control, chosen);
  const screen = mainTab[bot.control];
  const [closedIn, setClosedIn] = useState<{ runId: string | undefined }>();
  const takeover = bot.pauseReason === "browser_session";
  const used = isActive(run)
    ? tools.flatMap((tool) => {
        const toolTab = screenTab(tool.name, bot.control);
        return toolTab ? [{ ...tool, tab: toolTab }] : [];
      })
    : [];
  const latest = used.at(-1);
  const liveTab = takeover ? screen : used.findLast(({ status }) => status === "running")?.tab;
  const cue = takeover
    ? { key: "takeover", tab: screen }
    : latest
      ? { key: latest.id, tab: latest.tab }
      : activity && { key: `activity ${activity.seq}`, tab: screen };
  const [seenCue, setSeenCue] = useState(cue?.key);

  if (cue?.key !== seenCue) {
    setSeenCue(cue?.key);
    if (cue && !open && !(closedIn && closedIn.runId === run?.id) && roomBeside()) {
      setOpen(true);
      setChosen(cue.tab);
    }
  }

  return {
    open,
    tab,
    liveTab,
    choose(next: WorkspaceTab) {
      setChosen(next);
      save(tabKey(bot.id), next);
    },
    show(next?: WorkspaceTab) {
      setOpen(true);
      if (next) {
        setChosen(next);
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
  hostControl,
  working,
  activity,
  tab,
  liveTab,
  onTab,
  onClose,
  onEdit,
}: {
  bot: Bot;
  boxes: BoxAvailability | undefined;
  hostControl: HostControlAvailability | undefined;
  working: boolean;
  activity: BotActivity | undefined;
  tab: WorkspaceTab;
  liveTab: WorkspaceTab | undefined;
  onTab: (tab: WorkspaceTab) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  const drag = useRef<{ x: number; width: number }>(null);

  function endDrag() {
    if (drag.current) {
      drag.current = null;
      save(widthKey, String(width));
    }
  }

  const place = <WhereWorks bot={bot} hostControl={hostControl} onEdit={onEdit} />;

  return (
    <aside
      aria-label={`${bot.name}'s computer`}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-edge bg-sidebar max-lg:absolute max-lg:inset-0 max-lg:z-30 max-lg:!w-full lg:max-w-[calc(100%-22rem)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-honey-surface focus-visible:bg-honey-surface max-lg:hidden"
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
          {controlTabs[bot.control].map((id) => {
            const { label, Icon } = tabInfo[id];
            return (
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
            );
          })}
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
      {bot.control === "host" ? (
        <HostScreen
          bot={bot}
          hostControl={hostControl}
          working={working}
          activity={activity}
          place={place}
        />
      ) : tab === "computer" && bot.control !== "computer" ? (
        <div className="scroller min-h-0 flex-1 overflow-auto px-4 py-3">
          <ScreenHeader bot={bot} inControl={false} />
          <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 rounded-xl bg-raised p-6 text-center">
            <p className="text-small text-ink-secondary">
              {bot.control === "browser"
                ? `${bot.name} works in a browser of its own, with no desktop.`
                : `${bot.name} has no screen.`}
            </p>
            {bot.control === "browser" && (
              <button
                type="button"
                className="button button-outline"
                onClick={() => onTab("browser")}
              >
                <Globe {...iconProps} size={14} />
                Watch its browser
              </button>
            )}
          </div>
          {place}
        </div>
      ) : hasBoxScreen(bot, boxes) ? (
        <Screen bot={bot} tab={tab} activity={activity} place={place} />
      ) : (
        <div className="scroller min-h-0 flex-1 overflow-auto px-4 py-3">
          <SetUp boxes={boxes} />
          {tab === "computer" && place}
        </div>
      )}
    </aside>
  );
}

// "Ada's screen", and what that screen is, or that the owner is driving it.
function ScreenHeader({ bot, inControl }: { bot: Bot; inControl: boolean }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 text-small text-ink-secondary">
      <span className="truncate">{bot.name}'s screen</span>
      {inControl ? (
        <span className="flex shrink-0 items-center gap-1.5 text-label font-medium text-ink">
          <span className="size-1.5 rounded-full bg-honey-fill" />
          You're in control
        </span>
      ) : (
        <span className="shrink-0 text-label">{controlOptions[bot.control].name}</span>
      )}
    </div>
  );
}

// The owner's own control banner: while it shows, the bot's input is refused.
function InControl({ line, onGive }: { line: string; onGive: () => void }) {
  return (
    <div className="mt-3 rounded-xl border border-honey/40 bg-honey-surface p-4">
      <p className="text-small text-ink">{line}</p>
      <button type="button" className="button button-primary mt-2 w-full" onClick={onGive}>
        <Hand {...iconProps} size={14} />
        Hand control back
      </button>
    </div>
  );
}

// The mode is the bot's own setting, so changing it here is the same as in its settings. Moving
// onto the owner's computer needs their consent, which only the settings ask for.
function WhereWorks({
  bot,
  hostControl,
  onEdit,
}: {
  bot: Bot;
  hostControl: HostControlAvailability | undefined;
  onEdit: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(control: BotControl) {
    if (control === bot.control || pending) {
      return;
    }
    if (control === "host") {
      onEdit();
      return;
    }
    setPending(true);
    setError(undefined);
    const result = await postCommand({ type: "set-bot-control", botId: bot.id, control });
    setPending(false);
    setError(result.ok ? undefined : result.message);
  }

  return (
    <section aria-label={`Where ${bot.name} works`} className="mt-4 rounded-xl bg-raised p-4">
      <h2 className="text-name font-medium text-ink">Where {bot.name} works</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {controlOrder.map((control) => {
          const { name, Icon } = controlOptions[control];
          const selected = control === bot.control;
          const unavailable = control === "host" && !selected && hostControl?.available !== true;
          return (
            <button
              key={control}
              type="button"
              aria-pressed={selected}
              disabled={unavailable || pending}
              title={
                unavailable ? (hostControl?.problem ?? undefined) : controlOptions[control].help
              }
              className={`flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1.5 py-2.5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-honey bg-honey-surface text-ink" : "border-edge text-ink-secondary enabled:hover:border-honey/60 enabled:hover:bg-hover"}`}
              onClick={() => void choose(control)}
            >
              <Icon {...iconProps} size={16} className={selected ? "text-honey" : undefined} />
              <span className="w-full truncate text-label font-medium">{name}</span>
              {unavailable && <span className="w-full truncate text-micro">Unavailable</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-small text-ink-secondary">{controlOptions[bot.control].line}</p>
      {error && <p className="mt-2 text-small text-danger">{error}</p>}
    </section>
  );
}

// Bots' computers run in boxes, so the first one is set up from here rather than from Usage.
function SetUp({ boxes }: { boxes: BoxAvailability | undefined }) {
  const [error, setError] = useState<string>();

  async function setUp() {
    setError(undefined);
    const result = await postCommand({ type: "set-up-boxes" });
    if (!result.ok) {
      setError(result.message);
    }
  }

  if (boxes?.settingUp) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <p className="text-name font-medium">Setting up computers</p>
        {boxes.progress && <SetupProgress progress={boxes.progress} />}
        <p className="text-label text-ink-faint">
          This happens once and can take several minutes. You can keep chatting meanwhile.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-small text-ink-secondary">
        {!boxes
          ? "This server can't run computers for bots."
          : (boxes.problem ?? "Computers for your bots aren't set up yet.")}
      </p>
      {boxes && (
        <button type="button" className="button button-primary" onClick={() => void setUp()}>
          Set up computers
        </button>
      )}
      {error && <p className="text-small text-danger">{error}</p>}
    </div>
  );
}

// The owner's own display, polled while it's shown: often while the bot works, rarely otherwise.
function HostScreen({
  bot,
  hostControl,
  working,
  activity,
  place,
}: {
  bot: Bot;
  hostControl: HostControlAvailability | undefined;
  working: boolean;
  activity: BotActivity | undefined;
  place: ReactNode;
}) {
  const [frame, setFrame] = useState<HostFrame>();
  const [frameError, setFrameError] = useState<string>();
  const [holdError, setHoldError] = useState<string>();
  const available = hostControl?.available === true;
  const held = hostControl?.held === true;

  useEffect(() => {
    if (!available) {
      return undefined;
    }
    const ended = new AbortController();
    async function poll() {
      if (document.hidden) {
        return;
      }
      const result = await postCommand({ type: "host-frame" });
      if (ended.signal.aborted) {
        return;
      }
      const next = result.ok ? HostFrame.safeParse(result.body).data : undefined;
      if (next) {
        setFrame(next);
      }
      setFrameError(result.ok ? undefined : result.message);
    }
    void poll();
    const timer = setInterval(() => void poll(), working ? hostPollMs.working : hostPollMs.idle);
    return () => {
      ended.abort();
      clearInterval(timer);
    };
  }, [available, working]);

  async function hold() {
    const result = await postCommand({ type: "host-hold", held: !held });
    setHoldError(result.ok ? undefined : result.message);
  }

  return (
    <div className="scroller min-h-0 flex-1 overflow-auto px-4 py-3">
      <ScreenHeader bot={bot} inControl={held} />
      {!available ? (
        <p className="rounded-xl bg-raised p-6 text-center text-small text-ink-secondary">
          {hostControl?.problem ?? "Bots can't use this computer from here."}
        </p>
      ) : (
        <>
          <div
            className={`relative overflow-hidden rounded-xl bg-raised ${held ? "ring-2 ring-honey" : ""}`}
          >
            <ActivityOverlay activity={activity} />
            {frame ? (
              <img
                alt="Your screen"
                src={`data:image/jpeg;base64,${frame.data}`}
                draggable={false}
                className="block w-full"
              />
            ) : (
              <p className="flex aspect-[16/10] items-center justify-center text-small text-ink-faint">
                Waiting for your screen…
              </p>
            )}
          </div>
          {held ? (
            <InControl
              line="You have your computer. Bots' clicks and keystrokes are refused until you hand it back."
              onGive={() => void hold()}
            />
          ) : (
            <>
              <button
                type="button"
                className="button button-primary mt-3 w-full"
                title="Stop bots from using your computer until you hand it back"
                onClick={() => void hold()}
              >
                <Hand {...iconProps} size={14} />
                Take control
              </button>
              <p className="mt-2 text-small text-ink-secondary">
                {bot.name} can use your screen while you watch. Moving your mouse stops it.
              </p>
            </>
          )}
          {(holdError ?? frameError) && (
            <p className="mt-2 text-small text-danger">{holdError ?? frameError}</p>
          )}
        </>
      )}
      {place}
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

// Both tabs share the one handoff socket, so the lease is the same whichever is shown. The desktop
// view stays mounted on either tab, so its connection follows the lease and not the tab.
function Screen({
  bot,
  tab,
  activity,
  place,
}: {
  bot: Bot;
  tab: WorkspaceTab;
  activity: BotActivity | undefined;
  place: ReactNode;
}) {
  const socket = useRef<WebSocket>(null);
  const frameBox = useRef<HTMLDivElement>(null);
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
  const hasDesktop = bot.control === "computer";
  useEffect(() => {
    if (!hasDesktop) {
      return undefined;
    }
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
  }, [bot.id, controlLease, hasDesktop]);

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

  const canTake = lease !== undefined && !unavailable && lease.holder !== "human";
  const take = () => send({ type: "take" });
  const give = () => send({ type: "give" });
  const onDesktop = tab === "computer";
  const status = unavailable
    ? `${bot.name} has no browser running.`
    : !lease
      ? "Connecting…"
      : mine
        ? `You have control. ${bot.name} waits until you give it back.`
        : lease.holder === "human"
          ? "Someone else has control in another window."
          : `${bot.name} has control. Take it to click and type.`;
  const request = lease?.requested && (
    <p className="mt-3 rounded-md border border-honey/40 px-3 py-2 text-small">
      {requestLines[lease.requested](lease.note ?? "A site")}
    </p>
  );

  return (
    <>
      {!onDesktop && (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
            <p className="min-w-0 flex-1 text-small text-ink-secondary">{status}</p>
            {lease && !unavailable && (
              <button
                type="button"
                className={mine ? "button button-primary" : "button button-outline"}
                disabled={!mine && !canTake}
                onClick={mine ? give : take}
              >
                {mine ? `Give back to ${bot.name}` : "Take control"}
              </button>
            )}
          </div>
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
        </>
      )}
      <div
        className={`scroller min-h-0 flex-1 overflow-auto ${onDesktop ? "px-4 py-3" : "px-2 py-3"}`}
      >
        {onDesktop && <ScreenHeader bot={bot} inControl={mine} />}
        {!onDesktop && request}
        <div
          ref={frameBox}
          className={`relative aspect-[16/10] w-full overflow-hidden rounded-xl bg-raised ${mine ? "ring-2 ring-honey" : ""} ${onDesktop && hasDesktop ? "" : "hidden"}`}
        >
          <div
            ref={screen}
            role="img"
            aria-label={`${bot.name}'s desktop`}
            className={`size-full ${desktop ? "" : "invisible"}`}
          />
          <ActivityOverlay activity={activity} />
          {!desktop && (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-small text-ink-faint">
              Connecting to {bot.name}'s desktop…
            </p>
          )}
          {desktop && !mine && canTake && (
            <button
              type="button"
              aria-label={`Open ${bot.name}'s desktop and take control`}
              className="group absolute inset-0 cursor-pointer"
              onClick={take}
            >
              <span className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-label font-medium text-white opacity-80 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Maximize2 {...iconProps} size={12} />
                Open
              </span>
            </button>
          )}
        </div>
        {onDesktop ? (
          <>
            {request}
            {mine && (
              <InControl
                line={`You have the wheel. ${bot.name}'s clicks and keystrokes are refused until you hand it back.`}
                onGive={give}
              />
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {!mine && (
                <button
                  type="button"
                  className="button button-primary flex-auto"
                  disabled={!canTake}
                  title={`Pause ${bot.name}'s hands and drive this computer yourself`}
                  onClick={take}
                >
                  <Hand {...iconProps} size={14} />
                  Take control
                </button>
              )}
              <button
                type="button"
                className="button button-outline flex-auto"
                disabled={!desktop}
                onClick={() => void frameBox.current?.requestFullscreen()}
              >
                <Maximize2 {...iconProps} size={14} />
                Full screen
              </button>
            </div>
            {!mine && lease?.holder === "human" && (
              <p className="mt-2 text-small text-ink-secondary">
                Someone else has control in another window.
              </p>
            )}
          </>
        ) : unavailable ? null : frame?.data ? (
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
        {mine && (
          <form className="mt-3 flex items-center gap-2" onSubmit={typePrivately}>
            <input
              type="password"
              autoComplete="off"
              aria-label="Private text"
              placeholder="Click a field, then type here"
              className="field min-w-0 flex-1 text-ink"
              value={privateText}
              onChange={(event) => setPrivateText(event.target.value)}
            />
            <button type="submit" className="button" disabled={!privateText}>
              Type into page
            </button>
          </form>
        )}
        {mine && (
          <p className="mt-2 text-label text-ink-faint">
            Type passwords in the private field, not on the screen. It never reaches {bot.name}, its
            logs or the audit log. What you type on the screen goes there as you type it, and{" "}
            {bot.name} may read it later.
            {!onDesktop && " Native dialogs and the browser's own menus don't appear in this view."}
          </p>
        )}
        {onDesktop && place}
      </div>
    </>
  );
}
