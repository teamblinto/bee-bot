import type { HandoffInput } from "@beebot/contracts";

// What the owner typed while holding the browser, kept in memory only and only for as long as the
// browser session lives: masking a value means knowing it. `current` is the run of keys since the
// last click, Enter or Tab.
export type Typing = { current: string; secrets: string[] };

export const noTyping: Typing = { current: "", secrets: [] };

// Shorter values would mask ordinary words all over the page.
const minSecretLength = 3;
export const mask = "[typed by owner]";

export function addSecret(typing: Typing, text: string): Typing {
  return text.length < minSecretLength || typing.secrets.includes(text)
    ? typing
    : { ...typing, secrets: [...typing.secrets, text] };
}

export const flushTyping = (typing: Typing): Typing => ({
  ...addSecret(typing, typing.current),
  current: "",
});

export function trackTyping(typing: Typing, input: HandoffInput): Typing {
  if (input.type === "mouse") {
    return input.action === "down" ? flushTyping(typing) : typing;
  }
  if (input.action !== "down") {
    return typing;
  }
  if (input.key === "Enter" || input.key === "Tab") {
    return flushTyping(typing);
  }
  if (input.key === "Backspace") {
    return { ...typing, current: typing.current.slice(0, -1) };
  }
  return [...input.key].length === 1 ? { ...typing, current: typing.current + input.key } : typing;
}

// Longest first, so a value that contains another is masked whole. The encoded form covers a value
// that a form put into the URL.
export function redact(text: string, typing: Typing) {
  const secrets = flushTyping(typing)
    .secrets.flatMap((secret) => [secret, encodeURIComponent(secret)])
    .toSorted((a, b) => b.length - a.length);
  return secrets.reduce((masked, secret) => masked.replaceAll(secret, mask), text);
}
