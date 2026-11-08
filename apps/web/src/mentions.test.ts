import { describe, expect, it } from "vite-plus/test";

import { insertMention, mentionAt, mentionMatches } from "./mentions";

const members = [{ name: "Ada" }, { name: "Ben Ito" }, { name: "Bea" }];

describe("the mention picker", () => {
  it("finds the mention being typed before the caret, and nothing else", () => {
    expect(mentionAt("hi @be", 6)).toEqual({ query: "be", start: 3 });
    expect(mentionAt("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionAt("mail a@ada", 10)).toBeUndefined();
    expect(mentionAt("@ada done", 9)).toBeUndefined();
  });

  it("offers members whose mention starts with the query", () => {
    expect(mentionMatches(members, "BE").map(({ name }) => name)).toEqual(["Ben Ito", "Bea"]);
    expect(mentionMatches(members, "benI").map(({ name }) => name)).toEqual(["Ben Ito"]);
  });

  it("inserts the full mention in place of the typed one", () => {
    const text = "ask @be about it";
    expect(insertMention(text, 7, 4, "Ben Ito")).toEqual({
      text: "ask @benito about it",
      caret: 12,
    });
  });
});
