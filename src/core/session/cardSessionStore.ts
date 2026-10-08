import { isDeepStrictEqual } from "node:util";
import { parseCardInput } from "../read/readCardInputs.js";
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
import { settingsActionSchema, SettingsConflict } from "./settingsOperation.js";
import { settingsInputError } from "./settingsInputError.js";


export class CardError extends Error {}

export class CardStore {
  private stopped = false;
  constructor(private readonly options: {
    records: CardRecordStore;
    ownerId: string;
    prepare?: ((kind: CardKind) => Promise<CardPreparation>) | undefined;
    execute(kind: CardKind, input: Record<string, unknown>): Promise<unknown>;
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
  async create(kind: CardKind, input: Record<string, unknown>, execute = false): Promise<CardResponse & { permission: string }> {
    this.assertCurrent();
    const business = kind === "connect" || kind === "review";
    if (kind === "settings" && (!this.options.settings || execute || Object.keys(input).length)) throw new CardError("Settings cards are unavailable for this input.");
    if (business && (!this.options.workflow || execute)) throw new CardError("This type of card is unavailable.");
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
    const record: CardRecord = { ownerId: this.options.ownerId, tokenHash: base.tokenHash,
      scope: kind === "settings" ? "settings" : kind === "connect" ? "connect" : kind === "review" ? input.mode === "manage" ? "review_manage" : "review" : "read",
      ...(kind === "settings" ? { operationId: randomUUID() } : {}),
      ...(kind === "review" && input.mode === "manage" && typeof input.attemptId === "string" ? { operationId: input.attemptId } : {}),
      state: { cardId: base.id, kind, state: preparation.status === "failed" ? "closed" : "ready", revision: 0,
        createdAt: base.createdAt, expiresAt: base.expiresAt, input,
        ...(preparation.status === "failed" ? { reason: "failed", error: preparation.error } :
          preparation.data === undefined ? {} : { data: preparation.data }) } };
    if (kind === "settings") this.options.settings!.create(record);
    else this.options.records.create(record);
    if (preparation.status === "failed") this.reportFailure(record, "input_preparation");
    const result = parsed === undefined ? await this.describe(record, false) : await this.submit({
      cardId: base.id, permission: token, revision: 0, input: parsed
    });
    return { ...result, permission: token };
  }
  async read(input: CardReference): Promise<CardResponse> { return this.describe(this.require(input), true); }
  async readSettingsFile(input: CardReference & { operationId: string; fileId: string; offset: number }, limit: number) {
    const record = this.require(input);
    if (record.state.kind !== "settings" || !this.options.settings) throw new CardError("This card does not provide a backup file.");
    if (record.operationId !== input.operationId) throw new CardError("This backup does not match the Settings operation.");
    return this.options.settings.readFile(record, input.fileId, input.offset, limit);
  }
  async readSaved(cardId: string): Promise<CardSnapshot> { return (await this.describe(this.current(cardId), false)).snapshot; }
  private async describe(record: CardRecord, uiObservation: boolean): Promise<CardResponse> {
    if (record.state.kind === "settings") {
      if (!this.options.settings) throw new CardError("Settings cards are unavailable.");
      const described = await this.options.settings.describe(record);
      return { snapshot: cardSnapshotSchema.parse({ ...described.record.state, data: described.data,
        inputRemainingMs: described.record.state.state === "ready" ? Math.max(0, Date.parse(described.record.state.expiresAt) - this.now().getTime()) : 0,
        pollAfterMs: EXECUTION_POLLING_INTERVAL_SECONDS * 1000 }) };
    }
    if (record.state.kind !== "connect" && record.state.kind !== "review") return this.response(record);
    if (!this.options.workflow) throw new CardError("Wallet actions are unavailable.");
    const view = await this.options.workflow.describe(record, uiObservation);
    const current = view.evaluated.record;
    if (!current) throw new CardError("Saved card data is unavailable.");
    const snapshot = cardSnapshotSchema.parse({ ...current.state, data: view.data,
      inputRemainingMs: view.evaluated.inputRemainingMs,
      pollAfterMs: (current.state.kind === "review" ? EXECUTION_POLLING_INTERVAL_SECONDS : WALLET_CONNECTION_POLL_SECONDS) * 1000 });
    assertNoForbiddenMcpFields(snapshot);
    return { snapshot, ...(view.walletDisplay ? { walletDisplay: view.walletDisplay } : {}),
      ...(view.receiptDisplay ? { receiptDisplay: view.receiptDisplay, displayAttemptId: view.displayAttemptId! } : {}) };
  }
  async act(input: CardSubmission): Promise<CardResponse> {
    const record = this.require(input);
    if (record.state.kind === "settings") {
      if (!this.options.settings) throw new CardError("Settings cards are unavailable.");
      const parsed = settingsActionSchema.safeParse(input.input);
      if (!parsed.success) return { ...await this.describe(record, false), error: { code: "invalid_card_input", message: "This Settings action is not valid." } };
      if (parsed.data.action === "settings_confirm" && record.acceptedInput !== undefined && isDeepStrictEqual(record.acceptedInput, parsed.data)) return this.describe(record, false);
      if (input.revision !== record.state.revision) return { ...await this.describe(record, false), error: { code: "card_conflict", message: "This Settings selection changed. Review the current selection before continuing." } };
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
    if ((record.state.kind !== "connect" && record.state.kind !== "review") || !this.options.workflow) {
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
    return this.describe(this.current(input.cardId), false);
  }
  async submit(input: CardSubmission): Promise<CardResponse> {
    const record = this.require(input);
    if (record.state.kind === "connect" || record.state.kind === "review" || record.state.kind === "settings") throw new CardError("This card does not accept data selections.");
    let parsed: Record<string, unknown>;
    try { parsed = parseCardInput(record.state.kind, input.input); }
    catch { return { ...this.response(record), error: { code: "invalid_card_input", message: "The selected information is not valid for this card." } }; }
    if (record.acceptedInput !== undefined) {
      if (isDeepStrictEqual(record.acceptedInput, parsed)) return this.response(record);
      return this.conflict(record, "This card already accepted a different selection.");
    }
    if (record.state.state !== "ready" || record.ownerId !== this.options.ownerId || record.state.revision !== input.revision) {
      return this.conflict(record, "This selection does not match the current card.");
    }
    const admitted = this.options.records.admit(record, parsed, this.options.ownerId, () => this.now());
    if (!admitted) return this.conflict(this.require(input), "The card changed or expired before this selection was accepted.");
    let source: unknown;
    try { source = await this.options.execute(record.state.kind, parsed); }
    catch { return this.fail(admitted, "read_service", "The requested data could not be read."); }
    this.assertCurrent();
    let projected: ReturnType<typeof projectReadCardResult>;
    try { projected = projectReadCardResult(record.state.kind, parsed, source); }
    catch { return this.fail(admitted, "result_validation", "The returned data could not be prepared for this card."); }
    const complete: CardRecord = { ...admitted, ...("receiptDisplay" in projected ? { receiptDisplay: projected.receiptDisplay! } : {}),
      state: { ...admitted.state, data: projected.data, state: "closed", reason: "completed", revision: admitted.state.revision + 1 } };
    // Do not report success or replay the source call if this commit fails.
    try { this.options.records.replace(admitted, complete); }
    catch { return this.fail(admitted, "result_storage", "The result could not be saved. This request will not be repeated automatically."); }
    return this.response(this.current(record.state.cardId));
  }
  stop(): void { this.stopped = true; }

  private fail(record: CardRecord, stage: string, message: string): CardResponse {
    this.assertCurrent();
    this.reportFailure(record, stage);
    this.options.records.replace(record, { ...record, state: { ...record.state,
      state: "closed", reason: "failed", error: message, revision: record.state.revision + 1 } });
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
    const snapshot = cardSnapshotSchema.parse({ ...record.state,
      pollAfterMs: WALLET_CONNECTION_POLL_SECONDS * 1000,
      inputRemainingMs: record.state.state === "ready" ? Math.max(0, Date.parse(record.state.expiresAt) - Date.parse(evaluatedAt)) : 0 });
    assertNoForbiddenMcpFields(snapshot);
    return snapshot;
  }
  private response(record: CardRecord): CardResponse {
    const evaluated = this.options.records.evaluate(record, () => this.now());
    record = evaluated.record;
    return { snapshot: this.snapshot(record, evaluated.evaluatedAt), ...(record.receiptDisplay === undefined ? {} : { receiptDisplay: record.receiptDisplay }) };
  }
}
