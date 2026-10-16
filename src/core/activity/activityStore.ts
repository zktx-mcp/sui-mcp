import type { PrivateReviewArtifacts } from "../session/privateReviewArtifacts.js";
import type { ReviewEvaluationCandidate, ReviewEvaluation } from "../session/reviewValidity.js";
import type { TransactionRequest, TransactionRequestStatus } from "../session/transactionRequest.js";
import type {
  ActionPlan,
  InternalSessionStatus,
  ReviewSession,
  ToolErrorKind,
  ReviewState
} from "../action/types.js";
import type { ExternalActivityTransactionDetail } from "./transactionActivityDetails.js";
import type { WalletChainId } from "../session/chainAccounts.js";

export type AccountSource = "wallet_connection" | "review_execution";
export type ReviewTransitionEvent =
  | "created"
  | "opened"
  | "wallet_connected"
  | "state_computed"
  | "request_admitted"
  | "request_status_changed"
  | "signature_verified"
  | "chain_result_recorded"
  | "review_update_failed"
  | "review_invalidated"
  | "expired";

export const REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD = 5;
export const REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT = 20;
export const REVIEW_ACTIVITY_LIST_MAX_LIMIT = 100;
export const REVIEW_ACTIVITY_DETAIL_MAX_ITEMS = 100;
export const EXTERNAL_ACTIVITY_SCAN_DEFAULT_LIMIT = 100;
export const EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT = 100;
export const EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS = 100;

export type AccountRecord = {
  id: number;
  chainId: WalletChainId;
  address: string;
  firstSeenAt: string;
  lastUsedAt: string;
  firstSource: AccountSource;
  lastSource: AccountSource;
};

export type ActiveAccountRecord = {
  accountId: number;
  chainId: WalletChainId;
  revision: number;
  address: string;
  source: "wallet_connection";
  setAt: string;
  walletName?: string;
  connectionId?: string;
};

export type ExternalActivityRelationship = "affected" | "sent";
export type ExternalActivityScanKind = "digest_lookup" | "account_scan" | "function_scan";
export type ExternalActivityTransactionStatus = "success" | "failure" | "unknown";
export type ExternalActivityIncompleteReason =
  | "limit_reached"
  | "ordering_unverified"
  | "cursor_invalid"
  | "provider_error";

export type ExternalActivityScanInput = {
  scanId: string;
  kind: ExternalActivityScanKind;
  account: string;
  relationship: ExternalActivityRelationship;
  inputDigest?: string | undefined;
  fromCheckpoint?: string | undefined;
  toCheckpoint?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
  limit: number;
  requestCursor?: string | undefined;
  responseCursor?: string | undefined;
  endpointHost: string;
  chainIdentifier: string;
  fetchedAt: string;
  hasMore: boolean;
  windowComplete: boolean | null;
  incompleteReason?: ExternalActivityIncompleteReason | undefined;
  skippedCount?: number | undefined;
  transactions: ExternalActivityTransactionInput[];
};

export type ExternalActivityTransactionInput = {
  digest: string;
  relationship: ExternalActivityRelationship;
  checkpoint?: string | undefined;
  timestamp?: string | undefined;
  status: ExternalActivityTransactionStatus;
  knownSenderAccountId?: number | undefined;
  details?: ExternalActivityTransactionDetail | undefined;
};

export type ExternalActivityScanRecord = {
  scanId: string;
  kind: ExternalActivityScanKind;
  accountId: number;
  account: string;
  relationship: ExternalActivityRelationship;
  inputDigest?: string | undefined;
  fromCheckpoint?: string | undefined;
  toCheckpoint?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
  limit: number;
  requestCursor?: string | undefined;
  responseCursor?: string | undefined;
  endpointHost: string;
  chainIdentifier: string;
  fetchedAt: string;
  storedCount: number;
  skippedCount: number;
  hasMore: boolean;
  windowComplete: boolean | null;
  incompleteReason?: ExternalActivityIncompleteReason | undefined;
};

export type ExternalActivityTransactionRecord = {
  accountId: number;
  account: string;
  digest: string;
  relationship: ExternalActivityRelationship;
  checkpoint?: string | undefined;
  timestamp?: string | undefined;
  status: ExternalActivityTransactionStatus;
  knownSenderAccountId?: number | undefined;
  firstScanId: string;
  lastScanId: string;
  firstFetchedAt: string;
  lastFetchedAt: string;
  lastScanIncompleteReason?: ExternalActivityIncompleteReason | undefined;
  details?: ExternalActivityTransactionDetail | undefined;
};

export type ExternalActivitySummaryFilter = {
  account?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
};

export type ExternalActivityCoverageFilter = {
  account?: string | undefined;
  from: string;
  to: string;
};

