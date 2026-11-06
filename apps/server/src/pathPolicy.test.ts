import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ApprovalTool } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkProjectFolder, pathPolicy } from "./pathPolicy.ts";

const win = process.platform === "win32";

let root: string;
let home: string;
let dataDir: string;
let workspace: string;

beforeEach(() => {
  root = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-paths-")),
  );
  home = NodePath.join(root, "home");
  dataDir = NodePath.join(home, "bee");
  workspace = NodePath.join(dataDir, "bots", "ada", "workspace");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(home, ".ssh"));
  NodeFS.mkdirSync(NodePath.join(home, "public"));
  NodeFS.writeFileSync(NodePath.join(home, ".ssh", "id_rsa"), "key");
  NodeFS.writeFileSync(NodePath.join(home, "public", "notes.txt"), "notes");
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const check = (tool: ApprovalTool, input: Record<string, unknown>) =>
  pathPolicy(tool, input, workspace, { home, dataDir, platform: process.platform });

const read = (file_path: unknown) => check("Read", { file_path });
const refused = expect.objectContaining({ allowed: false });
const inside = { allowed: true, inside: true };
const outside = { allowed: true, inside: false };

// A junction needs no privilege on Windows, and the type is ignored elsewhere.
const link = (target: string, path: string) => NodeFS.symlinkSync(target, path, "junction");

describe("targets in the workspace", () => {
  it("are fine, even a credential-looking folder of the bot's own", () => {
    expect(read("notes.txt")).toEqual(inside);
    expect(read(NodePath.join(workspace, "new", "deep.txt"))).toEqual(inside);
    expect(read(".ssh/config")).toEqual(inside);
    expect(check("Write", { file_path: ".aws/credentials" })).toMatchObject(inside);
    expect(check("Edit", { file_path: "a/../b.txt" })).toEqual(inside);
  });

  it("count once a link is followed", () => {
    link(workspace, NodePath.join(home, "public", "shortcut"));
    expect(read(NodePath.join(home, "public", "shortcut", "x.txt"))).toEqual(inside);
  });
});

describe("a bot's memory folder", () => {
  const memoryFile = () => NodePath.join(dataDir, "bots", "ada", "memory", "x.md");

  beforeEach(() => {
    NodeFS.mkdirSync(NodePath.dirname(memoryFile()));
    NodeFS.writeFileSync(memoryFile(), "memory");
  });

  it.each(["Read", "Write", "Edit"] as const)("is refused to %s", (tool) => {
    expect(check(tool, { file_path: memoryFile() })).toEqual(refused);
    expect(check(tool, { file_path: "../memory/x.md" })).toEqual(refused);
  });

  it("is refused to Grep and Glob", () => {
    expect(check("Grep", { pattern: "x", path: NodePath.dirname(memoryFile()) })).toEqual(refused);
    expect(check("Grep", { pattern: "x", path: "../memory" })).toEqual(refused);
    expect(check("Glob", { pattern: "../memory/*" })).toEqual(refused);
    expect(check("Glob", { pattern: "**/../memory/*" })).toEqual(refused);
  });

  it("is refused through a link from the workspace", () => {
    link(NodePath.dirname(memoryFile()), NodePath.join(workspace, "shortcut"));
    expect(read("shortcut/x.md")).toEqual(refused);
    expect(check("Write", { file_path: "shortcut/new.md" })).toEqual(refused);
  });
});

