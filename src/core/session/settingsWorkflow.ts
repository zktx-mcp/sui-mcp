import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { TextDecoder, isDeepStrictEqual } from "node:util";
import type { SqliteActivityStore } from "../activity/sqliteActivityStore.js";
import type { SqliteLocalDataService } from "../activity/localDataService.js";
import { LocalDataError } from "../activity/localDataTypes.js";
import { settingsInputError, SETTINGS_REPLACEMENT_BLOCKED_MESSAGE } from "./settingsInputError.js";
import type { SqlitePreferencesRepository } from "../preferences/sqlitePreferencesRepository.js";
import { SETTINGS_APPLIES_AFTER_RESTART } from "../preferences/preferencesStore.js";
import { parseGraphqlUrl, parseGrpcUrl } from "../suiEndpoint.js";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import type { CardRecord } from "./cardSession.js";
import { DEFAULT_SESSION_TTL_MS } from "./localSession.js";
import { isSettingsDownloadFile, settingsDownloadPath } from "./settingsFileIdentity.js";
import { SettingsFileStore, SettingsDownloadPathExists, settingsFileDigest, decodeSettingsChunk } from "./settingsFileStore.js";
import { SqliteSettingsWorkflowStore, settingsIdentity } from "./sqliteSettingsWorkflowStore.js";
import { SettingsConflict, settingsCardInputSchema, settingsDownload, isSettingsDownloadFileAction, type SettingsDownloadFileAction, settingsViewSchema, endpointPreparationSchema, storedRestoreCheckSchema, retainedBackupRejection, permitsBackupRecheck, type RestoreCheck, type SettingsAction, type SettingsDraft, type SettingsFile, type SettingsOperation, type SettingsResult, type SettingsView } from "./settingsOperation.js";
import type { WalletWorkflow } from "./walletWorkflow.js";
import type { WalletRuntimeEvent } from "./walletRuntime.js";
import type { SettingsLocalSaveOutcome } from "./settingsOperation.js";