export type ExternalActivityTransactionStreamFilter = {
  account?: string | undefined;
  from: string;
  to: string;
  limit?: number | undefined;
};

export type ExternalActivityCoverageStatus =
  | "complete"
  | "partial"
  | "no_stored_scans";

export type ExternalActivityCoverageLimitation =
  | "no_stored_activity_scans"
  | "no_complete_affected_account_scan"
  | "sent_only_scan_not_full_account_coverage"
  | "scan_window_incomplete"
  | "scan_window_unbounded"
  | "scan_records_truncated";

export type ExternalActivityCoverageResult = {
  dataScope: ReviewActivityDataScope;
  accountSource: ReviewActivityAccountSource;
  accountKnown: boolean;
  requestedRange: {
    from: string;
    to: string;
  };
  coverageStatus: ExternalActivityCoverageStatus;
  scanCount: number;
  returnedScanCount: number;
  scansTruncated: boolean;
  storedTransactionCount: number;
  storedTransactionRange?: {
    earliestTimestamp?: string | undefined;
    latestTimestamp?: string | undefined;
    earliestCheckpoint?: string | undefined;
    latestCheckpoint?: string | undefined;
  } | undefined;
  coverageEvidence: {
    completeAffectedAccountScanIds: string[];
    incompleteScanIds: string[];
    sentOnlyScanIds: string[];
  };
  limitations: ExternalActivityCoverageLimitation[];
  scans: ExternalActivityScanRecord[];
};

export type ExternalActivitySummaryResult = {
  dataScope: ReviewActivityDataScope;
  accountSource: ReviewActivityAccountSource;
  lowSampleWarning: boolean;
  lowSampleThreshold: number;
  truncated: boolean;
  summary: {
    transactionCount: number;
    statusCounts: Record<ExternalActivityTransactionStatus, number>;
    relationshipCounts: Record<ExternalActivityRelationship, number>;
    earliestTimestamp?: string | undefined;
    latestTimestamp?: string | undefined;
  };
  transactions: ExternalActivityTransactionRecord[];
};

export type ExternalActivityTransactionStreamResult = {
  dataScope: ReviewActivityDataScope;
  accountSource: ReviewActivityAccountSource;
  accountKnown: boolean;
  truncated: boolean;
  transactionCount: number;
  transactions: ExternalActivityTransactionRecord[];
};

export type ReviewActivityAccountSource = "active_account_context" | "explicit_filter";

export type ReviewActivityDataScope = {
  account: string;
  from?: string | undefined;
  to?: string | undefined;
  recordCount: number;
};

export type ReviewActivityTruncation = {
  activities: boolean;
  snapshots: boolean;
  transitions: boolean;
  requests?: boolean;
};

