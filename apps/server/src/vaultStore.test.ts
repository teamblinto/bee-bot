import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { protocolVersion, type VaultKey } from "@beebot/contracts";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";
import { apiKeyName } from "./vault.ts";
import {
  openVault,
  readVaultKeyFile,
  storeApiKey,
  unattendedLane,
  VaultError,
} from "./vaultStore.ts";

const secret = "sk-ant-api03-test-secret-do-not-leak";
const newKey = (): VaultKey => ({
  status: "ready",
  key: NodeCrypto.randomBytes(32).toString("base64"),
});

let dataDir: string;
let store: ReturnType<typeof openEventStore>;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-vault-"));
  store = openEventStore(dataDir);
});

afterEach(() => {
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const problem = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof VaultError ? error.problem : error),
  );

it("returns what it stored, and the status names the account", async () => {
  const vault = openVault(store.vaultStore, newKey());
  await vault.put(apiKeyName("claude"), secret);
  expect(await vault.get(apiKeyName("claude"))).toBe(secret);
  expect(await vault.get(apiKeyName("codex"))).toBeUndefined();
  expect(store.state().vault).toEqual({ apiKeys: ["claude"] });
  await vault.delete(apiKeyName("claude"));
  expect(store.state().vault).toEqual({ apiKeys: [] });
});

it("keeps the key out of events, state and the database file", async () => {
  const vault = openVault(store.vaultStore, newKey());
  const seen: string[] = [];
  store.onEvent((event) => seen.push(JSON.stringify(event)));
  expect(await storeApiKey(vault, "claude", secret)).toEqual({ status: 200, body: { ok: true } });
  store.vaultStore.acknowledgeAutomatedAccess();
  const events = store.eventsAfter(0).map((event) => JSON.stringify(event));
  expect(events.some((event) => event.includes('"vault.changed"'))).toBe(true);
  expect([...seen, ...events, JSON.stringify(store.state())].join("\n")).not.toContain(secret);
  store.close();
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  expect(NodeFS.readFileSync(NodePath.join(dataDir, "beebot.db")).includes(secret)).toBe(false);
  store = openEventStore(dataDir);
});

it("refuses a wrong key-encryption key and keeps the stored secret", async () => {
  const key = newKey();
  await openVault(store.vaultStore, key).put(apiKeyName("claude"), secret);
  const wrong = openVault(store.vaultStore, newKey());
  expect(await problem(wrong.get(apiKeyName("claude")))).toBe("wrong_key");
  expect(await problem(wrong.put(apiKeyName("codex"), "other"))).toBe("wrong_key");
  expect(await openVault(store.vaultStore, key).get(apiKeyName("claude"))).toBe(secret);
});

it("lets a new key take over once no secret is left", async () => {
  await openVault(store.vaultStore, newKey()).put(apiKeyName("claude"), secret);
  const replacement = openVault(store.vaultStore, newKey());
  await replacement.delete(apiKeyName("claude"));
  await replacement.put(apiKeyName("claude"), "fresh");
  expect(await replacement.get(apiKeyName("claude"))).toBe("fresh");
});

it("refuses a tampered or moved ciphertext", async () => {
  const vault = openVault(store.vaultStore, newKey());
  await vault.put(apiKeyName("claude"), secret);
  const sealed = Buffer.from(store.vaultStore.read(apiKeyName("claude")) ?? []);
  store.vaultStore.write(apiKeyName("codex"), sealed);
  expect(await problem(vault.get(apiKeyName("codex")))).toBe("corrupt");
  sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
  store.vaultStore.write(apiKeyName("claude"), sealed);
  expect(await problem(vault.get(apiKeyName("claude")))).toBe("corrupt");
});

it("refuses to store anything without a usable key", async () => {
  const vault = openVault(store.vaultStore, { status: "unavailable", problem: "insecure_keyring" });
  expect(await storeApiKey(vault, "claude", secret)).toEqual({
    status: 409,
    body: { code: "vault_insecure_keyring" },
  });
  expect(store.vaultStore.read(apiKeyName("claude"))).toBeUndefined();
  expect(store.state().vault).toEqual({ apiKeys: [] });
});

it("reads the headless key from a file, never from the environment itself", () => {
  const file = NodePath.join(dataDir, "vault-key");
  const key = NodeCrypto.randomBytes(32).toString("base64");
  NodeFS.writeFileSync(file, `${key}\n`);
  expect(readVaultKeyFile({ BEEBOT_VAULT_KEY_FILE: file })).toEqual({ status: "ready", key });
  expect(readVaultKeyFile({ CREDENTIALS_DIRECTORY: dataDir })).toEqual({
    status: "unavailable",
    problem: "key_unreadable",
  });
  NodeFS.writeFileSync(NodePath.join(dataDir, "beebot-vault-key"), key);
  expect(readVaultKeyFile({ CREDENTIALS_DIRECTORY: dataDir })).toEqual({ status: "ready", key });
  NodeFS.writeFileSync(file, "too short");
  expect(readVaultKeyFile({ BEEBOT_VAULT_KEY_FILE: file }).status).toBe("unavailable");
  expect(readVaultKeyFile({})).toEqual({ status: "unavailable", problem: "no_key" });
});

it("stores and deletes keys and records the notice once, through the commands", async () => {
  const token = "t".repeat(43);
  const server = await startServer({
    port: 0,
    token,
    dataDir,
    allowedOrigins: [],
    store,
    vault: openVault(store.vaultStore, newKey()),
    probeEngine: async () => ({
      cliFound: true,
      version: null,
      auth: "unknown",
      email: null,
      pauseReason: null,
    }),
  });
  const command = (body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  try {
    const stored = await command({ type: "store-api-key", engineAccountId: "codex", key: secret });
    expect(stored.status).toBe(200);
    expect(store.state().vault).toEqual({ apiKeys: ["codex"] });
    const fake = await command({ type: "store-api-key", engineAccountId: "fake", key: secret });
    expect(fake.status).toBe(400);
    expect(await fake.text()).not.toContain(secret);
    await command({ type: "acknowledge-automated-access" });
    const first = store.state().automatedAccessAcknowledgedAt;
    expect(first).not.toBeNull();
    await command({ type: "acknowledge-automated-access" });
    expect(store.state().automatedAccessAcknowledgedAt).toBe(first);
    expect((await command({ type: "delete-api-key", engineAccountId: "codex" })).status).toBe(200);
    expect(store.eventsAfter(0).map(({ type }) => type)).toEqual([
      "vault.changed",
      "automated-access.acknowledged",
      "vault.changed",
    ]);
  } finally {
    await server.close();
  }
});

it("runs an unattended bot on the API key, and on a subscription only after the notice", () => {
  expect(unattendedLane(true, null)).toBe("api_key");
  expect(unattendedLane(true, "2026-11-08T00:00:00.000Z")).toBe("api_key");
  expect(unattendedLane(false, "2026-11-08T00:00:00.000Z")).toBe("subscription");
  expect(unattendedLane(false, null)).toBeNull();
});
