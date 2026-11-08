import type { HandoffInput } from "@beebot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addSecret, mask, noTyping, redact, trackTyping, type Typing } from "./browserRedact.ts";

const keys = (text: string): HandoffInput[] =>
  [...text].map((key) => ({ type: "key", action: "down", key, code: "" }));
const press = (key: string): HandoffInput => ({ type: "key", action: "down", key, code: key });
const click: HandoffInput = { type: "mouse", action: "down", x: 1, y: 1, button: "left" };
const typed = (inputs: HandoffInput[]) => inputs.reduce<Typing>(trackTyping, noTyping);

describe("owner input redaction", () => {
  it("masks each value the owner typed, field by field", () => {
    const typing = typed([
      ...keys("ada@example.com"),
      press("Tab"),
      ...keys("hunter22"),
      press("Enter"),
    ]);
    expect(redact("Hi ada@example.com, your password hunter22 was wrong", typing)).toBe(
      `Hi ${mask}, your password ${mask} was wrong`,
    );
  });

  it("follows corrections, and splits values at a click", () => {
    const typing = typed([...keys("pw1x"), press("Backspace"), press("!"), click, ...keys("zed")]);
    expect(redact("pw1! and zed", typing)).toBe(`${mask} and ${mask}`);
    expect(redact("pw1x", typing)).toBe("pw1x");
  });

  it("masks a value still being typed", () => {
    expect(redact("echo: secret", typed(keys("secret")))).toBe(`echo: ${mask}`);
  });

  it("ignores key releases and named keys", () => {
    const up: HandoffInput = { type: "key", action: "up", key: "q", code: "KeyQ" };
    expect(typed([press("Shift"), up, press("ArrowLeft"), ...keys("abc")]).current).toBe("abc");
  });

  it("masks the private field's text, its URL-encoded form, and a longer value whole", () => {
    const typing = addSecret(addSecret(noTyping, "p@ss word"), "p@ss");
    expect(redact("q=p%40ss%20word and p@ss word", typing)).toBe(`q=${mask} and ${mask}`);
  });

  it("leaves one or two typed characters, which would mask the whole page", () => {
    expect(redact("a b", typed([...keys("a"), click, ...keys("b")]))).toBe("a b");
  });
});
