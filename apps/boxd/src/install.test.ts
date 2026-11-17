import { expect, it } from "vite-plus/test";

import { machineInstallScript } from "./install.ts";

it("never lets the box image name out of its shell quotes", () => {
  expect(() => machineInstallScript(".beebot/boxd", "x'; rm -rf ~; '", [])).toThrow(
    "bad box image",
  );
  expect(machineInstallScript(".beebot/boxd", "localhost/beebot-box:4", [])).toContain(
    "'localhost/beebot-box:4'",
  );
});