describe("targets outside the workspace", () => {
  it("are left to the card when nothing protected is touched", () => {
    expect(read(NodePath.join(home, "public", "notes.txt"))).toEqual(outside);
    expect(read("~/public/notes.txt")).toEqual(outside);
  });

  it.each([".ssh", ".aws", ".claude", ".gnupg", ".kube", ".docker", ".azure"])(
    "refuses anything under %s, existing or not",
    (folder) => {
      expect(read(NodePath.join(home, folder, "secret"))).toEqual(refused);
      expect(read(`~/${folder}/secret`)).toEqual(refused);
    },
  );

  it.each([".git-credentials", ".netrc", ".npmrc", ".claude.json"])("refuses %s", (file) => {
    expect(read(`~/${file}`)).toEqual(refused);
    expect(check("Write", { file_path: `~/${file}` })).toEqual(refused);
  });

  it("refuses browser profiles", () => {
    const profile = win
      ? "AppData/Local/Google/Chrome/User Data/Default/Login Data"
      : process.platform === "darwin"
        ? "Library/Application Support/Firefox/Profiles/x/logins.json"
        : ".config/google-chrome/Default/Login Data";
    expect(read(NodePath.join(home, profile))).toEqual(refused);
  });

  it("refuses Bee's own data: other bots, the database, run config files", () => {
    expect(read("../../ben/workspace/x.txt")).toEqual(refused);
    expect(read("../persona.md")).toEqual(refused);
    expect(read(NodePath.join(dataDir, "beebot.db"))).toEqual(refused);
    expect(read(NodePath.join(dataDir, "runtime", "x.json"))).toEqual(refused);
  });

  it("resolves .. before deciding", () => {
    expect(read("../../../../.ssh/id_rsa")).toEqual(refused);
    expect(read(NodePath.join(home, "public", "..", ".ssh", "id_rsa"))).toEqual(refused);
    expect(read("../../../../public/notes.txt")).toEqual(outside);
  });

  it("follows links out of the workspace", () => {
    link(NodePath.join(home, ".ssh"), NodePath.join(workspace, "keys"));
    expect(read("keys/id_rsa")).toEqual(refused);
    expect(check("Write", { file_path: "keys/new" })).toEqual(refused);
    link(NodePath.join(home, "public"), NodePath.join(workspace, "docs"));
    expect(read("docs/notes.txt")).toEqual(outside);
  });

  it("refuses a link named like a credential folder wherever it points", () => {
    const real = NodePath.join(home, "public", "dotfiles");
    NodeFS.mkdirSync(real);
    NodeFS.mkdirSync(NodePath.join(home, "other"));
    link(real, NodePath.join(home, "other", ".aws"));
    expect(read(NodePath.join(home, "other", ".aws", "credentials"))).toEqual(refused);
  });

  it("refuses a dangling link: a Write through it would land at the target", () => {
    const gone = NodePath.join(home, "public", "gone");
    NodeFS.mkdirSync(gone);
    link(gone, NodePath.join(workspace, "dangling"));
    NodeFS.rmSync(gone, { recursive: true });
    expect(check("Write", { file_path: "dangling/new.txt" })).toEqual(refused);
  });

  it.runIf(!win)("follows a link before applying ..", () => {
    NodeFS.mkdirSync(NodePath.join(home, "public", "a"));
    link(NodePath.join(home, "public", "a"), NodePath.join(workspace, "up"));
    expect(read("up/../notes.txt")).toEqual(outside);
  });
});

describe.runIf(win)("Windows paths", () => {
  it("are compared without case", () => {
    const shouted = NodePath.join(home, ".SSH", "ID_RSA");
    expect(read(shouted)).toEqual(refused);
    expect(read(shouted.toUpperCase())).toEqual(refused);
    expect(read(NodePath.join(home, "AppData/LOCAL/google/CHROME/x"))).toEqual(refused);
    expect(read(workspace.toUpperCase())).toEqual(inside);
    expect(read(NodePath.join(dataDir.toUpperCase(), "BEEBOT.DB"))).toEqual(refused);
  });

  it("drop what Win32 drops from a name", () => {
    expect(read(`${home}\\.ssh.\\id_rsa`)).toEqual(refused);
    expect(read(`${home}\\.ssh \\id_rsa`)).toEqual(refused);
    expect(read(`${home}\\.ssh. . \\id_rsa`)).toEqual(refused);
    expect(read(`${home}\\.ssh::$INDEX_ALLOCATION\\id_rsa`)).toEqual(refused);
    expect(read(`${home}\\.netrc::$DATA`)).toEqual(refused);
    expect(read(`${home}\\.netrc:hidden`)).toEqual(refused);
    expect(read(`${home}\\public\\... \\x`)).toEqual(refused);
  });

  it("read /c/foo as C:\\foo", () => {
    const posixStyle = `/${home[0]?.toLowerCase()}${home.slice(2).replaceAll("\\", "/")}`;
    expect(read(`${posixStyle}/.ssh/id_rsa`)).toEqual(refused);
    expect(read(`${posixStyle}/public/notes.txt`)).toEqual(outside);
  });

  it("refuse UNC, device and drive-relative paths outside the workspace", () => {
    expect(read("\\\\server\\share\\file")).toEqual(refused);
    expect(read("//server/share/file")).toEqual(refused);
    expect(read(`\\\\?\\${home}\\public\\notes.txt`)).toEqual(refused);
    expect(read(`\\\\.\\${home}\\public\\notes.txt`)).toEqual(refused);
    expect(read("\\\\?\\UNC\\server\\share\\file")).toEqual(refused);
    expect(read("C:notes.txt")).toEqual(refused);
    expect(read(`\\\\?\\${workspace}\\notes.txt`)).toEqual(inside);
  });
});

