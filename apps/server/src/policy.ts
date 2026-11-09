import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  type AuditPage,
  type Bot,
  type BotBoundary,
  BotProfile,
  type EngineLane,
  type Manifest,
} from "@beebot/contracts";
import { z } from "zod";

import { type AuditQuery, openAudit } from "./audit.ts";
import {
  type Decide,
  decide as brokerDecide,
  decideTool,
  parseManifest,
  type PolicyDecision,
  ruleFor,
} from "./broker.ts";
import type { StoreTx } from "./store.ts";

export type BrokerRun = { id: string; botId: string; attended: boolean };

const flag = z.number().transform((value) => value === 1);
const Legs = z.object({ readsUntrusted: flag, readsPrivate: flag, sideEffect: flag });
const BotPolicy = z.object({ profile: BotProfile, manifest: z.string() });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

const digestOf = (tool: string, args: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonical({ tool, args: args ?? null })))
    .digest("hex");

const maxToolName = 100;
const maxAuditPage = 200;

export function openPolicy(
  db: DatabaseSync,
  { transaction, emit }: StoreTx,
  getBot: (id: string) => Bot | undefined,
) {
  const { appendAudit, auditPage, brokenAuditRow } = openAudit(db);
  const selectBotPolicy = db.prepare("SELECT profile, manifest FROM bots WHERE id = ?");
  const updateProfile = db.prepare("UPDATE bots SET profile = ? WHERE id = ?");
  const updateManifest = db.prepare("UPDATE bots SET manifest = ? WHERE id = ?");
  const updateBoundary = db.prepare(
    "UPDATE bots SET boundary = ? WHERE id = ? AND boundary <> ? RETURNING id",
  );
  const updateAnySite = db.prepare("UPDATE bots SET egress_any_site = ? WHERE id = ?");
  const clearEgressHosts = db.prepare("DELETE FROM bot_egress_hosts WHERE bot_id = ?");
  const insertEgressHost = db.prepare(
    "INSERT INTO bot_egress_hosts (bot_id, host, created_at) VALUES (?, ?, ?)",
  );
  const updateUnattendedLane = db.prepare(
    "UPDATE bots SET unattended_lane = ? WHERE id = ? AND unattended_lane <> ? RETURNING id",
  );
  // A session lives in one boundary's CLI home, so the other side starts a new one.
  const forgetSessions = db.prepare(
    "UPDATE scopes SET session_id = NULL, session_started = 0 WHERE bot_id = ?",
  );
  const selectLegs = db.prepare(
    `SELECT s.legs_untrusted AS readsUntrusted, s.legs_private AS readsPrivate,
       s.legs_side_effect AS sideEffect
     FROM scopes s JOIN runs r ON r.scope_id = s.id WHERE r.id = ?`,
  );
  const addLegs = db.prepare(
    `UPDATE scopes SET legs_untrusted = MAX(legs_untrusted, ?),
       legs_private = MAX(legs_private, ?), legs_side_effect = MAX(legs_side_effect, ?)
     WHERE id = (SELECT scope_id FROM runs WHERE id = ?)`,
  );
  // The memory gate's own flag, so a write after an untrusted read waits for review.
  const markTainted = db.prepare(
    "UPDATE scopes SET tainted = 1 WHERE id = (SELECT scope_id FROM runs WHERE id = ?)",
  );

  return {
    // The legs are set before the answer goes back, so the tool can't run ahead of its taint. An
    // approval taints at once too: if the owner then refuses, the session is only stricter.
    check: (
      run: BrokerRun,
      tool: string,
      args: unknown,
      decide: Decide = brokerDecide,
    ): PolicyDecision =>
      transaction(() => {
        const row = selectBotPolicy.get(run.botId);
        const legsRow = selectLegs.get(run.id);
        const rule = ruleFor(tool);
        let decision: PolicyDecision = { kind: "deny", reason: "unknown_run" };
        if (row && legsRow) {
          const { profile, manifest } = BotPolicy.parse(row);
          decision = decideTool(
            { botId: run.botId, runId: run.id, tool },
            {
              profile,
              manifest: parseManifest(manifest),
              session: Legs.parse(legsRow),
              attended: run.attended,
            },
            decide,
          );
        }
        if (rule && (decision.kind === "allow" || decision.kind === "approve")) {
          const { readsUntrusted, readsPrivate, sideEffect } = rule.labels;
          addLegs.run(Number(readsUntrusted), Number(readsPrivate), Number(sideEffect), run.id);
          if (readsUntrusted) {
            markTainted.run(run.id);
          }
        }
        appendAudit({
          runId: run.id,
          botId: run.botId,
          attended: run.attended,
          status: decision.kind,
          reason: "reason" in decision ? decision.reason : null,
          tool: tool.slice(0, maxToolName),
          digest: rule && !rule.typed ? digestOf(tool, args) : null,
        });
        return decision;
      }),

    setBotProfile: (botId: string, profile: BotProfile) =>
      transaction(() => {
        updateProfile.run(profile, botId);
        const bot = getBot(botId);
        if (bot) {
          emit({ type: "bot.changed", bot });
          appendAudit({
            runId: null,
            botId,
            initiator: "human",
            attended: true,
            status: "profile_set",
            reason: profile,
          });
        }
        return bot;
      }),

    // Takes effect at the next call: every call reads the manifest afresh.
    setBotManifest: (botId: string, manifest: Manifest) =>
      transaction(() => {
        const sorted = [...new Set(manifest)].sort();
        updateManifest.run(JSON.stringify(sorted), botId);
        const bot = getBot(botId);
        if (bot) {
          emit({ type: "bot.changed", bot });
          appendAudit({
            runId: null,
            botId,
            initiator: "human",
            attended: true,
            status: "manifest_set",
            reason: sorted.join(",").slice(0, 200),
          });
        }
        return bot;
      }),

    // `hosts` is already checked and normalized (ownerEgressHosts).
    setBotEgressHosts: (botId: string, anySite: boolean, hosts: readonly string[]) =>
      transaction(() => {
        if (!getBot(botId)) {
          return undefined;
        }
        updateAnySite.run(anySite ? 1 : 0, botId);
        clearEgressHosts.run(botId);
        const now = new Date().toISOString();
        for (const host of hosts) {
          insertEgressHost.run(botId, host, now);
        }
        appendAudit({
          runId: null,
          botId,
          initiator: "human",
          attended: true,
          status: "egress_set",
          reason: [...(anySite ? ["any site"] : []), ...hosts].join(",").slice(0, 200),
        });
        const bot = getBot(botId);
        if (bot) {
          emit({ type: "bot.changed", bot });
        }
        return bot;
      }),

    setBotUnattendedLane: (botId: string, lane: EngineLane) =>
      transaction(() => {
        if (updateUnattendedLane.get(lane, botId, lane)) {
          appendAudit({
            runId: null,
            botId,
            initiator: "human",
            attended: true,
            status: "unattended_lane_set",
            reason: lane,
          });
        }
        const bot = getBot(botId);
        if (bot) {
          emit({ type: "bot.changed", bot });
        }
        return bot;
      }),

    setBotBoundary: (botId: string, boundary: BotBoundary) =>
      transaction(() => {
        if (updateBoundary.get(boundary, botId, boundary)) {
          forgetSessions.run(botId);
          appendAudit({
            runId: null,
            botId,
            initiator: "human",
            attended: true,
            status: "boundary_set",
            reason: boundary,
          });
        }
        const bot = getBot(botId);
        if (bot) {
          emit({ type: "bot.changed", bot });
        }
        return bot;
      }),

    auditPage: (query: AuditQuery): AuditPage => ({
      entries: auditPage(query),
      brokenRowId: brokenAuditRow(),
    }),
  };
}

