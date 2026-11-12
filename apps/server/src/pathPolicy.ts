import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ApprovalTool } from "@beebot/contracts";

// `skills`: the folders of the bot's skills, which Read, Glob and Grep may look in. Nothing may
// write there.
type Context = {
  home: string;
  dataDir: string;
  platform: NodeJS.Platform;
  skills?: readonly string[];
};

const refused = {
  allowed: false,
  message: "Refused: this path is off limits to bots. It was not touched.",
} as const;

const credentialSegments = new Set([
  ".claude",
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".docker",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".claude.json",
]);

const linuxRoots = [
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/vivaldi",
  ".config/gh",
  ".mozilla",
];
// Relative to home. Browser profiles, plus the OS and tool stores that hold saved logins.
const protectedRoots: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: [
    "AppData/Local/Google",
    "AppData/Local/Microsoft/Edge",
    "AppData/Local/Microsoft/Edge SxS",
    "AppData/Local/Microsoft/Credentials",
    "AppData/Local/BraveSoftware",
    "AppData/Local/Chromium",
    "AppData/Local/Vivaldi",
    "AppData/Roaming/Mozilla/Firefox",
    "AppData/Roaming/Opera Software",
    "AppData/Roaming/Microsoft/Credentials",
    "AppData/Roaming/Microsoft/Protect",
    "AppData/Roaming/GitHub CLI",
  ],
  darwin: [
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Vivaldi",
    ".config/gh",
  ],
};

// A dangling link counts as existing: a Write through it would land at its target.
function follow(path: string) {
  try {
    return NodeFS.realpathSync.native(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
    try {
      NodeFS.lstatSync(path);
    } catch {
      return path;
    }
    throw error;
  }
}

// Win32 drops these from a name when it opens it, so `.ssh. ` and `.ssh::$DATA` both mean `.ssh`.
function win32Name(segment: string) {
  const name = segment.replace(/:.*$/, "").replace(/[. ]+$/, "");
  return name || undefined;
}

// Glob's pattern can carry a directory of its own, so the search root is `path` plus its prefix.
function globRoot(pattern: string, base: string, win: boolean) {
  // A brace alternative can carry a whole path, so no prefix would describe where it searches.
  if (/\{[^}]*[\\/:][^}]*\}/.test(pattern)) {
    return undefined;
  }
  const segments = pattern.split(win ? /[\\/]/ : /\//);
  const wildcard = segments.findIndex((segment) => /[*?[\]{}()!]/.test(segment));
  const fixed = wildcard === -1 ? segments : segments.slice(0, wildcard);
  if (wildcard !== -1 && segments.slice(wildcard).join("/").includes("..")) {
    return undefined;
  }
  const prefix = fixed.join("/") || (fixed.length > 0 ? "/" : "");
  const rooted =
    (win ? NodePath.win32 : NodePath.posix).isAbsolute(prefix) ||
    /^~(?=$|\/)/.test(prefix) ||
    (win && /^[a-z]:/i.test(prefix));
  if (rooted) {
    return prefix;
  }
  return prefix ? `${base}/${prefix}` : base;
}

function targetsOf(tool: ApprovalTool, input: Record<string, unknown>, win: boolean) {
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    return typeof input.file_path === "string" ? [input.file_path] : undefined;
  }
  if (tool === "Patch") {
    const { paths } = input;
    const listed = Array.isArray(paths) && paths.length > 0;
    return listed && paths.every((path) => typeof path === "string") ? paths : undefined;
  }
  const base = input.path ?? ".";
  if (typeof base !== "string") {
    return undefined;
  }
  if (tool === "Grep") {
    return [base];
  }
  const root = typeof input.pattern === "string" ? globRoot(input.pattern, base, win) : undefined;
  return root === undefined ? undefined : [base, root];
}

function pathRules(platform: NodeJS.Platform) {
  const win = platform === "win32";
  const path = win ? NodePath.win32 : NodePath.posix;
  const fold = (text: string) => (win || platform === "darwin" ? text.toLowerCase() : text);
  const within = (child: string, parent: string) =>
    fold(child) === fold(parent) ||
    fold(child).startsWith(fold(parent).replace(/[\\/]+$/, "") + path.sep);

  // POSIX follows a link before applying `..`, so an unresolved path can't be normalized first.
  function walk(absolute: string) {
    const root = path.parse(absolute).root;
    let real = follow(root);
    const named: string[] = [];
    for (const segment of absolute.slice(root.length).split(win ? /[\\/]+/ : /\/+/)) {
      if (segment === "" || segment === ".") {
        continue;
      }
      if (segment === "..") {
        real = path.dirname(real);
        named.pop();
        continue;
      }
      const name = win ? win32Name(segment) : segment;
      if (!name) {
        return undefined;
      }
      named.push(name);
      real = follow(path.join(real, name));
    }
    return { real, lexical: path.join(root, ...named) };
  }

  const roots = (protectedRoots[platform] ?? linuxRoots).map((root) => path.normalize(root));
  const browserRoots = roots.map((root) => fold(`${path.sep}${root}${path.sep}`));
  const isProtected = (target: string) =>
    target.split(/[\\/]+/).some((name) => credentialSegments.has(name.toLowerCase())) ||
    browserRoots.some((root) => fold(`${target}${path.sep}`).includes(root));

  return { win, path, within, walk, roots, isProtected };
}