describe("searches", () => {
  it("are fine in the workspace", () => {
    expect(check("Grep", { pattern: ".ssh" })).toEqual(inside);
    expect(check("Grep", { pattern: "x", path: "src" })).toEqual(inside);
    expect(check("Glob", { pattern: "**/*.{ts,tsx}" })).toEqual(inside);
    expect(check("Glob", { pattern: "src/**/*.ts", path: "." })).toEqual(inside);
  });

  it("are left to the card in an unprotected folder", () => {
    const path = NodePath.join(home, "public");
    expect(check("Grep", { pattern: "x", path })).toEqual(outside);
    expect(check("Glob", { pattern: "*.txt", path })).toEqual(outside);
    expect(check("Glob", { pattern: "../../../../public/*.txt" })).toEqual(outside);
  });

  it("refuse home, anything above it, and anything above the data dir", () => {
    for (const path of ["~", home, root, NodePath.dirname(root), dataDir, "../../.."]) {
      expect(check("Grep", { pattern: "x", path })).toEqual(refused);
      expect(check("Glob", { pattern: "*", path })).toEqual(refused);
    }
  });

  it("refuse a root with protected data below it, or a pattern naming a credential folder", () => {
    const above = NodePath.join(home, win ? "AppData/Local" : ".config");
    NodeFS.mkdirSync(above, { recursive: true });
    expect(check("Grep", { pattern: "x", path: above })).toEqual(refused);
    const other = NodePath.join(root, "other");
    NodeFS.mkdirSync(other);
    expect(check("Grep", { pattern: "x", path: other })).toEqual(outside);
    expect(check("Grep", { pattern: "x", path: other, glob: ".ssh/**" })).toEqual(refused);
    expect(check("Glob", { pattern: "*/.SSH/*", path: other })).toEqual(refused);
  });

  it("refuse a brace alternative that carries a path", () => {
    expect(check("Glob", { pattern: `{${home}/.ssh,x}/*` })).toEqual(refused);
  });

  it("find the root a Glob pattern carries", () => {
    expect(check("Glob", { pattern: "../../../../.ssh/*" })).toEqual(refused);
    expect(check("Glob", { pattern: "../.ssh/*", path: "~/public" })).toEqual(refused);
    expect(check("Glob", { pattern: `${home.replaceAll("\\", "/")}/*` })).toEqual(refused);
    expect(check("Glob", { pattern: "~/.aws/*" })).toEqual(refused);
    expect(check("Glob", { pattern: "/*" })).toEqual(refused);
  });

  it("refuse a .. hidden past a wildcard or in braces", () => {
    expect(check("Glob", { pattern: "**/../../secret" })).toEqual(refused);
    expect(check("Glob", { pattern: "{a,../../..}/secret" })).toEqual(refused);
    expect(check("Glob", { pattern: "*/{..,x}/y" })).toEqual(refused);
  });

  it("check the path too when the pattern is absolute", () => {
    const pattern = `${workspace.replaceAll("\\", "/")}/*.txt`;
    expect(check("Glob", { pattern })).toEqual(inside);
    expect(check("Glob", { pattern, path: "~/.ssh" })).toEqual(refused);
  });
});

describe("fails closed", () => {
  it("on input it can't read", () => {
    expect(read(undefined)).toEqual(refused);
    expect(read(7)).toEqual(refused);
    expect(read("a\0b")).toEqual(refused);
    expect(check("Grep", { pattern: "x", path: 7 })).toEqual(refused);
    expect(check("Glob", { pattern: 7 })).toEqual(refused);
  });

  it("but never judges Bash, whose card shows the exact command", () => {
    expect(check("Bash", { command: "cat ~/.ssh/id_rsa" })).toEqual(outside);
  });
});

