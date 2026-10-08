import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { TextDecoder } from "node:util";
import type { SqliteActivityStore } from "../activity/sqliteActivityStore.js";
import type { SqliteLocalDataService } from "../activity/localDataService.js";
import { LocalDataError } from "../activity/localDataTypes.js";
import { settingsInputError, SETTINGS_REPLACEMENT_BLOCKED_MESSAGE } from "./settingsInputError.js";
import type { SqlitePreferencesRepository } from "../preferences/sqlitePreferencesRepository.js";
import { SETTINGS_APPLIES_AFTER_RESTART } from "../preferences/preferencesStore.js";
import { parseGraphqlUrl, parseGrpcUrl } from "../suiEndpoint.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import type { CardRecord } from "./cardSession.js";
import { SettingsFileStore, settingsFileDigest, decodeSettingsChunk } from "./settingsFileStore.js";
import { SqliteSettingsWorkflowStore, settingsIdentity } from "./sqliteSettingsWorkflowStore.js";
import { SettingsConflict, settingsViewSchema, endpointPreparationSchema, storedRestoreCheckSchema, retainedBackupRejection, permitsBackupRecheck, type RestoreCheck, type SettingsAction, type SettingsDraft, type SettingsFile, type SettingsOperation, type SettingsResult, type SettingsView } from "./settingsOperation.js";
import type { WalletWorkflow } from "./walletWorkflow.js";
import type { WalletRuntimeEvent } from "./walletRuntime.js";

