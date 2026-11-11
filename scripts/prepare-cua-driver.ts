import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The build OpenMausBot pins. Bumping it means updating both hashes.
const version = "0.45.4";
const zipName = `cua-driver-rs-${version}-windows-x86_64-binary.zip`;
const zipUrl = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${zipName}`;
const zipSha256 = "949927b4cb0519c6fb1377878d67d79a8d6fae7bc56cbed17c7aa26448d82cb5";
const exeSha256 = "f87066ca41e6f8437923a372a2d3556c6131463f19d51a4be510f7e7c13eb4c5";

const vendorDir = NodePath.resolve(import.meta.dirname, "../apps/desktop/vendor/cua-driver");
const exe = NodePath.join(vendorDir, "cua-driver.exe");

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

if (NodeFS.existsSync(exe) && sha256(NodeFS.readFileSync(exe)) === exeSha256) {
  console.log(`cua-driver ${version} already at ${exe}`);
  process.exit(0);
}

console.log(`Downloading ${zipUrl}`);
const response = await fetch(zipUrl, { signal: AbortSignal.timeout(300_000) });
if (!response.ok) {
  throw new Error(`cua-driver download failed: HTTP ${response.status}`);
}
const zip = new Uint8Array(await response.arrayBuffer());
if (sha256(zip) !== zipSha256) {
  throw new Error(`${zipName} has SHA-256 ${sha256(zip)}, expected ${zipSha256}`);
}

NodeFS.rmSync(vendorDir, { recursive: true, force: true });
NodeFS.mkdirSync(vendorDir, { recursive: true });
const zipPath = NodePath.join(vendorDir, zipName);
NodeFS.writeFileSync(zipPath, zip);
try {
  // Windows' bsdtar reads zips; Git for Windows puts a GNU tar earlier on PATH that does not.
  const tar =
    process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
      : "tar";
  NodeChildProcess.execFileSync(tar, ["-xf", zipPath, "-C", vendorDir, "cua-driver.exe"], {
    stdio: "inherit",
  });
} catch (error) {
  throw new Error(
    `Couldn't extract cua-driver.exe from the root of ${zipName}; check the zip's layout`,
    { cause: error },
  );
} finally {
  NodeFS.rmSync(zipPath);
}

if (sha256(NodeFS.readFileSync(exe)) !== exeSha256) {
  NodeFS.rmSync(exe, { force: true });
  throw new Error(`Extracted cua-driver.exe does not match ${exeSha256}`);
}
console.log(`cua-driver ${version} ready at ${exe}`);