describe("targets in a project folder", () => {
  let project: string;

  beforeEach(() => {
    project = NodePath.join(root, "work", "app");
    NodeFS.mkdirSync(project, { recursive: true });
  });

  const inProject = (tool: ApprovalTool, input: Record<string, unknown>) =>
    pathPolicy(tool, input, project, { home, dataDir, platform: process.platform });

  it("are inside when nothing protected is named", () => {
    expect(inProject("Read", { file_path: "src/a.ts" })).toEqual(inside);
    expect(inProject("Grep", { pattern: "x", path: "src" })).toEqual(inside);
    expect(inProject("Glob", { pattern: "**/*.ts" })).toEqual(inside);
  });

  it.each([".npmrc", ".docker/config.json", "sub/.ssh/key", ".AWS/credentials"])(
    "always ask for %s, and don't refuse it",
    (file_path) => {
      expect(inProject("Read", { file_path })).toEqual(outside);
      expect(inProject("Write", { file_path })).toMatchObject(outside);
      expect(inProject("Read", { file_path: NodePath.join(project, file_path) })).toEqual(outside);
    },
  );

  it.runIf(win)("always ask however Win32 spells the name", () => {
    expect(inProject("Read", { file_path: ".npmrc::$DATA" })).toEqual(outside);
    expect(inProject("Read", { file_path: ".docker. \\config.json" })).toEqual(outside);
  });

  it("always ask for a link named like a credential folder", () => {
    NodeFS.mkdirSync(NodePath.join(project, "plain"));
    link(NodePath.join(project, "plain"), NodePath.join(project, ".aws"));
    expect(inProject("Read", { file_path: ".aws/credentials" })).toEqual(outside);
  });

  it("always ask for a search aimed at a protected name", () => {
    expect(inProject("Grep", { pattern: "x", path: ".docker" })).toEqual(outside);
    expect(inProject("Grep", { pattern: "x", glob: ".npmrc" })).toEqual(outside);
    expect(inProject("Glob", { pattern: "**/.npmrc" })).toEqual(outside);
  });

  it("still refuse what is protected outside the folder", () => {
    expect(inProject("Read", { file_path: NodePath.join(home, ".ssh", "id_rsa") })).toEqual(
      refused,
    );
    expect(inProject("Read", { file_path: NodePath.join(dataDir, "beebot.db") })).toEqual(refused);
  });

  it("refuse a link out to something protected, whatever its name", () => {
    link(NodePath.join(home, ".ssh"), NodePath.join(project, "keys"));
    expect(inProject("Read", { file_path: "keys/id_rsa" })).toEqual(refused);
  });
});

