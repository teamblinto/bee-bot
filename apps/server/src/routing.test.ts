import type { ResponderMode } from "@beebot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isNoResponse, route } from "./routing.ts";

const members = [
  { id: "ada", name: "Ada" },
  { id: "ben", name: "Ben Ito" },
  { id: "cy", name: "Cy" },
];
const human = (
  body: string,
  fields: {
    defaultBotId?: string;
    replyToBotId?: string;
    mode?: ResponderMode;
    leadBotId?: string;
  } = {},
) =>
  route({
    body,
    members,
    defaultBotId: fields.defaultBotId ?? null,
    replyToBotId: fields.replyToBotId ?? null,
    authorBotId: null,
    mode: fields.mode ?? "mentions",
    leadBotId: fields.leadBotId ?? null,
  });

describe("routing a human's message", () => {
  it("wakes the reply target, then mentions in order, then nothing else", () => {
    expect(human("@cy and @ada, thoughts?", { replyToBotId: "ben", defaultBotId: "ada" })).toEqual({
      kind: "wake",
      botIds: ["ben", "cy", "ada"],
    });
    expect(human("@ada @Ada @ADA.")).toEqual({ kind: "wake", botIds: ["ada"] });
  });

  it("matches a spaced name by its first letters or without its spaces", () => {
    expect(human("@ben hi")).toEqual({ kind: "wake", botIds: ["ben"] });
    expect(human("@BenIto hi")).toEqual({ kind: "wake", botIds: ["ben"] });
  });

  it("falls back to the room default, then asks the human", () => {
    expect(human("anyone?", { defaultBotId: "cy" })).toEqual({ kind: "wake", botIds: ["cy"] });
    expect(human("anyone?")).toEqual({ kind: "ask" });
    expect(human("mail me at a@ada.dev")).toEqual({ kind: "ask" });
    expect(human("@nobody here")).toEqual({ kind: "ask" });
  });

  it("refuses a mention two members share instead of guessing", () => {
    const twins = [...members, { id: "ada2", name: "Ada" }];
    const prefix = [...members, { id: "cyd", name: "Cyd" }, { id: "cyra", name: "Cyra" }];
    const send = (body: string, list: typeof members) =>
      route({
        body,
        members: list,
        defaultBotId: "cy",
        replyToBotId: null,
        authorBotId: null,
        mode: "mentions",
        leadBotId: null,
      });
    expect(send("@ada go", twins)).toEqual({ kind: "ambiguous", mention: "ada" });
    expect(send("@cyd go", prefix)).toEqual({ kind: "wake", botIds: ["cyd"] });
    expect(send("@cy go", prefix)).toEqual({ kind: "wake", botIds: ["cy"] });
    expect(send("@cyr go", prefix)).toEqual({ kind: "wake", botIds: ["cyra"] });
    const noExact = [...members, { id: "bea", name: "Bea" }];
    expect(send("@be go", noExact)).toEqual({ kind: "ambiguous", mention: "be" });
  });

  it("ignores a reply to someone who left", () => {
    expect(human("ok", { replyToBotId: "gone" })).toEqual({ kind: "ask" });
  });

  it("wakes every member in join order for an un-addressed message in everyone_optional", () => {
    expect(human("thoughts?", { mode: "everyone_optional", defaultBotId: "cy" })).toEqual({
      kind: "wake",
      botIds: ["ada", "ben", "cy"],
      everyone: true,
    });
  });

  it("sends an un-addressed message to the lead in lead mode, and to the default when the lead left", () => {
    expect(human("go", { mode: "lead", leadBotId: "ben", defaultBotId: "cy" })).toEqual({
      kind: "wake",
      botIds: ["ben"],
    });
    expect(human("go", { mode: "lead", leadBotId: "gone", defaultBotId: "cy" })).toEqual({
      kind: "wake",
      botIds: ["cy"],
    });
    expect(human("go", { mode: "lead", leadBotId: "gone" })).toEqual({ kind: "ask" });
    expect(human("go", { mode: "default", defaultBotId: "cy" })).toEqual({
      kind: "wake",
      botIds: ["cy"],
    });
  });

  it("lets a reply or a mention win in every mode", () => {
    for (const mode of ["mentions", "default", "everyone_optional", "lead"] as const) {
      const fields = { mode, leadBotId: "ada", defaultBotId: "ada" };
      expect(human("@cy go", fields)).toEqual({ kind: "wake", botIds: ["cy"] });
      expect(human("ok", { ...fields, replyToBotId: "ben" })).toEqual({
        kind: "wake",
        botIds: ["ben"],
      });
    }
  });
});

describe("routing a bot's message", () => {
  const bot = (body: string) =>
    route({
      body,
      members,
      defaultBotId: "ada",
      replyToBotId: null,
      authorBotId: "ada",
      mode: "everyone_optional",
      leadBotId: "ben",
    });

  it("wakes only the bots it names, never itself or the default", () => {
    expect(bot("@ben can you check? cc @ada")).toEqual({ kind: "wake", botIds: ["ben"] });
    expect(bot("Done.")).toEqual({ kind: "none" });
  });
});

describe("the NO_RESPONSE sentinel", () => {
  it("matches only the whole trimmed output", () => {
    expect(isNoResponse("NO_RESPONSE")).toBe(true);
    expect(isNoResponse("  NO_RESPONSE\n")).toBe(true);
    expect(isNoResponse("NO_RESPONSE.")).toBe(false);
    expect(isNoResponse("no_response")).toBe(false);
    expect(isNoResponse("I have nothing. NO_RESPONSE")).toBe(false);
    expect(isNoResponse("")).toBe(false);
  });
});
