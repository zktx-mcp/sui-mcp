import { workflowConnectionEligibility, type ConnectionContext, type EvaluatedWorkflowState, type ReviewReadTarget } from "./workflowState.js";
import { SessionStoreError } from "./sessionErrors.js";
import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import type { ReviewComputationDeps } from "../review/reviewComputation.js";
import { computeReviewStateWithPrivateArtifacts } from "../review/reviewComputation.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import type { PublicChainReceiptResult } from "../action/suiChainReceiptReader.js";
import { projectReadCardResult } from "../read/readCardResult.js";
import type { VerifySuiChainReceiptInput, SuiChainReceiptVerificationResult } from "../action/suiChainReceiptVerifier.js";
import type { SessionStore } from "./sessionStore.js";
import type { CardRecord, CardPreparation, ReceiptDisplay, WalletDisplay } from "./cardSession.js";
import { SqliteWalletWorkflowStore, WorkflowConflict } from "./sqliteWalletWorkflowStore.js";
import { isOwnedConnectedWallet, SUI_SIGN_TRANSACTION_METHOD, WalletUserRejectedError, WalletUnavailableError,
  type WalletAvailability, type WorkflowProgress, type WalletRecoveryImpact } from "./walletConnection.js";
import { isInitialChainObservation, type TransactionRequest } from "./transactionRequest.js";
import { projectConnectionView, projectReviewView, parseWorkflowAction, type WorkflowView, type PendingConnectionStatus } from "./workflowView.js";

import { WalletRunInterruptedError, type WalletRuntime, type WalletRun, type WalletRuntimeEvent,
  type WalletSessionObservation } from "./walletRuntime.js";

import { reviewProgress, type ReviewSnapshot } from "./status.js";

type CompletedCallback = { kind: "request"; id: string; field: "sdk_pending" | "submit_pending" | "lookup_pending" } |
  { kind: "connection"; id: string; runId: string; cardId: string; action: "connect" | "disconnect";
    unrecordedOutcome?: "failed" | "stopped" | "rejected" };
type PendingWalletWrite = CompletedCallback | { kind: "runtime_failure"; runId: string; observedAt: string } |
  { kind: "runtime_exit"; runId: string; observedAt: string; parentProcessing: string[] };
type SettingsRecovery = { synchronize(): void; runtimeEvent(event: WalletRuntimeEvent): void; readyPublished(runId: string): void };

