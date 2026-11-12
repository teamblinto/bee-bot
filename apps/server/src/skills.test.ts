import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Bot } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { personaText } from "./engine.ts";
import { pathPolicy } from "./pathPolicy.ts";
import {
  type LaunchSkill,
  parseSkillMd,
  prepareSkill,
  readSkillFolder,
  skillFolder,
  skillsText,
} from "./skills.ts";
import { type EventStore, openEventStore } from "./store.ts";

let dataDir: string;
let store: EventStore;

beforeEach(() => {
  dataDir = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-skills-")),
  );
  store = openEventStore(dataDir);
});

afterEach(() => {
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const skillMd = (name: string, description = `Does ${name} things.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });

function addSkill(name: string, files = [file("SKILL.md", skillMd(name))]) {
  const prepared = prepareSkill(files);
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }
  const added = store.addSkill(prepared, "pasted");
  if (typeof added === "string") {
    throw new Error(added);
  }
  return added;
}

const enable = (bot: Bot, name: string) => {
  const skill = store.getSkill(name);
  store.reviewSkill(name, skill?.sha256 ?? "");
  return store.setBotSkill(bot.id, name, true);
};

const addBot = (name = "Ada") =>
  store.createBot({ name, personality: "", engineAccountId: "fake" });

function launchOf(bot: Bot) {
  store.sendMessage({
    id: NodeCrypto.randomUUID(),
    roomId: bot.roomId,
    body: "hi",
    attended: true,
  });
  const now = new Date().toISOString();
  store.dueWakes(now).forEach(store.queueRun);
  const run = store.queuedRuns()[0];
  const claimed = store.claimRun(run?.id ?? "", "boot", now);
  if (!claimed) {
    throw new Error("the run was not claimed");
  }
  store.finishRun(claimed.id, "boot", { status: "Completed", reason: null, reply: "done" });
  return claimed.launch;
}

describe("a skill's files", () => {
  it("refuse a path that leaves the folder, hides, or names a device", () => {
    for (const path of [
      "../x.md",
      "a/../../x",
      "/etc/passwd",
      ".env",
      "a/.git/config",
      "NUL",
      "con.txt",
      "a/aux",
      "trail.",
    ]) {
      expect(prepareSkill([file("SKILL.md", skillMd("ok")), file(path, "x")])).toMatchObject({
        error: "skill_bad_path",
      });
    }
  });

  it("refuse a folder holding a link", () => {
    const folder = NodePath.join(dataDir, "incoming");
    NodeFS.mkdirSync(folder);
    NodeFS.writeFileSync(NodePath.join(folder, "SKILL.md"), skillMd("linked"));
    NodeFS.symlinkSync(dataDir, NodePath.join(folder, "escape"), "junction");
    expect(readSkillFolder(folder)).toMatchObject({ error: "skill_link", path: "escape" });
  });

  it("refuse more than the caps", () => {
    const big = file("SKILL.md", skillMd("big") + "x".repeat(256 * 1024));
    expect(prepareSkill([big])).toMatchObject({ error: "skill_md_too_large" });
    const many = Array.from({ length: 200 }, (_, index) => file(`f${index}.txt`, "x"));
    expect(prepareSkill([file("SKILL.md", skillMd("many")), ...many])).toMatchObject({
      error: "skill_too_many_files",
    });
    const heavy = file("blob.bin", "x".repeat(16 * 1024 * 1024));
    expect(prepareSkill([file("SKILL.md", skillMd("heavy")), heavy])).toMatchObject({
      error: "skill_too_large",
    });
  });

  it("need a valid name and description in the front matter", () => {
    expect(parseSkillMd("# no front matter")).toMatchObject({ error: "skill_no_front_matter" });
    expect(parseSkillMd(skillMd("Bad_Name"))).toMatchObject({ error: "skill_bad_name" });
    expect(parseSkillMd(skillMd("../up"))).toMatchObject({ error: "skill_bad_name" });
    expect(parseSkillMd(skillMd("a".repeat(65)))).toMatchObject({ error: "skill_bad_name" });
    expect(parseSkillMd(skillMd("long", "x".repeat(1025)))).toMatchObject({
      error: "skill_bad_description",
    });
    expect(parseSkillMd('---\nname: "quoted"\ndescription: >\n  Folded\n  text.\n---\n')).toEqual({
      name: "quoted",
      description: "Folded text.",
    });
  });
});

describe("turning a skill on", () => {
  it("needs the owner to have seen exactly what is there now", () => {
    const bot = addBot();
    const skill = addSkill("pdf");
    expect(store.setBotSkill(bot.id, "pdf", true)).toBe("skill_not_reviewed");
    expect(store.reviewSkill("pdf", "f".repeat(64))).toBe("skill_changed");
    expect(store.reviewSkill("pdf", skill.sha256 ?? "")).toMatchObject({ name: "pdf" });
    expect(store.setBotSkill(bot.id, "pdf", true)).toMatchObject({ botIds: [bot.id] });
  });
});

describe("a launch", () => {
  it("leaves out a skill whose files changed since review", () => {
    const bot = addBot();
    addSkill("pdf");
    addSkill("csv");
    enable(bot, "pdf");
    enable(bot, "csv");
    NodeFS.appendFileSync(NodePath.join(skillFolder(dataDir, "pdf"), "SKILL.md"), "\nDo more.");
    expect(launchOf(bot).skills.map(({ name }) => name)).toEqual(["csv"]);
    expect(store.getSkill("pdf")).toMatchObject({ reviewedSha256: expect.any(String) });
    expect(store.getSkill("pdf")?.sha256).not.toBe(store.getSkill("pdf")?.reviewedSha256);
  });

  it("drops a skill taken off the bot, or deleted, from the next launch", () => {
    const ada = addBot();
    const bea = addBot("Bea");
    addSkill("pdf");
    addSkill("csv");
    enable(ada, "pdf");
    enable(ada, "csv");
    enable(bea, "csv");
    expect(launchOf(ada).skills.map(({ name }) => name)).toEqual(["csv", "pdf"]);
    store.setBotSkill(ada.id, "pdf", false);
    expect(launchOf(ada).skills.map(({ name }) => name)).toEqual(["csv"]);
    expect(store.deleteSkill("csv")).toBe(true);
    expect(launchOf(ada).skills).toEqual([]);
    expect(launchOf(bea).skills).toEqual([]);
    expect(NodeFS.existsSync(skillFolder(dataDir, "csv"))).toBe(false);
  });

  it("puts each skill's SKILL.md path in the persona", () => {
    const bot = addBot();
    addSkill("pdf");
    enable(bot, "pdf");
    const launch = launchOf(bot);
    const expected = NodePath.join(dataDir, "skills", "pdf", "SKILL.md");
    expect(personaText(launch)).toContain(`- pdf: Does pdf things. Read "${expected}"`);
  });

  it("keeps the review through a restart, and finds a folder dropped in as unreviewed", () => {
    const bot = addBot();
    addSkill("pdf");
    enable(bot, "pdf");
    NodeFS.mkdirSync(skillFolder(dataDir, "new"));
    NodeFS.writeFileSync(NodePath.join(skillFolder(dataDir, "new"), "SKILL.md"), skillMd("new"));
    store.close();
    store = openEventStore(dataDir);
    expect(store.state().skills).toMatchObject([
      { name: "new", reviewedAt: null, botIds: [] },
      { name: "pdf", botIds: [bot.id] },
    ]);
    expect(launchOf(bot).skills.map(({ name }) => name)).toEqual(["pdf"]);
  });
});

describe("the prompt's skill list", () => {
  const skill = (index: number, description = "Short."): LaunchSkill => ({
    name: `skill-${index}`,
    description,
    sha256: "a".repeat(64),
  });

  it("lists every skill when they fit", () => {
    const text = skillsText([skill(1), skill(2)], "/run/bee/skills");
    expect(text).toContain('- skill-1: Short. Read "/run/bee/skills/skill-1/SKILL.md"');
    expect(text).not.toContain("cut");
  });

  it("stops at 30 skills and says it was cut", () => {
    const text = skillsText(
      Array.from({ length: 31 }, (_, index) => skill(index)),
      "/run/bee/skills",
    );
    expect(text.match(/^- /gm)).toHaveLength(30);
    expect(text).toContain("The list was cut: 1 more skills");
  });

  it("stops at 4 KB and says it was cut", () => {
    const text = skillsText(
      Array.from({ length: 10 }, (_, index) => skill(index, "x".repeat(1000))),
      "/run/bee/skills",
    );
    expect(Buffer.byteLength(text)).toBeLessThan(4096 + 200);
    expect(text).toMatch(/The list was cut: [6-9] more skills/);
  });
});

describe("the path policy for skills", () => {
  it("lets Read, Glob and Grep into the bot's own skill folders, and nothing writes there", () => {
    const home = NodePath.join(dataDir, "home");
    const workspace = NodePath.join(dataDir, "bots", "ada", "workspace");
    NodeFS.mkdirSync(workspace, { recursive: true });
    NodeFS.mkdirSync(home);
    addSkill("pdf");
    addSkill("csv");
    const pdf = skillFolder(dataDir, "pdf");
    const csv = skillFolder(dataDir, "csv");
    const context = { home, dataDir, platform: process.platform, skills: [pdf] };
    const check = (tool: "Read" | "Glob" | "Grep" | "Write" | "Edit", input: object) =>
      pathPolicy(tool, { ...input }, workspace, context);
    const skillMdPath = NodePath.join(pdf, "SKILL.md");

    expect(check("Read", { file_path: skillMdPath })).toEqual({ allowed: true, inside: true });
    expect(check("Grep", { pattern: "x", path: pdf })).toMatchObject({ allowed: true });
    expect(check("Glob", { pattern: "**/*.md", path: pdf })).toMatchObject({ allowed: true });

    for (const tool of ["Write", "Edit"] as const) {
      expect(check(tool, { file_path: skillMdPath })).toMatchObject({ allowed: false });
    }
    expect(check("Read", { file_path: NodePath.join(csv, "SKILL.md") })).toMatchObject({
      allowed: false,
    });
    expect(check("Grep", { pattern: "x", path: NodePath.dirname(pdf) })).toMatchObject({
      allowed: false,
    });
    expect(check("Read", { file_path: NodePath.join(pdf, "..", "csv", "SKILL.md") })).toMatchObject(
      { allowed: false },
    );
    const noSkills = pathPolicy("Read", { file_path: skillMdPath }, workspace, {
      ...context,
      skills: [],
    });
    expect(noSkills).toMatchObject({ allowed: false });
  });

  it("follows the store's assignments", () => {
    const bot = addBot();
    addSkill("pdf");
    expect(store.skillFolders(bot.id)).toEqual([]);
    enable(bot, "pdf");
    expect(store.skillFolders(bot.id)).toEqual([skillFolder(dataDir, "pdf")]);
    store.setBotSkill(bot.id, "pdf", false);
    expect(store.skillFolders(bot.id)).toEqual([]);
  });
});
