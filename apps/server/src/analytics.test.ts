import { describe, expect, it, vi } from "vite-plus/test";

import { createAnalytics } from "./analytics.ts";

function setup({ consent = true, env = {} }: { consent?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const sent: Array<{
    api_key: string;
    batch: Array<{ distinct_id: string; properties: Record<string, unknown> }>;
  }> = [];
  const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
  const state = { consent };
  const analytics = createAnalytics(
    {
      key: "phc_test",
      host: "https://eu.i.posthog.com",
      appVersion: "1.2.3",
      environmentId: "env-1",
      consent: () => state.consent,
    },
    { env, send },
  );
  return { analytics, sent, send, state };
}

describe("analytics", () => {
  it("refuses a property outside the event's allowlist", async () => {
    const { analytics, sent } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    analytics.track("message_sent", {
      room: "dm",
      chars: 5,
      attachments: 0,
      mentions: 0,
      is_reply: false,
      body: "hello",
    });
    analytics.track("onboarding_viewed", { name: "Ada" });
    await analytics.flush();
    expect(sent).toEqual([]);
    expect(error.mock.calls.flat().join(" ")).not.toContain("hello");
    error.mockRestore();
  });

  it("sends allowed events with the common properties and a hashed id", async () => {
    const { analytics, sent } = setup();
    analytics.track("routine_created", { enabled: true, has_skip_window: false });
    await analytics.flush();
    const [event] = sent[0]?.batch ?? [];
    expect(event).toMatchObject({
      event: "routine_created",
      properties: {
        enabled: true,
        has_skip_window: false,
        app_version: "1.2.3",
        $process_person_profile: false,
      },
    });
    expect(event?.distinct_id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sent)).not.toContain("env-1");
  });

  it("drops what is queued once usage data is turned off", async () => {
    const { analytics, sent, state } = setup();
    analytics.track("app_foregrounded", {});
    state.consent = false;
    await analytics.flush();
    analytics.track("app_foregrounded", {});
    state.consent = true;
    await analytics.flush();
    expect(sent).toEqual([]);
  });

  it("sends nothing when BEEBOT_TELEMETRY=0", async () => {
    const { analytics, send } = setup({ env: { BEEBOT_TELEMETRY: "0" } });
    analytics.track("app_foregrounded", {});
    analytics.captureError(new Error("boom"));
    await analytics.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports an error's type and frames without its message or paths", async () => {
    const { analytics, sent } = setup();
    const error = new TypeError("secret prompt text");
    error.stack = [
      "TypeError: secret prompt text",
      "    at runCommand (C:\\Users\\ada\\AppData\\bee\\resources\\server\\index.cjs:10:5)",
      "    at file:///home/ada/project/web/assets/index-abc.js:3:7",
    ].join("\n");
    analytics.captureError(error);
    await analytics.flush();
    const payload = JSON.stringify(sent);
    expect(payload).not.toMatch(/secret|ada|Users|home/);
    expect(sent[0]?.batch[0]?.properties.$exception_list).toMatchObject([
      {
        type: "TypeError",
        stacktrace: {
          frames: [
            { filename: "index-abc.js", lineno: 3, colno: 7 },
            { filename: "index.cjs", function: "runCommand", lineno: 10, colno: 5 },
          ],
        },
      },
    ]);
  });

  it("never reads frames from a message that quotes another stack", async () => {
    const { analytics, sent } = setup();
    const error = new Error("child failed:\n    at chargeCustomer (C:\\acme\\payments.ts:10:5)");
    error.stack = [
      "Error: child failed:",
      "    at chargeCustomer (C:\\acme\\payments.ts:10:5)",
      "    at some private words (index.cjs:1:2)",
      "    at boot (index.cjs:3:4)",
    ].join("\n");
    analytics.captureError(error);
    await analytics.flush();
    const payload = JSON.stringify(sent);
    expect(payload).not.toMatch(/chargeCustomer|payments|private/);
    expect(payload).toContain('"function":"boot"');
  });

  it("never throws when PostHog is unreachable", async () => {
    const { analytics, send } = setup();
    send.mockRejectedValueOnce(new TypeError("fetch failed"));
    analytics.track("app_foregrounded", {});
    await expect(analytics.flush()).resolves.toBeUndefined();
  });
});
