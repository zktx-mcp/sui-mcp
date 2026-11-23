import { scanContinuitySchema, scanReachedLowerBound, scanPageFollows, validScanPageBounds, windowCompletion } from "./transactionActivityScanPolicy.js";
import { SUI_MAINNET_CHAIN_IDENTIFIER } from "../suiEndpoint.js";
import { parseSuiFunctionTarget } from "./suiFunctionTarget.js";
import { isDeepStrictEqual } from "node:util";
import { extractRequestedIntent } from "./sqliteActivityStoreRows.js";
import { walletChainSchema, walletChainsSchema, normalizeChainAddress, SUI_MAINNET_WALLET_CHAIN } from "../session/chainAccounts.js";
import { LOCAL_SETTING_KEYS } from "../preferences/preferencesStore.js";
import { receiptObservationSchema, canTransitionRequest, transactionRequestStatusSchema, transactionRequestSchema, type TransactionRequestStatus } from "../session/transactionRequest.js";
import { REVIEW_TRANSITION_EVENTS } from "./sqliteActivityStoreRows.js";
import { z, type ZodType } from "zod";
import type { AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { parseLifecycleValidatedReviewState } from "../action/reviewStateValidation.js";
import { actionPlanSchema, transactionExecutionSummarySchema, internalSessionStatusSchema } from "../action/schemas.js";
import type { InternalSessionStatus, ReviewState } from "../action/types.js";
import { canTransitionReview, interruptedReviewStatus, reviewStatusAfterBinding } from "../session/reviewTransitions.js";
import { parseGraphqlUrl, parseGrpcUrl } from "../suiEndpoint.js";
import {
  EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES,
  externalActivityTransactionDetailJsonByteLength,
  externalActivityTransactionDetailSchema,
  externalActivityTransactionDetailsReferenceOnlyAccount
} from "./transactionActivityDetails.js";
import {
  LOCAL_DATA_EXPORT_FORMAT,
  LOCAL_DATA_NETWORK,
  LocalDataError,
  type AccountExportRow,
  type ExternalActivityScanExportRow,
  type ExternalActivityTransactionExportRow,
  type LocalDataCounts,
  type LocalDataEnvelope,
  type LocalDataPayload,
  type LocalSettingExportRow,
  type ReviewExecutionExportRow,
  type ReviewRequestExportRow,
  type ReviewSessionExportRow,
  type ReviewStateSnapshotExportRow,
  type ReviewStatusTransitionExportRow
} from "./localDataTypes.js";

const isoTimestamp = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "must be an ISO 8601 UTC timestamp");

const nullableString = z.string().nullable();

const accountRowSchema: z.ZodType<AccountExportRow> = z.object({
  id: z.number().int().positive(),
  chain_id: walletChainSchema,
  address: z.string(),
  first_seen_at: isoTimestamp,
  last_used_at: isoTimestamp,
  first_source: z.enum(["wallet_connection", "review_record"]),
  last_source: z.enum(["wallet_connection", "review_record"])
}).strict().refine((row) => normalizeChainAddress(row.chain_id, row.address) === row.address &&
  (row.chain_id === SUI_MAINNET_WALLET_CHAIN || row.first_source !== "review_record" && row.last_source !== "review_record"),
  "Account identity and source must match the supported chain");

const reviewSessionRowSchema: z.ZodType<ReviewSessionExportRow> = z.object({
  id: z.string().min(1),
  plan_id: z.string().min(1),
  action_kind: z.string().min(1),
  adapter_id: z.string().min(1),
  protocol: z.string().min(1),
  account_id: z.number().int().positive().nullable(),
  current_status: internalSessionStatusSchema,
  current_attempt_id: z.string().min(1).nullable(),
  opened_at: isoTimestamp.nullable(),
  plan_json: z.string(),
  intent_json: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
}).strict();

const reviewStateSnapshotRowSchema: z.ZodType<ReviewStateSnapshotExportRow> = z.object({
  id: z.number().int().positive(),
  review_revision: z.number().int().nonnegative(),
  review_session_id: z.string().min(1),
  plan_id: z.string().min(1),
  account_id: z.number().int().positive(),
  status: z.enum(["ready_for_wallet_review", "refresh_required", "blocked"]),
  blocked_reason: nullableString,
  refresh_reason: nullableString,
  state_json: z.string(),
  updated_at: isoTimestamp,
  recorded_at: isoTimestamp
}).strict();

const reviewStatusTransitionRowSchema: z.ZodType<ReviewStatusTransitionExportRow> = z.object({
  id: z.number().int().positive(),
  review_session_id: z.string().min(1),
  event: z.enum(REVIEW_TRANSITION_EVENTS),
  domain: z.enum(["review", "request"]),
  attempt_id: z.string().min(1).nullable(),
  from_status: z.string().nullable(),
  to_status: z.string(),
  account_id: z.number().int().positive().nullable(),
  reason: nullableString,
  transitioned_at: isoTimestamp
}).strict();

const reviewExecutionRowSchema: z.ZodType<ReviewExecutionExportRow> = z.object({
  attempt_id: z.string().min(1),
  review_session_id: z.string().min(1),
  plan_id: z.string().min(1),
  account_id: z.number().int().positive(),
  status: z.enum(["success", "failure"]),
  tx_digest: nullableString,
  explorer_url: nullableString,
  failure_reason: nullableString,
  result_json: z.string(),
  recorded_at: isoTimestamp,
  updated_at: isoTimestamp
}).strict();

