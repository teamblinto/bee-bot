import type { UsageWindow } from "@beebot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it, vi } from "vite-plus/test";

const window = (fields: Partial<UsageWindow>): UsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  windowDurationMins: 300,
  usedPercent: 43,
  resetsAt: "2026-11-06T06:00:00.000Z",
  status: null,
  ...fields,
});
const now = Date.parse("2026-11-06T04:00:00.000Z");

let LimitWindows: typeof import("./UsagePage").LimitWindows;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { search: "" } });
  ({ LimitWindows } = await import("./UsagePage"));
});

const render = (windows: UsageWindow[]) =>
  renderToStaticMarkup(<LimitWindows windows={windows} now={now} />);

it("shows what is left, the reset, and a pace mark", () => {
  const html = render([window({})]);
  expect(html).toContain("57% left");
  expect(html).toContain("resets in 2h 0m");
  expect(html).toContain("Under pace");
});

it("never renders an unknown percentage as a number", () => {
  const html = render([window({ usedPercent: null })]);
  expect(html).toContain("Not reported yet");
  expect(html).not.toContain("% left");
  expect(html).not.toContain("0%");
});
