import { walletCardResult, reviewCardResult, endedCardMessage, type WalletPendingWork } from "./cardResult.js";
import { readStoredWalletConnectionOperation } from "./sqliteWalletConnectionOperation.js";
import { readStoredTransactionRequest } from "./sqliteTransactionRequest.js";
import type { EventLogRecord } from "../eventlog/sink.js";
import { type WalletSnapshot } from "./walletRuntime.js";
import { materialStillMatches, type ValidatedReviewMaterial } from "./reviewValidity.js";
import type { LocalTransactionMaterialStore } from "./transactionMaterialStore.js";
import { SqliteSessionRecordStore, SqlitePrivateReviewArtifactStore } from "./sqliteSessionStore.js";
import { fixedReviewTarget, workflowEligibility, walletActionDecision, type ConnectionFacts, type ReviewReadTarget, type WorkflowEvaluationInput, type EvaluatedWorkflowState, type WorkflowAction } from "./workflowState.js";
import { SessionStoreError } from "./sessionErrors.js";
import { createHash, randomUUID } from "node:crypto";
import { SqliteAccountStore } from "../activity/sqliteAccountStore.js";
import { SqlitePreferencesRepository } from "../preferences/sqlitePreferencesRepository.js";
import { pendingWalletConnectionOperationSchema, publicConnectionOperation, type WalletConnectionAction, type WalletConnectionOperationRecord } from "./walletConnectionOperations.js";
import { initialGrantRevisions, fixedChainAccount, approvedChainResults, type WalletChainId } from "./chainAccounts.js";
import { isDeepStrictEqual } from "node:util";
import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { reviewStateOutputSchema } from "../action/schemas.js";
import { LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION } from "./liveReviewSessionContract.js";
import { SqliteCardRecordStore } from "./sqliteCardStore.js";
import { receiptDisplaySchema, type CardRecord, type ReceiptDisplay } from "./cardSession.js";
import { isOwnedConnectedWallet, usableWalletConnection, connectionHasSuiSigningScope, walletConnectionEligibility, walletConnectionSchema, walletRecoveryImpactSchema, SUI_MAINNET_WALLET_CHAIN,
  type WalletConnection, type WalletConnectionRecord, type WalletSession, type WalletConnectionPresence, type WalletRecoveryImpact } from "./walletConnection.js";
import { SIGNATURE_WAIT_MS, CHAIN_RECEIPT_LOOKUP_MAX_AGE_MS, INITIAL_CHAIN_OBSERVATION_STATUSES, isInitialChainObservation,
  transactionExecutionSummarySchema, requestTransitions, type TransactionRequest,
  type TransactionRequestStatus, type TransactionExecutionSummary } from "./transactionRequest.js";

export class WorkflowConflict extends Error {
  constructor(message: string, readonly events: EventLogRecord[] = [], readonly reason?: string) { super(message); }
}
export type ConnectionResponseOwner = { id: string; operationId: string; cardId: string; runId: string };
type ConnectionPublication = "published" | "already_published" | "cleanup_required" | "not_owned";
export type RequestAuthority = {
  attempt_id: string; owner_id: string; run_id: string | null; connection_id: string; grant_revision: number;
  can_submit: number; sdk_pending: number; submit_pending: number; lookup_pending: number;
  signature_deadline: string; lookup_deadline: string | null; observation_stopped: number;
};
type ReviewRow = { id: string; status: string; account: string | null; expires_at: string;
  review_revision: number; preparation_id: string | null; preparation_error: string | null;
  current_attempt_id: string | null; wallet_connection_id: string | null; wallet_grant_revision: number | null; review_state_json: string | null };
const interruptionReasons = {
  user_stop: "User stopped waiting before submission.",
  wallet_change: "The wallet connection changed or became unavailable before submission. Nothing was submitted.",
  disconnect_requested: "Wallet disconnection was requested before submission. Nothing was submitted.",
  wallet_service_restarted: "The wallet service was restarted before submission. Nothing was submitted.",
  wallet_service_lost: "The wallet service stopped before submission. Nothing was submitted."
} as const;
type RequestInterruptionCause = keyof typeof interruptionReasons;
const preparationInterruptionReasons = {
  wallet_change: "The original wallet connection's Sui authorization changed.",
  disconnect_requested: "Wallet disconnection was requested for the original connection. This review cannot use a replacement connection.",
  wallet_service_restarted: "The wallet service was restarted. Update this review before requesting approval.",
  wallet_service_lost: "The wallet service stopped. Restore the wallet connection and update this review before requesting approval."
} as const;

/** Purpose-specific mutations on the activity owner's connection. Each method
 * commits card, request and public history together; no network work runs here. */
export class SqliteWalletWorkflowStore {
  private readonly cards: SqliteCardRecordStore;
  private runId: string | undefined;
  setWalletRunId(runId: string): void { this.runId = runId; }
  private assertWalletInputAllowed(): void {
    if ((this.db.prepare("SELECT wallet_input_blocked FROM settings_control WHERE id=1").get() as { wallet_input_blocked: number }).wallet_input_blocked) {
      throw new WorkflowConflict("Wallet input is blocked while the connection service is being recovered.");
    }
  }
  constructor(private readonly db: SqliteDatabase, private readonly ownerId: string,
    private readonly accounts: SqliteAccountStore,
    private readonly clock: () => Date, private readonly materialStore: LocalTransactionMaterialStore,
    private readonly evaluateState: (input: WorkflowEvaluationInput, at?: Date) => EvaluatedWorkflowState,
    private readonly readSdkSnapshot: () => WalletSnapshot | undefined) {
    this.cards = new SqliteCardRecordStore(db);
  }

  cardResult(record: CardRecord, at: Date, pendingWork?: WalletPendingWork): unknown {
    if (record.state.kind === "connect" || record.state.kind === "disconnect") {
      const operation = record.operationId ? this.cardOperation(record) : undefined;
      const id = operation?.connectionId ?? (record.state.kind === "disconnect" && typeof record.state.input.connectionId === "string" ? record.state.input.connectionId : undefined);
      return walletCardResult(record, at, { message: record.state.error ?? operation?.message ?? endedCardMessage(record.state.reason),
        connection: id ? this.connection(id)?.connection : undefined, pendingWork });
    }
    const session = new SqliteSessionRecordStore(this.db).get(String(record.state.input.reviewSessionId));
    const id = record.operationId ?? (typeof record.state.input.attemptId === "string" ? record.state.input.attemptId : undefined);
    const request = id ? this.request(id) : undefined;
    return reviewCardResult(record, at, { session, request, state: id ? this.requestReview(id) ?? session?.reviewState : session?.reviewState,
      receipt: id ? this.executionDetails(id)?.data : undefined, observationStopped: !!(id && this.authority(id)?.observation_stopped) });
  }
  private replaceCard(expected: CardRecord, next: CardRecord, at = this.clock(), pendingWork?: WalletPendingWork): boolean {
    if (next.state.state === "closed") next = { ...next, state: { ...next.state, data: this.cardResult(next, at, pendingWork) } };
    return this.cards.replace(expected, next, at);
  }
  endCard(record: CardRecord, reason: NonNullable<CardRecord["state"]["reason"]>, at = this.clock(), error?: string): CardRecord {
    if (record.state.state === "closed") return record;
    if (!this.replaceCard(record, { ...record, state: { ...record.state, state: "closed", reason,
      ...(error ? { error } : {}), revision: record.state.revision + 1 } }, at)) throw new WorkflowConflict("The card changed before its result could be saved.");
    return this.cards.get(record.state.cardId)!;
  }
  expireCard(record: CardRecord, at = this.clock()): CardRecord {
    record = this.currentCard(record);
    return record.state.state === "ready" && Date.parse(record.state.expiresAt) <= at.getTime() ? this.endCard(record, "expired", at) : record;
  }

  reconcileAndEvaluate(input: WorkflowEvaluationInput): EvaluatedWorkflowState { return this.evaluateState(input); }

  currentCard(expected: CardRecord): CardRecord {
    const current = this.cards.get(expected.state.cardId);
    if (!current || current.tokenHash !== expected.tokenHash || current.scope !== expected.scope || current.ownerId !== expected.ownerId ||
        !isDeepStrictEqual(current.state.input, expected.state.input)) throw new SessionStoreError("input_invalid", "Card access is unavailable.");
    return current;
  }
  reviewReadTarget(reviewSessionId: string, expectedCard?: CardRecord): ReviewReadTarget {
    const card = expectedCard && this.currentCard(expectedCard);
    if (card && (card.state.kind !== "review" || card.state.input.reviewSessionId !== reviewSessionId)) {
      throw new SessionStoreError("session_mismatch", "The card does not match this review.");
    }
    const exactId = card?.scope === "review_manage" ? String(card.state.input.attemptId) : card?.operationId;
    const request = exactId ? this.request(exactId) : this.currentRequest(reviewSessionId);
    if (exactId && !request || request && request.reviewSessionId !== reviewSessionId) {
      throw new SessionStoreError("session_mismatch", "The request identity does not match this review.");
    }
    const liveReview = new SqliteSessionRecordStore(this.db).get(reviewSessionId);
    const at = this.clock().getTime();
    return { reviewSessionId, attemptId: request?.attemptId, walletDependent: !request || request.requestStatus === "awaiting_signature" ||
      !!(card?.scope === "review" && card.state.state === "ready" && !card.operationId && Date.parse(card.state.expiresAt) > at &&
        liveReview && liveReview.status !== "expired" && Date.parse(liveReview.expiresAt) > at) };
  }

