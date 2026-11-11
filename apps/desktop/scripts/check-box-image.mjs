import * as NodePath from "node:path";

import { missingSources } from "../../../images/box/containerfile.ts";

// A file the Containerfile COPYs but extraResources leaves out only fails on the owner's machine.
export default function checkBoxImage({ appOutDir, electronPlatformName, packager }) {
  const resources = ["darwin", "mas"].includes(electronPlatformName)
    ? NodePath.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : NodePath.join(appOutDir, "resources");
  const imageDir = NodePath.join(resources, "box", "images", "box");
  const missing = missingSources(imageDir);
  if (missing.length > 0) {
    throw new Error(
      `${imageDir} is missing ${missing.join(", ")}: add them to extraResources in electron-builder.yml`,
    );
  }
  console.log(`  • box image context complete  dir=${imageDir}`);
}
