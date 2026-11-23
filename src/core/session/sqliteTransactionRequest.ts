import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { receiptObservationMessages, receiptObservationSchema, transactionRequestSchema, type TransactionRequest, type TransactionRequestStatus } from "./transactionRequest.js";

type RequestRow = {
  attempt_id: string; review_session_id: string; plan_id: string; review_revision: number;
  account: string; transaction_digest: string; request_status: TransactionRequestStatus;
  revision: number; created_at: string; updated_at: string; reason: string | null;
  observation_json: string | null; signature_verified_at: string | null; submission_admitted_at: string | null; result_json: string | null; recorded_at: string | null;
};

export function readStoredTransactionRequest(db: SqliteDatabase, id: string): TransactionRequest | undefined {
    const row = db.prepare(`SELECT r.*, a.address AS account, e.result_json, e.recorded_at FROM review_requests r
      JOIN accounts a ON a.id=r.account_id AND a.chain_id='sui:mainnet' LEFT JOIN review_executions e ON e.attempt_id=r.attempt_id
      WHERE r.attempt_id=?`).get(id) as RequestRow | undefined;
    if (!row) return undefined;
    const observation = row.observation_json === null ? undefined : receiptObservationSchema.parse(JSON.parse(row.observation_json));
    const reason = row.request_status === "completed" ? undefined :
      observation && row.reason && Object.values(receiptObservationMessages).includes(row.reason) ? receiptObservationMessages[observation.kind] : row.reason;
    const result = transactionRequestSchema.parse({ attemptId: row.attempt_id, reviewSessionId: row.review_session_id,
      planId: row.plan_id, reviewRevision: row.review_revision, account: row.account, transactionDigest: row.transaction_digest,
      requestStatus: row.request_status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(observation ? {lastObservation:observation} : {}),
      ...(reason ? { reason } : {}),
      ...(row.signature_verified_at === null ? {} : { signatureVerifiedAt: row.signature_verified_at }),
      ...(row.submission_admitted_at === null ? {} : { submissionAdmittedAt: row.submission_admitted_at }),
      ...(row.result_json === null ? {} : { execution: { ...JSON.parse(row.result_json), recordedAt: row.recorded_at } }) });
    assertNoForbiddenMcpFields(result);
    return result;
  }
