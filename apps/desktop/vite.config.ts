import { defineConfig } from "vite-plus";

const shouldLaunchElectronAfterPack = process.env.BEEBOT_DESKTOP_DEV === "1";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: false,
      },
      dev: {
        command: "vp pack --watch",
        cache: false,
      },
      // tsc rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
      typecheck: {
        command: "tsc --noEmit",
        cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
      },
    },
  },
  pack: {
    format: "cjs",
    outDir: "dist-electron",
    dts: false,
    sourcemap: true,
    outExtensions: () => ({ js: ".cjs" }),
    outputOptions: { codeSplitting: false },
    entry: ["src/main.ts"],
    clean: true,
    deps: { neverBundle: ["electron"] },
    ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
  },
});
