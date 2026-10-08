import type { EventLogRecord } from "../eventlog/sink.js";
import { walletRecoverySchema, type WalletRecovery, type WalletSnapshot } from "./walletRuntime.js";
import { materialStillMatches, type ValidatedReviewMaterial } from "./reviewValidity.js";
import type { LocalTransactionMaterialStore } from "./transactionMaterialStore.js";
import { SqliteSessionRecordStore, SqlitePrivateReviewArtifactStore } from "./sqliteSessionStore.js";
import { reviewPreparationAccount, workflowEligibility, type ConnectionFacts, type ReviewReadTarget, type WorkflowEvaluationInput, type EvaluatedWorkflowState, type WorkflowAction, type ConnectionView } from "./workflowState.js";
import { SessionStoreError } from "./sessionErrors.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { reviewStateOutputSchema } from "../action/schemas.js";
import { LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION } from "./liveReviewSessionContract.js";
import { SqliteCardRecordStore } from "./sqliteCardStore.js";
import { receiptDisplaySchema, type CardRecord, type ReceiptDisplay } from "./cardSession.js";
import { isOwnedConnectedWallet, walletConnectionSelection, walletConnectionSchema, walletRecoveryImpactSchema, SUI_MAINNET_WALLET_CHAIN, SUI_SIGN_TRANSACTION_METHOD,
  type WalletConnection, type WalletConnectionRecord, type WalletSession, type StoredReadAccount, type WalletConnectionPresence, type WalletRecoveryImpact } from "./walletConnection.js";
import { SIGNATURE_WAIT_MS, CHAIN_RECEIPT_LOOKUP_MAX_AGE_MS, INITIAL_CHAIN_OBSERVATION_STATUSES, isInitialChainObservation, transactionRequestSchema,
  transactionExecutionSummarySchema, requestTransitions, type TransactionRequest,
  type TransactionRequestStatus, type TransactionExecutionSummary } from "./transactionRequest.js";

export class WorkflowConflict extends Error {
  constructor(message: string, readonly events: EventLogRecord[] = []) { super(message); }
}
export type RequestAuthority = {
  attempt_id: string; owner_id: string; run_id: string | null; connection_id: string; connection_revision: number;
  can_submit: number; sdk_pending: number; submit_pending: number; lookup_pending: number;
  signature_deadline: string; lookup_deadline: string | null; observation_stopped: number;
};
type RequestRow = {
  attempt_id: string; review_session_id: string; plan_id: string; review_revision: number;
  account: string; transaction_digest: string; request_status: TransactionRequestStatus;
  revision: number; created_at: string; updated_at: string; reason: string | null;
  signature_verified_at: string | null; submitted_at: string | null; result_json: string | null;
};
type ReviewRow = { id: string; status: string; account: string | null; expires_at: string;
  review_revision: number; preparation_id: string | null; preparation_error: string | null;
  current_attempt_id: string | null; review_state_json: string | null };