const reviewRequestRowSchema: z.ZodType<ReviewRequestExportRow> = z.object({
  attempt_id: z.string().min(1), review_session_id: z.string().min(1), plan_id: z.string().min(1),
  review_revision: z.number().int().nonnegative(), account_id: z.number().int().positive(), transaction_digest: z.string().min(1),
  review_state_json: z.string(), request_status: transactionRequestStatusSchema, revision: z.number().int().nonnegative(),
  reason: nullableString, created_at: isoTimestamp, updated_at: isoTimestamp,
  signature_verified_at: isoTimestamp.nullable(), submission_admitted_at: isoTimestamp.nullable(), observation_json: nullableString
}).strict();

const externalActivityScanRowSchema: z.ZodType<ExternalActivityScanExportRow> = z.object({
  scan_id: z.string().min(1),
  kind: z.enum(["digest_lookup", "account_scan", "function_scan"]),
  account_id: z.number().int().positive(),
  relationship: z.enum(["affected", "sent"]),
  input_digest: nullableString,
  function_target: nullableString, continuity_json: nullableString,
  source_upper_timestamp: isoTimestamp.nullable(), source_upper_checkpoint: z.string().regex(/^\d+$/).nullable(),
  from_checkpoint: z.string().regex(/^\d+$/).nullable(),
  to_checkpoint: z.string().regex(/^\d+$/).nullable(),
  from_timestamp: isoTimestamp.nullable(),
  to_timestamp: isoTimestamp.nullable(),
  limit_count: z.number().int().min(1).max(100),
  request_cursor: nullableString,
  response_cursor: nullableString,
  endpoint_host: z.string().min(1),
  chain_identifier: z.string().min(1),
  fetched_at: isoTimestamp,
  stored_count: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  outside_filter_count: z.number().int().nonnegative(), unconfirmed_relation_count: z.number().int().nonnegative(),
  has_more: z.union([z.literal(0), z.literal(1)]),
  window_complete: z.union([z.literal(0), z.literal(1)]).nullable(),
  incomplete_reason: z.enum(["limit_reached", "ordering_unverified", "cursor_invalid", "provider_error"]).nullable()
}).strict();

const externalActivityTransactionRowSchema: z.ZodType<ExternalActivityTransactionExportRow> = z.object({
  account_id: z.number().int().positive(),
  digest: z.string().min(1),
  relationship: z.enum(["affected", "sent"]),
  checkpoint: nullableString,
  timestamp: isoTimestamp.nullable(),
  metadata_conflicts: z.number().int().min(0).max(7),
  status_conflict: z.union([z.literal(0), z.literal(1)]),
  status: z.enum(["success", "failure", "unknown"]),
  known_sender_account_id: z.number().int().positive().nullable(),
  first_scan_id: z.string().min(1),
  last_scan_id: z.string().min(1),
  first_fetched_at: isoTimestamp,
  last_fetched_at: isoTimestamp,
  detail_json: z.string().nullable()
}).strict();

const localSettingRowSchema: z.ZodType<LocalSettingExportRow> = z.object({
  key: z.enum(LOCAL_SETTING_KEYS),
  value_json: z.string(),
  updated_at: isoTimestamp
}).strict();

// Validate one row at a time so a rejected table retains at most one row's diagnostics.
function backupRows<T>(schema: z.ZodType<T>, exactCount?: number) {
  return z.unknown().transform((value, ctx): T[] => {
    if (Array.isArray(value) && (exactCount === undefined || value.length === exactCount)) {
      const rows: T[] = [];
      for (const row of value) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          ctx.addIssue({ code: "custom", message: "Invalid backup row" });
          return z.NEVER;
        }
        rows.push(parsed.data);
      }
      return rows;
    }
    ctx.addIssue({ code: "custom", message: "Invalid backup table" });
    return z.NEVER;
  });
}

const payloadSchema: z.ZodType<LocalDataPayload> = z.object({
  accounts: backupRows(accountRowSchema),
  reviewSessions: backupRows(reviewSessionRowSchema),
  reviewStateSnapshots: backupRows(reviewStateSnapshotRowSchema),
  reviewStatusTransitions: backupRows(reviewStatusTransitionRowSchema),
  reviewExecutions: backupRows(reviewExecutionRowSchema),
  reviewRequests: backupRows(reviewRequestRowSchema),
  externalActivityScans: backupRows(externalActivityScanRowSchema),
  externalActivityTransactions: backupRows(externalActivityTransactionRowSchema),
  externalActivityObservations: backupRows(z.object({ scan_id: z.string(), account_id: z.number().int().positive(),
    digest: z.string(), detail_status: z.enum(["available","missing","size_limit"]) }).strict()),
  localSettings: backupRows(localSettingRowSchema, LOCAL_SETTING_KEYS.length)
}).strict();

const envelopeSchema: z.ZodType<LocalDataEnvelope> = z.object({
  format: z.literal(LOCAL_DATA_EXPORT_FORMAT),
  network: z.literal(LOCAL_DATA_NETWORK),
  exportedAt: isoTimestamp,
  data: payloadSchema
}).strict();

export function validateBackupBytes(bytes: Uint8Array, validateAdapterLifecycle: AdapterLifecycleValidator): LocalDataEnvelope {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) {
      if (!(error instanceof TypeError) || !("code" in error) || error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
      throw new LocalDataError("input_invalid", "The backup is not valid UTF-8.", { reason: "invalid_backup_encoding" });
    }
    try { return parseLocalDataEnvelope(JSON.parse(text), { validateAdapterLifecycle }); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new LocalDataError("input_invalid", "The backup is not valid JSON.", { reason: "invalid_backup_json" });
    }
}

