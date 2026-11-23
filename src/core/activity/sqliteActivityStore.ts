import { windowCompletion } from "./transactionActivityScanPolicy.js";
import { parseSuiFunctionTarget } from "./suiFunctionTarget.js";
import type { PrivateReviewArtifacts } from "../session/privateReviewArtifacts.js";
import { mergeActivityDetails } from "./transactionActivityDetails.js";
import { readStoredTransactionRequest } from "../session/sqliteTransactionRequest.js";
import { publicConnectionOperation } from "../session/walletConnectionOperations.js";
import { decideReviewEvaluation, needsReviewMaterial, type ReviewEvaluationCandidate, type ReviewEvaluation } from "../session/reviewValidity.js";
import { fixedReviewTarget, workflowEligibility, type WorkflowEvaluationInput, type EvaluatedWorkflowState } from "../session/workflowState.js";
import { SessionStoreError } from "../session/sessionErrors.js";
import { z } from "zod";
import { TRANSACTION_REQUEST_STATUSES, transactionRequestStatusSchema } from "../session/transactionRequest.js";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { claimFirstReviewOpening, SqliteWalletWorkflowStore } from "../session/sqliteWalletWorkflowStore.js";
import type { AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { parseLifecycleValidatedReviewState } from "../action/reviewStateValidation.js";
import { actionPlanSchema } from "../action/schemas.js";
import type { ActionPlan, ReviewState } from "../action/types.js";
import { parseSuiAddress } from "../suiAddress.js";
import { SqliteAccountStore } from "./sqliteAccountStore.js";
import { SUI_MAINNET_WALLET_CHAIN, fixedChainAccount } from "../session/chainAccounts.js";
import { walletConnectionSchema } from "../session/walletConnection.js";
import { SqlitePreferencesRepository } from "../preferences/sqlitePreferencesRepository.js";
import { SqliteTransactionMaterialStore } from "../session/sqliteTransactionMaterialStore.js";
import { SqliteCardRecordStore } from "../session/sqliteCardStore.js";
import { sameHandle, type LocalTransactionMaterialStore } from "../session/transactionMaterialStore.js";
import {
  SqliteSessionRecordStore,
  SqlitePrivateReviewArtifactStore,
  sessionFromLiveReviewSessionRow,
  insertLiveReviewSessionRow,
  updateLiveReviewSessionRow,
  type LiveReviewSessionRow
} from "../session/sqliteSessionStore.js";
import type { SessionRecordStore } from "../session/sessionRecordStore.js";
import type { PrivateReviewArtifactStore } from "../session/privateReviewArtifacts.js";
import { SqliteSettingsWorkflowStore } from "../session/sqliteSettingsWorkflowStore.js";
import type {
  CoinMetadataCache,
  CoinMetadataCacheLookup,
  CoinMetadataCacheRecord
} from "../read/coinMetadata.js";
import { SqliteLocalDataService, type SqliteLocalDataServiceOptions } from "./localDataService.js";
import { buildExternalActivityCoverageResult, scanCompletesAffectedAccountRange } from "./externalActivityCoverage.js";
import {
  buildExternalActivityTransactionStreamResult
} from "./externalActivityTransactionStream.js";
import type {
  AccountRecord,
  AccountSource,
  ActiveAccountRecord,
  ActivityStore, ActivityWindowBinding,
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
  ReviewFunnelSummaryResult,
  ReviewSessionEvidenceInput,
  ReviewSessionDetailInput,
  ReviewSessionDetailResult,
  ReviewStateSnapshotInput,
  ReviewTransitionInput,
  LiveReviewSessionMutation
} from "./activityStore.js";
import {
  ActivityStoreReadError,
  EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS,
  REVIEW_ACTIVITY_DETAIL_MAX_ITEMS,
  REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD
} from "./activityStore.js";
import {
  assertCurrentDatabaseFormat,
  configureDatabase,
  initializeDatabase
} from "./sqliteActivityStoreSchema.js";
import {
  ActivityStoreError,
  type SqliteActivityStoreOptions,
  type SqliteDatabase
} from "./sqliteActivityStoreTypes.js";
import {
  EXTERNAL_ACTIVITY_RELATIONSHIPS,
  EXTERNAL_ACTIVITY_STATUSES,
  INTERNAL_SESSION_STATUSES,
  REVIEW_STATE_STATUSES,
  type CoinMetadataCacheRow,
  type CountRow,
  type ExternalActivityScanRow,
  type ExternalActivityTransactionRow,
  type KeyCountRow,
  type ReviewActivityListRow,
  type ReviewActivityScope,
  type ReviewStateSnapshotRow,
  type ReviewTransitionRow,
  asInternalSessionStatus,
  asReviewTransitionEvent,
  assertDateRange,
  coinMetadataCacheRecordFromRow,
  countMap,
  emptyExternalActivitySummaryStats,
  emptyReviewFunnelSummary,
  externalActivityScanFromRow,
  externalActivitySummaryResult,
  externalActivityTransactionFromRow,
  extractRequestedIntent,
  normalizeExternalActivityLimit,
  normalizeListLimit,
  nullableSeconds,
  parseActionPlanEvidence,
  parseEvidenceJson,
  parseIsoTimestamp,
  parseOptionalIsoTimestamp,
  reasonForReviewState,
  reviewActivityListResult,
  reviewActivityRowFromStorage,
  reviewFunnelResult,
  reviewSessionWhere,
  serializeExternalActivityTransactionDetail,
  serializeJson,
  serializeOptionalJson
} from "./sqliteActivityStoreRows.js";

export { ActivityStoreError };
export type { SqliteActivityStoreOptions };

export const DATA_DIR_ENV = "SUI_MCP_DATA_DIR";
export const ACTIVITY_DATABASE_FILENAME = "sui-mcp.sqlite";

// Best-effort permission hardening. The owner-only data directory is the primary
// protection; failures (e.g. on Windows, which ignores POSIX modes) are non-fatal.
function restrictPathPermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Non-fatal: the 0700 directory remains the primary protection.
  }
}

export class SqliteActivityStore implements ActivityStore {
  private readonly db: SqliteDatabase;
  readonly chainAccounts: SqliteAccountStore;
  private readonly validateAdapterLifecycle: AdapterLifecycleValidator;

