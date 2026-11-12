import { defineConfig } from "vite-plus";
import type { PackUserConfig } from "vite-plus/pack";

const shouldLaunchElectronAfterPack = process.env.BEEBOT_DESKTOP_DEV === "1";

const packShared: PackUserConfig = {
  format: "cjs",
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  outputOptions: { codeSplitting: false },
  clean: false,
  deps: { neverBundle: ["electron"] },
};

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
  // One config per entry: a single bundle can't hold two entries without code splitting.
  // Neither cleans, or one build would delete the other's output.
  pack: [
    {
      ...packShared,
      entry: ["src/main.ts"],
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    { ...packShared, entry: ["src/preload.ts"] },
  ],
});