  recordWalletFailure(input: { observedAt: string; runId?: string }): void {
    // Retried by the workflow until revocation is durably recorded. The SDK
    // run is already fenced, so a failed write cannot preserve usable authority.
    this.invalidateWalletRun("wallet_service_lost", new Date(input.observedAt), input.runId);
  }
  applyWalletObservation(snapshot: WalletSnapshot, _previous: WalletSnapshot | undefined, ready: boolean, recordReady?: () => void): void {
    this.db.transaction(() => {
      if (ready) this.db.prepare(`UPDATE wallet_connection_operations SET sdk_pending=0
        WHERE owner_id!=? OR run_id IS NOT NULL AND run_id!=?`).run(this.ownerId, snapshot.runId);
      let record = this.currentConnection();
      if (record && ready) {
        // The exclusive SDK lease permits cleanup ownership, not old authority.
        this.db.prepare("UPDATE live_wallet_connections SET owner_id=?,run_id=? WHERE id=? AND current_slot=1")
          .run(this.ownerId, snapshot.runId, record.connection.connectionId);
        record = this.currentConnection();
      }
      const observed = record?.topic ? snapshot.sessions.find((item) => item.topic === record.topic) : undefined;
      if (record && record.ownerId === this.ownerId && record.runId === snapshot.runId && observed) {
        const id = record.connection.connectionId;
        if (observed.status !== "present") {
          if (record.connection.status === "connected") this.applyConnectionChange(id,
            { status: observed.status === "absent" ? "disconnected" : "failed",
              reason: observed.status === "absent" ? "The wallet session is no longer present." : "The retained wallet session cannot be used." }, this.clock());
          const pending = this.pendingDisconnect(id);
          if (pending?.status === "running" && observed.status === "absent") this.finishDisconnect(pending.operationId, id, true, this.clock());
        } else {
          const session = observed.session;
          if (record.connection.lifecycleRevision !== observed.lifecycleRevision ||
              record.connection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] !== observed.grantRevisions[SUI_MAINNET_WALLET_CHAIN]) {
            this.invalidateConnectionRequests(id, this.clock(), "wallet_change");
          }
          if (!isDeepStrictEqual(record.connection.grants, session.grants) || !isDeepStrictEqual(record.connection.grantRevisions, observed.grantRevisions) ||
              record.connection.lifecycleRevision !== observed.lifecycleRevision || record.connection.expiresAt !== session.expiresAt || record.connection.walletName !== session.walletName) {
            this.updateConnection(id, { grants: session.grants, grantRevisions: observed.grantRevisions, lifecycleRevision: observed.lifecycleRevision,
              expiresAt: session.expiresAt, walletName: session.walletName }, this.clock());
          }
        }
      }
      if (ready) { recordReady?.();  }
    }).immediate();
  }

  invalidateWalletRun(cause: "wallet_service_lost" | "wallet_service_restarted", now = this.clock(), runId?: string): void {
    this.db.transaction(() => {
      const targets = new Set<string>();
      if (runId !== undefined) {
        for (const row of this.db.prepare("SELECT connection_id FROM live_request_authority WHERE owner_id=? AND run_id=?")
          .all(this.ownerId, runId) as { connection_id: string }[]) targets.add(row.connection_id);
        for (const row of this.db.prepare("SELECT wallet_connection_id FROM live_review_sessions WHERE owner_id=? AND preparation_run_id=? AND wallet_connection_id IS NOT NULL")
          .all(this.ownerId, runId) as { wallet_connection_id: string }[]) targets.add(row.wallet_connection_id);
      }
      for (const record of this.connections()) {
        if (record.ownerId !== this.ownerId || runId !== undefined && record.runId !== runId) continue;
        targets.add(record.connection.connectionId);
        if (["connected", "awaiting_approval"].includes(record.connection.status)) this.updateConnection(record.connection.connectionId, {}, now);
      }
      for (const id of targets) this.invalidateConnectionRequests(id, now, cause, runId);

    }).immediate();
  }

  private connectionRows(id?: string, current = false): WalletConnectionRecord[] {
    const rows = this.db.prepare(`SELECT c.*,EXISTS(SELECT 1 FROM wallet_connection_operations o
      WHERE o.connection_id=c.id AND o.sdk_pending=1) AS sdk_pending,
      EXISTS(SELECT 1 FROM wallet_connection_operations o WHERE o.connection_id=c.id AND o.action='disconnect'
        AND (o.status='running' OR o.sdk_pending=1)) AS disconnect_pending,
      pending.operation_id AS pending_operation_id,pending.action AS pending_action,
      pending.status AS pending_status,pending.sdk_pending AS pending_settlement
      FROM live_wallet_connections c LEFT JOIN wallet_connection_operations pending ON pending.connection_id=c.id
        AND (pending.status='running' OR pending.sdk_pending=1)
      ${current ? "WHERE c.current_slot=1" : id === undefined ? "" : "WHERE c.id=?"} ORDER BY c.id`)
      .all(...(id === undefined ? [] : [id])) as Array<{ owner_id: string; run_id: string | null; topic: string | null;
        id: string; sdk_pending: number; disconnect_pending: number; current_slot: number | null; data_epoch: number; read_address_cleared: number; connection_json: string;
        pending_operation_id: string | null; pending_action: string | null; pending_status: string | null; pending_settlement: number | null }>;
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new WorkflowConflict("A wallet connection has conflicting pending operations.");
    return rows.map((row) => ({ connection: walletConnectionSchema.parse(JSON.parse(row.connection_json)), ownerId: row.owner_id,
      sdkPending: row.sdk_pending === 1, disconnectPending: row.disconnect_pending === 1, current: row.current_slot === 1, dataEpoch: row.data_epoch, readAddressCleared: row.read_address_cleared === 1,
      ...(row.pending_operation_id ? { pendingOperation: pendingWalletConnectionOperationSchema.parse({ operationId: row.pending_operation_id,
        action: row.pending_action, status: row.pending_status, settlementPending: row.pending_settlement === 1 }) } : {}),
      ...(row.run_id === null ? {} : { runId: row.run_id }), ...(row.topic === null ? {} : { topic: row.topic }) }));
  }
  connection(id: string): WalletConnectionRecord | undefined { return this.connectionRows(id)[0]; }
  connections(): WalletConnectionRecord[] { return this.connectionRows(); }
  currentConnection(): WalletConnectionRecord | undefined { return this.connectionRows(undefined, true)[0]; }
  private connectionPresence(record: WalletConnectionRecord | undefined, snapshot: WalletSnapshot | undefined): WalletConnectionPresence {
    const currentRun = !!snapshot && snapshot.runId === this.runId;
    const observed = currentRun && record?.topic ? snapshot.sessions.find((item) => item.topic === record.topic) : undefined;
    const epoch = (this.db.prepare("SELECT data_epoch FROM settings_control WHERE id=1").get() as { data_epoch: number }).data_epoch;
    const pending = !!record?.pendingOperation;
    return { confirmed: currentRun && (!record?.topic || !!observed), managed: !record || record.ownerId === this.ownerId && record.runId === this.runId,
      dataCurrent: !record || record.dataEpoch === epoch, pending, hasRecordedSession: !!record?.topic,
      unrecorded: !!(currentRun && !(record?.sdkPending && !record.topic) && snapshot.sessions.some((item) => item.status !== "absent" && item.topic !== record?.topic)),
      ...(observed ? { observation: { status: observed.status, ...(observed.status === "present" ? { expiresAt: observed.session.expiresAt } : {}) } } : {}) };
  }
  readConnectionFacts(now: Date): ConnectionFacts {
    return this.db.transaction(() => {
      const record = this.currentConnection(), snapshot = this.readSdkSnapshot();
      const account = this.accounts.currentReadAccount(SUI_MAINNET_WALLET_CHAIN);
      return { evaluatedAt: now.toISOString(), activeAccount: account?.address,
        requestedChains: new SqlitePreferencesRepository(this.db).getWalletConnectionChainsSync(),
        readAddressCleared: !!record?.readAddressCleared,
        ...(record ? { connection: { ...record.connection, disconnectImpact: this.disconnectImpact(record.connection.connectionId) },
          pendingOperation: record.pendingOperation } : {}),
        connectionPresence: this.connectionPresence(record, snapshot),
        ...(snapshot ? { walletObservation: { runId: snapshot.runId, sequence: snapshot.sequence, observedAt: snapshot.observedAt } } : {}) };
    }).deferred();
  }
  connectionEligibility(now = this.clock()) {
    const facts = this.readConnectionFacts(now);
    return walletConnectionEligibility(facts.connection, now.getTime(), facts.connectionPresence, facts.activeAccount, facts.readAddressCleared);
  }
  isUsableConnection(id: string, now = this.clock(), chainId: WalletChainId = SUI_MAINNET_WALLET_CHAIN, account?: string): boolean {
    const record = this.currentConnection();
    return !!usableWalletConnection(record?.connection, now.getTime(), this.connectionPresence(record, this.readSdkSnapshot()), id, chainId, account);
  }

  operation(id: string): WalletConnectionOperationRecord | undefined { return readStoredWalletConnectionOperation(this.db, id); }
  cardOperation(card: CardRecord, id = card.operationId): WalletConnectionOperationRecord | undefined {
    const operation = id ? this.operation(id) : undefined;
    if (operation && operation.cardId !== card.state.cardId) throw new WorkflowConflict("This operation belongs to a different card.");
    return operation;
  }
  private requireConnectionCard(expected: CardRecord, now: Date): CardRecord {
    const card = this.currentCard(expected);
    if (!["connect", "disconnect"].includes(card.scope ?? "") || card.ownerId !== this.ownerId || card.state.state !== "ready" || card.acceptedInput !== undefined || card.state.revision !== expected.state.revision ||
      Date.parse(card.state.expiresAt) <= now.getTime()) throw new WorkflowConflict("This wallet request card no longer accepts actions.");
    return card;
  }
  recoverConnectionOperation(expected: CardRecord, input: WalletConnectionAction): WalletConnectionOperationRecord | undefined {
    const card = this.currentCard(expected);
    if (card.scope !== input.action || card.operationId !== input.operationId ||
        input.action === "disconnect" && card.state.input.connectionId !== input.connectionId) {
      throw new WorkflowConflict("This action does not match the card's fixed purpose, operation and target.");
    }
    const operation = this.operation(input.operationId);
    if (!operation) return undefined;
    if (operation.cardId !== expected.state.cardId || operation.ownerId !== this.ownerId || !isDeepStrictEqual(operation.input, input)) {
      throw new WorkflowConflict("This operation ID already belongs to a different request.");
    }
    return operation;
  }
  private admitConnectionOperation(card: CardRecord, input: WalletConnectionAction, now: Date, connectionId: string, pending = false): void {
    const epoch = (this.db.prepare("SELECT data_epoch FROM settings_control WHERE id=1").get() as { data_epoch: number }).data_epoch;
    this.db.prepare(`INSERT INTO wallet_connection_operations
      (operation_id,card_id,owner_id,run_id,data_epoch,action,connection_id,status,input_json,sdk_pending,created_at,updated_at,expires_at)
      VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,?)`).run(input.operationId, card.state.cardId, this.ownerId,
        input.walletRunId, epoch, input.action, connectionId,
        JSON.stringify(input), Number(pending), now.toISOString(), now.toISOString(), card.state.expiresAt);
    // Admission consumes this card for exactly one effect.
    if (!this.replaceCard(card, { ...card, acceptedInput: input, operationId: input.operationId, state: { ...card.state, state: "running", revision: card.state.revision + 1 } })) {
      throw new WorkflowConflict("The connection details changed. Check the updated card and try again.");
    }
  }
  private finishConnectionOperation(id: string, status: "completed" | "failed" | "stopped", message: string, now: Date,
    endReason?: "user_stopped" | "expired" | "run_ended", pendingWork?: WalletPendingWork): void {
    const changed = this.db.prepare(`UPDATE wallet_connection_operations SET status=?,result_json=?,updated_at=?
      WHERE operation_id=? AND status='running' AND result_json IS NULL`).run(status, JSON.stringify({ message, ...(endReason ? { endReason } : {}) }), now.toISOString(), id);
    if (!changed.changes) return;
    const op = this.operation(id)!;
    const card = this.cards.get(op.cardId);
    if (card && card.state.state !== "closed") {
      const reason = endReason === "user_stopped" ? "cancelled" : endReason === "expired" ? "expired" : status === "completed" ? "completed" : "failed";
      if (!this.replaceCard(card, { ...card, state: { ...card.state, state: "closed", reason, revision: card.state.revision + 1 } }, now, pendingWork)) {
        throw new WorkflowConflict("The operation result could not be saved with its card.");
      }
    }
  }
  pendingDisconnect(connectionId: string, ownerId = this.ownerId): WalletConnectionOperationRecord | undefined {
    const row = this.db.prepare(`SELECT operation_id FROM wallet_connection_operations WHERE owner_id=? AND connection_id=? AND action='disconnect'
      AND (status='running' OR sdk_pending=1) ORDER BY created_at DESC,operation_id DESC LIMIT 1`).get(ownerId, connectionId) as { operation_id: string } | undefined;
    return row ? this.operation(row.operation_id) : undefined;
  }
  pendingConnectionOperations(): WalletConnectionOperationRecord[] {
    return (this.db.prepare(`SELECT operation_id FROM wallet_connection_operations
      WHERE owner_id=? AND (status='running' OR sdk_pending=1) ORDER BY created_at,operation_id`)
      .all(this.ownerId) as { operation_id: string }[]).map(({ operation_id }) => this.operation(operation_id)!);
  }
  settleConnection(id: string, source: { cardId: string; runId: string; operationId: string; action: "connect" | "disconnect";
    unrecordedOutcome?: "failed" | "stopped" | "rejected"; cleanup?: { topic: string; absent: boolean } }): void {
    this.db.transaction(() => {
      const operation = this.operation(source.operationId);
      if (!operation || operation.cardId !== source.cardId || operation.connectionId !== id || operation.runId !== source.runId ||
        operation.ownerId !== this.ownerId) return;
      const epoch = (this.db.prepare("SELECT data_epoch FROM settings_control WHERE id=1").get() as { data_epoch: number }).data_epoch;
      if (operation.dataEpoch !== epoch) return;
      if (source.cleanup) {
        const retained = this.connection(id);
        if (!retained || retained.ownerId !== this.ownerId || retained.runId !== source.runId ||
            retained.topic !== source.cleanup.topic || operation.status === "completed") return;
        this.updateConnection(id, { status: source.cleanup.absent ? "disconnected" : "failed",
          reason: source.cleanup.absent ? "The unaccepted wallet session was removed."
            : "This wallet connection was not accepted for account use, and its removal could not be confirmed. Disconnect it before connecting again." }, this.clock());
      }
      if (operation.status === "running" && source.action === "connect") this.finishConnectionOperation(operation.operationId, source.unrecordedOutcome === "stopped" ? "stopped" : "failed",
        source.unrecordedOutcome === "rejected" ? "The connection request was declined in your wallet."
          : "The wallet operation could not be confirmed. Check the saved connection state.", this.clock());
      this.db.prepare("UPDATE wallet_connection_operations SET sdk_pending=0 WHERE operation_id=?").run(operation.operationId);
      const connection = this.connection(id);
      if (source.action === "connect" && connection?.connection.status === "awaiting_approval") this.updateConnection(id,
        { status: source.unrecordedOutcome ?? "failed", reason: "The connection was not recorded as approved." }, this.clock());

    }).immediate();
  }
  request(id: string): TransactionRequest | undefined { return readStoredTransactionRequest(this.db, id); }
  requestForRevision(id: string, revision: number): TransactionRequest | undefined {
    const row = this.db.prepare("SELECT attempt_id FROM review_requests WHERE review_session_id=? AND review_revision=?")
      .get(id, revision) as { attempt_id: string } | undefined;
    return row ? this.request(row.attempt_id) : undefined;
  }

  currentRequest(reviewSessionId: string): TransactionRequest | undefined {
    const row = this.db.prepare("SELECT current_attempt_id FROM review_sessions WHERE id=?").get(reviewSessionId) as
      { current_attempt_id: string | null } | undefined;
    return row?.current_attempt_id ? this.request(row.current_attempt_id) : undefined;
  }
  requestReview(id: string) {
    const row = this.db.prepare("SELECT review_state_json FROM review_requests WHERE attempt_id=?").get(id) as { review_state_json: string } | undefined;
    return row ? reviewStateOutputSchema.parse(JSON.parse(row.review_state_json)) : undefined;
  }
  authority(id: string): RequestAuthority | undefined {
    return this.db.prepare("SELECT * FROM live_request_authority WHERE attempt_id=?").get(id) as RequestAuthority | undefined;
  }
  executionDetails(id: string): { data: unknown; receiptDisplay?: ReceiptDisplay } | undefined {
    const row = this.db.prepare("SELECT model_json,display_json FROM live_execution_details WHERE attempt_id=?").get(id) as
      { model_json: string; display_json: string | null } | undefined;
    if (!row) return undefined;
    const data: unknown = JSON.parse(row.model_json); assertNoForbiddenMcpFields(data);
    return { data, ...(row.display_json === null ? {} : { receiptDisplay: receiptDisplaySchema.parse(JSON.parse(row.display_json)) }) };
  }

  private requireInput(expected: CardRecord, now: Date): CardRecord {
    const current = this.cards.get(expected.state.cardId);
    if (!current || current.ownerId !== this.ownerId || current.tokenHash !== expected.tokenHash ||
        current.scope !== expected.scope || !isDeepStrictEqual(current.state.input, expected.state.input) ||
        current.state.revision !== expected.state.revision || current.state.state !== "ready" || current.acceptedInput !== undefined ||
        Date.parse(current.state.expiresAt) <= now.getTime()) throw new WorkflowConflict("This card input is no longer available.");
    return current;
  }
  private requireAction(card: CardRecord, action: WorkflowAction, now: Date) {
    const session = card.state.kind === "review" ? new SqliteSessionRecordStore(this.db).get(String(card.state.input.reviewSessionId)) : undefined;
    const target = session ? this.reviewReadTarget(session.id, card) : undefined;
    const request = target?.attemptId ? this.request(target.attemptId) : undefined;
    if (card.state.kind === "review" && !session) throw new WorkflowConflict("The saved review is unavailable.");
    // Wallet-dependent commands already passed the workflow availability guard.
    // This store checks DB eligibility; it does not measure SDK health.
    const connectionFacts = this.readConnectionFacts(now), targetAccount = session ? fixedReviewTarget(session, card.state.input)?.account : undefined;
    const facts = { ...connectionFacts, ownerId: this.ownerId, record: card, session, request,
      authority: request ? this.authority(request.attemptId) : undefined,
      walletAvailability: { status: "available" as const },
      busyForAccount: !!targetAccount && this.busyForAccount(targetAccount, now) };
    const eligibility = workflowEligibility(facts);
    if (!eligibility.allowedActions.includes(action)) throw new WorkflowConflict("That action is not available right now.");
    return eligibility;
  }
  manage(expected: CardRecord, action: "stop_waiting" | "read_result"): string {
    return this.db.transaction(() => {
      const now = this.clock(), card = this.currentCard(expected);
      if (card.ownerId !== this.ownerId || card.state.kind !== "review") throw new WorkflowConflict("This request does not match the card's current state.");
      const id = card.scope === "review_manage" ? String(card.state.input.attemptId) : card.operationId;
      const request = id ? this.request(id) : undefined;
      if (!id || !request || request.reviewSessionId !== card.state.input.reviewSessionId) throw new WorkflowConflict("This transaction request does not match the card.");
      // A repeated stop reads its ended card; it must not stop a later result
      // observation admitted through a different management card.
      if (action === "stop_waiting" && card.state.state === "closed" && card.state.reason === "cancelled") return id;
      if (card.state.revision !== expected.state.revision) throw new WorkflowConflict("This request does not match the card's current state.");
      this.advanceRequestDeadlines(now, id);
      this.requireAction(card, action, now);
      if (action === "stop_waiting") {
        this.stopWaiting(id, now, "user_stop", card.state.cardId);
        this.closeCancelledCard(this.cards.get(card.state.cardId)!);
      }
      else {
        if (card.scope !== "review_manage" || card.state.state !== "ready" || card.acceptedInput !== undefined) throw new WorkflowConflict("Open a new result card for another lookup.");
        this.consume(card, { action: "read_result" }, id);
        this.resumeObservation(id);
      }
      return id;
    }).immediate();
  }
  expireConnections(now: Date, operationId?: string): void {
    const connectionId = operationId ? this.operation(operationId)?.connectionId : undefined;
    const records = operationId ? connectionId ? this.connectionRows(connectionId) : [] : this.connections();
    for (const record of records) if (record.ownerId === this.ownerId && record.connection.status === "awaiting_approval" &&
      Date.parse(record.connection.expiresAt) <= now.getTime()) {
      this.updateConnection(record.connection.connectionId, { status: "expired", reason: "The time to approve this connection has ended." }, now);
      const rows = this.db.prepare("SELECT operation_id FROM wallet_connection_operations WHERE connection_id=? AND action='connect' AND status='running'")
        .all(record.connection.connectionId) as { operation_id: string }[];
      for (const row of rows) this.finishConnectionOperation(row.operation_id, "stopped", "The connection request expired.", now, "expired", this.operation(row.operation_id)?.settlementPending ? "approval_response" : undefined);
    }
  }
  beginObservation(id: string, explicit: boolean): TransactionRequest | undefined {
    return this.db.transaction(() => {
      const now = this.clock();
      this.advanceRequestDeadlines(now, id);
      const request = this.request(id), authority = this.authority(id);
      if (!request || !authority || authority.owner_id !== this.ownerId || authority.lookup_pending === 1 ||
          authority.observation_stopped && !explicit ||
          !(isInitialChainObservation(request.requestStatus) || explicit && request.requestStatus === "outcome_unknown")) return undefined;
      if (isInitialChainObservation(request.requestStatus) && !authority.lookup_deadline) {
        throw new WorkflowConflict("The saved transaction observation deadline is unavailable.");
      }
      this.settle(id, "lookup_pending", true);
      return request;
    }).immediate();
  }
  private consume(card: CardRecord, input: Record<string, unknown>, operationId: string | undefined, terminal = false): void {
    const next: CardRecord = { ...card, acceptedInput: input, ...(operationId ? { operationId } : {}), state: {
      ...card.state, state: terminal ? "closed" : "running", revision: card.state.revision + 1,
      ...(terminal ? { reason: "completed" as const } : {}) } };
    if (!this.replaceCard(card, next, this.clock())) throw new WorkflowConflict("The card changed before this action was accepted.");
  }
  private publish(operationId: string, terminal: boolean, excludedCardId?: string): void {
    const rows = this.db.prepare("SELECT id FROM live_read_cards WHERE operation_id=? AND state!='closed'").all(operationId) as { id: string }[];
    for (const { id } of rows) {
      if (id === excludedCardId) continue;
      const card = this.cards.get(id)!;
      if (!this.replaceCard(card, { ...card, state: { ...card.state, revision: card.state.revision + 1,
        ...(terminal ? { state: "closed" as const, reason: "completed" as const } : {}) } }, this.clock())) throw new WorkflowConflict("The request result could not be saved with its card.");
    }
  }
  closeConnectionCardsWithChangedNetworks(chains: readonly WalletChainId[]): void {
    for (const { id } of this.db.prepare("SELECT id FROM live_read_cards WHERE owner_id=? AND scope='connect' AND state='ready'").all(this.ownerId) as { id: string }[]) {
      const card = this.cards.get(id)!;
      if (!isDeepStrictEqual(card.state.input.requestedChains, chains)) this.invalidateConnectionCard(card);
    }
  }
  reconcileWalletCard(card: CardRecord, facts: ConnectionFacts): CardRecord {
    if (card.ownerId !== this.ownerId || card.state.state !== "ready") return card;
    let message: string | undefined;
    if (card.scope === "connect") {
      if (!isDeepStrictEqual(card.state.input.requestedChains, facts.requestedChains) ||
          (card.state.input.connectionId ?? null) !== (facts.connection?.connectionId ?? null)) return this.invalidateConnectionCard(card);
      if (facts.pendingOperation && facts.pendingOperation.operationId !== card.operationId) {
        message = "Another wallet request is still pending. No connection request was sent from this card. Ask in chat to check the existing request.";
      } else if (facts.connection && facts.connectionPresence.confirmed &&
          ["present", "unusable"].includes(facts.connectionPresence.observation?.status ?? "")) {
        message = "A wallet session is already present. No connection request was sent. To change the wallet or networks, ask in chat to disconnect and then request a new connection.";
      }
    } else if (card.scope === "disconnect") {
      const replaced = !!facts.connection && facts.connection.connectionId !== card.state.input.connectionId;
      const absent = facts.connection?.connectionId === card.state.input.connectionId && facts.connectionPresence.confirmed &&
        facts.connectionPresence.observation?.status === "absent";
      if (replaced || absent) message = "The wallet session for this card is no longer current. No disconnection request was sent from this card. Ask in chat for current connection status.";
    }
    return message ? this.invalidateConnectionCard(card, message) : card;
  }
  invalidateConnectionCard(card: CardRecord, message = "The networks or connection state for this request changed. Ask for a new wallet connection card. No connection request was sent."): CardRecord {
    if (card.state.state === "closed") return card;
    if (!this.replaceCard(card, { ...card, state: { ...card.state, state: "closed", reason: "failed", revision: card.state.revision + 1,
      error: message } }, this.clock())) throw new WorkflowConflict("The card changed before it could be closed.");
    return this.cards.get(card.state.cardId)!;
  }
  operationRead(expected: CardRecord, context: Pick<WorkflowEvaluationInput, "walletAvailability" | "walletObservation">) {
    return this.db.transaction(() => {
      let record = this.expireCard(this.currentCard(expected));
      if (!["connect", "disconnect"].includes(record.scope ?? "")) throw new WorkflowConflict("A wallet operation card is required.");
      const now = this.clock(), connectionFacts = record.state.state === "closed" ? undefined : this.readConnectionFacts(now);
      if (connectionFacts) record = this.reconcileWalletCard(record, connectionFacts);
      const operation = this.cardOperation(record);
      const facts = connectionFacts && record.state.state !== "closed" ? { ...connectionFacts, ...context,
        record, ownerId: this.ownerId, hasReviewInput: false, busyForAccount: false,
        operation: operation ? publicConnectionOperation(operation) : undefined } : undefined;
      const evaluated: EvaluatedWorkflowState | undefined = facts ? { ...facts, ...workflowEligibility(facts), events: [] } : undefined;
      if (record.acceptedInput && !operation) throw new WorkflowConflict("The admitted operation is unavailable.");
      return { record, operation: operation ? publicConnectionOperation(operation) : null, evaluated,
        evaluatedAt: evaluated?.evaluatedAt ?? this.clock().toISOString() };
    }).deferred();
  }
  private closeCancelledCard(expected: CardRecord): void {
    const card = this.currentCard(expected);
    if (card.ownerId !== this.ownerId) throw new WorkflowConflict("This card no longer accepts actions.");
    if (card.state.state === "closed" && card.state.reason === "cancelled") return;
    if (!this.replaceCard(card, { ...card, state: { ...card.state, state: "closed", reason: "cancelled", revision: card.state.revision + 1 } }, this.clock())) {
      throw new WorkflowConflict("Card changed before cancellation.");
    }
  }
  recoveryImpact(runId: string): WalletRecoveryImpact {
    return walletRecoveryImpactSchema.parse({
      runId,
      connections: this.connections().filter((record) => record.ownerId === this.ownerId && record.runId === runId)
        .map((record) => ({ connectionId: record.connection.connectionId, revision: record.connection.revision,
          status: record.connection.status, chainResults: record.connection.chainResults, walletName: record.connection.walletName,
          sdkPending: record.sdkPending, disconnectPending: record.disconnectPending })),
      preparations: this.db.prepare(`SELECT id,revision,review_revision,preparation_id,wallet_connection_id FROM live_review_sessions
        WHERE owner_id=? AND preparation_run_id=? AND status!='expired' ORDER BY id`).all(this.ownerId, runId),
      requests: this.db.prepare(`SELECT r.attempt_id,r.revision,r.request_status,l.can_submit,l.sdk_pending,l.submit_pending,l.lookup_pending
        FROM review_requests r JOIN live_request_authority l ON l.attempt_id=r.attempt_id
        WHERE l.owner_id=? AND (l.run_id=? OR r.request_status IN ('submitting','awaiting_chain_result','outcome_unknown'))
        ORDER BY r.attempt_id`).all(this.ownerId, runId)
    });
  }
  recordRunExit(runId: string, parentProcessing: readonly string[] = []): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE live_request_authority SET sdk_pending=0 WHERE owner_id=? AND run_id=? AND sdk_pending=1
        AND attempt_id NOT IN (SELECT value FROM json_each(?))`).run(this.ownerId, runId, JSON.stringify(parentProcessing));
      const rows = this.db.prepare("SELECT operation_id FROM wallet_connection_operations WHERE owner_id=? AND run_id=? AND sdk_pending=1")
        .all(this.ownerId, runId) as { operation_id: string }[];
      for (const row of rows) {
        const op = this.operation(row.operation_id)!;
        if (op.status === "running") {
          this.finishConnectionOperation(op.operationId, "stopped", "The wallet service ended before this operation was confirmed.", this.clock(), "run_ended");
          if (op.connectionId) this.updateConnection(op.connectionId, { status: op.action === "connect" ? "stopped" : "failed",
            reason: "The wallet service ended before this operation was confirmed." }, this.clock());
        }
      }
      this.db.prepare("UPDATE wallet_connection_operations SET sdk_pending=0 WHERE owner_id=? AND run_id=?").run(this.ownerId, runId);

    }).immediate();
  }
  private publishReview(id: string): void {
    this.db.prepare(`UPDATE live_read_cards SET revision=revision+1 WHERE owner_id=? AND kind='review' AND state='ready'
      AND json_extract(input_json,'$.reviewSessionId')=?`).run(this.ownerId, id);
  }

  admitConnection(expected: CardRecord, input: Extract<WalletConnectionAction, { action: "connect" }>): { connection: WalletConnectionRecord; operationId: string; created: boolean } {
    const admitted = this.db.transaction(() => {
      const recovered = this.recoverConnectionOperation(expected, input);
      if (recovered) return { connection: this.connection(recovered.connectionId!)!, operationId: recovered.operationId, created: false };
      const now = this.clock(); this.assertWalletInputAllowed(); this.expireConnections(now);
      const card = this.requireConnectionCard(expected, now);
      if (this.runId !== input.walletRunId) {
        throw new WorkflowConflict("This card cannot start that wallet connection.");
      }
      const facts = this.readConnectionFacts(now);
      if (this.reconcileWalletCard(card, facts).state.state === "closed") return undefined;
      if (!input.chains.length || !isDeepStrictEqual([...input.chains].sort(), [...facts.requestedChains].sort())) {
        throw new WorkflowConflict("The requested networks changed. Check the current networks before connecting.");
      }
      const decision = walletActionDecision({ ...facts, walletAvailability: { status: "available" } }, "connect");
      if (!decision.allowed) throw new WorkflowConflict(decision.nextStep.message!, [], decision.nextStep.reason);
      const connection = walletConnectionSchema.parse({ connectionId: randomUUID(), status: "awaiting_approval", revision: 0,
        requestedChains: input.chains, chainResults: [], grants: [], grantRevisions: initialGrantRevisions(), lifecycleRevision: 0,
        createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: card.state.expiresAt });
      const epoch = (this.db.prepare("SELECT data_epoch FROM settings_control WHERE id=1").get() as { data_epoch: number }).data_epoch;
      this.db.prepare("UPDATE live_wallet_connections SET current_slot=NULL WHERE current_slot=1").run();
      this.db.prepare("INSERT INTO live_wallet_connections (id,owner_id,status,revision,topic,connection_json,run_id,current_slot,data_epoch) VALUES (?,?,?,?,?,?,?,1,?)")
        .run(connection.connectionId, this.ownerId, connection.status, 0, null, JSON.stringify(connection), this.runId, epoch);
      this.admitConnectionOperation(card, input, now, connection.connectionId, true);

      return { connection: this.connection(connection.connectionId)!, operationId: input.operationId, created: true };
    }).immediate();
    if (!admitted) throw new WorkflowConflict("The networks or connection state for this request changed. Ask for a new wallet connection card. No connection request was sent.");
    return admitted;
  }
  updateConnection(id: string, update: Partial<Pick<WalletConnection, "status" | "grants" | "grantRevisions" | "lifecycleRevision" | "expiresAt" | "walletName" | "reason">>, now: Date, topic?: string): WalletConnectionRecord | undefined {
    const allowed = new Set(["status", "grants", "grantRevisions", "lifecycleRevision", "expiresAt", "walletName", "reason"]);
    if (Object.keys(update).some((key) => !allowed.has(key))) throw new WorkflowConflict("A fixed connection approval cannot be changed.");
    return this.db.transaction(() => {
      const old = this.connection(id);
      if (!old || old.ownerId !== this.ownerId) return undefined;
      const next = walletConnectionSchema.parse({ ...old.connection, ...update,
        connectionId: id, revision: old.connection.revision + 1, updatedAt: now.toISOString() });
      assertNoForbiddenMcpFields(next);
      this.db.prepare(`UPDATE live_wallet_connections SET status=?,revision=?,topic=?,connection_json=?
        WHERE id=? AND owner_id=? AND revision=?`).run(next.status, next.revision, topic ?? old.topic ?? null,
          JSON.stringify(next), id, this.ownerId, old.connection.revision);

      return this.connection(id);
    }).immediate();
  }
  applyConnectionChange(id: string, update: Partial<Pick<WalletConnection, "status" | "grants" | "grantRevisions" | "lifecycleRevision" | "expiresAt" | "walletName" | "reason">>, now: Date): void {
    this.db.transaction(() => {
      this.invalidateConnectionRequests(id, now, "wallet_change");
      this.updateConnection(id, update, now);
    }).immediate();
  }
  pairingExpiry(operationId: string, expiresAt: string): void {
    this.db.transaction(() => {
      const op = this.operation(operationId);
      if (!op || op.ownerId !== this.ownerId || op.runId !== this.runId || op.status !== "running" || op.action !== "connect") return;
      this.db.prepare("UPDATE wallet_connection_operations SET expires_at=?,updated_at=? WHERE operation_id=?")
        .run(expiresAt, this.clock().toISOString(), operationId);
      this.updateConnection(op.connectionId!, { expiresAt }, this.clock());
    }).immediate();
  }
  private responseOwner(source: ConnectionResponseOwner) {
    const operation = this.operation(source.operationId), record = this.connection(source.id);
    const epoch = (this.db.prepare("SELECT data_epoch FROM settings_control WHERE id=1").get() as { data_epoch: number }).data_epoch;
    if (!operation || operation.action !== "connect" || operation.cardId !== source.cardId || operation.connectionId !== source.id ||
        operation.ownerId !== this.ownerId || operation.runId !== source.runId || source.runId !== this.runId ||
        operation.dataEpoch !== epoch || !record || record.ownerId !== this.ownerId || record.runId !== source.runId || record.dataEpoch !== epoch) return undefined;
    return { operation, record };
  }
  captureConnectionSession(source: ConnectionResponseOwner, session: WalletSession): "captured" | "already_published" | "not_owned" {
    return this.db.transaction(() => {
      const owned = this.responseOwner(source);
      if (!owned) return "not_owned";
      const { operation, record } = owned;
      if (record.topic && record.topic !== session.topic) return "not_owned";
      if (operation.status === "completed") return record.topic === session.topic && record.connection.approvedAt ? "already_published" : "not_owned";
      // SDK exit may end I/O before the parent can persist its received
      // response. The original operation still owns cleanup, never approval.
      if (!record.current) return "not_owned";
      const existing = this.db.prepare("SELECT id FROM live_wallet_connections WHERE topic=?").get(session.topic) as { id: string } | undefined;
      if (existing && existing.id !== source.id) return "not_owned";
      // The SDK response is owned for cleanup before account use is published.
      // A later publication rollback must not erase this private association.
      this.db.prepare("UPDATE live_wallet_connections SET topic=? WHERE id=? AND current_slot=1").run(session.topic, source.id);
      return "captured";
    }).immediate();
  }
  prepareConnectionCleanup(source: ConnectionResponseOwner, session: WalletSession, now: Date): boolean {
    return this.db.transaction(() => {
      const owned = this.responseOwner(source);
      if (!owned || !owned.record.current || owned.record.topic !== session.topic || owned.operation.status === "completed") return false;
      const { operation } = owned;
      this.updateConnection(source.id, { status: operation.status === "stopped" ? "stopped" : "failed", grants: session.grants,
        expiresAt: session.expiresAt, walletName: session.walletName, reason: "This wallet connection was not accepted for account use." }, now);
      if (operation.status === "running") this.finishConnectionOperation(source.operationId, "failed",
        "The wallet connection could not be recorded as approved.", now, undefined, "session_removal");
      return true;
    }).immediate();
  }
  completeConnection(source: ConnectionResponseOwner, session: WalletSession, now: Date): ConnectionPublication {
    return this.db.transaction(() => {
      const owned = this.responseOwner(source);
      if (!owned || owned.record.topic !== session.topic) return "not_owned";
      const { operation: op, record } = owned;
      if (op.status === "completed") return record.connection.approvedAt ? "already_published" : "not_owned";
      const snapshot = this.readSdkSnapshot(), observed = snapshot?.sessions.find((item) => item.topic === session.topic);
      if (!record.current) return "not_owned";
      if (op.status !== "running" || record.connection.status !== "awaiting_approval" ||
          Date.parse(op.expiresAt) <= now.getTime() || snapshot?.runId !== op.runId || observed?.status !== "present") return "cleanup_required";
      const chainResults = approvedChainResults(record.connection.requestedChains, session.grants);
      const next = walletConnectionSchema.parse({ ...record.connection, status: "connected", chainResults, approvedAt: now.toISOString(),
        grants: observed.session.grants, grantRevisions: observed.grantRevisions, lifecycleRevision: observed.lifecycleRevision,
        expiresAt: observed.session.expiresAt, walletName: observed.session.walletName, revision: record.connection.revision + 1, updatedAt: now.toISOString() });
      this.db.prepare("UPDATE live_wallet_connections SET status=?,revision=?,topic=?,connection_json=? WHERE id=? AND current_slot=1")
        .run(next.status, next.revision, session.topic, JSON.stringify(next), next.connectionId);
      for (const result of chainResults) if (result.status === "bound") this.accounts.upsert(result.chainId, result.address, "wallet_connection", now.toISOString());
      this.finishConnectionOperation(source.operationId, "completed", chainResults.some((result) => result.status === "bound") ? "Wallet connection approved." : "The wallet returned no usable address. Disconnect before connecting again.", now);

      return "published";
    }).immediate();
  }
  stopConnection(expected: CardRecord, operationId: string): string {
    return this.db.transaction(() => {
      const current = this.currentCard(expected), op = this.cardOperation(current, operationId);
      if (op?.endReason === "user_stopped") return op.connectionId!;
      if (current.scope !== "connect" || current.ownerId !== this.ownerId || current.state.state === "closed") throw new WorkflowConflict("This connection card has ended.");
      if (!op || op.action !== "connect" || op.status !== "running") throw new WorkflowConflict("This connection request can no longer be stopped.");
      this.finishConnectionOperation(operationId, "stopped", "Connecting was stopped here. A pending wallet approval will not be used.", this.clock(), "user_stopped", op.settlementPending ? "approval_response" : undefined);
      this.updateConnection(op.connectionId!, { status: "stopped", reason: "The connection request was stopped here." }, this.clock());
      this.closeCancelledCard(current);
      return op.connectionId!;
    }).immediate();
  }
  disconnectImpact(connectionId: string): { impactId: string; requestCount: number; chains: WalletChainId[] } {
    const record = this.connection(connectionId);
    if (!record) throw new WorkflowConflict("The wallet connection is unavailable.");
    const requests = this.db.prepare(`SELECT l.attempt_id,r.revision FROM live_request_authority l JOIN review_requests r ON r.attempt_id=l.attempt_id
      WHERE l.connection_id=? AND l.can_submit=1 ORDER BY l.attempt_id`).all(connectionId);
    const impact = { connectionId, lifecycleRevision: record.connection.lifecycleRevision, grants: record.connection.grantRevisions,
      chainResults: record.connection.chainResults, requests };
    return { impactId: createHash("sha256").update(JSON.stringify(impact)).digest("hex"), requestCount: requests.length,
      chains: record.connection.requestedChains };
  }
  admitDisconnect(expected: CardRecord, input: Extract<WalletConnectionAction, { action: "disconnect" }>): { connection: WalletConnectionRecord; created: boolean } {
    return this.db.transaction(() => {
      const prior = this.recoverConnectionOperation(expected, input);
      if (prior) return { connection: this.connection(prior.connectionId!)!, created: false };
      const now = this.clock(); this.assertWalletInputAllowed();
      const card = this.requireConnectionCard(expected, now), connection = this.connection(input.connectionId);
      const decision = walletActionDecision({ ...this.readConnectionFacts(now), walletAvailability: { status: "available" } }, "disconnect", input.connectionId);
      if (!decision.allowed) throw new WorkflowConflict(decision.nextStep.message!, [], decision.nextStep.reason);
      if (!connection?.topic || !connection.current || connection.ownerId !== this.ownerId || connection.runId !== this.runId || input.walletRunId !== this.runId ||
          input.impactId !== this.disconnectImpact(input.connectionId).impactId) throw new WorkflowConflict("The connection or pending approvals changed. Review the updated disconnection details.");
      this.admitConnectionOperation(card, input, now, input.connectionId, true);
      this.invalidateConnectionRequests(input.connectionId, now, "disconnect_requested");

      return { connection, created: true };
    }).immediate();
  }
  finishDisconnect(operationId: string, connectionId: string, succeeded: boolean, now: Date): void {
    this.db.transaction(() => {
      const op = this.operation(operationId);
      if (!op || op.connectionId !== connectionId || op.status !== "running" || op.ownerId !== this.ownerId) return;
      this.updateConnection(connectionId, succeeded ? { status: "disconnected" } : {
        status: "failed", reason: "Wallet disconnection was not confirmed. Check the retained connection in your wallet app." }, now);
      this.finishConnectionOperation(operationId, succeeded ? "completed" : "failed", succeeded ? "Wallet disconnected." : "Wallet disconnection was not confirmed.", now, undefined, succeeded ? undefined : "session_status");
    }).immediate();
  }
  recoverDisconnect(operationId: string, connectionId: string, revision: number, sessionAbsent: boolean): void {
    const connection = this.connection(connectionId);
    if (connection?.connection.revision === revision && !connection.sdkPending) this.finishDisconnect(operationId, connectionId, sessionAbsent, this.clock());
  }
  private recoverRequestAt(expected: CardRecord, input: Record<string, unknown>, binding: {
    reviewSessionId: string; reviewRevision: number; account: string; connectionId: string;
  }, now: Date): { request: TransactionRequest; created: false } | undefined {
    const request = this.requestForRevision(binding.reviewSessionId, binding.reviewRevision);
    if (!request) return undefined;
    const card = this.requireInput(expected, now), authority = this.authority(request.attemptId);
    if (card.scope !== "review" || card.state.input.reviewSessionId !== binding.reviewSessionId ||
        request.account !== binding.account || !authority || authority.owner_id !== this.ownerId || authority.connection_id !== binding.connectionId) {
      throw new WorkflowConflict("This review already has a request for a different selection.");
    }
    const sameRun = typeof input.walletRunId === "string" && this.db.prepare(`SELECT 1 FROM live_read_cards
      WHERE owner_id=? AND scope='review' AND operation_id=?
      AND json_extract(accepted_input_json,'$.action')='request_signature'
      AND json_extract(accepted_input_json,'$.walletRunId')=? LIMIT 1`).get(this.ownerId, request.attemptId, input.walletRunId);
    if (!sameRun) throw new WorkflowConflict("This request belongs to an earlier wallet service run. Check its saved result instead.");
    this.consume(card, input, request.attemptId, !["awaiting_signature", "submitting", "awaiting_chain_result"].includes(request.requestStatus));
    return { request, created: false };
  }
  recoverRequest(expected: CardRecord, input: Record<string, unknown>, binding: {
    reviewSessionId: string; reviewRevision: number; account: string; connectionId: string;
  }): { request: TransactionRequest; created: false } | undefined {
    return this.db.transaction(() => this.recoverRequestAt(expected, input, binding, this.clock())).immediate();
  }
  admitRequest(expected: CardRecord, input: Record<string, unknown>, material: ValidatedReviewMaterial,
    reviewConnection: WalletConnection, walletRunId: string): { request: TransactionRequest; created: boolean } {
    const result = this.db.transaction(() => {
      const now = this.clock();
      this.assertWalletInputAllowed();
      const binding = { reviewSessionId: material.reviewSessionId, planId: material.planId, account: material.account,
        reviewRevision: material.reviewRevision, transactionDigest: material.reviewedTransactionDigest,
        connectionId: reviewConnection.connectionId, grantRevision: reviewConnection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] };
      const recovered = this.recoverRequestAt(expected, input, binding, now);
      if (recovered) return recovered;
      const card = this.requireInput(expected, now);
      if (card.scope !== "review" || card.state.input.reviewSessionId !== material.reviewSessionId) throw new WorkflowConflict("The request does not belong to this review card.");
      const sessions = new SqliteSessionRecordStore(this.db), current = sessions.get(material.reviewSessionId);
      const artifacts = new SqlitePrivateReviewArtifactStore(this.db).get(material.reviewSessionId);
      const stored = this.materialStore.getTransactionMaterial(material.transactionMaterial, now);
      if (!current || !materialStillMatches(material, current, sessions.revision(current.id)!, artifacts, stored, now)) {
        // Expected expiry commits its normal cleanup, but no request authority.
        // A changed candidate is a conflict and must not invalidate newer data.
        const evaluated = this.evaluateState({ purpose: "review", reviewSessionId: material.reviewSessionId,
          readTarget: this.reviewReadTarget(material.reviewSessionId, card), expectedCard: card, candidate: { session: material.review, rowRevision: material.rowRevision,
          artifacts: material.artifacts, material }, walletAvailability: { status: "available", walletRunId } }, now);
        return new WorkflowConflict("The transaction details used by this review are no longer current.", evaluated.events);
      }
      const review = this.db.prepare("SELECT * FROM live_review_sessions WHERE id=?").get(binding.reviewSessionId) as ReviewRow | undefined;
      const state = review?.review_state_json ? JSON.parse(review.review_state_json) as Record<string, unknown> : undefined;
      const data = state?.transactionReviewData as { reviewedTransactionDigest?: string } | undefined;
      const connection = this.connection(binding.connectionId);
      if (!review || review.status !== "ready_for_wallet_review" || review.preparation_id !== null || review.account !== binding.account ||
          review.wallet_connection_id !== binding.connectionId || review.wallet_grant_revision !== binding.grantRevision ||
          review.review_revision !== binding.reviewRevision || state?.planId !== binding.planId ||
          data?.reviewedTransactionDigest !== binding.transactionDigest || Date.parse(review.expires_at) <= now.getTime() ||
          !this.isUsableConnection(binding.connectionId, now) || !isOwnedConnectedWallet(connection, this.ownerId, !!this.pendingDisconnect(binding.connectionId)) ||
          connection.connection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] !== binding.grantRevision || Date.parse(connection.connection.expiresAt) <= now.getTime() ||
          !connectionHasSuiSigningScope(connection.connection, binding.account)) {
        throw new WorkflowConflict("The account, wallet connection or transaction changed since this review was prepared.");
      }
      if (this.busyForAccount(binding.account, now)) throw new WorkflowConflict("Another wallet request or transaction result for this account is still pending.");
      this.requireAction(card, "request_signature", now);
      const account = this.db.prepare("SELECT id FROM accounts WHERE chain_id='sui:mainnet' AND address=?").get(binding.account) as { id: number } | undefined;
      if (!account) throw new WorkflowConflict("The reviewed account is unavailable.");
      const id = randomUUID();
      this.db.prepare(`INSERT INTO review_requests
        (attempt_id,review_session_id,plan_id,review_revision,account_id,transaction_digest,review_state_json,request_status,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'awaiting_signature',0,?,?)`).run(id, review.id, binding.planId, binding.reviewRevision,
          account.id, binding.transactionDigest, review.review_state_json, now.toISOString(), now.toISOString());
      this.db.prepare(`INSERT INTO live_request_authority
        (attempt_id,owner_id,connection_id,grant_revision,can_submit,sdk_pending,submit_pending,lookup_pending,signature_deadline,run_id)
        VALUES (?,?,?,?,1,1,0,0,?,?)`).run(id, this.ownerId, binding.connectionId, binding.grantRevision,
          new Date(Math.min(now.getTime() + SIGNATURE_WAIT_MS, Date.parse(review.expires_at))).toISOString(), walletRunId);
      this.db.prepare(`UPDATE live_review_sessions SET current_attempt_id=?, revision=revision+1, write_contract_version=? WHERE id=?`)
        .run(id, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, review.id);
      this.db.prepare("UPDATE review_sessions SET current_attempt_id=?, updated_at=? WHERE id=?").run(id, now.toISOString(), review.id);
      this.consume(card, input, id);
      this.recordRequestEvent(this.request(id)!, "request_admitted", undefined, now);

      return { request: this.request(id)!, created: true };
    }).immediate();
    if (result instanceof Error) throw result;
    return result;
  }

  busyForAccount(account: string, now: Date): boolean {
    return !!this.db.prepare(`SELECT 1 FROM live_request_authority l JOIN review_requests r ON r.attempt_id=l.attempt_id
      JOIN accounts a ON a.id=r.account_id AND a.chain_id='sui:mainnet' WHERE a.chain_id='sui:mainnet' AND a.address=? AND (l.sdk_pending=1 OR l.submit_pending=1 OR l.lookup_pending=1
        OR (r.request_status IN (SELECT value FROM json_each(?)) AND l.observation_stopped=0
          AND (l.lookup_deadline IS NULL OR l.lookup_deadline>?))) LIMIT 1`)
      .get(account, JSON.stringify(INITIAL_CHAIN_OBSERVATION_STATUSES), now.toISOString());
  }
  assertDataReplacementAllowed(now = new Date()): void {
    this.db.transaction(() => {
      this.advanceRequestDeadlines(now);
      if (hasUnsettledWalletWork(this.db, now)) throw new WorkflowConflict("Local data cannot be replaced while a wallet request or its initial chain observation is unsettled.");
    }).immediate();
  }
  advanceRequestDeadlines(now: Date, attemptId?: string): void {
    this.db.transaction(() => {
      const expired = this.db.prepare(`SELECT r.attempt_id,r.request_status FROM review_requests r
        JOIN live_request_authority l ON l.attempt_id=r.attempt_id WHERE l.owner_id=@owner
        AND (@attempt IS NULL OR r.attempt_id=@attempt)
        AND ((r.request_status='awaiting_signature' AND l.signature_deadline<=@now)
          OR (r.request_status IN (SELECT value FROM json_each(@chainStates)) AND l.lookup_deadline<=@now))`)
        .all({ owner: this.ownerId, attempt: attemptId ?? null, now: now.toISOString(),
          chainStates: JSON.stringify(INITIAL_CHAIN_OBSERVATION_STATUSES) }) as
          { attempt_id: string; request_status: TransactionRequestStatus }[];
      for (const row of expired) {
        this.transitionRequest(row.attempt_id, row.request_status === "awaiting_signature" ? "request_failed" : "outcome_unknown", now, {
          reason: row.request_status === "awaiting_signature"
            ? "Local signing wait expired. The wallet request may still be open."
            : "No chain result was confirmed within the initial observation window."
        });
      }
    }).immediate();
  }
  private recordRequestEvent(request: TransactionRequest, event: string, from: TransactionRequestStatus | undefined, now: Date): void {
    const account = this.db.prepare("SELECT id FROM accounts WHERE chain_id='sui:mainnet' AND address=?").get(request.account) as { id: number };
    this.db.prepare(`INSERT INTO review_status_transitions
      (review_session_id,event,attempt_id,domain,from_status,to_status,account_id,reason,transitioned_at)
      VALUES (?,?,?,'request',?,?,?,?,?)`).run(request.reviewSessionId, event, request.attemptId, from ?? null,
        request.requestStatus, account.id, request.reason ?? null, now.toISOString());
  }
  transitionRequest(id: string, next: TransactionRequestStatus, now: Date, options: {
    reason?: string; execution?: TransactionExecutionSummary; signatureVerified?: boolean; excludedCardId?: string;
    details?: { data: unknown; receiptDisplay?: ReceiptDisplay };
  } = {}): TransactionRequest | undefined {
    return this.db.transaction(() => {
      const old = this.request(id), authority = this.authority(id);
      if (!old || !authority || authority.owner_id !== this.ownerId) return undefined;
      if (old.requestStatus === next && (!options.signatureVerified || old.signatureVerifiedAt !== undefined)) return old;
      if (old.requestStatus !== next && !requestTransitions[old.requestStatus].includes(next)) return old;
      if (next === "completed") {
        const execution = transactionExecutionSummarySchema.parse(options.execution);
        if (execution.attemptId !== id || execution.reviewSessionId !== old.reviewSessionId || execution.planId !== old.planId ||
            execution.txDigest !== old.transactionDigest || execution.chainReceipt.sender !== old.account) {
          throw new WorkflowConflict("Chain result does not match the admitted transaction.");
        }
        const account = this.db.prepare("SELECT id FROM accounts WHERE chain_id='sui:mainnet' AND address=?").get(old.account) as { id: number };
        this.db.prepare(`INSERT INTO review_executions
          (attempt_id,review_session_id,plan_id,account_id,status,tx_digest,failure_reason,result_json,recorded_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, old.reviewSessionId, old.planId, account.id, execution.status, execution.txDigest,
            execution.failureReason ?? null, JSON.stringify(execution), now.toISOString(), now.toISOString());
        if (options.details) {
          assertNoForbiddenMcpFields(options.details.data);
          const display = options.details.receiptDisplay ? receiptDisplaySchema.parse(options.details.receiptDisplay) : undefined;
          if (display && display.transactionDigest !== old.transactionDigest) throw new WorkflowConflict("Receipt display digest differs from the request.");
          this.db.prepare("INSERT INTO live_execution_details VALUES (?,?,?)")
            .run(id, JSON.stringify(options.details.data), display ? JSON.stringify(display) : null);
        }
      }
      this.db.prepare(`UPDATE review_requests SET request_status=?, reason=?, revision=revision+1, updated_at=?,
        signature_verified_at=COALESCE(signature_verified_at,?), submitted_at=COALESCE(submitted_at,?) WHERE attempt_id=? AND revision=?`)
        .run(next, options.reason ?? old.reason ?? null, now.toISOString(), options.signatureVerified ? now.toISOString() : null,
          next === "submitting" ? now.toISOString() : null, id, old.revision);
      if (next !== "awaiting_signature") this.db.prepare("UPDATE live_request_authority SET can_submit=0 WHERE attempt_id=?").run(id);
      const result = this.request(id)!;
      this.recordRequestEvent(result, options.signatureVerified ? "signature_verified" : next === "completed" ? "chain_result_recorded" : "request_status_changed", old.requestStatus, now);
      this.db.prepare("UPDATE review_sessions SET updated_at=? WHERE id=?").run(now.toISOString(), old.reviewSessionId);
      this.publish(id, !["awaiting_signature", "submitting", "awaiting_chain_result"].includes(next), options.excludedCardId);
      if (["stopped", "request_failed", "outcome_unknown", "completed"].includes(next)) {
        // A historical attempt may finish while a newer review is preparing.
        // Clean only the material still owned by this admitted revision.
        for (const table of ["live_transaction_materials", "live_private_review_artifacts"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE review_session_id=? AND EXISTS
            (SELECT 1 FROM live_review_sessions WHERE id=? AND review_revision=? AND preparation_id IS NULL)`)
            .run(old.reviewSessionId, old.reviewSessionId, old.reviewRevision);
        }
      }
      return result;
    }).immediate();
  }
  beginSubmission(id: string): boolean {
    return this.db.transaction(() => {
      const now = this.clock();
      const request = this.request(id), authority = this.authority(id);
      if (!request || !authority || authority.owner_id !== this.ownerId || authority.can_submit !== 1 || authority.run_id !== (this.runId ?? null) ||
          (this.db.prepare("SELECT wallet_input_blocked FROM settings_control WHERE id=1").get() as { wallet_input_blocked: number }).wallet_input_blocked !== 0 ||
          request.requestStatus !== "awaiting_signature" || Date.parse(authority.signature_deadline) <= now.getTime()) return false;
      const connection = this.connection(authority.connection_id);
      if (!this.isUsableConnection(authority.connection_id, now, SUI_MAINNET_WALLET_CHAIN, request.account) ||
          !isOwnedConnectedWallet(connection, this.ownerId, !!this.pendingDisconnect(authority.connection_id)) ||
          connection.connection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] !== authority.grant_revision ||
          !connectionHasSuiSigningScope(connection.connection, request.account) || Date.parse(connection.connection.expiresAt) <= now.getTime()) return false;
      this.db.prepare("UPDATE live_request_authority SET can_submit=0, submit_pending=1, lookup_deadline=? WHERE attempt_id=?")
        .run(new Date(now.getTime() + CHAIN_RECEIPT_LOOKUP_MAX_AGE_MS).toISOString(), id);
      return this.transitionRequest(id, "submitting", now)?.requestStatus === "submitting";
    }).immediate();
  }
  finishSubmission(id: string): void {
    this.db.transaction(() => {
      const now = this.clock();
      this.advanceRequestDeadlines(now, id);
      // Observation may have finished, or its window may have closed, while
      // submit was pending. A late response cannot reopen either outcome.
      if (this.request(id)?.requestStatus === "submitting") this.transitionRequest(id, "awaiting_chain_result", now);
    }).immediate();
  }
  settle(id: string, field: "sdk_pending" | "submit_pending" | "lookup_pending", pending: boolean): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE live_request_authority SET ${field}=? WHERE attempt_id=? AND owner_id=?`).run(Number(pending), id, this.ownerId);
      if (field === "lookup_pending" && !pending) {
        const request = this.request(id);
        if (request && !isInitialChainObservation(request.requestStatus)) this.publish(id, true);
      }
    }).immediate();
  }

  private stopWaiting(id: string, now: Date, cause: RequestInterruptionCause, excludedCardId?: string): TransactionRequest | undefined {
    return this.db.transaction(() => {
      const request = this.request(id), authority = this.authority(id);
      if (!request || !authority || authority.owner_id !== this.ownerId) return request;
      if (request.requestStatus === "awaiting_signature") return this.transitionRequest(id, cause === "wallet_service_lost" ? "request_failed" : "stopped", now, { reason: interruptionReasons[cause], ...(excludedCardId ? { excludedCardId } : {}) });
      // Once submitted, connection changes cannot revoke a transaction or the
      // independent lookup of its digest. Only explicit user stopping ends observation.
      if (cause === "user_stop" && authority.observation_stopped === 0 &&
          ["submitting", "awaiting_chain_result", "outcome_unknown"].includes(request.requestStatus)) {
        this.db.prepare("UPDATE live_request_authority SET observation_stopped=1 WHERE attempt_id=?").run(id);
        this.publish(id, false, excludedCardId);
      }
      return this.request(id);
    }).immediate();
  }
  resumeObservation(id: string): void {
    this.db.prepare("UPDATE live_request_authority SET observation_stopped=0 WHERE attempt_id=? AND owner_id=?").run(id, this.ownerId);
  }
  private invalidateConnectionRequests(connectionId: string, now: Date, cause: Exclude<RequestInterruptionCause, "user_stop">, runId?: string): void {
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM live_review_sessions v WHERE wallet_connection_id=? AND owner_id=? AND status!='expired'
        AND (? IS NULL OR v.preparation_run_id=?)
        AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.review_session_id=v.id AND r.review_revision=v.review_revision)`)
        .all(connectionId, this.ownerId, runId ?? null, runId ?? null) as ReviewRow[];
      for (const row of rows) {
        const state = row.review_state_json ? JSON.parse(row.review_state_json) as Record<string, unknown> : undefined;
        // Later session observations cannot rewrite why an already interrupted
        // preparation ended. A new admitted preparation clears this error.
        if (!row.preparation_id && row.preparation_error && !state?.transactionReviewData) continue;
        if (state) {
          delete state.transactionReviewData; delete state.blockedReason;
          state.status = "refresh_required"; state.refreshReason = "wallet_connection_changed";
        }
        const status = state ? "refresh_required" : row.status;
        this.db.prepare(`UPDATE live_review_sessions SET status=?,preparation_id=NULL,preparation_error=?,review_state_json=?,
          revision=revision+1,write_contract_version=? WHERE id=?`).run(status,
          preparationInterruptionReasons[cause],
          state ? JSON.stringify(state) : null, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, row.id);
        this.db.prepare("UPDATE review_sessions SET current_status=?,updated_at=? WHERE id=?").run(status, now.toISOString(), row.id);
        this.db.prepare(`INSERT INTO review_status_transitions(review_session_id,event,from_status,to_status,reason,transitioned_at)
          VALUES (?,'review_invalidated',?,?,?,?)`).run(row.id, row.status, status, preparationInterruptionReasons[cause], now.toISOString());
        this.publishReview(row.id);
      }
    }).immediate();
    for (const row of this.db.prepare("SELECT attempt_id FROM live_request_authority WHERE connection_id=? AND owner_id=? AND (? IS NULL OR run_id=?)")
      .all(connectionId, this.ownerId, runId ?? null, runId ?? null) as { attempt_id: string }[]) this.stopWaiting(row.attempt_id, now, cause);
  }
  cancelInput(expected: CardRecord): void {
    this.db.transaction(() => {
      const now = this.clock();
      const card = this.currentCard(expected);
      if (card.scope === "connect" && card.state.state === "running" && card.state.revision === expected.state.revision) {
        const operation = this.cardOperation(card);
        if (operation?.status === "running") { this.stopConnection(card, operation.operationId); return; }
      }
      this.requireInput(card, now);
      this.requireAction(card, "cancel", now);
      const pairing = card.scope === "connect" ? this.cardOperation(card) : undefined;
      if (pairing?.status === "running") this.stopConnection(card, pairing.operationId);
      this.closeCancelledCard(card);
    }).immediate();
  }
  beginReviewPreparation(expected: CardRecord, reviewRevision: number, connection: WalletConnection, account: string): string {
    return this.db.transaction(() => {
      const now = this.clock();
      this.assertWalletInputAllowed();
      const card = this.requireInput(expected, now);
      if (card.scope !== "review" || typeof card.state.input.reviewSessionId !== "string") throw new WorkflowConflict("This card cannot update the review.");
      const id = card.state.input.reviewSessionId;
      const review = this.db.prepare("SELECT * FROM live_review_sessions WHERE id=?").get(id) as ReviewRow | undefined;
      const currentConnection = this.connection(connection.connectionId);
      if (!review || review.preparation_id !== null || review.review_revision !== reviewRevision ||
          review.status === "expired" || Date.parse(review.expires_at) <= now.getTime() ||
          !this.isUsableConnection(connection.connectionId, now) || !isOwnedConnectedWallet(currentConnection, this.ownerId, !!this.pendingDisconnect(connection.connectionId)) ||
          currentConnection.connection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] !== connection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] || Date.parse(currentConnection.connection.expiresAt) <= now.getTime()) throw new WorkflowConflict("The review could not be updated with the current wallet and account.");
      if (review.wallet_connection_id && review.wallet_connection_id !== connection.connectionId) {
        throw new WorkflowConflict("This review remains bound to its original wallet connection.");
      }
      const binding = fixedReviewTarget({ ...(review.account ? { account: review.account } : {}),
        ...(review.wallet_connection_id ? { walletConnectionId: review.wallet_connection_id } : {}) }, card.state.input);
      if (!binding || binding.connectionId !== connection.connectionId || binding.account !== account) throw new WorkflowConflict("The review target changed before preparation.");
      if (this.busyForAccount(binding.account, now)) throw new WorkflowConflict("Another wallet request or transaction result for this account is still pending.");
      const target = this.requireAction(card, "prepare_review", now).reviewTarget;
      if (target?.connectionId !== connection.connectionId || target.account !== account) throw new WorkflowConflict("The review target changed before preparation.");
      if (fixedChainAccount(currentConnection.connection, SUI_MAINNET_WALLET_CHAIN) !== binding.account) throw new WorkflowConflict("The review could not be updated with its fixed wallet account.");
      const preparation = randomUUID();
      this.db.prepare(`UPDATE live_review_sessions SET preparation_id=?,preparation_run_id=?,preparation_error=NULL,wallet_connection_id=?,wallet_grant_revision=?,revision=revision+1,write_contract_version=? WHERE id=?`)
        .run(preparation, this.runId ?? null, connection.connectionId, connection.grantRevisions[SUI_MAINNET_WALLET_CHAIN], LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, id);
      this.publishReview(id);
      return preparation;
    }).immediate();
  }
  isPreparing(id: string, preparationId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM live_review_sessions WHERE id=? AND preparation_id=? AND owner_id=?")
      .get(id, preparationId, this.ownerId);
  }
  failPreparation(id: string, preparationId: string, now: Date): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM live_review_sessions WHERE id=? AND preparation_id=? AND owner_id=?")
        .get(id, preparationId, this.ownerId) as ReviewRow | undefined;
      if (!row) return;
      const prior = row.review_state_json ? JSON.parse(row.review_state_json) as Record<string, unknown> : undefined;
      if (prior && row.status !== "expired") {
        delete prior.transactionReviewData; delete prior.blockedReason;
        prior.status = "refresh_required"; prior.refreshReason = "review_update_failed";
      }
      const status = prior && row.status !== "expired" ? "refresh_required" : row.status;
      this.db.prepare(`UPDATE live_review_sessions SET preparation_id=NULL,preparation_error=?,status=?,review_state_json=?,revision=revision+1,write_contract_version=? WHERE id=?`)
        .run(row.status === "expired" ? "The review expired while it was being updated." : "The review update could not be completed.",
          status, prior ? JSON.stringify(prior) : null, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, id);
      this.db.prepare("UPDATE review_sessions SET current_status=?,updated_at=? WHERE id=?").run(status, now.toISOString(), id);
      this.db.prepare(`INSERT INTO review_status_transitions(review_session_id,event,from_status,to_status,reason,transitioned_at)
        VALUES (?,'review_update_failed',?,?,?,?)`).run(id, row.status, status, "Review update could not be completed.", now.toISOString());
      this.publishReview(id);
    }).immediate();
  }
  markReviewOpened(reviewSessionId: string, now: Date): void {
    this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE review_sessions SET opened_at=? WHERE id=? AND opened_at IS NULL").run(now.toISOString(), reviewSessionId);
      if (!changed.changes) return;
      const row = this.db.prepare("SELECT current_status,account_id FROM review_sessions WHERE id=?").get(reviewSessionId) as { current_status: string; account_id: number | null };
      this.db.prepare(`INSERT INTO review_status_transitions(review_session_id,event,from_status,to_status,account_id,transitioned_at)
        VALUES (?,'opened',?,?,?,?)`).run(reviewSessionId, row.current_status, row.current_status, row.account_id, now.toISOString());
    }).immediate();
  }
  recover(now: Date): void {
    this.db.transaction(() => {
      const reviews = this.db.prepare("SELECT id,status,account FROM live_review_sessions WHERE owner_id!=?")
        .all(this.ownerId) as { id: string; status: string; account: string | null }[];
      for (const review of reviews) {
        this.db.prepare("DELETE FROM live_transaction_materials WHERE review_session_id=?").run(review.id);
        this.db.prepare("DELETE FROM live_private_review_artifacts WHERE review_session_id=?").run(review.id);
        if (review.status !== "expired") {
          const account = review.account ? this.db.prepare("SELECT id FROM accounts WHERE chain_id='sui:mainnet' AND address=?").get(review.account) as { id: number } | undefined : undefined;
          this.db.prepare(`INSERT INTO review_status_transitions(review_session_id,event,from_status,to_status,account_id,reason,transitioned_at)
            VALUES (?,'expired',?,'expired',?,'server_restarted',?)`).run(review.id, review.status, account?.id ?? null, now.toISOString());
          this.db.prepare("UPDATE review_sessions SET current_status='expired',updated_at=? WHERE id=?").run(now.toISOString(), review.id);
        }
      }
      this.db.prepare(`UPDATE live_review_sessions SET owner_id=?,status='expired',preparation_id=NULL,
        revision=revision+1,write_contract_version=? WHERE owner_id!=?`)
        .run(this.ownerId, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, this.ownerId);
      for (const row of this.db.prepare("SELECT operation_id FROM wallet_connection_operations WHERE owner_id!=? AND status='running'")
        .all(this.ownerId) as { operation_id: string }[]) {
        const op = this.operation(row.operation_id)!;
        this.finishConnectionOperation(op.operationId, "stopped", "The server restarted before this operation was confirmed.", now, "run_ended");
        if (op.connectionId) {
          const record = this.connection(op.connectionId);
          if (record) {
            const next = { ...record.connection, status: op.action === "connect" ? "stopped" as const : "failed" as const,
              revision: record.connection.revision + 1, updatedAt: now.toISOString(), reason: "The server restarted before the wallet operation was confirmed." };
            this.db.prepare("UPDATE live_wallet_connections SET owner_id=?,status=?,revision=?,connection_json=? WHERE id=?")
              .run(this.ownerId, next.status, next.revision, JSON.stringify(next), next.connectionId);
          }
        }
      }
      const old = this.db.prepare("SELECT attempt_id FROM live_request_authority WHERE owner_id!=?").all(this.ownerId) as { attempt_id: string }[];
      for (const { attempt_id: id } of old) {
        this.db.prepare("UPDATE live_request_authority SET owner_id=?,can_submit=0,sdk_pending=0,submit_pending=0,lookup_pending=0 WHERE attempt_id=?").run(this.ownerId, id);
        const request = this.request(id)!;
        if (["awaiting_signature", "submitting", "awaiting_chain_result"].includes(request.requestStatus)) {
          this.transitionRequest(id, "outcome_unknown", now, { reason: "The server restarted. The request will not be sent again." });
        }
      }
      for (const { id } of this.db.prepare("SELECT id FROM live_read_cards WHERE kind IN ('connect','disconnect','review') AND state!='closed' AND owner_id!=?").all(this.ownerId) as { id: string }[]) {
        const card = this.cards.get(id)!;
        const next = { ...card, ownerId: this.ownerId, state: { ...card.state, state: "closed" as const,
          reason: card.state.state === "ready" && Date.parse(card.state.expiresAt) <= now.getTime() ? "expired" as const : "server_restarted" as const, revision: card.state.revision + 1 } };
        if (!this.replaceCard(card, next, now)) throw new WorkflowConflict("The interrupted wallet card could not be saved.");
      }
    }).immediate();
  }
}

export function hasUnsettledWalletWork(db: SqliteDatabase, now = new Date()): boolean {
  return !!db.prepare("SELECT 1 FROM wallet_connection_operations WHERE sdk_pending=1 OR status='running' LIMIT 1").get() ||
    !!db.prepare(`SELECT 1 FROM live_request_authority l JOIN review_requests r ON r.attempt_id=l.attempt_id
    WHERE l.sdk_pending=1 OR l.submit_pending=1 OR l.lookup_pending=1
      OR (r.request_status IN (SELECT value FROM json_each(?)) AND (l.lookup_deadline IS NULL OR l.lookup_deadline>?)) LIMIT 1`)
    .get(JSON.stringify(INITIAL_CHAIN_OBSERVATION_STATUSES), now.toISOString());
}
