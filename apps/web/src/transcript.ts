import type {
  Approval,
  ChatMessage,
  Continuation,
  PendingApproval,
  Routine,
  RoutineFiring,
} from "@beebot/contracts";

export type TranscriptItem = { at: string; sender: ChatMessage["author"] } & (
  | { kind: "message"; message: ChatMessage }
  | { kind: "approval"; approval: Approval; pending: PendingApproval | undefined }
  | { kind: "continuation"; continuation: Continuation }
  | { kind: "routine"; routine: Routine; firing: RoutineFiring }
);

export function itemKey(item: TranscriptItem) {
  if (item.kind === "message") {
    return item.message.id;
  }
  if (item.kind === "continuation") {
    return item.continuation.id;
  }
  return item.kind === "approval" ? item.approval.id : item.firing.id;
}

// These wait on the owner, so they stay at the bottom until answered.
export const isOpenItem = (item: TranscriptItem) =>
  item.kind === "routine" ||
  item.kind === "continuation" ||
  (item.kind === "approval" && item.pending !== undefined);

// The server posts a Box action's outcome under this ID, as the answer to the bot's waiting reply.
export const isOutcomeMessage = (message: ChatMessage) => message.id.startsWith("continuation:");

// A pending approval without its in-memory detail has nothing to show yet.
export function buildTranscript(
  messages: ChatMessage[],
  approvals: Approval[],
  pending: PendingApproval[],
  cards: Array<{ routine: Routine; firing: RoutineFiring }>,
  continuations: Continuation[] = [],
) {
  const items: TranscriptItem[] = messages.map((message) => ({
    kind: "message",
    message,
    at: message.createdAt,
    sender: message.author,
  }));
  for (const approval of approvals) {
    const detail = pending.find(({ id }) => id === approval.id);
    if (approval.status !== "pending" || detail) {
      items.push({
        kind: "approval",
        approval,
        pending: approval.status === "pending" ? detail : undefined,
        at: approval.createdAt,
        sender: "bot",
      });
    }
  }
  for (const continuation of continuations) {
    items.push({ kind: "continuation", continuation, at: continuation.createdAt, sender: "bot" });
  }
  for (const { routine, firing } of cards) {
    items.push({ kind: "routine", routine, firing, at: firing.createdAt, sender: "bot" });
  }
  return items.toSorted((a, b) => a.at.localeCompare(b.at));
}
