# Bee Bot

## Prerequisites

- Node 26.13.0 (see `engines` in `package.json`)
- pnpm 12.16.1

## Commands

```sh
pnpm install
pnpm dev:desktop       # web dev server on 127.0.0.1:5833 plus Electron
pnpm build
pnpm start:desktop     # run the production build
pnpm fmt
pnpm lint
pnpm typecheck
pnpm test
pnpm dist:desktop:win  # installer in apps/desktop/release
```

`dist:desktop:mac` and `dist:desktop:linux` run the same build on those platforms.

Copy `.env.example` to `.env` to change the dev server port.

On Windows, keep the repo root under about 90 characters: `dist:desktop:win` fails on longer paths because NSIS cannot open the deep pnpm paths.

## Computers and browsers

Each bot works on one of four things, chosen under **Works on** in its settings or in **Where it works** on its panel's Screen tab, and kept in `bots.control`:

- **Browser** (`browser`): its own Chromium, web pages only, through the `browser_*` tools. The Browser tab shows it.
- **Private desktop** (`computer`, the default for new bots): its own Xfce Linux desktop, with a top bar, a dock of terminal, file manager, browser and app finder, and that Chromium on it, through the `computer_*` and `browser_*` tools. The Screen tab shows it live; Take control hands the owner its mouse and keyboard and refuses the bot's until they hand it back, and Full screen fills the screen with it. The Browser tab shows its browser.
- **This PC** (`host`): the owner's real desktop, through the `computer_*` tools. Windows and the desktop app only. Choosing it in the panel asks for consent right there, once per move, then switches. The Screen tab shows it.
- **Off** (`none`): no browser or computer tools.

The mode alone grants the browser and desktop tools (`grantsOf` in `apps/server/src/broker.ts`), so the tools a bot is offered, the broker's checks and the note in its persona always agree. A change waits until the bot has no run going, because a turn keeps the tools it started with, and each change is audited.

A bot's browser or private desktop runs in a Linux desktop (Xvfb, Xfce, headed Chromium) in a rootless Podman container next to the bot's engine container. The desktop's home and Chromium's profile live on the box's volume, so they outlast restarts; closing Chromium or a part of the desktop brings it back a second later. The two share no network, and both reach the internet only through Bee Bot's egress proxy. `apps/boxd` runs inside a Podman machine and is the only thing that touches containers. The server reaches the desktop through boxd's verbs: CDP for the `browser_*` tools, xdotool for the `computer_*` tools, and VNC for the live view. A browser-only bot's box has the same desktop, but neither the bot nor the owner's view reaches anything but its browser.

