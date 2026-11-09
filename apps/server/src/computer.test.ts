import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";

import type { InputAction } from "@beebot/boxd/protocol";
import { describe, expect, it } from "vite-plus/test";

import type { AuditRecord } from "./audit.ts";
import type { Activity } from "./browser.ts";
import type { PolicyDecision } from "./broker.ts";
import { freshLease, type Lease } from "./browserLease.ts";
import { computerExecutors, createComputer, glide, type ToolContent } from "./computer.ts";
import { answerMcp } from "./mcp.ts";

const run = { id: "run-1", botId: "bot-1", attended: true };

function setup(decision: PolicyDecision = { kind: "allow" }) {
  const inputs: InputAction[][] = [];
  const audits: AuditRecord[] = [];
  const activities: Activity[] = [];
  const approvals: unknown[] = [];
  const state = { lease: freshLease as Lease, screen: "screen-1", observed: 0 };
  const computer = createComputer({
    screen: (botId) =>
      botId === "bot-1"
        ? {
            input: async (_botId, actions) => {
              inputs.push(actions);
            },
            screenshot: async () => Buffer.from(state.screen),
          }
        : undefined,
    check: () => decision,
    appendAudit: (record) => audits.push(record),
    requestApproval: (_run, tool, args) => {
      approvals.push({ tool, args });
      return "waiting for the owner";
    },
    lease: () => state.lease,
    observed: () => {
      state.observed += 1;
      state.lease = { ...state.lease, mustObserve: false };
    },
    activity: (_botId, activity) => activities.push(activity),
  });
  return { computer, inputs, audits, activities, approvals, state };
}

const image = (screen: string): ToolContent[] => [
  { type: "image", data: Buffer.from(screen).toString("base64"), mimeType: "image/png" },
];
const refusal = (content: ToolContent[]) =>
  content[0]?.type === "text" ? JSON.parse(content[0].text) : undefined;
const moves = (actions: InputAction[]) => actions.filter(({ type }) => type === "move");

describe("glide", () => {
  it("moves in 8 to 15 steps and ends exactly on the target", () => {
    const near = glide({ x: 640, y: 400 }, { x: 650, y: 400 });
    expect(moves(near)).toHaveLength(8);
    expect(near.at(-2)).toEqual({ type: "move", x: 650, y: 400 });
    const far = glide({ x: 0, y: 0 }, { x: 1279, y: 799 });
    expect(moves(far)).toHaveLength(15);
    expect(far.at(-2)).toEqual({ type: "move", x: 1279, y: 799 });
    expect(far.filter(({ type }) => type === "wait")).toHaveLength(15);
  });
});

