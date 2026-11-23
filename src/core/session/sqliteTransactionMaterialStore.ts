import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import type { UnknownRecord } from "../action/types.js";
import {
  buildTransactionMaterialRecord,
  sameHandle,
  toMaterialHandle,
  type LocalTransactionMaterialHandle,
  type LocalTransactionMaterialKind,
  type LocalTransactionMaterialRecord,
  type LocalTransactionMaterialSource,
  type LocalTransactionMaterialStore,
  type StoreLocalTransactionMaterialInput
} from "./transactionMaterialStore.js";

type LiveTransactionMaterialRow = {
  material_id: string;
  review_session_id: string;
  plan_id: string;
  account: string;
  kind: string;
  source: string;
  transaction_bytes: Buffer;
  redacted_diagnostics_json: string | null;
  created_at: string;
  expires_at: string;
};

/**
 * SQLite-backed transaction material store. Holds the same synchronous contract as
 * InMemoryLocalTransactionMaterialStore so producers and the wallet handoff path are
 * unchanged, but persists records (including the unsigned transaction BLOB) to the
 * shared local database so any review-server process can read them. Validation,
 * handle identity, and expiry semantics are shared via transactionMaterialStore.ts,
 * so the two backends never drift. The unsigned bytes are protected at rest by the
 * data directory (0700) and database file (0600) permissions set in SqliteActivityStore.
 */
export class SqliteTransactionMaterialStore implements LocalTransactionMaterialStore {
  constructor(private readonly db: SqliteDatabase) {}

  recordTransactionMaterial(
    input: StoreLocalTransactionMaterialInput,
    now = new Date()
  ): LocalTransactionMaterialHandle {
    const record = buildTransactionMaterialRecord(input, now);
    const inserted = this.db
      .prepare(
        `INSERT INTO live_transaction_materials
           (material_id, review_session_id, plan_id, account, kind, source,
            transaction_bytes, redacted_diagnostics_json, created_at, expires_at, preparation_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ? IS NULL OR EXISTS (
           SELECT 1 FROM live_review_sessions r JOIN live_wallet_connections c ON c.id=r.wallet_connection_id
           WHERE r.id=? AND r.preparation_id=? AND r.account=? AND r.status!='expired' AND r.expires_at>?
           AND json_extract(r.plans_json,'$[0].id')=?
           AND json_extract(c.connection_json,'$.grantRevisions."sui:mainnet"')=r.wallet_grant_revision
           AND c.owner_id=r.owner_id AND c.run_id=r.preparation_run_id AND c.current_slot=1 AND c.status='connected'
           AND c.data_epoch=(SELECT data_epoch FROM settings_control WHERE id=1)
         )`
      )
      .run(
        record.materialId,
        record.reviewSessionId,
        record.planId,
        record.account,
        record.kind,
        record.source,
        Buffer.from(record.transactionBytes),
        record.redactedDiagnostics === undefined ? null : JSON.stringify(record.redactedDiagnostics),
        record.createdAt,
        record.expiresAt, input.preparationId ?? null, input.preparationId ?? null,
        record.reviewSessionId, input.preparationId ?? null, record.account, now.toISOString(), record.planId
      );
    if (inserted.changes !== 1) throw new Error("The review preparation changed before storing its candidate.");
    return toMaterialHandle(record);
  }

  getTransactionMaterial(
    handle: LocalTransactionMaterialHandle,
    now = new Date()
  ): LocalTransactionMaterialRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM live_transaction_materials WHERE material_id = ?`)
      .get(handle.materialId) as LiveTransactionMaterialRow | undefined;
    if (!row) {
      return undefined;
    }
    if (Date.parse(row.expires_at) <= now.getTime()) {
      this.db.prepare(`DELETE FROM live_transaction_materials WHERE material_id = ?`).run(handle.materialId);
      return undefined;
    }
    const record = recordFromRow(row);
    if (!sameHandle(record, handle)) {
      return undefined;
    }
    return record;
  }

  deleteTransactionMaterial(handle: LocalTransactionMaterialHandle): void {
    this.db.prepare("DELETE FROM live_transaction_materials WHERE material_id=? AND review_session_id=? AND plan_id=? AND account=?")
      .run(handle.materialId, handle.reviewSessionId, handle.planId, handle.account);
  }
  deleteReviewSessionTransactionMaterials(reviewSessionId: string): void {
    this.db.prepare(`DELETE FROM live_transaction_materials WHERE review_session_id = ?`).run(reviewSessionId);
  }
}

// Each read rebuilds a fresh record (new Uint8Array from the BLOB, parsed
// diagnostics) so a caller mutating the result never touches the stored row.
function recordFromRow(row: LiveTransactionMaterialRow): LocalTransactionMaterialRecord {
  return {
    materialId: row.material_id,
    reviewSessionId: row.review_session_id,
    planId: row.plan_id,
    account: row.account,
    kind: row.kind as LocalTransactionMaterialKind,
    source: row.source as LocalTransactionMaterialSource,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    transactionBytes: new Uint8Array(row.transaction_bytes),
    ...(row.redacted_diagnostics_json == null
      ? {}
      : { redactedDiagnostics: JSON.parse(row.redacted_diagnostics_json) as UnknownRecord })
  };
}
