import { REVIEW_PREPARATION_STATUSES } from "../action/types.js";
import { TRANSACTION_REQUEST_STATUSES, type TransactionRequest } from "../session/transactionRequest.js";
import { actionPlanSchema } from "../action/schemas.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import type { ActionPlan, InternalSessionStatus, ReviewState } from "../action/types.js";
import type { CoinMetadataCacheRecord } from "../read/coinMetadata.js";
import {
  ActivityStoreReadError,
  EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT,
  REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT,
  REVIEW_ACTIVITY_LIST_MAX_LIMIT,
  REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD
} from "./activityStore.js";
import type {
  AccountSource,
  ExternalActivityRelationship,
  ExternalActivityScanRecord,
  ExternalActivitySummaryResult,
  ExternalActivityTransactionRecord,
  ExternalActivityTransactionStatus,
  ReviewActivityAccountSource,
  ReviewActivityDataScope,
  ReviewActivityListResult,
  ReviewActivityRow,
  ReviewFunnelSummary,
  ReviewFunnelSummaryResult
} from "./activityStore.js";
import {
  EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES,
  externalActivityTransactionDetailJsonByteLength,
  externalActivityTransactionDetailSchema,
  externalActivityTransactionDetailsReferenceOnlyAccount,
  type ExternalActivityTransactionDetail
} from "./transactionActivityDetails.js";
import { ActivityStoreError, type EvidenceSchema } from "./sqliteActivityStoreTypes.js";

export type ReviewActivityScope = {
  account: string;
  accountId?: number | undefined;
  accountSource: ReviewActivityAccountSource;
};

export type ReviewActivityListRow = {
  review_session_id: string;
  plan_id: string;
  action_kind: string;
  adapter_id: string;
  protocol: string;
  current_status: string;
  current_attempt_id: string | null;
  account: string;
  created_at: string;
  updated_at: string;
  execution_status: string | null;
  tx_digest: string | null;
  snapshot_count: number;
  transition_count: number;
};

export type CountRow = {
  count: number;
};

export type KeyCountRow = {
  key: string;
  count: number;
};





export type ExternalActivityScanRow = {
  scan_id: string;
  kind: string;
  account_id: number;
  account: string;
  relationship: string;
  input_digest: string | null;
  from_checkpoint: string | null;
  to_checkpoint: string | null;
  from_timestamp: string | null;
  to_timestamp: string | null;
  limit_count: number;
  request_cursor: string | null;
  response_cursor: string | null;
  endpoint_host: string;
  chain_identifier: string;
  fetched_at: string;
  stored_count: number;
  skipped_count: number;
  has_more: number;
  window_complete: number | null;
  incomplete_reason: string | null;
};

export type ExternalActivityTransactionRow = {
  account_id: number;
  account: string;
  digest: string;
  relationship: string;
  checkpoint: string | null;
  timestamp: string | null;
  status: string;
  known_sender_account_id: number | null;
  first_scan_id: string;
  last_scan_id: string;
  first_fetched_at: string;
  last_fetched_at: string;
  last_scan_incomplete_reason: string | null;
  detail_json: string | null;
};

export type ReviewStateSnapshotRow = {
  id: number;
  review_revision: number;
  plan_id: string;
  account: string;
  status: string;
  blocked_reason: string | null;
  refresh_reason: string | null;
  state_json: string;
  updated_at: string;
  recorded_at: string;
};

export type ReviewTransitionRow = {
  id: number;
  attempt_id: string | null;
  domain: "review" | "request";
  event: string;
  from_status: string | null;
  to_status: string;
  account: string | null;
  reason: string | null;
  transitioned_at: string;
};

export type CoinMetadataCacheRow = {
  coin_type: string;
  chain_identifier: string;
  decimals: number;
  symbol: string;
  name: string;
  fetched_at: string;
  expires_at: string;
};

export const INTERNAL_SESSION_STATUSES = REVIEW_PREPARATION_STATUSES;

