import * as NodeCrypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const inviteTtlMs = 7 * 24 * 60 * 60 * 1000;

export type MemberState = "provisioning" | "ready" | "failed" | "suspended";
export type Member = { cell: string; admin: boolean; state: MemberState };

export const cellPattern = /^bb[0-9a-f]{10}$/;
export const newCellName = () => `bb${NodeCrypto.randomBytes(5).toString("hex")}`;

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

export function openGatewayDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS invite (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      admin INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS member (
      user_id TEXT PRIMARY KEY,
      cell TEXT NOT NULL UNIQUE,
      admin INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed', 'suspended')),
      error TEXT
    );
  `);
  return db;
}

// Only the hash is kept, so a copy of the database can't accept anyone's invite.
export function createInvite(db: DatabaseSync, email: string, admin: boolean, now = Date.now()) {
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO invite (token_hash, email, admin, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    email.trim().toLowerCase(),
    admin ? 1 : 0,
    now + inviteTtlMs,
  );
  return token;
}

export function openInvite(db: DatabaseSync, token: string, now = Date.now()) {
  const row = db
    .prepare(
      "SELECT email, admin FROM invite WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(sha256(token), now) as { email: string; admin: number } | undefined;
  return row && { email: row.email, admin: row.admin === 1 };
}

// Atomic, so two tabs posting the same invite create one account.
export function claimInvite(db: DatabaseSync, token: string, now = Date.now()) {
  const { changes } = db
    .prepare(
      "UPDATE invite SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .run(now, sha256(token), now);
  return changes === 1;
}

export function addMember(db: DatabaseSync, userId: string, cell: string, admin: boolean) {
  db.prepare(
    "INSERT INTO member (user_id, cell, admin, state) VALUES (?, ?, ?, 'provisioning')",
  ).run(userId, cell, admin ? 1 : 0);
}

export function setMemberState(
  db: DatabaseSync,
  userId: string,
  state: MemberState,
  error: string | null = null,
) {
  db.prepare("UPDATE member SET state = ?, error = ? WHERE user_id = ?").run(state, error, userId);
}

// Atomic, so two sign-ins at once start one retry.
export function retryFailedMember(db: DatabaseSync, userId: string) {
  const { changes } = db
    .prepare("UPDATE member SET state = 'provisioning' WHERE user_id = ? AND state = 'failed'")
    .run(userId);
  return changes === 1;
}

export function findMemberByCell(db: DatabaseSync, cell: string) {
  return db.prepare("SELECT user_id, state FROM member WHERE cell = ?").get(cell) as
    | { user_id: string; state: MemberState }
    | undefined;
}

export function findMember(db: DatabaseSync, userId: string): Member | undefined {
  const row = db.prepare("SELECT cell, admin, state FROM member WHERE user_id = ?").get(userId) as
    | { cell: string; admin: number; state: MemberState }
    | undefined;
  return row && { cell: row.cell, admin: row.admin === 1, state: row.state };
}

export function listUsers(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT u.email, m.cell, m.admin = 1 AS admin, m.state, m.error, u.createdAt
       FROM member m JOIN "user" u ON u.id = m.user_id ORDER BY u.createdAt`,
    )
    .all()
    .map((row) => ({ ...row, admin: row.admin === 1 }));
}
