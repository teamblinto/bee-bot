import { afterEach, expect, it } from "vite-plus/test";

import { logJson } from "./jsonLog.ts";

const original = { ...console };

afterEach(() => {
  Object.assign(console, original);
});

it("writes one JSON object per line with ts, level and msg", () => {
  const lines: string[] = [];
  logJson((line) => lines.push(line));
  console.error("beebotd: box for %s didn't come up", "b1");
  console.info("listening");
  console.error(new TypeError("boom"));
  expect(lines.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(
    true,
  );
  const [first, second, third] = lines.map((line) => JSON.parse(line));
  expect(first).toMatchObject({ level: "error", msg: "box for b1 didn't come up" });
  expect(Number.isNaN(Date.parse(first.ts))).toBe(false);
  expect(second).toMatchObject({ level: "info", msg: "listening" });
  expect(third).toMatchObject({ level: "error", msg: "boom", error: { name: "TypeError" } });
});