- **Setup.** Installing Podman is the user's one manual step. "Set up computers" in a chat's computer panel (or Set up boxes on the Usage page) creates the `beebot` Podman machine if it is missing, starts it, builds the box image and starts boxd. A progress bar follows each step, and the package download and install are measured. The first time on a Windows (WSL) machine, boxd moves systemd into its own cgroup so container limits hold, and Bee Bot restarts the machine once for that to take effect. When Bee Bot starts, it restarts a machine it has set up before and rebuilds the image after an update. If the machine stops while Bee Bot runs, it reconnects by itself. Only one boxd runs per machine: a newly launched one stops any older one first. There are no other accounts or logins.
- **Image updates.** `images/box/imageTag.test.ts` fails until a change to the image's build inputs comes with a new tag in `runSpec.json`. When a box was made from an older image, boxd replaces its containers and keeps its volumes, so the bot's files and browser profile survive.
- **Workspace panel.** The panel beside the chat shows the tabs the bot's mode has: Computer (the whole desktop over noVNC), Browser (a CDP screencast with an address bar), or Your screen (a frame of the owner's display, refreshed every second while the bot works). It opens by itself when the bot starts using its screen, or asks for a person, unless the owner closed it during that run. Take control gives the owner the bot's lease. While the owner holds it, the bot's screen tools are refused and the address bar, desktop input and a private sign-in field work. Giving control back makes the bot look again before it acts.
- **This computer.** Only the desktop app's server drives the desktop it runs in: Electron sends `hostControl` in the bootstrap, and a headless server never does. The driver is a Windows PowerShell process (`apps/server/src/hostDriver.ps1.ts`) that calls Win32 SendInput and captures the main display with the pointer drawn in, at physical pixels. Screenshots are fitted to 1280x800 and the bot's coordinates are mapped back. It starts on first use and stops after five idle minutes. The owner gives consent when choosing the mode. The bot opens and uses apps on the screen with the `computer_*` tools, not with shell commands. A bot uses it only while the owner watches, and one bot at a time. Each input checks that the pointer is where the bot left it, so moving the mouse stops the bot, between its calls as well as during them. Input aimed at Bee Bot's own windows is refused, so a bot can't approve its own cards. Take control in the Your screen tab refuses the bot's calls until the owner hands it back. Calls go through Access like any other: below Full access each click, key, scroll or drag asks with a card, and at Full access none do. Only the main display is shown, and only Windows is supported for now. `BEEBOT_HOST_TESTS=1` runs the real-driver test, which moves the pointer a few pixels.
- **Why not CUA or a cloud sandbox.** OpenMausBot drives computers through trycua's `cua-driver`, a native binary that Electron ships and runs. Inside a container, xdotool and CDP do the same job, and on the owner's Windows desktop, Win32 calls from PowerShell do. Neither needs anything extra shipped. Hosted sandboxes would mean a second account, and bots' pages and sign-ins would sit with a third party. Bee Bot sends nothing to anyone else except usage data the owner opts into (see [Usage data](#usage-data)). Every provider-specific part sits behind `BoxRuntime` (`apps/server/src/boxRuntime.ts`), so another backend can implement that interface.

## Policy and audit

A bot has one permission setting, Access, chosen in the composer:

- **Supervised** asks before every command, file read or change, and screen or browser action.
- **Auto-accept edits** runs file edits inside the working folder and asks before everything else.
- **Full access** asks before nothing, including Bash and the `computer_*` and `browser_*` tools. New bots start here.

Every ask is an approval card while the owner watches; a call is never refused silently because it needed approval. Looking (a screenshot, a page snapshot) and reads inside the working folder that were Always allowed don't ask. Paths that hold credentials are refused at every level.

The Rule of Two still guards runs nobody watches, such as a box bot's routine: **with nobody watching, a Full access bot acts freely but may read untrusted content (web pages, screens, a tainted bot's messages) or your private data (files, memory) in one session, never both.** The broker tracks the legs a session holds from static labels on each tool, and refuses the call that would add the second kind of read, or any side effect after both. An unattended run gets no memory up front for the same reason; it can search memory if it hasn't read untrusted content. At a lower level an unattended call that would ask is refused, since nobody can answer.

The audit log (Audit in the sidebar) records each run starting and ending, each approval, setting changes, and every call through Bee Bot's tools with the broker's decision, who started the run and whether anyone was watching. Inputs are kept only as a SHA-256 fingerprint, and inputs that can hold typed text or credentials not even that. It does not record what the engine does with its own shell and file tools unless it asks permission first, the engine's own network traffic, credentials, or anything typed during a browser handoff. Rows are hash-chained, so an edit or a removal in the middle shows; removing the newest rows does not.

## Usage data

Bee Bot can send anonymous usage data and crash reports to PostHog, to see which features are used and what breaks. It is off by default: the owner is asked once on the onboarding card and can switch **Share usage data** in the sidebar footer at any time. Turning it off stops sending at once and drops anything queued. Setting `BEEBOT_TELEMETRY=0` in the environment turns it off regardless. Only release builds made with a PostHog key send anything, and only the local server sends.

- **Sent:** event names (the `UsageEvents` map in `packages/contracts/src/index.ts`) with only enums, counts, durations and true/false values, plus the app and protocol version, OS and CPU architecture. Crash reports carry the exception type and stack frames (function, file name, line, column), never the message. The id is a SHA-256 hash of a random id made for this install. Events create no person profile, and GeoIP lookup is off.
- **Never sent:** message or prompt text, bot names, personality or summary, file paths or names, URLs or hosts, connector names, URLs or tools, memory, skills, screenshots, error messages, API keys, tokens or emails.
