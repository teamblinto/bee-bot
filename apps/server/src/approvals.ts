import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  type Approval,
  ApprovalTool,
  type BotAccess,
  type Command,
  type PendingApproval,
} from "@beebot/contracts";
import { z } from "zod";

import { workingFolder } from "./engine.ts";
import { pathPolicy } from "./pathPolicy.ts";
import type { EventStore } from "./store.ts";

const defaultTimeoutMs = 5 * 60_000;
const alwaysAllowable: ReadonlySet<ApprovalTool> = new Set(["Read", "Glob", "Grep"]);

export type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

const malformed: Decision = { behavior: "deny", message: "Refused: this call can't be approved." };
const notApproved: Decision = { behavior: "deny", message: "The owner did not approve this." };

const Arguments = z.object({ tool_name: ApprovalTool, input: z.record(z.string(), z.unknown()) });

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

export const inputDigest = (tool: ApprovalTool, input: Record<string, unknown>) =>
  sha256(JSON.stringify(stable({ tool, input }))).digest("hex");

// Exactly what the model sent: the owner is approving this text.
function detailText(
  tool: ApprovalTool,
  { command, file_path, pattern, path, glob }: Record<string, unknown>,
) {
  if (tool === "Bash") {
    return typeof command === "string" ? command : undefined;
  }
  if (tool === "Glob" || tool === "Grep") {
    if (typeof pattern !== "string") {
      return undefined;
    }
    const where = typeof path === "string" ? ` in ${path}` : "";
    return `${pattern}${where}${typeof glob === "string" ? ` matching ${glob}` : ""}`;
  }
  return typeof file_path === "string" ? file_path : undefined;
}

type RunMode = { attended: boolean; plan: boolean };
type Run = RunMode & { id: string; botId: string; tokenHash: Buffer };

// Runs only after the path policy passed, so a forbidden path never gets here. A Plan turn is
// asked about everything: the CLI leaves Bash to the model there, and the owner asked for no changes.
function accessAllows(access: BotAccess, tool: ApprovalTool, inside: boolean, run: RunMode) {
  if (run.plan) {
    return false;
  }
  if (access === "full") {
    return run.attended;
  }
  return access === "auto-edits" && inside && (tool === "Write" || tool === "Edit");
}

type HeldCall = PendingApproval & {
  runId: string;
  botId: string;
  tool: ApprovalTool;
  digest: string;
  timer: NodeJS.Timeout;
  resolve: (decision: Decision) => void;
  updatedInput: Record<string, unknown>;
};

type Options = {
  store: EventStore;
  dataDir: string;
  onChange: () => void;
  timeoutMs?: number | undefined;
};

