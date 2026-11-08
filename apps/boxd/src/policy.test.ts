import * as NodeFs from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  boxNames,
  type EgressAttachment,
  boxState,
  containerSpec,
  createArgs,
  networkArgs,
  ownedBy,
  ownershipLabels,
  parseRunSpec,
} from "./policy.ts";
import { testRunSpec } from "./testing.ts";

const secret = Buffer.alloc(32, 7);
const box = { prefix: "beebot", owner: "env-1", botId: "bot-1" };
const spec = (role: "engine" | "browser", egress: EgressAttachment = { dns: null, env: {} }) =>
  containerSpec(role, {
    box,
    secret,
    runSpec: testRunSpec,
    seccomp: "/opt/boxd/seccomp-chromium.json",
    egress,
    labels: { "beebot-dev": "1" },
  });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

const imageSpec = NodeFs.readFileSync(
  new URL("../../../images/box/runSpec.json", import.meta.url),
  "utf8",
);

describe("run spec", () => {
  it("reads the image's own spec", () => {
    const parsed = parseRunSpec(imageSpec);
    expect(parsed.engine).toMatchObject({
      user: "10001:10001",
      home: "/home/bee",
      volumes: { home: "/home/bee", workspace: "/work" },
      seccomp: false,
    });
    expect(parsed.browser).toMatchObject({
      home: "/browser",
      hostname: "bee-browser",
      seccomp: true,
    });
  });

  it("refuses root and malformed users", () => {
    const text = (user: string) => JSON.stringify({ ...JSON.parse(imageSpec), user });
    expect(() => parseRunSpec(text("0:0"))).toThrow("non-root");
    expect(() => parseRunSpec(text("root"))).toThrow("non-root");
    expect(parseRunSpec(text("10002:10002")).browser.user).toBe("10002:10002");
  });

  it.each([
    ["capDrop", "chown"],
    ["readOnly", false],
    ["securityOpt", ["no-new-privileges", "label=disable"]],
  ])("refuses a spec that weakens %s", (key, value) => {
    const json = JSON.parse(imageSpec);
    json.engine[key] = value;
    expect(() => parseRunSpec(JSON.stringify(json))).toThrow("must drop all caps");
  });
});

describe("container specs", () => {
  it.each(["engine", "browser"] as const)("locks down the %s container", (role) => {
    const args = createArgs(spec(role));
    expect(args).toContain("--cap-drop=all");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("--pull=never");
    expect(flag(args, "--user")).toBe("10001:10001");
    expect(flag(args, "--memory")).toMatch(/^\d+g$/);
    expect(flag(args, "--memory-swap")).toBe(flag(args, "--memory"));
    expect(Number(flag(args, "--cpus"))).toBeGreaterThan(0);
    expect(Number(flag(args, "--pids-limit"))).toBeGreaterThan(0);
  });

  it("gives the sidecar the Chromium seccomp profile and a fixed hostname", () => {
    const browser = createArgs(spec("browser"));
    expect(browser).toContain("seccomp=/opt/boxd/seccomp-chromium.json");
    expect(flag(browser, "--hostname")).toBe("bee-browser");
    expect(createArgs(spec("engine")).some((arg) => arg.startsWith("seccomp="))).toBe(false);
  });

  it("keeps the engine and the sidecar on separate networks and volumes", () => {
    const names = boxNames(box);
    const engine = createArgs(spec("engine"));
    const browser = createArgs(spec("browser"));
    expect(flag(engine, "--network")).toBe(names.network.engine);
    expect(flag(browser, "--network")).toBe(names.network.browser);
    expect(engine).toContain(`${names.volume("engine", "workspace")}:/work`);
    expect(engine.join(" ")).not.toContain(names.volume("browser", "profile"));
    expect(browser.join(" ")).not.toContain(names.volume("engine", "home"));
  });

  it("isolates every network and gives it no gateway or resolver", () => {
    const args = networkArgs("n", {});
    expect(args).toContain("--internal");
    expect(args).toContain("--disable-dns");
    expect(flag(args, "--opt")).toBe("isolate=true");
  });

  it("passes env values outside argv", () => {
    const egress = { dns: "10.0.0.2", env: { HTTPS_PROXY: "http://10.0.0.2:3128" } };
    const engine = spec("engine", egress);
    const args = createArgs(engine);
    expect(flag(args, "--dns")).toBe("10.0.0.2");
    expect(args.join(" ")).not.toContain("http://10.0.0.2:3128");
    expect(engine.env.HTTPS_PROXY).toBe("http://10.0.0.2:3128");
  });

  it("binds host directories without exec or device files", () => {
    const engine = createArgs(
      containerSpec("engine", {
        box,
        secret,
        runSpec: testRunSpec,
        seccomp: "/s.json",
        egress: { dns: null, env: {}, hosts: { "proxy.beebot": "10.0.0.2" } },
        labels: {},
        binds: [{ source: "/state/bots/bot-1/box", target: "/run/bee/bot", readOnly: true }],
      }),
    );
    expect(engine).toContain("/state/bots/bot-1/box:/run/bee/bot:ro,nosuid,nodev,noexec");
    expect(flag(engine, "--add-host")).toBe("proxy.beebot:10.0.0.2");
  });

  it("has no way out without an egress proxy", () => {
    expect(flag(createArgs(spec("engine")), "--dns")).toBe("none");
  });
});

describe("ownership", () => {
  it("accepts only labels signed with this secret for this resource", () => {
    const labels = ownershipLabels(secret, box, "engine", "beebot-bot-1-engine");
    expect(ownedBy(secret, box, "beebot-bot-1-engine", labels)).toBe(true);
    expect(ownedBy(secret, box, "beebot-bot-1-browser", labels)).toBe(false);
    expect(ownedBy(Buffer.alloc(32, 8), box, "beebot-bot-1-engine", labels)).toBe(false);
    expect(ownedBy(secret, { ...box, botId: "bot-2" }, "beebot-bot-1-engine", labels)).toBe(false);
  });
});

describe("box state", () => {
  const up = { owned: true, running: true, oomKilled: false };
  const down = { ...up, running: false };
  it("reports the pair as one state", () => {
    expect(boxState(null, null).state).toBe("absent");
    expect(boxState(up, up).state).toBe("running");
    expect(boxState(down, down).state).toBe("stopped");
    expect(boxState(up, down)).toEqual({ state: "failed", reason: "browser stopped" });
    expect(boxState(up, null).state).toBe("failed");
    expect(boxState({ ...up, owned: false }, up).state).toBe("failed");
    expect(boxState({ ...down, oomKilled: true }, down).reason).toBe("engine ran out of memory");
  });
});