type EndpointChange = { key: "suiGrpcUrl" | "suiGraphqlUrl"; value: string; status: "saved" | "reset" };
export class SettingsWorkflow {
  private readonly pendingResults = new Map<string, { result: SettingsResult; ready: boolean; file?: SettingsFile }>();
  private readonly finishedFileIO = new Set<string>();
  // This tracks actual pending I/O only; SQLite owns check results and permission.
  private readonly checkingFiles = new Set<string>();
  constructor(private readonly options: {
    records: SqliteSettingsWorkflowStore; files: SettingsFileStore; activity: SqliteActivityStore;
    localData: SqliteLocalDataService; preferences: SqlitePreferencesRepository; wallet: WalletWorkflow;
    readFacts(): Promise<NonNullable<SettingsView["facts"]>>;
    resolveEndpoint(input: Extract<SettingsDraft, { kind: "set_endpoint" | "restore_endpoint" }>): EndpointChange;
    verifyEndpoint(input: Extract<SettingsDraft, { kind: "set_endpoint" | "restore_endpoint" }>): Promise<EndpointChange>;
    assertCurrent(): void;
    interruptRun(runId: string): void;
  }) {
    options.wallet.attachSettingsRecovery({ synchronize: () => this.synchronize(undefined, true),
      runtimeEvent: (event) => this.runtimeEvent(event), readyPublished: (runId) => this.readyPublished(runId) });
  }
  private get records() { this.options.assertCurrent(); return this.options.records; }
  create(record: CardRecord): void { this.records.create(record); }
  operationKind(record: CardRecord): SettingsDraft["kind"] | undefined { return this.records.forCard(record).draft?.kind; }
  recoverOwner(): void {
    // Invalidate old input synchronously. Verifying a prior backup and removing
    // temporary files must not delay unrelated MCP startup or completed reads.
    this.records.transaction(() => {
      const rows = this.records.db.prepare("SELECT operation_id FROM settings_operations WHERE owner_id!=? AND phase!='terminal'")
        .all(this.records.ownerId) as { operation_id: string }[];
      for (const row of rows) {
        const operation = this.records.get(row.operation_id)!;
        const file = operation.fileId ? this.records.file(operation.fileId) : undefined;
        const card = this.records.cards.get(operation.cardId);
        if (!card) continue;
        const verifyExport = operation.draft?.kind === "export_local_data" && file?.role === "export" && !!operation.admittedAt;
        const result: SettingsResult = { outcome: "interrupted", recordedAt: this.now().toISOString(),
          message: operation.admittedAt
            ? "Sui MCP restarted before this confirmed change finished. It will not be repeated. Check the result of the original request separately."
            : "Sui MCP restarted before you confirmed this change. It will not be repeated." };
        this.records.db.prepare(`UPDATE settings_operations SET owner_id=?,phase=?,result_json=?,checkpoint=? WHERE operation_id=?`)
          .run(this.records.ownerId, verifyExport ? "executing" : "terminal", verifyExport ? null : JSON.stringify(result),
            verifyExport ? "verify_export_after_owner_change" : null, operation.operationId);
        const reason = card.state.reason ?? (card.state.state === "ready" && Date.parse(card.state.expiresAt) <= this.now().getTime() ? "expired" : "server_restarted");
        if (this.records.db.prepare(`UPDATE live_read_cards SET owner_id=?,state=?,reason=?,revision=revision+1
          WHERE id=? AND owner_id=? AND token_hash=? AND revision=?`).run(this.records.ownerId, verifyExport ? "running" : "closed",
            verifyExport ? null : reason, card.state.cardId, card.ownerId, card.tokenHash, card.state.revision).changes !== 1) {
          throw new SettingsConflict("The interrupted Settings card changed while its status was being updated.");
        }
        if (file?.role === "upload") this.records.writeFile({ ...file, invalidated: true });
        this.records.db.prepare(`UPDATE settings_control SET active_operation_id=NULL,wallet_input_blocked=0,wallet_block_operation_id=NULL
          WHERE id=1 AND active_operation_id=?`).run(operation.operationId);
        if (file) this.records.releaseFileIO(file.fileId);
      }
      // The departed owner may have committed a terminal result and finished
      // physical I/O, but failed to persist its final I/O release. Terminal
      // operations were intentionally not reopened above. Release that stale
      // reservation without replaying the operation or touching a current owner.
      const ioId = this.records.control().file_io_id;
      if (ioId) {
        const file = this.records.file(ioId);
        const cleanupOwner = file && this.records.get(file.cleanupOperationId ?? file.operationId);
        if (!cleanupOwner || cleanupOwner.ownerId !== this.records.ownerId) this.records.releaseFileIO(ioId);
      }
    });
  }
  async cleanupAfterOwnerChange(): Promise<void> { await this.cleanupTemporaryFiles(); }
  private async verifyPriorExport(operation: SettingsOperation): Promise<void> {
    const file = operation.fileId ? this.records.file(operation.fileId) : undefined;
    let result: SettingsResult = { outcome: "interrupted", recordedAt: this.now().toISOString(),
      message: "Sui MCP restarted and the backup file could not be checked. Open a new Settings card to create another backup." };
    if (file) {
      try {
        await this.options.files.verifyExport(file);
        result = { outcome: "completed", recordedAt: this.now().toISOString(), message: "The previously created local backup was verified.",
          details: { path: this.options.files.exportPath(file), filename: file.displayName, fileId: file.fileId, sha256: file.sha256, totalSize: file.totalSize } };
      } catch { /* A missing artifact is never regenerated on a read. */ }
    }
    this.options.assertCurrent();
    this.retainResult(operation.operationId, result, false, file && result.outcome === "completed" ? { ...file, sealed: true, receivedSize: file.totalSize } : undefined);
  }
  async readFile(record: CardRecord, fileId: string, offset: number, limit: number): Promise<{ file: SettingsFile; offset: number; chunkBase64: string }> {
    const operation = this.records.forCard(record), file = this.records.file(fileId);
    if (operation.result?.outcome !== "completed" || operation.draft?.kind !== "export_local_data" || operation.fileId !== fileId ||
        !file || file.operationId !== operation.operationId || !file.sealed || file.invalidated) throw new SettingsConflict("This completed backup is not available for download.");
    const length = Math.min(limit, file.totalSize - offset);
    const data = await this.options.files.readExportRange(file, offset, length);
    this.options.assertCurrent();
    return { file, offset, chunkBase64: data.toString("base64") };
  }
  private now(): Date { return this.records.now(); }
  private withoutPreparation(operation: SettingsOperation): SettingsOperation {
    const { preparationId: _id, fingerprint: _fingerprint, preparation: _preparation,
      preparedUserDataRevision: _revision, ...rest } = operation;
    const rejection = retainedBackupRejection(operation, operation.fileId ? this.records.file(operation.fileId) : undefined);
    return rejection ? { ...rest, preparation: { restoreCheck: rejection } } : rest;
  }
  private async backupInput(file: SettingsFile): Promise<unknown> {
    const bytes = await this.options.files.readUpload(file);
    return this.parseBackupBytes(bytes);
  }
  private parseBackupBytes(bytes: Buffer): unknown {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) {
      if (!(error instanceof TypeError) || !("code" in error) || error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
      throw new LocalDataError("input_invalid", "The backup is not valid UTF-8.", { reason: "invalid_backup_encoding" });
    }
    try { return JSON.parse(text) as unknown; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new LocalDataError("input_invalid", "The backup is not valid JSON.", { reason: "invalid_backup_json" });
    }
  }
  private fingerprint(operation: SettingsOperation): string {
    const control = this.records.control(), draft = operation.draft;
    if (!draft) throw new SettingsConflict("Choose what you want to change in Settings first.");
    const common = { draft, epoch: control.data_epoch };
    if (draft.kind === "restart_wallet_service") {
      const context = this.options.wallet.currentRecoveryFacts();
      const active = control.active_operation_id && this.records.get(control.active_operation_id);
      return settingsIdentity({ ...common, runId: context.availability.walletRunId, impact: context.impact,
        activeId: active ? active.operationId : null, activePhase: active ? active.phase : null });
    }
    if (draft.kind === "set_endpoint" || draft.kind === "restore_endpoint") return settingsIdentity({ ...common, target: this.options.resolveEndpoint(draft),
      current: this.options.preferences.getLocalSettingSync(draft.endpoint === "grpc" ? "suiGrpcUrl" : "suiGraphqlUrl") });
    if (draft.kind === "clear_read_address") return settingsIdentity({ ...common,
      current: this.records.db.prepare("SELECT * FROM active_account_context WHERE id=1").get() ?? null });
    if (draft.kind === "import_local_data" || draft.kind === "reset_local_data") return settingsIdentity({ ...common,
      userDataRevision: control.user_data_revision, file: operation.fileId ? this.records.file(operation.fileId) : null });
    return settingsIdentity(common);
  }
  private requireRestartPreparation(context: ReturnType<WalletWorkflow["currentRecoveryFacts"]>): SettingsOperation | undefined {
    const id = this.records.control().active_operation_id, active = id ? this.records.get(id) : undefined;
    if (context.availability.status === "recovering" || active &&
        (active.phase !== "starting" || active.nextRunId !== context.availability.walletRunId || context.availability.status !== "initializing")) {
      throw new SettingsConflict("A Settings change or service restart has not finished. This restart cannot replace it.");
    }
    return active;
  }
  private canPrepareRestart(): boolean {
    try { this.requireRestartPreparation(this.options.wallet.currentRecoveryFacts()); return true; }
    catch (error) { if (error instanceof SettingsConflict) return false; throw error; }
  }
  private requireSupersedable(operationId: string, runId: string | undefined): SettingsOperation {
    const previous = this.records.get(operationId);
    if (!previous || previous.phase !== "starting" || previous.nextRunId !== runId || this.pendingResults.has(operationId)) {
      throw new SettingsConflict("The earlier service startup changed. Check its result before continuing.");
    }
    return previous;
  }
  private requireConfirmation(record: CardRecord, operation: SettingsOperation): void {
    const replacing = operation.draft?.kind === "restart_wallet_service" && typeof operation.preparation?.supersedesOperationId === "string"
      ? operation.preparation.supersedesOperationId : undefined;
    this.records.requireAdmission(record, { action: "settings_confirm", operationId: operation.operationId,
      preparationId: operation.preparationId! }, () => this.fingerprint(operation), replacing);
    if (replacing) this.requireSupersedable(replacing, operation.priorRunId);
    if (operation.draft?.kind === "import_local_data" || operation.draft?.kind === "reset_local_data") {
      this.options.localData.assertReplacementAllowed(this.now());
    }
  }
  private canConfirm(record: CardRecord, operation: SettingsOperation): boolean {
    try { this.requireConfirmation(record, operation); return true; }
    catch (error) {
      if (error instanceof SettingsConflict || error instanceof LocalDataError && error.details.reason === "wallet_request_unsettled") return false;
      throw error;
    }
  }
  private restoreCheck(operation: SettingsOperation, record: CardRecord, file: SettingsFile | undefined): RestoreCheck {
    if (!file || file.invalidated) return { status: "no_file" };
    const unavailable = (reason: Extract<RestoreCheck, { status: "cannot_restore" }>["reason"], message: string): RestoreCheck =>
      ({ status: "cannot_restore", reason, message });
    const required = (message: string): RestoreCheck => ({ status: "check_required", message });
    if (record.state.state !== "ready" || record.ownerId !== this.records.ownerId ||
        operation.dataEpoch !== this.records.control().data_epoch || Date.parse(record.state.expiresAt) <= this.now().getTime()) {
      return unavailable("input_unavailable", "This Settings request can no longer restore data. Open a new Settings card.");
    }
    if (this.checkingFiles.has(file.fileId)) return { status: "checking" };
    const rejection = retainedBackupRejection(operation, file);
    if (rejection) return rejection.check;
    if (operation.phase === "prepared" && operation.preparationId) {
      try {
        this.requireConfirmation(record, operation);
        return { status: "can_restore" };
      } catch (error) {
        if (error instanceof LocalDataError && error.details.reason === "wallet_request_unsettled") {
          return unavailable("wallet_request_unsettled", SETTINGS_REPLACEMENT_BLOCKED_MESSAGE);
        }
        if (!(error instanceof SettingsConflict)) throw error;
        const control = this.records.control();
        return control.file_io_id !== null || control.active_operation_id !== null
          ? unavailable("operation_busy", "Another Settings change or file transfer is in progress. Wait for it to finish before restoring.")
          : required("Local records changed or the earlier check is out of date. Check the same backup again.");
      }
    }
    const saved = storedRestoreCheckSchema.safeParse(operation.preparation?.restoreCheck);
    if (saved.success && saved.data.fileId === file.fileId && saved.data.sha256 === file.sha256 && saved.data.totalSize === file.totalSize &&
        saved.data.dataEpoch === operation.dataEpoch && saved.data.userDataRevision === this.records.control().user_data_revision) {
      if (saved.data.check.status === "cannot_restore") {
        if (saved.data.check.reason === "wallet_request_unsettled") {
          try { this.options.localData.assertReplacementAllowed(this.now()); }
          catch (error) { if (error instanceof LocalDataError && error.details.reason === "wallet_request_unsettled") return saved.data.check; throw error; }
          return required("The earlier wallet or transaction wait has ended. Check this backup again.");
        }
        if (saved.data.check.reason === "operation_busy" && this.records.control().file_io_id === null &&
            this.records.control().active_operation_id === null) {
          return required("The earlier Settings change or file transfer has ended. Check this backup again.");
        }
        return saved.data.check;
      }
      if (saved.data.check.status === "checking") return unavailable("check_failed", "The backup check did not finish. Check this backup again.");
      if (saved.data.check.status === "check_required") return saved.data.check;
    }
    return file.sealed ? required("Check this backup again before restoring.") : { status: "receiving" };
  }
  async describe(record: CardRecord): Promise<{ record: CardRecord; data: SettingsView }> {
    this.options.assertCurrent();
    let operation = this.records.forCard(record);
    if (operation.result) {
      // The result is already committed. A failed release of known-ended I/O
      // must remain retryable without making that result depend on the write.
      try { this.synchronize(operation.operationId); }
      catch { this.options.assertCurrent(); }
    }
    if (operation.result === undefined) {
      this.synchronize(operation.operationId);
      operation = this.records.get(operation.operationId)!;
      if (operation.checkpoint === "verify_export_after_owner_change" && !operation.result) await this.verifyPriorExport(operation);
      if (operation.draft?.kind === "restart_wallet_service" && operation.admittedAt) {
        this.options.wallet.recoveryContext();
        this.assertRecoveryRecorded();
      }
      this.records.transaction(() => {
        record = this.records.cards.evaluate(record, () => this.now()).record;
        if (record.state.state === "closed" && record.state.reason === "expired") {
          if (operation.fileId) this.invalidateFile(operation.fileId);
          this.records.finish(operation.operationId, { outcome: "interrupted", recordedAt: this.now().toISOString(), message: "The time to confirm this Settings change has ended." });
        }
      });
      operation = this.records.get(operation.operationId)!;
    }
    if (operation.result) {
      for (const file of this.records.filesNeedingCleanup(operation.operationId)) {
        await this.cleanupFile(file).catch(() => { this.options.assertCurrent(); });
      }
    }
    // Completed facts do not depend on current wallet or unrelated cleanup writes.
    const facts = operation.result ? undefined : await this.options.readFacts();
    this.options.assertCurrent();
    record = this.records.cards.get(record.state.cardId)!;
    operation = this.records.forCard(record);
    const file = operation.fileId ? this.records.file(operation.fileId) : undefined;
    const restoreCheck = operation.draft?.kind === "import_local_data" && !operation.result
      ? this.restoreCheck(operation, record, file) : undefined;
    const allowed: SettingsAction["action"][] = [];
    if (record.state.state === "ready" && record.ownerId === this.records.ownerId && operation.dataEpoch === this.records.control().data_epoch && !operation.result) {
      const fileIOAvailable = this.records.fileIOAvailable();
      if (fileIOAvailable) {
        allowed.push("settings_select", "settings_cancel");
        if (operation.draft) allowed.push("settings_back");
      }
      if (operation.phase === "prepared" && (restoreCheck ? restoreCheck.status === "can_restore" : this.canConfirm(record, operation))) {
        allowed.push("settings_confirm");
      }
      if (operation.draft?.kind === "import_local_data") {
        if (fileIOAvailable && file && !file.invalidated && file.receivedSize === file.totalSize && !file.reservation &&
            restoreCheck && permitsBackupRecheck(restoreCheck)) allowed.push("settings_prepare");
        // A matching upload may resume without allocating another file. New
        // writes still require the shared reservation check at their admission.
        if (fileIOAvailable && ["draft", "uploading"].includes(operation.phase) &&
            (file && !file.invalidated || this.records.canReserveFileIO(operation.operationId))) allowed.push("settings_begin_upload");
      } else if (operation.phase !== "prepared" && operation.draft &&
          (operation.draft.kind !== "restart_wallet_service" || this.canPrepareRestart())) allowed.push("settings_prepare");
      if (operation.phase === "uploading" && file && !file.invalidated && !file.sealed) {
        if (file.receivedSize > 0 || file.receivedSize < file.totalSize && this.records.canReserveFileIO(operation.operationId)) {
          allowed.push("settings_upload_chunk");
        }
        if (fileIOAvailable && file.receivedSize === file.totalSize && !file.reservation && !this.checkingFiles.has(file.fileId) &&
            !retainedBackupRejection(operation, file)) allowed.push("settings_seal_upload");
      }
    }
    const cleanup = operation.result ? this.records.temporaryFileCleanup(operation.operationId) : undefined;
    const backupPath = operation.draft?.kind === "export_local_data" && operation.result?.outcome === "completed"
      ? operation.result.details?.path : undefined;
    const data: SettingsView = { kind: "settings", operationId: operation.operationId, phase: operation.phase, allowedActions: allowed,
      observe: !operation.result && (["executing", "stopping", "starting"].includes(operation.phase) || restoreCheck?.status === "checking"),
      ...(restoreCheck ? { restoreCheck } : {}),
      ...(typeof backupPath === "string" ? { backupLocation: { directory: dirname(backupPath), filename: basename(backupPath) } } : {}),
      ...(operation.draft ? { draft: operation.draft } : {}), ...(operation.preparationId ? { preparationId: operation.preparationId } : {}),
      ...(operation.preparation ? { preparation: operation.preparation } : {}), ...(operation.result ? { result: operation.result } : {}),
      ...(cleanup ? { temporaryFileCleanup: cleanup } : {}),
      ...(file ? { file: { fileId: file.fileId, displayName: file.displayName, totalSize: file.totalSize, receivedSize: file.receivedSize, sha256: file.sha256, sealed: file.sealed, cleanup: file.cleanup } } : {}),
      ...(facts ? { facts } : {}), ...(operation.priorRunId ? { priorRunId: operation.priorRunId } : {}),
      ...(operation.nextRunId ? { nextRunId: operation.nextRunId } : {}),
      ...(operation.supersedesOperationId ? { supersedesOperationId: operation.supersedesOperationId } : {}),
      ...(operation.supersededByOperationId ? { supersededByOperationId: operation.supersededByOperationId } : {}) };
    assertNoForbiddenMcpFields(data);
    return { record, data: settingsViewSchema.parse(data) };
  }
  async act(expected: CardRecord, action: SettingsAction): Promise<void> {
    this.options.assertCurrent();
    const stored = this.records.forCard(expected);
    if (action.action === "settings_confirm" && stored.acceptedDigest === settingsIdentity(action)) return;
    if (action.action === "settings_confirm") { await this.confirm(expected, action); return; }
    if (action.action === "settings_prepare") { await this.prepare(expected, action.operationId); return; }
    if (action.action === "settings_begin_upload") { await this.beginUpload(expected, action); return; }
    if (action.action === "settings_upload_chunk") { await this.upload(expected, action); return; }
    if (action.action === "settings_seal_upload") { await this.seal(expected, action); return; }
    this.records.transaction(() => {
      const { card, operation } = this.records.requireInput(expected, "operationId" in action ? action.operationId : undefined);
      if (!this.records.fileIOAvailable()) throw new SettingsConflict("Wait for the file transfer to finish before changing your selection.");
      if (action.action === "settings_cancel") {
        if (operation.fileId) this.invalidateFile(operation.fileId);
        this.records.finish(operation.operationId, { outcome: "interrupted", recordedAt: this.now().toISOString(), message: "This Settings change was cancelled. Nothing was applied." });
        return;
      }
      if (action.action === "settings_select" && action.draft.kind === "set_endpoint") {
        // Drafts are public display state. Reject credentials and invalid URLs
        // before storing or projecting the user's endpoint input.
        action = { ...action, draft: { ...action.draft,
          value: (action.draft.endpoint === "grpc" ? parseGrpcUrl : parseGraphqlUrl)(action.draft.value) } };
      }
      if (action.action === "settings_back") { this.records.resetPreparation(operation, card); return; }
      const next = this.withoutPreparation(operation);
      if (action.action === "settings_select") {
        if (operation.fileId) this.invalidateFile(operation.fileId);
        delete next.fileId;
        delete next.preparation;
        next.draft = action.draft; next.phase = "draft";
      }
      this.records.write(operation, next, card);
    });
    await this.cleanupTemporaryFiles(stored.operationId);
  }
  private invalidateFile(id: string): void {
    const file = this.records.file(id);
    if (file?.role === "upload") this.records.writeFile({ ...file, invalidated: true, cleanup: "pending" });
  }
  private async prepare(expected: CardRecord, id: string): Promise<void> {
    const initial = this.records.requireInput(expected, id);
    const draft = initial.operation.draft;
    if (!draft) throw new SettingsConflict("Choose what you want to change in Settings first.");
    let preparation: Record<string, unknown>;
    if (draft.kind === "import_local_data") {
      await this.checkImport(expected, id);
      return;
    } else if (draft.kind === "restart_wallet_service") {
      const context = this.options.wallet.recoveryContext();
      this.assertRecoveryRecorded();
      const active = this.requireRestartPreparation(context);
      preparation = { walletRunId: context.availability.walletRunId, impact: context.impact,
        ...(active ? { supersedesOperationId: active.operationId } : {}) };
    } else if (draft.kind === "set_endpoint" || draft.kind === "restore_endpoint") {
      if (draft.kind === "set_endpoint") (draft.endpoint === "grpc" ? parseGrpcUrl : parseGraphqlUrl)(draft.value);
      const collected = this.fingerprint(initial.operation);
      const localSettings = (await this.options.readFacts()).localSettings;
      const current = draft.endpoint === "grpc" ? localSettings.suiGrpcUrl : localSettings.suiGraphqlUrl;
      preparation = { localSettings, endpoint: { endpoint: draft.endpoint, ...this.options.resolveEndpoint(draft),
        storedValue: current.storedValue, effectiveValue: current.effectiveValue, source: current.source } };
      if (collected !== this.fingerprint(initial.operation)) throw new SettingsConflict("The network setting changed while it was being checked. Review the change again.");
    } else preparation = { counts: this.options.localData.getDataCountsSync() };
    this.options.assertCurrent();
    let refused: SettingsConflict | undefined;
    this.records.transaction(() => {
      const decisionTime = this.now();
      if (draft.kind === "reset_local_data") preparation = { counts: this.options.localData.currentDataCountsSync(decisionTime) };
      let current: ReturnType<SqliteSettingsWorkflowStore["requireInput"]>;
      try { current = this.records.requireInput(expected, id, decisionTime); }
      catch (error) { if (!(error instanceof SettingsConflict)) throw error; refused = error; return; }
      const { card, operation } = current;
      const fingerprint = this.fingerprint(operation);
      this.records.write(operation, { ...operation, phase: "prepared", preparationId: randomUUID(), fingerprint,
        preparedUserDataRevision: this.records.control().user_data_revision, preparation,
        ...(draft.kind === "restart_wallet_service" ? { priorRunId: String(preparation.walletRunId) } : {}) }, card);
    });
    if (refused) throw refused;
  }
  private async beginUpload(expected: CardRecord, action: Extract<SettingsAction, { action: "settings_begin_upload" }>): Promise<void> {
    let file!: SettingsFile, createNeeded = false;
    this.records.transaction(() => {
      const { card, operation } = this.records.requireInput(expected, action.operationId);
      if (operation.draft?.kind !== "import_local_data") throw new SettingsConflict("This Settings selection does not accept a backup file.");
      const existing = operation.fileId && this.records.file(operation.fileId);
      if (!this.records.fileIOAvailable()) throw new SettingsConflict("Wait for the current file transfer.");
      if (existing && !existing.invalidated && existing.totalSize === action.totalSize && existing.sha256 === action.sha256) {
        file = existing;
        if (!existing.sealed && operation.phase !== "uploading") this.records.write(operation, { ...this.withoutPreparation(operation), phase: "uploading" }, card);
        return;
      }
      if (operation.fileId) this.invalidateFile(operation.fileId);
      const fileId = randomUUID();
      file = { fileId, operationId: operation.operationId, role: "upload", relativePath: `.settings-staging/${fileId}.upload`, displayName: action.name,
        totalSize: action.totalSize, receivedSize: 0, sha256: action.sha256, sealed: false, invalidated: false, cleanup: "pending" };
      this.records.createFile(file); this.records.reserveFileIO(fileId, operation.operationId);
      createNeeded = true;
      const next = this.withoutPreparation(operation);
      delete next.preparation;
      this.records.write(operation, { ...next, fileId, phase: "uploading" }, card);
    });
    if (!createNeeded) return;
    try { await this.options.files.createUpload(file); }
    catch (error) {
      this.options.assertCurrent();
      this.records.writeFile({ ...file, invalidated: true, cleanup: "failed" });
      throw error;
    } finally { this.finishFileIO(file.fileId); }
    await this.cleanupTemporaryFiles(action.operationId);
  }
  private async upload(expected: CardRecord, action: Extract<SettingsAction, { action: "settings_upload_chunk" }>): Promise<void> {
    const data = decodeSettingsChunk(action.chunkBase64);
    if (!data.length) throw new SettingsConflict("The file transfer contained no new file content.");
    let file!: SettingsFile, alreadyReceived = false;
    this.records.transaction(() => {
      const { operation } = this.records.requireInput(expected, action.operationId);
      const current = this.records.file(action.fileId);
      if (operation.phase !== "uploading" || operation.fileId !== action.fileId || !current || current.invalidated || current.sealed) throw new SettingsConflict("This file transfer is no longer available. Choose the backup file again.");
      const reservation = { offset: action.offset, length: data.length, sha256: settingsFileDigest(data) };
      if (action.offset + data.length <= current.receivedSize) { alreadyReceived = true; file = current; return; }
      if (action.offset !== current.receivedSize || action.offset + data.length > current.totalSize ||
          current.reservation && settingsIdentity(current.reservation) !== settingsIdentity(reservation)) throw new SettingsConflict("The next part of the file does not match the transfer already in progress. Choose the same backup file again.");
      file = { ...current, reservation };
      this.records.reserveFileIO(file.fileId, operation.operationId); this.records.writeFile(file);
    });
    if (alreadyReceived) { await this.options.files.verifyUploadPrefix(file, action.offset, data); return; }
    try {
      await this.options.files.writeReservedChunk(file, data); this.options.assertCurrent();
      this.records.transaction(() => {
        const { card, operation } = this.records.requireInput(expected, action.operationId);
        const current = this.records.file(file.fileId);
        if (!current || current.invalidated || settingsIdentity(current.reservation) !== settingsIdentity(file.reservation)) throw new SettingsConflict("The file transfer changed while its contents were being saved. Choose the same backup file again.");
        const { reservation: _reservation, ...complete } = current;
        this.records.writeFile({ ...complete, receivedSize: action.offset + data.length });
        this.records.write(operation, operation, card);
      });
    } finally { this.finishFileIO(file.fileId); }
  }
  private async seal(expected: CardRecord, action: Extract<SettingsAction, { action: "settings_seal_upload" }>): Promise<void> {
    const { operation } = this.records.requireInput(expected, action.operationId);
    if (operation.fileId !== action.fileId) throw new SettingsConflict("This file transfer is no longer available. Choose the backup file again.");
    await this.checkImport(expected, action.operationId);
  }
  private async checkImport(expected: CardRecord, id: string): Promise<void> {
    const initial = this.records.requireInput(expected, id);
    const file = initial.operation.fileId ? this.records.file(initial.operation.fileId) : undefined;
    if (initial.operation.draft?.kind !== "import_local_data" || !file || file.role !== "upload" || file.invalidated ||
        file.receivedSize !== file.totalSize || file.reservation) throw new SettingsConflict("Finish receiving the selected backup before checking it.");
    const rejection = retainedBackupRejection(initial.operation, file);
    if (rejection) throw new SettingsConflict(rejection.check.status === "cannot_restore" ? rejection.check.message : "Choose another backup file.");
    if (this.checkingFiles.has(file.fileId)) throw new SettingsConflict("This backup is already being checked.");
    const control = this.records.control();
    const binding = { fileId: file.fileId, sha256: file.sha256, totalSize: file.totalSize, dataEpoch: control.data_epoch, userDataRevision: control.user_data_revision };
    let checking!: CardRecord;
    this.records.transaction(() => {
      const { card, operation } = this.records.requireInput(expected, id);
      if (!this.records.fileIOAvailable()) throw new SettingsConflict("The last part of the file is still being saved. Wait for the transfer to finish.");
      this.records.write(operation, { ...this.withoutPreparation(operation), phase: file.sealed ? "sealed" : "uploading",
        preparation: { restoreCheck: { ...binding, check: { status: "checking" } } } }, card);
      checking = this.records.cards.get(card.state.cardId)!;
    });
    this.checkingFiles.add(file.fileId);
    let verified = false, input: unknown, failure: Extract<RestoreCheck, { status: "cannot_restore" | "check_required" }> | undefined;
    let unexpected: unknown;
    try {
      try {
        const bytes = await this.options.files.readUpload(file); verified = true;
        this.options.assertCurrent();
        input = this.parseBackupBytes(bytes);
      } catch (error) {
        this.options.assertCurrent();
        if (error instanceof LocalDataError && error.kind === "input_invalid") {
          const classified = settingsInputError(error, "import_local_data")!;
          failure = { status: "cannot_restore", reason: classified.restoreReason, message: classified.message };
        } else if (error instanceof SettingsConflict || error !== null && typeof error === "object" && "code" in error &&
            ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) {
          failure = { status: "cannot_restore", reason: "file_unavailable", message: "The received backup could not be verified. Choose the backup file again." };
        } else {
          failure = { status: "cannot_restore", reason: "check_failed", message: "The backup could not be checked. Try checking it again." };
          unexpected = error;
        }
      }
      this.records.transaction(() => {
        const decisionTime = this.now(), { card, operation } = this.records.requireInput(checking, id, decisionTime);
        const currentFile = this.records.file(file.fileId);
        if (operation.fileId !== file.fileId || !currentFile || currentFile.invalidated ||
            currentFile.sha256 !== file.sha256 || currentFile.totalSize !== file.totalSize || currentFile.reservation) {
          throw new SettingsConflict("The selected backup changed while it was being checked.");
        }
        if (verified) this.records.writeFile({ ...currentFile, sealed: true });
        let preparation: Record<string, unknown> | undefined;
        if (!failure && this.records.control().user_data_revision !== binding.userDataRevision) {
          failure = { status: "check_required", message: "Local data changed while the backup was being checked. Check this backup again." };
        }
        if (!failure) {
          try {
            const preview = this.options.localData.previewImportLocalDataSync(input, decisionTime);
            preparation = { preview };
            this.options.localData.assertReplacementAllowed(decisionTime);
            this.records.requireFinalSlot();
          } catch (error) {
            if (error instanceof LocalDataError && error.kind === "input_invalid") {
              const classified = settingsInputError(error, "import_local_data")!;
              failure = { status: "cannot_restore", reason: classified.restoreReason, message: classified.message };
            } else if (error instanceof SettingsConflict) {
              failure = { status: "cannot_restore", reason: "operation_busy", message: "Another Settings change or file transfer is in progress. Wait for it to finish before restoring." };
            } else {
              failure = { status: "cannot_restore", reason: "check_failed", message: "The backup could not be checked. Try checking it again." };
              unexpected = error;
            }
          }
        }
        const current = this.records.get(id)!;
        const check: RestoreCheck = failure ?? { status: "can_restore" };
        const recorded = { ...binding, userDataRevision: this.records.control().user_data_revision, check };
        this.records.write(current, failure
          ? { ...this.withoutPreparation(current), phase: verified ? "sealed" : "uploading", preparation: { ...preparation, restoreCheck: recorded } }
          : { ...current, phase: "prepared", preparationId: randomUUID(), fingerprint: this.fingerprint(current),
              preparedUserDataRevision: this.records.control().user_data_revision, preparation: { ...preparation, restoreCheck: recorded } }, card);
      });
      if (unexpected) throw unexpected;
    } finally { this.checkingFiles.delete(file.fileId); }
  }
  private async confirm(expected: CardRecord, action: Extract<SettingsAction, { action: "settings_confirm" }>): Promise<void> {
    const initial = this.records.requireInput(expected, action.operationId), draft = initial.operation.draft;
    if (!draft || initial.operation.preparationId !== action.preparationId) throw new SettingsConflict("Review the current Settings change before confirming it.");
    if (draft.kind === "restart_wallet_service") { this.restart(expected, action); return; }
    let endpoint: EndpointChange | undefined;
    let imported: Awaited<ReturnType<SqliteLocalDataService["parseAndVerifyImportEnvelope"]>> | undefined;
    if (draft.kind === "set_endpoint" || draft.kind === "restore_endpoint") {
      endpoint = await this.options.verifyEndpoint(draft);
      const prepared = endpointPreparationSchema.parse(initial.operation.preparation?.endpoint);
      if (!prepared || prepared.endpoint !== draft.endpoint || prepared.key !== endpoint.key || prepared.value !== endpoint.value) {
        throw new SettingsConflict("The selected network address changed. Review it again before confirming.");
      }
    }
    if (draft.kind === "import_local_data") {
      const file = initial.operation.fileId && this.records.file(initial.operation.fileId);
      if (!file || !this.records.hasReusableUpload(initial.operation.operationId)) throw new SettingsConflict("The selected backup is no longer available. Choose the backup file again.");
      const rejection = retainedBackupRejection(initial.operation, file);
      if (rejection) throw new SettingsConflict(rejection.check.status === "cannot_restore" ? rejection.check.message : "Choose another backup file.");
      try {
        imported = await this.options.localData.parseAndVerifyImportEnvelope(await this.backupInput(file));
      } catch (error) {
        this.options.assertCurrent();
        // A rejected final verification does not apply data or end the card,
        // but it must revoke the previous ready result for this exact file.
        this.records.transaction(() => {
          const { card, operation } = this.records.requireInput(expected, action.operationId);
          if (operation.fileId !== file.fileId) throw new SettingsConflict("The selected backup changed before its check result could be saved.");
          const physical = error instanceof SettingsConflict || error !== null && typeof error === "object" && "code" in error &&
            ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code));
          const control = this.records.control();
          const classified = settingsInputError(error, "import_local_data");
          const check: RestoreCheck = { status: "cannot_restore", reason: physical ? "file_unavailable" : classified?.restoreReason ?? "check_failed",
            message: physical ? "The received backup could not be verified. Choose the backup file again."
              : classified?.message ?? "The backup could not be verified for restoration. Check its availability and try again." };
          this.records.write(operation, { ...this.withoutPreparation(operation), phase: "sealed",
            preparation: { restoreCheck: { fileId: file.fileId, sha256: file.sha256, totalSize: file.totalSize, dataEpoch: control.data_epoch,
              userDataRevision: control.user_data_revision, check } } }, card);
        });
        throw error;
      }
    }
    this.options.assertCurrent();
    let exported: { file: SettingsFile; data: Buffer } | undefined;
    const replacement = draft.kind === "reset_local_data" || draft.kind === "import_local_data";
    let refused: SettingsConflict | undefined;
    this.records.transaction(() => {
      const decisionTime = this.now();
      const fingerprint = () => this.fingerprint(this.records.get(action.operationId)!);
      if (replacement) {
        this.options.localData.currentDataCountsSync(decisionTime);
        try { this.records.requireAdmission(expected, action, fingerprint, undefined, decisionTime); }
        catch (error) { if (!(error instanceof SettingsConflict)) throw error; refused = error; return; }
      }
      const operation = this.records.admit(expected, action, fingerprint, undefined, decisionTime);
      let details: Record<string, unknown> = {};
      if (endpoint) {
        const previous = this.options.preferences.getLocalSettingSync(endpoint.key);
        this.options.preferences.setLocalSettingSync(endpoint.key, endpoint.value, this.now());
        const prepared = endpointPreparationSchema.parse(operation.preparation!.endpoint);
        details = { status: endpoint.status, storedValue: endpoint.value, previousStoredValue: previous?.value,
          endpoint: draft.kind === "set_endpoint" || draft.kind === "restore_endpoint" ? draft.endpoint : undefined,
          effectiveValueAtSave: prepared.effectiveValue, effectiveSourceAtSave: prepared.source,
          appliesAfter: SETTINGS_APPLIES_AFTER_RESTART };
      } else if (draft.kind === "clear_read_address") this.options.activity.clearActiveAccountSync(this.now());
      else if (replacement) details = this.options.localData.applyValidatedReplacement(imported, decisionTime, expected.state.cardId);
      else if (draft.kind === "export_local_data") {
        const data = Buffer.from(JSON.stringify(this.options.localData.exportLocalDataSync(this.now())), "utf8"), fileId = randomUUID();
        const file: SettingsFile = { fileId, operationId: operation.operationId, role: "export", relativePath: `backups/${operation.operationId}.json`,
          displayName: `${operation.operationId}.json`, totalSize: data.length, receivedSize: 0, sha256: settingsFileDigest(data), sealed: false, invalidated: false, cleanup: "pending" };
        this.records.createFile(file); this.records.reserveFileIO(fileId, operation.operationId);
        const card = this.records.cards.get(operation.cardId)!;
        this.records.write(operation, { ...operation, fileId }, card); exported = { file, data }; return;
      }
      this.records.finish(operation.operationId, { outcome: "completed", recordedAt: this.now().toISOString(),
        message: endpoint ? "The network address was saved. This result describes the settings at save time."
          : draft.kind === "clear_read_address" ? "The default address for viewing assets was cleared. Your wallet connection and transaction requests are unchanged."
          : draft.kind === "import_local_data" ? "Local records were replaced. Restart the apps using Sui MCP before continuing."
          : "Local data was reset. This does not cancel a transaction on Sui or disconnect your wallet app.", details });
    });
    if (refused) throw refused;
    if (replacement) this.options.localData.notifyDataReplaced();
    if (exported) {
      const value = exported;
      void this.export(value.file, value.data).catch(() => {});
    } else await this.cleanupTemporaryFiles(action.operationId);
  }
  private async export(file: SettingsFile, data: Buffer): Promise<void> {
    let result: SettingsResult;
    try {
      const path = await this.options.files.publishExport(file, data); this.options.assertCurrent();
      result = { outcome: "completed", recordedAt: this.now().toISOString(), message: "The local backup file was created.",
        details: { path, filename: file.displayName, fileId: file.fileId, sha256: file.sha256, totalSize: file.totalSize } };
    } catch {
      this.options.assertCurrent();
      result = { outcome: "failed", recordedAt: this.now().toISOString(), message: "The backup could not be confirmed. This request will not create another file." };
    }
    this.finishedFileIO.add(file.fileId);
    this.retainResult(file.operationId, result, false, result.outcome === "completed" ? { ...file, receivedSize: file.totalSize, sealed: true } : undefined);
    await this.cleanupFile(file);
  }
  private restart(expected: CardRecord, action: Extract<SettingsAction, { action: "settings_confirm" }>): void {
    this.options.wallet.recoveryContext();
    this.assertRecoveryRecorded();
    let admitted!: SettingsOperation;
    try {
      this.records.transaction(() => {
        const preparation = this.records.get(action.operationId)?.preparation;
        const supersedes = typeof preparation?.supersedesOperationId === "string" ? preparation.supersedesOperationId : undefined;
        admitted = this.records.admit(expected, action, () => this.fingerprint(this.records.get(action.operationId)!), supersedes);
        if (!admitted.priorRunId) throw new SettingsConflict("The wallet connection service changed. Check status before continuing.");
        if (supersedes) {
          const previous = this.requireSupersedable(supersedes, admitted.priorRunId);
          const previousCard = this.records.cards.get(previous.cardId)!;
          this.records.write(previous, { ...previous, phase: "terminal", supersededByOperationId: admitted.operationId,
            result: { outcome: "superseded", recordedAt: this.now().toISOString(), message: "A restart confirmed in another Settings card replaced this service startup." } }, previousCard,
            { ...previousCard, state: { ...previousCard.state, state: "closed", reason: "cancelled", revision: previousCard.state.revision + 1 } });
          const card = this.records.cards.get(admitted.cardId)!;
          this.records.write(admitted, { ...admitted, supersedesOperationId: supersedes }, card); admitted = this.records.get(admitted.operationId)!;
        }
        this.options.interruptRun(admitted.priorRunId!);
        this.records.db.prepare("UPDATE settings_control SET wallet_input_blocked=1,wallet_block_operation_id=? WHERE id=1").run(admitted.operationId);
      });
    } catch (error) {
      if (!(error instanceof SettingsConflict)) this.options.wallet.blockSettingsAdmissionFailure();
      throw error;
    }
    this.options.wallet.fenceForSettings(admitted.priorRunId!);
    void this.options.wallet.replaceForSettings(admitted.priorRunId!, (nextRunId) => {
      this.records.transaction(() => {
        const operation = this.records.get(admitted.operationId), control = this.records.control();
        if (!operation || operation.phase !== "stopping" || operation.dataEpoch !== control.data_epoch || control.active_operation_id !== operation.operationId) throw new SettingsConflict("This restart is no longer current.");
        const card = this.records.cards.get(operation.cardId)!;
        this.records.write(operation, { ...operation, phase: "starting", nextRunId }, card);
      });
    }).catch(() => {
      this.options.assertCurrent();
      this.retainResult(admitted.operationId, { outcome: "failed", recordedAt: this.now().toISOString(), message: "The wallet connection service restart could not be confirmed. Open a new Settings card if you want to try restarting again." }, false);
    }).catch(() => {});
  }
  private runtimeEvent(event: WalletRuntimeEvent): void {
    const id = this.records.control().active_operation_id, operation = id && this.records.get(id);
    if (!operation || operation.phase !== "starting" || operation.nextRunId !== event.runId) return;
    if (event.type !== "lost" && !(event.type === "snapshot" && event.ready)) return;
    const ready = event.type === "snapshot";
    if (!ready && this.pendingResults.get(operation.operationId)?.ready) this.pendingResults.delete(operation.operationId);
    const existing = this.pendingResults.get(operation.operationId);
    const result = existing?.result ?? { outcome: ready ? "completed" : "failed", recordedAt: this.now().toISOString(),
      message: ready ? "The connection service restarted. Check the original request's result separately."
        : "The wallet connection service could not start. Open a new Settings card if you want to try restarting again.",
      details: { priorRunId: operation.priorRunId, nextRunId: operation.nextRunId } } as SettingsResult;
    if (existing && !existing.ready && ready) throw new SettingsConflict("The startup failure could not yet be saved. Check status before continuing.");
    this.retainResult(operation.operationId, result, ready);
  }
  private retainResult(id: string, result: SettingsResult, ready: boolean, file?: SettingsFile): void {
    if (!this.pendingResults.has(id)) this.pendingResults.set(id, { result, ready, ...(file ? { file } : {}) });
    const retained = this.pendingResults.get(id)!;
    let settledFileId: string | undefined;
    const applied = this.records.transaction(() => {
      if (retained.file) this.records.writeFile(retained.file);
      const fileId = retained.file?.fileId ?? this.records.get(id)?.fileId;
      if (fileId && this.finishedFileIO.has(fileId)) {
        this.records.releaseFileIO(fileId); settledFileId = fileId;
      }
      return this.records.finish(id, retained.result);
    });
    // A later cleanup can reserve this same file. The ended publication must
    // not be reused as evidence that this new I/O has also ended.
    if (settledFileId) this.finishedFileIO.delete(settledFileId);
    if (applied && !ready) this.pendingResults.delete(id);
  }
  private readyPublished(runId: string): void {
    for (const [id, pending] of this.pendingResults) {
      if (pending.ready && this.records.get(id)?.nextRunId === runId &&
          this.records.get(id)?.result?.outcome === "completed") this.pendingResults.delete(id);
    }
  }
  private assertRecoveryRecorded(): void {
    for (const id of this.pendingResults.keys()) {
      if (this.records.get(id)?.draft?.kind === "restart_wallet_service") throw new Error("The connection-service result could not be saved. Use Check status to save that result before trying another restart.");
    }
  }
  private finishFileIO(fileId: string): void {
    this.options.assertCurrent(); this.finishedFileIO.add(fileId);
    this.records.releaseFileIO(fileId); this.finishedFileIO.delete(fileId);
  }
  synchronize(operationId?: string, recoveryOnly = false): void {
    this.options.assertCurrent();
    if (!recoveryOnly) for (const id of this.finishedFileIO) {
      const file = this.records.file(id);
      if (operationId !== undefined && (file?.cleanupOperationId ?? file?.operationId) !== operationId) continue;
      this.records.releaseFileIO(id); this.finishedFileIO.delete(id);
    }
    for (const [id, pending] of this.pendingResults) {
      if (operationId !== undefined && id !== operationId || recoveryOnly && this.records.get(id)?.draft?.kind !== "restart_wallet_service") continue;
      // Ready is replayed only inside the SDK snapshot transaction; a previous
      // failed transaction did not prove that its observation was committed.
      if (!pending.ready) this.retainResult(id, pending.result, false, pending.file);
    }
  }
  private async cleanupFile(file: SettingsFile): Promise<void> {
    this.records.transaction(() => this.records.reserveFileIO(file.fileId, file.cleanupOperationId ?? file.operationId));
    try { await this.options.files.cleanup(file); this.options.assertCurrent(); this.records.writeFile({ ...this.records.file(file.fileId)!, cleanup: "complete" }); }
    catch { this.options.assertCurrent(); const current = this.records.file(file.fileId); if (current) this.records.writeFile({ ...current, cleanup: "failed" }); throw new Error("The local data change was saved, but temporary files could not be removed."); }
    finally { this.finishFileIO(file.fileId); }
  }
  private async cleanupTemporaryFiles(operationId?: string): Promise<void> {
    const files = operationId === undefined
      ? (this.records.db.prepare(`SELECT file_id FROM settings_files WHERE cleanup!='complete' AND (invalidated=1 OR role='export')`)
        .all() as { file_id: string }[]).map((row) => this.records.file(row.file_id)!)
      : this.records.filesNeedingCleanup(operationId);
    for (const file of files) {
      try { await this.cleanupFile(file); }
      catch (error) { if (!(error instanceof SettingsConflict)) throw error; }
    }
  }
}
