import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

// Electron 44+ has no postinstall; requiring it downloads the binary when missing.
const electronPath = NodeModule.createRequire(import.meta.url)("electron");

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const remoteDebuggingPort = process.env.BEEBOT_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
const userDataDir = process.env.BEEBOT_DESKTOP_USER_DATA_DIR?.trim();
const electronArgs = [
  ...(remoteDebuggingPort ? [`--remote-debugging-port=${remoteDebuggingPort}`] : []),
  ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
];

const child = NodeChildProcess.spawn(electronPath, [...electronArgs, "."], {
  stdio: "inherit",
  cwd: NodePath.resolve(import.meta.dirname, ".."),
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
