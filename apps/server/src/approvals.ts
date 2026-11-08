import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  type Approval,
  type ApprovalChange,
  ApprovalTool,
  type BotAccess,
  type Command,
  type PendingApproval,
} from "@beebot/contracts";
import { z } from "zod";

import { workingFolder } from "./engine.ts";
import { pathPolicy } from "./pathPolicy.ts";
import type { EventStore } from "./store.ts";
import { type AwakeClock, awakeTimeout, createAwakeClock } from "./watchdog.ts";

const defaultTimeoutMs = 5 * 60_000;
const maxPreviewChars = 20_000;
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
  { command, file_path, pattern, path, glob, paths }: Record<string, unknown>,
) {
  if (tool === "Bash") {
    return typeof command === "string" ? command : undefined;
  }
  if (tool === "Patch") {
    return Array.isArray(paths) ? paths.join(", ") : undefined;
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

// A cut at a line end must leave something to read, or the card would look like an empty write.
function capped(text: string, maxChars = maxPreviewChars) {
  if (text.length <= maxChars) {
    return text;
  }
  const lineEnd = Math.max(text.lastIndexOf("\n", maxChars), 0);
  const lines = text.slice(0, lineEnd).replace(/\r$/, "");
  return lines.trim() ? lines : text.slice(0, maxChars).replace(/[\ud800-\udbff]$/, "");
}

function preview(
  action: ApprovalChange["action"],
  removed: string | null,
  added: string,
  replaceAll: boolean,
): ApprovalChange {
  const shownRemoved = removed === null ? null : capped(removed);
  const shownAdded = capped(added);
  const shown = (shownRemoved?.length ?? 0) + shownAdded.length;
  return {
    action,
    removed: shownRemoved,
    added: shownAdded,
    hiddenChars: (removed?.length ?? 0) + added.length - shown,
    replaceAll,
  };
}

export const patchFileHeader = "=== ";

// `diff` is one header line per file, then that file's lines, each starting with +, - or context.
function patchPreview(paths: unknown, diff: unknown): ApprovalChange | undefined {
  if (typeof diff !== "string" || !Array.isArray(paths)) {
    return undefined;
  }
  const parsed: Array<{ path: string; removed: string[]; added: string[] }> = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith(patchFileHeader)) {
      parsed.push({ path: line.slice(patchFileHeader.length), removed: [], added: [] });
    } else if (line.startsWith("-")) {
      parsed.at(-1)?.removed.push(line.slice(1));
    } else if (line.startsWith("+")) {
      parsed.at(-1)?.added.push(line.slice(1));
    }
  }
  if (parsed.length === 0) {
    return undefined;
  }
  let room = maxPreviewChars;
  let hiddenChars = 0;
  const take = (lines: string[]) => {
    const text = lines.join("\n");
    const shown = capped(text, room);
    room -= shown.length;
    hiddenChars += text.length - shown.length;
    return shown;
  };
  const files = parsed.map(({ path, removed, added }) => ({
    path,
    removed: take(removed),
    added: take(added),
  }));
  return {
    action: "patch",
    removed: null,
    added: "",
    hiddenChars,
    replaceAll: false,
    files,
  } as const;
}

// Undefined when the call can't be shown, so it can't be approved. Null for a tool with no change.
function proposedChange(
  tool: ApprovalTool,
  { content, old_string, new_string, replace_all = false, paths, diff }: Record<string, unknown>,
) {
  if (tool === "Patch") {
    return patchPreview(paths, diff);
  }
  if (tool === "Write") {
    return typeof content === "string" ? preview("write", null, content, false) : undefined;
  }
  if (tool === "Edit") {
    return typeof old_string === "string" &&
      typeof new_string === "string" &&
      typeof replace_all === "boolean"
      ? preview("edit", old_string, new_string, replace_all)
      : undefined;
  }
  return null;
}

export function writeAction(target: string): ApprovalChange["action"] {
  try {
    const stats = NodeFS.statSync(target, { throwIfNoEntry: false });
    if (!stats) {
      return "create";
    }
    return stats.isFile() ? "replace" : "write";
  } catch {
    return "write";
  }
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
  return (
    access === "auto-edits" && inside && (tool === "Write" || tool === "Edit" || tool === "Patch")
  );
}

type HeldCall = Omit<PendingApproval, "expiresAt"> & {
  runId: string;
  botId: string;
  tool: ApprovalTool;
  digest: string;
  timer: ReturnType<typeof awakeTimeout>;
  resolve: (decision: Decision) => void;
  updatedInput: Record<string, unknown>;
};

type Options = {
  store: EventStore;
  dataDir: string;
  onChange: () => void;
  timeoutMs?: number | undefined;
  clock?: AwakeClock | undefined;
};

export function createApprovals({
  store,
  dataDir,
  onChange,
  timeoutMs = defaultTimeoutMs,
  clock = createAwakeClock(),
}: Options) {
  const runs = new Map<string, Run>();
  const held = new Map<string, HeldCall>();

  // Every outcome funnels through here, so a row and its held call can't disagree. Nothing is
  // released as allowed unless the decision is on record.
  function settle(call: HeldCall, status: "allowed" | "denied", reason: Approval["reason"]) {
    held.delete(call.id);
    call.timer.cancel();
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
    fields: Pick<PendingApproval, "detail" | "change" | "canAlwaysAllow">,
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
        timer: awakeTimeout(clock, timeoutMs, () => settle(call, "denied", "timeout"), onChange),
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
      const proposal = proposedChange(tool, input);
      if (detail === undefined || proposal === undefined) {
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
      const { writeTarget } = policy;
      const change =
        proposal && writeTarget ? { ...proposal, action: writeAction(writeTarget) } : proposal;
      const decision = await hold(run, tool, { detail, change, canAlwaysAllow }, input, closed);
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
      [...held.values()].map(({ id, detail, change, canAlwaysAllow, timer }) => ({
        id,
        detail,
        change,
        canAlwaysAllow,
        expiresAt: new Date(Date.now() + timer.leftMs()).toISOString(),
      })),

    isHolding: (runId: string) => [...held.values()].some((call) => call.runId === runId),

    // Rows stay pending for the next boot to expire: the call only ended because we did.
    close: () => {
      for (const call of held.values()) {
        call.timer.cancel();
        call.resolve(notApproved);
      }
      held.clear();
      runs.clear();
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
