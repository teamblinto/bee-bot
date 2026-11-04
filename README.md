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
