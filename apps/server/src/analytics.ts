import * as NodeCrypto from "node:crypto";

import {
  ErrorReport,
  protocolVersion,
  toErrorReport,
  type UsageEventName,
  UsageEvents,
  type UsageProperties,
} from "@beebot/contracts";

const maxQueued = 500;
const flushAtCount = 50;
const flushEveryMs = 30_000;
const sendTimeoutMs = 10_000;
const shutdownTimeoutMs = 1000;

export type AnalyticsConfig = {
  key: string;
  host: string;
  appVersion: string;
  environmentId: string;
  // The owner's usage-data setting, read on every event and every send.
  consent: () => boolean;
};

type Captured = {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
};

// Sends usage events to PostHog's batch API. Every failure is swallowed: usage data never blocks
// or breaks Bee Bot. Without a config, or with BEEBOT_TELEMETRY=0, nothing is ever sent.
export function createAnalytics(
  config: AnalyticsConfig | undefined,
  { env = process.env, send = fetch } = {},
) {
  const on = env.BEEBOT_TELEMETRY === "0" ? undefined : config;
  const distinctId = on
    ? NodeCrypto.createHash("sha256").update(on.environmentId).digest("hex")
    : "";
  let queue: Captured[] = [];
  let timer: NodeJS.Timeout | undefined;

  function allowed() {
    try {
      return on !== undefined && on.consent();
    } catch {
      return false;
    }
  }

  function enqueue(event: string, properties: Record<string, unknown>) {
    if (!on || !allowed()) {
      queue = [];
      return;
    }
    if (queue.length >= maxQueued) {
      return;
    }
    queue.push({
      event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        ...properties,
        app_version: on.appVersion,
        protocol_version: protocolVersion,
        os: process.platform,
        arch: process.arch,
        $lib: "beebot",
        // Anonymous events, and no location looked up from the sender's address.
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    if (queue.length >= flushAtCount) {
      void flush();
    } else {
      timer ??= setTimeout(() => void flush(), flushEveryMs).unref();
    }
  }

  async function flush(timeoutMs = sendTimeoutMs) {
    clearTimeout(timer);
    timer = undefined;
    const batch = queue;
    queue = [];
    // Consent read again here: turning usage data off drops whatever was waiting.
    if (!on || batch.length === 0 || !allowed()) {
      return;
    }
    try {
      await send(new URL("/batch/", on.host), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: on.key, batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // PostHog unreachable: the batch is dropped, never retried.
    }
  }

  function reportError(report: ErrorReport) {
    const parsed = ErrorReport.safeParse(report);
    if (!parsed.success) {
      return;
    }
    const { source, name, frames } = parsed.data;
    const platform = source === "web" ? "web:javascript" : "node:javascript";
    enqueue("$exception", {
      $exception_source: source,
      $exception_list: [
        {
          type: name,
          value: name,
          mechanism: { handled: false, synthetic: false },
          stacktrace: {
            type: "raw",
            // V8 lists the throwing frame first. PostHog expects it last.
            frames: frames.toReversed().map((frame) => ({
              ...frame,
              platform,
              lang: "javascript",
              in_app: true,
            })),
          },
        },
      ],
    });
  }

  return {
    // Checked at runtime against the event's own schema, so it takes properties from anywhere.
    track(event: UsageEventName, properties: unknown) {
      const parsed = UsageEvents[event].safeParse(properties);
      if (!parsed.success) {
        // Only the event's name: its values are what was refused.
        console.error(`beebotd: usage event ${event} refused`);
        return;
      }
      enqueue(event, parsed.data);
    },
    captureError: (error: unknown) => reportError(toErrorReport(error, "server")),
    reportError,
    flush,
    shutdown: () => flush(shutdownTimeoutMs),
  };
}

let analytics = createAnalytics(undefined);

export function startAnalytics(config: AnalyticsConfig | undefined) {
  analytics = createAnalytics(config);
}

export function track<E extends UsageEventName>(event: E, properties: UsageProperties<E>) {
  analytics.track(event, properties);
}

// For events from the desktop, whose properties arrive untyped over stdin.
export function trackUnchecked(event: UsageEventName, properties: unknown) {
  analytics.track(event, properties);
}

export function captureError(error: unknown) {
  analytics.captureError(error);
}

// An error from the desktop's main process or the web app, already reduced to type and frames.
export function reportError(report: ErrorReport) {
  analytics.reportError(report);
}

// Sends what is queued, waiting at most a second.
export function shutdownAnalytics() {
  return analytics.shutdown();
}