describe("computer tools", () => {
  it("glides to the target, clicks, shows the ripple and answers with the screenshot", async () => {
    const { computer, inputs, activities } = setup();
    expect(await computer.call(run, "computer_click", { x: 100, y: 200, double: true })).toEqual(
      image("screen-1"),
    );
    expect(inputs[0]?.at(-1)).toEqual({ type: "click", button: 1, count: 2 });
    expect(moves(inputs[0] ?? []).at(-1)).toEqual({ type: "move", x: 100, y: 200 });
    expect(activities).toEqual([{ kind: "click", x: 100 / 1280, y: 200 / 800, text: null }]);

    await computer.call(run, "computer_drag", { from: [100, 200], to: [300, 400] });
    const drag = inputs[1] ?? [];
    expect(drag.filter(({ type }) => type === "down" || type === "up")).toHaveLength(2);
    // It starts from where the last click left the pointer.
    expect(drag[0]).toEqual({ type: "move", x: 100, y: 200 });
    expect(moves(drag).at(-1)).toEqual({ type: "move", x: 300, y: 400 });
  });

  it("never shows what it typed", async () => {
    const { computer, inputs, activities } = setup();
    await computer.call(run, "computer_type", { text: "hunter2" });
    expect(inputs).toEqual([[{ type: "type", text: "hunter2" }]]);
    expect(activities[0]?.text).toBe("•••");
    await computer.call(run, "computer_key", { keys: "ctrl+s" });
    expect(activities[1]).toMatchObject({ kind: "key", text: "ctrl+s" });
  });

  it("refuses, never queues, while the owner holds the computer, and audits it", async () => {
    const { computer, inputs, audits, state } = setup();
    state.lease = { ...freshLease, holder: "human", leaseId: "lease-1" };
    for (const tool of ["computer_screenshot", "computer_scroll"]) {
      const answer = await computer.call(run, tool, { x: 1, y: 1, direction: "down" });
      expect(refusal(answer)).toMatchObject({ status: "refused" });
    }
    expect(inputs).toEqual([]);
    expect(audits).toMatchObject([
      { status: "refused", reason: "human_has_control", tool: "computer_screenshot" },
      { status: "refused", reason: "human_has_control", tool: "computer_scroll" },
    ]);
  });

  it("after a handback, acts only once the bot has taken a screenshot", async () => {
    const { computer, inputs, state } = setup();
    state.lease = { ...freshLease, generation: 3, mustObserve: true };
    const stale = await computer.call(run, "computer_click", { x: 1, y: 1 });
    expect(refusal(stale).reason).toContain("computer_screenshot");
    expect(inputs).toEqual([]);
    expect(await computer.call(run, "computer_screenshot", {})).toEqual(image("screen-1"));
    expect(state.lease.mustObserve).toBe(false);
    await computer.call(run, "computer_click", { x: 1, y: 1 });
    expect(inputs).toHaveLength(1);
  });

  it("answers an unchanged screen with text instead of the same image again", async () => {
    const { computer, state } = setup();
    expect(await computer.call(run, "computer_screenshot", {})).toEqual(image("screen-1"));
    expect(await computer.call(run, "computer_key", { keys: "Escape" })).toEqual([
      { type: "text", text: "The screen is unchanged since your last screenshot." },
    ]);
    state.screen = "screen-2";
    expect(await computer.call(run, "computer_screenshot", {})).toEqual(image("screen-2"));
    // A new run has seen nothing yet.
    expect(await computer.call({ ...run, id: "run-2" }, "computer_screenshot", {})).toEqual(
      image("screen-2"),
    );
  });

  it("asks the owner, or refuses, as the broker says, before touching the screen", async () => {
    const asked = setup({ kind: "approve" });
    expect(await asked.computer.call(run, "computer_type", { text: "hi" })).toEqual([
      { type: "text", text: "waiting for the owner" },
    ]);
    expect(asked.approvals).toEqual([{ tool: "computer_type", args: { text: "hi" } }]);
    const denied = setup({ kind: "deny", reason: "nobody_watching" });
    const answer = await denied.computer.call(run, "computer_click", { x: 1, y: 1 });
    expect(refusal(answer)).toMatchObject({ status: "refused", reason: "nobody_watching" });
    for (const { inputs } of [asked, denied]) {
      expect(inputs).toEqual([]);
    }
  });

  it("refuses bad arguments and bots without a box", async () => {
    const { computer, inputs } = setup();
    for (const [tool, args] of [
      ["computer_click", { x: 1280, y: 0 }],
      ["computer_key", { keys: "--window 1" }],
      ["computer_scroll", { x: 1, y: 1, direction: "down", amount: 21 }],
      ["computer_type", { text: "" }],
    ] as const) {
      expect(refusal(await computer.call(run, tool, args)), tool).toMatchObject({
        status: "refused",
      });
    }
    const hostBot = await computer.call({ ...run, botId: "bot-2" }, "computer_screenshot", {});
    expect(refusal(hostBot).reason).toContain("box");
    expect(inputs).toEqual([]);
  });

  it("runs an approved action as the continuation's executor", async () => {
    const { computer, inputs, state } = setup({ kind: "approve" });
    const execute = new Map(computerExecutors(computer)).get("computer_click");
    const payload = JSON.stringify({ tool: "computer_click", input: { x: 5, y: 6 } });
    const call = { botId: "bot-1", runId: "run-1", tool: "computer_click", payload };
    expect(await execute?.(call)).toMatchObject({
      ok: true,
      output: expect.stringContaining("screenshot"),
    });
    expect(inputs[0]?.at(-1)).toEqual({ type: "click", button: 1, count: 1 });
    state.lease = { ...freshLease, holder: "human", leaseId: "lease-1" };
    expect(await execute?.(call)).toMatchObject({ ok: false });
  });

  it("runs an approved screenshot, which an Operator's first one needs", async () => {
    const { computer } = setup({ kind: "approve" });
    const execute = new Map(computerExecutors(computer)).get("computer_screenshot");
    const payload = JSON.stringify({ tool: "computer_screenshot", input: {} });
    const call = { botId: "bot-1", runId: "run-1", tool: "computer_screenshot", payload };
    expect(await execute?.(call)).toMatchObject({ ok: true });
  });
});

describe("MCP", () => {
  it("answers a computer tool with its image content", async () => {
    const shot = image("png-bytes");
    const server = NodeHttp.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      await answerMcp(
        response,
        String(Buffer.concat(chunks)),
        async () => ({ behavior: "deny", message: "" }),
        () => "",
        () => "",
        async () => "",
        async () => shot,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "computer_screenshot", arguments: {} },
        }),
      });
      const called = await response.json();
      expect(called).toEqual({ jsonrpc: "2.0", id: 2, result: { content: shot } });
    } finally {
      server.close();
    }
  });
});
