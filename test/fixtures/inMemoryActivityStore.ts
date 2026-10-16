import { TRANSACTION_REQUEST_STATUSES, type TransactionRequest } from "../../src/core/session/transactionRequest.js";
import { parseSuiAddress } from "../../src/core/suiAddress.js";
import { assertNoForbiddenMcpFields } from "../../src/core/action/forbiddenFields.js";
import { actionPlanSchema } from "../../src/core/action/schemas.js";
import {
  ActivityStoreReadError,
  EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS,
  EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT,
  REVIEW_ACTIVITY_DETAIL_MAX_ITEMS,
  REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT,
  REVIEW_ACTIVITY_LIST_MAX_LIMIT,
  REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD
} from "../../src/core/activity/activityStore.js";
import type {
  AccountRecord,
  AccountSource,
  ActiveAccountRecord,
  ActivityStore,
  ExternalActivityCoverageFilter,
  ExternalActivityCoverageResult,
  ExternalActivityScanInput,
  ExternalActivityScanRecord,
  ExternalActivitySummaryFilter,
  ExternalActivitySummaryResult,
  ExternalActivityTransactionStreamFilter,
  ExternalActivityTransactionStreamResult,
  ExternalActivityTransactionRecord,
  ReviewActivityFilter,
  ReviewActivityListFilter,
  ReviewActivityListResult,
  ReviewActivityRow,
  ReviewFunnelSummary,
  ReviewFunnelSummaryResult,
  ReviewSessionEvidenceInput,
  ReviewSessionDetailInput,
  ReviewSessionDetailResult,
  ReviewStateSnapshotInput,
  ReviewTransitionInput
} from "../../src/core/activity/activityStore.js";
import {
  buildExternalActivityCoverageResult,
  scanOverlapsRequestedRange
} from "../../src/core/activity/externalActivityCoverage.js";
import {
  buildExternalActivityTransactionStreamResult,
  canonicalExternalActivityTransactions,
  compareExternalActivityTransactionsDescending,
  transactionTimestampInHalfOpenRange
} from "../../src/core/activity/externalActivityTransactionStream.js";
import type { ActionPlan, InternalSessionStatus, ReviewState } from "../../src/core/action/types.js";

export class InMemoryActivityStore implements ActivityStore {
  private readonly accountsByAddress = new Map<string, AccountRecord>();
  readonly requests = new Map<string, TransactionRequest>();
  private nextAccountId = 1;
  private activeAccount: ActiveAccountRecord | undefined;
  readonly reviewSessions: ReviewSessionEvidenceInput[] = [];
  readonly reviewTransitions: ReviewTransitionInput[] = [];
  readonly reviewStateSnapshots: ReviewStateSnapshotInput[] = [];
  readonly externalActivityScans: ExternalActivityScanRecord[] = [];
  readonly externalActivityTransactions: ExternalActivityTransactionRecord[] = [];
  private readonly reviewSessionState = new Map<string, {
    input: ReviewSessionEvidenceInput;
    account?: string | undefined;
    currentStatus: string;
    updatedAt: string;
  }>();

  async upsertAccount(address: string, source: AccountSource, now = new Date()): Promise<AccountRecord> {
    return this.upsertAccountAt(address, source, now.toISOString());
  }

  async getKnownAccount(address: string): Promise<AccountRecord | undefined> {
    const normalized = parseSuiAddress(address);
    if (!normalized) {
      throw new ActivityStoreReadError("input_invalid", "Invalid account address", { field: "account" });
    }
    const account = this.accountsByAddress.get(normalized);
    return account ? { ...account } : undefined;
  }

  private upsertAccountAt(address: string, source: AccountSource, timestamp: string): AccountRecord {
    const normalized = parseSuiAddress(address);
    if (!normalized) {
      throw new Error("Invalid Sui account address");
    }
    const existing = this.accountsByAddress.get(normalized);
    const account: AccountRecord = existing
      ? { ...existing, lastUsedAt: timestamp, lastSource: source }
      : {
          id: this.nextAccountId++,
          chainId: "sui:mainnet",
          address: normalized,
          firstSeenAt: timestamp,
          lastUsedAt: timestamp,
          firstSource: source,
          lastSource: source
    };
    this.accountsByAddress.set(normalized, account);
    return { ...account };
  }

