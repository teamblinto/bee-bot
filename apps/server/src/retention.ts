import type { EventStore } from "./store.ts";

export const eventRetentionMs = 30 * 24 * 60 * 60_000;

// The event log only. Messages, runs and turn summaries stay until the owner deletes them.
export const pruneEvents = (store: Pick<EventStore, "pruneEventsBefore">, now = Date.now()) =>
  store.pruneEventsBefore(new Date(now - eventRetentionMs).toISOString());