export class WalletWorkflow {
  private stopped = false;
  private started = false;
  private readonly pairings = new Map<string, WalletDisplay>();
  private readonly observing = new Map<string, Promise<void>>();
  private readonly preparing = new Set<string>();
  private readonly pendingWrites = new Map<string, PendingWalletWrite>();
  // Child exit ends child I/O, not verification or submit work already running
  // in this parent. The owning signature continuation alone ends that work.
  private readonly parentSignatureWork = new Set<string>();
  private eventListener: ((event: WalletRuntimeEvent) => void) | undefined;
  private settingsRecovery: SettingsRecovery | undefined;
  constructor(private readonly options: {
    records: SqliteWalletWorkflowStore;
    sessions: SessionStore; ownerId: string;
    runtime: WalletRuntime;
    computation: ReviewComputationDeps;
    verifyReceipt(input: VerifySuiChainReceiptInput): Promise<SuiChainReceiptVerificationResult>;
    readReceipt?: ((input: { digest: string; now: Date }) => Promise<PublicChainReceiptResult>) | undefined;
    submitTransaction(bytes: Uint8Array, signature: string): Promise<unknown>;
    assertCurrent(): void;
    bindExternalEvent(work: (event: WalletRuntimeEvent) => void): (event: WalletRuntimeEvent) => void;
    verifyNetwork(): Promise<void>;
    signatureClient?: ClientWithCoreApi;
    logger: { error(message: string, meta?: Record<string, unknown>): void };
    now?: (() => Date) | undefined;
  }) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private assertCurrent(): void {
    if (this.stopped) throw new Error("Wallet workflow owner stopped.");
    this.options.assertCurrent();
  }
  walletAvailability(): WalletAvailability {
    this.assertCurrent();
    return this.options.runtime.availability();
  }
  private assertWalletAvailable(run?: WalletRun): void {
    this.assertCurrent();
    run?.assertCurrent();
    const availability = this.walletAvailability();
    if (availability.status !== "available") throw new WalletUnavailableError(
      availability.status === "unavailable" ? availability.reason : "wallet_state_unavailable", availability.message);
  }
  private report(stage: string): void { try { this.options.logger.error("Wallet operation failed", { stage }); } catch { /* SQLite owns outcomes. */ } }
  async start(): Promise<void> {
    this.assertCurrent();
    if (this.started) throw new WorkflowConflict("The wallet service has already started.");
    this.started = true;
    this.options.records.setWalletRunId(this.options.runtime.runId);
    this.options.records.recover(this.now());
    this.bindEvents();
    this.options.runtime.start((event) => this.eventListener?.(event));
  }
  private bindEvents(): void {
    this.eventListener = this.options.bindExternalEvent((event) => this.runtimeEvent(event));
  }
  private runtimeEvent(event: WalletRuntimeEvent): void {
    this.assertCurrent();
    if (event.runId !== this.options.runtime.runId) return;
    const runtime = this.options.runtime;
    if (event.type === "snapshot") {
      this.options.records.applyWalletObservation(event.snapshot, event.previous, event.ready,
        () => this.settingsRecovery?.runtimeEvent(event));
      if (event.ready) { runtime.publishReady(event.runId); this.settingsRecovery?.readyPublished(event.runId); }
    } else if (event.type === "stage") {
      this.options.records.publishWalletState();
    } else if (event.type === "lost") {
      this.pairings.clear();
      this.retainWrite({ kind: "runtime_failure", runId: event.runId, observedAt: this.now().toISOString() });
      this.settingsRecovery?.runtimeEvent(event);
    } else if (event.type === "exit") {
      this.retainWrite({ kind: "runtime_exit", runId: event.runId, observedAt: this.now().toISOString(), parentProcessing: [...this.parentSignatureWork] });
    }
  }
  attachSettingsRecovery(recovery: SettingsRecovery): void {
    if (this.settingsRecovery) throw new Error("Settings recovery is already attached.");
    this.settingsRecovery = recovery;
  }
  recoveryContext(): { availability: WalletAvailability; impact: WalletRecoveryImpact } {
    this.synchronizeWalletState();
    return this.currentRecoveryFacts();
  }
  currentRecoveryFacts(): { availability: WalletAvailability; impact: WalletRecoveryImpact } {
    return { availability: this.walletAvailability(), impact: this.options.records.recoveryImpact(this.options.runtime.runId) };
  }
  blockSettingsAdmissionFailure(): void {
    const runId = this.options.runtime.runId;
    this.options.runtime.block("wallet_state_unavailable");
    this.retainWrite({ kind: "runtime_failure", runId, observedAt: this.now().toISOString() });
  }
  fenceForSettings(runId: string): void { this.assertCurrent(); this.options.runtime.fence(runId); }
  replaceForSettings(runId: string, reserve: (nextRunId: string) => void): Promise<void> {
    this.assertCurrent();
    return this.options.runtime.replace(runId, (nextRunId) => {
      this.synchronizeWalletState();
      reserve(nextRunId);
      this.options.records.setWalletRunId(nextRunId);
    });
  }
  dataReplaced(): void {
    this.pairings.clear(); this.pendingWrites.clear();
    const status = this.options.runtime.availability().status;
    if (status === "initializing" || status === "recovering") this.options.runtime.dataReplaced();
    this.bindEvents();
  }
  private observed(topic: string): WalletSessionObservation | undefined {
    return this.options.runtime.snapshot()?.sessions.find((item) => item.topic === topic);
  }
  private observation() {
    const snapshot = this.options.runtime.snapshot();
    return snapshot && { runId: snapshot.runId, sequence: snapshot.sequence, observedAt: snapshot.observedAt };
  }
  private completeCallback(completion: CompletedCallback): void {
    this.retainWrite(completion);
  }
  private retainWrite(completion: PendingWalletWrite): void {
    // An old data generation cannot add repair work to the replacement data.
    try { this.assertCurrent(); } catch { return; }
    const key = completion.kind === "runtime_failure" || completion.kind === "runtime_exit" ? `${completion.kind}:${completion.runId}` :
      completion.kind === "request" ? `request:${completion.id}:${completion.field}` : `connection:${completion.cardId}:${completion.runId}`;
    if (!this.pendingWrites.has(key)) this.pendingWrites.set(key, completion);
    try { this.settlePendingWrite(key, this.pendingWrites.get(key)!); } catch { this.report("callback_record"); }
  }
  private settlePendingWrite(key: string, completion: PendingWalletWrite): void {
    if (completion.kind === "request") this.options.records.settle(completion.id, completion.field, false);
    else if (completion.kind === "connection") this.options.records.settleConnection(completion.id, completion);
    else if (completion.kind === "runtime_exit") this.options.records.recordRunExit(completion.runId, completion.parentProcessing);
    else this.options.records.recordWalletFailure(completion);
    this.pendingWrites.delete(key);
  }
  private synchronizeWalletState(target?: ReviewReadTarget): void {
    this.assertCurrent();
    const walletDependent = !target || target.walletDependent;
    let failure: unknown;
    for (const [key, completion] of this.pendingWrites) {
      if (!walletDependent && (completion.kind !== "request" || completion.id !== target?.attemptId)) continue;
      try { this.settlePendingWrite(key, completion); } catch (error) { failure = error; }
    }
    // A completed callback's pending flag is housekeeping, not authority to
    // read recorded facts. Retain failed repairs for the next applicable read.
    if (failure && walletDependent) throw failure;
    if (walletDependent) this.settingsRecovery?.synchronize();
    if (walletDependent) this.options.runtime.synchronize();
  }
  async prepare(kind: "connect" | "review", input: Record<string, unknown>): Promise<CardPreparation> {
    this.assertCurrent();
    if (kind === "connect") return { status: "ready" };
    if (typeof input.reviewSessionId !== "string") throw new WorkflowConflict("The requested review was not specified.");
    const session = await this.options.sessions.getReviewSession(input.reviewSessionId, () => this.now()); this.assertCurrent();
    if (!session) throw new WorkflowConflict("The review session is unavailable.");
    if (input.mode === "manage") {
      if (typeof input.attemptId !== "string") throw new WorkflowConflict("The transaction request to check was not specified.");
      const request = this.options.records.request(input.attemptId);
      if (!request || request.reviewSessionId !== session.id) throw new WorkflowConflict("This transaction request does not belong to the specified review.");
    }
    return { status: "ready" };
  }

