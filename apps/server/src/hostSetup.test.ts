import { expect, it } from "vite-plus/test";

import { linuxFamily, setupPath, terminalLaunch } from "./hostSetup.ts";

it("names the package family from ID, then ID_LIKE", () => {
  expect(linuxFamily('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n')).toBe("debian");
  expect(linuxFamily('ID="rocky"\nID_LIKE="rhel centos fedora"\n')).toBe("fedora");
  expect(linuxFamily("ID=pop\n")).toBe("debian");
  expect(linuxFamily("ID=endeavouros\nID_LIKE=arch\n")).toBe("arch");
  expect(linuxFamily('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n')).toBe("suse");
  expect(linuxFamily("ID=somethingelse\nID_LIKE=ubuntu debian\n")).toBe("debian");
  expect(linuxFamily("ID=nixos\n")).toBeNull();
  expect(linuxFamily("")).toBeNull();
});

it("puts the installers' folders on PATH once", () => {
  expect(setupPath("/usr/bin:/usr/local/bin", "darwin", "/Users/me")).toBe(
    "/Users/me/.local/bin:/opt/homebrew/bin:/opt/podman/bin:/usr/bin:/usr/local/bin",
  );
  expect(setupPath("/home/me/.local/bin:/usr/bin", "linux", "/home/me")).toBe(
    "/home/me/.local/bin:/usr/bin",
  );
  expect(setupPath("C:\\Windows", "win32", "C:\\Users\\me")).toBe(
    "C:\\Users\\me\\.local\\bin;C:\\Program Files\\RedHat\\Podman;C:\\Windows",
  );
});

const command = "brew install podman";

it("opens a new PowerShell console on Windows that waits for Enter", () => {
  const launch = terminalLaunch("win32", "irm https://claude.ai/install.ps1 | iex", "", () => true);
  expect(launch?.file).toBe("cmd.exe");
  expect(launch?.script).toBeUndefined();
  const [, , start = ""] = launch?.args ?? [];
  expect(start).toMatch(/^start "Bee Bot setup" powershell\.exe -NoExit .* -EncodedCommand \S+$/);
  const script = Buffer.from(start.split(" ").at(-1) ?? "", "base64").toString("utf16le");
  expect(script.split("\n")).toEqual([
    "Write-Host 'Bee Bot will run:'",
    "Write-Host ''",
    "Write-Host '  irm https://claude.ai/install.ps1 | iex'",
    "Write-Host ''",
    "Write-Host 'Press Enter to run it, or close this window to cancel.'",
    "[void](Read-Host)",
    "irm https://claude.ai/install.ps1 | iex",
    "Write-Host ''",
    "Write-Host 'Done. Go back to Bee Bot.'",
  ]);
});

it("runs a script in Terminal on macOS", () => {
  const launch = terminalLaunch("darwin", command, "/tmp/x/setup.command", () => false);
  expect(launch).toMatchObject({
    file: "open",
    args: ["-a", "Terminal", "/tmp/x/setup.command"],
    script: { path: "/tmp/x/setup.command" },
  });
  const lines = launch?.script?.text.split("\n");
  expect(lines?.[0]).toBe("#!/bin/bash");
  expect(lines).toContain(`  ${command}`);
  const enter = lines?.indexOf(
    'read -r -p "Press Enter to run it, or close this window to cancel. "',
  );
  expect(lines?.[(enter ?? -2) + 1]).toBe(command);
  expect(lines).toContain('echo "Done. Go back to Bee Bot."');
});

it("uses the first terminal it finds on Linux, or none", () => {
  const found = (bins: string[]) => (bin: string) => bins.includes(bin);
  expect(terminalLaunch("linux", command, "/tmp/s", found(["xterm", "konsole"]))).toMatchObject({
    file: "konsole",
    args: ["-e", "/tmp/s"],
  });
  expect(terminalLaunch("linux", command, "/tmp/s", found(["gnome-terminal"]))?.args).toEqual([
    "--",
    "/tmp/s",
  ]);
  expect(terminalLaunch("linux", command, "/tmp/s", found(["kitty"]))?.args).toEqual(["/tmp/s"]);
  expect(terminalLaunch("linux", command, "/tmp/s", found([]))).toBeUndefined();
});
