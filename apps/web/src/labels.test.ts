import type { MemoryItem } from "@beebot/contracts";
import { expect, it } from "vite-plus/test";

import {
  folderName,
  formatElapsed,
  liveStatusLine,
  liveThoughtLine,
  memoryReview,
  projectPathValue,
  toolRowLabel,
  visibleDetail,
  workedLine,
} from "./labels";

it("shows characters that would hide or reorder a command, and leaves layout alone", () => {
  expect(visibleDetail("ls\n\tcat ‮gpj.exe\u0000")).toBe("ls\n\tcat [U+202E]gpj.exe[U+0000]");
});

it("takes a folder as Windows' Copy as path gives it, and empty as no folder", () => {
  expect(projectPathValue('  "D:\\My Work\\app"  ')).toBe("D:\\My Work\\app");
  expect(projectPathValue("'/home/ada/app'")).toBe("/home/ada/app");
  expect(projectPathValue("D:\\app")).toBe("D:\\app");
  expect(projectPathValue('  ""  ')).toBeNull();
  expect(projectPathValue("   ")).toBeNull();
});

it("names a folder by its last segment", () => {
  expect(folderName("D:\\work\\bee-bot")).toBe("bee-bot");
  expect(folderName("/home/ada/app/")).toBe("app");
});

it("formats a turn's time the way the timer reads", () => {
  expect(formatElapsed(9_400)).toBe("9s");
  expect(formatElapsed(62_000)).toBe("1m 02s");
  expect(formatElapsed(3_720_000)).toBe("1h 02m");
  expect(workedLine(62_000, 1)).toBe("Worked for 1m 02s · 1 tool");
  expect(workedLine(null, 2)).toBe("Worked · 2 tools");
});

it("labels tool rows by state, and by name alone after a reload", () => {
  const read = { name: "Read", detail: "notes.md" };
  expect(toolRowLabel({ ...read, status: "running" })).toBe("Reading notes.md");
  expect(toolRowLabel({ ...read, status: "done" })).toBe("Read notes.md");
  expect(toolRowLabel({ ...read, detail: null, status: "done" })).toBe("Read a file");
  expect(toolRowLabel({ name: "constructor", detail: null, status: "done" })).toBe("constructor");
});

it("announces status changes and takes the newest thought line", () => {
  const tool = { id: "a", name: "Bash", detail: "ls" };
  expect(liveStatusLine(true, [], false)).toBe("Thinking");
  expect(liveStatusLine(false, [{ ...tool, status: "failed" }], false)).toBe("Ran ls failed");
  expect(liveStatusLine(false, [{ ...tool, status: "running" }], false)).toBe("Running ls");
  expect(liveStatusLine(false, [], true)).toBe("Writing a reply");
  expect(liveThoughtLine("first\n  second \n")).toBe("second");
});

const memory = (id: string, fields: Partial<MemoryItem>): MemoryItem => ({
  id,
  botId: "bot",
  type: "user",
  source: "agent",
  sourceRef: "run:run",
  status: "pending",
  created: "2026-11-06T10:15:00.000Z",
  supersededBy: null,
  text: id,
  ...fields,
});

it("shows what a pending request would do to its target", () => {
  const target = memory("t", { status: "active", text: "Likes tea" });
  const texts = (item: MemoryItem) => memoryReview(item, [target]).lines.map(({ text }) => text);

  expect(texts(memory("plain", { text: "Likes coffee" }))).toEqual(["Likes coffee"]);
  expect(texts(memory("s", { sourceRef: "supersede:t", text: "Likes coffee" }))).toEqual([
    "Likes tea",
    "Likes coffee",
  ]);
  expect(texts(memory("f", { sourceRef: "forget:t", text: "Out of date" }))).toEqual([
    "Likes tea",
    "Out of date",
  ]);
});

it("says so when the target of a pending request is no longer active", () => {
  const gone = [memory("t", { status: "pending", text: "Likes tea" })];
  const supersede = memoryReview(memory("s", { sourceRef: "supersede:t" }), gone);
  const forget = memoryReview(memory("f", { sourceRef: "forget:t" }), []);

  expect(supersede.title).toContain("adds this as new");
  expect(supersede.lines.map(({ text }) => text)).toEqual(["s"]);
  expect(forget.title).toContain("changes nothing");
});