  reconcileConnectionContext(): ConnectionContext {
    this.assertCurrent();
    this.synchronizeWalletState();
    this.recoverDisconnects();
    const state = this.options.records.reconcileAndEvaluate({ purpose: "current_wallet", walletAvailability: this.walletAvailability(), walletObservation: this.observation() });
    return { connections: state.connections, connectionConflict: state.connectionConflict, walletAvailability: state.walletAvailability,
      walletObservation: state.walletObservation, manageableConnectionIds: state.manageableConnectionIds,
      connectionReconciliationRequired: state.connectionReconciliationRequired, assetReadAccount: state.assetReadAccount ?? { status: "address_required" } };
  }
  // Diagnostic facts are collected without maintenance. Reconciliation and
  // admission own durable transitions and cannot use this snapshot as authority.
  currentConnectionContext(): ConnectionContext {
    this.assertCurrent();
    const facts = this.options.records.readConnectionFacts(this.now()), availability = this.walletAvailability();
    const { selection: _selection, ...eligibility } = workflowConnectionEligibility({ ...facts, walletAvailability: availability });
    // The shared projection gates qualification on published availability;
    // a memory snapshot alone does not prove its journal/result has committed.
    return { connections: facts.connections, walletAvailability: availability, walletObservation: facts.walletObservation,
      connectionConflict: eligibility.connectionConflict, manageableConnectionIds: eligibility.manageableConnectionIds,
      connectionReconciliationRequired: eligibility.connectionReconciliationRequired,
      assetReadAccount: eligibility.assetReadAccount ?? { status: "address_required" } };
  }
  private recoverDisconnects(): void {
    const available = this.walletAvailability().status === "available";
    for (const record of this.options.records.connections()) {
      if (record.ownerId !== this.options.ownerId || record.sdkPending) continue;
      const pending = this.options.records.pendingDisconnect(record.connection.connectionId);
      if (!pending) continue;
      // Disabled transports also return undefined; that is not session absence.
      const absent = available && !!record.topic && this.observed(record.topic)?.status === "absent";
      this.options.records.recoverDisconnect(pending.state.cardId, record.connection.connectionId, record.connection.revision, absent);
    }
  }
  private async evaluateReview(id: string, expectedCard?: CardRecord, uiObservation = false, expectedAttempt?: string): Promise<EvaluatedWorkflowState> {
    this.assertCurrent();
    const readTarget = this.options.records.reviewReadTarget(id, expectedCard);
    if (expectedAttempt && readTarget.attemptId !== expectedAttempt) throw new WorkflowConflict("The current transaction request changed. Check this review again.");
    this.synchronizeWalletState(readTarget);
    const preparation = this.options.sessions.readReviewSession(id)?.preparationId;
    if (preparation && !this.preparing.has(preparation)) this.options.records.failPreparation(id, preparation, this.now());
    const candidate = await this.options.sessions.inspectReview(id, this.now());
    this.assertCurrent();
    if (!candidate) throw new SessionStoreError("session_not_found", "The saved review is unavailable.");
    const evaluated = this.options.records.reconcileAndEvaluate({ purpose: "review", reviewSessionId: id, candidate, expectedCard, readTarget,
      walletAvailability: this.walletAvailability(), walletObservation: this.observation(), uiObservation });
    this.options.sessions.recordEvaluationEvents(evaluated.events);
    return evaluated;
  }
  async readReview(id: string, explicitResult = false): Promise<ReviewSnapshot | undefined> {
    if (!this.options.sessions.readReviewSession(id)) return undefined;
    let state = await this.evaluateReview(id);
    if (state.request) {
      this.observe(state.request.attemptId, explicitResult);
      if (explicitResult) {
        await this.observing.get(state.request.attemptId);
        this.assertCurrent();
        // An awaited receipt may have committed new facts. Return one freshly
        // evaluated snapshot; ordinary status reads do not await external I/O.
        state = await this.evaluateReview(id, undefined, false, state.request.attemptId);
      }
    }
    if (!state.session) return undefined;
    return { session: state.session, request: state.request, hasReviewInput: state.hasReviewInput, connectionConflict: state.connectionConflict, walletAvailability: state.walletAvailability, walletObservation: this.observation(),
      connectionReconciliationRequired: state.connectionReconciliationRequired,
      progress: reviewProgress(!!state.session.preparationId, state.request, state.walletAvailability,
        { stopped: state.authority?.observation_stopped === 1, pending: state.authority?.lookup_pending === 1 }) };
  }

