import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import { walletConnectionActionSchema, walletConnectionOperationSchema, type WalletConnectionOperationRecord } from "./walletConnectionOperations.js";

export function readStoredWalletConnectionOperation(db: SqliteDatabase, id: string): WalletConnectionOperationRecord | undefined {
    const row = db.prepare("SELECT * FROM wallet_connection_operations WHERE operation_id=?").get(id) as {
      operation_id: string; card_id: string; owner_id: string; run_id: string; data_epoch: number; action: string;
      connection_id: string; status: string; input_json: string; result_json: string | null;
      sdk_pending: number; created_at: string; updated_at: string; expires_at: string } | undefined;
    if (!row) return undefined;
    const input = walletConnectionActionSchema.parse(JSON.parse(row.input_json));
    const result = row.result_json ? JSON.parse(row.result_json) as { message?: string } : {};
    return { ...walletConnectionOperationSchema.parse({ operationId: row.operation_id, cardId: row.card_id, action: row.action,
      status: row.status, settlementPending: row.sdk_pending === 1, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
      ...(row.connection_id ? { connectionId: row.connection_id } : {}), ...({}),
      ...result }),
      ownerId: row.owner_id, runId: row.run_id, dataEpoch: row.data_epoch, input };
}