export function parseLocalDataEnvelope(
  input: unknown,
  options: { validateAdapterLifecycle: AdapterLifecycleValidator }
): LocalDataEnvelope {
  const envelope = parseEnvelopeRows(input);
  validatePayloadSemantics(envelope.data, options.validateAdapterLifecycle);
  return envelope;
}

function parseEnvelopeRows(input: unknown): LocalDataEnvelope {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new LocalDataError("input_invalid", "Invalid local data backup", {
      reason: "invalid_backup_shape"
    });
  }
  return parsed.data;
}

export function projectLocalDataExport(input: LocalDataEnvelope, validateAdapterLifecycle: AdapterLifecycleValidator): LocalDataEnvelope {
  const envelope = parseEnvelopeRows(input);
  const data = envelope.data;
  for (const row of data.reviewSessions) {
    validateJsonColumn(row.plan_json, "plan_json", actionPlanSchema);
    if (row.intent_json !== null) validateJsonColumn(row.intent_json, "intent_json");
  }
  for (const row of data.reviewStateSnapshots) validateReviewStateJsonColumn(row.state_json, "state_json", validateAdapterLifecycle);
  for (const row of data.reviewRequests) {
    validateReviewStateJsonColumn(row.review_state_json, "review_state_json", validateAdapterLifecycle);
    if (row.observation_json !== null) validateJsonColumn(row.observation_json, "observation_json", receiptObservationSchema);
  }
  for (const row of data.reviewExecutions) {
    const execution = validateJsonColumn(row.result_json, "result_json", transactionExecutionSummarySchema);
    // Older writers sampled the wall clock twice. Export the time of the committed transition.
    if (execution.recordedAt !== row.recorded_at) {
      row.result_json = JSON.stringify({ ...execution, recordedAt: row.recorded_at });
    }
  }
  for (const row of data.externalActivityScans) {
    if (row.continuity_json !== null) {
      const proof = validateJsonColumn(row.continuity_json, "continuity_json", scanContinuitySchema);
      if (!proof.sourceLower && row.kind !== "digest_lookup" && row.window_complete === 1) row.window_complete = 0;
    }
  }
  const accounts = new Map(data.accounts.map(row => [row.id, row.address]));
  for (const row of data.externalActivityTransactions) validateAccountDetail(row, accounts);
  validateSettings(data);
  return envelope;
}

