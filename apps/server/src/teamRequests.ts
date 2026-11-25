import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { TeamRequest, type TeamRequestKind } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";

const Json = z
  .string()
  .transform((json) => z.record(z.string(), z.unknown()).parse(JSON.parse(json)));
const Row = TeamRequest.extend({ payload: Json, result: Json.nullable() });
const Count = z.object({ n: z.number() });

// A lead's ask to change the team: pending until applied, declined or failed, each move once.
export function openTeamRequests(db: DatabaseSync, { transaction, emit }: StoreTx) {
  const columns = `id, kind, payload_json AS payload, requested_by_bot_id AS requestedByBotId,
    run_id AS runId, status, result_json AS result, created_at AS createdAt,
    decided_at AS decidedAt`;
  const insertRow = db.prepare(
    `INSERT INTO team_requests (id, kind, payload_json, requested_by_bot_id, run_id, spawn_key,
       status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT (spawn_key) DO NOTHING RETURNING ${columns}`,
  );
  const selectOne = db.prepare(`SELECT ${columns} FROM team_requests WHERE id = ?`);
  const selectByKey = db.prepare(`SELECT ${columns} FROM team_requests WHERE spawn_key = ?`);
  const selectPending = db.prepare(
    `SELECT ${columns} FROM team_requests WHERE status = 'pending' ORDER BY created_at, rowid`,
  );
  const countPendingFor = db.prepare(
    "SELECT count(*) AS n FROM team_requests WHERE requested_by_bot_id = ? AND status = 'pending'",
  );
  const countForRun = db.prepare(
    "SELECT count(*) AS n FROM team_requests WHERE run_id = ? AND kind = ?",
  );
  const countPendingCreates = db.prepare(
    "SELECT count(*) AS n FROM team_requests WHERE kind = 'create_bot' AND status = 'pending'",
  );
  const finishRow = db.prepare(
    `UPDATE team_requests SET status = ?, result_json = ?, decided_at = ?
     WHERE id = ? AND status = 'pending' RETURNING ${columns}`,
  );
  const parse = (row: unknown) => (row === undefined ? undefined : Row.parse(row));

  return {
    insert: (input: {
      kind: TeamRequestKind;
      payload: Record<string, unknown>;
      requestedByBotId: string;
      runId: string;
      spawnKey: string;
    }) =>
      transaction(() => {
        const { kind, payload, requestedByBotId, runId, spawnKey } = input;
        const inserted = parse(
          insertRow.get(
            NodeCrypto.randomUUID(),
            kind,
            JSON.stringify(payload),
            requestedByBotId,
            runId,
            spawnKey,
            new Date().toISOString(),
          ),
        );
        if (inserted) {
          emit({ type: "team-request.changed", request: inserted });
          return { request: inserted, created: true };
        }
        return { request: Row.parse(selectByKey.get(spawnKey)), created: false };
      }),
    byKey: (spawnKey: string) => parse(selectByKey.get(spawnKey)),
    get: (id: string) => parse(selectOne.get(id)),
    pending: () => z.array(Row).parse(selectPending.all()),
    pendingFor: (botId: string) => Count.parse(countPendingFor.get(botId)).n,
    countForRun: (runId: string, kind: TeamRequestKind) =>
      Count.parse(countForRun.get(runId, kind)).n,
    pendingCreates: () => Count.parse(countPendingCreates.get()).n,
    // One conditional UPDATE, so a decision lands at most once.
    finish: (
      id: string,
      status: "applied" | "declined" | "failed",
      result: Record<string, unknown> | null,
    ) =>
      transaction(() => {
        const request = parse(
          finishRow.get(
            status,
            result === null ? null : JSON.stringify(result),
            new Date().toISOString(),
            id,
          ),
        );
        if (request) {
          emit({ type: "team-request.changed", request });
        }
        return request;
      }),
  };
}
