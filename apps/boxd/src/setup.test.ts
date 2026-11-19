import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Podman } from "./podman.ts";
import {
  limitProblems,
  MachineRestartNeeded,
  patchBootstrap,
  patchContainersConf,
  setup,
} from "./setup.ts";
import { testRunSpec } from "./testing.ts";

// Podman 5.8's /root/bootstrap in the WSL machine (S3).
const original = `#!/bin/bash
ps -ef | grep -v grep | grep -q systemd && exit 0
nohup unshare --kill-child --fork --pid --mount --mount-proc --propagation shared /lib/systemd/systemd >/dev/null 2>&1 &
sleep 0.1
`;

describe("cgroup fix", () => {
  it("moves systemd into its own cgroup before it starts, once", () => {
    const patched = patchBootstrap(original);
    expect(patched).not.toBeNull();
    const lines = patched!.split("\n");
    const move = lines.findIndex((line) => line.includes("beebot-systemd/init.scope/cgroup.procs"));
    const launch = lines.findIndex((line) => line.startsWith("nohup unshare"));
    expect(move).toBeGreaterThan(-1);
    expect(move).toBeLessThan(launch);
    expect(lines.some((line) => line.includes("+memory +pids"))).toBe(true);
    expect(patchBootstrap(patched!)).toBe(patched);
  });

  it("leaves a bootstrap patched by hand alone and refuses an unknown one", () => {
    const byHand = original.replace("nohup", "mkdir -p $CG/beebot-systemd/init.scope\nnohup");
    expect(patchBootstrap(byHand)).toBe(byHand);
    expect(patchBootstrap("#!/bin/sh\nexec /sbin/init\n")).toBeNull();
  });

  it("sets the systemd cgroup manager in any containers.conf, once", () => {
    for (const before of [
      "",
      "[engine]\n",
      '[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n',
      "[containers]\nlog_size_max = 1\n\n[network]\ndns_bind_port = 1\n",
    ]) {
      const after = patchContainersConf(before);
      expect(after.match(/cgroup_manager/g)).toHaveLength(1);
      expect(after).toMatch(/\[engine\]\ncgroup_manager = "systemd"\n/);
      expect(patchContainersConf(after)).toBe(after);
    }
    expect(
      patchContainersConf('[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n'),
    ).toContain('events_logger = "file"');
  });
});

describe("setup", () => {
  function host(probe: string) {
    let bootstrap = original;
    const writes: string[] = [];
    const podman: Podman = {
      host: async (_command, args, stdin) => {
        if (args.includes("cat")) {
          return { code: 0, stdout: bootstrap, stderr: "" };
        }
        if (args.includes("tee")) {
          bootstrap = stdin ?? "";
          writes.push(bootstrap);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      run: async () => ({ code: 0, stdout: probe, stderr: "" }),
      spawn: () => {
        throw new Error("unused");
      },
    };
    return { podman, writes };
  }

  it("applies the fix once and passes when limits hold", async () => {
    const dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "boxd-setup-"));
    const conf = NodePath.join(dir, "containers", "containers.conf");
    const { podman, writes } = host("67108864\n32\n50000 100000\n");
    expect(await setup(podman, testRunSpec.engine, conf)).toEqual({
      bootstrapChanged: true,
      confChanged: true,
    });
    expect(await setup(podman, testRunSpec.engine, conf)).toEqual({
      bootstrapChanged: false,
      confChanged: false,
    });
    expect(writes).toHaveLength(1);
    expect(await NodeFs.readFile(conf, "utf8")).toContain('cgroup_manager = "systemd"');
    await NodeFs.rm(dir, { recursive: true });
  });

  it("asks for a machine restart while the cgroup fix is in place but not yet live", async () => {
    const dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "boxd-setup-"));
    const { podman } = host("max\nmax\nmax 100000\n");
    const conf = NodePath.join(dir, "c.conf");
    await expect(setup(podman, testRunSpec.engine, conf)).rejects.toBeInstanceOf(
      MachineRestartNeeded,
    );
    // A retry before the restart finds the fix already written, and still asks for it.
    await expect(setup(podman, testRunSpec.engine, conf)).rejects.toBeInstanceOf(
      MachineRestartNeeded,
    );
    await NodeFs.rm(dir, { recursive: true });
  });

  it("refuses to serve without asking for a restart where there is no cgroup fix", async () => {
    const dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "boxd-setup-"));
    const { podman } = host("max\nmax\nmax 100000\n");
    const linux: Podman = {
      ...podman,
      host: async () => ({ code: 1, stdout: "", stderr: "no such file" }),
    };
    const failure = setup(linux, testRunSpec.engine, NodePath.join(dir, "c.conf"));
    await expect(failure).rejects.toThrow("container limits are not enforced");
    await expect(failure).rejects.not.toBeInstanceOf(MachineRestartNeeded);
    await NodeFs.rm(dir, { recursive: true });
  });

  it("never runs sudo on a native host", async () => {
    const dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "boxd-setup-"));
    const { podman } = host("67108864\n32\n50000 100000\n");
    const native: Podman = {
      ...podman,
      host: async () => {
        throw new Error("sudo ran");
      },
    };
    expect(await setup(native, testRunSpec.engine, NodePath.join(dir, "c.conf"), true)).toEqual({
      bootstrapChanged: false,
      confChanged: true,
    });
    await NodeFs.rm(dir, { recursive: true });
  });
});

describe("limit check", () => {
  it("passes only when every probe limit took", () => {
    expect(limitProblems("67108864\n32\n50000 100000\n")).toEqual([]);
    expect(limitProblems("max\n32\n50000 100000\n")).toEqual(["memory.max is max"]);
    expect(limitProblems("67108864\nmax\nmax 100000\n")).toHaveLength(2);
    expect(limitProblems("")).toHaveLength(3);
  });
});
