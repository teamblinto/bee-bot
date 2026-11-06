import { expect, it } from "vite-plus/test";

import { visibleDetail } from "./labels";

it("shows characters that would hide or reorder a command, and leaves layout alone", () => {
  expect(visibleDetail("ls\n\tcat ‮gpj.exe\u0000")).toBe("ls\n\tcat [U+202E]gpj.exe[U+0000]");
});
