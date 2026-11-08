import type { DatabaseSync } from "node:sqlite";

import type { VaultStatus } from "@beebot/contracts";
import { z } from "zod";

// Async because the desktop key comes through Electron's async safeStorage (R13). Values never
// reach logs, events or the database unencrypted.
export type Vault = {
  put: (name: string, secret: string) => Promise<void>;
  get: (name: string) => Promise<string | undefined>;
  delete: (name: string) => Promise<void>;
};

const apiKeyPrefix = "api_key:";

export const apiKeyName = (engineAccountId: string) => `${apiKeyPrefix}${engineAccountId}`;

export function createMemoryVault(): Vault {
  const secrets = new Map<string, string>();
  return {
    put: async (name, secret) => {
      secrets.set(name, secret);
    },
    get: async (name) => secrets.get(name),
    delete: async (name) => {
      secrets.delete(name);
    },
  };
}

// Reads names only, from the rows a real vault keeps in `vault_entries`.
export function openVaultEntries(db: DatabaseSync) {
  const selectApiKeys = db.prepare(
    "SELECT substr(name, ?) AS accountId FROM vault_entries WHERE name LIKE ? ORDER BY name",
  );
  return {
    vaultStatus: (): VaultStatus => ({
      apiKeys: z
        .array(z.object({ accountId: z.string() }))
        .parse(selectApiKeys.all(apiKeyPrefix.length + 1, `${apiKeyPrefix}%`))
        .map(({ accountId }) => accountId),
    }),
  };
}
