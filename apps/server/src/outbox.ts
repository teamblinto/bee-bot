import type { Backoff, OutboxItem } from "./effects.ts";
import type { EventStore } from "./store.ts";

const maxAttempts = 12;

export const outboxBackoff: Backoff = (attempts) =>
  attempts >= maxAttempts ? null : Math.min(30_000, 100 * 2 ** attempts);

// Delivery is at least once: a crash between a handler and its mark delivers the row again, so a
// handler makes its write idempotent on `item.idempotencyKey`.
export type Deliver = (item: OutboxItem) => Promise<void>;

export function createOutboxWorker(
  effects: EventStore["effects"],
  handlers: ReadonlyMap<string, Deliver>,
  backoff: Backoff = outboxBackoff,
) {
  const inFlight = new Map<string, Promise<void>>();

  async function attempt(item: OutboxItem, deliver: Deliver) {
    try {
      await deliver(item);
    } catch {
      // Payloads can quote messages, so only the row is named.
      console.error(`beebotd: outbox ${item.id} (${item.kind}) attempt failed`);
      effects.markOutboxAttemptFailed(item.id, backoff);
      return;
    }
    effects.markDelivered(item.id);
  }

  return {
    // A kind with no handler stays pending for the build that knows it.
    drain: (now = new Date().toISOString()) => {
      for (const item of effects.duePendingOutbox(now)) {
        const deliver = handlers.get(item.kind);
        if (!deliver || inFlight.has(item.id)) {
          continue;
        }
        const running = attempt(item, deliver)
          .catch((error: unknown) => console.error(error))
          .finally(() => inFlight.delete(item.id));
        inFlight.set(item.id, running);
      }
    },
    idle: () => Promise.all(inFlight.values()),
  };
}