  constructor(options: SqliteActivityStoreOptions) {
    this.validateAdapterLifecycle = options.validateAdapterLifecycle;
    const dataDirectory = dirname(options.databasePath);
    try {
      if (options.databasePath !== ":memory:") mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    } catch {
      throw new ActivityStoreError(
        `Could not create the local activity data directory. Check directory permissions or set ${DATA_DIR_ENV}.`
      );
    }
    if (options.databasePath !== ":memory:" && existsSync(options.databasePath)) {
      const existing = new Database(options.databasePath, { readonly: true, fileMustExist: true });
      try { assertCurrentDatabaseFormat(existing); } finally { existing.close(); }
    }
    const database = new Database(options.databasePath);
    this.db = options.guardDatabase?.(database) ?? database;
    this.chainAccounts = new SqliteAccountStore(this.db);
    try {
      initializeDatabase(this.db);
      configureDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    // This database persists unsigned transaction material (Option B), so restrict it to
    // the owner. The 0700 directory is the primary protection (it also covers the WAL/SHM
    // sidecars and blocks other OS users); the 0600 file is belt-and-suspenders. Best-effort
    // because some platforms (e.g. Windows) ignore POSIX modes.
    if (options.databasePath !== ":memory:") {
      restrictPathPermissions(dataDirectory, 0o700);
      restrictPathPermissions(options.databasePath, 0o600);
    }
  }

  async upsertAccount(address: string, source: AccountSource, now = new Date()): Promise<AccountRecord> {
    return this.upsertAccountSync(address, source, now.toISOString());
  }

  async getKnownAccount(address: string): Promise<AccountRecord | undefined> {
    const normalized = parseSuiAddress(address);
    if (!normalized) {
      throw new ActivityStoreReadError("input_invalid", "Invalid account address", { field: "account" });
    }
    return this.getAccountByAddressSync(normalized);
  }

  async getActiveAccount(): Promise<ActiveAccountRecord | undefined> { return this.getActiveAccountSync(); }

  async recordReviewSession(input: ReviewSessionEvidenceInput): Promise<void> {
    const plan = parseActionPlanEvidence(input.plan);
    const planJson = serializeJson(plan);
    const intentJson = serializeOptionalJson(extractRequestedIntent(plan));
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO review_sessions
               (id, plan_id, action_kind, adapter_id, protocol, current_status,
                plan_json, intent_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.reviewSessionId,
            plan.id,
            plan.actionKind,
            plan.adapterId,
            plan.protocol,
            input.currentStatus,
            planJson,
            intentJson,
            input.createdAt,
            input.createdAt
          );
        this.insertReviewTransition({
          reviewSessionId: input.reviewSessionId,
          event: "created",
          toStatus: input.currentStatus,
          transitionedAt: input.createdAt
        });
      })();
  }

  async recordReviewSessionWithLiveSession(
    input: ReviewSessionEvidenceInput,
    live: LiveReviewSessionMutation
  ): Promise<boolean> {
    const plan = parseActionPlanEvidence(input.plan);
    const planJson = serializeJson(plan);
    const intentJson = serializeOptionalJson(extractRequestedIntent(plan));
    return this.runLiveReviewSessionMutation(live, () => {
      this.db
        .prepare(
          `INSERT INTO review_sessions
             (id, plan_id, action_kind, adapter_id, protocol, current_status,
              plan_json, intent_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.reviewSessionId,
          plan.id,
          plan.actionKind,
          plan.adapterId,
          plan.protocol,
          input.currentStatus,
          planJson,
          intentJson,
          input.createdAt,
          input.createdAt
        );
      this.insertReviewTransition({
        reviewSessionId: input.reviewSessionId,
        event: "created",
        toStatus: input.currentStatus,
        transitionedAt: input.createdAt
      });
    });
  }

  async recordReviewTransition(input: ReviewTransitionInput): Promise<void> {
    this.db
      .transaction(() => {
        const accountId = input.account
          ? this.upsertAccountSync(input.account, "review_record", input.transitionedAt).id
          : null;
        if (accountId !== null) {
          this.assertReviewSessionAccount(input.reviewSessionId, accountId);
        }
        const transitionedAt = this.insertReviewTransition({ ...input, accountId });
        this.db
          .prepare(
            `UPDATE review_sessions
             SET current_status = ?, account_id = COALESCE(account_id, ?), updated_at = ?
             WHERE id = ?`
          )
          .run(input.toStatus, accountId, transitionedAt, input.reviewSessionId);
      })();
  }

  async recordReviewTransitionWithLiveSession(
    input: ReviewTransitionInput,
    live: LiveReviewSessionMutation
  ): Promise<boolean> {
    return this.recordReviewTransitionWithLiveSessionSync(input, live);
  }

  private recordReviewTransitionWithLiveSessionSync(
    input: ReviewTransitionInput,
    live: LiveReviewSessionMutation
  ): boolean {
    return this.runLiveReviewSessionMutation(live, () => {
      const accountId = input.account
        ? this.upsertAccountSync(input.account, "review_record", input.transitionedAt).id
        : null;
      if (accountId !== null) {
        this.assertReviewSessionAccount(input.reviewSessionId, accountId);
      }
      const transitionedAt = this.insertReviewTransition({ ...input, accountId });
      this.db
        .prepare(
          `UPDATE review_sessions
           SET current_status = ?, account_id = COALESCE(account_id, ?), updated_at = ?
           WHERE id = ?`
        )
        .run(input.toStatus, accountId, transitionedAt, input.reviewSessionId);
    });
  }

  async recordReviewStateSnapshot(input: ReviewStateSnapshotInput): Promise<void> {
    const parsedState = parseLifecycleValidatedReviewState(input.state, this.validateAdapterLifecycle);
    const stateJson = serializeJson(parsedState);
    this.db
      .transaction(() => {
        const account = this.upsertAccountSync(parsedState.account, "review_record", input.recordedAt);
        this.assertReviewSessionAccount(input.reviewSessionId, account.id);
        this.db
          .prepare(
            `INSERT INTO review_state_snapshots
               (review_session_id, plan_id, account_id, status, blocked_reason, refresh_reason,
                state_json, updated_at, recorded_at, review_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.reviewSessionId,
            parsedState.planId,
            account.id,
            parsedState.status,
            "blockedReason" in parsedState ? parsedState.blockedReason : null,
            "refreshReason" in parsedState ? parsedState.refreshReason : null,
            stateJson,
            parsedState.updatedAt,
            input.recordedAt, input.reviewRevision
          );
        this.insertReviewTransition({
          reviewSessionId: input.reviewSessionId,
          event: "state_computed",
          fromStatus: input.fromStatus,
          toStatus: parsedState.status,
          accountId: account.id,
          reason: reasonForReviewState(parsedState),
          transitionedAt: input.recordedAt
        });
        this.db
          .prepare(
            `UPDATE review_sessions
             SET current_status = ?, account_id = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(parsedState.status, account.id, input.recordedAt, input.reviewSessionId);
      })();
  }

  async recordReviewStateSnapshotWithLiveSession(
    input: ReviewStateSnapshotInput,
    live: LiveReviewSessionMutation
  ): Promise<boolean> {
    return this.recordReviewStateSnapshotWithLiveSessionSync(input, live);
  }

  private recordReviewStateSnapshotWithLiveSessionSync(
    input: ReviewStateSnapshotInput,
    live: LiveReviewSessionMutation
  ): boolean {
    const parsedState = parseLifecycleValidatedReviewState(input.state, this.validateAdapterLifecycle);
    const stateJson = serializeJson(parsedState);
    return this.runLiveReviewSessionMutation(live, () => {
      if (live.publication) {
        const { material: checked, clock } = live.publication;
        const at = clock(), handle = checked.artifacts.transactionMaterial;
        if (handle && Date.parse(handle.expiresAt) <= at.getTime()) {
          throw new SessionStoreError("invalid_session_transition", "Quote expired before review publication.",
            { reason: "quote_expired_before_publication" });
        }
        const material = handle && this.createTransactionMaterialStore().getTransactionMaterial(handle, at);
        const connection = live.expected?.walletConnectionId ? this.db.prepare(`SELECT c.status,c.owner_id,c.run_id,c.connection_json,r.preparation_run_id FROM live_wallet_connections c
          JOIN live_review_sessions r ON r.wallet_connection_id=c.id WHERE c.id=? AND r.id=? AND c.current_slot=1 AND c.data_epoch=(SELECT data_epoch FROM settings_control WHERE id=1)`)
          .get(live.expected.walletConnectionId, live.expected.id) as { status: string; owner_id: string; run_id: string | null; preparation_run_id: string | null; connection_json: string } | undefined : undefined;
        const wallet = connection && walletConnectionSchema.parse(JSON.parse(connection.connection_json));
        if (Date.parse(live.next.expiresAt) <= at.getTime() || !handle || !material || !sameHandle(material, handle) ||
            !Buffer.from(material.transactionBytes).equals(checked.transactionBytes) || !connection || connection.status !== "connected" ||
            connection.owner_id !== live.expected?.ownerId || !connection.run_id || connection.run_id !== connection.preparation_run_id || !wallet ||
            wallet.grantRevisions[SUI_MAINNET_WALLET_CHAIN] !== live.expected?.walletGrantRevision ||
            fixedChainAccount(wallet, SUI_MAINNET_WALLET_CHAIN) !== parsedState.account ||
            Date.parse(wallet.expiresAt) <= at.getTime()) {
          throw new SessionStoreError("invalid_session_transition", "Review material or wallet selection changed before publication.");
        }
      }
      const account = this.upsertAccountSync(parsedState.account, "review_record", input.recordedAt);
      this.assertReviewSessionAccount(input.reviewSessionId, account.id);
      this.db
        .prepare(
          `INSERT INTO review_state_snapshots
             (review_session_id, plan_id, account_id, status, blocked_reason, refresh_reason,
              state_json, updated_at, recorded_at, review_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.reviewSessionId,
          parsedState.planId,
          account.id,
          parsedState.status,
          "blockedReason" in parsedState ? parsedState.blockedReason : null,
          "refreshReason" in parsedState ? parsedState.refreshReason : null,
          stateJson,
          parsedState.updatedAt,
          input.recordedAt, input.reviewRevision
        );
      this.insertReviewTransition({
        reviewSessionId: input.reviewSessionId,
        event: "state_computed",
        fromStatus: input.fromStatus,
        toStatus: parsedState.status,
        accountId: account.id,
        reason: reasonForReviewState(parsedState),
        transitionedAt: input.recordedAt
      });
      this.db
        .prepare(
          `UPDATE review_sessions
           SET current_status = ?, account_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(parsedState.status, account.id, input.recordedAt, input.reviewSessionId);
    });
  }

  async listReviewActivity(filter: ReviewActivityListFilter): Promise<ReviewActivityListResult> {
    const from = parseOptionalIsoTimestamp(filter.from, "from"), to = parseOptionalIsoTimestamp(filter.to, "to");
    assertDateRange(from, to);
    const limit = normalizeListLimit(filter.limit), scope = this.resolveReviewActivityScope(filter);
    if (scope.accountId === undefined) return reviewActivityListResult(scope, from, to, [], false, 0);
    const base = reviewSessionWhere(scope.accountId, from, to, filter.reviewStatus);
    let where = base.whereSql; const params = [...base.params];
    if (filter.requestStatus !== undefined) { where += " AND r.request_status=?"; params.push(transactionRequestStatusSchema.parse(filter.requestStatus)); }
    if (filter.executionStatus !== undefined) { where += " AND e.status=?"; params.push(z.enum(["success", "failure"]).parse(filter.executionStatus)); }
    const joins = `FROM review_sessions rs JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id=rs.account_id
      LEFT JOIN review_requests r ON r.attempt_id=rs.current_attempt_id AND r.review_session_id=rs.id AND r.account_id=rs.account_id
      LEFT JOIN review_executions e ON e.attempt_id=r.attempt_id`;
    const count = (this.db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).get(...params) as CountRow).count;
    const rows = this.db.prepare(`SELECT rs.id AS review_session_id, rs.plan_id, rs.action_kind, rs.adapter_id, rs.protocol,
      rs.current_status, rs.current_attempt_id, a.address AS account, rs.created_at, rs.updated_at,
      e.status AS execution_status, e.tx_digest,
      (SELECT COUNT(*) FROM review_state_snapshots s WHERE s.review_session_id=rs.id) AS snapshot_count,
      (SELECT COUNT(*) FROM review_status_transitions t WHERE t.review_session_id=rs.id) AS transition_count
      ${joins} ${where} ORDER BY rs.created_at DESC,rs.id DESC LIMIT ?`).all(...params, limit + 1) as ReviewActivityListRow[];
    const activities = rows.slice(0, limit).map((row) => {
      const request = row.current_attempt_id ? this.readRequestEvidence(row.current_attempt_id, row.review_session_id, row.account) : undefined;
      return reviewActivityRowFromStorage(row, request);
    });
    return reviewActivityListResult(scope, from, to, activities, rows.length > limit, count);
  }

  async summarizeReviewFunnel(filter: ReviewActivityFilter): Promise<ReviewFunnelSummaryResult> {
    const from = parseOptionalIsoTimestamp(filter.from, "from"), to = parseOptionalIsoTimestamp(filter.to, "to");
    assertDateRange(from, to);
    const scope = this.resolveReviewActivityScope(filter), summary = emptyReviewFunnelSummary();
    if (scope.accountId === undefined) return reviewFunnelResult(scope, from, to, summary, 0);
    const { whereSql: where, params } = reviewSessionWhere(scope.accountId, from, to);
    const totals = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN rs.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN r.attempt_id IS NULL THEN 1 ELSE 0 END) AS without_request,
      SUM(CASE WHEN e.attempt_id IS NULL THEN 1 ELSE 0 END) AS without_execution,
      SUM(CASE WHEN rs.current_status='expired' AND NOT EXISTS (SELECT 1 FROM review_executions x WHERE x.review_session_id=rs.id) THEN 1 ELSE 0 END) AS expired_without_execution
      FROM review_sessions rs LEFT JOIN review_requests r ON r.attempt_id=rs.current_attempt_id AND r.review_session_id=rs.id
      LEFT JOIN review_executions e ON e.attempt_id=r.attempt_id ${where}`).get(...params) as {
        total: number; opened: number | null; without_request: number | null; without_execution: number | null; expired_without_execution: number | null;
      };
    summary.total = totals.total; summary.opened = totals.opened ?? 0;
    summary.withoutRequest = totals.without_request ?? 0; summary.withoutExecutionResult = totals.without_execution ?? 0;
    summary.expiredWithoutExecutionResult = totals.expired_without_execution ?? 0;
    const eventCounts = this.db.prepare(`SELECT t.event AS key,COUNT(DISTINCT t.review_session_id) AS count
      FROM review_status_transitions t JOIN review_sessions rs ON rs.id=t.review_session_id ${where} AND t.domain='review' GROUP BY t.event`)
      .all(...params) as KeyCountRow[];
    summary.walletConnected = eventCounts.find((row) => row.key === "wallet_connected")?.count ?? 0;
    summary.stateComputed = eventCounts.find((row) => row.key === "state_computed")?.count ?? 0;
    summary.reviewStatusCounts = countMap(INTERNAL_SESSION_STATUSES, this.db.prepare(`SELECT rs.current_status AS key,COUNT(*) AS count FROM review_sessions rs ${where} GROUP BY rs.current_status`).all(...params) as KeyCountRow[]);
    const requestCounts = countMap(TRANSACTION_REQUEST_STATUSES, this.db.prepare(`SELECT r.request_status AS key,COUNT(*) AS count FROM review_sessions rs
      JOIN review_requests r ON r.attempt_id=rs.current_attempt_id AND r.review_session_id=rs.id ${where} GROUP BY r.request_status`).all(...params) as KeyCountRow[]);
    summary.requestStatusCounts = TRANSACTION_REQUEST_STATUSES.map((requestStatus) => ({ requestStatus, count: requestCounts[requestStatus] }));
    summary.executionStatusCounts = countMap(["success", "failure"] as const, this.db.prepare(`SELECT e.status AS key,COUNT(*) AS count FROM review_sessions rs
      JOIN review_executions e ON e.attempt_id=rs.current_attempt_id AND e.review_session_id=rs.id ${where} GROUP BY e.status`).all(...params) as KeyCountRow[]);
    summary.everReachedReviewStateCounts = countMap(REVIEW_STATE_STATUSES, this.db.prepare(`SELECT t.to_status AS key,COUNT(DISTINCT rs.id) AS count
      FROM review_status_transitions t JOIN review_sessions rs ON rs.id=t.review_session_id ${where} AND t.domain='review'
      AND t.to_status IN ('ready_for_wallet_review','blocked','refresh_required') GROUP BY t.to_status`).all(...params) as KeyCountRow[]);
    summary.everAwaitedChainResult = (this.db.prepare(`SELECT COUNT(DISTINCT rs.id) AS count FROM review_status_transitions t
      JOIN review_sessions rs ON rs.id=t.review_session_id ${where} AND t.domain='request' AND t.to_status='awaiting_chain_result'`).get(...params) as CountRow).count;
    const timing = this.db.prepare(`SELECT AVG((julianday(first.verified_at)-julianday(rs.created_at))*86400.0) AS created,
      AVG(CASE WHEN rs.opened_at IS NULL THEN NULL ELSE (julianday(first.verified_at)-julianday(rs.opened_at))*86400.0 END) AS opened
      FROM review_sessions rs JOIN (SELECT review_session_id,MIN(signature_verified_at) AS verified_at FROM review_requests
      WHERE signature_verified_at IS NOT NULL GROUP BY review_session_id) first ON first.review_session_id=rs.id ${where}`)
      .get(...params) as { created: number | null; opened: number | null };
    summary.avgCreatedToSignatureVerifiedSeconds = nullableSeconds(timing.created);
    summary.avgOpenedToSignatureVerifiedSeconds = nullableSeconds(timing.opened);
    const inconsistent = this.db.prepare(`SELECT rs.id FROM review_sessions rs LEFT JOIN review_requests r ON r.attempt_id=rs.current_attempt_id
      LEFT JOIN review_executions e ON e.attempt_id=r.attempt_id ${where} AND
      ((rs.current_attempt_id IS NOT NULL AND (r.attempt_id IS NULL OR r.review_session_id!=rs.id OR r.account_id!=rs.account_id)) OR
       (r.request_status='completed' AND e.attempt_id IS NULL) OR (e.attempt_id IS NOT NULL AND
       (r.request_status!='completed' OR e.tx_digest!=r.transaction_digest OR json_valid(e.result_json)=0))) LIMIT 1`).get(...params);
    if (inconsistent) throw new ActivityStoreReadError("internal_error", "Stored review request evidence is inconsistent.", { reason: "invalid_stored_evidence" });
    // Aggregation must not turn a malformed current result into a valid count.
    for (const row of this.db.prepare(`SELECT rs.id,rs.current_attempt_id,a.address AS account
      FROM review_sessions rs JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id=rs.account_id ${where} AND rs.current_attempt_id IS NOT NULL`)
      .all(...params) as { id: string; current_attempt_id: string; account: string }[]) {
      this.readRequestEvidence(row.current_attempt_id, row.id, row.account);
    }
    return reviewFunnelResult(scope, from, to, summary, summary.total);
  }

  private readRequestEvidence(id: string, reviewSessionId: string, account: string) {
    try {
      const request = readStoredTransactionRequest(this.db, id);
      if (!request || request.reviewSessionId !== reviewSessionId || request.account !== account) throw new Error("Request identity mismatch");
      return request;
    } catch {
      throw new ActivityStoreReadError("internal_error", "Stored review request evidence is invalid.", { reason: "invalid_stored_evidence", reviewSessionId });
    }
  }

  async getReviewSessionDetail(input: ReviewSessionDetailInput): Promise<ReviewSessionDetailResult> {
    const scope = this.resolveReviewActivityScope({ account: input.account });
    const row = scope.accountId === undefined ? undefined : this.db.prepare(`SELECT rs.*, a.address AS account
      FROM review_sessions rs JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id=rs.account_id WHERE rs.id=? AND rs.account_id=?`)
      .get(input.reviewSessionId, scope.accountId) as { id: string; plan_id: string; action_kind: string; adapter_id: string; protocol: string;
        current_status: string; current_attempt_id: string | null; created_at: string; updated_at: string; account: string; plan_json: string; intent_json: string | null } | undefined;
    if (!row) throw new ActivityStoreReadError("session_not_found", "Review session not found", { reviewSessionId: input.reviewSessionId });
    const snapshots = this.db.prepare(`SELECT s.*,a.address AS account FROM review_state_snapshots s JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id=s.account_id
      WHERE s.review_session_id=? AND s.account_id=? ORDER BY s.recorded_at,s.id LIMIT ?`)
      .all(input.reviewSessionId, scope.accountId, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS + 1) as ReviewStateSnapshotRow[];
    const transitions = this.db.prepare(`SELECT t.*,a.address AS account FROM review_status_transitions t LEFT JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id=t.account_id
      WHERE t.review_session_id=? AND (t.account_id IS NULL OR t.account_id=?) ORDER BY t.transitioned_at,t.id LIMIT ?`)
      .all(input.reviewSessionId, scope.accountId, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS + 1) as ReviewTransitionRow[];
    const requestIds = this.db.prepare(`SELECT attempt_id FROM review_requests WHERE review_session_id=? AND account_id=? ORDER BY created_at,attempt_id LIMIT ?`)
      .all(input.reviewSessionId, scope.accountId, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS + 1) as { attempt_id: string }[];
    const requestCount = (this.db.prepare("SELECT COUNT(*) AS count FROM review_requests WHERE review_session_id=? AND account_id=?")
      .get(input.reviewSessionId, scope.accountId) as CountRow).count;
    const recordCount = (this.db.prepare("SELECT COUNT(*) AS count FROM review_sessions WHERE account_id=?").get(scope.accountId) as CountRow).count;
    const request = row.current_attempt_id ? this.readRequestEvidence(row.current_attempt_id, row.id, row.account) : undefined;
    return {
      dataScope: { account: scope.account, recordCount }, accountSource: scope.accountSource,
      lowSampleWarning: recordCount < REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD, lowSampleThreshold: REVIEW_ACTIVITY_LOW_SAMPLE_THRESHOLD,
      session: { reviewSessionId: row.id, planId: row.plan_id, actionKind: row.action_kind, adapterId: row.adapter_id,
        protocol: row.protocol, reviewStatus: asInternalSessionStatus(row.current_status), account: row.account,
        createdAt: row.created_at, updatedAt: row.updated_at, ...(request ? { currentAttemptId: request.attemptId } : {}) },
      planJson: parseEvidenceJson<ActionPlan>(row.plan_json, row.id, "plan_json", actionPlanSchema),
      ...(row.intent_json === null ? {} : { intentJson: parseEvidenceJson<unknown>(row.intent_json, row.id, "intent_json") }),
      stateSnapshots: snapshots.slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS).map((snapshot) => ({
        id: snapshot.id, reviewRevision: snapshot.review_revision, planId: snapshot.plan_id, account: snapshot.account, status: snapshot.status,
        blockedReason: snapshot.blocked_reason ?? undefined, refreshReason: snapshot.refresh_reason ?? undefined,
        stateJson: this.parseReviewStateEvidenceJson(snapshot.state_json, row.id, "state_json"),
        updatedAt: snapshot.updated_at, recordedAt: snapshot.recorded_at })),
      transitions: transitions.slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS).map((event) => ({
        id: event.id, event: asReviewTransitionEvent(event.event), domain: event.domain,
        ...(event.attempt_id === null ? {} : { attemptId: event.attempt_id }),
        fromStatus: event.from_status ?? undefined, toStatus: event.to_status, isNoOp: event.from_status === event.to_status,
        account: event.account ?? undefined, reason: event.reason ?? undefined, transitionedAt: event.transitioned_at })),
      ...(request ? { request } : {}), requestCount,
      requests: requestIds.slice(0, REVIEW_ACTIVITY_DETAIL_MAX_ITEMS).map(({ attempt_id }) => this.readRequestEvidence(attempt_id, row.id, row.account)),
      truncated: { activities: false, snapshots: snapshots.length > REVIEW_ACTIVITY_DETAIL_MAX_ITEMS,
        transitions: transitions.length > REVIEW_ACTIVITY_DETAIL_MAX_ITEMS, requests: requestIds.length > REVIEW_ACTIVITY_DETAIL_MAX_ITEMS }
    };
  }

  findScanPredecessor(q: import("./activityStore.js").ScanContinuationQuery): ExternalActivityScanRecord | undefined {
    const previous = this.externalActivityScanById(q.scanId);
    if (!previous?.hasMore || !previous.responseCursor || !previous.continuity?.sourceLower) return undefined;
    const keys = ["accountId", "kind", "relationship", "functionTarget", "fromCheckpoint", "toCheckpoint",
      "fromTimestamp", "toTimestamp", "chainIdentifier", "endpointHost"] as const;
    return keys.every(key => previous[key] === q[key]) ? previous : undefined;
  }

  async recordExternalActivityScan(input: ExternalActivityScanInput): Promise<ExternalActivityScanRecord> {
    try {
      assertNoForbiddenMcpFields(input);
    } catch {
      throw new ActivityStoreReadError("input_invalid", "External activity scan contains forbidden fields", {
        reason: "forbidden_field"
      });
    }
    if (input.kind === "function_scan" && (!input.functionTarget || parseSuiFunctionTarget(input.functionTarget).target !== input.functionTarget)) {
      throw new ActivityStoreReadError("input_invalid", "Missing normalized function scan target", { reason: "invalid_scan_function" });
    }
    const account = await this.getKnownAccount(input.account);
    if (!account) {
      throw new ActivityStoreReadError("input_invalid", "External activity scan account is not a known wallet", {
        reason: "account_not_known"
      });
    }
    const completion = input.kind !== "digest_lookup" && input.windowComplete === true ? windowCompletion(input) : input.windowComplete;
    const fetchedAt = parseIsoTimestamp(input.fetchedAt, "fetchedAt");
    const fromTimestamp = parseOptionalIsoTimestamp(input.fromTimestamp, "from");
    const toTimestamp = parseOptionalIsoTimestamp(input.toTimestamp, "to");
    assertDateRange(fromTimestamp, toTimestamp);
    const record = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO external_activity_scans
             (scan_id, kind, account_id, relationship, input_digest, continuity_json, source_upper_timestamp, source_upper_checkpoint, function_target, from_checkpoint, to_checkpoint,
              from_timestamp, to_timestamp, limit_count, request_cursor, response_cursor, endpoint_host,
              chain_identifier, fetched_at, stored_count, skipped_count, has_more, window_complete,
              incomplete_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.scanId,
          input.kind,
          account.id,
          input.relationship,
          input.inputDigest ?? null, input.continuity ? JSON.stringify(input.continuity) : null,
          input.sourceUpperTimestamp ?? null, input.sourceUpperCheckpoint ?? null,
          input.functionTarget ?? null,
          input.fromCheckpoint ?? null,
          input.toCheckpoint ?? null,
          fromTimestamp ?? null,
          toTimestamp ?? null,
          input.limit,
          input.requestCursor ?? null,
          input.responseCursor ?? null,
          input.endpointHost,
          input.chainIdentifier,
          fetchedAt,
          0,
          input.transactions.length,
          input.hasMore ? 1 : 0,
          completion === null ? null : Number(completion),
          input.incompleteReason ?? null
        );

      const observedDigests = new Set<string>();
      const outsideFilter = input.outsideFilterCount ?? 0, unconfirmedRelation = input.unconfirmedRelationCount ?? 0;
      // Each bit denotes an immutable scalar for this account and digest.
      const fields = [["checkpoint", 1], ["timestamp", 2], ["known_sender_account_id", 4]] as const;
      const disagrees = (field: string) => `excluded.${field} IS NOT NULL AND external_activity_transactions.${field} IS NOT NULL AND
        excluded.${field} != external_activity_transactions.${field}`;
      const metadataUpdates = fields.map(([field, bit]) => `${field} = CASE WHEN
        (metadata_conflicts & ${bit}) != 0 OR (${disagrees(field)}) THEN NULL ELSE COALESCE(excluded.${field},external_activity_transactions.${field}) END`).join(", ");
      const metadataConflicts = fields.map(([field,bit]) => `CASE WHEN ${disagrees(field)} THEN ${bit} ELSE 0 END`).join(" | ");
      const upsert = this.db.prepare(
        `INSERT INTO external_activity_transactions
           (account_id, digest, relationship, checkpoint, timestamp, status, known_sender_account_id,
            first_scan_id, last_scan_id, first_fetched_at, last_fetched_at, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, digest) DO UPDATE SET
           relationship = CASE WHEN excluded.relationship='sent' THEN 'sent' ELSE external_activity_transactions.relationship END,
           ${metadataUpdates},
           metadata_conflicts = metadata_conflicts | ${metadataConflicts},
           status = CASE WHEN external_activity_transactions.status_conflict THEN 'unknown' WHEN excluded.status='unknown' THEN external_activity_transactions.status WHEN external_activity_transactions.status IN (excluded.status,'unknown') THEN excluded.status ELSE 'unknown' END,
           status_conflict = external_activity_transactions.status_conflict OR (excluded.status!='unknown' AND external_activity_transactions.status NOT IN ('unknown',excluded.status)),
           first_scan_id = CASE WHEN excluded.first_fetched_at < external_activity_transactions.first_fetched_at THEN excluded.first_scan_id ELSE external_activity_transactions.first_scan_id END,
           first_fetched_at = min(external_activity_transactions.first_fetched_at,excluded.first_fetched_at),
           last_scan_id = CASE WHEN excluded.last_fetched_at >= external_activity_transactions.last_fetched_at THEN excluded.last_scan_id ELSE external_activity_transactions.last_scan_id END,
           last_fetched_at = max(external_activity_transactions.last_fetched_at,excluded.last_fetched_at),
           detail_json = COALESCE(excluded.detail_json, external_activity_transactions.detail_json)`
      );
      const validatedSenders = new Set<number>();
      const observe = this.db.prepare("INSERT INTO external_activity_observations(scan_id,account_id,digest,detail_status) VALUES(?,?,?,?) ON CONFLICT(scan_id,digest) DO UPDATE SET detail_status=CASE WHEN external_activity_observations.detail_status='available' THEN 'available' ELSE excluded.detail_status END");
      const existing = this.db.prepare("SELECT detail_json FROM external_activity_transactions WHERE account_id=? AND digest=?");
      for (const transaction of input.transactions) {
        if (transaction.knownSenderAccountId !== undefined && !validatedSenders.has(transaction.knownSenderAccountId) && !this.accountIdExists(transaction.knownSenderAccountId)) {
          throw new ActivityStoreReadError("input_invalid", "External activity sender account is not known", {
            reason: "sender_account_not_known"
          });
        }
        if (transaction.knownSenderAccountId !== undefined) validatedSenders.add(transaction.knownSenderAccountId);
        if (input.kind === "digest_lookup" && input.inputDigest !== transaction.digest) {
          throw new ActivityStoreReadError("input_invalid", "Digest lookup disagrees with its observation", { reason: "digest_lookup_mismatch" });
        }
        let detailJson: string | null = null, detailStatus = "missing";
        if (transaction.details) {
          try {
            detailJson = serializeExternalActivityTransactionDetail(transaction.details, account.address);
            const prior = existing.get(account.id, transaction.digest) as { detail_json: string | null } | undefined;
            if (prior?.detail_json) detailJson = serializeExternalActivityTransactionDetail(
              mergeActivityDetails(JSON.parse(prior.detail_json), JSON.parse(detailJson)), account.address);
            detailStatus = "available";
          } catch (error) {
            if (!(error instanceof ActivityStoreReadError) || error.details.reason !== "external_activity_detail_too_large") throw error;
            detailJson = null;
            detailStatus = "size_limit";
          }
        }
        upsert.run(
          account.id,
          transaction.digest,
          transaction.relationship,
          transaction.checkpoint ?? null,
          transaction.timestamp ? parseIsoTimestamp(transaction.timestamp, "transaction.timestamp") : null,
          transaction.status,
          transaction.knownSenderAccountId ?? null,
          input.scanId,
          input.scanId,
          fetchedAt,
          fetchedAt,
          detailJson
        );
        observe.run(input.scanId, account.id, transaction.digest, detailStatus);
        observedDigests.add(transaction.digest);
      }
      this.db
        .prepare(
          `UPDATE external_activity_scans
           SET stored_count = ?, skipped_count = ?, outside_filter_count = ?, unconfirmed_relation_count = ?
           WHERE scan_id = ?`
        )
        .run(observedDigests.size, outsideFilter + unconfirmedRelation + input.transactions.length - observedDigests.size, outsideFilter, unconfirmedRelation, input.scanId);
      return this.externalActivityScanById(input.scanId);
    })();
    if (!record) {
      throw new ActivityStoreReadError("internal_error", "External activity scan was not recorded", {
        scanId: input.scanId
      });
    }
    return record;
  }

  withActivityWindow<T>(filter: ExternalActivityTransactionStreamFilter, bind: (window: ActivityWindowBinding) => T): T {
    // bind can schedule asynchronous work, but the selected rows are captured
    // before this read transaction returns. Never keep SQLite open across RPC.
    const { result } = this.db.transaction(() => {
      const scope = this.resolveReviewActivityScope(filter);
      const row = this.db.prepare("SELECT user_data_revision FROM settings_control WHERE id=1").get() as { user_data_revision: number };
      const result = bind({ account: scope.account, revision: row.user_data_revision, load: () => {
        const coverage = this.getExternalActivityCoverageSync(filter, scope);
        const activityTransactions = this.listExternalActivityEffectTransactionsSync(filter, scope, coverage.storedTransactionCount);
        return { coverage, activityTransactions };
      } });
      return { result };
    })();
    return result;
  }

  async getExternalActivityCoverage(filter: ExternalActivityCoverageFilter): Promise<ExternalActivityCoverageResult> {
    return this.db.transaction(() => this.getExternalActivityCoverageSync(filter))();
  }

  private getExternalActivityCoverageSync(filter: ExternalActivityCoverageFilter, scope = this.resolveReviewActivityScope(filter)): ExternalActivityCoverageResult {
    const from = parseIsoTimestamp(filter.from, "from");
    const to = parseIsoTimestamp(filter.to, "to");
    assertDateRange(from, to);
    assertNonEmptyHalfOpenRange(from, to);

    if (scope.accountId === undefined) {
      return buildExternalActivityCoverageResult({
        scope,
        from,
        to,
        scans: [],
        scanCount: 0,
        storedTransactionCount: 0
      });
    }

    const scanWhereSql = `
      WHERE eas.account_id = ?
        AND (eas.from_timestamp IS NULL OR eas.from_timestamp < ?)
        AND (eas.to_timestamp IS NULL OR eas.to_timestamp >= ?)`;
    const scanParams = [scope.accountId, to, from] as const;
    const scanCount = (this.db
      .prepare(`SELECT COUNT(*) AS count FROM external_activity_scans eas ${scanWhereSql}`)
      .get(...scanParams) as CountRow).count;
    const scanRows = this.db
      .prepare(
        `SELECT eas.scan_id, eas.kind, eas.account_id, a.address AS account, eas.relationship,
                eas.input_digest, eas.continuity_json, eas.source_upper_timestamp, eas.source_upper_checkpoint, eas.function_target, eas.from_checkpoint, eas.to_checkpoint, eas.from_timestamp,
                eas.to_timestamp, eas.limit_count, eas.request_cursor, eas.response_cursor,
                eas.endpoint_host, eas.chain_identifier, eas.fetched_at, eas.stored_count,
                eas.skipped_count, eas.outside_filter_count, eas.unconfirmed_relation_count, eas.has_more, eas.window_complete, eas.incomplete_reason
         FROM external_activity_scans eas
         JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id = eas.account_id
         ${scanWhereSql}
         ORDER BY eas.fetched_at DESC, eas.scan_id DESC
         LIMIT ?`
      )
      .all(...scanParams, EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS + 1) as ExternalActivityScanRow[];
    const scansTruncated = scanRows.length > EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS;
    const scans = scanRows
      .slice(0, EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS)
      .map(externalActivityScanFromRow);

    const transactionWhereSql = "WHERE eat.account_id = ? AND eat.timestamp >= ? AND eat.timestamp < ?";
    const transactionParams = [scope.accountId, from, to] as const;
    const aggregate = this.db.prepare(`SELECT count(*) AS count, min(timestamp) AS firstTime, max(timestamp) AS lastTime,
      min(CASE WHEN checkpoint IS NOT NULL THEN printf('%02d',length(checkpoint))||checkpoint END) AS firstCheckpoint,
      max(CASE WHEN checkpoint IS NOT NULL THEN printf('%02d',length(checkpoint))||checkpoint END) AS lastCheckpoint
      FROM external_activity_transactions eat ${transactionWhereSql}`).get(...transactionParams) as {
        count: number; firstTime: string; lastTime: string; firstCheckpoint: string | null; lastCheckpoint: string | null };
    const storedTransactionCount = aggregate.count;
    const transactionsWithoutTime = (this.db.prepare("SELECT count(*) AS count FROM external_activity_transactions WHERE account_id=? AND timestamp IS NULL").get(scope.accountId) as CountRow).count;
    const storedTransactionRange = aggregate.count ? { earliestTimestamp: aggregate.firstTime, latestTimestamp: aggregate.lastTime,
      earliestCheckpoint: aggregate.firstCheckpoint?.slice(2), latestCheckpoint: aggregate.lastCheckpoint?.slice(2) } : undefined;
    // A proof can precede the displayed scans. Stream matching candidates until
    // the public evidence limit is reached, using the ordinary stored-scan reader.
    const candidates = this.db.prepare(`SELECT eas.*, a.address AS account FROM external_activity_scans eas
      JOIN accounts a ON a.id=eas.account_id
      WHERE eas.account_id=? AND eas.kind='account_scan' AND eas.relationship='affected'
      AND eas.window_complete=1 AND eas.from_checkpoint IS NULL AND eas.to_checkpoint IS NULL
      AND eas.from_timestamp<=? AND eas.to_timestamp>=? ORDER BY eas.fetched_at DESC, eas.scan_id DESC`)
      .iterate(scope.accountId, from, to) as Iterable<ExternalActivityScanRow>;
    const proofIds: string[] = [];
    for (const row of candidates) {
      const scan = externalActivityScanFromRow(row);
      if (scanCompletesAffectedAccountRange(scan, from, to)) proofIds.push(scan.scanId);
      if (proofIds.length === EXTERNAL_ACTIVITY_COVERAGE_SCAN_MAX_RECORDS) break;
    }
    return buildExternalActivityCoverageResult({
      scope,
      from,
      to,
      scans,
      scanCount,
      transactionsWithoutTime, storedTransactionCount,
      storedTransactionRange,
      scansTruncated, proofIds
    });
  }

  async listExternalActivityEffectTransactions(
    filter: ExternalActivityTransactionStreamFilter
  ): Promise<ExternalActivityTransactionStreamResult> {
    return this.db.transaction(() => this.listExternalActivityEffectTransactionsSync(filter))();
  }

  private listExternalActivityEffectTransactionsSync(filter: ExternalActivityTransactionStreamFilter, scope = this.resolveReviewActivityScope(filter), knownCount?: number): ExternalActivityTransactionStreamResult {
    const from = parseIsoTimestamp(filter.from, "from");
    const to = parseIsoTimestamp(filter.to, "to");
    assertDateRange(from, to);
    assertNonEmptyHalfOpenRange(from, to);
    const limit = normalizeExternalActivityLimit(filter.limit);

    if (scope.accountId === undefined) {
      return buildExternalActivityTransactionStreamResult({
        scope,
        from,
        to,
        transactions: [],
        truncated: false,
        transactionCount: 0
      });
    }

    const whereSql = "WHERE eat.account_id = ? AND eat.timestamp >= ? AND eat.timestamp < ?";
    const params = [scope.accountId, from, to];
    const total = knownCount ?? (this.db.prepare(`SELECT count(*) AS count FROM external_activity_transactions eat ${whereSql}`).get(...params) as CountRow).count;
    const rows = this.externalActivityTransactions(whereSql, params, limit);
    return buildExternalActivityTransactionStreamResult({
      scope,
      from,
      to,
      transactions: rows,
      truncated: total > rows.length,
      transactionCount: total
    });
  }

  async summarizeExternalActivity(filter: ExternalActivitySummaryFilter): Promise<ExternalActivitySummaryResult> {
    return this.db.transaction(() => this.summarizeExternalActivitySync(filter))();
  }

  private summarizeExternalActivitySync(filter: ExternalActivitySummaryFilter): ExternalActivitySummaryResult {
    const from = parseOptionalIsoTimestamp(filter.from, "from");
    const to = parseOptionalIsoTimestamp(filter.to, "to");
    assertDateRange(from, to);
    const limit = normalizeExternalActivityLimit(filter.limit);
    const scope = this.resolveReviewActivityScope(filter);

    if (scope.accountId === undefined) {
      return externalActivitySummaryResult(scope, from, to, [], false, emptyExternalActivitySummaryStats());
    }

    const where: string[] = ["eat.account_id = ?"];
    const params: unknown[] = [scope.accountId];
    if (from !== undefined) {
      where.push("eat.timestamp >= ?");
      params.push(from);
    }
    if (to !== undefined) {
      where.push("eat.timestamp <= ?");
      params.push(to);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS count FROM external_activity_transactions eat ${whereSql}`)
      .get(...params) as CountRow).count;
    const statusCounts = countMap(
      EXTERNAL_ACTIVITY_STATUSES,
      this.db
        .prepare(`SELECT eat.status AS key, COUNT(*) AS count FROM external_activity_transactions eat ${whereSql} GROUP BY eat.status`)
        .all(...params) as KeyCountRow[]
    );
    const relationships = this.db.prepare(`SELECT eas.relationship AS key, COUNT(DISTINCT eat.digest) AS transactions,
      COUNT(*) AS observations FROM external_activity_transactions eat
      JOIN external_activity_observations o ON o.account_id=eat.account_id AND o.digest=eat.digest
      JOIN external_activity_scans eas ON eas.scan_id=o.scan_id ${whereSql} GROUP BY eas.relationship`)
      .all(...params) as { key: string; transactions: number; observations: number }[];
    const relationshipCounts = countMap(EXTERNAL_ACTIVITY_RELATIONSHIPS, relationships.map(r => ({ key: r.key, count: r.transactions })));
    const relationshipObservationCounts = countMap(EXTERNAL_ACTIVITY_RELATIONSHIPS, relationships.map(r => ({ key: r.key, count: r.observations })));
    const timestampRow = this.db
      .prepare(
        `SELECT MIN(eat.timestamp) AS earliest_timestamp, MAX(eat.timestamp) AS latest_timestamp
         FROM external_activity_transactions eat
         ${whereSql}`
      )
      .get(...params) as { earliest_timestamp: string | null; latest_timestamp: string | null };
    const rows = this.db
      .prepare(
        `SELECT eat.account_id, a.address AS account, eat.digest, eat.relationship,
                eat.checkpoint, eat.timestamp, eat.status, eat.metadata_conflicts, eat.known_sender_account_id,
                eat.first_scan_id, eat.last_scan_id, eat.first_fetched_at, eat.last_fetched_at,
                last_scan.incomplete_reason AS last_scan_incomplete_reason,
                eat.detail_json,
                (SELECT count(*) FROM external_activity_observations o WHERE o.account_id=eat.account_id AND o.digest=eat.digest) AS observation_count,
                (SELECT detail_status FROM external_activity_observations o WHERE o.scan_id=eat.last_scan_id AND o.digest=eat.digest) AS last_detail_status
         FROM external_activity_transactions eat
         JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id = eat.account_id
         LEFT JOIN external_activity_scans last_scan ON last_scan.scan_id = eat.last_scan_id
         ${whereSql}
         ORDER BY
           CASE WHEN eat.checkpoint IS NULL THEN 0 ELSE 1 END DESC,
           CAST(eat.checkpoint AS INTEGER) DESC,
           COALESCE(eat.timestamp, '') DESC,
           eat.digest DESC
         LIMIT ?`
      )
      .all(...params, limit + 1) as ExternalActivityTransactionRow[];
    return externalActivitySummaryResult(
      scope,
      from,
      to,
      rows.slice(0, limit).map(externalActivityTransactionFromRow),
      rows.length > limit,
      {
        transactionCount: total,
        statusCounts,
        relationshipCounts, relationshipObservationCounts,
        earliestTimestamp: timestampRow.earliest_timestamp ?? undefined,
        latestTimestamp: timestampRow.latest_timestamp ?? undefined
      }
    );
  }

  close(): void {
    this.db.close();
  }

  createPreferencesRepository(): SqlitePreferencesRepository {
    return new SqlitePreferencesRepository(this.db);
  }

  createLocalDataService(options: SqliteLocalDataServiceOptions): SqliteLocalDataService {
    return new SqliteLocalDataService(this.db, options, this.validateAdapterLifecycle);
  }

  createCoinMetadataCache(): CoinMetadataCache {
    return new SqliteCoinMetadataCache(this.db);
  }

  createTransactionMaterialStore(): LocalTransactionMaterialStore {
    return new SqliteTransactionMaterialStore(this.db);
  }

  createSessionRecordStore(): SessionRecordStore {
    return new SqliteSessionRecordStore(this.db, { usesActivityStoreLiveSessionMutations: true });
  }

  createCardRecordStore(): SqliteCardRecordStore {
    return new SqliteCardRecordStore(this.db);
  }

  createSettingsWorkflowStore(ownerId: string, now: () => Date = () => new Date()): SqliteSettingsWorkflowStore {
    return new SqliteSettingsWorkflowStore(this.db, ownerId, now);
  }

  createPrivateReviewArtifactStore(): PrivateReviewArtifactStore {
    return new SqlitePrivateReviewArtifactStore(this.db);
  }

  createWalletWorkflowStore(ownerId: string, clock: () => Date = () => new Date(),
    readSdkSnapshot: () => import("../session/walletRuntime.js").WalletSnapshot | undefined = () => undefined): SqliteWalletWorkflowStore {
    const records: SqliteWalletWorkflowStore = new SqliteWalletWorkflowStore(this.db, ownerId,
      this.chainAccounts, clock, this.createTransactionMaterialStore(),
      (input, at) => this.reconcileWorkflowState(input, records, ownerId, at === undefined ? clock : () => at),
      readSdkSnapshot);
    return records;
  }

  finalizeReviewEvaluation(candidate: ReviewEvaluationCandidate, clock: () => Date): ReviewEvaluation {
    return this.db.transaction(() => this.finalizeReviewEvaluationAt(candidate, clock())).immediate();
  }

  private finalizeReviewEvaluationAt(candidate: ReviewEvaluationCandidate, now: Date): ReviewEvaluation {
    const row = this.liveReviewSessionRow(candidate.session.id);
    if (!row) throw new SessionStoreError("session_not_found", "The saved review is unavailable.");
    const current = sessionFromLiveReviewSessionRow(row);
    const artifacts = this.createPrivateReviewArtifactStore().get(current.id);
    const admitted = this.createSessionRecordStore().hasAdmittedRevision(current.id, current.reviewRevision);
    const material = !admitted && !current.preparationId && artifacts?.transactionMaterial
      ? this.createTransactionMaterialStore().getTransactionMaterial(artifacts.transactionMaterial, now) : undefined;
    if (!admitted && !current.preparationId && artifacts && !material && !needsReviewMaterial(current, admitted)) {
      this.createTransactionMaterialStore().deleteReviewSessionTransactionMaterials(current.id);
      this.createPrivateReviewArtifactStore().delete(current.id);
    }
    const next = decideReviewEvaluation(candidate, current, row.revision, artifacts, material, admitted, now);
    if (next === current) return { session: current, events: [] };
    const live = { expected: current, next, deleteTransactionMaterials: true };
    const committed = next.status === "expired"
      ? this.recordReviewTransitionWithLiveSessionSync({ reviewSessionId: current.id, event: "expired", fromStatus: current.status,
          toStatus: next.status, transitionedAt: now.toISOString() }, live)
      : this.recordReviewStateSnapshotWithLiveSessionSync({ reviewSessionId: current.id, fromStatus: current.status,
          state: next.reviewState!, reviewRevision: next.reviewRevision, recordedAt: now.toISOString() }, live);
    if (!committed) throw new SessionStoreError("invalid_session_transition", "Review state changed before evaluation committed.");
    return { session: next, events: next.status === "expired" ? [] : [{ type: "state.computed", sessionId: next.id,
      status: next.status, reason: "private_review_artifacts_refresh_required", at: now.toISOString() }] };
  }

  private reconcileWorkflowState(input: WorkflowEvaluationInput, records: SqliteWalletWorkflowStore,
    ownerId: string, clock: () => Date): EvaluatedWorkflowState {
    return this.db.transaction(() => {
      const now = clock();
      if (input.purpose !== "current_wallet" && input.purpose !== "review" ||
          input.purpose === "review" && (!input.readTarget || !input.candidate)) {
        throw new SessionStoreError("input_invalid", "An explicit workflow evaluation target is required.");
      }
      const cards = this.createCardRecordStore();
      let record = input.expectedCard && records.currentCard(input.expectedCard);
      const reviewId = input.purpose === "review" ? input.reviewSessionId : undefined;
      if (record && (input.purpose === "review" ? record.state.kind !== "review" || record.state.input.reviewSessionId !== reviewId : !["connect", "disconnect"].includes(record.state.kind))) {
        throw new SessionStoreError("session_mismatch", "The workflow target does not match this card.");
      }
      const target = reviewId ? records.reviewReadTarget(reviewId, record) : undefined;
      if (input.purpose === "review" && (!target || input.readTarget.reviewSessionId !== target.reviewSessionId ||
          input.readTarget.attemptId !== target.attemptId || !input.readTarget.walletDependent && target.walletDependent)) {
        throw new SessionStoreError("session_mismatch", "The review target changed while its state was being read. Check this review again.");
      }
      let evaluated: ReviewEvaluation | undefined;
      if (input.purpose === "review") {
        if (!input.candidate || input.candidate.session.id !== reviewId) throw new SessionStoreError("session_not_found", "The saved review is unavailable.");
        evaluated = this.finalizeReviewEvaluationAt(input.candidate, now);
        if (input.uiObservation && record?.scope === "review") records.markReviewOpened(reviewId, now);
      }
      if (!target || target.walletDependent) {
        records.advanceRequestDeadlines(now);
        records.expireConnections(now);
      } else records.advanceRequestDeadlines(now, target.attemptId);
      if (record) record = records.expireCard(record, now);
      const session = evaluated?.session;
      const request = target?.attemptId ? records.request(target.attemptId) : undefined;
      const authority = request && records.authority(request.attemptId);
      const details = record && request?.execution && records.executionDetails(request.attemptId);
      const operationRecord = ["connect", "disconnect"].includes(record?.scope ?? "") && record ? records.cardOperation(record) : undefined;
      const operation = operationRecord && publicConnectionOperation(operationRecord);
      const connectionFacts = records.readConnectionFacts(now), reviewTarget = session ? fixedReviewTarget(session, record?.state.input) : undefined;
      const targetAccount = reviewTarget?.account;
      if (record?.scope === "connect" || record?.scope === "disconnect") record = records.reconcileWalletCard(record, connectionFacts);
      if (record?.scope === "review" && record.state.state === "ready") {
        const expired = session?.status === "expired" || !!session && Date.parse(session.expiresAt) <= now.getTime();
        const targetReplaced = !!reviewTarget && !!connectionFacts.connection && connectionFacts.connection.connectionId !== reviewTarget.connectionId;
        const targetAbsent = !!reviewTarget && connectionFacts.connection?.connectionId === reviewTarget.connectionId && connectionFacts.connectionPresence.confirmed &&
          connectionFacts.connectionPresence.observation?.status === "absent";
        if (expired || targetAbsent || targetReplaced) {
          const error = expired ? undefined : targetAbsent
            ? "The wallet session for this review was confirmed absent. Ask in chat for a new transaction review; connect a wallet first if needed."
            : "The original wallet connection is no longer current. Ask in chat for a new transaction review.";
          record = records.endCard(record, expired ? "expired" : "failed", now, error);
        }
      }
      const facts = { ...connectionFacts, ownerId, record, session, request, authority,
        hasReviewInput: !!session && session.status !== "expired" && Date.parse(session.expiresAt) > now.getTime() &&
          cards.hasReviewInput(session.id, ownerId, now),
        walletAvailability: input.walletAvailability,
        operation,
        walletDependent: !target || target.walletDependent,
        boundReview: request && (record?.operationId || record?.scope === "review_manage") ? records.requestReview(request.attemptId) : undefined,
        busyForAccount: !!targetAccount && records.busyForAccount(targetAccount, now),
        receipt: details ? details.data : undefined, receiptDisplay: details ? details.receiptDisplay : undefined };
      return { ...facts, ...workflowEligibility(facts), events: evaluated?.events ?? [] };
    }).immediate();
  }

  private runLiveReviewSessionMutation(
    live: LiveReviewSessionMutation,
    writeActivity: () => void
  ): boolean {
    const stale = new Error("live review session changed before commit");
    try {
      const commit = this.db.transaction(() => {
        const current = this.liveReviewSessionRow(live.next.id);
        if (live.expected ? !current || !isDeepStrictEqual(sessionFromLiveReviewSessionRow(current), live.expected) : !!current) throw stale;
        if (live.firstCard) {
          const { record, assertTarget } = live.firstCard;
          assertTarget();
          if (live.expected || record.ownerId !== live.next.ownerId || record.scope !== "review" ||
              record.state.input.reviewSessionId !== live.next.id) throw stale;
        }
        writeActivity();
        if (!this.applyLiveReviewSessionMutation(live)) throw stale;
        if (live.firstCard) {
          const { record, terminalProjection } = live.firstCard;
          this.createCardRecordStore().create(terminalProjection ? terminalProjection(record) : record);
        }
      });
      commit.immediate();
      return true;
    } catch (error) {
      if (error === stale) {
        return false;
      }
      throw error;
    }
  }

  private applyLiveReviewSessionMutation(live: LiveReviewSessionMutation): boolean {
    if (!live.expected) {
      if (this.liveReviewSessionRow(live.next.id)) {
        return false;
      }
      insertLiveReviewSessionRow(this.db, live.next);
      this.applyLiveReviewSessionSideEffects(live);
      return true;
    }

    const row = this.liveReviewSessionRow(live.next.id);
    if (!row || !isDeepStrictEqual(sessionFromLiveReviewSessionRow(row), live.expected)) {
      return false;
    }
    if (!updateLiveReviewSessionRow(this.db, row.revision, live.next)) {
      return false;
    }
    this.applyLiveReviewSessionSideEffects(live);
    return true;
  }

  private applyLiveReviewSessionSideEffects(live: LiveReviewSessionMutation): void {
    this.db.prepare(`UPDATE live_read_cards SET revision=revision+1 WHERE kind='review' AND state='ready'
      AND json_extract(input_json,'$.reviewSessionId')=?`).run(live.next.id);
    if (live.deleteTransactionMaterials) {
      this.db.prepare(`DELETE FROM live_transaction_materials WHERE review_session_id = ?`).run(live.next.id);
      this.db.prepare(`DELETE FROM live_private_review_artifacts WHERE review_session_id = ?`).run(live.next.id);
    }
    if (live.privateArtifactsJson !== undefined) {
      const current = live.privateArtifactsJson && (JSON.parse(live.privateArtifactsJson) as PrivateReviewArtifacts).transactionMaterial?.materialId;
      this.db.prepare("DELETE FROM live_transaction_materials WHERE review_session_id=? AND material_id IS NOT ?")
        .run(live.next.id, current || null);
    }
    if (live.privateArtifactsJson === null) {
      this.db.prepare(`DELETE FROM live_private_review_artifacts WHERE review_session_id = ?`).run(live.next.id);
    } else if (live.privateArtifactsJson !== undefined) {
      this.db
        .prepare(
          `INSERT INTO live_private_review_artifacts (review_session_id, artifacts_json)
           VALUES (?, ?)
           ON CONFLICT(review_session_id) DO UPDATE SET artifacts_json = excluded.artifacts_json`
        )
        .run(live.next.id, live.privateArtifactsJson);
    }
  }

  private liveReviewSessionRow(id: string): LiveReviewSessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM live_review_sessions WHERE id = ?`)
      .get(id) as LiveReviewSessionRow | undefined;
  }

  private upsertAccountSync(address: string, source: AccountSource, timestamp: string): AccountRecord {
    return this.chainAccounts.upsert(SUI_MAINNET_WALLET_CHAIN, address, source, timestamp);
  }

  private parseReviewStateEvidenceJson(
    value: string | null,
    reviewSessionId: string,
    evidenceField: string
  ): ReviewState {
    const parsed = parseEvidenceJson<ReviewState>(
      value,
      reviewSessionId,
      evidenceField
    );
    try {
      return parseLifecycleValidatedReviewState(parsed, this.validateAdapterLifecycle);
    } catch {
      throw new ActivityStoreReadError("internal_error", "Malformed activity JSON evidence", {
        reviewSessionId,
        evidenceField
      });
    }
  }

  private getAccountByAddressSync(address: string): AccountRecord | undefined {
    return this.chainAccounts.get(SUI_MAINNET_WALLET_CHAIN, address);
  }

  private accountIdExists(accountId: number): boolean {
    const row = this.db.prepare("SELECT id FROM accounts WHERE id = ? AND chain_id=?").get(accountId, SUI_MAINNET_WALLET_CHAIN) as { id: number } | undefined;
    return row !== undefined;
  }

  private externalActivityScanById(scanId: string): ExternalActivityScanRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT eas.scan_id, eas.kind, eas.account_id, a.address AS account, eas.relationship,
                eas.input_digest, eas.continuity_json, eas.source_upper_timestamp, eas.source_upper_checkpoint, eas.function_target, eas.from_checkpoint, eas.to_checkpoint, eas.from_timestamp,
                eas.to_timestamp, eas.limit_count, eas.request_cursor, eas.response_cursor,
                eas.endpoint_host, eas.chain_identifier, eas.fetched_at, eas.stored_count,
                eas.skipped_count, eas.outside_filter_count, eas.unconfirmed_relation_count, eas.has_more, eas.window_complete, eas.incomplete_reason
         FROM external_activity_scans eas
         JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id = eas.account_id
         WHERE eas.scan_id = ?`
      )
      .get(scanId) as ExternalActivityScanRow | undefined;
    return row ? externalActivityScanFromRow(row) : undefined;
  }

  private externalActivityTransactions(
    whereSql: string,
    params: unknown[], limit: number
  ): ExternalActivityTransactionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT eat.account_id, a.address AS account, eat.digest, eat.relationship,
                eat.checkpoint, eat.timestamp, eat.status, eat.metadata_conflicts, eat.known_sender_account_id,
                eat.first_scan_id, eat.last_scan_id, eat.first_fetched_at, eat.last_fetched_at,
                last_scan.incomplete_reason AS last_scan_incomplete_reason,
                eat.detail_json,
                (SELECT count(*) FROM external_activity_observations o WHERE o.account_id=eat.account_id AND o.digest=eat.digest) AS observation_count,
                (SELECT detail_status FROM external_activity_observations o WHERE o.scan_id=eat.last_scan_id AND o.digest=eat.digest) AS last_detail_status
         FROM external_activity_transactions eat
         JOIN accounts a ON a.chain_id='${SUI_MAINNET_WALLET_CHAIN}' AND a.id = eat.account_id
         LEFT JOIN external_activity_scans last_scan ON last_scan.scan_id = eat.last_scan_id
         ${whereSql}
         ORDER BY
           CASE WHEN eat.checkpoint IS NULL THEN 0 ELSE 1 END DESC,
           CAST(eat.checkpoint AS INTEGER) DESC,
           COALESCE(eat.timestamp, '') DESC,
           eat.digest DESC LIMIT ?`
      )
      .all(...params, limit) as ExternalActivityTransactionRow[];
    return rows.map(externalActivityTransactionFromRow);
  }

  private insertReviewTransition(input: ReviewTransitionInput & { accountId?: number | null }): string {
    let transitionedAt = input.transitionedAt;
    if (input.event === "opened") {
      const opened = claimFirstReviewOpening(this.db, input.reviewSessionId, transitionedAt);
      if (!opened) throw new ActivityStoreError("The review opening was already recorded or the session is missing.");
      transitionedAt = opened.opened_at;
    }
    this.db
      .prepare(
        `INSERT INTO review_status_transitions
           (review_session_id, event, from_status, to_status, account_id, reason, transitioned_at)
         VALUES (?, ?, COALESCE(?, (SELECT current_status FROM review_sessions WHERE id=? AND ?!='created')), ?, ?, ?, ?)`
      )
      .run(
        input.reviewSessionId,
        input.event,
        input.fromStatus ?? null,
        input.reviewSessionId,
        input.event,
        input.toStatus,
        input.accountId ?? null,
        input.reason ?? null,
        transitionedAt
      );
    return transitionedAt;
  }

  private resolveReviewActivityScope(filter: ReviewActivityFilter): ReviewActivityScope {
    if (filter.account) {
      const normalized = parseSuiAddress(filter.account);
      if (!normalized) {
        throw new ActivityStoreReadError("input_invalid", "Invalid account filter", { field: "account" });
      }
      const row = this.db
        .prepare("SELECT id FROM accounts WHERE chain_id=? AND address=?")
        .get(SUI_MAINNET_WALLET_CHAIN, normalized) as { id: number } | undefined;
      return {
        account: normalized,
        accountId: row?.id,
        accountSource: "explicit_filter"
      };
    }

    const active = this.getActiveAccountSync();
    if (!active) {
      throw new ActivityStoreReadError("active_account_not_set", "No saved read address is set. Provide an explicit Sui account for this read.", {
        action: "provide_account"
      });
    }
    return {
      account: active.address,
      accountId: active.accountId,
      accountSource: "active_account_context"
    };
  }

  getActiveAccountSync(): ActiveAccountRecord | undefined {
    return this.chainAccounts.currentReadAccount(SUI_MAINNET_WALLET_CHAIN);
  }

  private assertReviewSessionAccount(reviewSessionId: string, accountId: number): void {
    const row = this.db
      .prepare("SELECT account_id FROM review_sessions WHERE id = ?")
      .get(reviewSessionId) as { account_id: number | null } | undefined;
    if (!row) {
      throw new ActivityStoreError(`Review session not found: ${reviewSessionId}`);
    }
    if (row.account_id !== null && row.account_id !== accountId) {
      throw new ActivityStoreError(`Review session already belongs to a different account: ${reviewSessionId}`);
    }
  }


}

