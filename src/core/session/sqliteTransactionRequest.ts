import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { transactionRequestSchema, type TransactionRequest, type TransactionRequestStatus } from "./transactionRequest.js";

type RequestRow = {
  attempt_id: string; review_session_id: string; plan_id: string; review_revision: number;
  account: string; transaction_digest: string; request_status: TransactionRequestStatus;
  revision: number; created_at: string; updated_at: string; reason: string | null;
  signature_verified_at: string | null; submitted_at: string | null; result_json: string | null;
};

export function readStoredTransactionRequest(db: SqliteDatabase, id: string): TransactionRequest | undefined {
    const row = db.prepare(`SELECT r.*, a.address AS account, e.result_json FROM review_requests r
      JOIN accounts a ON a.id=r.account_id AND a.chain_id='sui:mainnet' LEFT JOIN review_executions e ON e.attempt_id=r.attempt_id
      WHERE r.attempt_id=?`).get(id) as RequestRow | undefined;
    if (!row) return undefined;
    const result = transactionRequestSchema.parse({ attemptId: row.attempt_id, reviewSessionId: row.review_session_id,
      planId: row.plan_id, reviewRevision: row.review_revision, account: row.account, transactionDigest: row.transaction_digest,
      requestStatus: row.request_status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.signature_verified_at === null ? {} : { signatureVerifiedAt: row.signature_verified_at }),
      ...(row.submitted_at === null ? {} : { submittedAt: row.submitted_at }),
      ...(row.result_json === null ? {} : { execution: JSON.parse(row.result_json) }) });
    assertNoForbiddenMcpFields(result);
    return result;
  }
