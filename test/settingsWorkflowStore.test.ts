import { seedCurrentReadAccount } from "./fixtures/readAccount.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import { SqliteActivityStore } from "../src/core/activity/sqliteActivityStore.js";
import { createLocalSessionBase } from "../src/core/session/localSession.js";
import type { CardRecord } from "../src/core/session/cardSession.js";
import { settingsIdentity } from "../src/core/session/sqliteSettingsWorkflowStore.js";
import { SettingsConflict } from "../src/core/session/settingsOperation.js";

const resources: (() => void)[] = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sui-mcp-settings-store-"));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "sui-mcp.sqlite");
  const activity = new SqliteActivityStore({ databasePath: path, validateAdapterLifecycle: validateSupportedAdapterLifecycle });
  resources.push(() => activity.close());
  const db = new Database(path); resources.push(() => db.close());
  const now = new Date("2026-10-04T00:00:00.000Z");
  const store = activity.createSettingsWorkflowStore("settings-owner", () => now);
  const create = () => {
    const { base, token } = createLocalSessionBase(now, 30 * 60 * 1000);
    const card: CardRecord = { ownerId: "settings-owner", scope: "settings", tokenHash: base.tokenHash, operationId: randomUUID(),
      state: { cardId: base.id, kind: "settings", state: "ready", revision: 0, input: {}, createdAt: base.createdAt, expiresAt: base.expiresAt } };
    store.create(card);
    return { card, token, operation: store.forCard(card) };
  };
  const admit = (entry: ReturnType<typeof create>, kind: "restore_endpoint" | "reset_local_data" = "restore_endpoint") => {
    const preparationId = randomUUID();
    store.write(entry.operation, { ...entry.operation, draft: kind === "restore_endpoint" ? { kind, endpoint: "grpc" } : { kind }, phase: "prepared", preparationId, fingerprint: "selected-settings", preparedUserDataRevision: store.control().user_data_revision }, entry.card);
    return store.admit(store.cards.get(entry.card.state.cardId)!, { action: "settings_confirm", operationId: entry.operation.operationId, preparationId }, () => "selected-settings");
  };
  return { activity, store, db, now, create, admit };
}

it("commits Settings identity with its card and rolls both back on a write failure", () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER reject_settings BEFORE INSERT ON settings_operations BEGIN SELECT RAISE(ABORT,'operation storage refused'); END");
  expect(() => f.create()).toThrow("operation storage refused");
  expect(f.db.prepare("SELECT count(*) AS count FROM live_read_cards").get()).toEqual({ count: 0 });
  f.db.exec("DROP TRIGGER reject_settings");
  const { card, operation } = f.create();
  expect(operation).toMatchObject({ cardId: card.state.cardId, operationId: card.operationId, dataEpoch: 0, phase: "draft" });
});

it("invalidates a replacement confirmation on a same-count user-data change, once", async () => {
  const f = fixture();
  const address = `0x${"a".repeat(64)}`;
  await seedCurrentReadAccount(f.activity, address, f.now);
  const { card, operation } = f.create();
  const userRevision = f.store.control().user_data_revision;
  f.store.write(operation, { ...operation, draft: { kind: "reset_local_data" }, phase: "prepared",
    preparationId: randomUUID(), fingerprint: "prior-data", preparedUserDataRevision: userRevision }, card);
  f.db.prepare("UPDATE accounts SET last_used_at=? WHERE address=?").run("2026-10-04T00:00:01.000Z", address);
  expect(f.db.prepare("SELECT count(*) AS count FROM accounts").get()).toEqual({ count: 1 });
  expect(f.store.control().user_data_revision).toBe(userRevision + 1);
  expect(f.store.forCard(card)).toMatchObject({ phase: "draft" });
  expect(f.store.forCard(card).preparationId).toBeUndefined();
  expect(f.store.cards.get(card.state.cardId)?.state.revision).toBe(2);
  f.db.prepare("UPDATE accounts SET last_used_at=? WHERE address=?").run("2026-10-04T00:00:02.000Z", address);
  expect(f.store.cards.get(card.state.cardId)?.state.revision).toBe(2);
  expect(() => f.store.requireInput(card)).toThrow(SettingsConflict);
});

