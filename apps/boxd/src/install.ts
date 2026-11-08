// Run by the server through `podman machine ssh <machine> bash -s` before boxd starts. The machine
// has no Node and no host file sharing (automount is off), so the runtime is downloaded by
// checksum and boxd's own files arrive inside this script over stdin.
const nodeVersion = "v26.13.0";
const nodeSums = {
  x86_64: ["x64", "d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997"],
  aarch64: ["arm64", "406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92"],
};

export const nodeBin = "node/bin/node";

export function machineInstallScript(
  installDir: string,
  files: (readonly [name: string, content: Uint8Array])[],
) {
  if (
    !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(installDir) ||
    installDir.split("/").includes("..")
  ) {
    throw new Error(`bad boxd install dir ${installDir}`);
  }
  const nodeCases = Object.entries(nodeSums)
    .map(([machine, [arch, sum]]) => `${machine}) arch=${arch}; sum=${sum};;`)
    .join(" ");
  const lines = [
    "set -eu",
    `d="$HOME/${installDir}"`,
    'mkdir -p "$d"',
    `case "$(uname -m)" in ${nodeCases} *) echo "unsupported machine $(uname -m)" >&2; exit 1;; esac`,
    // Node's Linux build links libatomic, which the Podman machine image leaves out.
    "ldconfig -p | grep -q 'libatomic.so.1' || sudo -n dnf install -y -q libatomic",
    `if [ "$("$d/${nodeBin}" --version 2>/dev/null || true)" != "${nodeVersion}" ]; then`,
    '  t="$(mktemp -d)"',
    `  curl -fsSL -o "$t/node.tar.xz" "https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-$arch.tar.xz"`,
    '  echo "$sum  $t/node.tar.xz" | sha256sum -c - >/dev/null',
    '  rm -rf "$d/node" && mkdir -p "$d/node"',
    '  tar -xJf "$t/node.tar.xz" -C "$d/node" --strip-components=1',
    '  rm -rf "$t"',
    "fi",
    `printf '{"type":"module"}' > "$d/package.json"`,
  ];
  for (const [name, content] of files) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`bad boxd file name ${name}`);
    }
    lines.push(
      `base64 -d > "$d/.${name}.tmp" <<'BEEBOT_EOF'`,
      Buffer.from(content).toString("base64"),
      "BEEBOT_EOF",
      `mv "$d/.${name}.tmp" "$d/${name}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}
