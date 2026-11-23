import { type Bot, type ChatState, limitDefaults, type Task } from "@beebot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it, vi } from "vite-plus/test";

let TeamPanel: typeof import("./TeamPanel").TeamPanel;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { search: "" } });
  ({ TeamPanel } = await import("./TeamPanel"));
});

const bot = (id: string, name: string) => ({ id, name }) as Bot;

const task: Task = {
  id: "t1",
  kind: "delegate",
  chainId: "c1",
  hop: 1,
  depth: 1,
  parentRunId: "r1",
  requesterBotId: "ada",
  ownerBotId: "ben",
  roomId: "room",
  goal: "Draft the hero\nwith a bold headline",
  status: "queued",
  resultMessageId: null,
  createdAt: "2026-11-23T00:00:00.000Z",
  updatedAt: "2026-11-23T00:00:00.000Z",
};

it("shows account caps, limits and queued work", () => {
  const chat = {
    bots: [bot("ada", "Ada"), bot("ben", "Ben")],
    accounts: [
      {
        id: "claude",
        label: "Claude",
        lane: "subscription",
        blockedUntil: null,
        maxConcurrentRuns: 2,
      },
      {
        id: "fake",
        label: "Test engine",
        lane: "subscription",
        blockedUntil: null,
        maxConcurrentRuns: 1,
      },
    ],
    limits: limitDefaults,
    tasks: [task],
  } as ChatState;
  const html = renderToStaticMarkup(<TeamPanel chat={chat} />);
  expect(html).toContain("Claude");
  expect(html).toContain('value="2"');
  expect(html).not.toContain("Test engine");
  expect(html).toContain("Delegation depth");
  expect(html).toContain("Queued · Draft the hero · from Ada");
});
