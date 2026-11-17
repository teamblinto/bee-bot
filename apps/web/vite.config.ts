import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // tsc rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
      typecheck: {
        command: "tsc --noEmit",
        cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
      },
    },
  },
  // Production loads via file://, so asset URLs must be relative.
  base: "./",
  build: { sourcemap: "hidden" },
  plugins: [tanstackRouter({ autoCodeSplitting: true }), react({ compiler: true }), tailwindcss()],
  server: {
    host: process.env.HOST?.trim() || "localhost",
    port: Number(process.env.PORT ?? 5833),
    strictPort: true,
  },
});