it("keeps a completed operation immutable and releases only its own final reservation", () => {
  const f = fixture(); const a = f.create(), b = f.create();
  f.admit(a);
  expect(() => f.store.claimFinal(b.operation.operationId)).toThrow(SettingsConflict);
  const result = { outcome: "completed" as const, recordedAt: f.now.toISOString(), message: "The default network address was saved." };
  expect(f.store.finish(a.operation.operationId, result)).toBe(true);
  const revision = f.store.cards.get(a.card.state.cardId)?.state.revision;
  expect(f.store.finish(a.operation.operationId, result)).toBe(true);
  expect(f.store.cards.get(a.card.state.cardId)?.state.revision).toBe(revision);
  expect(f.store.finish(a.operation.operationId, { ...result, message: "different" })).toBe(false);
  expect(f.store.control().active_operation_id).toBeNull();
  f.store.claimFinal(b.operation.operationId);
  expect(f.store.finish(a.operation.operationId, result)).toBe(true);
  expect(f.store.control().active_operation_id).toBe(b.operation.operationId);
  expect(() => f.db.prepare("UPDATE settings_operations SET result_json='{}' WHERE operation_id=?").run(a.operation.operationId))
    .toThrow("terminal result is immutable");
});

it("preserves the applying card and private result in the same reset transaction", async () => {
  const f = fixture();
  await f.activity.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
  const a = f.create(), other = f.create();
  const localData = f.activity.createLocalDataService({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql",
    advanceRequestDeadlines: () => {}, verifySuiGrpcUrl: async () => {}, verifySuiGraphqlUrl: async () => {} });
  f.store.transaction(() => {
    f.admit(a, "reset_local_data");
    localData.applyValidatedReplacement(undefined, f.now, a.card.state.cardId);
    f.store.finish(a.operation.operationId, { outcome: "completed", recordedAt: f.now.toISOString(), message: "Local data reset." });
  });
  expect(f.store.control().data_epoch).toBe(1);
  expect(f.store.cards.get(other.card.state.cardId)).toBeUndefined();
  expect(f.store.cards.get(a.card.state.cardId)).toMatchObject({ tokenHash: a.card.tokenHash, state: { state: "closed", reason: "completed" } });
  expect(f.store.get(a.operation.operationId)?.result).toMatchObject({ outcome: "completed" });
  expect(JSON.stringify(await localData.exportLocalData(f.now))).not.toContain(a.operation.operationId);
});

it("normalizes typed input identity independently of key order", () => {
  expect(settingsIdentity({ action: "settings_select", draft: { endpoint: "grpc", kind: "set_endpoint", value: "https://node.example:443" } }))
    .toBe(settingsIdentity({ draft: { value: "https://node.example:443", kind: "set_endpoint", endpoint: "grpc" }, action: "settings_select" }));
  expect(settingsIdentity({ value: "one" })).not.toBe(settingsIdentity({ value: "two" }));
});

it("records terminal-only upload retirement and its cleanup obligation in the same result commit", () => {
  const f = fixture(), { card, operation } = f.create(), fileId = randomUUID();
  // This synchronous Store check models file metadata; real file removal and
  // owner-exit tests cover the physical artifact independently.
  f.store.createFile({ fileId, operationId: operation.operationId, cleanupOperationId: operation.operationId,
    role: "upload", relativePath: `.settings-staging/${fileId}.upload`, displayName: "synthetic-backup.json",
    totalSize: 1, receivedSize: 1, sha256: "0".repeat(64), sealed: true, invalidated: false, cleanup: "pending" });
  f.store.write(operation, { ...operation, draft: { kind: "import_local_data" }, phase: "sealed", fileId }, card);
  expect(f.store.filesForCleanup(operation.operationId)).toEqual([]);
  expect(f.store.finish(operation.operationId, { outcome: "interrupted", recordedAt: f.now.toISOString(), message: "This Settings change was cancelled. Nothing was applied." })).toBe(true);
  const closed = f.store.cards.get(card.state.cardId)!;
  expect(closed.state).toMatchObject({ state: "closed", reason: "cancelled", data: {
    result: { outcome: "interrupted" }, temporaryFileCleanup: "pending", file: { fileId, cleanup: "pending" }, allowedActions: [], observe: false } });
  expect(f.store.file(fileId)).toMatchObject({ invalidated: true, cleanup: "pending" });
  expect(f.store.filesForCleanup(operation.operationId)).toHaveLength(1);
});

