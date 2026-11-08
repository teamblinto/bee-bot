import type { EngineStatus, MemoryItem, Run } from "@beebot/contracts";
import { expect, it } from "vite-plus/test";

import {
  changeLines,
  folderName,
  formatElapsed,
  liveStatusLine,
  liveThoughtLine,
  memoryReview,
  pauseLine,
  projectPathValue,
  runLine,
  testedCodexVersion,
  toolRowLabel,
  visibleDetail,
  workedLine,
} from "./labels";

it("shows characters that would hide or reorder a command, and leaves layout alone", () => {
  expect(visibleDetail("ls\n\tcat ‮gpj.exe\u0000")).toBe("ls\n\tcat [U+202E]gpj.exe[U+0000]");
});

it("prefixes each line of a change, for LF and CRLF alike", () => {
  expect(changeLines("+ ", "one\n\ntwo")).toBe("+ one\n+ \n+ two");
  expect(changeLines("- ", "one\r\ntwo\r\n")).toBe("- one\n- two\n- ");
});

it("gives empty text no lines, so an edit that only removes adds nothing", () => {
  expect(changeLines("+ ", "")).toBe("");
});

it("makes hidden characters in a file's content visible on every line", () => {
  expect(changeLines("+ ", "safe‮txt.exe\nzero​width\nlone\rreturn")).toBe(
    "+ safe[U+202E]txt.exe\n+ zero[U+200B]width\n+ lone[U+000D]return",
  );
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

it("sends a paused Codex bot to Codex's own fix, and a Claude bot to Claude's", () => {
  const claude = { testedVersion: "2.0.0" } as EngineStatus;
  expect(pauseLine("auth_failed", "claude")).toContain("claude auth login");
  expect(pauseLine("cli_version", "claude", claude)).toContain("version 2.0.0");

  expect(pauseLine("auth_failed", "codex")).toContain("codex login");
  expect(pauseLine("cli_missing", "codex")).toContain("Codex CLI");
  expect(pauseLine("cli_version", "codex", claude)).toBe(
    `This Codex version is untested. Install version ${testedCodexVersion}, then Resume.`,
  );
  expect(pauseLine("owner", "codex")).toBe(pauseLine("owner", "claude"));
});

it("tells a bot on the wrong login how to log in its account's way", () => {
  const line = (accountId: string, lane: "subscription" | "api_key") =>
    pauseLine("credential_source", accountId, undefined, lane);
  expect(line("claude", "subscription")).toContain("Claude account");
  expect(line("claude", "api_key")).toContain("Console account");
  expect(line("codex", "subscription")).toContain("sign in with ChatGPT");
  expect(line("codex", "api_key")).toContain("codex login --with-api-key");
});

it("doesn't blame Claude when a Codex bot's login fails mid-run", () => {
  const run: Run = {
    id: "run",
    botId: "bot",
    status: "Refused",
    reason: "auth_failed",
    createdAt: "2026-11-06T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    chainId: null,
    hop: 0,
    depth: 0,
    taskId: null,
  };
  expect(runLine(run, undefined)).not.toContain("Claude");
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
