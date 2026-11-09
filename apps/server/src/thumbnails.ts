// The monitor wall's thumbnails share one small frame budget, taken only while someone watches the
// wall. Adapted from OpenMausBot's server/computer-frames.ts (Apache-2.0).

export type Thumbnail = { botId: string; data: Buffer; at: number };

const maxBackoffMs = 120_000;

// A token bucket: `perSecond` captures a second on average, never more than one second's worth at once.
export function createFrameBudget(perSecond: number, now: () => number) {
  let tokens = perSecond;
  let refilledAt = now();
  return {
    take() {
      const at = now();
      tokens = Math.min(perSecond, tokens + ((at - refilledAt) / 1_000) * perSecond);
      refilledAt = at;
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}

export function createThumbnails({
  running,
  working,
  held,
  capture,
  onFrame,
  onHeld,
  now = Date.now,
  framesPerSecond = 4,
  concurrency = 3,
  workingIntervalMs = 3_000,
  idleIntervalMs = 30_000,
  tickMs = 250,
  lingerMs = 5_000,
}: {
  // Bots whose box is running now. A stopped box is never captured.
  running: () => string[];
  working: (botId: string) => boolean;
  // A person controls this bot's screen: nothing on it may be captured.
  held: (botId: string) => boolean;
  capture: (botId: string) => Promise<Buffer>;
  onFrame: (frame: Thumbnail) => void;
  onHeld: (held: string[]) => void;
  now?: () => number;
  framesPerSecond?: number;
  concurrency?: number;
  workingIntervalMs?: number;
  idleIntervalMs?: number;
  tickMs?: number;
  // Capturing stops this long after the last watcher leaves.
  lingerMs?: number;
}) {
  const budget = createFrameBudget(framesPerSecond, now);
  const frames = new Map<string, Thumbnail>();
  const failures = new Map<string, { count: number; until: number }>();
  const inFlight = new Set<string>();
  let heldNow: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopAt: number | undefined;

  function dueAt(botId: string, at: number) {
    if (held(botId) || inFlight.has(botId) || at < (failures.get(botId)?.until ?? 0)) {
      return undefined;
    }
    const last = frames.get(botId)?.at;
    return last === undefined ? 0 : last + (working(botId) ? workingIntervalMs : idleIntervalMs);
  }

  async function take(botId: string) {
    inFlight.add(botId);
    try {
      const data = await capture(botId);
      // The owner may have taken control while the frame was on its way.
      if (held(botId) || timer === undefined) {
        return;
      }
      const frame = { botId, data, at: now() };
      frames.set(botId, frame);
      failures.delete(botId);
      onFrame(frame);
    } catch {
      const count = (failures.get(botId)?.count ?? 0) + 1;
      failures.set(botId, {
        count,
        until: now() + Math.min(maxBackoffMs, 5_000 * 2 ** (count - 1)),
      });
    } finally {
      inFlight.delete(botId);
    }
  }

  function tick() {
    const at = now();
    if (stopAt !== undefined && at >= stopAt) {
      stop();
      return;
    }
    const bots = running();
    for (const botId of frames.keys()) {
      if (!bots.includes(botId)) {
        frames.delete(botId);
        failures.delete(botId);
      }
    }
    const nextHeld = bots.filter(held);
    if (nextHeld.join() !== heldNow.join()) {
      heldNow = nextHeld;
      onHeld(heldNow);
    }
    const due = bots
      .map((botId) => ({ botId, due: dueAt(botId, at) }))
      .filter((entry): entry is { botId: string; due: number } => entry.due !== undefined)
      .filter(({ due }) => due <= at)
      .sort((a, b) => a.due - b.due);
    for (const { botId } of due) {
      if (inFlight.size >= concurrency || !budget.take()) {
        break;
      }
      void take(botId);
    }
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
    stopAt = undefined;
  }

  return {
    // Whether any client watches the wall now.
    watch(watching: boolean) {
      if (!watching) {
        stopAt = timer === undefined ? undefined : now() + lingerMs;
        return;
      }
      stopAt = undefined;
      if (timer === undefined) {
        timer = setInterval(tick, tickMs);
        timer.unref();
        tick();
      }
    },
    // What a client that just joined the wall is sent.
    frames: () => [...frames.values()],
    held: () => heldNow,
    watching: () => timer !== undefined,
    close: stop,
  };
}

export type Thumbnails = ReturnType<typeof createThumbnails>;
