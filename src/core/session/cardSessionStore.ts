import { prepareChartRead, type PreparedChartRead } from "../read/deepbookUsdcChartService.js";
import { isDeepStrictEqual } from "node:util";
import { matchesAcceptedRead, offeredChartMarket, parseCardInput, type OfferedChartMarket, type ReadCardSelection } from "../read/readCardInputs.js";
import { projectReadCardResult } from "../read/readCardResult.js";
import { WALLET_CONNECTION_POLL_SECONDS, WalletUnavailableError } from "./walletConnection.js";
import { EXECUTION_POLLING_INTERVAL_SECONDS } from "./status.js";
import { createLocalSessionBase, DEFAULT_SESSION_TTL_MS, tokenMatchesHash } from "./localSession.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { cardSnapshotSchema, type CardKind, type CardRecord, type CardRecordStore,
  type CardReference, type CardResponse, type CardSnapshot, type CardSubmission, type CardPreparation } from "./cardSession.js";
import type { Logger } from "../../runtime/logger.js";
import type { WalletWorkflow } from "./walletWorkflow.js";
import { WorkflowConflict } from "./sqliteWalletWorkflowStore.js";
import { parseWorkflowAction } from "./workflowView.js";
import { randomUUID } from "node:crypto";
import type { SettingsWorkflow } from "./settingsWorkflow.js";
import { settingsActionSchema, isSettingsDownloadFileAction, SettingsConflict } from "./settingsOperation.js";
import { settingsInputError } from "./settingsInputError.js";


export class CardError extends Error {}

type ReadExecution = Exclude<ReadCardSelection, { kind: "chart" }>
  | (Extract<ReadCardSelection, { kind: "chart" }> & { prepared: PreparedChartRead });

