import { ZodError } from "zod";
import { decideReviewEvaluation, needsReviewMaterial, type ReviewEvaluationCandidate, type ValidatedReviewMaterial } from "./reviewValidity.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ActionPlan,
  InternalSessionStatus,
  ReviewSession,
  ReviewState
} from "../action/types.js";
import type {
  ActivityStore,
  LiveReviewSessionMutation,
  ReviewStateSnapshotInput,
  ReviewTransitionInput
} from "../activity/activityStore.js";
import type { AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";
import { parseLifecycleValidatedReviewState } from "../action/reviewStateValidation.js";
import type { EventLogRecord, EventLogSink } from "../eventlog/sink.js";
import { hashEventValue, NullEventLogSink } from "../eventlog/sink.js";
import {
  LocalTransactionMaterialStoreError,
  verifyLocalTransactionMaterialArtifacts,
  type LocalTransactionMaterialStore
} from "./transactionMaterialStore.js";
import {
  verifyTransactionObjectOwnershipEvidence
} from "../action/transactionObjectOwnershipEvidence.js";
import {
  verifySwapQuotePolicyEvidence
} from "../action/swapQuotePolicyEvidence.js";
import {
  publicHumanReadableReviewFromEvidence
} from "../action/humanReadableReviewEvidence.js";
import {
  publicTransactionSimulationSummaryFromEvidence,
  verifyReviewTimeSimulationEvidence
} from "../action/reviewTimeSimulationEvidence.js";
import {
  verifySupportedHumanReadableReviewEvidence
} from "../action/humanReadableReviewProjectionVerifier.js";
import {
  clonePrivateReviewArtifacts,
  InMemoryPrivateReviewArtifactStore,
  type PrivateReviewArtifactStore,
  type PrivateReviewArtifacts
} from "./privateReviewArtifacts.js";
import {
  InMemorySessionRecordStore,
  type SessionRecordStore
} from "./sessionRecordStore.js";
import { isFinalSessionStatus } from "./status.js";
import { parseSuiAddress } from "../suiAddress.js";
import {
  cloneLocalSession,
  createLocalSessionBase,
  DEFAULT_SESSION_TTL_MS,
  isLocalSessionExpired,
  tokenMatchesHash
} from "./localSession.js";
import { SessionStoreError } from "./sessionErrors.js";

type PrivateDerivedReviewFieldBinding = {
  field: "humanReadableReview" | "simulation";
  getPublicState: (state: ReviewState) => unknown | undefined;
  getPrivateEvidence: (artifacts: PrivateReviewArtifacts) => unknown | undefined;
  projectPrivateEvidence: (evidence: unknown) => unknown;
};

type LiveReviewSessionSideEffects = Omit<LiveReviewSessionMutation, "expected" | "next">;

type LiveReviewSessionProcess = {
  sessionId: string;
  expectedSession?: ReviewSession | undefined;
  nextSession: ReviewSession;
  liveSideEffects?: LiveReviewSessionSideEffects | undefined;
  commitWithLiveSession?: ((live: LiveReviewSessionMutation) => Promise<boolean>) | undefined;
  commitActivityOnly: () => Promise<void>;
  commitLiveSessionOnly: () => void;
  applyActivityOnlySideEffects?: (() => void) | undefined;
  applyActivityOnlySideEffectsOnFailure?: boolean | undefined;
  failureMessage?: string | undefined;
};

const PRIVATE_DERIVED_REVIEW_FIELD_BINDINGS: readonly PrivateDerivedReviewFieldBinding[] = [
  {
    field: "humanReadableReview",
    getPublicState: (state) => state.humanReadableReview,
    getPrivateEvidence: (artifacts) => artifacts.humanReadableReview,
    projectPrivateEvidence: (evidence) =>
      publicHumanReadableReviewFromEvidence(evidence as NonNullable<PrivateReviewArtifacts["humanReadableReview"]>)
  },
  {
    field: "simulation",
    getPublicState: (state) => state.simulation,
    getPrivateEvidence: (artifacts) => artifacts.reviewTimeSimulation,
    projectPrivateEvidence: (evidence) =>
      publicTransactionSimulationSummaryFromEvidence(
        evidence as NonNullable<PrivateReviewArtifacts["reviewTimeSimulation"]>
      )
  }
];

export type CreatedReviewSession = {
  session: ReviewSession;
  token: string;
};

export interface SessionStore {
  createReviewSession(plans: ActionPlan[], now?: Date): Promise<CreatedReviewSession>;
  getReviewSession(id: string, clock?: () => Date): Promise<ReviewSession | undefined>;
  inspectReview(id: string, now?: Date): Promise<ReviewEvaluationCandidate | undefined>;
  recordEvaluationEvents(events: EventLogRecord[]): void;
  listReviewSessions(clock?: () => Date): Promise<ReviewSession[]>;
  readReviewSession(id: string): ReviewSession | undefined;
  reviewSessionIds(): string[];
  validateReviewToken(id: string, token: string, now?: Date): Promise<boolean>;
  recordWalletConnected(id: string, account: string, now?: Date): Promise<ReviewSession>;
  recordReviewState(id: string, state: ReviewState, now?: Date): Promise<ReviewSession>;
  recordReviewStateWithArtifacts(
    id: string,
    state: ReviewState,
    privateArtifacts: PrivateReviewArtifacts | undefined,
    now?: Date,
    preparation?: { id: string; connectionId: string; connectionRevision: number }
  ): Promise<ReviewSession>;
  prepareReviewedTransaction(
    id: string,
    planId: string,
    account: string,
    now?: Date
  ): Promise<ValidatedReviewMaterial>;
  invalidateAllLocalSessions(reason: string, now?: Date): Promise<void>;
}

export type InMemorySessionStoreOptions = {
  now?: () => Date;
  ttlMs?: number;
  ownerId?: string;
  eventLog?: EventLogSink;
  activityStore: ActivityStore;
  transactionMaterialStore?: Pick<
    LocalTransactionMaterialStore,
    "deleteReviewSessionTransactionMaterials" | "getTransactionMaterial"
  >;
  logger: {
    error(message: string, meta?: Record<string, unknown>): void;
  };
  validateAdapterLifecycle: AdapterLifecycleValidator;
};

export type LocalSessionStoreOptions = InMemorySessionStoreOptions & {
  sessions: SessionRecordStore;
  artifacts: PrivateReviewArtifactStore;
};

export { SessionStoreError } from "./sessionErrors.js";
export type { SessionStoreErrorCode } from "./sessionErrors.js";

const REVIEW_STATE_RECOMPUTE_STATUSES = new Set<InternalSessionStatus>([
  "wallet_connected",
  "ready_for_wallet_review",
  "refresh_required",
  "blocked"
]);

const ALLOWED_TRANSITIONS: Record<InternalSessionStatus, InternalSessionStatus[]> = {
  proposed: ["awaiting_wallet", "expired"],
  awaiting_wallet: ["wallet_connected", "expired"],
  wallet_connected: ["ready_for_wallet_review", "refresh_required", "blocked", "expired"],
  ready_for_wallet_review: ["refresh_required", "blocked", "expired"],
  refresh_required: ["ready_for_wallet_review", "blocked", "expired"],
  blocked: ["ready_for_wallet_review", "refresh_required", "expired"],
  expired: []
};

export class LocalSessionStore implements SessionStore {
  private readonly sessions: SessionRecordStore;
  private readonly privateReviewArtifacts: PrivateReviewArtifactStore;
  private readonly ownerId: string;
  private readonly ttlMs: number;
  private readonly clock: () => Date;
  private readonly eventLog: EventLogSink;
  private readonly activityStore: ActivityStore;
  private readonly transactionMaterialStore: Pick<
    LocalTransactionMaterialStore,
    "deleteReviewSessionTransactionMaterials" | "getTransactionMaterial"
  > | undefined;
  private readonly logger: InMemorySessionStoreOptions["logger"];
  private readonly validateAdapterLifecycle: InMemorySessionStoreOptions["validateAdapterLifecycle"];

  constructor(options: LocalSessionStoreOptions) {
    this.sessions = options.sessions;
    this.clock = options.now ?? (() => new Date());
    this.privateReviewArtifacts = options.artifacts;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.ownerId = options.ownerId ?? randomUUID();
    this.eventLog = options.eventLog ?? new NullEventLogSink();
    this.activityStore = options.activityStore;
    this.transactionMaterialStore = options.transactionMaterialStore;
    this.logger = options.logger;
    this.validateAdapterLifecycle = options.validateAdapterLifecycle;
  }

  async createReviewSession(plans: ActionPlan[], now = new Date()): Promise<CreatedReviewSession> {
    if (plans.length !== 1) {
      throw new SessionStoreError("input_invalid", "Exactly one action plan is required per review session");
    }

    const { base, token } = createLocalSessionBase(now, this.ttlMs);
    const session: ReviewSession = {
      ...base,
      ownerId: this.ownerId,
      reviewRevision: 0,
      status: "proposed",
      plans
    };

    const reviewSessionInput = {
      reviewSessionId: session.id,
      plan: plans[0]!,
      currentStatus: session.status,
      createdAt: session.createdAt
    };
    await this.commitLiveReviewSessionProcess({
      sessionId: session.id,
      nextSession: session,
      commitWithLiveSession: this.activityStore.recordReviewSessionWithLiveSession
        ? (live) => this.activityStore.recordReviewSessionWithLiveSession!(reviewSessionInput, live)
        : undefined,
      commitActivityOnly: () => this.activityStore.recordReviewSession(reviewSessionInput),
      commitLiveSessionOnly: () => this.sessions.create(session.id, session),
      failureMessage: `Review session already exists: ${session.id}`
    });
    await this.appendEventLog({
      type: "session.created",
      sessionId: session.id,
      at: now.toISOString()
    });

    return { session: cloneLocalSession(session), token };
  }

  // Snapshot access has no expiry, artifact reconciliation or external work.
  // Public consumers project this private record before exposing any fields.
  readReviewSession(id: string): ReviewSession | undefined {
    const session = this.sessions.get(id);
    return session ? cloneLocalSession(session) : undefined;
  }
  reviewSessionIds(): string[] { return this.sessions.ids(); }

  async inspectReview(id: string, now = this.clock()): Promise<ReviewEvaluationCandidate | undefined> {
    const session = this.sessions.get(id), rowRevision = this.sessions.revision(id);
    if (!session || rowRevision === undefined) return undefined;
    const artifacts = this.privateReviewArtifacts.get(id);
    const candidate: ReviewEvaluationCandidate = { session, rowRevision, artifacts };
    if (!needsReviewMaterial(session, this.sessions.hasAdmittedRevision(id, session.reviewRevision))) return candidate;
    if (!artifacts || !session.reviewState) return candidate;
    try {
      const checked = await this.parseReviewSessionPrivateArtifacts(id, session.reviewState, artifacts, now);
      const handle = checked.artifacts.transactionMaterial!, digest = checked.artifacts.transactionMaterialDigest!;
      candidate.material = { reviewSessionId: id, reviewRevision: session.reviewRevision, rowRevision, review: session, artifacts,
        planId: handle.planId, account: handle.account, reviewedTransactionDigest: digest.transactionDigest,
        transactionMaterial: handle, transactionMaterialDigest: digest,
        transactionBytesBase64: Buffer.from(checked.transactionBytes).toString("base64") };
    } catch (error) {
      // Invalid evidence is a candidate for refresh, never permission to mutate
      // a potentially newer revision. Storage failures must still propagate.
      if (!(error instanceof LocalTransactionMaterialStoreError) && !(error instanceof ReviewEvidenceMismatch) && !(error instanceof ZodError)) throw error;
    }
    return candidate;
  }

  recordEvaluationEvents(events: EventLogRecord[]): void {
    for (const event of events) void this.appendEventLog(event).catch(() => {});
  }

  async getReviewSession(id: string, clock: () => Date = this.clock): Promise<ReviewSession | undefined> {
    const candidate = await this.inspectReview(id, clock());
    if (!candidate) return undefined;
    if (this.activityStore.finalizeReviewEvaluation) {
      const result = this.activityStore.finalizeReviewEvaluation(candidate, clock);
      this.recordEvaluationEvents(result.events);
      return cloneLocalSession(result.session);
    }
    // Preparation-only in-memory fixtures share the decision function. They do
    // not establish SQLite atomicity or wallet admission guarantees.
    const current = this.sessions.get(id);
    if (!current) return undefined;
    const at = clock(), artifacts = this.privateReviewArtifacts.get(id);
    const admitted = this.sessions.hasAdmittedRevision(id, current.reviewRevision);
    const material = !admitted && !current.preparationId && artifacts?.transactionMaterial
      ? this.transactionMaterialStore?.getTransactionMaterial(artifacts.transactionMaterial, at) : undefined;
    if (!admitted && !current.preparationId && artifacts && !material && !needsReviewMaterial(current, admitted)) {
      this.deleteReviewSessionTransactionMaterials(id);
    }
    const next = decideReviewEvaluation(candidate, current, this.sessions.revision(id)!, artifacts, material, admitted, at);
    if (next === current) return cloneLocalSession(current);
    if (next.status === "expired") return this.expireReviewSession(id, current, at);
    await this.recordReviewStateSnapshotWithLiveSession({ reviewSessionId: id, fromStatus: current.status,
      state: next.reviewState!, reviewRevision: next.reviewRevision, recordedAt: at.toISOString() }, current, next, { deleteTransactionMaterials: true });
    return cloneLocalSession(next);
  }

  async listReviewSessions(clock: () => Date = this.clock): Promise<ReviewSession[]> {
    const sessions: ReviewSession[] = [];
    for (const id of this.sessions.ids()) {
      const session = await this.getReviewSession(id, clock);
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  async validateReviewToken(id: string, token: string, _now = new Date()): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    // Review sessions expose expired/final lifecycle states through read APIs after token validation.
    // Mutable methods own expiry transitions and return lifecycle-specific errors.
    return tokenMatchesHash(session.tokenHash, token);
  }

  async recordWalletConnected(id: string, account: string, now = new Date()): Promise<ReviewSession> {
    const session = await this.requireMutableSession(id, now);
    const normalizedAccount = parseSuiAddress(account);
    if (!normalizedAccount) {
      throw new SessionStoreError("input_invalid", "Invalid wallet account address");
    }
    const activeAccount = await this.activityStore.getActiveAccount();
    if (!activeAccount) {
      throw new SessionStoreError(
        "active_account_not_set",
        "Review account binding requires an active read account"
      );
    }
    if (activeAccount.address !== normalizedAccount) {
      throw new SessionStoreError(
        "invalid_session_transition",
        `Review account does not match active read account: ${id}`
      );
    }
    const nextSession = cloneLocalSession(session);
    if (session.account && session.account !== normalizedAccount) {
      throw new SessionStoreError(
        "invalid_session_transition",
        `Review session already bound to a different account: ${id}`
      );
    }
    if (nextSession.status === "proposed") {
      // Explicit backend account binding follows the preparation lifecycle.
      // Active read context alone is not wallet approval; the workflow checks
      // the live wallet connection before invoking this operation.
      transition(nextSession, "awaiting_wallet");
      transition(nextSession, "wallet_connected");
    } else if (nextSession.status === "awaiting_wallet") {
      transition(nextSession, "wallet_connected");
    } else if (!REVIEW_STATE_RECOMPUTE_STATUSES.has(nextSession.status)) {
      throw new SessionStoreError(
        "invalid_session_transition",
        `Invalid session transition: ${nextSession.status} -> wallet_connected`
      );
    }
    nextSession.account = normalizedAccount;
    nextSession.lastActivityAt = now.toISOString();
    await this.recordReviewTransitionWithLiveSession({
      reviewSessionId: id,
      event: "wallet_connected",
      fromStatus: session.status,
      toStatus: nextSession.status,
      account: normalizedAccount,
      transitionedAt: now.toISOString()
    }, session, nextSession);
    await this.appendEventLog({
      type: "wallet.connected",
      sessionId: id,
      walletAddressHash: hashEventValue(normalizedAccount),
      at: now.toISOString()
    });
    return cloneLocalSession(nextSession);
  }

  async recordReviewState(id: string, state: ReviewState, now = new Date()): Promise<ReviewSession> {
    return this.recordReviewStateInternal(id, state, undefined, now);
  }

  async recordReviewStateWithArtifacts(
    id: string,
    state: ReviewState,
    privateArtifacts: PrivateReviewArtifacts | undefined,
    now = this.clock(),
    preparation?: { id: string; connectionId: string; connectionRevision: number }
  ): Promise<ReviewSession> {
    if (this.sessions.hasUnsettledRequest(id, now)) {
      throw new SessionStoreError("invalid_session_transition", "The previous wallet request is still being settled.");
    }
    return this.recordReviewStateInternal(id, state, privateArtifacts, now, preparation);
  }

  private async recordReviewStateInternal(
    id: string,
    state: ReviewState,
    privateArtifacts: PrivateReviewArtifacts | undefined,
    now: Date,
    preparation?: { id: string; connectionId: string; connectionRevision: number }
  ): Promise<ReviewSession> {
    const session = await this.requireMutableSession(id, now);
    if (preparation && (session.preparationId !== preparation.id || session.walletConnectionId !== preparation.connectionId ||
        session.walletConnectionRevision !== preparation.connectionRevision)) this.throwStaleReviewSession(id);
    assertSameSessionId(id, state.reviewSessionId, "Review state");
    assertPlanInSession(session, state.planId);
    const parsedState = parseReviewState(state, this.validateAdapterLifecycle);
    if (!session.account) {
      throw new SessionStoreError(
        "invalid_session_transition",
        `Review state requires a wallet-connected account: ${id}`
      );
    }
    if (session.account !== parsedState.account) {
      throw new SessionStoreError(
        "invalid_session_transition",
        `Review state account does not match the review session account: ${id}`
      );
    }
    let verified;
    try { verified = await this.assertReviewSessionPrivateArtifacts(id, parsedState, privateArtifacts, now); }
    catch (error) {
      if (isDeepStrictEqual(this.sessions.get(id), session)) this.deleteReviewSessionTransactionMaterials(id);
      throw error;
    }
    const nextSession = cloneLocalSession(session);
    transition(nextSession, parsedState.status);
    nextSession.account = session.account;
    nextSession.reviewState = parsedState;
    nextSession.reviewRevision = session.reviewRevision + 1;
    delete nextSession.preparationId;
    delete nextSession.preparationError;
    nextSession.lastActivityAt = now.toISOString();
    try {
      await this.recordReviewStateSnapshotWithLiveSession({
        reviewSessionId: id,
        fromStatus: session.status,
        state: parsedState,
        reviewRevision: nextSession.reviewRevision,
        recordedAt: now.toISOString()
      }, session, nextSession, {
        privateArtifactsJson: this.privateArtifactsJsonForLiveMutation(privateArtifacts),
        ...(preparation && verified ? { publication: { material: verified, clock: this.clock } } : {})
      }, () => this.replaceReviewSessionPrivateArtifacts(id, privateArtifacts));
      await this.appendEventLog({
        type: "state.computed",
        sessionId: id,
        planId: parsedState.planId,
        walletAddressHash: hashEventValue(parsedState.account),
        status: parsedState.status,
        at: now.toISOString()
      });
      return cloneLocalSession(nextSession);
    } catch (error) {
      if (privateArtifacts && !this.isStaleReviewSessionCommitError(error) && isDeepStrictEqual(this.sessions.get(id), session)) {
        this.deleteReviewSessionTransactionMaterials(id);
      }
      throw error;
    }
  }

  private async requireMutableSession(id: string, now: Date): Promise<ReviewSession> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new SessionStoreError("session_not_found", `Review session not found: ${id}`);
    }
    if (isLocalSessionExpired(session, now) && !isFinalSessionStatus(session.status)) {
      await this.expireReviewSession(id, session, now);
      throw new SessionStoreError("session_expired", `Review session expired: ${id}`);
    }
    if (session.status === "expired") {
      throw new SessionStoreError("session_expired", `Review session expired: ${id}`);
    }
    return session;
  }

  async prepareReviewedTransaction(id: string, planId: string, account: string, now = this.clock()): Promise<ValidatedReviewMaterial> {
    const candidate = await this.inspectReview(id, now);
    if (!candidate) throw new SessionStoreError("session_not_found", "Review session is unavailable.");
    assertPlanInSession(candidate.session, planId);
    const state = candidate.session.reviewState;
    if (candidate.session.status !== "ready_for_wallet_review" || state?.planId !== planId || !state.transactionReviewData) {
      throw new SessionStoreError("invalid_session_transition", "Reviewed transaction requires current verified review evidence.");
    }
    if (state.account !== parseSuiAddress(account)) throw new SessionStoreError("input_invalid", "Reviewed transaction account does not match the reviewed account");
    const material = candidate.material;
    if (!material) throw new SessionStoreError("handoff_unavailable", "Reviewed transaction material is unavailable.");
    if (material.reviewedTransactionDigest !== state.transactionReviewData.reviewedTransactionDigest) {
      throw new SessionStoreError("handoff_commitment_mismatch", "Reviewed transaction digest differs from the reviewed commitment.");
    }
    return material;
  }

  async invalidateAllLocalSessions(reason: string, now = new Date()): Promise<void> {
    for (const id of this.sessions.ids()) {
      this.deleteReviewSessionTransactionMaterials(id);
    }
    this.sessions.clear();
    await this.appendEventLog({
      type: "local_sessions.invalidated",
      sessionId: "all",
      reason,
      at: now.toISOString()
    });
  }

  private async appendEventLog(record: EventLogRecord): Promise<void> {
    try {
      await this.eventLog.append(record);
    } catch (error) {
      // Event logs are optional audit/debug sinks. SQLite and in-memory session state remain authoritative.
      this.logger.error("event log append failed", {
        eventType: record.type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private deleteReviewSessionTransactionMaterials(reviewSessionId: string): void {
    try {
      this.transactionMaterialStore?.deleteReviewSessionTransactionMaterials(reviewSessionId);
    } catch (error) {
      this.logger.error("transaction material cleanup failed", {
        reviewSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    this.privateReviewArtifacts.delete(reviewSessionId);
  }

  private async commitLiveReviewSessionProcess(input: LiveReviewSessionProcess): Promise<void> {
    const live: LiveReviewSessionMutation = input.expectedSession
      ? {
          expected: input.expectedSession,
          next: input.nextSession,
          ...input.liveSideEffects
        }
      : {
          next: input.nextSession,
          ...input.liveSideEffects
        };

    if (this.canUseActivityStoreLiveSessionMutations() && input.commitWithLiveSession) {
      const committed = await input.commitWithLiveSession(live);
      if (!committed) {
        this.throwStaleReviewSession(input.sessionId, input.failureMessage);
      }
      return;
    }

    try {
      await input.commitActivityOnly();
      input.commitLiveSessionOnly();
      input.applyActivityOnlySideEffects?.();
    } catch (error) {
      if (input.applyActivityOnlySideEffectsOnFailure) {
        input.applyActivityOnlySideEffects?.();
      }
      throw error;
    }
  }

  private async recordReviewTransitionWithLiveSession(
    input: ReviewTransitionInput,
    expectedSession: ReviewSession,
    nextSession: ReviewSession,
    liveSideEffects: LiveReviewSessionSideEffects = {},
    options: { applyActivityOnlySideEffectsOnFailure?: boolean | undefined } = {}
  ): Promise<void> {
    await this.commitLiveReviewSessionProcess({
      sessionId: expectedSession.id,
      expectedSession,
      nextSession,
      liveSideEffects,
      commitWithLiveSession: this.activityStore.recordReviewTransitionWithLiveSession
        ? (live) => this.activityStore.recordReviewTransitionWithLiveSession!(input, live)
        : undefined,
      commitActivityOnly: () => this.activityStore.recordReviewTransition(input),
      commitLiveSessionOnly: () => this.commitReviewSessionUpdate(expectedSession.id, expectedSession, nextSession),
      applyActivityOnlySideEffects: () => this.applyActivityOnlyLiveSessionSideEffects(expectedSession.id, liveSideEffects),
      applyActivityOnlySideEffectsOnFailure: options.applyActivityOnlySideEffectsOnFailure
    });
  }

  private async recordReviewStateSnapshotWithLiveSession(
    input: ReviewStateSnapshotInput,
    expectedSession: ReviewSession,
    nextSession: ReviewSession,
    liveSideEffects: LiveReviewSessionSideEffects = {},
    applyActivityOnlySideEffects?: (() => void) | undefined
  ): Promise<void> {
    await this.commitLiveReviewSessionProcess({
      sessionId: expectedSession.id,
      expectedSession,
      nextSession,
      liveSideEffects,
      commitWithLiveSession: this.activityStore.recordReviewStateSnapshotWithLiveSession
        ? (live) => this.activityStore.recordReviewStateSnapshotWithLiveSession!(input, live)
        : undefined,
      commitActivityOnly: () => this.activityStore.recordReviewStateSnapshot(input),
      commitLiveSessionOnly: () => this.commitReviewSessionUpdate(expectedSession.id, expectedSession, nextSession),
      applyActivityOnlySideEffects: applyActivityOnlySideEffects
        ?? (() => this.applyActivityOnlyLiveSessionSideEffects(expectedSession.id, liveSideEffects))
    });
  }

  private applyActivityOnlyLiveSessionSideEffects(
    reviewSessionId: string,
    liveSideEffects: LiveReviewSessionSideEffects
  ): void {
    if (liveSideEffects.deleteTransactionMaterials) {
      this.deleteReviewSessionTransactionMaterials(reviewSessionId);
    }
  }

  private privateArtifactsJsonForLiveMutation(
    privateArtifacts: PrivateReviewArtifacts | undefined
  ): string | null {
    if (!privateArtifacts?.transactionMaterial || !privateArtifacts.transactionMaterialDigest) {
      return null;
    }
    return JSON.stringify(clonePrivateReviewArtifacts(privateArtifacts));
  }

  private canUseActivityStoreLiveSessionMutations(): boolean {
    return this.sessions.usesActivityStoreLiveSessionMutations === true;
  }

  private commitReviewSessionUpdate(
    id: string,
    expectedSession: ReviewSession,
    nextSession: ReviewSession
  ): void {
    if (this.sessions.commitReviewSessionTransition(id, expectedSession, nextSession)) {
      return;
    }
    this.throwStaleReviewSession(id);
  }

  private throwStaleReviewSession(id: string, message?: string): never {
    throw new SessionStoreError(
      "invalid_session_transition",
      message ?? `Review session changed before transition committed: ${id}`
    );
  }

  private isStaleReviewSessionCommitError(error: unknown): boolean {
    return (
      error instanceof SessionStoreError &&
      error.code === "invalid_session_transition" &&
      error.message.includes("changed before transition committed")
    );
  }

  private async expireReviewSession(
    id: string,
    session: ReviewSession,
    now: Date
  ): Promise<ReviewSession> {
    const nextSession = cloneLocalSession(session);
    transition(nextSession, "expired");
    await this.recordReviewTransitionWithLiveSession({
      reviewSessionId: id,
      event: "expired",
      fromStatus: session.status,
      toStatus: nextSession.status,
      transitionedAt: now.toISOString()
    }, session, nextSession, { deleteTransactionMaterials: true }, {
      applyActivityOnlySideEffectsOnFailure: true
    });
    return nextSession;
  }

  private replaceReviewSessionPrivateArtifacts(
    reviewSessionId: string,
    privateArtifacts: PrivateReviewArtifacts | undefined
  ): void {
    if (!privateArtifacts?.transactionMaterial || !privateArtifacts.transactionMaterialDigest) {
      this.deleteReviewSessionTransactionMaterials(reviewSessionId);
      return;
    }
    this.privateReviewArtifacts.set(reviewSessionId, privateArtifacts);
  }

  private async assertReviewSessionPrivateArtifacts(
    reviewSessionId: string,
    state: ReviewState,
    privateArtifacts: PrivateReviewArtifacts | undefined,
    now: Date
  ): Promise<{ artifacts: PrivateReviewArtifacts; transactionBytes: Uint8Array } | undefined> {
    if (!privateArtifacts) {
      if (state.humanReadableReview || state.simulation) {
        throw new SessionStoreError(
          "session_mismatch",
          `Review private-derived state requires matching private evidence: ${reviewSessionId}`
        );
      }
      return;
    }
    try {
      return await this.parseReviewSessionPrivateArtifacts(reviewSessionId, state, privateArtifacts, now);
    } catch (error) {
      this.logger.error("private review artifact rejected", {
        reviewSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new SessionStoreError(
        "session_mismatch",
        `Review private artifacts do not match the stored review state: ${reviewSessionId}`
      );
    }
  }

  private async parseReviewSessionPrivateArtifacts(
    reviewSessionId: string,
    state: ReviewState,
    privateArtifacts: PrivateReviewArtifacts,
    now: Date
  ): Promise<{ artifacts: PrivateReviewArtifacts; transactionBytes: Uint8Array }> {
    const { transactionMaterial, transactionMaterialDigest } = privateArtifacts;
    if (
      !transactionMaterial ||
      !transactionMaterialDigest ||
      !this.transactionMaterialStore
    ) {
      throw new ReviewEvidenceMismatch("missing private artifact material, digest, or material store");
    }
    const parsed = await verifyLocalTransactionMaterialArtifacts({
      materialStore: this.transactionMaterialStore,
      transactionMaterial,
      transactionMaterialDigest,
      now
    });
    if (
      parsed.transactionMaterial.reviewSessionId !== reviewSessionId ||
      parsed.transactionMaterial.planId !== state.planId ||
      parsed.transactionMaterial.account !== state.account
    ) {
      throw new ReviewEvidenceMismatch("private artifacts do not match review state identity");
    }
    try {
    const transactionObjectOwnership = privateArtifacts.transactionObjectOwnership
      ? verifyTransactionObjectOwnershipEvidence({
          transactionMaterial: parsed.transactionMaterial,
          transactionMaterialDigest: parsed.transactionMaterialDigest,
          evidence: privateArtifacts.transactionObjectOwnership,
          transactionBytes: parsed.transactionBytes,
          now
        })
      : undefined;
    const swapQuotePolicy = privateArtifacts.swapQuotePolicy
      ? verifySwapQuotePolicyEvidence({
          transactionMaterial: parsed.transactionMaterial,
          evidence: privateArtifacts.swapQuotePolicy,
          now
        })
      : undefined;
    const humanReadableReview = privateArtifacts.humanReadableReview
      ? verifySupportedHumanReadableReviewEvidence({
          transactionMaterial: parsed.transactionMaterial,
          transactionMaterialDigest: parsed.transactionMaterialDigest,
          swapQuotePolicy,
          transactionObjectOwnership,
          evidence: privateArtifacts.humanReadableReview,
          now
        })
      : undefined;
    const reviewTimeSimulation = privateArtifacts.reviewTimeSimulation
      ? verifyReviewTimeSimulationEvidence({
          transactionMaterial: parsed.transactionMaterial,
          transactionMaterialDigest: parsed.transactionMaterialDigest,
          evidence: privateArtifacts.reviewTimeSimulation,
          transactionBytes: parsed.transactionBytes,
          now
        })
      : undefined;
    const verifiedArtifacts = {
      transactionMaterial: parsed.transactionMaterial,
      transactionMaterialDigest: parsed.transactionMaterialDigest,
      ...(swapQuotePolicy ? { swapQuotePolicy } : {}),
      ...(transactionObjectOwnership ? { transactionObjectOwnership } : {}),
      ...(humanReadableReview ? { humanReadableReview } : {}),
      ...(reviewTimeSimulation ? { reviewTimeSimulation } : {})
    };
    assertPrivateDerivedReviewStateProjections(state, verifiedArtifacts);
    return { artifacts: verifiedArtifacts, transactionBytes: parsed.transactionBytes };
    } catch (error) {
      throw new ReviewEvidenceMismatch(error instanceof Error ? error.message : "Private review evidence does not match.");
    }
  }
}

// In-memory session store: the orchestration above with Map-backed record and
// artifact stores. Public name + constructor are unchanged so existing callers and
// the session-store contract test keep working as the regression wall.
export class InMemorySessionStore extends LocalSessionStore {
  constructor(options: InMemorySessionStoreOptions) {
    super({
      ...options,
      sessions: new InMemorySessionRecordStore(),
      artifacts: new InMemoryPrivateReviewArtifactStore()
    });
  }
}

function assertPrivateDerivedReviewStateProjections(
  state: ReviewState,
  privateArtifacts: PrivateReviewArtifacts
): void {
  for (const binding of PRIVATE_DERIVED_REVIEW_FIELD_BINDINGS) {
    const publicValue = binding.getPublicState(state);
    const privateEvidence = binding.getPrivateEvidence(privateArtifacts);
    if (publicValue === undefined && privateEvidence === undefined) {
      continue;
    }
    if (publicValue === undefined || privateEvidence === undefined) {
      throw new ReviewEvidenceMismatch(`review state ${binding.field} must match private ${binding.field} evidence`);
    }
    const projected = binding.projectPrivateEvidence(privateEvidence);
    if (!isDeepStrictEqual(publicValue, projected)) {
      throw new ReviewEvidenceMismatch(`review state ${binding.field} must be projected from private ${binding.field} evidence`);
    }
  }
}

export function transition(session: ReviewSession, next: InternalSessionStatus): void {
  if (session.status === next) {
    return;
  }

  const allowed = ALLOWED_TRANSITIONS[session.status] ?? [];
  if (!allowed.includes(next)) {
    throw new SessionStoreError(
      "invalid_session_transition",
      `Invalid session transition: ${session.status} -> ${next}`
    );
  }
  session.status = next;
}

function assertPlanInSession(session: ReviewSession, planId: string): void {
  if (!session.plans.some((plan) => plan.id === planId)) {
    throw new SessionStoreError(
      "plan_not_in_session",
      `Action plan not found in review session: ${planId}`
    );
  }
}

function assertSameSessionId(expected: string, actual: string, label: string): void {
  if (actual !== expected) {
    throw new SessionStoreError(
      "session_mismatch",
      `${label} session mismatch: expected ${expected}, got ${actual}`
    );
  }
}

function parseReviewState(
  state: ReviewState,
  validateAdapterLifecycle: AdapterLifecycleValidator
): ReviewState {
  let parsed;
  try {
    parsed = parseLifecycleValidatedReviewState(state, validateAdapterLifecycle);
  } catch {
    throw new SessionStoreError("input_invalid", "Invalid review state shape or adapter lifecycle");
  }
  const normalizedAccount = parseSuiAddress(parsed.account);
  if (!normalizedAccount) {
    throw new SessionStoreError("input_invalid", "Invalid review state account");
  }
  return { ...parsed, account: normalizedAccount } as ReviewState;
}

class ReviewEvidenceMismatch extends Error {}