// One existing product-session length from physical snapshot readiness.
export const DOWNLOAD_RETRY_WINDOW_MS = DEFAULT_SESSION_TTL_MS;
type EndpointChange = { key: "suiGrpcUrl" | "suiGraphqlUrl"; value: string; status: "saved" | "reset" };
export class SettingsWorkflow {
  private readonly pendingResults = new Map<string, { result: SettingsResult; ready: boolean; file?: SettingsFile; downloadReadyAt?: string }>();
  private readonly finishedFileIO = new Set<string>();
  // This tracks actual pending I/O only; SQLite owns check results and permission.
  private readonly checkingFiles = new Set<string>();
  private downloadTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private readonly downloadIO = new Map<string, Set<Promise<unknown>>>();
  private readonly downloadTasks = new Set<Promise<void>>();
  private readonly localSaveTasks = new Map<string, Promise<void>>();
  private readonly localSaveResults = new Map<string, { saveAttemptId: string; outcome: SettingsLocalSaveOutcome }>();
  constructor(private readonly options: {
    records: SqliteSettingsWorkflowStore; files: SettingsFileStore; activity: SqliteActivityStore;
    localData: SqliteLocalDataService; preferences: SqlitePreferencesRepository; wallet: WalletWorkflow;
    readFacts(): Promise<NonNullable<SettingsView["facts"]>>;
    resolveEndpoint(input: Extract<SettingsDraft, { kind: "set_endpoint" | "restore_endpoint" }>): EndpointChange;
    verifyEndpoint(input: Extract<SettingsDraft, { kind: "set_endpoint" | "restore_endpoint" }>): Promise<EndpointChange>;
    assertCurrent(): void;
    runMaintenance?<T>(work: () => Promise<T>): Promise<T>;
    interruptRun(runId: string): void;
  }) {
    options.wallet.attachSettingsRecovery({ synchronize: () => this.synchronize(undefined, true),
      runtimeEvent: (event) => this.runtimeEvent(event), readyPublished: (runId) => this.readyPublished(runId) });
  }
  private get records() { this.options.assertCurrent(); return this.options.records; }
  async create(record: CardRecord): Promise<void> {
    const input = settingsCardInputSchema.parse(record.state.input);
    if (!input.operationStatus) { this.records.create(record); return; }
    const operation = this.records.get(input.operationStatus.operationId);
    if (!operation || operation.dataEpoch !== this.records.control().data_epoch) {
      throw new SettingsConflict("This Settings request is not available in the current profile and server run.");
    }
    const original = this.records.cards.get(operation.cardId);
    if (!original) throw new SettingsConflict("This Settings request is unavailable.");
    const download = settingsDownload(operation);
    const targetId = download?.localSave?.attempts.find((a) => a.saveAttemptId === download.localSave?.currentSaveAttemptId)?.cardId ??
      download?.attempts.find((a) => a.attemptId === download.currentAttemptId)?.cardId;
    const target = targetId ? this.records.cards.get(targetId) ?? original : original;
    const current = await this.describe(target, true);
    const { restoreCheck: _restoreCheck, ...status } = current.data;

    const data = { ...status, allowedActions: [], observe: false,
      ...(current.data.download ? { download: { ...current.data.download, allowedFileActions: [] } } : {}) };
    // A status card is a recorded read, never a new Settings operation or input permission.
    this.records.cards.create({ ...record, state: { ...record.state, state: "closed", reason: "completed", data } });
  }
  operationKind(record: CardRecord): SettingsDraft["kind"] | undefined { return this.records.forCard(record).draft?.kind; }
  recoverOwner(): void {
    // Invalidate old input synchronously. Verifying a prior backup and removing
    // temporary files must not delay unrelated MCP startup or completed reads.
    this.records.transaction(() => {
      const downloads = this.records.db.prepare("SELECT operation_id FROM settings_operations WHERE kind='download_backup' AND owner_id!=?")
        .all(this.records.ownerId) as { operation_id: string }[];
      for (const row of downloads) {
        const operation = this.records.get(row.operation_id)!;
        if (settingsDownload(operation)?.localSave?.status === "saving") {
          // Inherit settlement, never the departed card's input permission.
          // Keep its final/file reservation until the existing artifact is checked.
          this.records.db.prepare("UPDATE settings_operations SET owner_id=? WHERE operation_id=?").run(this.records.ownerId, operation.operationId);

        } else this.records.endDownload(row.operation_id, "server_restarted");
      }
      const rows = this.records.db.prepare("SELECT operation_id FROM settings_operations WHERE owner_id!=? AND phase!='terminal'")
        .all(this.records.ownerId) as { operation_id: string }[];
      for (const row of rows) {
        const operation = this.records.get(row.operation_id)!;
        const file = operation.fileId ? this.records.file(operation.fileId) : undefined;
        const card = this.records.cards.get(operation.cardId);
        if (!card) continue;
        const result: SettingsResult = { outcome: "interrupted", recordedAt: this.now().toISOString(),
          message: operation.admittedAt
            ? "Sui MCP restarted before this confirmed change finished. It will not be repeated. Check the result of the original request separately."
            : "Sui MCP restarted before you confirmed this change. It will not be repeated." };
        this.records.db.prepare(`UPDATE settings_operations SET owner_id=?,phase='terminal',result_json=? WHERE operation_id=?`)
          .run(this.records.ownerId, JSON.stringify(result), operation.operationId);
        const reason = card.state.reason ?? (card.state.state === "ready" && Date.parse(card.state.expiresAt) <= this.now().getTime() ? "expired" : "server_restarted");
        this.records.invalidateUpload(operation);
        if (card.state.state !== "closed" && !this.records.cards.replace(card, { ...card, ownerId: this.records.ownerId,
          state: { ...card.state, state: "closed", reason, revision: card.state.revision + 1,
            data: this.records.resultView(operation, result) } }, this.now())) {
          throw new SettingsConflict("The interrupted Settings card changed while its status was being updated.");
        }
        this.records.db.prepare(`UPDATE settings_control SET active_operation_id=NULL,wallet_input_blocked=0,wallet_block_operation_id=NULL
          WHERE id=1 AND active_operation_id=?`).run(operation.operationId);
        if (file) this.records.releaseFileIO(file.fileId);
      }
      // Every purpose card loses input when its owner ends, including an
      // unadmitted redelivery and a save still owned by its domain journal.
      const pendingCards = this.records.db.prepare("SELECT id FROM live_read_cards WHERE kind='settings' AND state!='closed' AND owner_id!=?")
        .all(this.records.ownerId) as { id: string }[];
      for (const { id } of pendingCards) {
        const card = this.records.cards.get(id)!, operation = this.records.get(card.operationId!);
        if (!operation) throw new SettingsConflict("The interrupted Settings operation is unavailable.");
        const result: SettingsResult = { outcome: "interrupted", recordedAt: this.now().toISOString(),
          message: "This card ended when the server restarted. Check the original operation's current result in a new status card; no effect will be repeated." };
        if (!this.records.cards.replace(card, { ...card, ownerId: this.records.ownerId,
          state: { ...card.state, state: "closed", reason: "server_restarted", revision: card.state.revision + 1,
            data: this.records.resultView(operation, result) } }, this.now())) throw new SettingsConflict("The interrupted Settings card changed during recovery.");
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
  async cleanupAfterOwnerChange(): Promise<void> {
    for (const operation of this.records.downloads()) this.observeLocalSave(operation);
    await Promise.allSettled([...this.localSaveTasks.values()]);
    await this.maintainDownloads();
  }
  private maintenance<T>(work: () => Promise<T>): Promise<T> {
    return this.options.runMaintenance ? this.options.runMaintenance(work) : work();
  }
  private async trackDownloadIO<T>(fileId: string, work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(work), active = this.downloadIO.get(fileId) ?? new Set<Promise<unknown>>();
    active.add(task); this.downloadIO.set(fileId, active);
    try { return await task; }
    finally { active.delete(task); if (!active.size) this.downloadIO.delete(fileId); }
  }
  private scheduleDownloadExpiry(skipElapsed = false): void {
    if (this.downloadTimer !== undefined) clearTimeout(this.downloadTimer);
    this.downloadTimer = undefined;
    if (this.closing) return;
    const deadlines = this.records.downloads().flatMap((operation) => {
      const download = settingsDownload(operation)!;
      return !download.endReason && download.localSave?.status !== "saving" && download.expiresAt && (!skipElapsed || Date.parse(download.expiresAt) > this.now().getTime()) ? [Date.parse(download.expiresAt)] : [];
    });
    if (!deadlines.length) return;
    this.downloadTimer = setTimeout(() => {
      this.downloadTimer = undefined;
      void this.maintenance(() => this.maintainDownloads()).catch(() => {
        // Durable cleanup remains pending/failed; a same-operation read or
        // startup can retry. Never spin on an already elapsed deadline.
      });
    }, Math.max(0, Math.min(...deadlines) - this.now().getTime()));
    this.downloadTimer.unref?.();
  }
  async maintainDownloads(): Promise<void> {
    this.options.assertCurrent();
    let failure: unknown;
    try { this.records.expireDownloads(); } catch (error) { this.options.assertCurrent(); failure = error; }
    try { await this.cleanupTemporaryFiles(); } catch (error) { this.options.assertCurrent(); failure ??= error; }
    // A failed, already-due journal stays retryable through Check status/startup;
    // it cannot spin at zero delay or cancel another snapshot's future deadline.
    this.scheduleDownloadExpiry(failure !== undefined);
    if (failure) throw failure;
  }
  dataReplaced(): void {
    // The replacement action owns and awaits its transferred cleanup journal.
    // Starting another cleanup here would race its I/O reservation and return
    // before the action's required cleanup result is known.
    this.scheduleDownloadExpiry();
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.downloadTimer !== undefined) clearTimeout(this.downloadTimer);
    this.downloadTimer = undefined;
    await Promise.allSettled([...this.downloadTasks, ...[...this.downloadIO.values()].flatMap((tasks) => [...tasks])]);
    await this.maintenance(async () => {
      for (const operation of this.records.downloads()) this.observeLocalSave(operation);
      await Promise.allSettled([...this.localSaveTasks.values()]);
      this.records.transaction(() => { for (const operation of this.records.downloads()) this.records.endDownload(operation.operationId, "server_restarted"); });
      await this.cleanupTemporaryFiles();
    });
  }
  async readFile(record: CardRecord, fileId: string, offset: number, limit: number, attemptId?: string): Promise<{ file: SettingsFile; offset: number; chunkBase64: string }> {
    const operation = this.records.forCard(record);
    if (operation.draft?.kind === "download_backup") {
      if (this.closing) throw new SettingsConflict("This server is closing; the download cannot continue.");
      this.records.expireDownloads(operation.operationId);
      const checked = this.records.requireDownloadRead(record, fileId, attemptId), length = Math.min(limit, checked.file.totalSize - offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 1) throw new SettingsConflict("This part of the backup is unavailable.");
      let data: Buffer;
      try { data = await this.trackDownloadIO(fileId, () => this.options.files.readDownloadRange(checked.file, offset, length)); }
      catch {
        this.options.assertCurrent();
        this.records.transaction(() => this.records.endDownload(operation.operationId, "source_unavailable"));
        await this.cleanupTemporaryFiles(operation.operationId); this.scheduleDownloadExpiry();
        throw new SettingsConflict("The download snapshot could not be read or verified.");
      }
      this.options.assertCurrent();
      try {
        this.records.expireDownloads(operation.operationId);
        this.records.requireDownloadRead(record, fileId, attemptId);
        return { file: checked.file, offset, chunkBase64: data.toString("base64") };
      } finally {
        // A read may have been the last physical I/O keeping an ended snapshot
        // alive. Settle its own journal; a saved-result read need not await it.
        await this.cleanupTemporaryFiles(operation.operationId);
      }
    }
    throw new SettingsConflict("This Settings request does not provide a download.");
  }
  private async startDownload(expected: CardRecord, input: Extract<SettingsAction, { action: "settings_download_backup" }>): Promise<void> {
    let bytes!: Buffer;
    const file = this.records.admitDownload(expected, input, (operation) => {
      bytes = Buffer.from(JSON.stringify(this.options.localData.exportLocalDataSync(this.now())), "utf8");
      const fileId = randomUUID();
      return { fileId, operationId: operation.operationId, role: "export", relativePath: settingsDownloadPath(fileId),
        displayName: `${operation.operationId}.json`, totalSize: bytes.length, receivedSize: 0, sha256: settingsFileDigest(bytes),
        sealed: false, invalidated: false, cleanup: "pending" };
    });
    const task = this.writeDownload(file, bytes);
    this.downloadTasks.add(task);
    void task.catch(() => {}).finally(() => this.downloadTasks.delete(task));
  }
  private async writeDownload(file: SettingsFile, data: Buffer): Promise<void> {
    let result: SettingsResult, readyAt: string | undefined;
    try {
      await this.trackDownloadIO(file.fileId, () => this.options.files.createDownload(file, data)); this.options.assertCurrent();
      readyAt = this.now().toISOString();
      result = { outcome: "completed", completionScope: "backup_delivery", recordedAt: readyAt,
        message: "The backup is ready for download. This does not confirm that a file was saved.",
        details: { filename: file.displayName, fileId: file.fileId, sha256: file.sha256, totalSize: file.totalSize } };
    } catch (error) {
      this.options.assertCurrent();
      if (error instanceof SettingsDownloadPathExists) this.records.transaction(() => {
        this.records.endDownload(file.operationId, "source_unavailable");
        const existing = this.records.file(file.fileId)!;
        // An exclusive-create collision never made this request the physical
        // file's owner. Do not delete that pre-existing item as cleanup.
        this.records.writeFile({ ...existing, invalidated: true, cleanup: "complete" });
      });
      result = { outcome: "failed", completionScope: "backup_delivery", recordedAt: this.now().toISOString(),
        message: "The backup could not be prepared. Open a new Settings card to try again." };
    }
    this.finishedFileIO.add(file.fileId);
    this.retainResult(file.operationId, result, false, result.outcome === "completed" ? { ...file, sealed: true, receivedSize: file.totalSize } : undefined, readyAt);
    this.scheduleDownloadExpiry(); await this.cleanupTemporaryFiles(file.operationId);
  }
  async continueDownload(record: CardRecord, action: SettingsDownloadFileAction): Promise<void> {
    const file = this.records.continueDownload(record, action);
    if (file) this.runLocalSave(file, true);
    this.scheduleDownloadExpiry(); await this.cleanupTemporaryFiles(action.operationId);
  }
  private observeLocalSave(operation: SettingsOperation): void {
    if (operation.ownerId !== this.records.ownerId || operation.dataEpoch !== this.records.control().data_epoch ||
        settingsDownload(operation)?.localSave?.status !== "saving" || this.localSaveTasks.has(operation.operationId)) return;
    const file = operation.fileId && this.records.file(operation.fileId);
    if (file) this.runLocalSave(file, false);
  }
  private runLocalSave(file: SettingsFile, publish: boolean): void {
    if (this.localSaveTasks.has(file.operationId)) return;
    const task = this.settleLocalSave(file, publish);
    this.localSaveTasks.set(file.operationId, task); this.downloadTasks.add(task);
    void task.catch(() => {}).finally(() => {
      this.localSaveTasks.delete(file.operationId); this.downloadTasks.delete(task);
    });
  }
  private async settleLocalSave(file: SettingsFile, publish: boolean): Promise<void> {
    const operation = this.records.get(file.operationId)!, saved = settingsDownload(operation)?.localSave;
    if (saved?.status !== "saving" || !saved.currentSaveAttemptId) return;
    const saveAttemptId = saved.currentSaveAttemptId;
    this.records.localSaveContext(file.operationId, saveAttemptId);
    let retained = this.localSaveResults.get(file.operationId);
    if (!retained) {
      const outcome = await this.trackDownloadIO(file.fileId, async () => {
        if (publish) {
          try {
            return await this.options.files.publishDownload(file, (identity) => {
              this.options.assertCurrent(); this.records.rememberLocalSaveSource(file.operationId, saveAttemptId, identity);
            });
          } catch { this.options.assertCurrent(); }
        }
        const current = this.records.localSaveContext(file.operationId, saveAttemptId);
        return this.options.files.inspectDownloadPublication(file, current.save.sourceIdentity);
      });
      this.options.assertCurrent();
      retained = { saveAttemptId, outcome }; this.localSaveResults.set(file.operationId, retained);
    }
    // Retain the ended physical outcome if the DB write fails. A read retries
    // this same settlement, not link(), a new snapshot, or a Host request.
    const path = retained.outcome.status === "saved" ? this.options.files.localBackupPath(file) : undefined;
    this.records.settleLocalSave(file.operationId, retained.saveAttemptId, retained.outcome,
      path ? { directory: dirname(path), filename: basename(path) } : undefined);
    this.localSaveResults.delete(file.operationId);
    this.scheduleDownloadExpiry(); await this.cleanupTemporaryFiles(file.operationId);
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
    if (draft.kind === "set_wallet_networks") return settingsIdentity({ ...common,
      current: this.options.preferences.getLocalSettingSync("walletConnectionChains") });
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
    if (["set_wallet_networks", "clear_read_address", "download_backup"].includes(operation.draft?.kind ?? "")) throw new SettingsConflict("This action is applied by its explicit save or download request.");
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
  private expireInput(record: CardRecord): CardRecord {
    if (record.state.state !== "ready" || Date.parse(record.state.expiresAt) > this.now().getTime()) return record;
    const operation = this.records.forCard(record);
    const result: SettingsResult = { outcome: "interrupted", recordedAt: this.now().toISOString(),
      message: record.state.input.backupDelivery ? "This delivery card expired. Ask in chat for a new delivery card if the backup is still available."
        : "The time to confirm this Settings change has ended." };
    if (record.state.input.backupDelivery) {
      if (!this.records.cards.replace(record, { ...record, state: { ...record.state, state: "closed", reason: "expired",
        revision: record.state.revision + 1, data: this.records.resultView(operation, result) } }, this.now())) throw new SettingsConflict("This delivery card changed before it could expire.");
    } else this.records.finish(operation.operationId, result, undefined, "expired");
    return this.records.cards.get(record.state.cardId)!;
  }
  async describe(record: CardRecord, currentOperation = false): Promise<{ record: CardRecord; data: SettingsView }> {
    this.options.assertCurrent();
    record = this.expireInput(record);
    let operation = this.records.forCard(record);
    this.observeLocalSave(operation);
    let downloadExpiryPending = false;
    if (operation.result) {
      // The result is already committed. A failed release of known-ended I/O
      // must remain retryable without making that result depend on the write.
      try { this.synchronize(operation.operationId); }
      catch { this.options.assertCurrent(); }
    }
    if (operation.result === undefined) {
      this.synchronize(operation.operationId);
      operation = this.records.get(operation.operationId)!;
      if (operation.draft?.kind === "restart_wallet_service" && operation.admittedAt) {
        this.options.wallet.recoveryContext();
        this.assertRecoveryRecorded();
      }
      this.records.transaction(() => {
        record = this.expireInput(record);
        if (!record.state.input.backupDelivery && record.state.state === "closed" && record.state.reason === "expired") {
          this.records.finish(operation.operationId, { outcome: "interrupted", recordedAt: this.now().toISOString(), message: "The time to confirm this Settings change has ended." });
        }
      });
      operation = this.records.get(operation.operationId)!;
    }
    try { this.records.expireDownloads(operation.operationId); }
    catch (error) {
      this.options.assertCurrent();
      if (!operation.result && !settingsDownload(operation)?.readyAt) throw error;
      downloadExpiryPending = true;
    }
    operation = this.records.get(operation.operationId)!;
    if (operation.result) {
      for (const file of this.records.filesNeedingCleanup(operation.operationId)) {
        await this.cleanupFile(file, false).catch(() => { this.options.assertCurrent(); });
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
    if (!record.state.input.backupDelivery && record.state.state === "ready" && record.ownerId === this.records.ownerId && operation.dataEpoch === this.records.control().data_epoch && !operation.result) {
      const fileIOAvailable = this.records.fileIOAvailable();
      if (fileIOAvailable) {
        allowed.push("settings_select", "settings_cancel");
        if (this.records.control().active_operation_id === null) allowed.push("settings_download_backup", "settings_save_wallet_networks");
        if (facts?.readAddress && facts.readConnectionId && this.records.control().active_operation_id === null) allowed.push("settings_clear_read_address");
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
      } else if (operation.phase !== "prepared" && operation.draft && !["set_wallet_networks", "clear_read_address", "download_backup"].includes(operation.draft.kind) &&
          (operation.draft.kind !== "restart_wallet_service" || this.canPrepareRestart())) allowed.push("settings_prepare");
      if (operation.phase === "uploading" && file && !file.invalidated && !file.sealed) {
        if (file.receivedSize > 0 || file.receivedSize < file.totalSize && this.records.canReserveFileIO(operation.operationId)) {
          allowed.push("settings_upload_chunk");
        }
        if (fileIOAvailable && file.receivedSize === file.totalSize && !file.reservation && !this.checkingFiles.has(file.fileId) &&
            !retainedBackupRejection(operation, file)) allowed.push("settings_seal_upload");
      }
    }
    const storedDownload = settingsDownload(operation);
    const localSave = storedDownload?.localSave;
    const downloadEnd = storedDownload?.endReason ?? (localSave?.status !== "saving" && storedDownload?.expiresAt && this.now().getTime() >= Date.parse(storedDownload.expiresAt) ? "expired" : undefined);
    const currentAttempt = storedDownload?.attempts.find((attempt) => attempt.attemptId === storedDownload.currentAttemptId);
    const currentDownloadOwner = operation.ownerId === this.records.ownerId && operation.dataEpoch === this.records.control().data_epoch && record.ownerId === this.records.ownerId;
    const download: SettingsView["download"] = storedDownload ? {
      availability: downloadEnd ? "ended" : storedDownload.readyAt ? "available" : "preparing",
      currentAttemptId: storedDownload.currentAttemptId,
      ...(currentAttempt?.hostReport ? { hostReport: currentAttempt.hostReport } : {}),
      previousUnconfirmed: this.records.previousDeliveryPossible(storedDownload),
      ...(localSave ? { localSave: { status: localSave.status, ...(localSave.currentSaveAttemptId ? { currentSaveAttemptId: localSave.currentSaveAttemptId } : {}),
        ...(localSave.failure ? { failure: localSave.failure } : {}), ...(localSave.savedAt ? { savedAt: localSave.savedAt } : {}) } } : {}),
      ...(downloadEnd ? { endReason: downloadEnd } : {}),
      ...(storedDownload.expiresAt ? { expiresAt: storedDownload.expiresAt, remainingMs: Math.max(0, Date.parse(storedDownload.expiresAt) - this.now().getTime()) } : {}),
      allowedFileActions: currentDownloadOwner && record.state.state !== "closed" && !this.closing ? [
        ...(storedDownload.readyAt && currentAttempt?.cardId === record.state.cardId ? ["settings_report_download" as const] : []),
        ...(!downloadEnd && file && !file.invalidated && localSave?.status !== "saving" ? [
          ...(currentAttempt?.cardId === record.state.cardId ? ["settings_cancel_download" as const] : []),
          ...(record.state.state === "ready" && record.state.input.backupDelivery && !localSave && storedDownload.readyAt ? ["settings_retry_download" as const] : []),
          ...(record.state.state === "ready" && record.state.input.backupDelivery && localSave && (localSave.status === "needs_consent" || localSave.status === "failed" && localSave.failure === "not_published") &&
            this.records.canReserveFileIO(operation.operationId) ? ["settings_store_backup" as const] : [])] : [])] : []
    } : undefined;
    if (storedDownload && !downloadExpiryPending) this.scheduleDownloadExpiry();
    const backupPath = localSave?.status === "saved" && file ? this.options.files.localBackupPath(file) : undefined;
    const readingDownloadStatus = currentOperation && storedDownload !== undefined;
    const activeDelivery = storedDownload && !currentOperation && record.state.state !== "closed";
    const deliveryPending = storedDownload && (localSave?.status === "saving" || !downloadEnd &&
      (!storedDownload.readyAt || !currentAttempt?.hostReport && !localSave));
    const recordedResult = currentOperation && storedDownload
      ? (deliveryPending ? undefined : this.records.downloadResult(operation))
      : operation.result;
    const cleanup = recordedResult ? downloadExpiryPending ? "pending" : this.records.temporaryFileCleanup(operation.operationId) : undefined;
    const data: SettingsView = { kind: "settings", operationId: operation.operationId,
      phase: readingDownloadStatus ? recordedResult ? "terminal" : "executing"
        : activeDelivery ? record.state.state === "ready" ? "draft" : "executing" : operation.phase, allowedActions: readingDownloadStatus ? [] : allowed,
      observe: !readingDownloadStatus && (activeDelivery ? !storedDownload.readyAt || localSave?.status === "saving" : !operation.result && (["executing", "stopping", "starting"].includes(operation.phase) || restoreCheck?.status === "checking")),
      ...(restoreCheck ? { restoreCheck } : {}), ...(download ? { download } : {}),
      ...(typeof backupPath === "string" ? { backupLocation: { directory: dirname(backupPath), filename: basename(backupPath) } } : {}),
      ...(operation.draft ? { draft: operation.draft } : {}), ...(operation.preparationId ? { preparationId: operation.preparationId } : {}),
      ...(operation.preparation && !storedDownload ? { preparation: operation.preparation } : {}), ...(recordedResult && !activeDelivery ? { result: recordedResult } : {}),
      ...(cleanup && !activeDelivery ? { temporaryFileCleanup: cleanup } : {}),
      ...(file ? { file: { fileId: file.fileId, displayName: file.displayName, totalSize: file.totalSize, receivedSize: file.receivedSize, sha256: file.sha256, sealed: file.sealed, cleanup: file.cleanup } } : {}),
      ...(facts ? { facts } : {}), ...(operation.priorRunId ? { priorRunId: operation.priorRunId } : {}),
      ...(operation.nextRunId ? { nextRunId: operation.nextRunId } : {}),
      ...(operation.supersedesOperationId ? { supersedesOperationId: operation.supersedesOperationId } : {}),
      ...(operation.supersededByOperationId ? { supersededByOperationId: operation.supersededByOperationId } : {}) };
    assertNoForbiddenMcpFields(data);
    if (!currentOperation && record.state.state === "closed" && record.state.data !== undefined) return { record, data: settingsViewSchema.parse(record.state.data) };
    if (!currentOperation && record.state.input.backupDelivery && downloadEnd) {
      this.records.transaction(() => this.records.finishDownloadCard(operation.operationId, record.state.cardId));
      record = this.records.cards.get(record.state.cardId)!;
      return { record, data: settingsViewSchema.parse(record.state.data) };
    }
    return { record, data: settingsViewSchema.parse(data) };
  }
  async act(expected: CardRecord, action: SettingsAction): Promise<void> {
    this.options.assertCurrent();
    if (this.closing) throw new SettingsConflict("This server is closing; Settings cannot accept another action.");
    const stored = this.records.forCard(expected);
    if (action.action === "settings_download_backup") {
      if (stored.acceptedDigest === settingsIdentity(action)) return;
      await this.startDownload(expected, action); return;
    }
    if (isSettingsDownloadFileAction(action)) { await this.continueDownload(expected, action); return; }
    if (action.action === "settings_clear_read_address" || action.action === "settings_save_wallet_networks") {
      const input = action;
      if (stored.acceptedDigest === settingsIdentity(input)) return;
      this.records.transaction(() => {
        const { card, operation } = this.records.requireInput(expected, input.operationId);
        this.records.requireFinalSlot();
        const previous = input.action === "settings_save_wallet_networks" ? this.options.preferences.getWalletConnectionChainsSync() : undefined;
        if (input.action === "settings_save_wallet_networks" && !isDeepStrictEqual(previous, input.expectedChains)) {
          throw new SettingsConflict("The saved networks changed. Check the current settings before saving your selection.");
        }
        this.records.claimFinal(operation.operationId);
        const next: SettingsOperation = { operationId: operation.operationId, cardId: operation.cardId, ownerId: operation.ownerId,
          dataEpoch: operation.dataEpoch, phase: "executing", draft: input.action === "settings_clear_read_address"
            ? { kind: "clear_read_address" } : { kind: "set_wallet_networks", chains: input.chains },
          acceptedDigest: settingsIdentity(input), admittedAt: this.now().toISOString() };
        this.records.write(operation, next, card, { ...card, acceptedInput: input,
          state: { ...card.state, state: "running", revision: card.state.revision + 1 } });
        if (input.action === "settings_clear_read_address") {
          this.records.clearReadAddress(input.connectionId, input.account);
          this.records.finish(operation.operationId, { outcome: "completed", recordedAt: this.now().toISOString(),
            message: "The saved read address was cleared. Your wallet connection and transaction requests are unchanged." });
        } else {
          this.options.preferences.setLocalSettingSync("walletConnectionChains", input.chains, this.now());
          this.options.wallet.closeConnectionCardsWithChangedNetworks(input.chains);
          this.records.finish(operation.operationId, { outcome: "completed", recordedAt: this.now().toISOString(),
            message: "Wallet networks were saved. They apply to new connections; existing connections are unchanged.",
            details: { walletConnectionChains: input.chains, previousWalletConnectionChains: previous, appliesTo: "new_connections" } });
        }
      });
      await this.cleanupTemporaryFiles(input.operationId);
      return;
    }
    if (action.action === "settings_confirm" && stored.acceptedDigest === settingsIdentity(action)) return;
    if (action.action === "settings_confirm") { await this.confirm(expected, action); return; }
    if (action.action === "settings_prepare") { await this.prepare(expected, action.operationId); return; }
    if (action.action === "settings_begin_upload") { await this.beginUpload(expected, action); return; }
    if (action.action === "settings_upload_chunk") { await this.upload(expected, action); return; }
    if (action.action === "settings_seal_upload") { await this.seal(expected, action); return; }
    let selected: CardRecord | undefined;
    this.records.transaction(() => {
      const { card, operation } = this.records.requireInput(expected, "operationId" in action ? action.operationId : undefined);
      if (!this.records.fileIOAvailable()) throw new SettingsConflict("Wait for the file transfer to finish before changing your selection.");
      if (action.action === "settings_cancel") {
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
        delete next.fileId;
        delete next.preparation;
        next.draft = action.draft; next.phase = "draft";
      }
      this.records.write(operation, next, card);
      if (action.action === "settings_select" && action.draft.kind !== "import_local_data") selected = this.records.cards.get(card.state.cardId);
    });
    await this.cleanupTemporaryFiles(stored.operationId);
    if (selected) await this.prepare(selected, stored.operationId);
  }
  private async prepare(expected: CardRecord, id: string): Promise<void> {
    const initial = this.records.requireInput(expected, id);
    const draft = initial.operation.draft;
    if (!draft) throw new SettingsConflict("Choose what you want to change in Settings first.");
    if (["set_wallet_networks", "clear_read_address", "download_backup"].includes(draft.kind)) throw new SettingsConflict("This action is applied by its explicit save or download request.");
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
    if (draft.kind === "download_backup" || draft.kind === "set_wallet_networks" || draft.kind === "clear_read_address") throw new SettingsConflict("This action is applied by its explicit save or download request.");
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
      } else if (replacement) details = this.options.localData.applyValidatedReplacement(imported, decisionTime, expected.state.cardId);
      this.records.finish(operation.operationId, { outcome: "completed", recordedAt: this.now().toISOString(),
        message: endpoint ? "The network address was saved. This result describes the settings at save time."
          : draft.kind === "import_local_data" ? "Local records were replaced. Restart the apps using Sui MCP before continuing."
          : "Local data was reset. This does not cancel a transaction on Sui or disconnect your wallet app.", details });
    });
    if (refused) throw refused;
    if (replacement) this.options.localData.notifyDataReplaced();
    await this.cleanupTemporaryFiles(action.operationId);
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
  private retainResult(id: string, result: SettingsResult, ready: boolean, file?: SettingsFile, downloadReadyAt?: string): void {
    if (!this.pendingResults.has(id)) this.pendingResults.set(id, { result, ready, ...(file ? { file } : {}), ...(downloadReadyAt ? { downloadReadyAt } : {}) });
    const retained = this.pendingResults.get(id)!;
    let settledFileId: string | undefined;
    const applied = this.records.transaction(() => {
      if (retained.file) {
        const current = this.records.file(retained.file.fileId);
        this.records.writeFile(current && isSettingsDownloadFile(current)
          ? { ...retained.file, invalidated: current.invalidated, cleanup: current.cleanup } : retained.file);
      }
      if (retained.downloadReadyAt) this.records.recordDownloadReady(id, retained.downloadReadyAt, DOWNLOAD_RETRY_WINDOW_MS);
      else if (this.records.get(id)?.draft?.kind === "download_backup" && retained.result.outcome !== "completed") this.records.endDownload(id, "source_unavailable", retained.result);
      const fileId = retained.file?.fileId ?? this.records.get(id)?.fileId;
      if (fileId && this.finishedFileIO.has(fileId)) {
        this.records.releaseFileIO(fileId); settledFileId = fileId;
      }
      if (retained.downloadReadyAt) { this.records.releaseFinal(id); return true; }
      if (this.records.get(id)?.draft?.kind === "download_backup") return true;
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
  private async cleanupFile(file: SettingsFile, waitForIO = true): Promise<void> {
    if (isSettingsDownloadFile(file)) {
      const pending = this.downloadIO.get(file.fileId);
      if (pending) { if (!waitForIO) return; await Promise.allSettled([...pending]); }
      this.options.assertCurrent();
      const current = this.records.file(file.fileId);
      if (!current || !current.invalidated || current.cleanup === "complete") return;
      file = current;
    }
    this.records.transaction(() => this.records.reserveFileIO(file.fileId, file.cleanupOperationId ?? file.operationId));
    try { await this.options.files.cleanup(file); this.options.assertCurrent(); this.records.writeFile({ ...this.records.file(file.fileId)!, cleanup: "complete" }); }
    catch { this.options.assertCurrent(); const current = this.records.file(file.fileId); if (current) this.records.writeFile({ ...current, cleanup: "failed" }); throw new Error("The local data change was saved, but temporary files could not be removed."); }
    finally { this.finishFileIO(file.fileId); }
  }
  private async cleanupTemporaryFiles(operationId?: string): Promise<void> {
    const files = this.records.filesForCleanup(operationId);
    for (const file of files) {
      try { await this.cleanupFile(file); }
      catch (error) { if (!(error instanceof SettingsConflict)) throw error; }
    }
  }
}
