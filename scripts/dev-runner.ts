import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const envFile = NodePath.join(repoRoot, ".env");
if (NodeFS.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

if (
  process.platform === "win32" &&
  !NodeFS.existsSync(NodePath.join(repoRoot, "apps/desktop/vendor/cua-driver/cua-driver.exe"))
) {
  console.log("This PC uses the PowerShell driver; run `pnpm prepare:cua` for cua-driver.");
}

// `localhost` can resolve to ::1 on Windows and hang the TCP wait in dev-electron.
const host = "127.0.0.1";
const port = process.env.PORT ?? "5833";

const child = NodeChildProcess.spawn(
  "vp run --filter=@beebot/desktop --filter=@beebot/server --filter=@beebot/web --parallel dev",
  {
    cwd: repoRoot,
    stdio: "inherit",
    // vp is a .cmd shim on Windows.
    shell: true,
    env: {
      ...process.env,
      HOST: host,
      PORT: port,
      VITE_DEV_SERVER_URL: `http://${host}:${port}`,
      BEEBOT_DESKTOP_DEV: "1",
    },
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