export const REVIEW_STATE_STATUSES = [
  "ready_for_wallet_review",
  "blocked",
  "refresh_required"
] as const;

export const REVIEW_TRANSITION_EVENTS = [
  "created",
  "opened",
  "wallet_connected",
  "state_computed",
  "request_admitted", "request_status_changed", "signature_verified", "chain_result_recorded", "review_update_failed", "review_invalidated",
  "expired"
] as const;

export const EXTERNAL_ACTIVITY_RELATIONSHIPS = ["affected", "sent"] as const;
export const EXTERNAL_ACTIVITY_STATUSES = ["success", "failure", "unknown"] as const satisfies readonly ExternalActivityTransactionStatus[];
const EXTERNAL_ACTIVITY_INCOMPLETE_REASONS = [
  "limit_reached",
  "ordering_unverified",
  "cursor_invalid",
  "provider_error"
] as const;

export function parseIsoTimestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ActivityStoreReadError("input_invalid", `${field} must be an ISO 8601 UTC timestamp`, {
      field
    });
  }
  return value;
}

export function parseOptionalIsoTimestamp(value: string | undefined, field: "from" | "to"): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseIsoTimestamp(value, field);
}

export function assertDateRange(from: string | undefined, to: string | undefined): void {
  if (from && to && from > to) {
    throw new ActivityStoreReadError("input_invalid", "from must be before or equal to to", {
      from,
      to
    });
  }
}

export function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_ACTIVITY_LIST_MAX_LIMIT) {
    throw new ActivityStoreReadError("input_invalid", "limit must be an integer from 1 to 100", {
      limit,
      min: 1,
      max: REVIEW_ACTIVITY_LIST_MAX_LIMIT
    });
  }
  return limit;
}

export function normalizeExternalActivityLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT) {
    throw new ActivityStoreReadError("input_invalid", "limit must be an integer from 1 to 100", {
      limit,
      min: 1,
      max: EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT
    });
  }
  return limit;
}

