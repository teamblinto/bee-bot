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
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleX,
  Clock,
  Globe,
  Hand,
  LoaderCircle,
  Lock,
  Maximize2,
  Monitor,
  Plus,
  RotateCw,
  Undo2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
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
  stopShortcut,
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
  host: { label: "Your screen", Icon: Monitor },
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
  return stored ? clampWidth(stored) : 640;
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

// The panel's header, owner bar and tabs. Each view fills in who has control, and whether it can
// go full screen.
type Chrome = (owner: ReactNode, fullScreen?: RefObject<HTMLElement | null>) => ReactNode;

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
}) {
  const [width, setWidth] = useState(loadWidth);
  // Reconnecting remounts the screen, so its socket, lease and desktop all start over.
  const [attempt, setAttempt] = useState(0);
  const drag = useRef<{ x: number; width: number }>(null);

  function endDrag() {
    if (drag.current) {
      drag.current = null;
      save(widthKey, String(width));
    }
  }

  const chrome: Chrome = (owner, fullScreen) => (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption text-ink-secondary">{bot.name}</p>
          <h2 className="text-title-s font-semibold text-ink">Computer</h2>
        </div>
        <WhereWorks bot={bot} hostControl={hostControl} />
        <button
          type="button"
          aria-label="Full screen"
          title="Full screen"
          className="button button-icon"
          disabled={!fullScreen}
          onClick={() => void fullScreen?.current?.requestFullscreen()}
        >
          <Maximize2 {...iconProps} />
        </button>
        <button
          type="button"
          aria-label="Close computer"
          title="Close"
          className="button button-icon"
          onClick={onClose}
        >
          <X {...iconProps} />
        </button>
      </header>
      {owner && <div className="flex min-h-9 shrink-0 items-center gap-2 px-4 pb-2">{owner}</div>}
      <div
        role="tablist"
        aria-label="Views"
        className="flex shrink-0 gap-1 border-b border-edge-subtle pl-2"
      >
        {controlTabs[bot.control].map((id) => {
          const { label, Icon } = tabInfo[id];
          const selected = id === tab;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`relative flex h-9 items-center gap-2 px-3 text-body-s font-medium transition-colors ${selected ? "text-ink" : "text-ink-secondary hover:text-ink"}`}
              onClick={() => onTab(id)}
            >
              <Icon {...iconProps} />
              {label}
              {id === liveTab && (
                <span
                  role="img"
                  aria-label="In use"
                  className="size-1.5 animate-pulse rounded-full bg-brand-fill"
                />
              )}
              {selected && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand-fill" />}
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <aside
      aria-label={`${bot.name}'s computer`}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-edge-subtle bg-background shadow-panel max-lg:absolute max-lg:inset-0 max-lg:z-30 max-lg:!w-full lg:max-w-[calc(100%-22rem)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-brand-surface focus-visible:bg-brand-surface max-lg:hidden"
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
      {bot.control === "host" ? (
        <HostScreen
          bot={bot}
          hostControl={hostControl}
          working={working}
          activity={activity}
          chrome={chrome}
        />
      ) : tab === "computer" && bot.control !== "computer" ? (
        <>
          {chrome(
            <>
              <p className="min-w-0 flex-1 text-body-s text-ink-secondary">
                {bot.control === "browser"
                  ? `${bot.name} works in a browser of its own, with no desktop.`
                  : `${bot.name} has no screen.`}
              </p>
              {bot.control === "browser" && (
                <button
                  type="button"
                  className="button button-outline button-sm"
                  onClick={() => onTab("browser")}
                >
                  <Globe {...iconProps} />
                  Watch its browser
                </button>
              )}
            </>,
          )}
          <div className="scroller min-h-0 flex-1 overflow-auto p-4">
            <WhereHint bot={bot} />
          </div>
        </>
      ) : hasBoxScreen(bot, boxes) ? (
        <Screen
          key={attempt}
          bot={bot}
          tab={tab}
          working={working}
          activity={activity}
          chrome={chrome}
          onReconnect={() => setAttempt((count) => count + 1)}
        />
      ) : (
        <>
          {chrome(null)}
          <div className="scroller flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
            <SetUp bot={bot} boxes={boxes} />
            {tab === "computer" && <WhereHint bot={bot} />}
          </div>
        </>
      )}
    </aside>
  );
}

// Figma's waiting banner: while it shows, the bot's input is refused until the owner hands back.
function OwnerBanner({ line, onGive }: { line: string; onGive: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-card bg-waiting-surface py-3 pr-2 pl-3">
      <Clock {...iconProps} className="shrink-0 text-waiting-status" />
      <p className="min-w-0 flex-1 text-body-s font-medium text-waiting">{line}</p>
      <button type="button" className="button button-primary button-sm" onClick={onGive}>
        <Undo2 {...iconProps} />
        Hand back
      </button>
    </div>
  );
}

function OwnerLine({ live, children }: { live: boolean; children: ReactNode }) {
  return (
    <>
      {live && <span className="size-2 shrink-0 rounded-full bg-success-status" />}
      <p
        className={`min-w-0 flex-1 truncate text-body-s ${live ? "font-medium text-ink" : "text-ink-secondary"}`}
      >
        {children}
      </p>
    </>
  );
}

// Where the bot works, under its screen; Change opens the same menu as the header's pill.
function WhereHint({ bot }: { bot: Bot }) {
  const { Icon, line } = controlOptions[bot.control];
  return (
    <div className="flex items-center gap-2">
      <Icon {...iconProps} size={20} className="shrink-0 text-ink-secondary" />
      <p className="min-w-0 flex-1 text-body-s text-ink-secondary">{line}</p>
      <button type="button" popoverTarget="where-works" className="button button-sm">
        Change
      </button>
    </div>
  );
}

// The mode is the bot's own setting, so changing it here is the same as in its settings. Moving
// onto the owner's computer asks for their consent first, here in the panel.
function WhereWorks({
  bot,
  hostControl,
}: {
  bot: Bot;
  hostControl: HostControlAvailability | undefined;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [askingConsent, setAskingConsent] = useState(false);
  const current = controlOptions[bot.control];

  async function switchTo(control: BotControl) {
    setAskingConsent(false);
    setPending(true);
    setError(undefined);
    const result = await postCommand({
      type: "set-bot-control",
      botId: bot.id,
      control,
      // Only the consent card's button switches to this PC.
      ...(control === "host" && { hostConsent: true }),
    });
    setPending(false);
    setError(result.ok ? undefined : result.message);
    if (result.ok) {
      menu.current?.hidePopover?.();
    }
  }

  function choose(control: BotControl) {
    if (control === bot.control || pending) {
      return;
    }
    if (control === "host") {
      setAskingConsent(true);
      return;
    }
    void switchTo(control);
  }

  return (
    <>
      <button
        type="button"
        popoverTarget="where-works"
        aria-label={`Where ${bot.name} works: ${current.name}`}
        title={`Where ${bot.name} works`}
        className="flex h-7 min-w-0 shrink items-center gap-1 rounded-full px-2 text-label font-medium text-ink transition-colors [anchor-name:--where-works] hover:bg-hover"
      >
        <current.Icon {...iconProps} className="shrink-0" />
        <span className="truncate">{current.name}</span>
        <ChevronDown {...iconProps} size={12} className="shrink-0 text-ink-secondary" />
      </button>
      <div
        ref={menu}
        id="where-works"
        popover="auto"
        className="menu m-0 mt-1 w-80 max-w-[calc(100vw-16px)] p-1 [position-anchor:--where-works] [position-area:bottom_span-left]"
        onToggle={({ newState }) => newState === "closed" && setAskingConsent(false)}
      >
        <section aria-label={`Where ${bot.name} works`}>
          <h3 className="px-2 pt-2 pb-1 text-caption text-ink-secondary">Where {bot.name} works</h3>
          {controlOrder.map((control) => {
            const { name, help, Icon } = controlOptions[control];
            const selected = control === bot.control;
            const unavailable = control === "host" && !selected && hostControl?.available !== true;
            return (
              <button
                key={control}
                type="button"
                aria-pressed={selected}
                disabled={unavailable || pending}
                title={unavailable ? (hostControl?.problem ?? undefined) : help}
                className="flex w-full items-start gap-2 rounded-field px-2 py-1.5 text-left transition-colors enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => choose(control)}
              >
                <Icon {...iconProps} className="mt-0.5 shrink-0 text-ink-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-body-s text-ink">{name}</span>
                  <span className="block text-caption text-ink-secondary">
                    {unavailable ? "Unavailable" : help}
                  </span>
                </span>
                {selected && <Check {...iconProps} className="mt-0.5 shrink-0 text-brand-icon" />}
              </button>
            );
          })}
          {askingConsent && (
            <div
              role="group"
              aria-label={`Let ${bot.name} use this PC?`}
              className="m-1 rounded-field bg-sidebar p-3"
            >
              <p className="text-body-s font-medium text-ink">Let {bot.name} use this PC?</p>
              <p className="mt-1 text-caption text-ink-secondary">
                {bot.name} will see screenshots of your screen, which go to its model provider, and
                will click and type in your apps. Where it can, it works behind your windows with a
                pointer of its own; otherwise it briefly uses your mouse and keyboard. It can reach
                your apps and the accounts you're signed in to. It works only while you watch, and
                Take control
                {stopShortcut && ` (${stopShortcut})`} stops it.
                {bot.access === "full" && " With Full access it won't ask before each click."}
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  className="button button-outline button-sm"
                  onClick={() => setAskingConsent(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button button-primary button-sm"
                  autoFocus
                  onClick={() => void switchTo("host")}
                >
                  Use this PC
                </button>
              </div>
            </div>
          )}
          {error && <p className="px-2 py-1.5 text-caption text-danger">{error}</p>}
        </section>
      </div>
    </>
  );
}

// Bots' computers run in boxes, so the first one is set up from here rather than from Usage.
function SetUp({ bot, boxes }: { bot: Bot; boxes: BoxAvailability | undefined }) {
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
      <div className="flex flex-col gap-3">
        <p className="text-body-s font-medium text-ink">Setting up computers</p>
        {boxes.progress && <SetupProgress progress={boxes.progress} />}
        <p className="text-caption text-ink-secondary">
          This happens once and can take several minutes. You can keep chatting meanwhile.
        </p>
      </div>
    );
  }

  const Icon = controlOptions.computer.Icon;
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-raised text-ink-secondary">
        <Icon {...iconProps} />
      </span>
      <h3 className="text-title-s font-semibold text-ink">
        {boxes ? "Computers aren't set up yet" : "Computers are unavailable"}
      </h3>
      <p className="max-w-80 text-body-s text-ink-secondary">
        {!boxes
          ? "This server can't run computers for bots."
          : (boxes.problem ??
            `A private desktop gives ${bot.name} a computer of its own, apart from yours. You set it up once.`)}
      </p>
      {boxes && (
        <button
          type="button"
          className="button button-primary button-sm mt-2"
          onClick={() => void setUp()}
        >
          <Plus {...iconProps} />
          Set up computers
        </button>
      )}
      {error && <p className="text-body-s text-danger">{error}</p>}
    </div>
  );
}

const viewportClass = (held: boolean) =>
  `relative w-full overflow-hidden rounded-card bg-raised ${held ? "border-2 border-waiting-status" : "border border-edge-subtle"}`;

// The owner's own display, polled while it's shown: often while the bot works, rarely otherwise.
function HostScreen({
  bot,
  hostControl,
  working,
  activity,
  chrome,
}: {
  bot: Bot;
  hostControl: HostControlAvailability | undefined;
  working: boolean;
  activity: BotActivity | undefined;
  chrome: Chrome;
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
    <>
      {chrome(
        !available ? (
          <OwnerLine live={false}>
            {hostControl?.problem ?? "Bots can't use this computer from here."}
          </OwnerLine>
        ) : held ? (
          <OwnerBanner line="You have control · bots are waiting" onGive={() => void hold()} />
        ) : (
          <>
            <OwnerLine live={working}>
              {working
                ? `${bot.name} is using your screen`
                : `${bot.name} can use your screen while you watch`}
            </OwnerLine>
            <button
              type="button"
              className="button button-outline button-sm"
              title="Stop bots from using your computer until you hand it back"
              onClick={() => void hold()}
            >
              <Hand {...iconProps} />
              Take control
              {stopShortcut && (
                <kbd className="text-caption text-ink-secondary">{stopShortcut}</kbd>
              )}
            </button>
          </>
        ),
      )}
      <div className="scroller flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {available && (
          <div className={viewportClass(held)}>
            <ActivityOverlay activity={activity} />
            {frame ? (
              <img
                alt="Your screen"
                src={`data:${frame.mime};base64,${frame.data}`}
                draggable={false}
                className="block w-full"
              />
            ) : (
              <p className="flex aspect-[16/10] items-center justify-center text-body-s text-ink-faint">
                Waiting for your screen…
              </p>
            )}
          </div>
        )}
        {(holdError ?? frameError) && (
          <p className="text-body-s text-danger">{holdError ?? frameError}</p>
        )}
        <WhereHint bot={bot} />
      </div>
    </>
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
  working,
  activity,
  chrome,
  onReconnect,
}: {
  bot: Bot;
  tab: WorkspaceTab;
  working: boolean;
  activity: BotActivity | undefined;
  chrome: Chrome;
  onReconnect: () => void;
}) {
  const socket = useRef<WebSocket>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const privateId = useId();
  const [lease, setLease] = useState<Lease>();
  const [frame, setFrame] = useState<Frame>();
  const [page, setPage] = useState<Page>();
  const [unavailable, setUnavailable] = useState(false);
  const [lost, setLost] = useState(false);
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
    opened.onclose = () => {
      setLease(undefined);
      setLost(true);
    };
    return () => {
      opened.onclose = null;
      opened.close();
    };
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
  const takeButton = (
    <button
      type="button"
      className="button button-outline button-sm"
      disabled={!canTake}
      title={`Pause ${bot.name}'s hands and drive this computer yourself`}
      onClick={take}
    >
      <Hand {...iconProps} />
      Take control
    </button>
  );
  const owner = unavailable ? (
    <OwnerLine live={false}>{bot.name} has no browser running.</OwnerLine>
  ) : lost ? (
    <OwnerLine live={false}>Connection lost</OwnerLine>
  ) : !lease ? (
    <>
      <LoaderCircle {...iconProps} className="shrink-0 animate-spin text-success-status" />
      <p className="min-w-0 flex-1 truncate text-body-s text-ink">
        Connecting to {bot.name}'s computer…
      </p>
    </>
  ) : mine ? (
    <OwnerBanner line={`You have control · ${bot.name} is waiting`} onGive={give} />
  ) : lease.holder === "human" ? (
    <>
      <OwnerLine live={false}>Someone else has control in another window.</OwnerLine>
      {takeButton}
    </>
  ) : (
    <>
      <OwnerLine live={working}>
        {working
          ? `${bot.name} is using this computer`
          : `${bot.name} isn't using the computer right now`}
      </OwnerLine>
      {takeButton}
    </>
  );

  return (
    <>
      {chrome(owner, onDesktop && desktop ? frameBox : undefined)}
      <div className="scroller flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {lost && !unavailable && (
          <div className="flex flex-col gap-2">
            <p className="flex gap-2 text-body-s text-ink">
              <CircleX {...iconProps} className="mt-0.5 shrink-0 text-danger-status" />
              Lost connection to {bot.name}'s computer.
            </p>
            <div className="pl-6">
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={onReconnect}
              >
                Reconnect
              </button>
            </div>
          </div>
        )}
        {lease?.requested && (
          <p className="flex gap-2 rounded-card bg-waiting-surface px-3 py-3 text-body-s font-medium text-waiting">
            <Clock {...iconProps} className="mt-0.5 shrink-0 text-waiting-status" />
            {requestLines[lease.requested](lease.note ?? "A site")}
          </p>
        )}
        <div
          ref={frameBox}
          className={`aspect-[16/10] ${viewportClass(mine)} ${onDesktop && hasDesktop && !lost ? "" : "hidden"}`}
        >
          <div
            ref={screen}
            role="img"
            aria-label={`${bot.name}'s desktop`}
            className={`size-full ${desktop ? "" : "invisible"}`}
          />
          <ActivityOverlay activity={activity} />
          {!desktop && (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-body-s text-ink-faint">
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
              <span className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 rounded-field bg-inverse px-2 py-1 text-label font-medium text-ink-inverse opacity-80 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Maximize2 {...iconProps} size={12} />
                Open
              </span>
            </button>
          )}
        </div>
        {!onDesktop && !unavailable && !lost && (
          <div className={viewportClass(mine)}>
            <form
              className="flex items-center gap-0.5 border-b border-edge-subtle bg-sidebar px-1 py-0.5"
              onSubmit={navigate}
            >
              <button
                type="button"
                aria-label="Back"
                className="button button-icon button-sm"
                disabled={!mine || !page?.canGoBack}
                onClick={() => send({ type: "history", direction: "back" })}
              >
                <ArrowLeft {...iconProps} size={14} />
              </button>
              <button
                type="button"
                aria-label="Forward"
                className="button button-icon button-sm"
                disabled={!mine || !page?.canGoForward}
                onClick={() => send({ type: "history", direction: "forward" })}
              >
                <ArrowRight {...iconProps} size={14} />
              </button>
              <button
                type="button"
                aria-label="Reload"
                className="button button-icon button-sm"
                disabled={!mine || !page}
                onClick={() => send({ type: "reload" })}
              >
                <RotateCw {...iconProps} size={14} />
              </button>
              <input
                aria-label="Address"
                title={page?.title || undefined}
                className="min-w-0 flex-1 rounded-xs bg-transparent px-1.5 py-1 text-caption text-ink-secondary outline-none focus-visible:bg-card focus-visible:text-ink"
                readOnly={!mine}
                spellCheck={false}
                placeholder={mine ? "Type an address" : undefined}
                value={address ?? page?.url ?? ""}
                onChange={(event) => setAddress(event.target.value)}
                onBlur={() => setAddress(undefined)}
              />
            </form>
            {frame?.data ? (
              <img
                alt={`${bot.name}'s browser`}
                src={`data:image/jpeg;base64,${frame.data}`}
                tabIndex={mine ? 0 : -1}
                draggable={false}
                className={`block w-full bg-card outline-none ${mine ? "cursor-default" : ""}`}
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
              <p className="flex aspect-[16/10] items-center justify-center text-body-s text-ink-faint">
                Waiting for the page…
              </p>
            )}
          </div>
        )}
        {mine && (
          <form className="flex flex-col gap-1" onSubmit={typePrivately}>
            <label htmlFor={privateId} className="field-label pb-1 text-ink">
              Send text privately
            </label>
            <div className="relative flex items-center">
              <Lock
                {...iconProps}
                className="pointer-events-none absolute left-3 text-ink-secondary"
              />
              <input
                id={privateId}
                type="password"
                autoComplete="off"
                placeholder="Password or code"
                className="field pr-32 pl-9 text-ink"
                value={privateText}
                onChange={(event) => setPrivateText(event.target.value)}
              />
              <button
                type="submit"
                className="button button-sm absolute right-1"
                disabled={!privateText}
              >
                Type into page
              </button>
            </div>
            <p className="field-help">
              Type passwords here, not on the screen. It never reaches {bot.name}, its logs or the
              audit log. What you type on the screen goes there as you type it, and {bot.name} may
              read it later.
              {!onDesktop &&
                " Native dialogs and the browser's own menus don't appear in this view."}
            </p>
          </form>
        )}
        {onDesktop && <WhereHint bot={bot} />}
      </div>
    </>
  );
}
