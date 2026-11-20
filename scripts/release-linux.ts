// Packs a built tree (`pnpm build`) into release/beebot-<version>.tar.gz for a Linux host: what
// /opt/beebot/releases/<version> holds. Every bundle is self-contained, so no node_modules ship.
// The box image doesn't either: install.sh builds it on the host, or takes a `podman save` of it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const sha = NodeChildProcess.execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })
  .toString()
  .trim();
// Sorts by build time, so two builds of one commit are still two releases.
const version = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${sha}`;
const name = `beebot-${version}`;
const outDir = NodePath.join(root, "release");
const stage = NodePath.join(outDir, name);

const noMaps = (path: string) => !path.endsWith(".map");
const sources = (path: string) =>
  NodeFS.statSync(path).isDirectory() ||
  (path.endsWith(".ts") && !path.endsWith(".test.ts") && NodePath.basename(path) !== "testing.ts");
// The box Containerfile's build context (what .containerignore lets in), plus what the server reads.
const boxFiles = new Set([
  "Containerfile",
  ".containerignore",
  "runSpec.json",
  "claude-code.sha256",
  "seccomp-chromium.json",
  "engine.sh",
  "browser.sh",
  "tmux.conf",
  "chromium-policy.json",
  "chromium.flags",
  "xfce",
]);
const boxImage = (path: string) => {
  const [top = ""] = NodePath.relative(NodePath.join(root, "images/box"), path).split(NodePath.sep);
  return top === "" || boxFiles.has(top);
};

const parts: [string, ((path: string) => boolean)?][] = [
  ["apps/server/dist", noMaps],
  ["apps/gateway/dist", noMaps],
  ["apps/web/dist", noMaps],
  ["apps/boxd/package.json"],
  ["apps/boxd/src", sources],
  ["apps/boxd/egress/dist/egress.mjs"],
  ["apps/provision/package.json"],
  ["apps/provision/src/beebot-provision.ts"],
  ["apps/provision/system"],
  ["images/box", boxImage],
  ["deploy"],
  ["THIRD_PARTY_NOTICES.md"],
];

NodeFS.rmSync(stage, { recursive: true, force: true });
for (const [part, filter] of parts) {
  const from = NodePath.join(root, part);
  if (!NodeFS.existsSync(from)) {
    throw new Error(`${part} is missing: run pnpm build first`);
  }
  NodeFS.cpSync(from, NodePath.join(stage, part), { recursive: true, filter });
}
NodeFS.writeFileSync(NodePath.join(stage, "VERSION"), `${version}\n`);

const tarball = NodePath.join(outDir, `${name}.tar.gz`);
const tar = NodeChildProcess.spawnSync("tar", ["-czf", `${name}.tar.gz`, name], {
  cwd: outDir,
  stdio: "inherit",
});
if (tar.status !== 0) {
  throw new Error(`tar exited ${tar.status}`);
}
NodeFS.rmSync(stage, { recursive: true });
console.log(`${tarball} (${(NodeFS.statSync(tarball).size / 1e6).toFixed(1)} MB)`);