  async describe(record: CardRecord, uiObservation = false): Promise<{
    evaluated: EvaluatedWorkflowState; data: WorkflowView; walletDisplay?: WalletDisplay; receiptDisplay?: ReceiptDisplay; displayAttemptId?: string;
  }> {
    this.assertCurrent();
    if (record.state.kind === "connect") this.reconcileConnectionContext();
    const evaluated = record.state.kind === "review"
      ? await this.evaluateReview(String(record.state.input.reviewSessionId), record, uiObservation)
      : this.options.records.reconcileAndEvaluate({ purpose: "current_wallet", expectedCard: record, walletAvailability: this.walletAvailability(), walletObservation: this.observation() });
    this.assertCurrent();
    if (record.state.kind === "connect") {
      const data = projectConnectionView(evaluated);
      const pairing = evaluated.connection && evaluated.walletAvailability.status === "available" ? this.pairings.get(evaluated.connection.connectionId) : undefined;
      return { evaluated, data, ...(pairing && evaluated.connection?.status === "awaiting_approval" ? { walletDisplay: pairing } : {}) };
    }
    const data = projectReviewView(evaluated);
    assertNoForbiddenMcpFields(data);
    if (uiObservation && evaluated.request && isInitialChainObservation(evaluated.request.requestStatus) && !evaluated.authority?.observation_stopped) this.observe(evaluated.request.attemptId);
    return { evaluated, data, ...(evaluated.receiptDisplay && evaluated.request ? { receiptDisplay: evaluated.receiptDisplay, displayAttemptId: evaluated.request.attemptId } : {}) };
  }