export type ReviewActivityFilter = {
  account?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export type ReviewActivityListFilter = ReviewActivityFilter & {
  reviewStatus?: InternalSessionStatus | undefined;
  requestStatus?: TransactionRequestStatus | undefined;
  executionStatus?: "success" | "failure" | undefined;
  limit?: number | undefined;
};

export type ReviewActivityRow = {
  reviewSessionId: string; planId: string; actionKind: string; adapterId: string; protocol: string;
  reviewStatus: InternalSessionStatus; account: string; createdAt: string; updatedAt: string;
  currentAttemptId?: string; requestStatus?: TransactionRequestStatus; reviewRevision?: number;
  transactionDigest?: string; executionStatus?: "success" | "failure";
  snapshotCount: number; transitionCount: number;
};

export type ReviewActivityListResult = {
  dataScope: ReviewActivityDataScope;
  accountSource: ReviewActivityAccountSource;
  lowSampleWarning: boolean;
  lowSampleThreshold: number;
  truncated: ReviewActivityTruncation;
  activities: ReviewActivityRow[];
};

export type ReviewFunnelSummary = {
  total: number; opened: number; walletConnected: number; stateComputed: number;
  reviewStatusCounts: Record<InternalSessionStatus, number>;
  requestStatusCounts: Array<{ requestStatus: TransactionRequestStatus; count: number }>;
  executionStatusCounts: Record<"success" | "failure", number>;
  withoutRequest: number; withoutExecutionResult: number;
  everReachedReviewStateCounts: Record<"ready_for_wallet_review" | "blocked" | "refresh_required", number>;
  everAwaitedChainResult: number; expiredWithoutExecutionResult: number;
  avgCreatedToSignatureVerifiedSeconds: number | null;
  avgOpenedToSignatureVerifiedSeconds: number | null;
};

export type ReviewFunnelSummaryResult = {
  dataScope: ReviewActivityDataScope;
  accountSource: ReviewActivityAccountSource;
  lowSampleWarning: boolean;
  lowSampleThreshold: number;
  truncated: ReviewActivityTruncation;
  summary: ReviewFunnelSummary;
};

export type ReviewSessionDetailInput = {
  reviewSessionId: string;
  account?: string | undefined;
};

export type ReviewSessionDetailResult = {
  dataScope: ReviewActivityDataScope;
  accountSource: ReviewActivityAccountSource;
  lowSampleWarning: boolean;
  lowSampleThreshold: number;
  session: {
    reviewSessionId: string;
    planId: string;
    actionKind: string;
    adapterId: string;
    protocol: string;
    reviewStatus: InternalSessionStatus;
    currentAttemptId?: string;
    account: string;
    createdAt: string;
    updatedAt: string;
  };
  planJson: ActionPlan;
  intentJson?: unknown | undefined;
  stateSnapshots: Array<{
    id: number;
    reviewRevision: number;
    planId: string;
    account: string;
    status: string;
    blockedReason?: string | undefined;
    refreshReason?: string | undefined;
    stateJson: ReviewState;
    updatedAt: string;
    recordedAt: string;
  }>;
  transitions: Array<{
    id: number;
    event: ReviewTransitionEvent;
    fromStatus?: string | undefined;
    toStatus: string;
    isNoOp: boolean;
    domain: "review" | "request";
    attemptId?: string;
    account?: string | undefined;
    reason?: string | undefined;
    transitionedAt: string;
  }>;
  request?: TransactionRequest;
  requestCount: number;
  requests: TransactionRequest[];
  truncated: ReviewActivityTruncation;
};

export class ActivityStoreReadError extends Error {
  constructor(
    readonly kind: Extract<ToolErrorKind, "input_invalid" | "active_account_not_set" | "session_not_found" | "internal_error">,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export type ReviewSessionEvidenceInput = {
  reviewSessionId: string;
  plan: ActionPlan;
  currentStatus: InternalSessionStatus;
  createdAt: string;
};

export type ReviewTransitionInput = {
  reviewSessionId: string;
  event: ReviewTransitionEvent;
  fromStatus?: string | undefined;
  toStatus: string;
  account?: string | undefined;
  reason?: string | undefined;
  transitionedAt: string;
};

export type ReviewStateSnapshotInput = {
  reviewSessionId: string;
  reviewRevision: number;
  fromStatus?: string | undefined;
  state: ReviewState;
  recordedAt: string;
};

export type LiveReviewSessionMutation = {
  publication?: { material: { artifacts: PrivateReviewArtifacts; transactionBytes: Uint8Array }; clock: () => Date };
  expected?: ReviewSession | undefined;
  next: ReviewSession;
  privateArtifactsJson?: string | null | undefined;
  deleteTransactionMaterials?: boolean | undefined;
};

export interface ActivityStore {
  finalizeReviewEvaluation?(candidate: ReviewEvaluationCandidate, clock: () => Date): ReviewEvaluation;
  upsertAccount(address: string, source: AccountSource, now?: Date): Promise<AccountRecord>;
  getKnownAccount(address: string): Promise<AccountRecord | undefined>;
  getActiveAccount(): Promise<ActiveAccountRecord | undefined>;
  recordReviewSession(input: ReviewSessionEvidenceInput): Promise<void>;
  recordReviewSessionWithLiveSession?(input: ReviewSessionEvidenceInput, live: LiveReviewSessionMutation): Promise<boolean>;
  recordReviewTransition(input: ReviewTransitionInput): Promise<void>;
  recordReviewTransitionWithLiveSession?(input: ReviewTransitionInput, live: LiveReviewSessionMutation): Promise<boolean>;
  recordReviewStateSnapshot(input: ReviewStateSnapshotInput): Promise<void>;
  recordReviewStateSnapshotWithLiveSession?(input: ReviewStateSnapshotInput, live: LiveReviewSessionMutation): Promise<boolean>;
  listReviewActivity(filter: ReviewActivityListFilter): Promise<ReviewActivityListResult>;
  summarizeReviewFunnel(filter: ReviewActivityFilter): Promise<ReviewFunnelSummaryResult>;
  getReviewSessionDetail(input: ReviewSessionDetailInput): Promise<ReviewSessionDetailResult>;
  recordExternalActivityScan(input: ExternalActivityScanInput): Promise<ExternalActivityScanRecord>;
  getExternalActivityCoverage(filter: ExternalActivityCoverageFilter): Promise<ExternalActivityCoverageResult>;
  listExternalActivityEffectTransactions(filter: ExternalActivityTransactionStreamFilter): Promise<ExternalActivityTransactionStreamResult>;
  summarizeExternalActivity(filter: ExternalActivitySummaryFilter): Promise<ExternalActivitySummaryResult>;
}