function check(
  tool: Exclude<ApprovalTool, "Bash">,
  input: Record<string, unknown>,
  workspace: string,
  { home, dataDir, platform, skills = [] }: Context,
) {
  const { win, path, within, walk, roots, isProtected } = pathRules(platform);
  const realSkills = tool === "Read" || tool === "Glob" || tool === "Grep" ? skills : [];
  const readable = realSkills.flatMap((folder) => walk(path.resolve(folder))?.real ?? []);

  const realWorkspace = walk(path.resolve(workspace))?.real;
  const realHome = walk(path.resolve(home))?.real;
  const realData = walk(path.resolve(dataDir))?.real;
  if (!realWorkspace || !realHome || !realData) {
    return refused;
  }

  const resolve = (raw: string) => {
    if (raw.includes("\0")) {
      return undefined;
    }
    let target = (win ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/).test(raw) ? home + raw.slice(1) : raw;
    if (win) {
      target = target.replace(/^\/(?:cygdrive\/|mnt\/)?([a-z])(?=\/|$)/i, "$1:/");
      // `C:foo` depends on a per-drive working directory we can't see.
      if (/^[a-z]:(?![\\/])/i.test(target)) {
        return undefined;
      }
      if (/^[\\/]{2}/.test(target)) {
        // Checked before any fs call: touching a UNC path would reach out to that host.
        target = target.replace(/^[\\/]{2}[?.][\\/]/, "");
        const plain = path.normalize(target);
        const inWorkspace = within(plain, workspace) || within(plain, realWorkspace);
        if (!path.isAbsolute(target) || !inWorkspace) {
          return undefined;
        }
      }
      return walk(path.resolve(realWorkspace, target));
    }
    return walk(path.isAbsolute(target) ? target : `${realWorkspace}/${target}`);
  };

  const targets = targetsOf(tool, input, win);
  if (!targets) {
    return refused;
  }
  const search = tool === "Glob" || tool === "Grep";
  const namesCredentials = [input.pattern, input.glob].some(
    (text) =>
      typeof text === "string" &&
      text.split(/[\\/{},]+/).some((name) => credentialSegments.has(name.toLowerCase())),
  );
  let inside = true;
  let writeTarget: string | undefined;
  for (const target of targets) {
    const resolved = resolve(target);
    if (!resolved) {
      return refused;
    }
    const { real, lexical } = resolved;
    writeTarget = tool === "Write" ? real : undefined;
    if (within(real, realWorkspace)) {
      // A project holds the owner's real secrets. A private workspace, always under the data dir,
      // holds only what the bot made there.
      // shortcut: a search of the whole project names nothing protected, so Always allow still
      // covers a Grep that reads `.npmrc`. Pass exclude globs to it if that ever matters.
      const project = !within(realWorkspace, realData);
      if (project && (isProtected(real) || isProtected(lexical) || (search && namesCredentials))) {
        inside = false;
      }
      continue;
    }
    // A skill counts as the bot's own to read: the owner reviewed it, and Always allow may cover it.
    if (readable.some((folder) => within(real, folder))) {
      continue;
    }
    inside = false;

    const searchesTooMuch =
      search &&
      (within(realHome, real) ||
        within(realData, real) ||
        namesCredentials ||
        roots.some((root) => within(path.join(realHome, root), real)));
    if (
      isProtected(real) ||
      isProtected(lexical) ||
      within(real, realData) ||
      searchesTooMuch ||
      (win && real.startsWith("\\\\"))
    ) {
      return refused;
    }
  }
  return { allowed: true, inside, writeTarget } as const;
}

// `inside` means every target is in the workspace. Bash can't be checked, so its card shows it all.
export function pathPolicy(
  tool: ApprovalTool,
  input: Record<string, unknown>,
  workspace: string,
  context: Context,
) {
  if (tool === "Bash") {
    return { allowed: true, inside: false, writeTarget: undefined } as const;
  }
  try {
    return check(tool, input, workspace, context);
  } catch {
    return refused;
  }
}

// Returns the real path to store. A protected name counts anywhere in the path, as it does in
// `check`, so nothing under a stored folder looks protected only because of where the folder is.
export function checkProjectFolder(raw: string, { home, dataDir, platform }: Context) {
  const { win, path, within, walk, roots, isProtected } = pathRules(platform);
  const refuse = (refused: string) => ({ refused, real: undefined });
  if (raw.includes("\0")) {
    return refuse("folder_not_absolute");
  }
  // Checked before any fs call: touching a UNC path would reach out to that host.
  if (win && /^[\\/]{2}/.test(raw)) {
    return refuse("folder_network");
  }
  if (win ? !/^[a-z]:[\\/]/i.test(raw) : !path.isAbsolute(raw)) {
    return refuse("folder_not_absolute");
  }
  try {
    // Not resolved first: POSIX follows a link before applying `..`.
    const target = walk(raw);
    const realHome = walk(path.resolve(home))?.real;
    const realData = walk(path.resolve(dataDir))?.real;
    if (!target || !realHome || !realData) {
      return refuse("folder_not_found");
    }
    const { real, lexical } = target;
    if (win && real.startsWith("\\\\")) {
      return refuse("folder_network");
    }
    const stats = NodeFS.statSync(real, { throwIfNoEntry: false });
    if (!stats) {
      return refuse("folder_not_found");
    }
    if (!stats.isDirectory()) {
      return refuse("folder_not_directory");
    }
    if (real === path.parse(real).root) {
      return refuse("folder_root");
    }
    if (within(realHome, real)) {
      return refuse("folder_home");
    }
    if (within(real, realData) || within(realData, real)) {
      return refuse("folder_bee_data");
    }
    if (
      isProtected(real) ||
      isProtected(lexical) ||
      roots.some((root) => within(path.join(realHome, root), real))
    ) {
      return refuse("folder_protected");
    }
    return { real, refused: undefined };
  } catch {
    return refuse("folder_not_found");
  }
}
