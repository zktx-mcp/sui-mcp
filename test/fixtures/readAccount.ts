import { randomUUID } from "node:crypto";
import type { ActivityStore, ActiveAccountRecord } from "../../src/core/activity/activityStore.js";
import { SqliteActivityStore } from "../../src/core/activity/sqliteActivityStore.js";
import { InMemoryActivityStore } from "./inMemoryActivityStore.js";
import { walletConnectionSchema } from "../../src/core/session/walletConnection.js";
import { initialGrantRevisions } from "../../src/core/session/chainAccounts.js";

// External setup for read/history unit tests only. The record is disconnected,
// has no SDK topic or grant, and cannot prove wallet admission or signing.
export async function seedCurrentReadAccount(store: ActivityStore, address: string, at = new Date(), wallet?: { name?: string | undefined; connectionId?: string | undefined }): Promise<ActiveAccountRecord> {
  if (store instanceof InMemoryActivityStore) return store.seedReadAccount(address, at);
  if (!(store instanceof SqliteActivityStore)) throw new Error("A concrete read fixture store is required.");
  const account = await store.upsertAccount(address, "wallet_connection", at);
  const db = store.createSettingsWorkflowStore("read-fixture").db;
  const connection = walletConnectionSchema.parse({ connectionId: wallet?.connectionId ?? randomUUID(), status: "disconnected", revision: 0,
    requestedChains: ["sui:mainnet"], chainResults: [{ chainId: "sui:mainnet", status: "bound", address: account.address }], approvedAt: at.toISOString(),
    grants: [], grantRevisions: initialGrantRevisions(), lifecycleRevision: 0, createdAt: at.toISOString(), updatedAt: at.toISOString(), expiresAt: at.toISOString(),
    ...(wallet?.name ? { walletName: wallet.name } : {}) });
  db.transaction(() => {
    db.prepare("UPDATE live_wallet_connections SET current_slot=NULL WHERE current_slot=1").run();
    db.prepare(`INSERT INTO live_wallet_connections(id,owner_id,run_id,status,revision,connection_json,current_slot,data_epoch)
      VALUES (?,'read-fixture','read-fixture','disconnected',0,?,1,(SELECT data_epoch FROM settings_control WHERE id=1))`)
      .run(connection.connectionId,JSON.stringify(connection));
  }).immediate();
  return (await store.getActiveAccount())!;
}

// State setup for read/display tests; full permission/admission is tested through Settings.
export async function seedReadAddressCleared(store: ActivityStore): Promise<void> {
  if (store instanceof InMemoryActivityStore) { await store.clearReadFixture(); return; }
  if (!(store instanceof SqliteActivityStore)) throw new Error("A concrete read fixture store is required.");
  const current = await store.getActiveAccount();
  if (!current?.connectionId) throw new Error("A current stored read address is required.");
  store.createSettingsWorkflowStore("read-fixture").clearReadAddress(current.connectionId, current.address);
}
