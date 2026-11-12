import type { Child, Podman } from "./podman.ts";
import type { EgressAttachment, Role } from "./policy.ts";

// The seam for the egress proxy (apps/boxd/egress), which runs beside boxd in the Linux host.
// `start` runs once after setup, before boxd serves. `attach` runs when `create` has made a box
// network: the proxy joins that network and says how containers on it reach it. Box networks are
// internal, so whatever the proxy does not provide does not exist. `bind` ties a box address to its
// bot while the box runs; `detach` takes the proxy off a box network before the network goes;
// `control` opens a fresh control connection for the server's policies.
export type Egress = {
  start: () => Promise<void>;
  attach: (network: { botId: string; role: Role; name: string }) => Promise<EgressAttachment>;
  bind: (address: string, botId: string) => Promise<void>;
  unbind: (address: string) => Promise<void>;
  detach: (network: string) => Promise<void>;
  control: () => Child | null;
};

// Until a proxy is wired in, boxes have no way out at all.
export const noEgress: Egress = {
  start: async () => {},
  attach: async () => ({ dns: null, env: {} }),
  bind: async () => {},
  unbind: async () => {},
  detach: async () => {},
  control: () => null,
};

export const proxyHost = "proxy.beebot";

// The proxy's own address on a box network: the first host after the network address. boxd joins
// the proxy before any box container exists, so a box never takes it.
export function proxyAddress(subnet: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(subnet.trim());
  if (match === null || Number(match[5]) > 29) {
    throw new Error(`unsupported box subnet ${subnet}`);
  }
  const value = match.slice(1, 5).reduce((sum, part) => sum * 256 + Number(part), 0) + 2;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

const controlSocket = "/run/egress/control.sock";
const relay = `const s=require("net").connect(${JSON.stringify(controlSocket)});process.stdin.pipe(s).pipe(process.stdout);s.on("close",()=>process.exit());s.on("error",()=>process.exit(1))`;

export type PodmanEgressOptions = {
  podman: Podman;
  prefix: string;
  owner: string;
  labels: Record<string, string>;
  image: string;
  // Directories in the Linux host: Node's install, egress.mjs and boxd's beebotd relay socket.
  nodeDir: string;
  script: string;
  relayDir: string;
  testUpstreams?: Record<string, string> | undefined;
  log: (line: string) => void;
  // The proxy went away: every box lost its way out, so boxd must stop.
  onExit: () => void;
};

// The proxy runs as its own locked-down container on an upstream network that has a route out,
// and joins each box network at a fixed address. It lives as long as boxd holds its stdin.
export function createPodmanEgress(options: PodmanEgressOptions): Egress {
  const { podman, prefix, owner, labels, log } = options;
  const container = `${prefix}-egress`;
  const upstream = `${prefix}-egress-up`;
  const labelArgs = Object.entries({ ...labels, "beebot.owner": owner }).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  let link: { child: Child; send: (message: object) => Promise<void> } | null = null;

  async function ok(args: string[]) {
    const result = await podman.run(args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `podman ${args.slice(0, 2).join(" ")} failed`);
    }
    return result.stdout.trim();
  }

  function lines(child: Child, onLine: (line: string) => void) {
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      parts.forEach(onLine);
    });
  }

  function control() {
    return podman.spawn(["exec", "-i", container, "/opt/node/bin/node", "-e", relay], {});
  }

  function connectControl() {
    const child = control();
    const waiting: ((reply: string) => void)[] = [];
    lines(child, (line) => waiting.shift()?.(line));
    void child.exited.then(() => {
      for (const resolve of waiting.splice(0)) {
        resolve("closed");
      }
      log("egress: boxd's control connection closed");
      options.onExit();
    });
    return {
      child,
      send: (message: object) =>
        new Promise<void>((resolve, reject) => {
          waiting.push((reply) =>
            reply === '{"ok":true}' ? resolve() : reject(new Error(`egress refused: ${reply}`)),
          );
          child.stdin.write(`${JSON.stringify(message)}\n`);
        }),
    };
  }

  async function join(network: string) {
    const subnet = await ok([
      "network",
      "inspect",
      network,
      "--format",
      "{{range .Subnets}}{{.Subnet}}{{end}}",
    ]);
    const address = proxyAddress(subnet);
    const connect = await podman.run(["network", "connect", "--ip", address, network, container]);
    if (connect.code !== 0 && !/already/i.test(connect.stderr)) {
      throw new Error(connect.stderr.trim() || "podman network connect failed");
    }
    await link?.send({ type: "listen", address });
    return address;
  }

  return {
    start: async () => {
      await podman.run(["rm", "-f", "-t", "0", container]);
      if ((await podman.run(["network", "exists", upstream])).code !== 0) {
        await ok([
          "network",
          "create",
          "--disable-dns",
          "--opt",
          "isolate=true",
          ...labelArgs,
          upstream,
        ]);
      }
      const child = podman.spawn(
        [
          "run",
          "--rm",
          "-i",
          "--init",
          "--name",
          container,
          ...labelArgs,
          "--pull=never",
          "--user",
          "10002:10002",
          "--cap-drop=all",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--tmpfs",
          "/run/egress:rw,mode=0700,U",
          "--sysctl",
          "net.ipv4.ip_unprivileged_port_start=53",
          "--memory",
          "256m",
          "--pids-limit",
          "128",
          "--network",
          upstream,
          "-v",
          `${options.nodeDir}:/opt/node:ro`,
          "-v",
          `${options.script}:/opt/egress/egress.mjs:ro`,
          "-v",
          `${options.relayDir}:/run/bee-relay:ro`,
          options.image,
          "/opt/node/bin/node",
          "/opt/egress/egress.mjs",
        ],
        {},
      );
      const ready = new Promise<void>((resolve, reject) => {
        lines(child, (line) => {
          if (line.includes('"ev":"ready"')) {
            resolve();
          } else {
            log(`egress: ${line}`);
          }
        });
        void child.exited.then((code) => {
          reject(new Error(`egress proxy exited (${code})`));
          options.onExit();
        });
      });
      child.stdin.write(
        `${JSON.stringify({
          listen: ["127.0.0.1"],
          dnsPort: 53,
          proxyPort: 3128,
          apiPort: 8080,
          control: controlSocket,
          bee: "/run/bee-relay/bee.sock",
          ...(options.testUpstreams && { testUpstreams: options.testUpstreams }),
        })}\n`,
      );
      await ready;
      link = connectControl();
      // A restarted proxy joins every box network again, at the same address.
      const listed = await ok([
        "network",
        "ls",
        "--filter",
        `label=beebot.owner=${owner}`,
        "--filter",
        "label=beebot.role",
        "--format",
        "{{.Name}}",
      ]);
      for (const network of listed.split("\n").filter(Boolean)) {
        await join(network);
      }
    },
    attach: async ({ name }) => {
      const address = await join(name);
      return {
        dns: address,
        hosts: { [proxyHost]: address },
        env: {
          HTTPS_PROXY: `http://${proxyHost}:3128`,
          https_proxy: `http://${proxyHost}:3128`,
          NO_PROXY: proxyHost,
          no_proxy: proxyHost,
        },
      };
    },
    bind: async (address, botId) => {
      await link?.send({ type: "bind", address, botId });
    },
    // Only the proxy is disconnected: a forced `network rm` would remove the proxy itself.
    detach: async (network) => {
      const result = await podman.run(["network", "disconnect", "-f", network, container]);
      if (result.code !== 0 && !/not connected|no such/i.test(result.stderr)) {
        throw new Error(result.stderr.trim() || "podman network disconnect failed");
      }
    },
    unbind: async (address) => {
      await link?.send({ type: "unbind", address });
    },
    control: () => (link === null ? null : control()),
  };
}