it.each([
  { name: "complete current upload", role: "upload", received: 8, invalidated: false, differentOperation: false, phase: "sealed" },
  { name: "incomplete upload", role: "upload", received: 7, invalidated: false, differentOperation: false, phase: "draft" },
  { name: "invalidated upload", role: "upload", received: 8, invalidated: true, differentOperation: false, phase: "draft" },
  { name: "export file", role: "export", received: 8, invalidated: false, differentOperation: false, phase: "draft" },
  { name: "another operation's upload", role: "upload", received: 8, invalidated: false, differentOperation: true, phase: "draft" }
] as const)("uses the same Back and writer transition for $name", async (input) => {
  for (const source of ["back", "writer"] as const) {
    const f = fixture(); const address = `0x${"b".repeat(64)}`;
    await seedCurrentReadAccount(f.activity, address, f.now);
    const entry = f.create(), other = f.create(), fileId = randomUUID();
    f.store.createFile({ fileId, operationId: input.differentOperation ? other.operation.operationId : entry.operation.operationId,
      role: input.role, relativePath: "fixture", displayName: "backup.json", totalSize: 8, receivedSize: input.received,
      sha256: "0".repeat(64), sealed: true, invalidated: input.invalidated, cleanup: "pending" });
    f.store.write(entry.operation, { ...entry.operation, draft: { kind: "import_local_data" }, phase: "prepared", fileId,
      preparationId: randomUUID(), fingerprint: "prior-impact", preparation: { counts: { accounts: 1 } },
      preparedUserDataRevision: f.store.control().user_data_revision }, entry.card);
    const prepared = f.store.forCard(entry.card), card = f.store.cards.get(entry.card.state.cardId)!;
    if (source === "back") f.store.resetPreparation(prepared, card);
    else f.db.prepare("UPDATE accounts SET last_used_at=? WHERE address=?").run("2026-10-04T00:00:01.000Z", address);
    const reset = f.store.forCard(entry.card);
    expect(reset).toMatchObject({ phase: input.phase, fileId });
    for (const key of ["preparationId", "fingerprint", "preparation", "preparedUserDataRevision"]) expect(reset).not.toHaveProperty(key);
    expect(f.store.cards.get(card.state.cardId)?.state.revision).toBe(2);
    expect(() => f.store.requireInput(card)).toThrow(SettingsConflict);
    expect(f.store.get(other.operation.operationId)?.phase).toBe("draft");
  }
});

it("does not complete a draft or consume input when final admission rolls back", () => {
  const f = fixture(), entry = f.create();
  expect(() => f.store.finish(entry.operation.operationId, { outcome: "completed", recordedAt: f.now.toISOString(), message: "not admitted" })).toThrow("unconfirmed");
  f.db.exec("CREATE TRIGGER reject_admission BEFORE UPDATE ON settings_operations WHEN NEW.phase='executing' BEGIN SELECT RAISE(ABORT,'admission refused'); END");
  expect(() => f.admit(entry)).toThrow("admission refused");
  expect(f.store.control().active_operation_id).toBeNull();
  expect(f.store.cards.get(entry.card.state.cardId)).toMatchObject({ state: { state: "ready" } });
  expect(f.store.cards.get(entry.card.state.cardId)?.acceptedInput).toBeUndefined();
});

it.each(["retain", "replace_file", "drop_file", "change_effect", "finish"] as const)("owns upload cleanup when an operation transitions by %s", (transition) => {
  const f = fixture(), entry = f.create(), fileId = randomUUID();
  f.store.createFile({ fileId, operationId: entry.operation.operationId, role: "upload", relativePath: "fixture.upload",
    displayName: "backup.json", totalSize: 8, receivedSize: 8, sha256: "0".repeat(64), sealed: true, invalidated: false, cleanup: "pending" });
  f.store.write(entry.operation, { ...entry.operation, draft: { kind: "import_local_data" }, phase: "sealed", fileId }, entry.card);
  const previous = f.store.forCard(entry.card), card = f.store.cards.get(entry.card.state.cardId)!;
  const next = { ...previous };
  if (transition === "replace_file") {
    next.fileId = randomUUID();
    f.store.createFile({ ...f.store.file(fileId)!, fileId: next.fileId, relativePath: "replacement.upload" });
  } else if (transition === "drop_file") delete next.fileId;
  else if (transition === "change_effect") next.draft = { kind: "clear_read_address" };
  if (transition === "finish") f.store.finish(previous.operationId, { outcome: "interrupted", recordedAt: f.now.toISOString(), message: "Cancelled." });
  else f.store.write(previous, next, card);
  expect(f.store.file(fileId)).toMatchObject({ operationId: previous.operationId, cleanupOperationId: previous.operationId,
    invalidated: transition !== "retain", cleanup: "pending" });
  expect(f.store.filesForCleanup(previous.operationId).map((file) => file.fileId)).toEqual(transition === "retain" ? [] : [fileId]);
  if (transition === "replace_file") expect(f.store.file(next.fileId!)?.invalidated).toBe(false);
});
