import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { Skill, SkillFilePath, SkillName, skillLimits, skillUsable } from "@beebot/contracts";
import { z } from "zod";

import type { BoxRuntime } from "./boxRuntime.ts";
import type { StoreTx } from "./store.ts";

export const skillsDir = (dataDir: string) => NodePath.join(dataDir, "skills");
export const skillFolder = (dataDir: string, name: string) =>
  NodePath.join(skillsDir(dataDir), name);

export type SkillFile = { path: string; bytes: Buffer };
export type LaunchSkill = { name: string; description: string; sha256: string };
export type Refused = { error: string; path?: string };
type Prepared = LaunchSkill & { text: string; files: SkillFile[] };

const maxDescription = 1024;

// A YAML block scalar (`description: >`) folds its indented lines into one value.
function blockValue(lines: string[], start: number, style: string) {
  const taken: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() && !/^\s/.test(line)) {
      break;
    }
    taken.push(line.trim());
  }
  return (style.startsWith("|") ? taken.join("\n") : taken.join(" ")).trim();
}

function unquote(raw: string) {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return z.string().parse(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(value)) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/, "");
}

// shortcut: reads only the top-level `key: value` lines and block scalars of the front matter,
// enough for `name` and `description`. No YAML parser is a dependency here; add one if skills need
// flow collections or anchors in those two keys.
export function parseSkillMd(raw: string): Refused | { name: string; description: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { error: "skill_no_front_matter" };
  }
  const lines = (match[1] ?? "").split(/\r?\n/);
  const fields = new Map<string, string>();
  lines.forEach((line, index) => {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field?.[1] && field[2] !== undefined) {
      const value = field[2].trim();
      fields.set(
        field[1].toLowerCase(),
        /^[>|][-+]?$/.test(value) ? blockValue(lines, index + 1, value) : unquote(value),
      );
    }
  });
  const name = SkillName.safeParse(fields.get("name"));
  const description = fields.get("description") ?? "";
  if (!name.success) {
    return { error: "skill_bad_name" };
  }
  if (!description || description.length > maxDescription) {
    return { error: "skill_bad_description" };
  }
  return { name: name.data, description };
}

type Walked = { files: SkillFile[] } | Refused;

// Every file of a skill folder, read without following a link at any level. Anything a skill may
// not hold refuses the whole folder, so what the owner reviewed is all there is.
export function readSkillFolder(root: string): Walked {
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = (relative: string): Walked | undefined => {
    const entries = NodeFS.readdirSync(NodePath.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (!SkillFilePath.safeParse(path).success) {
        return { error: "skill_bad_path", path };
      }
      const full = NodePath.join(root, path);
      const stats = NodeFS.lstatSync(full);
      if (stats.isSymbolicLink()) {
        return { error: "skill_link", path };
      }
      if (stats.isDirectory()) {
        const failed = walk(path);
        if (failed) {
          return failed;
        }
        continue;
      }
      if (!stats.isFile()) {
        return { error: "skill_bad_path", path };
      }
      bytes += stats.size;
      if (files.length >= skillLimits.files) {
        return { error: "skill_too_many_files" };
      }
      if (bytes > skillLimits.bytes) {
        return { error: "skill_too_large" };
      }
      files.push({ path, bytes: NodeFS.readFileSync(full) });
    }
    return undefined;
  };
  try {
    if (!NodeFS.lstatSync(root).isDirectory()) {
      return { error: "skill_not_folder" };
    }
    return walk("") ?? { files };
  } catch {
    return { error: "skill_unreadable" };
  }
}

