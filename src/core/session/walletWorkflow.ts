import { randomUUID } from "node:crypto";
import { fixedReviewTarget, workflowConnectionEligibility, walletActionDecision, type ConnectionContext, type EvaluatedWorkflowState, type ReviewReadTarget } from "./workflowState.js";
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
import { SqliteWalletWorkflowStore, WorkflowConflict, type ConnectionResponseOwner } from "./sqliteWalletWorkflowStore.js";
import { isOwnedConnectedWallet, connectionHasSuiSigningScope, WalletUserRejectedError, WalletUnavailableError,
  type WalletAvailability, type WalletRecoveryImpact, type WalletSession } from "./walletConnection.js";
import { isInitialChainObservation, type TransactionRequest } from "./transactionRequest.js";
import { projectConnectionView, projectReviewView, parseWorkflowAction, type WorkflowView } from "./workflowView.js";

import { WalletRunInterruptedError, type WalletRuntime, type WalletRun, type WalletRuntimeEvent,
  type WalletSessionObservation, type SuiWalletRevision } from "./walletRuntime.js";

import { SUI_MAINNET_WALLET_CHAIN, walletGrantAccount, fixedChainAccount, type WalletChainId } from "./chainAccounts.js";
import { walletConnectionCardInputSchema, walletConnectionActionSchema } from "./walletConnectionOperations.js";
import { reviewProgress, type ReviewSnapshot } from "./status.js";

type CompletedCallback = { kind: "request"; id: string; field: "sdk_pending" | "submit_pending" | "lookup_pending" } |
  { kind: "connection"; id: string; runId: string; cardId: string; operationId: string; action: "connect" | "disconnect";
    unrecordedOutcome?: "failed" | "stopped" | "rejected"; cleanup?: { topic: string; absent: boolean } };
type UnacceptedConnectionResponse = ConnectionResponseOwner & { kind: "connection_cleanup"; session: WalletSession };
type PendingWalletWrite = CompletedCallback | { kind: "runtime_failure"; runId: string; observedAt: string } |
  { kind: "runtime_exit"; runId: string; observedAt: string; parentProcessing: string[] } | UnacceptedConnectionResponse;
type SettingsRecovery = { synchronize(): void; runtimeEvent(event: WalletRuntimeEvent): void; readyPublished(runId: string): void };

