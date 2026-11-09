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

## Policy and audit

Each bot has a Rule of Two profile. Reader may hold untrusted input and private data, Researcher untrusted input and side effects, Operator private data and side effects. Bots start as Operator: by default they act on the owner's files at the owner's word, and no tool that reads untrusted content is granted until the bot's manifest names it. The broker decides every call to Bee Bot's own tools from static labels on the tool, the bot's profile and manifest, and the legs the session already holds. A call that would take the session past its profile needs the owner watching, and is refused when nobody is.

The audit log (Audit in the sidebar) records each run starting and ending, each approval, profile changes, and every call through Bee Bot's tools with the broker's decision, who started the run and whether anyone was watching. Inputs are kept only as a SHA-256 fingerprint, and inputs that can hold typed text or credentials not even that. It does not record what the engine does with its own shell and file tools unless it asks permission first, the engine's own network traffic, credentials, or anything typed during a browser handoff. Rows are hash-chained, so an edit or a removal in the middle shows; removing the newest rows does not.
