import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { openAudit } from "./audit.ts";
import { migrate, migrations } from "./store.ts";

describe("audit log", () => {
  it("chains each row onto the one before, so an edit shows", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const audit = openAudit(db);
    for (const status of ["Queued", "Running", "Completed"]) {
      audit.appendAudit({ runId: "r", botId: "b", status, reason: null, initiator: "human" });
    }
    expect(audit.brokenAuditRow()).toBeNull();
    db.prepare("UPDATE audit_log SET status = 'Failed' WHERE id = 2").run();
    expect(audit.brokenAuditRow()).toBe(2);
  });

  it("chains the rows written before the chain existed", () => {
    const db = new DatabaseSync(":memory:");
    migrate(
      db,
      migrations.findIndex(({ name }) => name === "m3_audit_chain"),
    );
    const insert = db.prepare(
      "INSERT INTO audit_log (run_id, bot_id, status, created_at) VALUES ('r', 'b', ?, ?)",
    );
    insert.run("Queued", "2026-01-01T00:00:00.000Z");
    insert.run("Completed", "2026-01-01T00:00:01.000Z");
    migrate(db);
    const audit = openAudit(db);
    audit.appendAudit({ runId: null, botId: "b", status: "box_started", reason: null });
    expect(audit.brokenAuditRow()).toBeNull();
  });
});
