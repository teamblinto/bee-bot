const defaultGapMs = 15_000;

// Time the machine was awake. A suspend/resume pair is authoritative; without one (headless), a
// gap between observations far longer than the ticker's interval is taken as sleep, since no
// timer runs while the machine is suspended.
export function createAwakeClock(now: () => number = Date.now, gapMs = defaultGapMs) {
  let asleepMs = 0;
  let lastSeen = now();
  let suspendedAt: number | undefined;

  function observe() {
    const at = now();
    if (suspendedAt === undefined && at - lastSeen > gapMs) {
      asleepMs += at - lastSeen;
    }
    lastSeen = at;
  }

  return {
    observe,
    suspend: () => {
      observe();
      suspendedAt ??= now();
    },
    resume: () => {
      if (suspendedAt !== undefined) {
        asleepMs += now() - suspendedAt;
        suspendedAt = undefined;
        lastSeen = now();
      }
    },
    awakeNow: () => {
      observe();
      return (suspendedAt ?? now()) - asleepMs;
    },
  };
}
export type AwakeClock = ReturnType<typeof createAwakeClock>;

// A deadline in awake time: a timer that fires on wake re-arms for whatever the sleep didn't use.
export function awakeTimeout(
  clock: AwakeClock,
  ms: number,
  work: () => void,
  rearmed: () => void = () => {},
) {
  const due = clock.awakeNow() + ms;
  const leftMs = () => due - clock.awakeNow();
  const check = () => {
    if (leftMs() <= 0) {
      work();
    } else {
      timer = setTimeout(check, leftMs());
      rearmed();
    }
  };
  let timer = setTimeout(check, ms);
  return { leftMs, cancel: () => clearTimeout(timer) };
}

// A live turn means a live process: an engine settles its turn once the process exits. So silence
// is the only signal left to read, and a tool in flight is never silence.
export function createWatchdog(clock: AwakeClock, silenceMs: number) {
  const inFlight = new Set<string>();
  let lastActivity = clock.awakeNow();
  const touch = () => {
    lastActivity = clock.awakeNow();
  };
  return {
    touch,
    toolStart: (id: string) => {
      inFlight.add(id);
      touch();
    },
    toolEnd: (id: string) => {
      inFlight.delete(id);
      touch();
    },
    busy: () => inFlight.size > 0,
    stalled: () => inFlight.size === 0 && clock.awakeNow() - lastActivity >= silenceMs,
  };
}
