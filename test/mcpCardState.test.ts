import { seedCurrentReadAccount } from "./fixtures/readAccount.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CardStore } from "../src/core/session/cardSessionStore.js";
import { SqliteActivityStore } from "../src/core/activity/sqliteActivityStore.js";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import { RuntimeDataAccess } from "../src/runtime/shared/dataAccess.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../src/runtime/config.js";

const account = `0x${"1".repeat(64)}`;
const now = new Date("2026-09-22T00:00:00.000Z");
const choice = { account };
const dataOptions = { suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
  advanceRequestDeadlines: (_now: Date) => {}, // Read-card fixtures have no wallet requests.
  verifySuiGrpcUrl: async (url: string) => { expect(url).toBe(DEFAULT_SUI_GRPC_URL); },
  verifySuiGraphqlUrl: async (url: string) => { expect(url).toBe(DEFAULT_SUI_GRAPHQL_URL); } };
async function database(access?: RuntimeDataAccess) {
  const directory = mkdtempSync(join(tmpdir(), "say-card-state-"));
  const path = join(directory, "state.sqlite");
  const store = new SqliteActivityStore({ databasePath: path, validateAdapterLifecycle: validateSupportedAdapterLifecycle,
    ...(access ? { guardDatabase: access.guardDatabase } : {}) });
  await store.createPreferencesRepository().ensureDefaultLocalSettings(dataOptions);
  return { store, path, records: store.createCardRecordStore(), close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("DB-owned card admission, recovery and results", () => {
  it("keeps unsubmitted input across reads and returns one persisted result to other store instances", async () => {
    const db = await database(); let calls = 0;
    const options = { records: db.records, ownerId: "owner", now: () => now, execute: async () => { calls++; return { value: "source result" }; } };
    const cards = new CardStore(options);
    try {
      const created = await cards.create("account", {});
      const ref = { cardId: created.snapshot.cardId, permission: created.permission };
      expect((await cards.readSaved(ref.cardId))).toMatchObject({ state: "ready", revision: 0 });
      expect((await cards.read(ref)).snapshot).toMatchObject({ state: "ready", revision: 0, inputRemainingMs: 1_800_000 });
      const second = new CardStore(options);
      expect((await second.read(ref)).snapshot).toMatchObject({ state: "ready", revision: 0 });
      const result = await cards.submit({ ...ref, revision: 0, input: choice });
      expect(result.snapshot).toMatchObject({ state: "closed", reason: "completed", revision: 2, input: choice, data: { value: "source result" } });
      expect(await second.submit({ ...ref, revision: 0, input: choice })).toEqual(result);
      expect((await second.readSaved(ref.cardId))).toEqual(result.snapshot);
      expect(calls).toBe(1);
      expect(JSON.stringify(result)).not.toContain(created.permission);
      expect(JSON.stringify(result)).not.toContain("tokenHash");
    } finally { db.close(); }
  });
  it("atomically admits concurrent callers and returns canonical state for duplicates and conflicts", async () => {
    const db = await database();
    const peer = new SqliteActivityStore({ databasePath: db.path, validateAdapterLifecycle: validateSupportedAdapterLifecycle });
    const source = deferred<unknown>(); let calls = 0;
    const execute = () => { calls++; return source.promise; };
    const first = new CardStore({ records: db.records, ownerId: "owner", now: () => now, execute });
    const second = new CardStore({ records: peer.createCardRecordStore(), ownerId: "owner", now: () => now, execute });
    try {
      const created = await first.create("account", {});
      const input = { cardId: created.snapshot.cardId, permission: created.permission, revision: 0, input: choice };
      const pending = first.submit(input);
      expect((await second.submit(input)).snapshot).toMatchObject({ state: "running", revision: 1 });
      const conflict = await second.submit({ ...input, input: { account: `0x${"2".repeat(64)}` } });
      expect(conflict.error?.code).toBe("card_conflict");
      expect(conflict.snapshot).toMatchObject({ state: "running", input: choice });
      source.resolve({ value: "one result" });
      await pending;
      expect((await second.read(input)).snapshot).toMatchObject({ state: "closed", reason: "completed", data: { value: "one result" } });
      expect(calls).toBe(1);
    } finally { peer.close(); db.close(); }
  });
  it("checks permission, input, revision and server expiry independently without consuming valid input", async () => {
    const db = await database(); let clock = now; let calls = 0;
    const cards = new CardStore({ records: db.records, ownerId: "owner", now: () => clock, execute: async () => { calls++; return {}; } });
    try {
      const created = await cards.create("account", {});
      const input = { cardId: created.snapshot.cardId, permission: created.permission, revision: 0, input: choice };
      await expect(cards.submit({ ...input, permission: "wrong" })).rejects.toThrow("access is unavailable");
      const invalid = await cards.submit({ ...input, input: { account: "invalid" } });
      expect(invalid).toMatchObject({ error: { code: "invalid_card_input" }, snapshot: { state: "ready", revision: 0 } });
      const stale = await cards.submit({ ...input, revision: 1 });
      expect(stale).toMatchObject({ error: { code: "card_conflict" }, snapshot: { state: "ready", revision: 0 } });
      clock = new Date("2026-09-22T00:29:59.999Z");
      expect((await cards.read(input)).snapshot.inputRemainingMs).toBe(1);
      clock = new Date("2026-09-22T00:30:00.000Z");
      expect((await cards.read(input)).snapshot).toMatchObject({ state: "closed", reason: "expired", revision: 1 });
      expect((await cards.submit(input)).snapshot).toMatchObject({ state: "closed", reason: "expired", revision: 1 });
      expect(calls).toBe(0);
    } finally { db.close(); }
  });
  it("recovers abandoned work without replaying it and preserves completed results beyond the input deadline", async () => {
    const db = await database(); const delayed = deferred<unknown>(); let calls = 0;
    const old = new CardStore({ records: db.records, ownerId: "old", now: () => now,
      execute: async (_kind, input) => { calls++; return input.account === account ? delayed.promise : { value: "complete" }; } });
    try {
      const ready = await old.create("account", {});
      const running = await old.create("account", {});
      const pending = old.submit({ cardId: running.snapshot.cardId, permission: running.permission, revision: 0, input: choice });
      const done = await old.create("account", { account: `0x${"2".repeat(64)}` }, true);
      const recovered = new CardStore({ records: db.records, ownerId: "new", now: () => new Date("2026-09-23T00:00:00.000Z"),
        execute: async () => { throw new Error("Recovery must not execute a query."); } });
      expect((await recovered.readSaved(ready.snapshot.cardId))).toMatchObject({ state: "closed", reason: "expired" });
      expect((await recovered.readSaved(running.snapshot.cardId))).toMatchObject({ state: "closed", reason: "server_restarted" });
      expect((await recovered.readSaved(done.snapshot.cardId))).toMatchObject({ reason: "completed", data: { value: "complete" } });
      delayed.resolve({ value: "late" });
      expect((await pending).snapshot).toMatchObject({ reason: "server_restarted" });
      expect((await recovered.readSaved(running.snapshot.cardId)).data).toBeUndefined();
      expect(calls).toBe(2);
    } finally { db.close(); }
  });
  it("invalidates unexpired ready cards on owner change without relying on a View event", async () => {
    const db = await database();
    const cards = new CardStore({ records: db.records, ownerId: "old", now: () => now, execute: async () => ({}) });
    try {
      const ready = await cards.create("account", {});
      const next = new CardStore({ records: db.records, ownerId: "new", now: () => now, execute: async () => ({}) });
      expect((await next.readSaved(ready.snapshot.cardId))).toMatchObject({ state: "closed", reason: "server_restarted" });
    } finally { db.close(); }
  });
  it.each(["reset", "import"] as const)("removes card permissions with %s and refuses the delayed result", async (operation) => {
    const access = new RuntimeDataAccess(); const db = await database(access); const delayed = deferred<unknown>();
    const cards = new CardStore({ records: db.records, ownerId: "owner", now: () => now, assertCurrent: access.assertCurrent, execute: () => delayed.promise });
    const data = db.store.createLocalDataService({ ...dataOptions, onDataReplaced: () => access.dataReplaced() });
    const backup = await data.exportLocalData();
    access.ready();
    try {
      const created = await access.run(() => cards.create("account", {}));
      const ref = { cardId: created.snapshot.cardId, permission: created.permission };
      const pending = access.run(() => cards.submit({ ...ref, revision: 0, input: choice }));
      const rejection = expect(pending).rejects.toThrow("stale access");
      await access.run(() => operation === "reset" ? data.resetLocalData() : data.importLocalDataReplace(backup));
      delayed.resolve({ value: "late" }); await rejection;
      await expect(access.run(() => cards.read(ref))).rejects.toThrow("access is unavailable");
      expect(access.run(() => db.records.get(ref.cardId))).toBeUndefined();
    } finally { cards.stop(); access.close(); db.close(); }
  });
  it("rolls back card invalidation on reset failure and excludes private card records from backup", async () => {
    const db = await database(); const raw = new Database(db.path);
    const cards = new CardStore({ records: db.records, ownerId: "owner", now: () => now, execute: async () => ({ value: "saved" }) });
    const local = db.store.createLocalDataService(dataOptions);
    try {
      await seedCurrentReadAccount(db.store, account, now);
      const created = await cards.create("account", choice, true);
      const backup = await local.exportLocalData();
      expect(JSON.stringify(backup)).not.toContain(created.snapshot.cardId);
      expect(JSON.stringify(backup)).not.toContain(created.permission);
      raw.exec("CREATE TRIGGER fail_reset BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT, 'fixture reset failure'); END");
      await expect(local.resetLocalData()).rejects.toThrow("fixture reset failure");
      expect((await cards.read({ cardId: created.snapshot.cardId, permission: created.permission })).snapshot).toEqual(created.snapshot);
      expect(await db.store.getActiveAccount()).toMatchObject({ address: account });
    } finally { raw.close(); db.close(); }
  });
  it("does not call the source after admission write failure or return success after result write failure", async () => {
    const db = await database(); const raw = new Database(db.path); let calls = 0;
    const cards = new CardStore({ records: db.records, ownerId: "owner", now: () => now, execute: async () => { calls++; return { value: "unstored" }; } });
    try {
      const created = await cards.create("account", {});
      const input = { cardId: created.snapshot.cardId, permission: created.permission, revision: 0, input: choice };
      raw.exec("CREATE TRIGGER fail_admission BEFORE UPDATE ON live_read_cards WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT, 'fixture admission failure'); END");
      await expect(cards.submit(input)).rejects.toThrow("fixture admission failure");
      expect(calls).toBe(0); expect((await cards.read(input)).snapshot.state).toBe("ready");
      raw.exec("DROP TRIGGER fail_admission");
      raw.exec("CREATE TRIGGER fail_result BEFORE UPDATE ON live_read_cards WHEN NEW.reason='completed' BEGIN SELECT RAISE(ABORT, 'fixture result failure'); END");
      expect((await cards.submit(input)).snapshot).toMatchObject({ state: "closed", reason: "failed" });
      expect((await cards.readSaved(input.cardId)).data).toBeUndefined(); expect(calls).toBe(1);
    } finally { raw.close(); db.close(); }
  });
  it("does not persist or expose forbidden source output", async () => {
    const db = await database();
    const cards = new CardStore({ records: db.records, ownerId: "owner", now: () => now, execute: async () => ({ signature: "private fixture" }) });
    try {
      const created = await cards.create("account", choice, true);
      expect(created.snapshot).toMatchObject({ state: "closed", reason: "failed" });
      expect(JSON.stringify(db.records.get(created.snapshot.cardId))).not.toContain("private fixture");
    } finally { db.close(); }
  });
});

it.each(["reset", "stop"] as const)("refuses a late preparation result after %s without creating a failure record", async (operation) => {
  const access = new RuntimeDataAccess(); const db = await database(access);
  const raw = new Database(db.path);
  const preparation = deferred<{ status: "failed"; error: string }>();
  let prepares = 0, executes = 0;
  const cards = new CardStore({ records: db.records, ownerId: "owner", assertCurrent: access.assertCurrent,
    prepare: async () => { prepares++; return preparation.promise; }, execute: async () => { executes++; return {}; } });
  const data = db.store.createLocalDataService({ ...dataOptions, onDataReplaced: () => access.dataReplaced() });
  access.ready();
  try {
    const creating = access.run(() => cards.create("chart", {}));
    const rejected = expect(creating).rejects.toThrow(operation === "reset" ? "stale access" : "This card cannot be checked right now.");
    if (operation === "reset") await access.run(() => data.resetLocalData());
    else cards.stop();
    preparation.resolve({ status: "failed", error: "Fixture source unavailable" }); await rejected;
    expect(raw.prepare("SELECT COUNT(*) AS count FROM live_read_cards").get()).toEqual({ count: 0 });
    expect(prepares).toBe(1); expect(executes).toBe(0);
  } finally { cards.stop(); raw.close(); access.close(); db.close(); }
});

it("persists a safe preparation exception but refuses success when the initial DB write fails", async () => {
  const db = await database(); const raw = new Database(db.path); let executes = 0;
  const cards = new CardStore({ records: db.records, ownerId: "owner",
    prepare: async () => { throw new Error("private-source-fixture-must-not-be-exposed"); },
    execute: async () => { executes++; return {}; } });
  try {
    const failed = await cards.create("chart", {});
    expect(failed.snapshot).toMatchObject({ state: "closed", reason: "failed", revision: 0 });
    expect(failed.snapshot.error).toContain("The choices for this card could not be loaded.");
    expect(JSON.stringify(failed)).not.toContain("private-source-fixture");
    expect(db.records.get(failed.snapshot.cardId)?.acceptedInput).toBeUndefined();
    raw.exec("CREATE TRIGGER fail_initial_card BEFORE INSERT ON live_read_cards BEGIN SELECT RAISE(ABORT, 'fixture initial write failure'); END");
    await expect(cards.create("chart", {})).rejects.toThrow("fixture initial write failure");
    expect(raw.prepare("SELECT COUNT(*) AS count FROM live_read_cards").get()).toEqual({ count: 1 });
    expect(executes).toBe(0);
  } finally { cards.stop(); raw.close(); db.close(); }
});