function validatePayloadSemantics(
  data: LocalDataPayload,
  validateAdapterLifecycle: AdapterLifecycleValidator
): void {
  ensureUnique(data.accounts.map((row) => row.id), "duplicate_account_id");
  ensureUnique(data.accounts.map((row) => `${row.chain_id}:${row.address}`), "duplicate_account_address");
  ensureUnique(data.reviewSessions.map((row) => row.id), "duplicate_review_session_id");
  ensureUnique(data.reviewStateSnapshots.map((row) => row.id), "duplicate_review_state_snapshot_id");
  ensureUnique(data.reviewStatusTransitions.map((row) => row.id), "duplicate_review_transition_id");
  ensureUnique(data.reviewExecutions.map((row) => row.attempt_id), "duplicate_review_execution_id");
  ensureUnique(data.externalActivityScans.map((row) => row.scan_id), "duplicate_external_activity_scan_id");
  ensureUnique(
    data.externalActivityTransactions.map((row) => `${row.account_id}:${row.digest}`),
    "duplicate_external_activity_transaction"
  );
  ensureUnique(data.localSettings.map((row) => row.key), "duplicate_local_setting_key");
  ensureUnique(data.reviewRequests.map((row) => row.attempt_id), "duplicate_review_request_id");
  ensureUnique(data.reviewRequests.map((row) => `${row.review_session_id}:${row.review_revision}`), "duplicate_review_request_revision");
  const suiAccountIds = new Set(data.accounts.filter((row) => row.chain_id === SUI_MAINNET_WALLET_CHAIN).map((row) => row.id));
  const accountAddressesById = new Map(data.accounts.map((row) => [row.id, row.address]));
  for (const row of data.reviewSessions) {
    const plan = validateJsonColumn(row.plan_json, "plan_json", actionPlanSchema);
    const intent = row.intent_json === null ? undefined : validateJsonColumn(row.intent_json, "intent_json");
    if (plan.id !== row.plan_id || plan.actionKind !== row.action_kind || plan.adapterId !== row.adapter_id ||
        plan.protocol !== row.protocol || !isDeepStrictEqual(extractRequestedIntent(plan as Parameters<typeof extractRequestedIntent>[0]), intent)) throw invalidBackup("invalid_review_plan_identity");
    if (row.account_id !== null && !suiAccountIds.has(row.account_id)) {
      throw invalidBackup("invalid_review_session_account");
    }
  }
  const sessionsById = new Map(data.reviewSessions.map((row) => [row.id, row]));
  const reviewSessionIds = new Set(sessionsById.keys());
  const approvedSnapshots = new Map<string, ReviewState>();
  for (const row of data.reviewStateSnapshots) {
    if (!reviewSessionIds.has(row.review_session_id) || !suiAccountIds.has(row.account_id)) {
      throw invalidBackup("invalid_review_state_snapshot_reference");
    }
    if (row.status === "blocked" && (row.blocked_reason === null || row.refresh_reason !== null)) {
      throw invalidBackup("invalid_review_state_snapshot_status");
    }
    if (row.status === "refresh_required" && (row.refresh_reason === null || row.blocked_reason !== null)) {
      throw invalidBackup("invalid_review_state_snapshot_status");
    }
    if (row.status === "ready_for_wallet_review" && (row.blocked_reason !== null || row.refresh_reason !== null)) {
      throw invalidBackup("invalid_review_state_snapshot_status");
    }
    const state = validateReviewStateJsonColumn(row.state_json, "state_json", validateAdapterLifecycle);
    const key = row.review_session_id + ":" + row.review_revision;
    if (state.status === "ready_for_wallet_review") {
      if (approvedSnapshots.has(key)) throw invalidBackup("ambiguous_ready_snapshot");
      approvedSnapshots.set(key, state);
    }
    const session = sessionsById.get(row.review_session_id)!;
    if (state.reviewSessionId !== row.review_session_id || state.account !== accountAddressesById.get(row.account_id) ||
        session.account_id !== row.account_id || session.plan_id !== row.plan_id || state.planId !== row.plan_id ||
        state.status !== row.status || (state.blockedReason ?? null) !== row.blocked_reason ||
        (state.refreshReason ?? null) !== row.refresh_reason || state.updatedAt !== row.updated_at) throw invalidBackup("invalid_review_snapshot_identity");
  }
  const requestsById = new Map(data.reviewRequests.map((row) => [row.attempt_id, row]));
  const latestBySession = new Map<string, LocalDataPayload["reviewRequests"][number]>();
  const executionsById = new Map(data.reviewExecutions.map((row) => [row.attempt_id, row]));
  const resultsById = new Map(data.reviewExecutions.map(row => [
    row.attempt_id, validateJsonColumn(row.result_json, "result_json", transactionExecutionSummarySchema)
  ]));
  for (const row of data.reviewRequests) {
    const session = sessionsById.get(row.review_session_id), account = accountAddressesById.get(row.account_id);
    if (!session || !account || session.account_id !== row.account_id || session.plan_id !== row.plan_id) throw invalidBackup("invalid_review_request_reference");
    const previous = latestBySession.get(row.review_session_id);
    if (!previous || previous.review_revision < row.review_revision) latestBySession.set(row.review_session_id, row);
    const state = validateReviewStateJsonColumn(row.review_state_json, "review_requests.review_state_json", validateAdapterLifecycle);
    if (state.reviewSessionId !== row.review_session_id || state.planId !== row.plan_id || state.account !== account ||
        state.transactionReviewData?.reviewedTransactionDigest !== row.transaction_digest) throw invalidBackup("invalid_review_request_evidence");
    const snapshot = approvedSnapshots.get(row.review_session_id + ":" + row.review_revision);
    if (!snapshot || snapshot.status !== "ready_for_wallet_review" || !isDeepStrictEqual(snapshot, state)) throw invalidBackup("invalid_admitted_review_snapshot");
    const admissionTime = Date.parse(row.created_at);
    const expiry = state.transactionReviewData?.expiry;
    const reviewedUntil = state.humanReadableReview?.freshness.expiresAt;
    if (admissionTime < Date.parse(state.updatedAt) || expiry?.status === "expired" ||
        (expiry?.status === "current" && admissionTime >= Date.parse(expiry.expiresAt)) ||
        (reviewedUntil !== undefined && admissionTime >= Date.parse(reviewedUntil))) {
      throw invalidBackup("invalid_review_admission_time");
    }
    const result = resultsById.get(row.attempt_id);
    const parsed = transactionRequestSchema.safeParse({ attemptId: row.attempt_id, reviewSessionId: row.review_session_id,
      planId: row.plan_id, reviewRevision: row.review_revision, account, transactionDigest: row.transaction_digest,
      ...(row.observation_json === null ? {} : { lastObservation: validateJsonColumn(row.observation_json, "observation_json", receiptObservationSchema) }),
      requestStatus: row.request_status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.reason === null ? {} : { reason: row.reason }), ...(row.signature_verified_at === null ? {} : { signatureVerifiedAt: row.signature_verified_at }),
      ...(row.submission_admitted_at === null ? {} : { submissionAdmittedAt: row.submission_admitted_at }), ...(result ? { execution: result } : {}) });
    if (!parsed.success) throw invalidBackup("invalid_review_request_state");
    if (row.updated_at < row.created_at || (row.signature_verified_at !== null && row.signature_verified_at < row.created_at) ||
        (row.submission_admitted_at !== null && (row.signature_verified_at === null || row.submission_admitted_at < row.signature_verified_at))) throw invalidBackup("invalid_review_request_time");
  }
  for (const row of data.reviewSessions) {
    const latest = latestBySession.get(row.id);
    if ((latest?.attempt_id ?? null) !== row.current_attempt_id) throw invalidBackup("invalid_current_request_reference");
    if (row.current_attempt_id !== null) {
      const request = requestsById.get(row.current_attempt_id);
      if (!request || request.review_session_id !== row.id || request.account_id !== row.account_id) throw invalidBackup("invalid_current_request_reference");
    }
    if (row.opened_at !== null && row.opened_at < row.created_at) throw invalidBackup("invalid_review_open_time");
  }
  for (const row of data.reviewStatusTransitions) {
    if (!reviewSessionIds.has(row.review_session_id) || (row.account_id !== null && !suiAccountIds.has(row.account_id))) throw invalidBackup("invalid_review_transition_reference");
    const requestEvent = ["request_admitted", "request_status_changed", "signature_verified", "chain_result_recorded"].includes(row.event);
    if ((row.domain === "request") !== requestEvent) throw invalidBackup("invalid_review_transition_domain");
    if (row.domain === "request") {
      const request = row.attempt_id ? requestsById.get(row.attempt_id) : undefined;
      if (!request || request.review_session_id !== row.review_session_id || request.account_id !== row.account_id) throw invalidBackup("invalid_review_transition_attempt");
    } else if (row.attempt_id !== null || (row.account_id !== null && sessionsById.get(row.review_session_id)?.account_id !== row.account_id)) {
      throw invalidBackup("invalid_review_transition_attempt");
    }
  }
  for (const row of data.reviewExecutions) {
    const request = requestsById.get(row.attempt_id);
    if (!request || request.review_session_id !== row.review_session_id || request.plan_id !== row.plan_id || request.account_id !== row.account_id ||
        request.transaction_digest !== row.tx_digest) throw invalidBackup("invalid_review_execution_reference");
    const result = resultsById.get(row.attempt_id)!;
    if (result.recordedAt !== row.recorded_at) {
      // Earlier writers built the JSON after sampling the transition time. Accept
      // a later sample only as redundant display data. The row is checked against
      // its terminal transition below before the validated envelope can be used.
      if (Date.parse(result.recordedAt) < Date.parse(row.recorded_at)) throw invalidBackup("invalid_execution_recording_time");
      row.result_json = JSON.stringify({ ...result, recordedAt: row.recorded_at });
    }
    if (result.chainReceipt.source.chainIdentifier !== SUI_MAINNET_CHAIN_IDENTIFIER) throw invalidBackup("invalid_receipt_chain");
    if (result.status !== row.status || result.txDigest !== row.tx_digest || result.failureReason !== (row.failure_reason ?? undefined) ||
        result.chainReceipt.sender !== accountAddressesById.get(row.account_id)) throw invalidBackup("invalid_review_execution_status");
  }
  validateReviewHistory(data, requestsById, executionsById);
  validateScanLinks(data);
  const scanOwners = new Map(data.externalActivityScans.map((row) => [row.scan_id, row.account_id]));
  const txKeys = new Set(data.externalActivityTransactions.map((row) => `${row.account_id}:${row.digest}`));
  ensureUnique(data.externalActivityObservations.map((o) => `${o.scan_id}:${o.digest}`), "duplicate_activity_observation");
  for (const o of data.externalActivityObservations) {
    if (scanOwners.get(o.scan_id) !== o.account_id || !txKeys.has(`${o.account_id}:${o.digest}`)) throw invalidBackup("invalid_activity_observation");
  }
  for (const row of data.externalActivityScans) {
    if (row.outside_filter_count + row.unconfirmed_relation_count > row.skipped_count) throw invalidBackup("invalid_scan_skipped_counts");
    if (row.chain_identifier !== SUI_MAINNET_CHAIN_IDENTIFIER) throw invalidBackup("invalid_scan_chain");
    if (!suiAccountIds.has(row.account_id)) {
      throw invalidBackup("invalid_external_activity_scan_account");
    }
    if ((row.from_timestamp !== null && row.to_timestamp !== null && row.from_timestamp > row.to_timestamp) ||
        (row.from_checkpoint !== null && row.to_checkpoint !== null && BigInt(row.from_checkpoint) > BigInt(row.to_checkpoint))) {
      throw invalidBackup("invalid_external_activity_scan_window");
    }
    if (row.window_complete !== null && row.window_complete !== 0 && row.window_complete !== 1) {
      throw invalidBackup("invalid_external_activity_scan_window_complete");
    }
  }
  for (const row of data.externalActivityTransactions) {
    if (!suiAccountIds.has(row.account_id) || scanOwners.get(row.first_scan_id) !== row.account_id || scanOwners.get(row.last_scan_id) !== row.account_id) {
      throw invalidBackup("invalid_external_activity_transaction_reference");
    }
    if ((row.metadata_conflicts & 1 && row.checkpoint !== null) || (row.metadata_conflicts & 2 && row.timestamp !== null) ||
        (row.metadata_conflicts & 4 && row.known_sender_account_id !== null)) throw invalidBackup("inconsistent_activity_metadata");
    if (row.status_conflict && row.status !== "unknown") throw invalidBackup("inconsistent_activity_status");
    if (row.known_sender_account_id !== null && !suiAccountIds.has(row.known_sender_account_id)) {
      throw invalidBackup("invalid_external_activity_sender_reference");
    }
    validateAccountDetail(row, accountAddressesById);
  }
  validateSettings(data);
}

