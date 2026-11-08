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
  test: {
    include: ["src/**/*.test.ts"],
  },
  pack: {
    format: "cjs",
    outDir: "dist",
    dts: false,
    outExtensions: () => ({ js: ".cjs" }),
    outputOptions: { codeSplitting: false },
    entry: { boxd: "src/main.ts" },
  },
});