  async seedReadAccount(
    address: string,
    now = new Date()
  ): Promise<ActiveAccountRecord> {
    const account = await this.upsertAccount(address, "wallet_connection", now);
    this.activeAccount = {
      accountId: account.id,
      chainId: "sui:mainnet", revision: (this.activeAccount?.revision ?? -1) + 1,
      address: account.address,
      source: "wallet_connection",
      setAt: now.toISOString()
    };
    return { ...this.activeAccount };
  }

  async getActiveAccount(): Promise<ActiveAccountRecord | undefined> {
    return this.activeAccount ? { ...this.activeAccount } : undefined;
  }

  async clearReadFixture(): Promise<void> {
    this.activeAccount = undefined;
  }

  async recordReviewSession(input: ReviewSessionEvidenceInput): Promise<void> {
    const parsed = actionPlanSchema.safeParse(input.plan);
    if (!parsed.success) {
      throw new Error("Invalid review session action plan evidence");
    }
    const plan = parsed.data as ActionPlan;
    assertNoForbiddenMcpFields(plan);
    assertNoForbiddenMcpFields((plan.adapterData as { requestedIntent?: unknown }).requestedIntent);
    const evidence = { ...input, plan };
    this.reviewSessions.push(evidence);
    this.reviewSessionState.set(input.reviewSessionId, {
      input: evidence,
      currentStatus: input.currentStatus,
      updatedAt: input.createdAt
    });
    this.reviewTransitions.push({
      reviewSessionId: input.reviewSessionId,
      event: "created",
      toStatus: input.currentStatus,
      transitionedAt: input.createdAt
    });
  }

  async recordReviewTransition(input: ReviewTransitionInput): Promise<void> {
    const normalizedAccount = input.account ? this.upsertAccountAt(input.account, "review_execution", input.transitionedAt).address : undefined;
    if (normalizedAccount) {
      this.assertReviewSessionAccount(input.reviewSessionId, normalizedAccount);
    }
    this.reviewTransitions.push({ ...input, account: normalizedAccount });
    const session = this.reviewSessionState.get(input.reviewSessionId);
    if (session) {
      session.currentStatus = input.toStatus;
      session.updatedAt = input.transitionedAt;
      if (normalizedAccount) {
        session.account = normalizedAccount;
      }
    }
  }

  async recordReviewStateSnapshot(input: ReviewStateSnapshotInput): Promise<void> {
    assertNoForbiddenMcpFields(input.state);
    this.assertReviewSessionAccount(input.reviewSessionId, input.state.account);
    this.reviewStateSnapshots.push({ ...input });
    this.reviewTransitions.push({
      reviewSessionId: input.reviewSessionId,
      event: "state_computed",
      fromStatus: input.fromStatus,
      toStatus: input.state.status,
      account: input.state.account,
      reason: reasonForReviewState(input.state),
      transitionedAt: input.recordedAt
    });
    const session = this.reviewSessionState.get(input.reviewSessionId);
    if (session) {
      session.currentStatus = input.state.status;
      session.updatedAt = input.recordedAt;
      session.account = input.state.account;
    }
  }

  // Snapshot fixture only: real request admission is exercised against SQLite.
  setRequest(request: TransactionRequest): void {
    this.assertReviewSessionAccount(request.reviewSessionId, request.account);
    this.requests.set(request.attemptId, structuredClone(request));
  }
  private currentRequest(id: string): TransactionRequest | undefined {
    return [...this.requests.values()].filter((request) => request.reviewSessionId === id)
      .sort((a, b) => b.reviewRevision - a.reviewRevision)[0];
  }