// Compare independently stored public facts in SQLite insertion order. Two
// status changes can share a clock tick; backup array order is not authority.
function validateReviewHistory(
  data: LocalDataPayload,
  requests: ReadonlyMap<string, ReviewRequestExportRow>,
  executions: ReadonlyMap<string, ReviewExecutionExportRow>
) {
  const transitions = data.reviewStatusTransitions.toSorted((a, b) => a.id - b.id);
  const bySession = Map.groupBy(transitions, row => row.review_session_id);
  const byAttempt = Map.groupBy(transitions.filter(row => row.domain === "request"), row => row.attempt_id!);
  const snapshots = Map.groupBy(data.reviewStateSnapshots.toSorted((a, b) => a.id - b.id), row => row.review_session_id);

  for (const session of data.reviewSessions) {
    const events = bySession.get(session.id) ?? [];
    const states = snapshots.get(session.id) ?? [];
    let status: InternalSessionStatus | null = null;
    let openedAt: string | null = null;
    let updatedAt = session.created_at;
    let snapshotCount = 0;
    let admittedRevision: number | undefined;
    let boundAccountId: number | null = null;
    let currentSnapshot: ReviewStateSnapshotExportRow | undefined;
    for (const event of events) {
      if (event.domain === "request") {
        if (event.event === "request_admitted") {
          admittedRevision = requests.get(event.attempt_id!)!.review_revision;
          if (status !== "ready_for_wallet_review" || !currentSnapshot || currentSnapshot.review_revision !== admittedRevision ||
              event.transitioned_at < currentSnapshot.recorded_at) {
            throw invalidBackup("invalid_admitted_review_history");
          }
        }
        updatedAt = event.transitioned_at;
        continue;
      }
      if (event.from_status !== status) throw invalidBackup("invalid_review_transition_sequence");
      const next = internalSessionStatusSchema.safeParse(event.to_status);
      if (!next.success) throw invalidBackup("invalid_review_transition_state");
      switch (event.event) {
        case "created":
          if (status !== null || event.to_status !== "proposed" || event.account_id !== null || event.transitioned_at !== session.created_at) {
            throw invalidBackup("invalid_review_creation");
          }
          break;
        case "opened":
          if (!status || openedAt !== null || (event.to_status !== status &&
              !(status === "proposed" && event.to_status === "awaiting_wallet"))) throw invalidBackup("invalid_review_open_time");
          openedAt = event.transitioned_at;
          break;
        case "wallet_connected":
          if (!status || event.account_id === null || event.to_status !== reviewStatusAfterBinding(status)) {
            throw invalidBackup("invalid_wallet_connection_transition");
          }
          break;
        case "state_computed": {
          const state = states[snapshotCount++];
          if (!state || !status || !canTransitionReview(status, next.data) || state.review_revision === admittedRevision ||
              state.status !== event.to_status || state.recorded_at !== event.transitioned_at || state.account_id !== event.account_id ||
              (state.blocked_reason ?? state.refresh_reason) !== event.reason) throw invalidBackup("invalid_snapshot_transition");
          const previousRevision = currentSnapshot?.review_revision ?? 0;
          const sameRevisionInvalidation = currentSnapshot && state.review_revision === previousRevision &&
            (status === "ready_for_wallet_review" ? state.status === "refresh_required" && state.refresh_reason === "review_evidence_stale"
              : state.status === status);
          if (state.review_revision !== previousRevision + 1 && !sameRevisionInvalidation) {
            throw invalidBackup("invalid_review_snapshot_revision");
          }
          currentSnapshot = state;
          break;
        }
        case "expired":
          if (!status || status === "expired" || event.to_status !== "expired") throw invalidBackup("invalid_review_expiry");
          break;
        case "review_invalidated":
        case "review_update_failed":
          if (!status || event.to_status !== interruptedReviewStatus(status, currentSnapshot !== undefined)) {
            throw invalidBackup("invalid_review_transition_sequence");
          }
          break;
        default: throw invalidBackup("invalid_review_transition_domain");
      }
      status = next.data;
      if (event.account_id !== null) boundAccountId = event.account_id;
      // Opening records the first authenticated observation without changing
      // the computation time in the session header.
      if (event.event !== "opened" || event.from_status !== event.to_status) updatedAt = event.transitioned_at;
    }
    // The explicit activity transition writer also updates the header on an
    // opening; the authenticated card observation only sets opened_at.
    const last = events.at(-1);
    const matchesUpdate = updatedAt === session.updated_at || (last?.event === "opened" && openedAt === session.updated_at);
    if (status !== session.current_status || boundAccountId !== session.account_id || snapshotCount !== states.length ||
        openedAt !== session.opened_at || !matchesUpdate) throw invalidBackup("invalid_review_history");
  }
  for (const request of requests.values()) {
    validateRequestHistory(request, byAttempt.get(request.attempt_id) ?? [], executions.get(request.attempt_id));
  }
}

