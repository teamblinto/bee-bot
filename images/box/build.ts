import { spawnSync } from "node:child_process";

import { runSpec } from "./index.ts";
import { buildArgs, podmanBin } from "./podman.ts";

const tag = process.argv[2] ?? runSpec.image;
const result = spawnSync(podmanBin, buildArgs(tag), { stdio: "inherit" });
process.exit(result.status ?? 1);
