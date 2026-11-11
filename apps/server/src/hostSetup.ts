import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HostPlatform } from "@beebot/contracts";

import { windowsPodman } from "./boxHost.ts";

const families = new Map<string, NonNullable<HostPlatform["linuxFamily"]>>([
  ...["debian", "ubuntu", "linuxmint", "pop"].map((id) => [id, "debian"] as const),
  ...["fedora", "rhel", "centos", "rocky", "almalinux"].map((id) => [id, "fedora"] as const),
  ...["arch", "manjaro", "endeavouros"].map((id) => [id, "arch"] as const),
  ...["sles", "suse"].map((id) => [id, "suse"] as const),
]);

// `osRelease` is the text of /etc/os-release.
export function linuxFamily(osRelease: string) {
  const field = (name: string) =>
    osRelease.match(new RegExp(`^${name}=["']?([^"'\n]*)`, "m"))?.[1] ?? "";
  const ids = `${field("ID")} ${field("ID_LIKE")}`.toLowerCase().split(/\s+/);
  for (const id of ids) {
    const family = id.startsWith("opensuse") ? "suse" : families.get(id);
    if (family) {
      return family;
    }
  }
  return null;
}

export function hostPlatform(): HostPlatform {
  if (process.platform === "win32") {
    return { os: "windows", linuxFamily: null };
  }
  if (process.platform === "darwin") {
    return { os: "macos", linuxFamily: null };
  }
  try {
    return {
      os: "linux",
      linuxFamily: linuxFamily(NodeFS.readFileSync("/etc/os-release", "utf8")),
    };
  } catch {
    return { os: "linux", linuxFamily: null };
  }
}

// Where the installers setup recommends put `claude` and `podman`, which a PATH inherited from
// before the install (or a macOS GUI app's minimal one) lacks.
export function setupPath(path: string | undefined, platform: NodeJS.Platform, home: string) {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const dirs = [paths.join(home, ".local", "bin")];
  if (platform === "win32") {
    // Podman's installer puts it under Program Files for all users, or LocalAppData for one.
    dirs.push(
      NodePath.win32.dirname(windowsPodman),
      NodePath.win32.join(home, "AppData", "Local", "Programs", "Podman"),
    );
  }
  if (platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/opt/podman/bin");
  }
  const parts = (path ?? "").split(paths.delimiter).filter(Boolean);
  return [...dirs.filter((dir) => !parts.includes(dir)), ...parts].join(paths.delimiter);
}

const prompt = "Press Enter to run it, or close this window to cancel.";
const done = "Done. Go back to Bee Bot.";

const linuxTerminals = [
  { bin: "x-terminal-emulator", args: ["-e"] },
  { bin: "gnome-terminal", args: ["--"] },
  { bin: "konsole", args: ["-e"] },
  { bin: "xfce4-terminal", args: ["-x"] },
  { bin: "kitty", args: [] },
  { bin: "alacritty", args: ["-e"] },
  { bin: "xterm", args: ["-e"] },
];

function bashScript(command: string) {
  return `#!/bin/bash
cat <<'BEEBOT'
Bee Bot will run:

  ${command}

BEEBOT
read -r -p "${prompt} "
${command}
echo
echo "${done}"
exec "\${SHELL:-/bin/bash}" -i
`;
}

// How to open a visible terminal that shows `command` and runs it on Enter. `script` is written to
// `scriptPath` first. Null when no terminal is known on Linux.
export function terminalLaunch(
  platform: NodeJS.Platform,
  command: string,
  scriptPath: string,
  onPath: (bin: string) => boolean,
) {
  if (platform === "win32") {
    const quoted = command.replaceAll("'", "''");
    const script = [
      "Write-Host 'Bee Bot will run:'",
      "Write-Host ''",
      `Write-Host '  ${quoted}'`,
      "Write-Host ''",
      `Write-Host '${prompt}'`,
      "[void](Read-Host)",
      command,
      "Write-Host ''",
      `Write-Host '${done}'`,
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    // A detached console child gets no console at all, so `start` opens it a new one.
    return {
      file: "cmd.exe",
      args: [
        "/d",
        "/c",
        `start "Bee Bot setup" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      ],
      script: undefined,
    };
  }
  const script = { path: scriptPath, text: bashScript(command) };
  if (platform === "darwin") {
    return { file: "open", args: ["-a", "Terminal", scriptPath], script };
  }
  const terminal = linuxTerminals.find(({ bin }) => onPath(bin));
  return terminal && { file: terminal.bin, args: [...terminal.args, scriptPath], script };
}

function onPath(bin: string) {
  return (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .some((dir) => dir && NodeFS.existsSync(NodePath.join(dir, bin)));
}

// Resolves once the terminal process started, with why not if it didn't.
export async function openSetupTerminal(command: string) {
  let launch: ReturnType<typeof terminalLaunch>;
  try {
    const dir =
      process.platform === "win32"
        ? ""
        : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-setup-"));
    launch = terminalLaunch(process.platform, command, NodePath.join(dir, "setup.command"), onPath);
    if (launch?.script) {
      NodeFS.writeFileSync(launch.script.path, launch.script.text, { mode: 0o700 });
    }
  } catch {
    return "terminal_failed";
  }
  if (!launch) {
    return "no_terminal";
  }
  const { file, args } = launch;
  return new Promise<"opened" | "terminal_failed">((resolve) => {
    const child = NodeChildProcess.spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.once("error", () => resolve("terminal_failed"));
    child.once("spawn", () => {
      child.unref();
      resolve("opened");
    });
  });
}
