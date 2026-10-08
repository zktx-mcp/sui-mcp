import { mkdtempSync, readFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openWalletConnectStorage } from "../src/runtime/walletConnectStorage.js";
import { acquireDataDirectoryOwner, DataDirectoryOwnedError } from "../src/runtime/shared/ownerLease.js";

it("retains only SDK connection namespaces, never request history or unknown queues", async () => {
  const directory = mkdtempSync(join(tmpdir(), "say-sdk-storage-"));
  let storage = openWalletConnectStorage(directory);
  try {
    const session = { topic: "connection", accounts: ["sui:mainnet:fixture"] };
    await storage.storage.setItem("wc@2:client:0.3//session", session);
    await storage.storage.setItem("wc@2:core:0.3//keychain", { key: "private-key-material" });
    for (const key of ["wc@2:core:0.3//history", "wc@2:client:0.3//pendingRequest", "future-resend-queue"]) {
      await storage.storage.setItem(key, { transaction: "private-request", signature: "private-signature" });
      expect(await storage.storage.getItem(key)).toBeDefined();
    }
    storage.closeBeforeSdkUse();
    storage = openWalletConnectStorage(directory);
    expect(await storage.storage.getItem("wc@2:client:0.3//session")).toEqual(session);
    expect(await storage.storage.getKeys()).toEqual(["wc@2:client:0.3//session", "wc@2:core:0.3//keychain"]);
    const raw = readFileSync(join(directory, "walletconnect/sessions.sqlite")).toString("latin1");
    expect(raw).not.toContain("private-request"); expect(raw).not.toContain("private-signature");
    expect(statSync(join(directory, "walletconnect/sessions.sqlite")).mode & 0o077).toBe(0);
  } finally { storage.closeBeforeSdkUse(); rmSync(directory, { recursive: true, force: true }); }
});

it("refuses incompatible private SDK storage before modifying it", () => {
  const directory = mkdtempSync(join(tmpdir(), "say-sdk-format-"));
  const storage = openWalletConnectStorage(directory); storage.closeBeforeSdkUse();
  const path = join(directory, "walletconnect/sessions.sqlite"), db = new Database(path);
  db.exec("ALTER TABLE sdk_sessions ADD COLUMN unrecognized TEXT"); db.close(); const before = readFileSync(path);
  try { expect(() => openWalletConnectStorage(directory)).toThrow("format is unsupported"); expect(readFileSync(path)).toEqual(before); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

it("excludes another runtime owner regardless of chosen HTTP port and releases on close", () => {
  const directory = mkdtempSync(join(tmpdir(), "say-owner-")); const path = join(directory, "state.sqlite");
  const first = acquireDataDirectoryOwner(path);
  try { expect(() => acquireDataDirectoryOwner(path)).toThrow(DataDirectoryOwnedError); }
  finally { first.close(); }
  const second = acquireDataDirectoryOwner(path); second.close();
  try { chmodSync(directory, 0o755); expect(() => acquireDataDirectoryOwner(path)).toThrow("private"); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