describe("a proposed project folder", () => {
  const propose = (path: string, context = { home, dataDir, platform: process.platform }) =>
    checkProjectFolder(path, context).refused;
  const folder = (...segments: string[]) => {
    const path = NodePath.join(root, ...segments);
    NodeFS.mkdirSync(path, { recursive: true });
    return path;
  };

  it("gives back the real path", () => {
    const app = folder("work", "app");
    const context = { home, dataDir, platform: process.platform };
    expect(checkProjectFolder(app, context)).toEqual({ real: app, refused: undefined });
    expect(checkProjectFolder(`${app}${NodePath.sep}`, context).real).toBe(app);
    link(app, NodePath.join(root, "shortcut"));
    expect(checkProjectFolder(NodePath.join(root, "shortcut"), context).real).toBe(app);
  });

  it("accepts a folder inside home", () => {
    expect(propose(NodePath.join(home, "public"))).toBeUndefined();
  });

  it.each(["work/app", "./app", "~/app", "..", "a\0b"])("refuses %j as not absolute", (path) => {
    expect(propose(path)).toBe("folder_not_absolute");
  });

  it("refuses a NUL in an absolute path", () => {
    expect(propose(`${folder("work")}\0`)).toBe("folder_not_absolute");
  });

  it.runIf(win)("refuses paths that only look absolute on Windows", () => {
    for (const path of ["\\work", "/c/work", "C:work"]) {
      expect(propose(path)).toBe("folder_not_absolute");
    }
  });

  it.runIf(win)("refuses UNC and device paths", () => {
    for (const path of [
      "\\\\server\\share\\app",
      "//server/share/app",
      "\\/server/share",
      `\\\\?\\${folder("work")}`,
      `\\\\.\\${folder("work")}`,
    ]) {
      expect(propose(path)).toBe("folder_network");
    }
  });

  it("refuses what doesn't exist, a dangling link and a file", () => {
    expect(propose(NodePath.join(root, "nowhere"))).toBe("folder_not_found");
    const gone = folder("gone");
    link(gone, NodePath.join(root, "dangling"));
    NodeFS.rmSync(gone, { recursive: true });
    expect(propose(NodePath.join(root, "dangling"))).toBe("folder_not_found");
    expect(propose(NodePath.join(home, "public", "notes.txt"))).toBe("folder_not_directory");
  });

  it("refuses a filesystem or drive root", () => {
    expect(propose(NodePath.parse(root).root)).toBe("folder_root");
  });

  it("refuses home and anything above it, spelled directly or through a link", () => {
    expect(propose(home)).toBe("folder_home");
    expect(propose(root)).toBe("folder_home");
    expect(propose(NodePath.dirname(root))).toBe("folder_home");
    link(home, NodePath.join(root, "to-home"));
    expect(propose(NodePath.join(root, "to-home"))).toBe("folder_home");
    expect(propose(NodePath.join(folder("work"), "..", "home"))).toBe("folder_home");
  });

  it("refuses the data dir, anything in it and anything above it", () => {
    expect(propose(dataDir)).toBe("folder_bee_data");
    expect(propose(workspace)).toBe("folder_bee_data");
    const data = folder("apps", "bee", "data");
    const context = { home, dataDir: data, platform: process.platform };
    expect(propose(data, context)).toBe("folder_bee_data");
    expect(propose(NodePath.dirname(data), context)).toBe("folder_bee_data");
    link(data, NodePath.join(root, "to-data"));
    expect(propose(NodePath.join(root, "to-data"), context)).toBe("folder_bee_data");
  });

  it("refuses a protected root, anything in it and anything above it", () => {
    const [parent, store] = win
      ? ["AppData", "Local/Google/Chrome"]
      : process.platform === "darwin"
        ? ["Library", "Application Support/Firefox"]
        : [".config", "google-chrome"];
    const inside = NodePath.join(home, parent, store, "Default");
    NodeFS.mkdirSync(inside, { recursive: true });
    expect(propose(inside)).toBe("folder_protected");
    expect(propose(NodePath.join(home, parent))).toBe("folder_protected");
  });

  it("refuses a credential segment anywhere, even on a link's name", () => {
    expect(propose(NodePath.join(home, ".ssh"))).toBe("folder_protected");
    expect(propose(folder("work", ".aws", "app"))).toBe("folder_protected");
    expect(propose(folder("work", ".DOCKER"))).toBe("folder_protected");
    link(folder("plain"), NodePath.join(folder("elsewhere"), ".kube"));
    expect(propose(NodePath.join(root, "elsewhere", ".kube"))).toBe("folder_protected");
  });

  it("refuses a link to a credential folder under any name", () => {
    link(NodePath.join(home, ".ssh"), NodePath.join(root, "keys"));
    expect(propose(NodePath.join(root, "keys"))).toBe("folder_protected");
  });
});

describe("a patch", () => {
  const patch = (...paths: string[]) => check("Patch", { paths, diff: "" });
  const inWorkspace = () => NodePath.join(workspace, "a.txt");

  it("is inside only if every path is", () => {
    expect(patch(inWorkspace(), NodePath.join(workspace, "b.txt"))).toMatchObject(inside);
    expect(patch(inWorkspace(), NodePath.join(home, "public", "notes.txt"))).toMatchObject({
      allowed: true,
      inside: false,
    });
  });

  it("is refused whole when any one path is", () => {
    expect(patch(inWorkspace(), NodePath.join(home, ".ssh", "id_rsa"))).toEqual(refused);
  });

  it("is refused when it names no paths or a path that isn't text", () => {
    expect(patch()).toEqual(refused);
    expect(check("Patch", { paths: [7], diff: "" })).toEqual(refused);
  });
});
