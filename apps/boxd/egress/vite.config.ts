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
  // One dependency-free file: the Linux host's Node can be older than the repo's.
  pack: {
    format: "esm",
    platform: "node",
    target: "node20",
    outDir: "dist",
    dts: false,
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: false },
    entry: { egress: "src/main.ts" },
  },
});
