import { transactionRequestStatusSchema, transactionRequestSchema } from "../session/transactionRequest.js";
import { REVIEW_TRANSITION_EVENTS } from "./sqliteActivityStoreRows.js";
import { z, type ZodType } from "zod";
import type { AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { parseLifecycleValidatedReviewState } from "../action/reviewStateValidation.js";
import { actionPlanSchema, transactionExecutionSummarySchema, internalSessionStatusSchema } from "../action/schemas.js";
import type { ReviewState } from "../action/types.js";
import { parseSuiAddress } from "../suiAddress.js";
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
  type ActiveAccountContextExportRow,
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
  sui_address: z.string().refine((value) => parseSuiAddress(value) === value, "must be a normalized Sui address"),
  first_seen_at: isoTimestamp,
  last_used_at: isoTimestamp,
  first_source: z.enum(["wallet_connection", "review_execution"]),
  last_source: z.enum(["wallet_connection", "review_execution"])
}).strict();

const activeAccountContextRowSchema: z.ZodType<ActiveAccountContextExportRow> = z.object({
  id: z.literal(1),
  account_id: z.number().int().positive().nullable(),
  source: z.enum(["wallet_connection", "cleared"]),
  set_at: isoTimestamp,
  wallet_name: z.string().min(1).max(200).nullish(),
  wallet_id: z.string().min(1).max(200).nullish()
}).strict();

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
  signature_verified_at: isoTimestamp.nullable(), submitted_at: isoTimestamp.nullable()
}).strict();

const externalActivityScanRowSchema: z.ZodType<ExternalActivityScanExportRow> = z.object({
  scan_id: z.string().min(1),
  kind: z.enum(["digest_lookup", "account_scan", "function_scan"]),
  account_id: z.number().int().positive(),
  relationship: z.enum(["affected", "sent"]),
  input_digest: nullableString,
  from_checkpoint: nullableString,
  to_checkpoint: nullableString,
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
  status: z.enum(["success", "failure", "unknown"]),
  known_sender_account_id: z.number().int().positive().nullable(),
  first_scan_id: z.string().min(1),
  last_scan_id: z.string().min(1),
  first_fetched_at: isoTimestamp,
  last_fetched_at: isoTimestamp,
  detail_json: z.string().nullable()
}).strict();

const localSettingRowSchema: z.ZodType<LocalSettingExportRow> = z.object({
  key: z.enum(["suiGrpcUrl", "suiGraphqlUrl"]),
  value_json: z.string(),
  updated_at: isoTimestamp
}).strict();

const payloadSchema: z.ZodType<LocalDataPayload> = z.object({
  accounts: z.array(accountRowSchema),
  activeAccountContext: z.array(activeAccountContextRowSchema).max(1),
  reviewSessions: z.array(reviewSessionRowSchema),
  reviewStateSnapshots: z.array(reviewStateSnapshotRowSchema),
  reviewStatusTransitions: z.array(reviewStatusTransitionRowSchema),
  reviewExecutions: z.array(reviewExecutionRowSchema),
  reviewRequests: z.array(reviewRequestRowSchema),
  externalActivityScans: z.array(externalActivityScanRowSchema),
  externalActivityTransactions: z.array(externalActivityTransactionRowSchema),
  localSettings: z.array(localSettingRowSchema).length(2)
}).strict();

const envelopeSchema: z.ZodType<LocalDataEnvelope> = z.object({
  format: z.literal(LOCAL_DATA_EXPORT_FORMAT),
  network: z.literal(LOCAL_DATA_NETWORK),
  exportedAt: isoTimestamp,
  data: payloadSchema
}).strict();

export function parseLocalDataEnvelope(
  input: unknown,
  options: { validateAdapterLifecycle: AdapterLifecycleValidator }
): LocalDataEnvelope {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new LocalDataError("input_invalid", "Invalid local data backup", {
      reason: "invalid_backup_shape"
    });
  }
  validatePayloadSemantics(parsed.data.data, options.validateAdapterLifecycle);
  return parsed.data;
}

