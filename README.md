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

A bot with **Computer and browser** turned on (the default for new bots) gets its own computer: a Linux desktop (Xvfb, openbox, headed Chromium) in a rootless Podman container next to the bot's engine container. The two share no network, and both reach the internet only through Bee Bot's egress proxy. `apps/boxd` runs inside a Podman machine and is the only thing that touches containers. The server reaches the desktop through boxd's verbs: CDP for the `browser_*` tools, xdotool for the `computer_*` tools, and VNC for the live view.

- **Setup.** Installing Podman is the user's one manual step. "Set up computers" in a chat's computer panel (or Set up boxes on the Usage page) creates the `beebot` Podman machine if it is missing, starts it, builds the box image and starts boxd. When Bee Bot starts, it restarts a machine it has set up before and rebuilds the image after an update. There are no other accounts or logins.
- **Image updates.** `images/box/imageTag.test.ts` fails until a change to the image's build inputs comes with a new tag in `runSpec.json`. When a box was made from an older image, boxd replaces its containers and keeps its volumes, so the bot's files and browser profile survive.
- **Workspace panel.** The panel beside the chat has a Computer tab (the whole desktop over noVNC) and a Browser tab (a CDP screencast with an address bar). It opens by itself when the bot starts using its screen, or asks for a person, unless the owner closed it during that run. Take control gives the owner the bot's lease. While the owner holds it, the bot's screen tools are refused and the address bar, desktop input and a private sign-in field work. Giving control back makes the bot look again before it acts.
- **Why not CUA or a cloud sandbox.** OpenMausBot drives computers through trycua's `cua-driver`, mostly to control the user's own desktop. Bee Bot leaves the host desktop out of scope. Inside a container, xdotool and CDP do the same job with nothing extra to ship. Hosted sandboxes would mean a second account, and bots' pages and sign-ins would sit with a third party. Every provider-specific part sits behind `BoxRuntime` (`apps/server/src/boxRuntime.ts`), so another backend can implement that interface.

## Policy and audit

Each bot has a Rule of Two profile. Reader may hold untrusted input and private data, Researcher untrusted input and side effects, Operator private data and side effects. Bots start as Operator: by default they act on the owner's files at the owner's word, and no tool that reads untrusted content is granted until the bot's manifest names it. The broker decides every call to Bee Bot's own tools from static labels on the tool, the bot's profile and manifest, and the legs the session already holds. A call that would take the session past its profile needs the owner watching, and is refused when nobody is.

The audit log (Audit in the sidebar) records each run starting and ending, each approval, profile changes, and every call through Bee Bot's tools with the broker's decision, who started the run and whether anyone was watching. Inputs are kept only as a SHA-256 fingerprint, and inputs that can hold typed text or credentials not even that. It does not record what the engine does with its own shell and file tools unless it asks permission first, the engine's own network traffic, credentials, or anything typed during a browser handoff. Rows are hash-chained, so an edit or a removal in the middle shows; removing the newest rows does not.
