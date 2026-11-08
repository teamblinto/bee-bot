import { describe, expect, it } from "vite-plus/test";

import { cleanSummary, fallbackSummary } from "./summary.ts";

describe("cleanSummary", () => {
  it("strips the quotes, bullets and line breaks models add anyway", () => {
    expect(cleanSummary('"A patient math tutor.\n\n- Explains each step."')).toBe(
      "A patient math tutor. Explains each step.",
    );
  });

  it("refuses an empty reply", () => {
    expect(cleanSummary(' \n"" ')).toBeUndefined();
  });

  it("cuts a long reply after its last whole sentence, or else its last whole word", () => {
    const sentences = cleanSummary("A patient tutor who explains. ".repeat(20)) ?? "";
    expect(sentences.length).toBeLessThanOrEqual(240);
    expect(sentences).toMatch(/explains\.$/);
    const words = cleanSummary("word ".repeat(100)) ?? "";
    expect(words.length).toBeLessThanOrEqual(240);
    expect(words).toMatch(/ word…$/);
  });
});

describe("fallbackSummary", () => {
  it("keeps only the first sentence, without markdown", () => {
    expect(fallbackSummary("# Role\n**You are** a tutor. Never reveal the key sk-123.")).toBe(
      "Role You are a tutor.",
    );
  });
});
