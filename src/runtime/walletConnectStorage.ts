import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import Database from "better-sqlite3";
import type { CoreTypes } from "@walletconnect/types";

// Restoration namespaces of pinned SignClient/Core 2.23.10. Request history,
// pending requests, messages, unacknowledged envelopes and new namespaces are
// intentionally volatile; they may contain transaction or signature material.
const persistentKeys = new Set([
  "wc@2:core:0.3//keychain", "wc@2:core:0.3//pairing",
  "wc@2:core:0.3//subscription", "wc@2:core:0.3//expirer",
  "wc@2:client:0.3//session", "WALLETCONNECT_CLIENT_ID"
]);
const storageSchema = "CREATE TABLE sdk_sessions (key TEXT PRIMARY KEY, value BLOB NOT NULL)";
function storageFormat(db: Database.Database): "empty" | "current" {
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as { type: string; name: string; sql: string }[];
  if (schema.length === 0) return "empty";
  if (schema.length === 1 && schema[0]?.type === "table" &&
      schema[0].name === "sdk_sessions" && schema[0].sql === storageSchema) return "current";
  throw new Error("WalletConnect storage format is unsupported.");
}

export function openWalletConnectStorage(dataDirectory: string): {
  storage: NonNullable<CoreTypes.Options["storage"]>;
  closeBeforeSdkUse(): void;
} {
  const directory = join(dataDirectory, "walletconnect");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const check = (path: string, directoryExpected: boolean) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : !stat.isFile()) ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 ||
          (process.getuid !== undefined && stat.uid !== process.getuid())))) {
      throw new Error("WalletConnect storage must be private and owned by the current user.");
    }
  };
  check(directory, true);
  const filename = join(directory, "sessions.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(filename + suffix)) check(filename + suffix, false);
  if (existsSync(filename)) {
    const existing = new Database(filename, { readonly: true, fileMustExist: true });
    try { storageFormat(existing); } finally { existing.close(); }
  }
  const oldMask = process.umask(0o077);
  let db: Database.Database;
  try { db = new Database(filename); } finally { process.umask(oldMask); }
  try {
    if (storageFormat(db) === "empty") {
      db.transaction(() => {
        db.exec(storageSchema);
      })();
    }
    // There is exactly one SDK owner. FULL protects the session material that
    // the SDK needs to resume an acknowledged connection after process exit.
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
  } catch (error) { db.close(); throw error; }
  const volatile = new Map<string, Buffer>();
  const get = (key: string): Buffer | undefined => persistentKeys.has(key)
    ? (db.prepare("SELECT value FROM sdk_sessions WHERE key=?").get(key) as { value: Buffer } | undefined)?.value
    : volatile.get(key);
  const keys = () => [...(db.prepare("SELECT key FROM sdk_sessions").all() as { key: string }[]).map((row) => row.key), ...volatile.keys()];
  const storage: NonNullable<CoreTypes.Options["storage"]> = {
    getKeys: async () => keys(),
    getEntries: async <T>() => keys().map((key): [string, T] => [key, deserialize(get(key)!) as T]),
    getItem: async <T>(key: string) => { const value = get(key); return value === undefined ? undefined : deserialize(value) as T; },
    setItem: async <T>(key: string, value: T) => {
      const encoded = serialize(value);
      if (persistentKeys.has(key)) db.prepare("INSERT INTO sdk_sessions VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, encoded);
      else volatile.set(key, encoded);
    },
    removeItem: async (key: string) => {
      if (persistentKeys.has(key)) db.prepare("DELETE FROM sdk_sessions WHERE key=?").run(key);
      else volatile.delete(key);
    }
  };
  // Once injected, SDK timers own the storage until the owner process exits.
  return { storage, closeBeforeSdkUse: () => { volatile.clear(); db.close(); } };
}
