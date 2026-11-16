import type {
  Approval,
  ChatState,
  Continuation,
  MemoryItem,
  Routine,
  RoutineFiring,
} from "@beebot/contracts";

import { openCards } from "./serverConnection";

export type WaitingItem = { id: string; botId: string; createdAt: string } & (
  | { kind: "approval"; approval: Approval }
  | { kind: "continuation"; continuation: Continuation }
  | { kind: "routine"; routine: Routine; firing: RoutineFiring }
);

// Everything a bot is blocked on until the owner answers, oldest first. Archived bots can't be
// opened, so their items stay out.
export function waitingItems(chat: ChatState): WaitingItem[] {
  const bots = chat.bots.filter(({ archivedAt }) => !archivedAt);
  const active = new Set(bots.map(({ id }) => id));
  const items: WaitingItem[] = [
    ...chat.approvals
      .filter(({ status }) => status === "pending")
      .map((approval) => ({
        kind: "approval" as const,
        id: approval.id,
        botId: approval.botId,
        createdAt: approval.createdAt,
        approval,
      })),
    ...chat.continuations.map((continuation) => ({
      kind: "continuation" as const,
      id: continuation.id,
      botId: continuation.botId,
      createdAt: continuation.createdAt,
      continuation,
    })),
    ...bots.flatMap((bot) =>
      openCards(chat, bot.id).map(({ routine, firing }) => ({
        kind: "routine" as const,
        id: firing.id,
        botId: bot.id,
        createdAt: firing.createdAt,
        routine,
        firing,
      })),
    ),
  ];
  return items
    .filter(({ botId }) => active.has(botId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function waitingKind(item: WaitingItem) {
  if (item.kind === "approval") {
    const { tool } = item.approval;
    if (tool === "Bash") {
      return "Command";
    }
    return tool === "Read" || tool === "Glob" || tool === "Grep" ? "Read files" : "Edit files";
  }
  if (item.kind === "continuation") {
    return item.continuation.kind === "hand_off" ? "Hand-off" : "Continuation";
  }
  return "Routine";
}

// Memories a bot asked to save, change or forget. They don't block the bot, so they're for review.
export const memoriesToReview = (chat: ChatState): MemoryItem[] => {
  const active = new Set(chat.bots.filter(({ archivedAt }) => !archivedAt).map(({ id }) => id));
  return chat.memories.filter(({ botId, status }) => status === "pending" && active.has(botId));
};