export function reviewSessionWhere(
  accountId: number,
  from?: string,
  to?: string,
  status?: InternalSessionStatus
): { whereSql: string; params: unknown[] } {
  const conditions = ["rs.account_id = ?"];
  const params: unknown[] = [accountId];
  if (from) {
    conditions.push("rs.created_at >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("rs.created_at <= ?");
    params.push(to);
  }
  if (status) {
    conditions.push("rs.current_status = ?");
    params.push(status);
  }
  return {
    whereSql: `WHERE ${conditions.join(" AND ")}`,
    params
  };
}

export function reviewActivityRowFromStorage(row: ReviewActivityListRow, request?: TransactionRequest): ReviewActivityRow {
  return {
    reviewSessionId: asString(row.review_session_id),
    planId: asString(row.plan_id),
    actionKind: asString(row.action_kind),
    adapterId: asString(row.adapter_id),
    protocol: asString(row.protocol),
    reviewStatus: asInternalSessionStatus(row.current_status),
    account: asString(row.account),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    ...(request ? { currentAttemptId: request.attemptId, requestStatus: request.requestStatus, reviewRevision: request.reviewRevision,
      transactionDigest: request.transactionDigest, ...(request.execution ? { executionStatus: request.execution.status } : {}) } : {}),
    snapshotCount: row.snapshot_count,
    transitionCount: row.transition_count
  };
}

export function reviewActivityListResult(
  scope: ReviewActivityScope,
  from: string | undefined,
  to: string | undefined,
  activities: ReviewActivityRow[],
  truncated: boolean,
  recordCount: number
): ReviewActivityListResult {
  return {
    dataScope: dataScope(scope.account, from, to, recordCount),
    accountSource: scope.accountSource,
    lowSampleWarning: recordCount < REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
    lowSampleThreshold: REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
    truncated: {
      activities: truncated,
      snapshots: false,
      transitions: false
    },
    activities
  };
}

export function reviewFunnelResult(
  scope: ReviewActivityScope,
  from: string | undefined,
  to: string | undefined,
  summary: ReviewFunnelSummary,
  recordCount: number
): ReviewFunnelSummaryResult {
  return {
    dataScope: dataScope(scope.account, from, to, recordCount),
    accountSource: scope.accountSource,
    lowSampleWarning: recordCount < REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
    lowSampleThreshold: REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
    truncated: {
      activities: false,
      snapshots: false,
      transitions: false
    },
    summary
  };
}

function dataScope(
  account: string,
  from: string | undefined,
  to: string | undefined,
  recordCount: number
): ReviewActivityDataScope {
  const scope: ReviewActivityDataScope = {
    account,
    recordCount
  };
  if (from !== undefined) {
    scope.from = from;
  }
  if (to !== undefined) {
    scope.to = to;
  }
  return scope;
}

export function externalActivityScanFromRow(row: ExternalActivityScanRow): ExternalActivityScanRecord {
  return {
    scanId: asString(row.scan_id),
    kind: asExternalActivityScanKind(row.kind),
    accountId: row.account_id,
    account: asString(row.account),
    relationship: asExternalActivityRelationship(row.relationship),
    inputDigest: row.input_digest === null ? undefined : asString(row.input_digest),
    fromCheckpoint: row.from_checkpoint === null ? undefined : asString(row.from_checkpoint),
    toCheckpoint: row.to_checkpoint === null ? undefined : asString(row.to_checkpoint),
    fromTimestamp: row.from_timestamp === null ? undefined : asString(row.from_timestamp),
    toTimestamp: row.to_timestamp === null ? undefined : asString(row.to_timestamp),
    limit: row.limit_count,
    requestCursor: row.request_cursor === null ? undefined : asString(row.request_cursor),
    responseCursor: row.response_cursor === null ? undefined : asString(row.response_cursor),
    endpointHost: asString(row.endpoint_host),
    chainIdentifier: asString(row.chain_identifier),
    fetchedAt: asString(row.fetched_at),
    storedCount: row.stored_count,
    skippedCount: row.skipped_count,
    hasMore: row.has_more === 1,
    windowComplete: row.window_complete === null ? null : row.window_complete === 1,
    incompleteReason: row.incomplete_reason === null
      ? undefined
      : asExternalActivityIncompleteReason(row.incomplete_reason)
  };
}

export function externalActivityTransactionFromRow(row: ExternalActivityTransactionRow): ExternalActivityTransactionRecord {
  return {
    accountId: row.account_id,
    account: asString(row.account),
    digest: asString(row.digest),
    relationship: asExternalActivityRelationship(row.relationship),
    checkpoint: row.checkpoint === null ? undefined : asString(row.checkpoint),
    timestamp: row.timestamp === null ? undefined : asString(row.timestamp),
    status: asExternalActivityStatus(row.status),
    knownSenderAccountId: row.known_sender_account_id === null ? undefined : row.known_sender_account_id,
    firstScanId: asString(row.first_scan_id),
    lastScanId: asString(row.last_scan_id),
    firstFetchedAt: asString(row.first_fetched_at),
    lastFetchedAt: asString(row.last_fetched_at),
    lastScanIncompleteReason: row.last_scan_incomplete_reason === null
      ? undefined
      : asExternalActivityIncompleteReason(row.last_scan_incomplete_reason),
    details: row.detail_json === null
      ? undefined
      : parseEvidenceJson<ExternalActivityTransactionDetail>(
          row.detail_json,
          asString(row.digest),
          "external_activity_detail",
          externalActivityTransactionDetailSchema
        )
  };
}

export function externalActivitySummaryResult(
  scope: ReviewActivityScope,
  from: string | undefined,
  to: string | undefined,
  transactions: ExternalActivityTransactionRecord[],
  truncated: boolean,
  stats: {
    transactionCount: number;
    statusCounts: Record<ExternalActivityTransactionStatus, number>;
    relationshipCounts: Record<ExternalActivityRelationship, number>;
    earliestTimestamp?: string | undefined;
    latestTimestamp?: string | undefined;
  }
): ExternalActivitySummaryResult {
  const summary: ExternalActivitySummaryResult["summary"] = {
    transactionCount: stats.transactionCount,
    statusCounts: stats.statusCounts,
    relationshipCounts: stats.relationshipCounts
  };
  if (stats.earliestTimestamp !== undefined) {
    summary.earliestTimestamp = stats.earliestTimestamp;
  }
  if (stats.latestTimestamp !== undefined) {
    summary.latestTimestamp = stats.latestTimestamp;
  }
  return {
    dataScope: dataScope(scope.account, from, to, stats.transactionCount),
    accountSource: scope.accountSource,
    lowSampleWarning: stats.transactionCount < REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
    lowSampleThreshold: REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
    truncated,
    summary,
    transactions
  };
}

export function emptyExternalActivitySummaryStats(): {
  transactionCount: number;
  statusCounts: Record<ExternalActivityTransactionStatus, number>;
  relationshipCounts: Record<ExternalActivityRelationship, number>;
} {
  return {
    transactionCount: 0,
    statusCounts: Object.fromEntries(EXTERNAL_ACTIVITY_STATUSES.map((status) => [status, 0])) as Record<
      ExternalActivityTransactionStatus,
      number
    >,
    relationshipCounts: Object.fromEntries(EXTERNAL_ACTIVITY_RELATIONSHIPS.map((relationship) => [relationship, 0])) as Record<
      ExternalActivityRelationship,
      number
    >
  };
}

export function emptyReviewFunnelSummary(): ReviewFunnelSummary {
  return { total: 0, opened: 0, walletConnected: 0, stateComputed: 0,
    reviewStatusCounts: countMap(INTERNAL_SESSION_STATUSES, []),
    requestStatusCounts: TRANSACTION_REQUEST_STATUSES.map((requestStatus) => ({ requestStatus, count: 0 })), executionStatusCounts: { success: 0, failure: 0 },
    withoutRequest: 0, withoutExecutionResult: 0,
    everReachedReviewStateCounts: countMap(REVIEW_STATE_STATUSES, []), everAwaitedChainResult: 0,
    expiredWithoutExecutionResult: 0, avgCreatedToSignatureVerifiedSeconds: null, avgOpenedToSignatureVerifiedSeconds: null };
}

export function countMap<const T extends readonly string[]>(keys: T, rows: KeyCountRow[]): Record<T[number], number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
  for (const row of rows) {
    if ((keys as readonly string[]).includes(row.key)) {
      result[row.key as T[number]] = row.count;
    }
  }
  return result;
}