const interruptionReasons = {
  user_stop: "User stopped waiting before submission.",
  wallet_change: "The wallet connection changed or became unavailable before submission. Nothing was submitted.",
  connection_conflict: "More than one wallet connection is present. Nothing was submitted.",
  disconnect_requested: "Wallet disconnection was requested before submission. Nothing was submitted.",
  wallet_service_restarted: "The wallet service was restarted before submission. Nothing was submitted.",
  wallet_service_lost: "The wallet service stopped before submission. Nothing was submitted."
} as const;
type RequestInterruptionCause = keyof typeof interruptionReasons;
const preparationInterruptionReasons = {
  wallet_change: "The selected wallet connection changed.",
  connection_conflict: "More than one wallet connection is present. Disconnect the connections you no longer need, then update this review.",
  disconnect_requested: "Disconnection of the selected wallet was requested. Connect a wallet before updating this review.",
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
    private readonly writeActiveAccount: (address: string, connectionId: string, walletName: string | undefined, now: Date) => void,
    private readonly clock: () => Date, private readonly materialStore: LocalTransactionMaterialStore,
    private readonly evaluateState: (input: WorkflowEvaluationInput, at?: Date) => EvaluatedWorkflowState,
    private readonly readActiveAccount: () => StoredReadAccount | undefined,
    private readonly readSdkSnapshot: () => WalletSnapshot | undefined) {
    this.cards = new SqliteCardRecordStore(db);
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

  walletRecovery(record: CardRecord): WalletRecovery | undefined {
    if (record.acceptedInput?.action !== "restart_wallet_service") return undefined;
    const recovery = walletRecoverySchema.parse(record.state.data);
    if (recovery.priorRunId !== record.acceptedInput.walletRunId || record.operationId !== undefined || record.scope !== "connect") {
      throw new WorkflowConflict("The saved wallet recovery does not match this card.");
    }
    if (record.state.state === "closed" && record.state.reason === "server_restarted") {
      return { kind: recovery.kind, priorRunId: recovery.priorRunId, admittedAt: recovery.admittedAt, updatedAt: recovery.updatedAt,
        ...("nextRunId" in recovery ? { nextRunId: recovery.nextRunId } : {}), outcome: "server_restarted",
        message: "The server restarted before this wallet recovery was confirmed." };
    }
    return recovery;
  }
  recordWalletFailure(input: { observedAt: string; runId?: string }): void {
    // Retried by the workflow until revocation is durably recorded. The SDK
    // run is already fenced, so a failed write cannot preserve usable authority.
    this.invalidateWalletRun("wallet_service_lost", new Date(input.observedAt), input.runId);
  }
  publishWalletState(): void { this.publishAvailableWallets(); }
  applyWalletObservation(snapshot: WalletSnapshot, previous: WalletSnapshot | undefined, ready: boolean, recordReady?: () => void): void {
    this.db.transaction(() => {
      for (const record of this.connections()) {
        if (!record.topic) continue;
        const observed = snapshot.sessions.find((item) => item.topic === record.topic);
        if (record.connection.status !== "connected") {
          // Startup can transfer management ownership; ordinary observations
          // update the current run's facts without restoring terminal authority.
          if ((ready || record.ownerId === this.ownerId && record.runId === snapshot.runId) &&
              observed?.status === "present" && !record.sdkPending &&
              !this.pendingDisconnect(record.connection.connectionId, record.ownerId)) {
            const transferred = record.ownerId !== this.ownerId || record.runId !== snapshot.runId;
            const changed = !isDeepStrictEqual(record.connection.accounts, observed.session.accounts) ||
              !isDeepStrictEqual(record.connection.methods, observed.session.methods) ||
              record.connection.expiresAt !== observed.session.expiresAt || record.connection.walletName !== observed.session.walletName;
            if (transferred) this.db.prepare("UPDATE live_wallet_connections SET owner_id=?,run_id=? WHERE id=?")
              .run(this.ownerId, snapshot.runId, record.connection.connectionId);
            if (transferred || changed) this.updateConnection(record.connection.connectionId, { accounts: observed.session.accounts,
              methods: observed.session.methods, expiresAt: observed.session.expiresAt, walletName: observed.session.walletName }, this.clock());
          }
          continue;
        }
        if (ready && observed?.status === "present" && !record.sdkPending && !this.pendingDisconnect(record.connection.connectionId, record.ownerId)) {
          this.restoreConnection(observed.session, this.clock());
        } else if (record.ownerId === this.ownerId) {
          if (!observed || observed.status === "absent") this.applyConnectionChange(record.connection.connectionId,
            { status: "disconnected", reason: "The wallet session is no longer present in the connection service." }, this.clock());
          else if (observed.status === "unusable") this.applyConnectionChange(record.connection.connectionId,
            { status: "failed", reason: "This wallet session is no longer usable for Sui mainnet." }, this.clock());
          else if (observed.status === "present" && previous?.sessions.find((item) => item.topic === record.topic)?.version !== observed.version) {
            this.applyConnectionChange(record.connection.connectionId, { accounts: observed.session.accounts,
              methods: observed.session.methods, expiresAt: observed.session.expiresAt, walletName: observed.session.walletName }, this.clock());
          }
        }
      }
      this.invalidateConflictingConnections(this.clock());
      if (ready) recordReady?.();
      if (ready) this.publishAvailableWallets();
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
      this.publishAvailableWallets();
    }).immediate();
  }

  connection(id: string): WalletConnectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM live_wallet_connections WHERE id=?").get(id) as
      { owner_id: string; run_id: string | null; topic: string | null; sdk_pending: number; connection_json: string } | undefined;
    return row ? { connection: walletConnectionSchema.parse(JSON.parse(row.connection_json)), ownerId: row.owner_id, ...(row.run_id === null ? {} : { runId: row.run_id }),
      sdkPending: row.sdk_pending === 1, ...(row.topic === null ? {} : { topic: row.topic }) } : undefined;
  }
  connections(): WalletConnectionRecord[] {
    return (this.db.prepare("SELECT id FROM live_wallet_connections ORDER BY id").all() as { id: string }[])
      .map(({ id }) => this.connection(id)!);
  }
  connectionView(connection: WalletConnection): ConnectionView {
    return { ...connection, ...(this.pendingDisconnect(connection.connectionId) ? { pendingAction: "disconnect" as const } : {}) };
  }
  private connectionPresence(records: WalletConnectionRecord[], snapshot: WalletSnapshot | undefined): WalletConnectionPresence {
    const pendingConnectionIds = records.filter((item) => item.ownerId === this.ownerId &&
      (item.sdkPending || !!this.pendingDisconnect(item.connection.connectionId))).map((item) => item.connection.connectionId);
    if (!snapshot || snapshot.runId !== this.runId) return { confirmed: false, connections: [], unrecorded: false, pendingConnectionIds };
    const connections: WalletConnectionPresence["connections"] = [];
    let unrecorded = false;
    for (const session of snapshot.sessions) {
      if (session.status !== "present") continue;
      const record = records.find((item) => item.topic === session.topic && item.ownerId === this.ownerId && item.runId === this.runId);
      if (record) connections.push({ connectionId: record.connection.connectionId, expiresAt: session.session.expiresAt });
      else unrecorded = true;
    }
    return { confirmed: true, connections, unrecorded, pendingConnectionIds };
  }
  readConnectionFacts(now: Date): ConnectionFacts {
    // A deferred read transaction reuses an outer admission transaction when
    // present. It never repairs callbacks, advances deadlines or reserves I/O.
    return this.db.transaction(() => {
      const records = this.connections(), snapshot = this.readSdkSnapshot(), account = this.readActiveAccount();
      return { evaluatedAt: now.toISOString(), activeAccount: account?.address, activeAccountConnectionId: account?.walletId,
        connections: records.filter((item) => item.ownerId === this.ownerId).map((item) => this.connectionView(item.connection)),
        connectionPresence: this.connectionPresence(records, snapshot),
        ...(snapshot ? { walletObservation: { runId: snapshot.runId, sequence: snapshot.sequence, observedAt: snapshot.observedAt } } : {}) };
    }).deferred();
  }
  connectionSelection(now = this.clock()) {
    const facts = this.readConnectionFacts(now);
    return walletConnectionSelection(facts.connections, now.getTime(), facts.connectionPresence,
      facts.activeAccount ? { address: facts.activeAccount, walletId: facts.activeAccountConnectionId } : undefined);
  }
  isUsableConnection(id: string, now = this.clock()): boolean {
    return this.connectionSelection(now).connection?.connectionId === id;
  }
  private invalidateConflictingConnections(now: Date): void {
    const selection = this.connectionSelection(now);
    if (selection.conflict || selection.connectionReconciliationRequired) for (const record of this.connections()) {
      if (record.ownerId === this.ownerId) this.invalidateConnectionRequests(record.connection.connectionId, now,
        selection.conflict ? "connection_conflict" : "wallet_change");
    }
  }
  settleConnection(id: string, source: { cardId: string; runId: string; action: "connect" | "disconnect";
    unrecordedOutcome?: "failed" | "stopped" | "rejected" }): void {
    this.db.transaction(() => {
      const card = this.cards.get(source.cardId);
      if (!card || card.ownerId !== this.ownerId || card.operationId !== id || card.acceptedInput?.action !== source.action ||
          card.acceptedInput.walletRunId !== source.runId) return;
      // A connection may progress from pairing to one admitted disconnect.
      // That later operation owns sdk_pending even if its result is already
      // visible and the original pairing's failed cleanup write arrives late.
      const disconnect = this.db.prepare(`SELECT id FROM live_read_cards WHERE owner_id=? AND scope='connect' AND operation_id=?
        AND json_extract(accepted_input_json,'$.action')='disconnect'`).get(this.ownerId, id) as { id: string } | undefined;
      if (source.action === "connect" && disconnect && disconnect.id !== source.cardId) return;
      const activeDisconnect = this.pendingDisconnect(id);
      if (source.action === "disconnect" && activeDisconnect && activeDisconnect.state.cardId !== source.cardId) return;
      const record = this.connection(id);
      if (!record || record.ownerId !== this.ownerId || record.runId !== source.runId) return;
      if (source.action === "connect" && record.connection.status === "awaiting_approval") {
        const status = source.unrecordedOutcome ?? "failed";
        this.updateConnection(id, { status, reason: status === "stopped" ? "The wallet service ended before this connection was confirmed."
          : status === "rejected" ? "The wallet declined the connection request."
          : "The wallet connection could not be recorded. Check any retained connection in your wallet app." }, this.clock(), undefined, false);
      } else this.db.prepare("UPDATE live_wallet_connections SET sdk_pending=0 WHERE id=? AND owner_id=?").run(id, this.ownerId);
    }).immediate();
  }
  pendingDisconnect(connectionId: string, ownerId = this.ownerId): CardRecord | undefined {
    const row = this.db.prepare(`SELECT id FROM live_read_cards WHERE owner_id=? AND scope='connect'
      AND state='running' AND operation_id=? AND json_extract(accepted_input_json,'$.action')='disconnect'`)
      .get(ownerId, connectionId) as { id: string } | undefined;
    return row ? this.cards.get(row.id) : undefined;
  }
  pendingConnectionCards(now: Date): CardRecord[] {
    return (this.db.prepare(`SELECT id FROM live_read_cards WHERE owner_id=? AND kind='connect'
      AND state!='closed' AND (state!='ready' OR expires_at>?) ORDER BY created_at DESC,id DESC`)
      .all(this.ownerId, now.toISOString()) as { id: string }[]).map(({ id }) => this.cards.get(id)!);
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
  private requireAction(card: CardRecord, action: WorkflowAction, now: Date): void {
    const session = card.state.kind === "review" ? new SqliteSessionRecordStore(this.db).get(String(card.state.input.reviewSessionId)) : undefined;
    const target = session ? this.reviewReadTarget(session.id, card) : undefined;
    const request = target?.attemptId ? this.request(target.attemptId) : undefined;
    if (card.state.kind === "review" && !session) throw new WorkflowConflict("The saved review is unavailable.");
    const connection = card.state.kind === "connect" && card.operationId ? this.connection(card.operationId)?.connection : undefined;
    // Wallet-dependent commands already passed the workflow availability guard.
    // This store checks DB eligibility; it does not measure SDK health.
    const connectionFacts = this.readConnectionFacts(now), targetAccount = session?.account ?? connectionFacts.activeAccount;
    const facts = { ...connectionFacts, ownerId: this.ownerId, record: card, session, request,
      authority: request ? this.authority(request.attemptId) : undefined, connection,
      walletAvailability: { status: "available" as const },
      busyForAccount: !!targetAccount && this.busyForAccount(targetAccount, now) };
    if (!workflowEligibility(facts).allowedActions.includes(action)) throw new WorkflowConflict("That action is not available right now.");
  }
  manage(expected: CardRecord, action: "stop_connection" | "stop_waiting" | "read_result"): string {
    return this.db.transaction(() => {
      const now = this.clock(), card = this.cards.get(expected.state.cardId);
      if (!card || card.ownerId !== this.ownerId || card.tokenHash !== expected.tokenHash ||
          card.state.revision !== expected.state.revision || card.scope !== expected.scope) throw new WorkflowConflict("This request does not match the card's current state.");
      const id = card.scope === "review_manage" ? String(card.state.input.attemptId) : card.operationId!;
      if (action !== "stop_connection") this.advanceRequestDeadlines(now, id);
      this.requireAction(card, action, now);
      if (action === "stop_connection") this.updateConnection(id, { status: "stopped", reason: "The connection request was stopped here. The approval screen may still be open in your wallet." }, now);
      else if (action === "stop_waiting") this.stopWaiting(id, now, "user_stop");
      else this.resumeObservation(id);
      return id;
    }).immediate();
  }
  expireConnections(now: Date): void {
    for (const record of this.connections()) if (record.ownerId === this.ownerId && record.connection.status === "awaiting_approval" &&
      Date.parse(record.connection.expiresAt) <= now.getTime()) this.updateConnection(record.connection.connectionId,
        { status: "expired", reason: "The time to approve this connection has ended." }, now);
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
    if (!this.cards.replace(card, next)) throw new WorkflowConflict("The card changed before this action was accepted.");
  }
  private publish(operationId: string, terminal: boolean): void {
    this.db.prepare(`UPDATE live_read_cards SET revision=revision+1,
      state=CASE WHEN @terminal=1 THEN 'closed' ELSE state END,
      reason=CASE WHEN @terminal=1 THEN 'completed' ELSE reason END
      WHERE operation_id=@id`).run({ terminal: terminal ? 1 : 0, id: operationId });
  }
  private publishConnection(connectionId: string, status: WalletConnection["status"]): void {
    // Connection updates are not completion of every operation referencing it.
    // In particular, session_update(connected) must not finish a pending disconnect.
    const outcome = this.connection(connectionId)?.connection;
    this.db.prepare(`UPDATE live_read_cards SET revision=revision+1,
      result_json=CASE WHEN state='running' AND json_extract(accepted_input_json,'$.action')='disconnect'
        AND @disconnectTerminal THEN @outcome ELSE result_json END,
      reason=CASE WHEN state='running' AND
        CASE WHEN json_extract(accepted_input_json,'$.action')='disconnect'
          THEN @disconnectTerminal ELSE @connectionTerminal END THEN 'completed' ELSE reason END,
      state=CASE WHEN state='running' AND
        CASE WHEN json_extract(accepted_input_json,'$.action')='disconnect'
          THEN @disconnectTerminal ELSE @connectionTerminal END THEN 'closed' ELSE state END
      WHERE scope='connect' AND operation_id=@id`).run({ id: connectionId, outcome: outcome ? JSON.stringify({ disconnectOutcome: outcome }) : null,
        disconnectTerminal: Number(status !== "connected" && status !== "awaiting_approval"),
        connectionTerminal: Number(status !== "awaiting_approval") });
  }

  recoveryImpact(runId: string): WalletRecoveryImpact {
    return walletRecoveryImpactSchema.parse({
      runId,
      connections: this.connections().filter((record) => record.ownerId === this.ownerId && record.runId === runId)
        .map((record) => ({ connectionId: record.connection.connectionId, revision: record.connection.revision,
          status: record.connection.status, accounts: record.connection.accounts, walletName: record.connection.walletName,
          sdkPending: record.sdkPending, disconnectPending: !!this.pendingDisconnect(record.connection.connectionId) })),
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
      for (const record of this.connections()) {
        if (record.ownerId !== this.ownerId || record.runId !== runId) continue;
        const pending = this.pendingDisconnect(record.connection.connectionId);
        if (pending) this.finishDisconnect(pending.state.cardId, record.connection.connectionId, false, this.clock());
        else if (record.connection.status === "awaiting_approval") this.updateConnection(record.connection.connectionId,
          { status: "stopped", reason: "The wallet service ended before this connection was confirmed." }, this.clock(), undefined, false);
        this.db.prepare("UPDATE live_wallet_connections SET sdk_pending=0 WHERE id=? AND run_id=? AND sdk_pending=1").run(record.connection.connectionId, runId);
      }
    }).immediate();
  }
  private publishAvailableWallets(): void {
    this.db.prepare("UPDATE live_read_cards SET revision=revision+1 WHERE owner_id=? AND kind IN ('connect','review') AND state='ready'").run(this.ownerId);
  }
  private publishReview(id: string): void {
    this.db.prepare(`UPDATE live_read_cards SET revision=revision+1 WHERE owner_id=? AND kind='review' AND state='ready'
      AND json_extract(input_json,'$.reviewSessionId')=?`).run(this.ownerId, id);
  }

  admitConnection(expected: CardRecord, input: Record<string, unknown>): WalletConnectionRecord {
    return this.db.transaction(() => {
      const now = this.clock();
      this.assertWalletInputAllowed();
      this.expireConnections(now);
      const card = this.requireInput(expected, now);
      this.requireAction(card, "connect", now);
      const connection = walletConnectionSchema.parse({ connectionId: randomUUID(), status: "awaiting_approval", revision: 0,
        accounts: [], methods: [], chain: SUI_MAINNET_WALLET_CHAIN, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        expiresAt: card.state.expiresAt });
      this.db.prepare("INSERT INTO live_wallet_connections (id,owner_id,status,revision,topic,sdk_pending,connection_json,run_id) VALUES (?,?,?,?,?,?,?,?)")
        .run(connection.connectionId, this.ownerId, connection.status, 0, null, 1, JSON.stringify(connection), this.runId ?? null);
      this.consume(card, input, connection.connectionId);
      // Every other live input observes the admitted connection before the SDK
      // responds, so an older selection cannot bypass the one-connection rule.
      this.publishAvailableWallets();
      return this.connection(connection.connectionId)!;
    }).immediate();
  }
  updateConnection(id: string, update: Partial<WalletConnection>, now: Date, topic?: string, sdkPending?: boolean): WalletConnectionRecord | undefined {
    return this.db.transaction(() => {
      const old = this.connection(id);
      if (!old || old.ownerId !== this.ownerId) return undefined;
      const next = walletConnectionSchema.parse({ ...old.connection, ...update,
        connectionId: id, revision: old.connection.revision + 1, updatedAt: now.toISOString() });
      assertNoForbiddenMcpFields(next);
      this.db.prepare(`UPDATE live_wallet_connections SET status=?, revision=?, topic=?, sdk_pending=?, connection_json=?
        WHERE id=? AND owner_id=? AND revision=?`).run(next.status, next.revision, topic ?? old.topic ?? null,
          sdkPending === undefined ? Number(old.sdkPending) : Number(sdkPending), JSON.stringify(next), id, this.ownerId, old.connection.revision);
      this.invalidateConflictingConnections(now);
      this.publishConnection(id, next.status);
      this.publishAvailableWallets();
      if (next.status === "connected" && next.accounts.length === 1 && old.connection.status === "awaiting_approval" && this.isUsableConnection(id, now)) {
        this.writeActiveAccount(next.accounts[0]!, id, next.walletName, now);
      }
      return this.connection(id);
    }).immediate();
  }
  applyConnectionChange(id: string, update: Partial<WalletConnection>, now: Date): void {
    this.db.transaction(() => {
      this.invalidateConnectionRequests(id, now, "wallet_change");
      this.updateConnection(id, update, now);
    }).immediate();
  }
  restoreConnection(session: WalletSession, now: Date): WalletConnectionRecord {
    const existing = (this.db.prepare("SELECT id FROM live_wallet_connections WHERE topic=?").get(session.topic) as { id: string } | undefined);
    const id = existing?.id ?? randomUUID();
    const prior = existing ? this.connection(id)! : undefined;
    if (prior?.ownerId === this.ownerId && prior.runId === this.runId && prior.connection.status === "connected" && !prior.sdkPending &&
        isDeepStrictEqual(prior.connection.accounts, session.accounts) && isDeepStrictEqual(prior.connection.methods, session.methods) &&
        prior.connection.expiresAt === session.expiresAt && prior.connection.walletName === session.walletName) return prior;
    const next = walletConnectionSchema.parse({ connectionId: id, status: "connected", revision: (prior?.connection.revision ?? -1) + 1,
      accounts: session.accounts, methods: session.methods, chain: session.chain,
      createdAt: prior?.connection.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: session.expiresAt, walletName: session.walletName });
    this.db.prepare(`INSERT INTO live_wallet_connections (id,owner_id,status,revision,topic,sdk_pending,connection_json,run_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      owner_id=excluded.owner_id, status=excluded.status, revision=excluded.revision, topic=excluded.topic,
      sdk_pending=0, connection_json=excluded.connection_json,run_id=excluded.run_id`).run(id, this.ownerId, next.status, next.revision,
        session.topic, 0, JSON.stringify(next), this.runId ?? null);
    this.publishConnection(id, next.status);
    // Restoring the SDK session never restores a cleared read-account context.
    return this.connection(id)!;
  }
  useAccount(expected: CardRecord, input: Record<string, unknown>, connectionId: string, account: string): void {
    this.db.transaction(() => {
      const now = this.clock();
      this.assertWalletInputAllowed();
      const card = this.requireInput(expected, now), connection = this.connection(connectionId);
      if (card.scope !== "connect" || !this.isUsableConnection(connectionId, now) || !isOwnedConnectedWallet(connection, this.ownerId, !!this.pendingDisconnect(connectionId)) ||
          Date.parse(connection.connection.expiresAt) <= now.getTime() || !connection.connection.accounts.includes(account)) {
        throw new WorkflowConflict("The selected wallet account is no longer available.");
      }
      this.requireAction(card, "use_account", now);
      this.writeActiveAccount(account, connectionId, connection.connection.walletName, now);
      this.consume(card, input, connectionId, true);
      this.publishAvailableWallets();
    }).immediate();
  }
  admitDisconnect(expected: CardRecord, input: Record<string, unknown>, connectionId: string): WalletConnectionRecord {
    return this.db.transaction(() => {
      const now = this.clock();
      this.assertWalletInputAllowed();
      const card = this.requireInput(expected, now), connection = this.connection(connectionId);
      if (card.scope !== "connect" || !connection || connection.ownerId !== this.ownerId || connection.runId !== this.runId ||
          connection.sdkPending || !this.connectionSelection(now).manageableConnectionIds.includes(connectionId)) {
        throw new WorkflowConflict("The wallet connection is no longer available.");
      }
      this.requireAction(card, "disconnect", now);
      this.consume(card, input, connectionId);
      this.db.prepare("UPDATE live_wallet_connections SET sdk_pending=1 WHERE id=? AND owner_id=?").run(connectionId, this.ownerId);
      this.invalidateConnectionRequests(connectionId, now, "disconnect_requested");
      this.publishAvailableWallets();
      return connection;
    }).immediate();
  }
  finishDisconnect(cardId: string, connectionId: string, succeeded: boolean, now: Date): void {
    this.db.transaction(() => {
      const pending = this.pendingDisconnect(connectionId);
      // A session deletion event may have already completed this operation.
      if (pending?.state.cardId !== cardId) return;
      this.updateConnection(connectionId, succeeded ? { status: "disconnected" } : {
        status: "failed", reason: "The wallet disconnection could not be confirmed. The connection may remain in your wallet app."
      }, now);
    }).immediate();
  }
  recoverDisconnect(cardId: string, connectionId: string, revision: number, sessionAbsent: boolean): void {
    this.db.transaction(() => {
      const connection = this.connection(connectionId);
      if (!connection || connection.ownerId !== this.ownerId || connection.sdkPending ||
          connection.connection.revision !== revision || this.pendingDisconnect(connectionId)?.state.cardId !== cardId) return;
      this.finishDisconnect(cardId, connectionId, sessionAbsent, this.clock());
    }).immediate();
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
    selectedConnection: WalletConnection, walletRunId: string): { request: TransactionRequest; created: boolean } {
    const result = this.db.transaction(() => {
      const now = this.clock();
      this.assertWalletInputAllowed();
      const binding = { reviewSessionId: material.reviewSessionId, planId: material.planId, account: material.account,
        reviewRevision: material.reviewRevision, transactionDigest: material.reviewedTransactionDigest,
        connectionId: selectedConnection.connectionId, connectionRevision: selectedConnection.revision };
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
          review.review_revision !== binding.reviewRevision || state?.planId !== binding.planId ||
          data?.reviewedTransactionDigest !== binding.transactionDigest || Date.parse(review.expires_at) <= now.getTime() ||
          !this.isUsableConnection(binding.connectionId, now) || !isOwnedConnectedWallet(connection, this.ownerId, !!this.pendingDisconnect(binding.connectionId)) ||
          connection.connection.revision !== binding.connectionRevision || Date.parse(connection.connection.expiresAt) <= now.getTime() ||
          !connection.connection.accounts.includes(binding.account) || !connection.connection.methods.includes(SUI_SIGN_TRANSACTION_METHOD)) {
        throw new WorkflowConflict("The account, wallet connection or transaction changed since this review was prepared.");
      }
      this.requireAction(card, "request_signature", now);
      if (this.busyForAccount(binding.account, now)) throw new WorkflowConflict("Another wallet request or transaction result for this account is still pending.");
      const account = this.db.prepare("SELECT id FROM accounts WHERE sui_address=?").get(binding.account) as { id: number } | undefined;
      if (!account) throw new WorkflowConflict("The reviewed account is unavailable.");
      const id = randomUUID();
      this.db.prepare(`INSERT INTO review_requests
        (attempt_id,review_session_id,plan_id,review_revision,account_id,transaction_digest,review_state_json,request_status,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'awaiting_signature',0,?,?)`).run(id, review.id, binding.planId, binding.reviewRevision,
          account.id, binding.transactionDigest, review.review_state_json, now.toISOString(), now.toISOString());
      this.db.prepare(`INSERT INTO live_request_authority
        (attempt_id,owner_id,connection_id,connection_revision,can_submit,sdk_pending,submit_pending,lookup_pending,signature_deadline,run_id)
        VALUES (?,?,?,?,1,1,0,0,?,?)`).run(id, this.ownerId, binding.connectionId, binding.connectionRevision,
          new Date(Math.min(now.getTime() + SIGNATURE_WAIT_MS, Date.parse(review.expires_at))).toISOString(), walletRunId);
      this.db.prepare(`UPDATE live_review_sessions SET current_attempt_id=?, revision=revision+1, write_contract_version=? WHERE id=?`)
        .run(id, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, review.id);
      this.db.prepare("UPDATE review_sessions SET current_attempt_id=?, updated_at=? WHERE id=?").run(id, now.toISOString(), review.id);
      this.consume(card, input, id);
      this.recordRequestEvent(this.request(id)!, "request_admitted", undefined, now);
      this.publishAvailableWallets();
      return { request: this.request(id)!, created: true };
    }).immediate();
    if (result instanceof Error) throw result;
    return result;
  }

  busyForAccount(account: string, now: Date): boolean {
    return !!this.db.prepare(`SELECT 1 FROM live_request_authority l JOIN review_requests r ON r.attempt_id=l.attempt_id
      JOIN accounts a ON a.id=r.account_id WHERE a.sui_address=? AND (l.sdk_pending=1 OR l.submit_pending=1 OR l.lookup_pending=1
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
    const account = this.db.prepare("SELECT id FROM accounts WHERE sui_address=?").get(request.account) as { id: number };
    this.db.prepare(`INSERT INTO review_status_transitions
      (review_session_id,event,attempt_id,domain,from_status,to_status,account_id,reason,transitioned_at)
      VALUES (?,?,?,'request',?,?,?,?,?)`).run(request.reviewSessionId, event, request.attemptId, from ?? null,
        request.requestStatus, account.id, request.reason ?? null, now.toISOString());
  }
  transitionRequest(id: string, next: TransactionRequestStatus, now: Date, options: {
    reason?: string; execution?: TransactionExecutionSummary; signatureVerified?: boolean;
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
        const account = this.db.prepare("SELECT id FROM accounts WHERE sui_address=?").get(old.account) as { id: number };
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
      this.publish(id, !["awaiting_signature", "submitting", "awaiting_chain_result"].includes(next));
      if (old.requestStatus === "awaiting_signature" && next !== old.requestStatus) this.publishAvailableWallets();
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
      if (!this.isUsableConnection(authority.connection_id, now) || !isOwnedConnectedWallet(connection, this.ownerId, !!this.pendingDisconnect(authority.connection_id)) ||
          connection.connection.revision !== authority.connection_revision || Date.parse(connection.connection.expiresAt) <= now.getTime()) return false;
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
    this.db.prepare(`UPDATE live_request_authority SET ${field}=? WHERE attempt_id=? AND owner_id=?`).run(Number(pending), id, this.ownerId);
  }
  private stopWaiting(id: string, now: Date, cause: RequestInterruptionCause): TransactionRequest | undefined {
    return this.db.transaction(() => {
      const request = this.request(id), authority = this.authority(id);
      if (!request || !authority || authority.owner_id !== this.ownerId) return request;
      if (request.requestStatus === "awaiting_signature") return this.transitionRequest(id, cause === "wallet_service_lost" ? "request_failed" : "stopped", now, { reason: interruptionReasons[cause] });
      // Once submitted, connection changes cannot revoke a transaction or the
      // independent lookup of its digest. Only explicit user stopping ends observation.
      if (cause === "user_stop" && authority.observation_stopped === 0 &&
          ["submitting", "awaiting_chain_result", "outcome_unknown"].includes(request.requestStatus)) {
        this.db.prepare("UPDATE live_request_authority SET observation_stopped=1 WHERE attempt_id=?").run(id);
        this.publish(id, false);
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
      const card = this.requireInput(expected, now);
      this.requireAction(card, "cancel", now);
      if (!this.cards.replace(card, { ...card, state: { ...card.state, state: "closed", reason: "cancelled", revision: card.state.revision + 1 } })) {
        throw new WorkflowConflict("Card changed before cancellation.");
      }
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
          currentConnection.connection.revision !== connection.revision || Date.parse(currentConnection.connection.expiresAt) <= now.getTime() ||
          (review.account && this.busyForAccount(review.account, now))) throw new WorkflowConflict("The review could not be updated with the current wallet and account.");
      const readAccount = this.connectionSelection(now).assetReadAccount;
      const selection = reviewPreparationAccount(review.account ?? undefined, readAccount.status === "available" ? readAccount.account : undefined, account);
      if (!selection.allowed) throw new WorkflowConflict(selection.message);
      this.requireAction(card, "prepare_review", now);
      if (this.busyForAccount(selection.account, now) || !currentConnection.connection.accounts.includes(selection.account)) throw new WorkflowConflict("The review could not be updated with the selected wallet account.");
      const preparation = randomUUID();
      this.db.prepare(`UPDATE live_review_sessions SET preparation_id=?,preparation_run_id=?,preparation_error=NULL,wallet_connection_id=?,wallet_connection_revision=?,revision=revision+1,write_contract_version=? WHERE id=?`)
        .run(preparation, this.runId ?? null, connection.connectionId, connection.revision, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, id);
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
          const account = review.account ? this.db.prepare("SELECT id FROM accounts WHERE sui_address=?").get(review.account) as { id: number } | undefined : undefined;
          this.db.prepare(`INSERT INTO review_status_transitions(review_session_id,event,from_status,to_status,account_id,reason,transitioned_at)
            VALUES (?,'expired',?,'expired',?,'server_restarted',?)`).run(review.id, review.status, account?.id ?? null, now.toISOString());
          this.db.prepare("UPDATE review_sessions SET current_status='expired',updated_at=? WHERE id=?").run(now.toISOString(), review.id);
        }
      }
      this.db.prepare(`UPDATE live_review_sessions SET owner_id=?,status='expired',preparation_id=NULL,
        revision=revision+1,write_contract_version=? WHERE owner_id!=?`)
        .run(this.ownerId, LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION, this.ownerId);
      for (const record of this.connections()) {
        if (record.ownerId === this.ownerId) continue;
        const disconnect = this.pendingDisconnect(record.connection.connectionId, record.ownerId);
        if (disconnect || record.connection.status === "awaiting_approval") {
          const next: WalletConnection = { ...record.connection, status: disconnect ? "failed" : "stopped", revision: record.connection.revision + 1,
            reason: disconnect ? "Server restarted before wallet disconnection was confirmed. Check the connection in your wallet app."
              : "Server restarted before wallet approval.", updatedAt: now.toISOString() };
          this.db.prepare("UPDATE live_wallet_connections SET owner_id=?,status=?,revision=?,sdk_pending=0,connection_json=? WHERE id=?")
            .run(this.ownerId, next.status, next.revision, JSON.stringify(next), next.connectionId);
          if (disconnect) this.publishConnection(next.connectionId, next.status);
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
    }).immediate();
  }
}

export function hasUnsettledWalletWork(db: SqliteDatabase, now = new Date()): boolean {
  return !!db.prepare("SELECT 1 FROM live_wallet_connections WHERE sdk_pending=1 LIMIT 1").get() ||
    !!db.prepare(`SELECT 1 FROM live_request_authority l JOIN review_requests r ON r.attempt_id=l.attempt_id
    WHERE l.sdk_pending=1 OR l.submit_pending=1 OR l.lookup_pending=1
      OR (r.request_status IN (SELECT value FROM json_each(?)) AND (l.lookup_deadline IS NULL OR l.lookup_deadline>?)) LIMIT 1`)
    .get(JSON.stringify(INITIAL_CHAIN_OBSERVATION_STATUSES), now.toISOString());
}

export function readStoredTransactionRequest(db: SqliteDatabase, id: string): TransactionRequest | undefined {
    const row = db.prepare(`SELECT r.*, a.sui_address AS account, e.result_json FROM review_requests r
      JOIN accounts a ON a.id=r.account_id LEFT JOIN review_executions e ON e.attempt_id=r.attempt_id
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
