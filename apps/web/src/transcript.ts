import type { Approval, ChatMessage, PendingApproval } from "@beebot/contracts";

export type TranscriptItem = { at: string; sender: ChatMessage["author"] } & (
  | { kind: "message"; message: ChatMessage }
  | { kind: "approval"; approval: Approval; pending: PendingApproval | undefined }
);

// A pending approval without its in-memory detail has nothing to show yet.
export function buildTranscript(
  messages: ChatMessage[],
  approvals: Approval[],
  pending: PendingApproval[],
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
  return items.toSorted((a, b) => a.at.localeCompare(b.at));
}