export function skillHash(files: readonly SkillFile[]) {
  const hash = NodeCrypto.createHash("sha256");
  for (const { path, bytes } of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${path}\0${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

export function prepareSkill(files: SkillFile[]): Refused | Prepared {
  if (files.length > skillLimits.files) {
    return { error: "skill_too_many_files" };
  }
  if (files.reduce((sum, { bytes }) => sum + bytes.length, 0) > skillLimits.bytes) {
    return { error: "skill_too_large" };
  }
  const bad = files.find(({ path }) => !SkillFilePath.safeParse(path).success);
  if (bad) {
    return { error: "skill_bad_path", path: bad.path };
  }
  const skillMd = files.find(({ path }) => path === "SKILL.md");
  if (!skillMd) {
    return { error: "skill_md_missing" };
  }
  if (skillMd.bytes.length > skillLimits.skillMdBytes) {
    return { error: "skill_md_too_large" };
  }
  const text = skillMd.bytes.toString("utf8");
  const parsed = parseSkillMd(text);
  if ("error" in parsed) {
    return parsed;
  }
  return { ...parsed, text, files, sha256: skillHash(files) };
}

// Into a fresh folder, renamed into place whole, so a skill is never seen half written.
export function writeSkill(dataDir: string, { name, files }: Prepared) {
  const root = skillsDir(dataDir);
  NodeFS.mkdirSync(root, { recursive: true });
  const final = skillFolder(dataDir, name);
  if (NodeFS.existsSync(final)) {
    return "skill_exists";
  }
  const temp = NodePath.join(root, `.incoming-${NodeCrypto.randomUUID()}`);
  try {
    NodeFS.mkdirSync(temp);
    for (const { path, bytes } of files) {
      const target = NodePath.resolve(temp, ...path.split("/"));
      // Checked again here, whoever built `files`: nothing is written outside the skill's folder.
      const inside = NodePath.relative(temp, target);
      if (!SkillFilePath.safeParse(path).success || inside.startsWith("..") || !inside) {
        throw new Error(`refusing to write ${JSON.stringify(path)} outside the skill folder`);
      }
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, bytes, { flag: "wx" });
    }
    NodeFS.renameSync(temp, final);
    return "added";
  } finally {
    NodeFS.rmSync(temp, { recursive: true, force: true });
  }
}

// What a skill holds now. Null when SKILL.md can't be read, which drops the skill.
export function readSkill(dataDir: string, name: string) {
  const folder = skillFolder(dataDir, name);
  const walked = readSkillFolder(folder);
  if ("files" in walked) {
    const prepared = prepareSkill(walked.files);
    return "error" in prepared
      ? undefined
      : { description: prepared.description, text: prepared.text, sha256: prepared.sha256 };
  }
  // A folder that went bad keeps its card, so the owner sees it changed.
  try {
    const text = NodeFS.readFileSync(NodePath.join(folder, "SKILL.md"), "utf8");
    const parsed = parseSkillMd(text);
    return "error" in parsed ? undefined : { description: parsed.description, text, sha256: null };
  } catch {
    return undefined;
  }
}

// The folders that look like skills. Hidden ones are this module's temporary folders.
function diskSkills(dataDir: string) {
  try {
    return NodeFS.readdirSync(skillsDir(dataDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SkillName.safeParse(entry.name).success)
      .map(({ name }) => name);
  } catch {
    return [];
  }
}

// The truth is the folder on disk. The owner's review, the source and which bots have the skill are
// kept only here.
const SkillRow = z.object({
  name: z.string(),
  source: Skill.shape.source,
  reviewedSha256: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  botIds: z.string().transform((json) => z.array(z.string()).parse(JSON.parse(json))),
});

const maxPromptSkills = 30;
const maxPromptBytes = 4096;

// One line per skill, cut to the caps, saying so when it was. A box's `root` is a POSIX path.
export function skillsText(skills: readonly LaunchSkill[], root: string) {
  if (skills.length === 0) {
    return "";
  }
  const join = root.startsWith("/") ? NodePath.posix.join : NodePath.join;
  const header =
    "You have these skills. Each is a folder of instructions, and maybe reference files and " +
    "scripts, beside its SKILL.md. When a task matches one, read its SKILL.md first, then only " +
    "what that says to. Its files are read-only.";
  const lines: string[] = [];
  let bytes = Buffer.byteLength(header);
  for (const { name, description } of skills.slice(0, maxPromptSkills)) {
    const line = `- ${name}: ${description.replace(/\s+/g, " ")} Read "${join(root, name, "SKILL.md")}"`;

    if (bytes + Buffer.byteLength(line) + 1 > maxPromptBytes) {
      break;
    }
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  const cut =
    lines.length < skills.length
      ? [
          `The list was cut: ${skills.length - lines.length} more skills are on for you but not ` +
            "shown, so tell the owner if a task seems to need one.",
        ]
      : [];
  return [header, ...lines, ...cut].join("\n");
}

export function openSkills(db: DatabaseSync, { transaction, emit }: StoreTx, dataDir: string) {
  const columns = `s.name, s.source, s.sha256 AS reviewedSha256, s.reviewed_at AS reviewedAt,
    (SELECT json_group_array(bot_id) FROM
      (SELECT bot_id FROM bot_skills WHERE name = s.name ORDER BY bot_id)) AS botIds`;
  const selectAll = db.prepare(`SELECT ${columns} FROM skills s ORDER BY s.name`);
  const selectOne = db.prepare(`SELECT ${columns} FROM skills s WHERE s.name = ?`);
  const selectNames = db.prepare("SELECT name FROM skills");
  const selectAssigned = db.prepare(
    `SELECT ${columns} FROM skills s JOIN bot_skills b ON b.name = s.name WHERE b.bot_id = ?
     ORDER BY s.name`,
  );
  const insert = db.prepare(
    "INSERT INTO skills (name, description, source) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const updateDescription = db.prepare("UPDATE skills SET description = ? WHERE name = ?");
  const review = db.prepare("UPDATE skills SET sha256 = ?, reviewed_at = ? WHERE name = ?");
  const remove = db.prepare("DELETE FROM skills WHERE name = ?");
  const assign = db.prepare("INSERT OR IGNORE INTO bot_skills (bot_id, name) VALUES (?, ?)");
  const unassign = db.prepare("DELETE FROM bot_skills WHERE bot_id = ? AND name = ?");
  const botExists = db.prepare("SELECT 1 FROM bots WHERE id = ?");
  const Name = z.object({ name: z.string() });

  const withDisk = (row: unknown): Skill | undefined => {
    const stored = SkillRow.parse(row);
    const disk = readSkill(dataDir, stored.name);
    return disk && { ...stored, ...disk };
  };
  const getSkill = (name: string) => {
    const row = selectOne.get(name);
    return row ? withDisk(row) : undefined;
  };
  const changed = (name: string) => {
    const skill = getSkill(name);
    if (skill) {
      emit({ type: "skill.changed", skill });
    }
    return skill;
  };

  // At boot, from the folders. A skill found on disk with no row is new to the owner, so it starts
  // unreviewed and on for no bot.
  function rebuildSkills() {
    transaction(() => {
      const onDisk = new Set(diskSkills(dataDir));
      for (const { name } of z.array(Name).parse(selectNames.all())) {
        if (!onDisk.has(name)) {
          remove.run(name);
        }
      }
      for (const name of onDisk) {
        const disk = readSkill(dataDir, name);
        if (disk) {
          insert.run(name, disk.description, "folder");
          updateDescription.run(disk.description, name);
        }
      }
    });
  }

  return {
    rebuildSkills,
    getSkill,
    listSkills: () =>
      z
        .array(z.unknown())
        .parse(selectAll.all())
        .flatMap((row) => withDisk(row) ?? []),

    // Files first, then the row: a crash between leaves a folder the next boot finds.
    addSkill: (prepared: Prepared, source: Skill["source"]) => {
      const written = writeSkill(dataDir, prepared);
      if (written !== "added") {
        return written;
      }
      return transaction(() => {
        insert.run(prepared.name, prepared.description, source);
        return changed(prepared.name) ?? "skill_unreadable";
      });
    },

    reviewSkill: (name: string, sha256: string) =>
      transaction(() => {
        const skill = getSkill(name);
        if (!skill) {
          return "not_found";
        }
        if (skill.sha256 === null || skill.sha256 !== sha256) {
          return "skill_changed";
        }
        review.run(sha256, new Date().toISOString(), name);
        return changed(name) ?? "not_found";
      }),

    setBotSkill: (botId: string, name: string, on: boolean) =>
      transaction(() => {
        const skill = getSkill(name);
        if (!skill || !botExists.get(botId)) {
          return "not_found";
        }
        if (on && !skillUsable(skill)) {
          return skill.reviewedSha256 === null ? "skill_not_reviewed" : "skill_changed";
        }
        (on ? assign : unassign).run(botId, name);
        return changed(name) ?? "not_found";
      }),

    // The row first, so no launch after this sees it, then the folder.
    deleteSkill: (name: string) => {
      const deleted = transaction(() => {
        if (remove.run(name).changes === 0) {
          return false;
        }
        emit({ type: "skill.deleted", name });
        return true;
      });
      if (deleted) {
        NodeFS.rmSync(skillFolder(dataDir, name), { recursive: true, force: true });
      }
      return deleted;
    },

    // What a launch may use: assigned, and still exactly what the owner reviewed.
    launchSkills: (botId: string): LaunchSkill[] =>
      z
        .array(z.unknown())
        .parse(selectAssigned.all(botId))
        .flatMap((row) => {
          const skill = withDisk(row);
          return skill && skill.sha256 !== null && skillUsable(skill)
            ? [{ name: skill.name, description: skill.description, sha256: skill.sha256 }]
            : [];
        }),

    // For the path policy: only folders, so no hashing on every Read.
    skillFolders: (botId: string) =>
      z
        .array(Name)
        .parse(selectAssigned.all(botId))
        .map(({ name }) => skillFolder(dataDir, name)),
  };
}

// Before a box turn: the box keeps exactly the launch's skills. Each is read and hashed once more
// as it is copied, so a skill that changed since the claim stays out.
export async function syncBoxSkills(
  runtime: Pick<BoxRuntime, "keepSkills" | "writeSkill">,
  dataDir: string,
  botId: string,
  skills: readonly LaunchSkill[],
) {
  const missing = await runtime.keepSkills(
    botId,
    skills.map(({ name, sha256 }) => ({ name, sha256 })),
  );
  for (const { name, sha256 } of skills.filter(({ name }) => missing.includes(name))) {
    const walked = readSkillFolder(skillFolder(dataDir, name));
    if ("files" in walked && skillHash(walked.files) === sha256) {
      const files = walked.files.map(({ path, bytes }) => ({
        path,
        data: bytes.toString("base64"),
      }));
      await runtime.writeSkill(botId, { name, sha256, files });
    }
  }
}
