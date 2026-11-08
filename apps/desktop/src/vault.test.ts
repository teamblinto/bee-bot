import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { loadVaultKey } from "./vault.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-desktop-vault-"));
  file = NodePath.join(dir, "vault-key");
});

afterEach(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

// Stands in for the OS keyring: reversible, but never the plaintext on disk.
function keyring({
  backend = "gnome_libsecret" as const,
  available = true,
  reEncrypt = false,
}: {
  backend?: "basic_text" | "gnome_libsecret";
  available?: boolean;
  reEncrypt?: boolean;
} = {}) {
  let encryptions = 0;
  return {
    get encryptions() {
      return encryptions;
    },
    getSelectedStorageBackend: () => backend,
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plainText: string) => {
      encryptions += 1;
      return Buffer.from(`wrapped:${Buffer.from(plainText).toString("hex")}`);
    },
    decryptStringAsync: async (encrypted: Buffer) => {
      const text = encrypted.toString();
      if (!text.startsWith("wrapped:")) {
        throw new Error("not ours");
      }
      return {
        shouldReEncrypt: reEncrypt,
        result: Buffer.from(text.slice(8), "hex").toString(),
      };
    },
  };
}

it("creates one random key, keeps it wrapped, and gives the same key back", async () => {
  const first = await loadVaultKey(keyring(), file, "win32");
  expect(first.status).toBe("ready");
  const key = first.status === "ready" ? first.key : "";
  expect(Buffer.from(key, "base64")).toHaveLength(32);
  expect(NodeFS.readFileSync(file, "utf8")).not.toContain(key);
  expect(await loadVaultKey(keyring(), file, "win32")).toEqual(first);
});

it("refuses Linux basic_text and stores nothing", async () => {
  expect(await loadVaultKey(keyring({ backend: "basic_text" }), file, "linux")).toEqual({
    status: "unavailable",
    problem: "insecure_keyring",
  });
  expect(NodeFS.existsSync(file)).toBe(false);
});

it("refuses when the keyring is unavailable", async () => {
  expect(await loadVaultKey(keyring({ available: false }), file, "darwin")).toEqual({
    status: "unavailable",
    problem: "keyring_unavailable",
  });
  expect(NodeFS.existsSync(file)).toBe(false);
});

it("never replaces a key file the keyring can't open", async () => {
  NodeFS.writeFileSync(file, "from another machine");
  expect(await loadVaultKey(keyring(), file, "win32")).toEqual({
    status: "unavailable",
    problem: "key_unreadable",
  });
  expect(NodeFS.readFileSync(file, "utf8")).toBe("from another machine");
});

it("rewraps the same key when the keyring asks", async () => {
  const first = await loadVaultKey(keyring(), file, "win32");
  const rotating = keyring({ reEncrypt: true });
  expect(await loadVaultKey(rotating, file, "win32")).toEqual(first);
  expect(rotating.encryptions).toBe(1);
});