function validatePayloadSemantics(
  data: LocalDataPayload,
  validateAdapterLifecycle: AdapterLifecycleValidator
): void {
  ensureUnique(data.accounts.map((row) => row.id), "duplicate_account_id");
  ensureUnique(data.accounts.map((row) => row.sui_address), "duplicate_account_address");
  ensureUnique(data.reviewSessions.map((row) => row.id), "duplicate_review_session_id");
  ensureUnique(data.reviewStateSnapshots.map((row) => row.id), "duplicate_review_state_snapshot_id");
  ensureUnique(data.reviewStatusTransitions.map((row) => row.id), "duplicate_review_transition_id");
  ensureUnique(data.reviewExecutions.map((row) => row.attempt_id), "duplicate_review_execution_id");
  ensureUnique(data.externalActivityScans.map((row) => row.scan_id), "duplicate_external_activity_scan_id");
  ensureUnique(
    data.externalActivityTransactions.map((row) => `${row.account_id}:${row.digest}:${row.relationship}`),
    "duplicate_external_activity_transaction"
  );
  ensureUnique(data.localSettings.map((row) => row.key), "duplicate_local_setting_key");
  ensureUnique(data.reviewRequests.map((row) => row.attempt_id), "duplicate_review_request_id");
  ensureUnique(data.reviewRequests.map((row) => `${row.review_session_id}:${row.review_revision}`), "duplicate_review_request_revision");
  const accountIds = new Set(data.accounts.map((row) => row.id));
  const accountAddressesById = new Map(data.accounts.map((row) => [row.id, row.sui_address]));
  for (const row of data.activeAccountContext) {
    if (row.source === "cleared" && row.account_id !== null) {
      throw invalidBackup("invalid_active_account_context");
    }
    if (row.source === "wallet_connection" && (row.account_id === null || !accountIds.has(row.account_id))) {
      throw invalidBackup("invalid_active_account_context");
    }
  }
  for (const row of data.reviewSessions) {
    validateJsonColumn(row.plan_json, "plan_json", actionPlanSchema);
    validateOptionalJsonColumn(row.intent_json, "intent_json");
    if (row.account_id !== null && !accountIds.has(row.account_id)) {
      throw invalidBackup("invalid_review_session_account");
    }
  }
  const reviewSessionIds = new Set(data.reviewSessions.map((row) => row.id));
  for (const row of data.reviewStateSnapshots) {
    if (!reviewSessionIds.has(row.review_session_id) || !accountIds.has(row.account_id)) {
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
    validateReviewStateJsonColumn(row.state_json, "state_json", validateAdapterLifecycle);
  }
  const requestsById = new Map(data.reviewRequests.map((row) => [row.attempt_id, row]));
  const sessionsById = new Map(data.reviewSessions.map((row) => [row.id, row]));
  const executionsById = new Map(data.reviewExecutions.map((row) => [row.attempt_id, row]));
  for (const row of data.reviewRequests) {
    const session = sessionsById.get(row.review_session_id), account = accountAddressesById.get(row.account_id);
    if (!session || !account || session.account_id !== row.account_id || session.plan_id !== row.plan_id) throw invalidBackup("invalid_review_request_reference");
    validateReviewStateJsonColumn(row.review_state_json, "review_requests.review_state_json", validateAdapterLifecycle);
    const state = JSON.parse(row.review_state_json) as ReviewState;
    if (state.reviewSessionId !== row.review_session_id || state.planId !== row.plan_id || state.account !== account ||
        state.transactionReviewData?.reviewedTransactionDigest !== row.transaction_digest) throw invalidBackup("invalid_review_request_evidence");
    const execution = executionsById.get(row.attempt_id);
    const result = execution ? validateJsonColumn(execution.result_json, "result_json", transactionExecutionSummarySchema) : undefined;
    const parsed = transactionRequestSchema.safeParse({ attemptId: row.attempt_id, reviewSessionId: row.review_session_id,
      planId: row.plan_id, reviewRevision: row.review_revision, account, transactionDigest: row.transaction_digest,
      requestStatus: row.request_status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.reason === null ? {} : { reason: row.reason }), ...(row.signature_verified_at === null ? {} : { signatureVerifiedAt: row.signature_verified_at }),
      ...(row.submitted_at === null ? {} : { submittedAt: row.submitted_at }), ...(result ? { execution: result } : {}) });
    if (!parsed.success) throw invalidBackup("invalid_review_request_state");
    if (row.updated_at < row.created_at || (row.signature_verified_at !== null && row.signature_verified_at < row.created_at) ||
        (row.submitted_at !== null && (row.signature_verified_at === null || row.submitted_at < row.signature_verified_at))) throw invalidBackup("invalid_review_request_time");
  }
  for (const row of data.reviewSessions) {
    const attempts = data.reviewRequests.filter((request) => request.review_session_id === row.id);
    const latest = attempts.reduce<(typeof attempts)[number] | undefined>((found, request) =>
      !found || request.review_revision > found.review_revision ? request : found, undefined);
    if ((latest?.attempt_id ?? null) !== row.current_attempt_id) throw invalidBackup("invalid_current_request_reference");
    if (row.current_attempt_id !== null) {
      const request = requestsById.get(row.current_attempt_id);
      if (!request || request.review_session_id !== row.id || request.account_id !== row.account_id) throw invalidBackup("invalid_current_request_reference");
    }
    if (row.opened_at !== null && row.opened_at < row.created_at) throw invalidBackup("invalid_review_open_time");
  }
  for (const row of data.reviewStatusTransitions) {
    if (!reviewSessionIds.has(row.review_session_id) || (row.account_id !== null && !accountIds.has(row.account_id))) throw invalidBackup("invalid_review_transition_reference");
    const requestEvent = ["request_admitted", "request_status_changed", "signature_verified", "chain_result_recorded"].includes(row.event);
    if ((row.domain === "request") !== requestEvent) throw invalidBackup("invalid_review_transition_domain");
    const statusSchema = row.domain === "request" ? transactionRequestStatusSchema : internalSessionStatusSchema;
    if (!statusSchema.safeParse(row.to_status).success || (row.from_status !== null && !statusSchema.safeParse(row.from_status).success)) throw invalidBackup("invalid_review_transition_state");
    if (row.domain === "request") {
      const request = row.attempt_id ? requestsById.get(row.attempt_id) : undefined;
      if (!request || request.review_session_id !== row.review_session_id || request.account_id !== row.account_id) throw invalidBackup("invalid_review_transition_attempt");
    } else if (row.attempt_id !== null) throw invalidBackup("invalid_review_transition_attempt");
  }
  for (const row of data.reviewExecutions) {
    const request = requestsById.get(row.attempt_id);
    if (!request || request.review_session_id !== row.review_session_id || request.plan_id !== row.plan_id || request.account_id !== row.account_id ||
        request.transaction_digest !== row.tx_digest) throw invalidBackup("invalid_review_execution_reference");
    const result = transactionExecutionSummarySchema.parse(validateJsonColumn(row.result_json, "result_json", transactionExecutionSummarySchema));
    if (result.status !== row.status || result.txDigest !== row.tx_digest || result.failureReason !== (row.failure_reason ?? undefined) ||
        result.chainReceipt.sender !== accountAddressesById.get(row.account_id)) throw invalidBackup("invalid_review_execution_status");
  }
  const scanIds = new Set(data.externalActivityScans.map((row) => row.scan_id));
  for (const row of data.externalActivityScans) {
    if (!accountIds.has(row.account_id)) {
      throw invalidBackup("invalid_external_activity_scan_account");
    }
    if (row.from_timestamp !== null && row.to_timestamp !== null && row.from_timestamp > row.to_timestamp) {
      throw invalidBackup("invalid_external_activity_scan_window");
    }
    if (row.window_complete !== null && row.window_complete !== 0 && row.window_complete !== 1) {
      throw invalidBackup("invalid_external_activity_scan_window_complete");
    }
  }
  for (const row of data.externalActivityTransactions) {
    if (!accountIds.has(row.account_id) || !scanIds.has(row.first_scan_id) || !scanIds.has(row.last_scan_id)) {
      throw invalidBackup("invalid_external_activity_transaction_reference");
    }
    if (row.known_sender_account_id !== null && !accountIds.has(row.known_sender_account_id)) {
      throw invalidBackup("invalid_external_activity_sender_reference");
    }
    if (row.detail_json !== null) {
      if (externalActivityTransactionDetailJsonByteLength(row.detail_json) > EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES) {
        throw invalidBackup("external_activity_detail_too_large", {
          maxBytes: EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES
        });
      }
      const detail = validateJsonColumn(row.detail_json, "external_activity_transactions.detail_json");
      const parsedDetail = externalActivityTransactionDetailSchema.safeParse(detail);
      if (!parsedDetail.success) {
        throw invalidBackup("invalid_external_activity_detail_json");
      }
      const account = accountAddressesById.get(row.account_id);
      if (account === undefined || !externalActivityTransactionDetailsReferenceOnlyAccount(parsedDetail.data, account)) {
        throw invalidBackup("invalid_external_activity_detail_json");
      }
    }
  }
  const localSettingKeys = new Set(data.localSettings.map((row) => row.key));
  if (!localSettingKeys.has("suiGrpcUrl")) {
    throw invalidBackup("missing_sui_grpc_url");
  }
  for (const row of data.localSettings) {
    const value = validateJsonColumn(row.value_json, "local_settings.value_json");
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

function validateReviewStateJsonColumn(
  value: string,
  field: string,
  validateAdapterLifecycle: AdapterLifecycleValidator
): void {
  const parsed = validateJsonColumn(value, field);
  try {
    parseLifecycleValidatedReviewState(parsed as ReviewState, validateAdapterLifecycle);
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
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw invalidBackup("invalid_json_shape", { field });
    }
    return result.data;
  }
  return parsed;
}

function validateOptionalJsonColumn(value: string | null, field: string): void {
  if (value !== null) {
    validateJsonColumn(value, field);
  }
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
    localSettings: data.localSettings.length
  };
}

export function activeAccountChange(
  currentAccounts: AccountExportRow[],
  current: ActiveAccountContextExportRow[],
  incomingAccounts: AccountExportRow[],
  incoming: ActiveAccountContextExportRow[]
): "unchanged" | "set" | "cleared" {
  const currentAccount = activeAccountAddress(currentAccounts, current);
  const incomingAccount = activeAccountAddress(incomingAccounts, incoming);
  if (currentAccount === incomingAccount) {
    return "unchanged";
  }
  return incomingAccount === null ? "cleared" : "set";
}

export function activeAccountAddress(
  accounts: AccountExportRow[],
  context: ActiveAccountContextExportRow[]
): string | null {
  const accountId = context[0]?.account_id ?? null;
  if (accountId === null) {
    return null;
  }
  return accounts.find((account) => account.id === accountId)?.sui_address ?? null;
}

export function maxNumber(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), 0);
}
