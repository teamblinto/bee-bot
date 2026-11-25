import type {
  Approval,
  Bot,
  ChatState,
  Continuation,
  MemoryItem,
  Routine,
  RoutineFiring,
  TeamRequest,
} from "@beebot/contracts";

import { openCards } from "./serverConnection";

export type WaitingItem = { id: string; botId: string; createdAt: string } & (
  | { kind: "approval"; approval: Approval }
  | { kind: "continuation"; continuation: Continuation }
  | { kind: "routine"; routine: Routine; firing: RoutineFiring }
  | { kind: "budget"; bot: Bot }
  | { kind: "team_request"; request: TeamRequest }
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
    ...bots
      .filter(({ pauseReason }) => pauseReason === "budget")
      .map((bot) => ({
        kind: "budget" as const,
        id: `budget:${bot.id}`,
        botId: bot.id,
        createdAt: chat.runs.find(({ botId }) => botId === bot.id)?.endedAt ?? "",
        bot,
      })),
    ...chat.teamRequests.map((request) => ({
      kind: "team_request" as const,
      id: request.id,
      botId: request.requestedByBotId,
      createdAt: request.createdAt,
      request,
    })),
  ];
  return items
    .filter(({ botId }) => active.has(botId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const teamRequestKinds = {
  create_bot: "New bot",
  update_bot: "Edit bot",
  archive_bot: "Archive bot",
  create_room: "New room",
  invite_to_room: "Room invite",
} satisfies Record<TeamRequest["kind"], string>;

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
  if (item.kind === "budget") {
    return "Daily limit";
  }
  if (item.kind === "team_request") {
    return teamRequestKinds[item.request.kind];
  }
  return "Routine";
}

// Memories a bot asked to save, change or forget. They don't block the bot, so they're for review.
export const memoriesToReview = (chat: ChatState): MemoryItem[] => {
  const active = new Set(chat.bots.filter(({ archivedAt }) => !archivedAt).map(({ id }) => id));
  return chat.memories.filter(({ botId, status }) => status === "pending" && active.has(botId));
};

export const ownerActions = (chat: ChatState) =>
  chat.meetings
    .flatMap((meeting) =>
      meeting.records
        .filter(({ kind, ownerIsHuman, doneAt }) => kind === "action" && ownerIsHuman && !doneAt)
        .map((record) => ({ meeting, record })),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
