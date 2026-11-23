import { afterEach } from "vitest";
import { SqliteActivityStore } from "../../src/core/activity/sqliteActivityStore.js";
import { externalActivityScanFromRow, externalActivityTransactionFromRow } from "../../src/core/activity/sqliteActivityStoreRows.js";
import { validateSupportedAdapterLifecycle } from "../../src/adapters/adapterLifecycleValidators.js";
import { seedCurrentReadAccount } from "./readAccount.js";

const openStores = new Set<SqliteActivityStore>();
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
});

export class TestSqliteActivityStore extends SqliteActivityStore {
  constructor() {
    super({ databasePath: ":memory:", validateAdapterLifecycle: validateSupportedAdapterLifecycle });
    openStores.add(this);
  }
  seedReadAccount(address: string, at?: Date) { return seedCurrentReadAccount(this, address, at); }

  get storedTransactions() {
    const db = this.createSettingsWorkflowStore("inspection").db;
    return (db.prepare(`SELECT eat.*, a.address AS account, s.incomplete_reason AS last_scan_incomplete_reason
      FROM external_activity_transactions eat JOIN accounts a ON eat.account_id=a.id
      JOIN external_activity_scans s ON s.scan_id=eat.last_scan_id ORDER BY eat.rowid`).all() as
      Parameters<typeof externalActivityTransactionFromRow>[0][]).map(externalActivityTransactionFromRow);
  }
  get externalActivityScans() {
    const db = this.createSettingsWorkflowStore("inspection").db;
    return (db.prepare(`SELECT s.*, a.address AS account FROM external_activity_scans s JOIN accounts a ON s.account_id=a.id
      ORDER BY s.rowid`).all() as Parameters<typeof externalActivityScanFromRow>[0][]).map(externalActivityScanFromRow);
  }
}

// The synthetic activity index retains its complete history from checkpoint zero.
export const activityIndexGenesis = { checkpoint: "0", timestamp: "1970-01-01T00:00:00.000Z" };
