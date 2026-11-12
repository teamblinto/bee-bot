import * as NodePath from "node:path";

import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

await waitForResources({
  baseDir: NodePath.resolve(import.meta.dirname, ".."),
  files: ["dist-electron/main.cjs", "dist-electron/preload.cjs", "../server/dist/index.cjs"],
  tcpHost: devServer.hostname,
  tcpPort: port,
});

// `vp pack --watch` kills this process tree and re-runs it after each rebuild.
await import("./start-electron.mjs");
