import { mentionKey, type ResponderMode } from "@beebot/contracts";

export type Member = { id: string; name: string };

export type Route =
  | { kind: "wake"; botIds: string[]; everyone?: true }
  | { kind: "ask" }
  | { kind: "ambiguous"; mention: string }
  | { kind: "none" };

export const noResponse = "NO_RESPONSE";

export const everyoneOptionalCap = 6;

export const isNoResponse = (text: string) => text.trim() === noResponse;

const mentionPattern = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu;

function mentioned(body: string, members: Member[]) {
  const ids: string[] = [];
  for (const [, raw = ""] of body.matchAll(mentionPattern)) {
    const token = raw.replace(/[.-]+$/, "").toLowerCase();
    const exact = members.filter(({ name }) => mentionKey(name) === token);
    const prefixed = members.filter(({ name }) => mentionKey(name).startsWith(token));
    const matches = exact.length > 0 ? exact : prefixed;
    if (matches.length > 1) {
      return { ambiguous: raw };
    }
    const [member] = matches;
    if (member && !ids.includes(member.id)) {
      ids.push(member.id);
    }
  }
  return { ids };
}

// A human's message: the bot it replies to, then mentions in order, then the room's mode, then
// the human picks. A bot's message wakes only the bots it mentions, never itself.
export function route(input: {
  body: string;
  members: Member[];
  defaultBotId: string | null;
  replyToBotId: string | null;
  authorBotId: string | null;
  mode: ResponderMode;
  leadBotId: string | null;
}): Route {
  const { body, defaultBotId, replyToBotId, authorBotId, mode, leadBotId } = input;
  const members = input.members.filter(({ id }) => id !== authorBotId);
  const isMember = (id: string | null) => members.some((member) => member.id === id);
  const found = mentioned(body, members);
  if ("ambiguous" in found) {
    return { kind: "ambiguous", mention: found.ambiguous };
  }
  if (authorBotId !== null) {
    return found.ids.length > 0 ? { kind: "wake", botIds: found.ids } : { kind: "none" };
  }
  const reply = replyToBotId !== null && isMember(replyToBotId) ? [replyToBotId] : [];
  const botIds = [...reply, ...found.ids.filter((id) => !reply.includes(id))];
  if (botIds.length > 0) {
    return { kind: "wake", botIds };
  }
  if (mode === "everyone_optional" && members.length > 0) {
    return { kind: "wake", botIds: members.map(({ id }) => id), everyone: true };
  }
  const fallback = mode === "lead" && isMember(leadBotId) ? leadBotId : defaultBotId;
  return fallback !== null && isMember(fallback)
    ? { kind: "wake", botIds: [fallback] }
    : { kind: "ask" };
}