export function nullableSeconds(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

export function parseEvidenceJson<T>(
  value: string | null,
  reviewSessionId: string,
  evidenceField: string,
  schema?: EvidenceSchema
): T {
  if (value === null) {
    throw new ActivityStoreReadError("internal_error", "Malformed activity JSON evidence", {
      reviewSessionId,
      evidenceField
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ActivityStoreReadError("internal_error", "Malformed activity JSON evidence", {
      reviewSessionId,
      evidenceField
    });
  }
  if (schema !== undefined) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ActivityStoreReadError("internal_error", "Malformed activity JSON evidence", {
        reviewSessionId,
        evidenceField
      });
    }
    return result.data as T;
  }
  return parsed as T;
}

export function serializeJson(value: unknown): string {
  assertNoForbiddenMcpFields(value);
  return JSON.stringify(value);
}

export function serializeExternalActivityTransactionDetail(
  details: ExternalActivityTransactionDetail,
  account: string
): string {
  const parsed = externalActivityTransactionDetailSchema.safeParse(details);
  if (!parsed.success || !externalActivityTransactionDetailsReferenceOnlyAccount(parsed.data, account)) {
    throw new ActivityStoreReadError("input_invalid", "Invalid external activity transaction detail", {
      reason: "invalid_external_activity_detail_json"
    });
  }
  const json = serializeJson(parsed.data);
  if (externalActivityTransactionDetailJsonByteLength(json) > EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES) {
    throw new ActivityStoreReadError("input_invalid", "External activity transaction detail JSON is too large", {
      reason: "external_activity_detail_too_large",
      maxBytes: EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES
    });
  }
  return json;
}

export function serializeOptionalJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return serializeJson(value);
}

