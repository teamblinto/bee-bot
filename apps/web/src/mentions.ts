import { mentionKey } from "@beebot/contracts";

const typing = /(?:^|\s)@([\p{L}\p{N}_.-]*)$/u;

// The mention being typed just before the caret, if any.
export function mentionAt(text: string, caret: number) {
  const match = typing.exec(text.slice(0, caret));
  if (!match) {
    return undefined;
  }
  const query = match[1] ?? "";
  return { query, start: caret - query.length - 1 };
}

export const mentionMatches = <T extends { name: string }>(members: T[], query: string) =>
  members.filter(({ name }) => mentionKey(name).startsWith(query.toLowerCase()));

// Replaces the typed mention with the member's full key, so the router finds exactly them.
export function insertMention(text: string, caret: number, start: number, name: string) {
  const inserted = `@${mentionKey(name)} `;
  const after = text.slice(caret).replace(/^\s/, "");
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}