  async listReviewActivity(filter: ReviewActivityListFilter): Promise<ReviewActivityListResult> {
    const { from, to } = parseDateRange(filter);
    const limit = normalizeLimit(filter.limit);
    const scope = this.resolveScope(filter);
    if (!scope.accountId) {
      return listResult(scope, from, to, [], false, 0);
    }
    const rows = this.scopedRows(scope, from, to)
      .filter((row) => (!filter.reviewStatus || row.reviewStatus === filter.reviewStatus) &&
        (!filter.requestStatus || row.requestStatus === filter.requestStatus) &&
        (!filter.executionStatus || row.executionStatus === filter.executionStatus))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.reviewSessionId.localeCompare(a.reviewSessionId));
    return listResult(scope, from, to, rows.slice(0, limit), rows.length > limit, rows.length);
  }

  async summarizeReviewFunnel(filter: ReviewActivityFilter): Promise<ReviewFunnelSummaryResult> {
    const { from, to } = parseDateRange(filter);
    const scope = this.resolveScope(filter);
    if (!scope.accountId) {
      return funnelResult(scope, from, to, emptySummary(), 0);
    }
    const rows = this.scopedRows(scope, from, to);
    const rowIds = new Set(rows.map((row) => row.reviewSessionId));
    const transitions = this.reviewTransitions.filter((transition) => rowIds.has(transition.reviewSessionId));
    const reviewStatusCounts = statusCount(rows.map((row) => row.reviewStatus));
    const requests = rows.flatMap((row) => this.currentRequest(row.reviewSessionId) ?? []);
    const requestStatusCounts = TRANSACTION_REQUEST_STATUSES.map((requestStatus) => ({ requestStatus, count: requests.filter((r) => r.requestStatus === requestStatus).length }));
    const summary: ReviewFunnelSummary = {
      total: rows.length,
      opened: distinctTransitionCount(transitions, (transition) => transition.event === "opened"),
      walletConnected: distinctTransitionCount(transitions, (transition) => transition.event === "wallet_connected"),
      stateComputed: distinctTransitionCount(transitions, (transition) => transition.event === "state_computed"),
      reviewStatusCounts, requestStatusCounts,
      executionStatusCounts: { success: requests.filter((r) => r.execution?.status === "success").length,
        failure: requests.filter((r) => r.execution?.status === "failure").length },
      withoutRequest: rows.length - requests.length,
      withoutExecutionResult: rows.length - requests.filter((r) => r.execution).length,
      everReachedReviewStateCounts: {
        ready_for_wallet_review: distinctTransitionCount(transitions, (transition) => transition.toStatus === "ready_for_wallet_review"),
        blocked: distinctTransitionCount(transitions, (transition) => transition.toStatus === "blocked"),
        refresh_required: distinctTransitionCount(transitions, (transition) => transition.toStatus === "refresh_required")
      },
      everAwaitedChainResult: distinctTransitionCount(transitions, (transition) => transition.toStatus === "awaiting_chain_result"),
      expiredWithoutExecutionResult: rows.filter((row) => row.reviewStatus === "expired" &&
        ![...this.requests.values()].some((r) => r.reviewSessionId === row.reviewSessionId && r.execution)).length,
      avgCreatedToSignatureVerifiedSeconds: averageSeconds(rows, transitions, "created"),
      avgOpenedToSignatureVerifiedSeconds: averageSeconds(rows, transitions, "opened")
    };
    return funnelResult(scope, from, to, summary, rows.length);
  }

  async getReviewSessionDetail(input: ReviewSessionDetailInput): Promise<ReviewSessionDetailResult> {
    const scope = this.resolveScope({ account: input.account });
    if (!scope.accountId) {
      throw new ActivityStoreReadError("session_not_found", "Review session not found", {
        reviewSessionId: input.reviewSessionId
      });
    }
    const row = this.scopedRows(scope).find((item) => item.reviewSessionId === input.reviewSessionId);
    const state = this.reviewSessionState.get(input.reviewSessionId);
    if (!row || !state) {
      throw new ActivityStoreReadError("session_not_found", "Review session not found", {
        reviewSessionId: input.reviewSessionId
      });
    }
    const snapshots = this.reviewStateSnapshots
      .filter((snapshot) => snapshot.reviewSessionId === input.reviewSessionId && snapshot.state.account === scope.account)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS + 1);
    const transitions = this.reviewTransitions
      .filter((transition) =>
        transition.reviewSessionId === input.reviewSessionId &&
        (transition.account === undefined || transition.account === scope.account)
      )
      .sort((a, b) => a.transitionedAt.localeCompare(b.transitionedAt))
      .slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS + 1);
    const requests = [...this.requests.values()].filter((r) => r.reviewSessionId === input.reviewSessionId);
    const request = this.currentRequest(input.reviewSessionId);
    const recordCount = this.scopedRows(scope).length;
    return {
      dataScope: { account: scope.account, recordCount },
      accountSource: scope.accountSource,
      lowSampleWarning: recordCount < REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
      lowSampleThreshold: REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
      session: {
        reviewSessionId: row.reviewSessionId,
        planId: row.planId,
        actionKind: row.actionKind,
        adapterId: row.adapterId,
        protocol: row.protocol,
        reviewStatus: row.reviewStatus,
        ...(request ? { currentAttemptId: request.attemptId } : {}),
        account: row.account,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      },
      planJson: state.input.plan,
      intentJson: (state.input.plan.adapterData as { requestedIntent?: unknown }).requestedIntent,
      stateSnapshots: snapshots.slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS).map((snapshot, index) => ({
        id: index + 1,
        reviewRevision: snapshot.reviewRevision,
        planId: snapshot.state.planId,
        account: snapshot.state.account,
        status: snapshot.state.status,
        blockedReason: "blockedReason" in snapshot.state ? snapshot.state.blockedReason : undefined,
        refreshReason: "refreshReason" in snapshot.state ? snapshot.state.refreshReason : undefined,
        stateJson: snapshot.state,
        updatedAt: snapshot.state.updatedAt,
        recordedAt: snapshot.recordedAt
      })),
      transitions: transitions.slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS).map((transition, index) => ({
        id: index + 1,
        event: transition.event,
        domain: "review",
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        isNoOp: transition.fromStatus !== undefined && transition.fromStatus === transition.toStatus,
        account: transition.account,
        reason: transition.reason,
        transitionedAt: transition.transitionedAt
      })),
      ...(request ? { request } : {}), requestCount: requests.length,
      requests: requests.slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS),
      truncated: {
        activities: false,
        requests: requests.length > REVIEW_ACTIVITY_DETAIL_MAX_ITEMS,
        snapshots: snapshots.length > REVIEW_ACTIVITY_DETAIL_MAX_ITEMS,
        transitions: transitions.length > REVIEW_ACTIVITY_DETAIL_MAX_ITEMS
      }
    };
  }

  async recordExternalActivityScan(input: ExternalActivityScanInput): Promise<ExternalActivityScanRecord> {
    assertNoForbiddenMcpFields(input);
    const account = await this.getKnownAccount(input.account);
    if (!account) {
      throw new ActivityStoreReadError("input_invalid", "External activity scan account is not a known wallet", {
        reason: "account_not_known"
      });
    }
    const record: ExternalActivityScanRecord = {
      scanId: input.scanId,
      kind: input.kind,
      accountId: account.id,
      account: account.address,
      relationship: input.relationship,
      inputDigest: input.inputDigest,
      fromCheckpoint: input.fromCheckpoint,
      toCheckpoint: input.toCheckpoint,
      fromTimestamp: input.fromTimestamp,
      toTimestamp: input.toTimestamp,
      limit: input.limit,
      requestCursor: input.requestCursor,
      responseCursor: input.responseCursor,
      endpointHost: input.endpointHost,
      chainIdentifier: input.chainIdentifier,
      fetchedAt: input.fetchedAt,
      storedCount: input.transactions.length,
      skippedCount: input.skippedCount ?? 0,
      hasMore: input.hasMore,
      windowComplete: input.windowComplete,
      incompleteReason: input.incompleteReason
    };
    this.externalActivityScans.push(record);
    for (const transaction of input.transactions) {
      const existingIndex = this.externalActivityTransactions.findIndex(
        (row) =>
          row.accountId === account.id &&
          row.digest === transaction.digest &&
          row.relationship === transaction.relationship
      );
      const next: ExternalActivityTransactionRecord = {
        accountId: account.id,
        account: account.address,
        digest: transaction.digest,
        relationship: transaction.relationship,
        checkpoint: transaction.checkpoint,
        timestamp: transaction.timestamp,
        status: transaction.status,
        knownSenderAccountId: transaction.knownSenderAccountId,
        firstScanId: existingIndex >= 0 ? this.externalActivityTransactions[existingIndex]!.firstScanId : input.scanId,
        lastScanId: input.scanId,
        firstFetchedAt: existingIndex >= 0 ? this.externalActivityTransactions[existingIndex]!.firstFetchedAt : input.fetchedAt,
        lastFetchedAt: input.fetchedAt,
        lastScanIncompleteReason: input.incompleteReason,
        details: transaction.details ?? this.externalActivityTransactions[existingIndex]?.details
      };
      if (existingIndex >= 0) {
        this.externalActivityTransactions[existingIndex] = next;
      } else {
        this.externalActivityTransactions.push(next);
      }
    }
    return { ...record };
  }

  async getExternalActivityCoverage(filter: ExternalActivityCoverageFilter): Promise<ExternalActivityCoverageResult> {
    const from = parseRequiredIso(filter.from, "from");
    const to = parseRequiredIso(filter.to, "to");
    if (from >= to) {
      throw new ActivityStoreReadError("input_invalid", "from must be before to for a non-empty half-open range", { from, to });
    }
    const scope = this.resolveScope(filter);
    if (!scope.accountId) {
      return buildExternalActivityCoverageResult({
        scope,
        from,
        to,
        scans: [],
        scanCount: 0,
        storedTransactionCount: 0
      });
    }

    const relevantScans = this.externalActivityScans
      .filter((scan) => scan.accountId === scope.accountId)
      .filter((scan) => scanOverlapsRequestedRange(scan, from, to))
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.scanId.localeCompare(a.scanId));
    const scans = relevantScans.slice(0, EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS).map((scan) => ({ ...scan }));
    const rows = this.externalActivityTransactions
      .filter((row) => row.accountId === scope.accountId)
      .filter((row) => transactionTimestampInHalfOpenRange(row, from, to));
    const canonicalRows = canonicalExternalActivityTransactions(rows);
    return buildExternalActivityCoverageResult({
      scope,
      from,
      to,
      scans,
      scanCount: relevantScans.length,
      storedTransactionCount: canonicalRows.length,
      storedTransactionRange: canonicalRows.length === 0 ? undefined : inMemoryExternalActivityTransactionRange(canonicalRows),
      scansTruncated: relevantScans.length > EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS
    });
  }

  async listExternalActivityEffectTransactions(
    filter: ExternalActivityTransactionStreamFilter
  ): Promise<ExternalActivityTransactionStreamResult> {
    const from = parseRequiredIso(filter.from, "from");
    const to = parseRequiredIso(filter.to, "to");
    if (from >= to) {
      throw new ActivityStoreReadError("input_invalid", "from must be before to for a non-empty half-open range", { from, to });
    }
    const limit = normalizeExternalActivityLimit(filter.limit);
    const scope = this.resolveScope(filter);
    if (!scope.accountId) {
      return buildExternalActivityTransactionStreamResult({
        scope,
        from,
        to,
        transactions: [],
        truncated: false,
        transactionCount: 0
      });
    }

    const rows = canonicalExternalActivityTransactions(
      this.externalActivityTransactions
        .filter((row) => row.accountId === scope.accountId)
        .filter((row) => transactionTimestampInHalfOpenRange(row, from, to))
    );
    return buildExternalActivityTransactionStreamResult({
      scope,
      from,
      to,
      transactions: rows.slice(0, limit).map((row) => ({ ...row })),
      truncated: rows.length > limit,
      transactionCount: rows.length
    });
  }

  async summarizeExternalActivity(filter: ExternalActivitySummaryFilter): Promise<ExternalActivitySummaryResult> {
    const { from, to } = parseDateRange(filter);
    const limit = normalizeLimit(filter.limit);
    const scope = this.resolveScope(filter);
    const rows = scope.accountId
      ? this.externalActivityTransactions
          .filter((row) => row.accountId === scope.accountId)
          .filter((row) => !from || (row.timestamp !== undefined && row.timestamp >= from))
          .filter((row) => !to || (row.timestamp !== undefined && row.timestamp <= to))
          .sort(compareExternalActivityTransactionsDescending)
      : [];
    const statusCounts = { success: 0, failure: 0, unknown: 0 };
    const relationshipCounts = { affected: 0, sent: 0 };
    for (const row of rows) {
      statusCounts[row.status] += 1;
      relationshipCounts[row.relationship] += 1;
    }
    const timestamps = rows.flatMap((row) => row.timestamp ?? []);
    return {
      dataScope: compactScope(scope.account, from, to, rows.length),
      accountSource: scope.accountSource,
      lowSampleWarning: rows.length < REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
      lowSampleThreshold: REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
      truncated: rows.length > limit,
      summary: {
        transactionCount: rows.length,
        statusCounts,
        relationshipCounts,
        ...(timestamps.length === 0
          ? {}
          : {
              earliestTimestamp: [...timestamps].sort()[0],
              latestTimestamp: [...timestamps].sort().at(-1)
            })
      },
      transactions: rows.slice(0, limit).map((row) => ({ ...row }))
    };
  }

  private resolveScope(filter: ReviewActivityFilter): {
    account: string;
    accountId?: number;
    accountSource: "active_account_context" | "explicit_filter";
  } {
    if (filter.account) {
      const normalized = parseSuiAddress(filter.account);
      if (!normalized) {
        throw new ActivityStoreReadError("input_invalid", "Invalid account filter", { field: "account" });
      }
      const accountId = this.accountsByAddress.get(normalized)?.id;
      return accountId === undefined
        ? {
            account: normalized,
            accountSource: "explicit_filter"
          }
        : {
            account: normalized,
            accountId,
            accountSource: "explicit_filter"
          };
    }
    if (!this.activeAccount) {
      throw new ActivityStoreReadError("active_account_not_set", "No saved read address is set. Provide an explicit Sui account for this read.", {
        action: "provide_account"
      });
    }
    return {
      account: this.activeAccount.address,
      accountId: this.activeAccount.accountId,
      accountSource: "active_account_context"
    };
  }

  private scopedRows(
    scope: { account: string; accountId?: number },
    from?: string,
    to?: string
  ): ReviewActivityRow[] {
    if (!scope.accountId) {
      return [];
    }
    return [...this.reviewSessionState.entries()]
      .filter(([, value]) => value.account === scope.account)
      .filter(([, value]) => !from || value.input.createdAt >= from)
      .filter(([, value]) => !to || value.input.createdAt <= to)
      .map(([reviewSessionId, value]) => {
        const request = this.currentRequest(reviewSessionId);
        return {
          reviewSessionId,
          planId: value.input.plan.id,
          actionKind: value.input.plan.actionKind,
          adapterId: value.input.plan.adapterId,
          protocol: value.input.plan.protocol,
          reviewStatus: value.currentStatus as InternalSessionStatus,
          account: scope.account,
          createdAt: value.input.createdAt,
          updatedAt: value.updatedAt,
          ...(request ? { currentAttemptId: request.attemptId, requestStatus: request.requestStatus,
            reviewRevision: request.reviewRevision, transactionDigest: request.transactionDigest,
            ...(request.execution ? { executionStatus: request.execution.status } : {}) } : {}),
          snapshotCount: this.reviewStateSnapshots.filter((snapshot) => snapshot.reviewSessionId === reviewSessionId).length,
          transitionCount: this.reviewTransitions.filter((transition) => transition.reviewSessionId === reviewSessionId).length
        };
      });
  }

  private assertReviewSessionAccount(reviewSessionId: string, account: string): void {
    const normalized = parseSuiAddress(account);
    if (!normalized) {
      throw new Error("Invalid Sui account address");
    }
    const session = this.reviewSessionState.get(reviewSessionId);
    if (!session) {
      throw new Error(`Review session not found: ${reviewSessionId}`);
    }
    if (session.account && session.account !== normalized) {
      throw new Error(`Review session already belongs to a different account: ${reviewSessionId}`);
    }
  }
}