function validateRequestHistory(request: ReviewRequestExportRow, events: ReviewStatusTransitionExportRow[], execution?: ReviewExecutionExportRow) {
  let status: TransactionRequestStatus | null = null;
  let verifiedAt: string | null = null;
  let submittedAt: string | null = null;
  let previousTime = Date.parse(request.created_at);
  for (const event of events) {
    if (event.from_status !== status) throw invalidBackup("invalid_request_transition_sequence");
    const parsed = transactionRequestStatusSchema.safeParse(event.to_status);
    if (!parsed.success) throw invalidBackup("invalid_review_transition_state");
    const next = parsed.data;
    const eventTime = Date.parse(event.transitioned_at);
    if (eventTime < previousTime) throw invalidBackup("invalid_review_request_time");
    previousTime = eventTime;
    if (status === null) {
      if (event.event !== "request_admitted" || next !== "awaiting_signature" ||
          event.transitioned_at !== request.created_at) throw invalidBackup("invalid_request_admission");
    } else if (event.event === "signature_verified") {
      if (status !== "awaiting_signature" || next !== status || verifiedAt !== null) throw invalidBackup("invalid_signature_transition");
      verifiedAt = event.transitioned_at;
    } else {
      if (!canTransitionRequest(status, next) ||
          event.event !== (next === "completed" ? "chain_result_recorded" : "request_status_changed")) {
        throw invalidBackup("invalid_request_transition_sequence");
      }
      if (next === "submitting") {
        if (verifiedAt === null) throw invalidBackup("invalid_submission_transition");
        submittedAt = event.transitioned_at;
      }
      if (next === "completed" && (execution?.recorded_at !== event.transitioned_at || execution.updated_at !== event.transitioned_at)) {
        throw invalidBackup("invalid_execution_transition");
      }
    }
    status = next;
  }
  const last = events.at(-1);
  if (status !== request.request_status || events.length !== request.revision + 1 || last?.transitioned_at !== request.updated_at ||
      last.reason !== request.reason || verifiedAt !== request.signature_verified_at || submittedAt !== request.submission_admitted_at) {
    throw invalidBackup("invalid_request_history");
  }
}