function assertNonEmptyHalfOpenRange(from: string, to: string): void {
  if (from >= to) {
    throw new ActivityStoreReadError("input_invalid", "from must be before to for a non-empty half-open range", {
      from,
      to
    });
  }
}



class SqliteCoinMetadataCache implements CoinMetadataCache {
  constructor(private readonly db: SqliteDatabase) {}

  async getCoinMetadata(input: {
    coinType: string;
    chainIdentifier: string;
    now: Date;
  }): Promise<CoinMetadataCacheLookup> {
    const row = this.db
      .prepare(
        `SELECT coin_type, chain_identifier, decimals, symbol, name, fetched_at, expires_at
         FROM coin_metadata_cache
         WHERE coin_type = ? AND chain_identifier = ?`
      )
      .get(input.coinType, input.chainIdentifier) as CoinMetadataCacheRow | undefined;
    if (!row) {
      return { status: "miss" };
    }
    const record = coinMetadataCacheRecordFromRow(row);
    return record.expiresAt > input.now.toISOString()
      ? { status: "hit", record }
      : { status: "expired", record };
  }

  async setCoinMetadata(record: CoinMetadataCacheRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO coin_metadata_cache
           (coin_type, chain_identifier, decimals, symbol, name, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(coin_type, chain_identifier) DO UPDATE SET
           decimals = excluded.decimals,
           symbol = excluded.symbol,
           name = excluded.name,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at`
      )
      .run(
        record.coinType,
        record.chainIdentifier,
        record.decimals,
        record.symbol,
        record.name,
        record.fetchedAt,
        record.expiresAt
      );
  }
}

export function resolveActivityDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configured = env[DATA_DIR_ENV];
  const dataDir = configured && configured.trim() ? configured : defaultDataDir(env, platform);
  if (dataDir.includes("\0")) {
    throw new ActivityStoreError(`${DATA_DIR_ENV} must not contain null bytes`);
  }
  return resolve(dataDir, ACTIVITY_DATABASE_FILENAME);
}

export function assertSqliteEngineAvailable(): void {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE engine_check (id INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO engine_check (id) VALUES (?)").run(1);
    const row = db.prepare("SELECT id FROM engine_check").get() as { id: number } | undefined;
    if (row?.id !== 1) {
      throw new ActivityStoreError("better-sqlite3 smoke query failed");
    }
  } finally {
    db.close();
  }
}

function defaultDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = homedir();
  if (platform === "darwin") {
    return resolve(home, "Library", "Application Support", "sui-mcp");
  }
  if (platform === "win32") {
    return resolve(env.APPDATA ?? resolve(home, "AppData", "Roaming"), "sui-mcp");
  }
  return resolve(env.XDG_DATA_HOME ?? resolve(home, ".local", "share"), "sui-mcp");
}
