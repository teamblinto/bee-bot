import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  type ApiKeyAccountId,
  type EngineLane,
  VaultKey,
  type VaultProblem,
} from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";
import { apiKeyName, openVaultEntries, type Vault } from "./vault.ts";

// Envelope: the key-encryption key from outside the database wraps this row's random data key,
// and the data key encrypts every secret.
const dataKeyName = "data_key";
const format = 1;
const ivBytes = 12;
const tagBytes = 16;
const headerBytes = 1 + ivBytes + tagBytes;

export class VaultError extends Error {
  readonly problem: VaultProblem | "corrupt";
  constructor(problem: VaultProblem | "corrupt") {
    super(`vault: ${problem}`);
    this.problem = problem;
  }
}

// AES-256-GCM. The row name is authenticated too, so a ciphertext can't be moved to another row.
export function seal(key: Buffer, name: string, plaintext: Buffer) {
  const iv = NodeCrypto.randomBytes(ivBytes);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(format), iv, cipher.getAuthTag(), body]);
}

export function unseal(key: Buffer, name: string, sealed: Uint8Array) {
  const blob = Buffer.from(sealed);
  if (blob[0] !== format || blob.length < headerBytes) {
    return undefined;
  }
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, blob.subarray(1, 1 + ivBytes));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(blob.subarray(1 + ivBytes, headerBytes));
    return Buffer.concat([decipher.update(blob.subarray(headerBytes)), decipher.final()]);
  } catch {
    return undefined;
  }
}

const SealedRow = z.object({ ciphertext: z.instanceof(Uint8Array) });
const Count = z.object({ count: z.number() });
const Acknowledged = z.object({ acknowledgedAt: z.string() });

export function openVaultStore(db: DatabaseSync, { transaction, emit }: StoreTx) {
  const { vaultStatus } = openVaultEntries(db);
  const select = db.prepare("SELECT ciphertext FROM vault_entries WHERE name = ?");
  const upsert = db.prepare(
    `INSERT INTO vault_entries (name, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare("DELETE FROM vault_entries WHERE name = ?");
  const countSecrets = db.prepare("SELECT count(*) AS count FROM vault_entries WHERE name <> ?");
  const acknowledge = db.prepare(
    `UPDATE settings SET automated_access_acknowledged_at = ?
     WHERE automated_access_acknowledged_at IS NULL
     RETURNING automated_access_acknowledged_at AS acknowledgedAt`,
  );
  const changed = (name: string) => {
    if (name !== dataKeyName) {
      emit({ type: "vault.changed", vault: vaultStatus() });
    }
  };

  return {
    read: (name: string) => {
      const row = select.get(name);
      return row ? SealedRow.parse(row).ciphertext : undefined;
    },
    write: (name: string, ciphertext: Buffer) =>
      transaction(() => {
        const now = new Date().toISOString();
        upsert.run(name, ciphertext, now, now);
        changed(name);
      }),
    remove: (name: string) =>
      transaction(() => {
        if (remove.run(name).changes > 0) {
          changed(name);
        }
      }),
    hasSecrets: () => Count.parse(countSecrets.get(dataKeyName)).count > 0,
    acknowledgeAutomatedAccess: () =>
      transaction(() => {
        const row = acknowledge.get(new Date().toISOString());
        if (row) {
          emit({ type: "automated-access.acknowledged", ...Acknowledged.parse(row) });
        }
      }),
  };
}

export type VaultStore = ReturnType<typeof openVaultStore>;

export function openVault(rows: VaultStore, vaultKey: VaultKey): Vault {
  function dataKey() {
    if (vaultKey.status === "unavailable") {
      throw new VaultError(vaultKey.problem);
    }
    const keyEncryptionKey = Buffer.from(vaultKey.key, "base64");
    const wrapped = rows.read(dataKeyName);
    const key = wrapped && unseal(keyEncryptionKey, dataKeyName, wrapped);
    if (key) {
      return key;
    }
    if (wrapped && rows.hasSecrets()) {
      throw new VaultError("wrong_key");
    }
    // With no secret stored, a lost key loses nothing, so a fresh data key replaces it.
    const fresh = NodeCrypto.randomBytes(32);
    rows.write(dataKeyName, seal(keyEncryptionKey, dataKeyName, fresh));
    return fresh;
  }

  return {
    put: async (name, secret) => {
      rows.write(name, seal(dataKey(), name, Buffer.from(secret)));
    },
    get: async (name) => {
      const sealed = rows.read(name);
      if (!sealed) {
        return undefined;
      }
      const plaintext = unseal(dataKey(), name, sealed);
      if (!plaintext) {
        throw new VaultError("corrupt");
      }
      return plaintext.toString();
    },
    delete: async (name) => {
      rows.remove(name);
    },
  };
}

// The key file holds 32 random bytes in base64, e.g. from `openssl rand -base64 32`. Not an env
// var holding the key itself: every engine and box the server starts would inherit it. Under
// systemd, `LoadCredential=beebot-vault-key:<path>` keeps the file root-only.
export function readVaultKeyFile({
  BEEBOT_VAULT_KEY_FILE,
  CREDENTIALS_DIRECTORY,
}: NodeJS.ProcessEnv): VaultKey {
  const path =
    BEEBOT_VAULT_KEY_FILE ??
    (CREDENTIALS_DIRECTORY && NodePath.join(CREDENTIALS_DIRECTORY, "beebot-vault-key"));
  if (!path) {
    return { status: "unavailable", problem: "no_key" };
  }
  try {
    const parsed = VaultKey.safeParse({
      status: "ready",
      key: NodeFS.readFileSync(path, "utf8").trim(),
    });
    return parsed.data ?? { status: "unavailable", problem: "key_unreadable" };
  } catch {
    return { status: "unavailable", problem: "key_unreadable" };
  }
}

const refusal = (error: unknown) => {
  if (error instanceof VaultError) {
    return { status: 409, body: { code: `vault_${error.problem}` } };
  }
  throw error;
};

export async function storeApiKey(vault: Vault, accountId: ApiKeyAccountId, key: string) {
  try {
    await vault.put(apiKeyName(accountId), key);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return refusal(error);
  }
}

export async function deleteApiKey(vault: Vault, accountId: ApiKeyAccountId) {
  await vault.delete(apiKeyName(accountId));
  return { status: 200, body: { ok: true } };
}

// R7: an unattended run takes the account's API key when the vault holds one. A subscription is
// the fallback only after the owner read the automated-access notice, and otherwise it doesn't run.
export function unattendedLane(
  hasApiKey: boolean,
  acknowledgedAt: string | null,
): EngineLane | null {
  if (hasApiKey) {
    return "api_key";
  }
  return acknowledgedAt ? "subscription" : null;
}