  async act(record: CardRecord, action: ReturnType<typeof parseWorkflowAction>): Promise<void> {
    this.assertCurrent();
    const runtime = this.options.runtime;
    if ("walletRunId" in action && action.walletRunId !== runtime.runId) throw new WorkflowConflict("The wallet service changed. Confirm the current selection again.");
    if (action.action === "request_signature" && record.scope === "review") {
      const recovered = this.options.records.recoverRequest(record, action, { reviewSessionId: String(record.state.input.reviewSessionId),
        reviewRevision: action.reviewRevision, account: action.account, connectionId: action.connectionId });
      if (recovered) return;
    }
    if (["connect", "disconnect", "use_account", "prepare_review", "request_signature"].includes(action.action)) this.assertWalletAvailable();
    switch (action.action) {
      case "cancel": this.options.records.cancelInput(record); return;
      case "connect": {
        const run = runtime.bind();
        const admitted = this.options.records.admitConnection(record, action);
        void this.connect(admitted.connection.connectionId, run, record.state.cardId).catch(() => this.report("connection"));
        return;
      }
      case "use_account": {
        if (!action.account) throw new WorkflowConflict("No account from the connected wallet was selected.");
        const run = runtime.bind();
        await this.checkWallet(run, action.connectionId, action.account, record.state.cardId);
        this.assertWalletAvailable(run);
        this.options.records.useAccount(record, action, action.connectionId, action.account); return;
      }
      case "disconnect": {
        const run = runtime.bind();
        const selected = this.options.records.connection(action.connectionId);
        if (!selected?.topic) throw new WorkflowConflict("The selected wallet connection is unavailable.");
        await run.checkSession(selected.topic, record.state.cardId); this.assertWalletAvailable(run);
        const target = this.options.records.admitDisconnect(record, action, action.connectionId);
        void (async () => {
          try {
            if (target.topic) await run.disconnect(target.topic, record.state.cardId); this.assertWalletAvailable(run);
            this.options.records.finishDisconnect(record.state.cardId, action.connectionId, true, this.now());
          } catch { if (!this.stopped) this.options.records.finishDisconnect(record.state.cardId, action.connectionId, false, this.now()); }
          finally { this.completeCallback({ kind: "connection", id: action.connectionId, cardId: record.state.cardId, action: "disconnect", runId: run.runId }); }
        })().catch(() => this.report("disconnection")); return;
      }
      case "stop_connection": {
        const id = this.options.records.manage(record, action.action);
        this.pairings.delete(id);
        return;
      }
      case "prepare_review": {
        const id = String(record.state.input.reviewSessionId);
        const run = runtime.bind();
        const { connection } = await this.checkWallet(run, action.connectionId, action.account, record.state.cardId);
        this.assertWalletAvailable(run);
        const preparation = this.options.records.beginReviewPreparation(record, action.reviewRevision, connection, action.account);
        this.preparing.add(preparation);
        void this.compute(id, preparation, action.account, connection.connectionId, run)
          .finally(() => this.preparing.delete(preparation)).catch(() => this.report("review_computation"));
        return;
      }
      case "request_signature": {
        const run = runtime.bind();
        const id = String(record.state.input.reviewSessionId);
        const { connection } = await this.checkWallet(run, action.connectionId, action.account, record.state.cardId);
        this.assertWalletAvailable(run);
        const session = this.options.sessions.readReviewSession(id);
        if (!session || session.reviewRevision !== action.reviewRevision || !session.plans[0]) throw new WorkflowConflict("This request does not match the current review.");
        let material;
        try { material = await this.options.sessions.prepareReviewedTransaction(id, session.plans[0].id, action.account, this.now()); }
        catch (error) {
          if (!(error instanceof SessionStoreError)) throw error;
          if (this.options.records.recoverRequest(record, action, { reviewSessionId: id, reviewRevision: action.reviewRevision,
            account: action.account, connectionId: action.connectionId })) return;
          await this.evaluateReview(id);
          throw new WorkflowConflict("The transaction details needed for this approval request are no longer available.");
        }
        this.assertWalletAvailable(run);
        let admitted;
        try { admitted = this.options.records.admitRequest(record, action, material, connection, run.runId); }
        catch (error) {
          if (error instanceof WorkflowConflict) this.options.sessions.recordEvaluationEvents(error.events);
          throw error;
        }
        if (admitted.created) void this.sign(admitted.request, action.connectionId, material.transactionBytesBase64, run).catch(() => this.report("signature_request"));
        return;
      }
      case "stop_waiting": this.options.records.manage(record, action.action); return;
      case "read_result": {
        const id = this.options.records.manage(record, action.action);
        this.observe(id, true); return;
      }
    }
  }
  private requireWallet(id: string, account: string) {
    this.assertWalletAvailable();
    const current = this.options.records.connection(id);
    if (!this.options.records.isUsableConnection(id, this.now()) || !isOwnedConnectedWallet(current, this.options.ownerId, !!this.options.records.pendingDisconnect(id)) ||
        !current.connection.accounts.includes(account) || Date.parse(current.connection.expiresAt) <= this.now().getTime()) {
      throw new WorkflowConflict("The selected Sui wallet connection is unavailable.");
    }
    return current.connection;
  }
  private async checkWallet(run: WalletRun, id: string, account: string, operationId: string) {
    this.assertWalletAvailable(run);
    const stored = this.options.records.connection(id);
    if (!stored?.topic) throw new WorkflowConflict("The selected wallet connection is unavailable.");
    const observed = await run.checkSession(stored.topic, operationId);
    this.assertWalletAvailable(run);
    if (observed.status !== "present" || !observed.session.accounts.includes(account)) throw new WorkflowConflict("The selected Sui wallet account is unavailable.");
    return { connection: this.requireWallet(id, account), observed };
  }
  private async connect(id: string, run: WalletRun, cardId: string): Promise<void> {
    let unrecordedOutcome: "failed" | "stopped" | "rejected" = "failed";
    try {
      const result = await run.connect(id);
      let displayFailure: unknown;
      try {
        this.assertWalletAvailable(run);
        const current = this.options.records.connection(id);
        if (current?.connection.status === "awaiting_approval") {
          this.pairings.set(id, { connectionId: id, pairingUri: result.uri, expiresAt: result.expiresAt });
          this.options.records.updateConnection(id, { expiresAt: result.expiresAt }, this.now());
        }
      } catch (error) { displayFailure = error; }
      // The approval remains pending even if setup/QR recording fails or the
      // wallet dependency is disabled. Settle only after that promise ends.
      const session = await result.approval;
      if (displayFailure) throw displayFailure;
      this.assertWalletAvailable(run);
      const awaiting = this.options.records.connection(id);
      if (!awaiting || awaiting.connection.status !== "awaiting_approval" || Date.parse(awaiting.connection.expiresAt) <= this.now().getTime()) {
        await run.disconnect(session.topic, id);
        return;
      }
      this.options.records.updateConnection(id, { status: "connected", accounts: session.accounts, methods: session.methods,
        expiresAt: session.expiresAt, walletName: session.walletName }, this.now(), session.topic, false);
    } catch (error) {
      unrecordedOutcome = error instanceof WalletRunInterruptedError ? "stopped" : error instanceof WalletUserRejectedError ? "rejected" : "failed";
      if (!this.stopped) {
        const current = this.options.records.connection(id);
        if (current?.connection.status === "awaiting_approval") this.options.records.updateConnection(id,
          { status: error instanceof WalletRunInterruptedError ? "stopped" : error instanceof WalletUserRejectedError ? "rejected" : "failed",
            reason: this.walletAvailability().status !== "available" ? "The wallet connection could not be confirmed because the wallet service is unavailable." :
              error instanceof WalletUserRejectedError ? error.message : "Wallet connection could not be confirmed." }, this.now(), undefined, false);
      }
    } finally {
      this.completeCallback({ kind: "connection", id, runId: run.runId, cardId, action: "connect", unrecordedOutcome });
      this.pairings.delete(id);
    }
  }
  private async compute(id: string, preparation: string, account: string, connectionId: string, run: WalletRun): Promise<void> {
    try {
      await this.options.sessions.recordWalletConnected(id, account, this.now()); this.assertWalletAvailable(run);
      const session = await this.options.sessions.getReviewSession(id, () => this.now());
      if (!session?.plans[0]) throw new WorkflowConflict("Review session is unavailable.");
      const computed = await computeReviewStateWithPrivateArtifacts({ reviewSessionId: id, plan: session.plans[0], account, now: this.now() }, this.options.computation);
      const { connection: currentConnection } = await this.checkWallet(run, connectionId, account, preparation);
      this.assertWalletAvailable(run);
      if (!this.options.records.isPreparing(id, preparation) || session.walletConnectionRevision !== currentConnection.revision) return;
      await this.options.sessions.recordReviewStateWithArtifacts(id, computed.state, computed.privateArtifacts, this.now(),
        { id: preparation, connectionId, connectionRevision: currentConnection.revision });
    } catch { if (!this.stopped) this.options.records.failPreparation(id, preparation, this.now()); }
  }
  private async sign(request: TransactionRequest, connectionId: string, bytesBase64: string, run: WalletRun): Promise<void> {
    try { await this.performSignature(request, connectionId, bytesBase64, run); }
    finally { this.parentSignatureWork.delete(request.attemptId); this.completeCallback({ kind: "request", id: request.attemptId, field: "sdk_pending" }); }
  }
  private async performSignature(request: TransactionRequest, connectionId: string, bytesBase64: string, run: WalletRun): Promise<void> {
    let response: { transactionBytes: string; signature: string; sessionVersion: number };
    try {
      this.assertWalletAvailable(run);
      const connection = this.options.records.connection(connectionId);
      if (!connection?.topic || !connection.connection.methods.includes(SUI_SIGN_TRANSACTION_METHOD)) throw new WorkflowConflict("Wallet does not support Sui sign-only requests.");
      const proof = await this.checkWallet(run, connectionId, request.account, request.attemptId);
      this.assertWalletAvailable(run);
      response = await run.sign({ topic: connection.topic, account: request.account, transactionBytesBase64: bytesBase64,
        sessionVersion: proof.observed.version }, request.attemptId);
      this.parentSignatureWork.add(request.attemptId);
      this.assertWalletAvailable(run);
    } catch {
      if (!this.stopped) this.options.records.transitionRequest(request.attemptId, "request_failed", this.now(), { reason: this.walletAvailability().status !== "available" ? "Wallet operations became unavailable before submission. The returned signature will not be submitted." : "The wallet rejected the request or did not return a signature." });
      return;
    }
    const current = this.options.records.request(request.attemptId);
    if (!current) return;
    this.options.records.advanceRequestDeadlines(this.now(), current.attemptId);
    if (this.options.records.request(request.attemptId)?.requestStatus !== "awaiting_signature") return;
    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(response.transactionBytes, "base64");
      if (await Transaction.from(bytes).getDigest() !== request.transactionDigest) {
        throw new WorkflowConflict("The returned transaction does not match the reviewed transaction. Nothing was submitted.");
      }
      await verifyTransactionSignature(bytes, response.signature, { address: request.account,
        ...(this.options.signatureClient ? { client: this.options.signatureClient } : {}) }); this.assertWalletAvailable(run);
      await this.options.verifyNetwork(); this.assertWalletAvailable(run);
      const current = await this.checkWallet(run, connectionId, request.account, request.attemptId);
      this.assertWalletAvailable(run);
      if (current.observed.version !== response.sessionVersion) throw new WorkflowConflict("The wallet session changed before submission. Nothing was submitted.");
      this.options.records.advanceRequestDeadlines(this.now(), request.attemptId);
      if (this.options.records.request(request.attemptId)?.requestStatus !== "awaiting_signature") return;
      this.options.records.transitionRequest(request.attemptId, "awaiting_signature", this.now(), { signatureVerified: true });
      if (!this.options.records.beginSubmission(request.attemptId)) return;
    } catch (error) {
      // SDK verification can itself depend on a remote source. An exception is
      // not proof of a mismatched transaction or signer.
      if (!this.stopped) this.options.records.transitionRequest(request.attemptId, "request_failed", this.now(), {
        reason: this.walletAvailability().status !== "available" ? "Wallet operations became unavailable before submission. The returned signature will not be submitted."
          : error instanceof WorkflowConflict ? error.message : "Submission checks could not be completed. Nothing was submitted."
      });
      return;
    }
    try { await this.options.submitTransaction(bytes, response.signature); }
    catch { /* A lost submit response is not proof of failure. Observe the same digest. */ }
    finally { this.completeCallback({ kind: "request", id: request.attemptId, field: "submit_pending" }); }
    this.assertCurrent();
    try { this.options.records.finishSubmission(request.attemptId); }
    catch { this.report("submission_record"); return; }
    this.observe(request.attemptId);
  }
  observe(id: string, explicit = false): void {
    this.assertCurrent();
    if (this.observing.has(id)) return;
    const current = this.options.records.request(id);
    if (!current || !(isInitialChainObservation(current.requestStatus) || explicit && current.requestStatus === "outcome_unknown")) return;
    // Starting another lookup needs its own previous callback to be settled.
    // Stored terminal facts above never depend on this write succeeding.
    for (const [key, write] of this.pendingWrites) if (write.kind === "request" && write.id === id && write.field === "lookup_pending") {
      this.settlePendingWrite(key, write);
    }
    const request = this.options.records.beginObservation(id, explicit);
    if (!request) return;
    const reading = (async () => {
      try {
        const result = await this.options.verifyReceipt({ txDigest: request.transactionDigest, reviewedTransactionDigest: request.transactionDigest, account: request.account, now: this.now() });
        this.assertCurrent();
        if (result.status === "verified_success" || result.status === "verified_failure") {
          let details: ReturnType<typeof projectReadCardResult> | undefined;
          if (this.options.readReceipt) {
            try {
              const receipt = await this.options.readReceipt({ digest: request.transactionDigest, now: this.now() });
              this.assertCurrent();
              if (receipt.status === "found") details = projectReadCardResult("receipt", { digest: request.transactionDigest }, receipt);
            } catch { /* Keep verified chain facts if the additional display read is unavailable. */ }
          }
          this.assertCurrent();
          this.options.records.transitionRequest(id, "completed", this.now(), { execution: {
            reviewSessionId: request.reviewSessionId, attemptId: id, planId: request.planId,
            status: result.status === "verified_success" ? "success" : "failure", txDigest: request.transactionDigest,
            chainReceipt: result.receipt, recordedAt: this.now().toISOString(),
            ...(result.status === "verified_failure" ? { failureReason: "chain_execution_failed" as const } : {})
          }, ...(details ? { details } : {}) });
        } else if (result.status === "verification_failed") {
          this.options.records.transitionRequest(id, "outcome_unknown", this.now(), { reason: "The chain result could not be verified for this request." });
        }
      } catch { if (!this.stopped) this.options.records.transitionRequest(id, "outcome_unknown", this.now(), { reason: "The chain result is unavailable. No transaction was sent again." }); }
      finally { this.completeCallback({ kind: "request", id, field: "lookup_pending" }); this.observing.delete(id); }
    })();
    this.observing.set(id, reading);
    void reading.catch(() => this.report("chain_observation"));
  }
  pendingConnections() {
    this.assertCurrent();
    this.synchronizeWalletState();
    this.recoverDisconnects();
    const rows: { cardId: string; connectionId?: string; status: PendingConnectionStatus; lastActivityAt: string; progress: WorkflowProgress }[] = [];
    for (const card of this.options.records.pendingConnectionCards(this.now())) {
      const evaluated = this.options.records.reconcileAndEvaluate({ purpose: "current_wallet", expectedCard: card, walletAvailability: this.walletAvailability(), walletObservation: this.observation() });
      if (evaluated.record?.state.state === "closed") continue;
      const data = projectConnectionView(evaluated);
      if (data.runtimeRecovery) continue;
      if (!data.connection) rows.push({ cardId: card.state.cardId, status: "input_required", lastActivityAt: card.state.createdAt, progress: data.progress });
      else if (data.connection.status === "awaiting_approval") rows.push({ cardId: card.state.cardId,
        connectionId: data.connection.connectionId, status: "awaiting_approval", lastActivityAt: data.connection.updatedAt, progress: data.progress });
      else if (data.connection.pendingAction === "disconnect") rows.push({ cardId: card.state.cardId,
        connectionId: data.connection.connectionId, status: "disconnect_pending", lastActivityAt: data.connection.updatedAt, progress: data.progress });
    }
    return rows;
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.pairings.clear(); this.pendingWrites.clear();
  }
}