export class CardStore {
  private readonly chartPreviews = new Map<string, unknown>();
  private stopped = false;
  constructor(private readonly options: {
    records: CardRecordStore;
    ownerId: string;
    prepare?: ((kind: CardKind) => Promise<CardPreparation>) | undefined;
    execute(selection: ReadExecution, market?: OfferedChartMarket, preview?: (value: unknown) => void): Promise<unknown>;
    assertCurrent?: (() => void) | undefined;
    now?: (() => Date) | undefined;
    logger?: Logger | undefined;
    workflow?: WalletWorkflow | undefined;
    settings?: SettingsWorkflow | undefined;
  }) {
    this.assertCurrent();
    options.records.recover(options.ownerId, this.now());
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private assertCurrent(): void {
    if (this.stopped) throw new CardError("This card cannot be checked right now.");
    this.options.assertCurrent?.();
  }
  async createFirstReview(sessions: import("./sessionStore.js").SessionStore, plan: import("../action/types.js").ActionPlan,
    target?: { account: string; connectionId: string }) {
    this.assertCurrent();
    const workflow = this.options.workflow;
    if (!workflow) throw new CardError("The review workflow is unavailable.");
    const at = this.now(), { base, token } = createLocalSessionBase(at, DEFAULT_SESSION_TTL_MS);
    const checkTarget = target ? workflow.bindFirstReviewTarget(target) : () => this.assertCurrent();
    const { session } = await sessions.createReviewSession([plan], at, (reviewSessionId) => ({
      assertTarget: checkTarget,
      ...(plan.reviewModel ? { terminalProjection: (record: CardRecord) => workflow.terminalCard(record) } : {}),
      record: { ownerId: this.options.ownerId, tokenHash: base.tokenHash, scope: "review", state: {
        cardId: base.id, kind: "review", ...(plan.reviewModel ? { state: "closed" as const, reason: "completed" as const } : { state: "ready" as const }), revision: 0, createdAt: base.createdAt, expiresAt: base.expiresAt,
        input: { reviewSessionId, ...(target ? { account: target.account, connectionId: target.connectionId } : {}) }
      } }
    }));
    const record = this.current(base.id);
    let created: CardResponse;
    try { created = await this.describe(record, false); }
    catch { created = { snapshot: this.snapshot(record, this.now().toISOString()) }; }
    return { session, card: { ...created, permission: token } };
  }
  async create(kind: CardKind, input: Record<string, unknown>, execute = false): Promise<CardResponse & { permission: string }> {
    this.assertCurrent();
    const business = kind === "connect" || kind === "disconnect" || kind === "review";
    if (kind === "settings" && (!this.options.settings || execute)) throw new CardError("Settings cards are unavailable for this input.");
    if (business && (!this.options.workflow || execute)) throw new CardError("This type of card is unavailable.");
    if (kind === "connect" || kind === "disconnect") input = await this.options.workflow!.connectionCardInput(kind, input);
    const parsed = execute ? parseCardInput(kind, input) : undefined;
    let preparation: CardPreparation = { status: "ready" };
    if (business) {
      preparation = await this.options.workflow!.prepare(kind, input);
      this.assertCurrent();
    } else if (!execute && this.options.prepare) {
      try { preparation = await this.options.prepare(kind); }
      catch { preparation = { status: "failed", error: "The choices for this card could not be loaded." }; }
      // Preparation may finish after reset/import or shutdown. Never create a
      // card in replacement data from that stale continuation.
      this.assertCurrent();
    }
    assertNoForbiddenMcpFields({ input, preparation });
    const { base, token } = createLocalSessionBase(this.now(), DEFAULT_SESSION_TTL_MS);
    const settingsTarget = input.operationStatus ?? input.backupDelivery;
    const settingsOperationId = settingsTarget && typeof settingsTarget === "object" && "operationId" in settingsTarget ? String(settingsTarget.operationId) : randomUUID();
    let record: CardRecord = { ownerId: this.options.ownerId, tokenHash: base.tokenHash,
      scope: kind === "settings" ? "settings" : kind === "connect" || kind === "disconnect" ? kind : kind === "review" ? input.mode === "manage" ? "review_manage" : "review" : "read",
      ...(kind === "settings" ? { operationId: settingsOperationId } : {}),
      ...((kind === "connect" || kind === "disconnect") ? { operationId: String(input.operationId) } : {}),
      ...(kind === "review" && input.mode === "manage" && typeof input.attemptId === "string" ? { operationId: input.attemptId } : {}),
      state: { cardId: base.id, kind, state: preparation.status !== "ready" ? "closed" : "ready", revision: 0,
        createdAt: base.createdAt, expiresAt: base.expiresAt, input,
        ...(preparation.status === "failed" ? { reason: "failed", error: preparation.error } : preparation.status === "completed" ? { reason: "completed" } :
          preparation.data === undefined ? {} : { data: preparation.data }) } };
    if (business && record.state.state === "closed") record = this.options.workflow!.terminalCard(record);
    if (kind === "settings") await this.options.settings!.create(record);
    else this.options.records.create(record);
    const reference = { cardId: base.id, permission: token };
    record = parsed ? this.require(reference) : this.current(base.id);
    if (preparation.status === "failed") this.reportFailure(record, "input_preparation");
    const result = kind === "connect" || kind === "disconnect" ? { snapshot: (await this.readWalletOperation(base.id)).card }
      : parsed === undefined ? await this.describe(record, false) : await this.submitRead(record, reference, 0, parsed, "direct");
    return { ...result, permission: token };
  }
  async read(input: CardReference): Promise<CardResponse> { return this.describe(this.require(input), true); }
  async readSettingsFile(input: CardReference & { operationId: string; fileId: string; offset: number; attemptId?: string | undefined }, limit: number) {
    const record = this.require(input);
    if (record.state.kind !== "settings" || !this.options.settings) throw new CardError("This card does not provide a backup file.");
    if (record.operationId !== input.operationId) throw new CardError("This backup does not match the Settings operation.");
    return this.options.settings.readFile(record, input.fileId, input.offset, limit, input.attemptId);
  }
  async readSaved(cardId: string): Promise<CardSnapshot> {
    this.assertCurrent();
    const closed = this.options.records.getClosedState?.(cardId);
    if (closed) return this.stateSnapshot(closed, 0);
    return (await this.describe(this.current(cardId), false)).snapshot;
  }
  async readWalletOperation(cardId: string) {
    if (!this.options.workflow) throw new CardError("Wallet operations are unavailable.");
    const result = this.options.workflow.readOperation(this.current(cardId));
    return { card: this.snapshot(result.data ? { ...result.record, state: { ...result.record.state, data: result.data } } : result.record, result.evaluatedAt), operation: result.operation,
      walletAvailability: result.walletAvailability, evaluatedAt: result.evaluatedAt };
  }
  private async describe(record: CardRecord, uiObservation: boolean): Promise<CardResponse> {
    if (record.state.state === "closed") return this.response(record);
    if (record.state.kind === "settings") {
      if (!this.options.settings) throw new CardError("Settings cards are unavailable.");
      const described = await this.options.settings.describe(record);
      if (described.record.state.state === "closed") return this.response(described.record);
      return { snapshot: this.stateSnapshot({ ...described.record.state, data: described.data },
         described.record.state.state === "ready" ? Math.max(0, Date.parse(described.record.state.expiresAt) - this.now().getTime()) : 0, EXECUTION_POLLING_INTERVAL_SECONDS * 1000) };
    }
    if (record.state.kind !== "connect" && record.state.kind !== "disconnect" && record.state.kind !== "review") return this.response(record);
    if (!this.options.workflow) throw new CardError("Wallet actions are unavailable.");
    const view = await this.options.workflow.describe(record, uiObservation);
    const current = view.evaluated.record;
    if (!current) throw new CardError("Saved card data is unavailable.");
    if (current.state.state === "closed") return this.response(current);
    const snapshot = cardSnapshotSchema.parse({ ...current.state, data: view.data,
      inputRemainingMs: view.evaluated.inputRemainingMs,
      pollAfterMs: (current.state.kind === "review" ? EXECUTION_POLLING_INTERVAL_SECONDS : WALLET_CONNECTION_POLL_SECONDS) * 1000 });
    assertNoForbiddenMcpFields(snapshot);
    return { snapshot, ...(view.walletDisplay ? { walletDisplay: view.walletDisplay } : {}),
      ...(view.receiptDisplay ? { receiptDisplay: view.receiptDisplay, displayAttemptId: view.displayAttemptId! } : {}) };
  }
  async act(input: CardSubmission): Promise<CardResponse> {
    const record = this.require(input);
    if (record.state.state === "closed" && input.input.action !== "settings_report_download") {
      const normalized = record.state.kind === "settings" ? settingsActionSchema.safeParse(input.input) : undefined;
      if (isDeepStrictEqual(record.acceptedInput, normalized?.success ? normalized.data : input.input) || record.state.reason === "cancelled" &&
        (input.input.action === "stop_waiting" || input.input.action === "cancel" || input.input.action === "stop_connection" && input.input.operationId === record.operationId)) return this.response(record);
      return { ...this.response(record), error: { code: "card_conflict", message: "This card has ended. Ask in chat for a new request." } };
    }
    if (record.state.kind === "settings") {
      if (!this.options.settings) throw new CardError("Settings cards are unavailable.");
      const parsed = settingsActionSchema.safeParse(input.input);
      if (!parsed.success) return { ...await this.describe(record, false), error: { code: "invalid_card_input", message: "This Settings action is not valid." } };
      if ((parsed.data.action === "settings_confirm" || parsed.data.action === "settings_download_backup" || parsed.data.action === "settings_save_wallet_networks" || parsed.data.action === "settings_clear_read_address") && record.acceptedInput !== undefined && isDeepStrictEqual(record.acceptedInput, parsed.data)) return this.describe(record, false);
      if (input.revision !== record.state.revision && !isSettingsDownloadFileAction(parsed.data)) return { ...await this.describe(record, false), error: { code: "card_conflict", message: "This Settings selection changed. Review the current selection before continuing." } };
      const kind = parsed.data.action === "settings_select" ? parsed.data.draft.kind : this.options.settings.operationKind(record);
      try { await this.options.settings.act(record, parsed.data); }
      catch (error) {
        const invalid = settingsInputError(error, kind);
        if (!(error instanceof SettingsConflict) && invalid === undefined) throw error;
        return { ...await this.describe(this.current(input.cardId), false), error: {
          code: invalid === undefined ? "card_conflict" : "invalid_card_input",
          message: invalid?.message ?? (error as SettingsConflict).message
        } };
      }
      return this.describe(this.current(input.cardId), false);
    }
    if ((record.state.kind !== "connect" && record.state.kind !== "disconnect" && record.state.kind !== "review") || !this.options.workflow) {
      return this.conflict(record, "This card does not accept wallet workflow actions.");
    }
    let parsed: ReturnType<typeof parseWorkflowAction>;
    try { parsed = parseWorkflowAction(input.input); }
    catch { return { ...await this.describe(record, false), error: { code: "invalid_card_input", message: "The requested wallet action is not supported by this card." } }; }
    if (record.acceptedInput !== undefined && isDeepStrictEqual(record.acceptedInput, parsed)) return this.describe(record, false);
    if (record.state.revision !== input.revision) return { ...await this.describe(record, false),
      error: { code: "card_conflict", message: "This request does not match the card's current state." } };
    try { await this.options.workflow.act(record, parsed); }
    catch (error) {
      if (!(error instanceof WorkflowConflict) && !(error instanceof WalletUnavailableError)) throw error;
      return { ...await this.describe(this.current(input.cardId), false), error: {
        code: error instanceof WalletUnavailableError ? "wallet_unavailable" : "card_conflict", message: error.message } };
    }
    return this.describe(this.current(input.cardId), true);
  }
  async submit(input: CardSubmission): Promise<CardResponse> {
    const record = this.require(input);
    if (record.state.kind === "connect" || record.state.kind === "disconnect" || record.state.kind === "review" || record.state.kind === "settings") throw new CardError("This card does not accept data selections.");
    let parsed: ReadCardSelection;
    try { parsed = parseCardInput(record.state.kind, input.input); }
    catch { return { ...this.response(record), error: { code: "invalid_card_input", message: "The selected information is not valid for this card." } }; }
    return this.submitRead(record, input, input.revision, parsed, "card");
  }

  private async submitRead(record: CardRecord, reference: CardReference, revision: number, selection: ReadCardSelection, origin: "card" | "direct"): Promise<CardResponse> {
    const parsed = selection.input;
    if (record.acceptedInput !== undefined) {
      if (matchesAcceptedRead(selection, record.acceptedInput)) return this.response(record);
      return this.conflict(record, "This card already accepted a different selection.");
    }
    if (record.state.state !== "ready" || record.ownerId !== this.options.ownerId || record.state.revision !== revision) {
      return this.conflict(record, "This selection does not match the current card.");
    }
    let market: OfferedChartMarket | undefined;
    let execution: ReadExecution;
    if (selection.kind === "chart") {
      const prepared = prepareChartRead(selection.input, this.now());
      if (origin === "card") {
        if (prepared.status !== "ready") return { ...this.response(record), error: {
          code: "invalid_card_input", message: prepared.field === "poolName" ? "Choose a trading pair offered on this chart."
            : `${prepared.field === "startTimeMs" ? "Start" : "End"} time must be at or before the current time.`
        } };
        market = offeredChartMarket(selection.input, record.state.data);
        if (!market) return { ...this.response(record), error: {
          code: "invalid_card_input", message: "Choose a trading pair offered on this chart."
        } };
      }
      execution = { ...selection, prepared };
    } else {
      execution = selection;
    }
    const admitted = this.options.records.admit(record, parsed, this.options.ownerId, () => this.now());
    if (!admitted) return this.conflict(this.require(reference), "The card changed or expired before this selection was accepted.");
    const reading = this.completeRead(admitted, execution, market);
    if (record.state.kind !== "chart") return reading;
    // A long Chart keeps the single admitted read running across Host calls.
    // On the first polling tick the client can observe that same saved card.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([reading, new Promise<CardResponse>((resolve, reject) => {
        timer = setTimeout(() => {
          try { resolve(this.response(this.current(admitted.state.cardId))); }
          catch (error) { reject(error); }
        }, EXECUTION_POLLING_INTERVAL_SECONDS * 1000);
      })]);
    } finally { clearTimeout(timer); }
  }
  private async completeRead(admitted: CardRecord, selection: ReadExecution, market: OfferedChartMarket | undefined): Promise<CardResponse> {
    const { kind, input } = selection;
    let source: unknown;
    const preview = kind === "chart" ? (value: unknown) => {
      this.assertCurrent();
      this.chartPreviews.set(admitted.state.cardId, projectReadCardResult("chart", input, value).data);
    } : undefined;
    try { source = await this.options.execute(selection, market, preview); }
    catch { return this.fail(admitted, "read_service", "The requested data could not be read."); }
    finally { this.chartPreviews.delete(admitted.state.cardId); }
    this.assertCurrent();
    let projected: ReturnType<typeof projectReadCardResult>;
    try { projected = projectReadCardResult(kind, input, source); }
    catch { return this.fail(admitted, "result_validation", "The returned data could not be prepared for this card."); }
    const complete: CardRecord = { ...admitted, ...("receiptDisplay" in projected ? { receiptDisplay: projected.receiptDisplay! } : {}),
      state: { ...admitted.state, data: projected.data, state: "closed", reason: "completed", revision: admitted.state.revision + 1 } };
    // Do not report success or replay the source call if this commit fails.
    try { this.options.records.replace(admitted, complete, this.now()); }
    catch { return this.fail(admitted, "result_storage", "The result could not be saved. This request will not be repeated automatically."); }
    return this.response(this.current(admitted.state.cardId));
  }
  stop(): void { this.stopped = true; this.chartPreviews.clear(); }

  private fail(record: CardRecord, stage: string, message: string): CardResponse {
    this.assertCurrent();
    this.reportFailure(record, stage);
    this.options.records.replace(record, { ...record, state: { ...record.state,
      state: "closed", reason: "failed", error: message, revision: record.state.revision + 1 } }, this.now());
    return this.response(this.current(record.state.cardId));
  }
  private reportFailure(record: CardRecord, stage: string): void {
    try { this.options.logger?.error("Card read failed", { cardId: record.state.cardId, kind: record.state.kind, stage }); }
    catch { /* Logging does not own the operation's state. */ }
  }
  private conflict(record: CardRecord, message: string): CardResponse {
    return { ...this.response(record), error: { code: "card_conflict", message } };
  }
  private current(id: string): CardRecord {
    this.assertCurrent();
    const record = this.options.records.get(id);
    if (!record) throw new CardError("Saved card data is unavailable.");
    return record;
  }
  private require(input: CardReference): CardRecord {
    this.assertCurrent();
    const record = this.options.records.get(input.cardId);
    if (!record || !tokenMatchesHash(record.tokenHash, input.permission)) throw new CardError("Card access is unavailable.");
    return record;
  }
  private snapshot(record: CardRecord, evaluatedAt: string): CardSnapshot {
    const preview = record.state.state === "running" && record.state.kind === "chart" ? this.chartPreviews.get(record.state.cardId) : undefined;
    return this.stateSnapshot(preview ? {...record.state,data:preview} : record.state, record.state.state === "ready" ?
      Math.max(0, Date.parse(record.state.expiresAt) - Date.parse(evaluatedAt)) : 0);
  }
  private stateSnapshot(state: CardRecord["state"], inputRemainingMs: number, pollAfterMs = WALLET_CONNECTION_POLL_SECONDS * 1000): CardSnapshot {
    const snapshot = cardSnapshotSchema.parse({ ...state, pollAfterMs, inputRemainingMs });
    assertNoForbiddenMcpFields(snapshot);
    return snapshot;
  }
  private response(record: CardRecord): CardResponse {
    if (["connect", "disconnect", "review"].includes(record.state.kind) && record.state.state !== "closed") record = this.options.workflow!.expireCard(record);
    const evaluated = this.options.records.evaluate(record, () => this.now());
    record = evaluated.record;
    const receipt = record.state.kind === "review" && record.state.state === "closed" ? this.options.workflow?.closedReceiptDisplay(record) : undefined;
    return { ...(receipt ?? {}), snapshot: this.snapshot(record, evaluated.evaluatedAt), ...(record.receiptDisplay === undefined ? {} : { receiptDisplay: record.receiptDisplay }) };
  }
}