function validateAccountDetail(row: ExternalActivityTransactionExportRow, accountAddressesById: Map<number, string>) {
    if (row.detail_json !== null) {
      if (externalActivityTransactionDetailJsonByteLength(row.detail_json) > EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES) {
        throw invalidBackup("external_activity_detail_too_large", {
          maxBytes: EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES
        });
      }
      const detail = validateJsonColumn(row.detail_json, "external_activity_transactions.detail_json");
      const parsedDetail = externalActivityTransactionDetailSchema.validate(detail);
      if (!parsedDetail) {
        throw invalidBackup("invalid_external_activity_detail_json");
      }
      const account = accountAddressesById.get(row.account_id);
      if (account === undefined || !externalActivityTransactionDetailsReferenceOnlyAccount(detail, account)) {
        throw invalidBackup("invalid_external_activity_detail_json");
      }
    }
}

function validateSettings(data: LocalDataPayload) {
  const localSettingKeys = new Set(data.localSettings.map((row) => row.key));
  if (!localSettingKeys.has("suiGrpcUrl")) {
    throw invalidBackup("missing_sui_grpc_url");
  }
  for (const row of data.localSettings) {
    const value = validateJsonColumn(row.value_json, "local_settings.value_json");
    if (row.key === "walletConnectionChains") {
      if (!walletChainsSchema.safeParse(value).success) throw invalidBackup("invalid_wallet_connection_chains");
      continue;
    }
    if (typeof value !== "string") {
      throw invalidBackup(row.key === "suiGrpcUrl" ? "invalid_sui_grpc_url" : "invalid_sui_graphql_url");
    }
    try {
      if (row.key === "suiGrpcUrl") {
        parseGrpcUrl(value);
      } else {
        parseGraphqlUrl(value);
      }
    } catch {
      throw invalidBackup(row.key === "suiGrpcUrl" ? "invalid_sui_grpc_url" : "invalid_sui_graphql_url");
    }
  }
}

function validateScanLinks(data: LocalDataPayload): void {
  const scans = new Map(data.externalActivityScans.map((s) => [s.scan_id, s]));
  const proofs = new Map(data.externalActivityScans.filter((s) => s.continuity_json !== null).map((s) =>
    [s.scan_id, validateJsonColumn(s.continuity_json!, "continuity_json", scanContinuitySchema)]));
  for (const [id, proof] of proofs) {
    const scan = scans.get(id)!;
    const root = scans.get(proof.rootScanId);
    if (!root || root.request_cursor !== null || !scan.source_upper_checkpoint || !scan.source_upper_timestamp ||
        !validScanPageBounds(proof, scan.source_upper_checkpoint, scan.source_upper_timestamp)) throw invalidBackup("invalid_scan_bounds");
    if (!proof.predecessorScanId) {
      if (id !== proof.rootScanId || scan.request_cursor !== null) throw invalidBackup("invalid_scan_start");
    } else {
      const previous = scans.get(proof.predecessorScanId), prevProof = proofs.get(proof.predecessorScanId);
      if (!previous || !prevProof || prevProof.rootScanId !== proof.rootScanId || !previous.has_more || !scan.request_cursor ||
          previous.response_cursor !== scan.request_cursor || !scanPageFollows(prevProof, proof) ||
          (["account_id","kind","relationship","function_target","source_upper_checkpoint","source_upper_timestamp","from_timestamp",
            "to_timestamp","from_checkpoint","to_checkpoint","chain_identifier","endpoint_host"] as const).some((k) => previous[k] !== scan[k])) throw invalidBackup("invalid_scan_continuation");
    }
    if (scan.window_complete === 1 && scan.request_cursor && !proof.predecessorScanId) throw invalidBackup("invalid_scan_completion");
  }
  const visited = new Set<string>();
  for (const id of proofs.keys()) {
    const chain = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      if (chain.has(current)) throw invalidBackup("cyclic_scan_continuation");
      chain.add(current); current = proofs.get(current)?.predecessorScanId;
    }
    for (const item of chain) visited.add(item);
  }
  const discovered = new Set<string>(), perScan = new Map<string, number>();
  const observedTimes = new Map<string, { first: string; last: string }>();
  for (const o of data.externalActivityObservations) {
    const scan = scans.get(o.scan_id);
    if (scan?.kind === "digest_lookup" && scan.input_digest !== o.digest) throw invalidBackup("digest_lookup_observation_mismatch");
    if (!scan || scan.account_id !== o.account_id) throw invalidBackup("invalid_activity_observation");
    const key = o.account_id + ":" + o.digest;
    const times = observedTimes.get(key) ?? { first: scan.fetched_at, last: scan.fetched_at };
    if (scan.fetched_at < times.first) times.first = scan.fetched_at;
    if (scan.fetched_at > times.last) times.last = scan.fetched_at;
    observedTimes.set(key, times);
    discovered.add(o.scan_id + ":" + o.digest);
    perScan.set(o.scan_id, (perScan.get(o.scan_id) ?? 0) + 1);
  }
  for (const scan of data.externalActivityScans) {
    if ((perScan.get(scan.scan_id) ?? 0) !== scan.stored_count) throw invalidBackup("scan_observation_count_mismatch");
    if (scan.kind !== "digest_lookup" && scan.window_complete === 1) {
      const proof = proofs.get(scan.scan_id);
      if (!proof) throw invalidBackup("missing_scan_continuity");
      if (scan.request_cursor && !proof.predecessorScanId) throw invalidBackup("missing_scan_continuation");
      if (scan.to_timestamp && (!scan.source_upper_timestamp || scan.source_upper_timestamp < scan.to_timestamp)) throw invalidBackup("invalid_scan_upper_bound");
      if (scan.incomplete_reason) throw invalidBackup("invalid_scan_completion");
      if (proof.sourceLower) {
        if (!windowCompletion({ scanId: scan.scan_id, requestCursor: scan.request_cursor ?? undefined, continuity: proof,
            hasMore: !!scan.has_more, sourceUpperCheckpoint: scan.source_upper_checkpoint ?? undefined,
            sourceUpperTimestamp: scan.source_upper_timestamp ?? undefined, fromCheckpoint: scan.from_checkpoint ?? undefined,
            toCheckpoint: scan.to_checkpoint ?? undefined, fromTimestamp: scan.from_timestamp ?? undefined,
            toTimestamp: scan.to_timestamp ?? undefined })) throw invalidBackup("invalid_scan_completion");
      } else {
        // Earlier candidates did not record the transaction index's retention floor.
        // Preserve their observations without restoring an unsupported completion.
        if (!scanReachedLowerBound({ hasMore: !!scan.has_more, continuity: proof,
            fromCheckpoint: scan.from_checkpoint ?? undefined, fromTimestamp: scan.from_timestamp ?? undefined })) {
          throw invalidBackup("invalid_scan_completion");
        }
        scan.window_complete = 0;
      }
    }
    if (scan.kind === "function_scan" && (!scan.function_target || parseSuiFunctionTarget(scan.function_target).target !== scan.function_target)) throw invalidBackup("invalid_scan_function");
  }
  for (const tx of data.externalActivityTransactions) {
    const times = observedTimes.get(tx.account_id + ":" + tx.digest);
    if (times?.first !== tx.first_fetched_at || times.last !== tx.last_fetched_at ||
        scans.get(tx.first_scan_id)?.fetched_at !== times.first || scans.get(tx.last_scan_id)?.fetched_at !== times.last) {
      throw invalidBackup("invalid_activity_observation_chronology");
    }
    if (!discovered.has(tx.first_scan_id + ":" + tx.digest) || !discovered.has(tx.last_scan_id + ":" + tx.digest)) throw invalidBackup("missing_activity_observation");
  }
}

