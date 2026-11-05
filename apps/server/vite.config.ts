import { defineConfig } from "vite-plus";

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
    outDir: "dist",
    dts: false,
    sourcemap: true,
    outExtensions: () => ({ js: ".cjs" }),
    outputOptions: { codeSplitting: false },
    entry: ["src/index.ts"],
    // Electron may spawn the last bundle while a dev rebuild is running.
    clean: false,
  },
});
