import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";

import { VaultKey, type VaultProblem } from "@beebot/contracts";
import type { SafeStorage } from "electron";

type KeyStore = Pick<
  SafeStorage,
  | "isAsyncEncryptionAvailable"
  | "encryptStringAsync"
  | "decryptStringAsync"
  | "getSelectedStorageBackend"
>;

const unavailable = (problem: VaultProblem): VaultKey => ({ status: "unavailable", problem });

async function save(keyStore: KeyStore, file: string, key: string) {
  const temporary = `${file}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  await NodeFS.writeFile(temporary, await keyStore.encryptStringAsync(key), { mode: 0o600 });
  await NodeFS.rename(temporary, file);
}

async function readIfPresent(file: string) {
  try {
    return await NodeFS.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// The vault's key-encryption key, kept in `file` as the OS keyring encrypted it. Only the server
// ever holds it unwrapped, over the bootstrap channel. Nothing is stored without a real keyring.
export async function loadVaultKey(
  keyStore: KeyStore,
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<VaultKey> {
  if (platform === "linux" && keyStore.getSelectedStorageBackend() === "basic_text") {
    return unavailable("insecure_keyring");
  }
  if (!(await keyStore.isAsyncEncryptionAvailable())) {
    return unavailable("keyring_unavailable");
  }
  try {
    const stored = await readIfPresent(file);
    if (!stored) {
      const key = NodeCrypto.randomBytes(32).toString("base64");
      await save(keyStore, file, key);
      return { status: "ready", key };
    }
    const { result, shouldReEncrypt } = await keyStore.decryptStringAsync(stored);
    if (shouldReEncrypt) {
      await save(keyStore, file, result);
    }
    return (
      VaultKey.safeParse({ status: "ready", key: result }).data ?? unavailable("key_unreadable")
    );
  } catch {
    // Never replaced: a new key would orphan every secret the old one protects.
    return unavailable("key_unreadable");
  }
}