export function parseActionPlanEvidence(plan: ActionPlan): ActionPlan {
  const parsed = actionPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new ActivityStoreError("Invalid review session action plan evidence");
  }
  return parsed.data as ActionPlan;
}

export function extractRequestedIntent(plan: ActionPlan): unknown {
  // Adapter convention: full plan_json stays canonical, while requestedIntent
  // is materialized only to make activity queries avoid nested JSON paths.
  return (plan.adapterData as { requestedIntent?: unknown }).requestedIntent;
}

export function reasonForReviewState(state: ReviewState): string | undefined {
  if ("blockedReason" in state) {
    return state.blockedReason;
  }
  if ("refreshReason" in state) {
    return state.refreshReason;
  }
  return undefined;
}

export function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new ActivityStoreError("Unexpected SQLite value type");
  }
  return value;
}

export function coinMetadataCacheRecordFromRow(row: CoinMetadataCacheRow): CoinMetadataCacheRecord {
  return {
    coinType: asString(row.coin_type),
    chainIdentifier: asString(row.chain_identifier),
    decimals: row.decimals,
    symbol: asString(row.symbol),
    name: asString(row.name),
    fetchedAt: asString(row.fetched_at),
    expiresAt: asString(row.expires_at)
  };
}

export function asInternalSessionStatus(value: unknown): InternalSessionStatus {
  if (typeof value === "string" && (INTERNAL_SESSION_STATUSES as readonly string[]).includes(value)) {
    return value as InternalSessionStatus;
  }
  throw new ActivityStoreError("Unexpected review status");
}

export function asReviewTransitionEvent(value: unknown) {
  if (typeof value === "string" && (REVIEW_TRANSITION_EVENTS as readonly string[]).includes(value)) {
    return value as (typeof REVIEW_TRANSITION_EVENTS)[number];
  }
  throw new ActivityStoreError("Unexpected review transition event");
}

export function asAccountSource(value: unknown): AccountSource {
  if (value === "wallet_connection" || value === "review_execution") {
    return value;
  }
  throw new ActivityStoreError("Unexpected account source");
}

function asExternalActivityScanKind(value: unknown) {
  if (value === "digest_lookup" || value === "account_scan" || value === "function_scan") {
    return value;
  }
  throw new ActivityStoreError("Unexpected external activity scan kind");
}

function asExternalActivityRelationship(value: unknown) {
  if (typeof value === "string" && (EXTERNAL_ACTIVITY_RELATIONSHIPS as readonly string[]).includes(value)) {
    return value as (typeof EXTERNAL_ACTIVITY_RELATIONSHIPS)[number];
  }
  throw new ActivityStoreError("Unexpected external activity relationship");
}

function asExternalActivityStatus(value: unknown): ExternalActivityTransactionStatus {
  if (typeof value === "string" && (EXTERNAL_ACTIVITY_STATUSES as readonly string[]).includes(value)) {
    return value as ExternalActivityTransactionStatus;
  }
  throw new ActivityStoreError("Unexpected external activity status");
}

function asExternalActivityIncompleteReason(value: unknown) {
  if (typeof value === "string" && (EXTERNAL_ACTIVITY_INCOMPLETE_REASONS as readonly string[]).includes(value)) {
    return value as (typeof EXTERNAL_ACTIVITY_INCOMPLETE_REASONS)[number];
  }
  throw new ActivityStoreError("Unexpected external activity incomplete reason");
}