function parseDateRange(filter: ReviewActivityFilter): { from?: string; to?: string } {
  const from = parseIso(filter.from, "from");
  const to = parseIso(filter.to, "to");
  if (from && to && from > to) {
    throw new ActivityStoreReadError("input_invalid", "from must be before or equal to to", { from, to });
  }
  const range: { from?: string; to?: string } = {};
  if (from !== undefined) range.from = from;
  if (to !== undefined) range.to = to;
  return range;
}

function parseIso(value: string | undefined, field: "from" | "to"): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ActivityStoreReadError("input_invalid", `${field} must be an ISO 8601 UTC timestamp`, { field });
  }
  return value;
}

function parseRequiredIso(value: string, field: "from" | "to"): string {
  const parsed = parseIso(value, field);
  if (parsed === undefined) {
    throw new ActivityStoreReadError("input_invalid", `${field} must be an ISO 8601 UTC timestamp`, { field });
  }
  return parsed;
}

function inMemoryExternalActivityTransactionRange(
  rows: ExternalActivityTransactionRecord[]
): NonNullable<ExternalActivityCoverageResult["storedTransactionRange"]> {
  const timestamps = rows.flatMap((row) => row.timestamp ?? []).sort();
  const checkpoints = rows.flatMap((row) => row.checkpoint ?? []).sort((a, b) => {
    const delta = BigInt(a) - BigInt(b);
    if (delta < 0n) return -1;
    if (delta > 0n) return 1;
    return 0;
  });
  return {
    earliestTimestamp: timestamps[0],
    latestTimestamp: timestamps.at(-1),
    earliestCheckpoint: checkpoints[0],
    latestCheckpoint: checkpoints.at(-1)
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return REVIEW_ACTIVITY_LIST_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_ACTIVITY_LIST_MAX_LIMIT) {
    throw new ActivityStoreReadError("input_invalid", "limit must be an integer from 1 to 100", { limit });
  }
  return limit;
}

function normalizeExternalActivityLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT) {
    throw new ActivityStoreReadError("input_invalid", "limit must be an integer from 1 to 100", { limit });
  }
  return limit;
}

function listResult(
  scope: { account: string; accountSource: "active_account_context" | "explicit_filter" },
  from: string | undefined,
  to: string | undefined,
  activities: ReviewActivityRow[],
  truncated: boolean,
  recordCount: number
): ReviewActivityListResult {
  return {
    dataScope: compactScope(scope.account, from, to, recordCount),
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

function funnelResult(
  scope: { account: string; accountSource: "active_account_context" | "explicit_filter" },
  from: string | undefined,
  to: string | undefined,
  summary: ReviewFunnelSummary,
  recordCount: number
): ReviewFunnelSummaryResult {
  return {
    dataScope: compactScope(scope.account, from, to, recordCount),
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

function compactScope(account: string, from: string | undefined, to: string | undefined, recordCount: number) {
  const scope: { account: string; from?: string; to?: string; recordCount: number } = { account, recordCount };
  if (from !== undefined) scope.from = from;
  if (to !== undefined) scope.to = to;
  return scope;
}

function emptySummary(): ReviewFunnelSummary {
  return {
    total: 0,
    opened: 0,
    walletConnected: 0,
    stateComputed: 0,
    reviewStatusCounts: statusCount([]),
    requestStatusCounts: TRANSACTION_REQUEST_STATUSES.map((requestStatus) => ({ requestStatus, count: 0 })),
    executionStatusCounts: { success: 0, failure: 0 }, withoutRequest: 0, withoutExecutionResult: 0,
    everReachedReviewStateCounts: {
      ready_for_wallet_review: 0,
      blocked: 0,
      refresh_required: 0
    },
    everAwaitedChainResult: 0,
    expiredWithoutExecutionResult: 0,
    avgCreatedToSignatureVerifiedSeconds: null,
    avgOpenedToSignatureVerifiedSeconds: null
  };
}

function statusCount(statuses: string[]): Record<InternalSessionStatus, number> {
  const result: Record<InternalSessionStatus, number> = {
    proposed: 0,
    awaiting_wallet: 0,
    wallet_connected: 0,
    ready_for_wallet_review: 0,
    refresh_required: 0,
    blocked: 0,
    expired: 0
  };
  for (const status of statuses) {
    if (status in result) {
      result[status as InternalSessionStatus] += 1;
    }
  }
  return result;
}

function distinctTransitionCount(
  transitions: ReviewTransitionInput[],
  predicate: (transition: ReviewTransitionInput) => boolean
): number {
  return new Set(transitions.filter(predicate).map((transition) => transition.reviewSessionId)).size;
}

function averageSeconds(
  rows: ReviewActivityRow[],
  transitions: ReviewTransitionInput[],
  from: "created" | "opened"
): number | null {
  const values = rows.flatMap((row) => {
    const signed = transitions
      .filter((transition) =>
        transition.reviewSessionId === row.reviewSessionId &&
        transition.event === "signature_verified"
      )
      .map((transition) => transition.transitionedAt)
      .sort()[0];
    if (!signed) return [];
    const start = from === "created"
      ? row.createdAt
      : transitions
          .filter((transition) => transition.reviewSessionId === row.reviewSessionId && transition.event === "opened")
          .map((transition) => transition.transitionedAt)
          .sort()[0];
    if (!start) return [];
    return [(new Date(signed).getTime() - new Date(start).getTime()) / 1000];
  });
  if (values.length === 0) {
    return null;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function reasonForReviewState(state: ReviewState): string | undefined {
  if ("blockedReason" in state) {
    return state.blockedReason;
  }
  if ("refreshReason" in state) {
    return state.refreshReason;
  }
  return undefined;
}