function validateReviewStateJsonColumn(
  value: string,
  field: string,
  validateAdapterLifecycle: AdapterLifecycleValidator
): ReviewState {
  const parsed = validateJsonColumn(value, field);
  try {
    return parseLifecycleValidatedReviewState(parsed, validateAdapterLifecycle, true);
  } catch {
    throw invalidBackup("invalid_json_shape", { field });
  }
}

export function suiGrpcUrlFromPayload(data: LocalDataPayload): string {
  const row = data.localSettings.find((setting) => setting.key === "suiGrpcUrl");
  if (!row) {
    throw invalidBackup("missing_sui_grpc_url");
  }
  const value = validateJsonColumn(row.value_json, "local_settings.value_json");
  if (typeof value !== "string") {
    throw invalidBackup("invalid_sui_grpc_url");
  }
  try {
    return parseGrpcUrl(value);
  } catch {
    throw invalidBackup("invalid_sui_grpc_url");
  }
}

export function suiGraphqlUrlFromPayload(data: LocalDataPayload): string {
  const row = data.localSettings.find((setting) => setting.key === "suiGraphqlUrl");
  if (!row) {
    throw invalidBackup("missing_sui_graphql_url");
  }
  const value = validateJsonColumn(row.value_json, "local_settings.value_json");
  if (typeof value !== "string") {
    throw invalidBackup("invalid_sui_graphql_url");
  }
  try {
    return parseGraphqlUrl(value);
  } catch {
    throw invalidBackup("invalid_sui_graphql_url");
  }
}

function ensureUnique<T>(values: T[], reason: string): void {
  if (new Set(values).size !== values.length) {
    throw invalidBackup(reason);
  }
}

function validateJsonColumn<T>(value: string, field: string, schema: EvidenceSchema<T>): T;
function validateJsonColumn(value: string, field: string): unknown;
function validateJsonColumn<T>(value: string, field: string, schema?: EvidenceSchema<T>): T | unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidBackup("malformed_json", { field });
  }
  try {
    assertNoForbiddenMcpFields(parsed);
  } catch {
    throw invalidBackup("forbidden_field", { field });
  }
  if (schema) {
    if (!schema.validate(parsed)) {
      throw invalidBackup("invalid_json_shape", { field });
    }
    return parsed;
  }
  return parsed;
}

type EvidenceSchema<T> = ZodType<T>;

export function invalidBackup(reason: string, details: Record<string, unknown> = {}): LocalDataError {
  return new LocalDataError("input_invalid", "Invalid local data backup", { reason, ...details });
}

export function countsForPayload(data: LocalDataPayload): LocalDataCounts {
  return {
    accounts: data.accounts.length,
    reviewSessions: data.reviewSessions.length,
    reviewStateSnapshots: data.reviewStateSnapshots.length,
    reviewStatusTransitions: data.reviewStatusTransitions.length,
    reviewExecutions: data.reviewExecutions.length,
    reviewRequests: data.reviewRequests.length,
    outcomeUnknownRequests: data.reviewRequests.filter((row) => row.request_status === "outcome_unknown").length,
    externalActivityScans: data.externalActivityScans.length,
    externalActivityTransactions: data.externalActivityTransactions.length,
    externalActivityObservations: data.externalActivityObservations.length,
    localSettings: data.localSettings.length
  };
}

export function maxNumber(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), 0);
}