export type Policy = ReturnType<typeof openPolicy>;

const AuditParams = z.object({
  botId: z.uuid().optional(),
  unattended: z.enum(["0", "1"]).default("0"),
  before: z.coerce.number().int().positive().optional(),
});

export function auditQuery(url: URL): AuditQuery | undefined {
  const params = AuditParams.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) {
    return undefined;
  }
  const { botId, unattended, before } = params.data;
  return { botId, unattended: unattended === "1", before, limit: maxAuditPage };
}

const refusals: Record<Exclude<PolicyDecision["kind"], "allow">, string> = {
  deny: "Bee's policy refused this call.",
  approve: "This needs the owner's approval, which this call can't wait for. Tell the user.",
  hand_off: "Only the owner can do this. Tell the user what they need to do.",
};

export function refusedText(decision: Exclude<PolicyDecision, { kind: "allow" }>) {
  const reason = "reason" in decision ? decision.reason : "approval_required";
  return JSON.stringify({ status: "refused", reason, note: refusals[decision.kind] });
}

// For Bee's own tools on /mcp. Until approvals can wait (workstream 5), approve and hand_off refuse.
export function gateTool(
  policy: Policy,
  run: BrokerRun,
  name: string,
  args: unknown,
  call: () => string,
) {
  const decision = policy.check(run, name, args);
  return decision.kind === "allow" ? call() : refusedText(decision);
}