export function createApprovals({
  store,
  dataDir,
  onChange,
  timeoutMs = defaultTimeoutMs,
}: Options) {
  const runs = new Map<string, Run>();
  const held = new Map<string, HeldCall>();

  // Every outcome funnels through here, so a row and its held call can't disagree. Nothing is
  // released as allowed unless the decision is on record.
  function settle(call: HeldCall, status: "allowed" | "denied", reason: Approval["reason"]) {
    held.delete(call.id);
    clearTimeout(call.timer);
    let recorded = true;
    try {
      store.closeApproval(call.id, status, reason);
    } catch (error) {
      console.error(error);
      recorded = false;
    }
    const allowed = recorded && status === "allowed";
    call.resolve(allowed ? { behavior: "allow", updatedInput: call.updatedInput } : notApproved);
    onChange();
    return recorded;
  }

  function hold(
    run: Run,
    tool: ApprovalTool,
    fields: { detail: string; canAlwaysAllow: boolean },
    input: Record<string, unknown>,
    closed: AbortSignal,
  ) {
    const digest = inputDigest(tool, input);
    const { id } = store.openApproval({ runId: run.id, botId: run.botId, tool, digest });
    return new Promise<Decision>((resolve) => {
      const call: HeldCall = {
        ...fields,
        id,
        runId: run.id,
        botId: run.botId,
        tool,
        digest,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        timer: setTimeout(() => settle(call, "denied", "timeout"), timeoutMs),
        resolve,
        updatedInput: input,
      };
      held.set(id, call);
      closed.addEventListener(
        "abort",
        () => {
          if (held.has(id)) {
            settle(call, "denied", "stopped");
          }
        },
        { once: true },
      );
      onChange();
    });
  }

  return {
    openRun: (id: string, botId: string, mode: RunMode) => {
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      runs.set(id, { ...mode, id, botId, tokenHash: sha256(token).digest() });
      return token;
    },

    // Revokes the token first, so a call racing a stop finds no card to open.
    closeRun: (id: string) => {
      runs.delete(id);
      for (const call of [...held.values()].filter(({ runId }) => runId === id)) {
        settle(call, "denied", "stopped");
      }
    },

    // Hashing gives equal lengths, which timingSafeEqual needs. Runs are few, so a scan is fine.
    authenticate: (bearer: string | undefined) => {
      const presented = sha256(bearer ?? "").digest();
      return [...runs.values()].find(({ tokenHash }) =>
        NodeCrypto.timingSafeEqual(tokenHash, presented),
      );
    },

    approve: async (run: Run, args: unknown, closed: AbortSignal): Promise<Decision> => {
      // Before anything else: the stream's tool frame has no order against a memory call on /mcp,
      // but a tool can't run until this answers. If the write throws, the call is denied.
      store.markTainted(run.id);
      const parsed = Arguments.safeParse(args);
      if (!parsed.success || !runs.has(run.id) || closed.aborted) {
        return malformed;
      }
      const { tool_name: tool, input } = parsed.data;
      const detail = detailText(tool, input);
      if (detail === undefined) {
        return malformed;
      }
      const projectPath = store.getBot(run.botId)?.projectPath ?? null;
      const checkPath = () =>
        pathPolicy(tool, input, workingFolder(dataDir, run.botId, projectPath), {
          home: NodeOS.homedir(),
          dataDir,
          platform: process.platform,
        });
      const policy = checkPath();
      if (!policy.allowed) {
        store.auditTool(run.id, run.botId, tool, "refused", null);
        return { behavior: "deny", message: policy.message };
      }
      // Read on every call, so lowering the level holds the running turn's next call.
      const access = store.botAccess(run.botId);
      if (access && accessAllows(access, tool, policy.inside, run)) {
        store.auditTool(run.id, run.botId, tool, "allowed", `access:${access}`);
        return { behavior: "allow", updatedInput: input };
      }
      const canAlwaysAllow = alwaysAllowable.has(tool) && policy.inside;
      if (canAlwaysAllow && store.toolGranted(run.botId, tool)) {
        store.auditTool(run.id, run.botId, tool, "allowed", "always");
        return { behavior: "allow", updatedInput: input };
      }
      const decision = await hold(run, tool, { detail, canAlwaysAllow }, input, closed);
      // A link can be swapped in during a long hold. This narrows that window; it can't close it.
      const after = decision.behavior === "allow" ? checkPath() : undefined;
      if (after && !after.allowed) {
        store.auditTool(run.id, run.botId, tool, "refused", null);
        return { behavior: "deny", message: after.message };
      }
      return decision;
    },

    decide: ({ approvalId, digest, decision }: Extract<Command, { type: "decide-approval" }>) => {
      const call = held.get(approvalId);
      if (!call) {
        return { status: 409, body: { code: "approval_closed" } };
      }
      if (digest !== call.digest) {
        return { status: 409, body: { code: "digest_mismatch" } };
      }
      if (decision === "always" && !call.canAlwaysAllow) {
        return { status: 403, body: { code: "always_not_allowed" } };
      }
      // Before the call is released, so the next call of this kind already sees the grant.
      if (decision === "always") {
        store.grantTool(call.botId, call.tool);
      }
      return settle(call, decision === "deny" ? "denied" : "allowed", "owner")
        ? { status: 200, body: { ok: true } }
        : { status: 500, body: { code: "storage_failed" } };
    },

    pending: (): PendingApproval[] =>
      [...held.values()].map(({ id, detail, canAlwaysAllow, expiresAt }) => ({
        id,
        detail,
        canAlwaysAllow,
        expiresAt,
      })),

    isHolding: (runId: string) => [...held.values()].some((call) => call.runId === runId),

    // Rows stay pending for the next boot to expire: the call only ended because we did.
    close: () => {
      for (const call of held.values()) {
        clearTimeout(call.timer);
        call.resolve(notApproved);
      }
      held.clear();
      runs.clear();
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