export class WalletWorkflow {
  private stopped = false;
  private started = false;
  private retainedSessionCheck: { runId: string; connectionId: string; work: Promise<void> } | undefined;
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
    if (availability.status !== "available") throw new WalletUnavailableError(availability);
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
      if (event.ready) { runtime.publishReady(event.runId); this.settingsRecovery?.readyPublished(event.runId);
        void this.inspectRetainedSession().catch(() => this.report("retained_session_check")); }
    } else if (event.type === "stage") {

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
      completion.kind === "request" ? `request:${completion.id}:${completion.field}` : `${completion.kind}:${completion.operationId}:${completion.runId}`;
    if (!this.pendingWrites.has(key)) this.pendingWrites.set(key, completion);
    try { this.settlePendingWrite(key, this.pendingWrites.get(key)!); } catch { this.report("callback_record"); }
  }
  private settlePendingWrite(key: string, completion: PendingWalletWrite): void {
    if (completion.kind === "connection_cleanup") {
      // Retry only recording the received response. Once the topic and cleanup
      // intent are durable, the continuation owns its one remote removal.
      if (completion.runId !== this.options.runtime.runId) { this.pendingWrites.delete(key); return; }
      const captured = this.options.records.captureConnectionSession(completion, completion.session);
      if (captured === "captured" && this.options.records.prepareConnectionCleanup(completion, completion.session, this.now())) {
        this.pendingWrites.delete(key);
        if (this.walletAvailability().status === "available") {
          const run = this.options.runtime.bind();
          void this.cleanupConnection(completion, run).catch(() => this.report("connection_cleanup"));
        } else {
          // The response was already received, so its callback I/O has ended.
          // Keep the exact topic for recovery without using a fenced SDK run.
          this.completeCallback({ kind: "connection", id: completion.id, cardId: completion.cardId,
            operationId: completion.operationId, runId: completion.runId, action: "connect",
            cleanup: { topic: completion.session.topic, absent: false } });
        }
      } else {
        this.pendingWrites.delete(key);
        this.completeCallback({ kind: "connection", id: completion.id, cardId: completion.cardId,
          operationId: completion.operationId, runId: completion.runId, action: "connect" });
      }
      return;
    }
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
  terminalCard(record: CardRecord): CardRecord {
    return { ...record, state: { ...record.state, data: this.options.records.cardResult(record, this.now()) } };
  }
  expireCard(record: CardRecord): CardRecord { return this.options.records.expireCard(record, this.now()); }
  async prepare(kind: "connect" | "disconnect" | "review", input: Record<string, unknown>): Promise<CardPreparation> {
    this.assertCurrent();
    if (kind === "connect" || kind === "disconnect") return { status: "ready" };
    if (typeof input.reviewSessionId !== "string") throw new WorkflowConflict("The requested review was not specified.");
    const session = await this.options.sessions.getReviewSession(input.reviewSessionId, () => this.now()); this.assertCurrent();
    if (!session) throw new WorkflowConflict("The review session is unavailable.");
    if (input.mode === "manage") {
      if (typeof input.attemptId !== "string") throw new WorkflowConflict("The transaction request to check was not specified.");
      const request = this.options.records.request(input.attemptId);
      if (!request || request.reviewSessionId !== session.id) throw new WorkflowConflict("This transaction request does not belong to the specified review.");
    } else if (!session.plans[0]?.reviewModel) {
      const target = fixedReviewTarget(session, input);
      const connection = target && this.options.records.connection(target.connectionId);
      if (!target || !connection || fixedChainAccount(connection.connection, SUI_MAINNET_WALLET_CHAIN) !== target.account ||
          !session.walletConnectionId && !connection.current) {
        throw new WorkflowConflict("A review requires its fixed wallet connection and account. Start a new review from the current connection.");
      }
    }
    return session.plans[0]?.reviewModel || input.mode === "manage" && ["completed", "stopped", "request_failed"].includes(this.options.records.request(String(input.attemptId))?.requestStatus ?? "") ? { status: "completed" } : { status: "ready" };
  }
  async connectionCardInput(kind: "connect" | "disconnect", input: Record<string, unknown>): Promise<Record<string, unknown>> {
    walletConnectionCardInputSchema.parse(input);
    await this.inspectRetainedSession();
    const context = this.reconcileConnectionContext(), facts = this.options.records.readConnectionFacts(this.now());
    if (kind === "disconnect") {
      this.assertWalletAvailable();
      const decision = walletActionDecision({ ...facts, walletAvailability: context.walletAvailability }, "disconnect");
      if (!decision.allowed) throw new WorkflowConflict(decision.nextStep.message!, [], decision.nextStep.reason);
      return { connectionId: context.connection!.connectionId, operationId: randomUUID() };
    }
    return { requestedChains: facts.requestedChains, connectionId: facts.connection?.connectionId ?? null, operationId: randomUUID() };
  }
  readOperation(record: CardRecord) {
    const id = record.operationId;
    if (id) {
      for (const [key, write] of this.pendingWrites) if ((write.kind === "connection" || write.kind === "connection_cleanup") && write.operationId === id) {
        try { this.settlePendingWrite(key, write); this.pendingWrites.delete(key); } catch { this.report("callback_record"); }
      }
      this.recoverDisconnects(id); this.options.records.expireConnections(this.now(), id);
    }
    const walletAvailability = this.walletAvailability();
    const result = this.options.records.operationRead(record, { walletAvailability, walletObservation: this.observation() });
    return { ...result, ...(result.record.state.state !== "closed" && result.evaluated ? { data: projectConnectionView(result.evaluated) } : {}), walletAvailability };
  }
  closedReceiptDisplay(record: CardRecord) {
    const data = record.state.data as { request?: TransactionRequest } | undefined;
    const request = data?.request;
    if (!request?.execution) return undefined;
    const receiptDisplay = this.options.records.executionDetails(request.attemptId)?.receiptDisplay;
    return receiptDisplay ? { receiptDisplay, displayAttemptId: request.attemptId } : undefined;
  }
  closeConnectionCardsWithChangedNetworks(chains: readonly WalletChainId[]): void {
    this.assertCurrent(); this.options.records.closeConnectionCardsWithChangedNetworks(chains);
  }
  resolveReviewTarget(): { status: "available"; connectionId: string; account: string } |
    { status: "unavailable"; reason: "wallet_unavailable" | "connection_required" | "connection_state_unconfirmed" } {
    const context = this.reconcileConnectionContext(), record = this.options.records.currentConnection();
    if (context.walletAvailability.status !== "available") return { status: "unavailable", reason: "wallet_unavailable" };
    if (context.connectionReconciliationRequired) return { status: "unavailable", reason: "connection_state_unconfirmed" };
    const account = record && fixedChainAccount(record.connection, SUI_MAINNET_WALLET_CHAIN);
    return account && record && this.options.records.isUsableConnection(record.connection.connectionId, this.now(), SUI_MAINNET_WALLET_CHAIN, account)
      ? { status: "available", connectionId: record.connection.connectionId, account } : { status: "unavailable", reason: "connection_required" };
  }
  reconcileConnectionContext(): ConnectionContext {
    this.assertCurrent(); this.synchronizeWalletState(); this.recoverDisconnects();
    const state = this.options.records.reconcileAndEvaluate({ purpose: "current_wallet", walletAvailability: this.walletAvailability(), walletObservation: this.observation() });
    return { connection: state.connection, pendingOperation: state.pendingOperation, requestedChains: state.requestedChains, walletAvailability: state.walletAvailability,
      walletObservation: state.walletObservation, canDisconnect: state.canDisconnect,
      connectionReconciliationRequired: state.connectionReconciliationRequired, assetReadAccount: state.assetReadAccount ?? { status: "address_required" } };
  }
  currentConnectionContext(): ConnectionContext {
    this.assertCurrent();
    const facts = this.options.records.readConnectionFacts(this.now()), availability = this.walletAvailability();
    const { selection: _selection, ...eligibility } = workflowConnectionEligibility({ ...facts, walletAvailability: availability });
    return { connection: eligibility.connection, pendingOperation: facts.pendingOperation, walletAvailability: availability, walletObservation: facts.walletObservation,
      requestedChains: facts.requestedChains, canDisconnect: eligibility.canDisconnect,
      connectionReconciliationRequired: eligibility.connectionReconciliationRequired, assetReadAccount: eligibility.assetReadAccount ?? { status: "address_required" } };
  }
  private async inspectRetainedSession(): Promise<void> {
    const record = this.options.records.currentConnection();
    if (!record?.topic || this.walletAvailability().status !== "available" || this.observed(record.topic)) return;
    const run = this.options.runtime.bind(), connectionId = record.connection.connectionId;
    if (this.retainedSessionCheck?.runId === run.runId && this.retainedSessionCheck.connectionId === connectionId) return this.retainedSessionCheck.work;
    const check = { runId: run.runId, connectionId, work: Promise.resolve() };
    this.retainedSessionCheck = check;
    check.work = (async () => {
      try { await run.checkSession(record.topic!, connectionId); this.assertWalletAvailable(run); }
      catch { this.report("retained_session_check"); }
      finally { if (this.retainedSessionCheck === check) this.retainedSessionCheck = undefined; }
    })();
    return check.work;
  }

  private recoverDisconnects(operationId?: string): void {
    const operation = operationId ? this.options.records.operation(operationId) : undefined;
    if (operationId && (!operation || operation.action !== "disconnect" || operation.status !== "running")) return;
    const target = operation?.connectionId ? this.options.records.connection(operation.connectionId) : undefined;
    const available = this.walletAvailability().status === "available";
    for (const record of operationId ? target ? [target] : [] : [this.options.records.currentConnection()].filter((item): item is NonNullable<typeof item> => !!item)) {
      if (record.ownerId !== this.options.ownerId || record.sdkPending || !record.disconnectPending) continue;
      const pending = operation ?? this.options.records.pendingDisconnect(record.connection.connectionId);
      if (!pending) continue;
      // Disabled transports also return undefined; that is not session absence.
      const absent = available && !!record.topic && this.observed(record.topic)?.status === "absent";
      this.options.records.recoverDisconnect(pending.operationId, record.connection.connectionId, record.connection.revision, absent);
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
    return { session: state.session, request: state.request, hasReviewInput: state.hasReviewInput, walletAvailability: state.walletAvailability, walletObservation: this.observation(),
      connectionReconciliationRequired: state.connectionReconciliationRequired,
      progress: reviewProgress(!!state.session.preparationId, state.request, state.walletAvailability,
        { stopped: state.authority?.observation_stopped === 1, pending: state.authority?.lookup_pending === 1 }) };
  }

  async describe(record: CardRecord, uiObservation = false): Promise<{
    evaluated: EvaluatedWorkflowState; data: WorkflowView; walletDisplay?: WalletDisplay; receiptDisplay?: ReceiptDisplay; displayAttemptId?: string;
  }> {
    this.assertCurrent();
    if (record.state.kind === "connect" || record.state.kind === "disconnect") { await this.inspectRetainedSession(); this.reconcileConnectionContext(); }
    const evaluated = record.state.kind === "review"
      ? await this.evaluateReview(String(record.state.input.reviewSessionId), record, uiObservation)
      : this.options.records.reconcileAndEvaluate({ purpose: "current_wallet", expectedCard: record, walletAvailability: this.walletAvailability(), walletObservation: this.observation() });
    this.assertCurrent();
    if (record.state.kind === "connect" || record.state.kind === "disconnect") {
      const data = projectConnectionView(evaluated);
      const pairing = evaluated.operation?.action === "connect" && evaluated.operation.status === "running" && evaluated.walletAvailability.status === "available"
        ? this.pairings.get(evaluated.operation!.operationId) : undefined;
      return { evaluated, data, ...(pairing ? { walletDisplay: pairing } : {}) };
    }
    const data = projectReviewView(evaluated);
    assertNoForbiddenMcpFields(data);
    if (uiObservation && evaluated.record?.state.reason !== "cancelled" && evaluated.request &&
        isInitialChainObservation(evaluated.request.requestStatus) && !evaluated.authority?.observation_stopped) this.observe(evaluated.request.attemptId);
    return { evaluated, data, ...(evaluated.receiptDisplay && evaluated.request ? { receiptDisplay: evaluated.receiptDisplay, displayAttemptId: evaluated.request.attemptId } : {}) };
  }

  async act(record: CardRecord, action: ReturnType<typeof parseWorkflowAction>): Promise<void> {
    this.assertCurrent();
    const runtime = this.options.runtime;
    const management = walletConnectionActionSchema.safeParse(action);
    if (management.success && this.options.records.recoverConnectionOperation(record, management.data)) return;
    const requiresWallet = ["connect", "disconnect", "prepare_review", "request_signature"].includes(action.action);
    if (requiresWallet && record.state.state === "closed") throw new WorkflowConflict("This card was cancelled. Open a new card to start another request.");
    if ("walletRunId" in action && action.walletRunId !== runtime.runId) throw new WorkflowConflict("The wallet service changed. Confirm the current selection again.");
    if (action.action === "request_signature" && record.scope === "review") {
      const recovered = this.options.records.recoverRequest(record, action, { reviewSessionId: String(record.state.input.reviewSessionId),
        reviewRevision: action.reviewRevision, account: action.account, connectionId: action.connectionId });
      if (recovered) return;
    }
    if (requiresWallet) this.assertWalletAvailable();
    switch (action.action) {
      case "cancel": this.options.records.cancelInput(record); return;
      case "connect": {
        const run = runtime.bind();
        const admitted = this.options.records.admitConnection(record, action);
        if (admitted.created) void this.connect(admitted.connection.connection.connectionId, admitted.operationId, run, record.state.cardId)
          .catch(() => this.report("connection"));
        return;
      }
      case "disconnect": {
        const run = runtime.bind(), selected = this.options.records.connection(action.connectionId);
        if (!selected?.topic) throw new WorkflowConflict("The selected wallet connection is unavailable.");
        await run.checkSession(selected.topic, action.operationId); this.assertWalletAvailable(run);
        const admitted = this.options.records.admitDisconnect(record, action);
        if (!admitted.created) return;
        const target = admitted.connection;
        void (async () => {
          try {
            await run.disconnect(target.topic!, action.operationId); this.assertWalletAvailable(run);
            this.options.records.finishDisconnect(action.operationId, action.connectionId, true, this.now());
          } catch { if (!this.stopped) this.options.records.finishDisconnect(action.operationId, action.connectionId, false, this.now()); }
          finally { this.completeCallback({ kind: "connection", id: action.connectionId, cardId: record.state.cardId,
            operationId: action.operationId, action: "disconnect", runId: run.runId }); }
        })().catch(() => this.report("disconnection")); return;
      }
      case "stop_connection": {
        this.options.records.stopConnection(record, action.operationId);
        this.pairings.delete(action.operationId); return;
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
        fixedChainAccount(current.connection, SUI_MAINNET_WALLET_CHAIN) !== account || Date.parse(current.connection.expiresAt) <= this.now().getTime()) {
      throw new WorkflowConflict("The selected Sui wallet connection is unavailable.");
    }
    return current.connection;
  }
  private async checkWallet(run: WalletRun, id: string, account: string, operationId: string) {
    this.assertWalletAvailable(run);
    const stored = this.options.records.connection(id);
    if (!stored?.topic) throw new WorkflowConflict("The selected wallet connection is unavailable.");
    const observed = await run.checkSession(stored.topic, operationId, SUI_MAINNET_WALLET_CHAIN);
    this.assertWalletAvailable(run);
    if (observed.status !== "present" || !walletGrantAccount(observed.session.grants, SUI_MAINNET_WALLET_CHAIN, account)) throw new WorkflowConflict("The selected Sui wallet account is unavailable.");
    return { connection: this.requireWallet(id, account), observed };
  }
  private async connect(id: string, operationId: string, run: WalletRun, cardId: string): Promise<void> {
    let unrecordedOutcome: "failed" | "stopped" | "rejected" = "failed";
    let response: UnacceptedConnectionResponse | undefined, cleanupOwnsSettlement = false;
    const deferCleanup = () => {
      cleanupOwnsSettlement = true;
      this.retainWrite(response!);
    };
    try {
      const operation = this.options.records.operation(operationId);
      if (operation?.input.action !== "connect") throw new WorkflowConflict("The admitted connection scope is unavailable.");
      const result = await run.connect(operation.input.chains, operationId);
      let pairingPublicationFailed = false;
      try {
        this.assertWalletAvailable(run);
        if (this.options.records.operation(operationId)?.status === "running") {
          this.options.records.pairingExpiry(operationId, result.expiresAt);
          this.pairings.set(operationId, { connectionId: id, pairingUri: result.uri, expiresAt: result.expiresAt });
        }
      } catch { pairingPublicationFailed = true; }
      // A stopped display does not settle the original SDK approval or its cleanup.
      const session = await result.approval;
      response = { kind: "connection_cleanup", id, operationId, cardId, runId: run.runId, session };
      this.assertWalletAvailable(run);
      const captured = this.options.records.captureConnectionSession(response, session);
      if (captured !== "captured") return;
      const published = pairingPublicationFailed ? "cleanup_required" : this.options.records.completeConnection(response, session, this.now());
      if (published === "cleanup_required") deferCleanup();
    } catch (error) {
      unrecordedOutcome = error instanceof WalletRunInterruptedError ? "stopped" : error instanceof WalletUserRejectedError ? "rejected" : "failed";
      if (response) deferCleanup();
      else if (!this.stopped) {
        const current = this.options.records.connection(id);
        if (current?.connection.status === "awaiting_approval") this.options.records.updateConnection(id,
          { status: unrecordedOutcome, reason: error instanceof WalletUserRejectedError ? error.message : "Wallet connection could not be confirmed." }, this.now());
      }
    } finally {
      if (!cleanupOwnsSettlement) this.completeCallback({ kind: "connection", id, runId: run.runId, cardId, operationId, action: "connect", unrecordedOutcome });
      this.pairings.delete(operationId);
    }
  }
  private async cleanupConnection(response: UnacceptedConnectionResponse, run: WalletRun): Promise<void> {
    let absent = false;
    try {
      this.assertWalletAvailable(run);
      if (this.observed(response.session.topic)?.status !== "absent") {
        try { await run.disconnect(response.session.topic, response.operationId); }
        catch { /* A lost reply is resolved by exact observation, not another removal. */ }
      }
      this.assertWalletAvailable(run);
      const observed = this.observed(response.session.topic);
      // A received absent snapshot already identifies this topic and current
      // run. Missing/present/unusable evidence needs one exact confirmation.
      absent = (observed?.status === "absent" ? observed : await run.checkSession(response.session.topic, response.operationId)).status === "absent";
      this.assertWalletAvailable(run);
    } catch { /* Retain the exact topic for explicit cleanup when unconfirmed. */ }
    finally {
      this.completeCallback({ kind: "connection", id: response.id, runId: response.runId, cardId: response.cardId,
        operationId: response.operationId, action: "connect", cleanup: { topic: response.session.topic, absent } });
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
      if (!this.options.records.isPreparing(id, preparation) || session.walletGrantRevision !== currentConnection.grantRevisions[SUI_MAINNET_WALLET_CHAIN]) return;
      await this.options.sessions.recordReviewStateWithArtifacts(id, computed.state, computed.privateArtifacts, this.now(),
        { id: preparation, connectionId, grantRevision: currentConnection.grantRevisions[SUI_MAINNET_WALLET_CHAIN] });
    } catch { if (!this.stopped) this.options.records.failPreparation(id, preparation, this.now()); }
  }
  private async sign(request: TransactionRequest, connectionId: string, bytesBase64: string, run: WalletRun): Promise<void> {
    try { await this.performSignature(request, connectionId, bytesBase64, run); }
    finally { this.parentSignatureWork.delete(request.attemptId); this.completeCallback({ kind: "request", id: request.attemptId, field: "sdk_pending" }); }
  }
  private async performSignature(request: TransactionRequest, connectionId: string, bytesBase64: string, run: WalletRun): Promise<void> {
    let response: SuiWalletRevision & { transactionBytes: string; signature: string };
    try {
      this.assertWalletAvailable(run);
      const connection = this.options.records.connection(connectionId);
      if (!connection?.topic || !connectionHasSuiSigningScope(connection.connection, request.account)) throw new WorkflowConflict("The Sui signing scope is unavailable for this connection and account.");
      const checkedWallet = await this.checkWallet(run, connectionId, request.account, request.attemptId);
      this.assertWalletAvailable(run);
      response = await run.sign({ topic: connection.topic, account: request.account, transactionBytesBase64: bytesBase64,
        chainId: SUI_MAINNET_WALLET_CHAIN, lifecycleRevision: checkedWallet.observed.lifecycleRevision, grantRevision: checkedWallet.observed.grantRevisions[SUI_MAINNET_WALLET_CHAIN] }, request.attemptId);
      this.parentSignatureWork.add(request.attemptId);
      this.assertWalletAvailable(run);
    } catch (error) {
      if (!this.stopped) this.options.records.transitionRequest(request.attemptId, "request_failed", this.now(), {
        reason: error instanceof WalletUserRejectedError ? "The wallet approval request was declined. Nothing was submitted."
          : this.walletAvailability().status !== "available" ? "Wallet operations became unavailable before submission. Nothing was submitted."
            : "The wallet signing request could not be completed. Nothing was submitted."
      });
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
      if (current.observed.lifecycleRevision !== response.lifecycleRevision || current.observed.grantRevisions[SUI_MAINNET_WALLET_CHAIN] !== response.grantRevision) throw new WorkflowConflict("The wallet session changed before submission. Nothing was submitted.");
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
    this.options.records.expireConnections(this.now());
    return this.options.records.pendingConnectionOperations().map((operation) => ({
      cardId: operation.cardId, operationId: operation.operationId,
      ...(operation.connectionId ? { connectionId: operation.connectionId } : {}),
      status: operation.status === "running" ? operation.action === "disconnect" ? "disconnect_pending" as const : "awaiting_approval" as const : "cleanup_pending" as const,
      lastActivityAt: operation.updatedAt,
      progress: { status: "waiting" as const }
    }));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.pairings.clear(); this.pendingWrites.clear();
  }
}
