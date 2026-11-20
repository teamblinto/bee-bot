import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { imageDir } from "./podman.ts";

const buildInputs = [
  "Containerfile",
  "engine.sh",
  "browser.sh",
  "tmux.conf",
  "chromium-policy.json",
  "chromium.flags",
  "xfce/helpers.rc",
  "xfce/xfconf/xfce-perchannel-xml/xfce4-desktop.xml",
  "xfce/xfconf/xfce-perchannel-xml/xfce4-panel.xml",
  "xfce/xfconf/xfce-perchannel-xml/xsettings.xml",
];

// A Podman machine keeps an image by its tag and setup only builds a missing one, so changed
// inputs under the old tag never reach a machine that already has it.
it("names a new image tag whenever what the image is built from changes", () => {
  const hash = createHash("sha256");
  for (const name of buildInputs) {
    hash.update(name).update(readFileSync(join(imageDir, name), "utf8").replaceAll("\r\n", "\n"));
  }
  const { image } = JSON.parse(readFileSync(join(imageDir, "runSpec.json"), "utf8"));
  expect(`${image} ${hash.digest("hex").slice(0, 16)}`).toBe(
    "localhost/beebot-box:5 e6996b507c3bcb69",
  );
});
