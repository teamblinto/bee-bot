import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
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
    format: "esm",
    outDir: "dist",
    dts: false,
    sourcemap: true,
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: false },
    entry: ["src/index.ts"],
  },
});
