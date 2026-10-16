import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import type { CardRecord } from "./cardSession.js";
import { SqliteCardRecordStore } from "./sqliteCardStore.js";
import { SettingsConflict, settingsDownload, storedSettingsDownloadSchema, type SettingsDownload, type SettingsDownloadFileAction, settingsDraftSchema, settingsResultSchema, retainedBackupRejection, type SettingsAction, type SettingsOperation, type SettingsFile, type SettingsResult } from "./settingsOperation.js";
import { isSettingsDownloadFile, settingsBackupPath, SETTINGS_FILE_CLEANUP_SQL } from "./settingsFileIdentity.js";
import type { SettingsLocalSave, SettingsLocalSaveOutcome, SettingsPhysicalFileIdentity } from "./settingsOperation.js";
import { SETTINGS_REUSABLE_UPLOAD_SQL, SETTINGS_RESET_PREPARATION_SQL } from "./settingsPreparationSql.js";

type OperationRow = {
  operation_id: string; card_id: string; owner_id: string; data_epoch: number;
  phase: SettingsOperation["phase"]; draft_json: string | null; preparation_id: string | null;
  fingerprint: string | null; prepared_user_data_revision: number | null; preparation_json: string | null;
  file_id: string | null; accepted_digest: string | null; admitted_at: string | null; result_json: string | null;
  prior_run_id: string | null; next_run_id: string | null; supersedes_operation_id: string | null; superseded_by_operation_id: string | null;
};
type FileRow = { file_id: string; operation_id: string; cleanup_operation_id: string; role: SettingsFile["role"]; relative_path: string; display_name: string;
  total_size: number; received_size: number; sha256: string; sealed: number; invalidated: number;
  cleanup: SettingsFile["cleanup"]; reservation_json: string | null };
export type SettingsControl = { data_epoch: number; user_data_revision: number; active_operation_id: string | null;
  file_io_id: string | null; wallet_input_blocked: number; wallet_block_operation_id: string | null };

/** Settings transitions share the activity owner's SQLite connection and card CAS.
 * Network and filesystem work must remain outside these transactions. */
export class SqliteSettingsWorkflowStore {
  readonly cards: SqliteCardRecordStore;
  constructor(readonly db: SqliteDatabase, readonly ownerId: string, readonly now: () => Date = () => new Date()) {
    this.cards = new SqliteCardRecordStore(db);
  }
  transaction<T>(work: () => T): T { return this.db.transaction(work).immediate(); }
  control(): SettingsControl { return this.db.prepare("SELECT * FROM settings_control WHERE id=1").get() as SettingsControl; }
  clearReadAddress(connectionId: string, account: string): void {
    const changed = this.db.prepare(`UPDATE live_wallet_connections SET read_address_cleared=1
      WHERE id=? AND current_slot=1 AND read_address_cleared=0 AND data_epoch=(SELECT data_epoch FROM settings_control WHERE id=1)
      AND EXISTS(SELECT 1 FROM json_each(connection_json,'$.chainResults') r WHERE json_extract(r.value,'$.chainId')='sui:mainnet'
        AND json_extract(r.value,'$.status')='bound' AND json_extract(r.value,'$.address')=?)`).run(connectionId, account);
    if (!changed.changes) throw new SettingsConflict("The saved read address changed. Check the current address before clearing it.");
  }
  create(record: CardRecord): void {
    this.transaction(() => {
      if (record.scope !== "settings" || record.state.kind !== "settings" || !record.operationId || record.ownerId !== this.ownerId) {
        throw new SettingsConflict("This Settings card could not be identified.");
      }
      if (record.state.input.backupDelivery) {
        const ref = record.state.input.backupDelivery as { operationId: string; fileId: string };
        const op = this.get(ref.operationId), file = this.file(ref.fileId), download = op && settingsDownload(op);
        if (!op || op.ownerId !== this.ownerId || op.dataEpoch !== this.control().data_epoch || !file || op.fileId !== file.fileId ||
            !download?.readyAt || download.endReason || !download.expiresAt || Date.parse(download.expiresAt) <= this.now().getTime() || file.invalidated ||
            download.localSave?.status === "saving") throw new SettingsConflict("This backup is no longer available for another delivery. Request a new backup.");
        this.cards.create(record); return;
      }
      this.cards.create(record);
      this.db.prepare(`INSERT INTO settings_operations (operation_id,card_id,owner_id,data_epoch,phase)
        VALUES (?,?,?,?,'draft')`).run(record.operationId, record.state.cardId, this.ownerId, this.control().data_epoch);
    });
  }
  get(id: string): SettingsOperation | undefined {
    const row = this.db.prepare("SELECT * FROM settings_operations WHERE operation_id=?").get(id) as OperationRow | undefined;
    if (!row) return undefined;
    return { operationId: row.operation_id, cardId: row.card_id, ownerId: row.owner_id, dataEpoch: row.data_epoch, phase: row.phase,
      ...(row.draft_json === null ? {} : { draft: settingsDraftSchema.parse(JSON.parse(row.draft_json)) }),
      ...(row.preparation_id === null ? {} : { preparationId: row.preparation_id }),
      ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
      ...(row.prepared_user_data_revision === null ? {} : { preparedUserDataRevision: row.prepared_user_data_revision }),
      ...(row.preparation_json === null ? {} : { preparation: JSON.parse(row.preparation_json) as Record<string, unknown> }),
      ...(row.file_id === null ? {} : { fileId: row.file_id }),
      ...(row.accepted_digest === null ? {} : { acceptedDigest: row.accepted_digest }),
      ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
      ...(row.result_json === null ? {} : { result: settingsResultSchema.parse(JSON.parse(row.result_json)) }),
      ...(row.prior_run_id === null ? {} : { priorRunId: row.prior_run_id }),
      ...(row.next_run_id === null ? {} : { nextRunId: row.next_run_id }),
      ...(row.supersedes_operation_id === null ? {} : { supersedesOperationId: row.supersedes_operation_id }),
      ...(row.superseded_by_operation_id === null ? {} : { supersededByOperationId: row.superseded_by_operation_id }) };
  }
  forCard(record: CardRecord): SettingsOperation {
    const operation = record.operationId && this.get(record.operationId);
    if (!operation || record.scope !== "settings" || operation.cardId !== record.state.cardId &&
        !(record.state.input.backupDelivery && (record.state.input.backupDelivery as { operationId: string; fileId: string }).operationId === operation.operationId &&
          (record.state.input.backupDelivery as { fileId: string }).fileId === operation.fileId)) {
      throw new SettingsConflict("This Settings request does not match the open card.");
    }
    return operation;
  }
  requireInput(expected: CardRecord, operationId?: string, now = this.now()): { card: CardRecord; operation: SettingsOperation } {
    const card = this.cards.get(expected.state.cardId);
    if (!card || card.ownerId !== this.ownerId || card.tokenHash !== expected.tokenHash || card.scope !== "settings" ||
        card.state.kind !== "settings" || card.state.input.backupDelivery !== undefined || card.state.input.operationStatus !== undefined || card.state.revision !== expected.state.revision ||
        card.state.state !== "ready" || card.acceptedInput !== undefined || Date.parse(card.state.expiresAt) <= now.getTime()) {
      throw new SettingsConflict("This Settings selection changed or its time limit ended.");
    }
    const operation = this.forCard(card);
    if (operationId !== undefined && operation.operationId !== operationId || operation.ownerId !== this.ownerId ||
        operation.dataEpoch !== this.control().data_epoch || operation.phase === "terminal") {
      throw new SettingsConflict("This Settings selection is out of date.");
    }
    return { card, operation };
  }
  write(expected: SettingsOperation, next: SettingsOperation, card: CardRecord, nextCard?: CardRecord, display?: Record<string, unknown>): void {
    this.transaction(() => {
      if (!isDeepStrictEqual(this.get(expected.operationId), expected) || next.operationId !== expected.operationId ||
          next.cardId !== expected.cardId || next.ownerId !== expected.ownerId) throw new SettingsConflict("Settings state changed before it could be saved.");
      // The operation owns the lifetime of its upload. A new effect or terminal
      // result cannot discard the file reference without retaining cleanup work.
      if (next.fileId !== expected.fileId || next.draft?.kind !== "import_local_data" || next.phase === "terminal") {
        this.invalidateUpload(expected);
      }
      this.db.prepare(`UPDATE settings_operations SET data_epoch=@epoch,kind=@kind,phase=@phase,draft_json=@draft,
        preparation_id=@preparationId,fingerprint=@fingerprint,prepared_user_data_revision=@userRevision,preparation_json=@preparation,
        file_id=@fileId,accepted_digest=@accepted,admitted_at=@admitted,result_json=@result,
        prior_run_id=@prior,next_run_id=@next,supersedes_operation_id=@supersedes,superseded_by_operation_id=@supersededBy
        WHERE operation_id=@id`).run({ id: next.operationId, epoch: next.dataEpoch, kind: next.draft?.kind ?? null,
        phase: next.phase, draft: next.draft ? JSON.stringify(next.draft) : null, preparationId: next.preparationId ?? null,
        fingerprint: next.fingerprint ?? null, userRevision: next.preparedUserDataRevision ?? null,
        preparation: next.preparation ? JSON.stringify(next.preparation) : null, fileId: next.fileId ?? null,
        accepted: next.acceptedDigest ?? null, admitted: next.admittedAt ?? null, result: next.result ? JSON.stringify(next.result) : null,
        prior: next.priorRunId ?? null, next: next.nextRunId ?? null,
        supersedes: next.supersedesOperationId ?? null, supersededBy: next.supersededByOperationId ?? null });
      let projected = nextCard ?? { ...card, state: { ...card.state, revision: card.state.revision + 1 } };
      if (projected.state.state === "closed" && projected.state.data === undefined && next.result) {
        projected = { ...projected, state: { ...projected.state, data: this.resultView(next, next.result, display) } };
      }
      if (card.state.state !== "closed" && !this.cards.replace(card, projected, this.now())) {
        throw new SettingsConflict("The Settings card changed before it could be saved.");
      }
    });
  }
  invalidateUpload(operation: SettingsOperation): void {
    if (!operation.fileId) return;
    this.db.prepare(`UPDATE settings_files SET invalidated=1,cleanup='pending'
      WHERE file_id=? AND operation_id=? AND role='upload' AND invalidated=0`)
      .run(operation.fileId, operation.operationId);
  }
  hasReusableUpload(operationId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM settings_operations WHERE operation_id=? AND (${SETTINGS_REUSABLE_UPLOAD_SQL})`).get(operationId);
  }
  resetPreparation(expected: SettingsOperation, card: CardRecord): void {
    this.transaction(() => {
      const current = this.requireInput(card, expected.operationId);
      if (!isDeepStrictEqual(current.operation, expected)) throw new SettingsConflict("The Settings selection changed before it could be cleared.");
      const rejection = retainedBackupRejection(current.operation, current.operation.fileId ? this.file(current.operation.fileId) : undefined);
      this.db.prepare(`${SETTINGS_RESET_PREPARATION_SQL} WHERE operation_id=?`).run(expected.operationId);
      if (rejection) this.db.prepare("UPDATE settings_operations SET preparation_json=? WHERE operation_id=?")
        .run(JSON.stringify({ restoreCheck: rejection }), expected.operationId);
      if (!this.cards.replace(current.card, { ...current.card, state: { ...current.card.state, revision: current.card.state.revision + 1 } })) {
        throw new SettingsConflict("The Settings card changed before its selection could be cleared.");
      }
    });
  }
  claimFinal(id: string, replaceId?: string): void {
    this.requireFinalSlot(replaceId);
    this.db.prepare("UPDATE settings_control SET active_operation_id=? WHERE id=1").run(id);
  }
  fileIOAvailable(control = this.control()): boolean { return control.file_io_id === null; }
  canReserveFileIO(operationId: string): boolean {
    const control = this.control();
    return this.fileIOAvailable(control) && (control.active_operation_id === null || control.active_operation_id === operationId);
  }
  // Read-only eligibility check shared by preparation and final admission.
  requireFinalSlot(replaceId?: string): void {
    const control = this.control();
    if (!this.fileIOAvailable(control) || control.active_operation_id !== (replaceId ?? null)) {
      throw new SettingsConflict("Another Settings change or file transfer is in progress. Check its result before confirming again.");
    }
  }
  reserveFileIO(fileId: string, operationId: string): void {
    if (!this.canReserveFileIO(operationId)) {
      throw new SettingsConflict("A file transfer or Settings change is in progress. Check its status before trying again.");
    }
    this.db.prepare("UPDATE settings_control SET file_io_id=? WHERE id=1").run(fileId);
  }
  releaseFileIO(fileId: string): void {
    this.db.prepare("UPDATE settings_control SET file_io_id=NULL WHERE id=1 AND file_io_id=?").run(fileId);
  }
  admit(expected: CardRecord, input: Extract<SettingsAction, { action: "settings_confirm" }>, currentFingerprint: () => string,
    replaceOperationId?: string, now = this.now()): SettingsOperation {
    return this.transaction(() => {
      const { card, operation } = this.requireAdmission(expected, input, currentFingerprint, replaceOperationId, now);
      this.claimFinal(operation.operationId, replaceOperationId);
      const next: SettingsOperation = { ...operation, phase: operation.draft!.kind === "restart_wallet_service" ? "stopping" : "executing",
        acceptedDigest: settingsIdentity(input), admittedAt: now.toISOString() };
      this.write(operation, next, card, { ...card, acceptedInput: input, state: { ...card.state,
        state: "running", revision: card.state.revision + 1 } });
      return next;
    });
  }
  // Pure admission checks let deadline reconciliation commit an expected refusal
  // without claiming a final slot or consuming input. Admission uses the same rule.
  requireAdmission(expected: CardRecord, input: Extract<SettingsAction, { action: "settings_confirm" }>, currentFingerprint: () => string,
    replaceOperationId?: string, now = this.now()): { card: CardRecord; operation: SettingsOperation } {
    const result = this.requireInput(expected, input.operationId, now), operation = result.operation;
    if (operation.phase !== "prepared" || !operation.draft || operation.preparationId !== input.preparationId ||
        operation.fingerprint !== currentFingerprint()) throw new SettingsConflict("This change is out of date. Review it again before confirming.");
    if (["import_local_data", "reset_local_data"].includes(operation.draft.kind) &&
        operation.preparedUserDataRevision !== this.control().user_data_revision) throw new SettingsConflict("Local records changed after they were checked. Review the current records before confirming.");
    this.requireFinalSlot(replaceOperationId);
    return result;
  }
  admitDownload(expected: CardRecord, input: Extract<SettingsAction, { action: "settings_download_backup" }>,
    snapshot: (operation: SettingsOperation) => SettingsFile): SettingsFile {
    return this.transaction(() => {
      const { card, operation } = this.requireInput(expected, input.operationId);
      this.requireFinalSlot();
      const file = snapshot(operation);
      if (!isSettingsDownloadFile(file) || file.operationId !== operation.operationId) throw new SettingsConflict("The download snapshot does not match this request.");
      this.createFile(file); this.claimFinal(operation.operationId); this.reserveFileIO(file.fileId, operation.operationId);
      const admittedAt = this.now().toISOString();
      const download: SettingsDownload = { currentAttemptId: input.attemptId, attempts: [{ attemptId: input.attemptId, admittedAt, cardId: card.state.cardId }] };
      const next: SettingsOperation = { operationId: operation.operationId, cardId: operation.cardId, ownerId: operation.ownerId,
        dataEpoch: operation.dataEpoch, phase: "executing", draft: { kind: "download_backup" }, fileId: file.fileId,
        preparation: { download }, acceptedDigest: settingsIdentity(input), admittedAt };
      this.write(operation, next, card, { ...card, acceptedInput: input,
        state: { ...card.state, state: "running", revision: card.state.revision + 1 } });
      return file;
    });
  }
  downloadContext(expected: CardRecord, operationId: string, fileId: string) {
    const card = this.cards.get(expected.state.cardId);
    if (!card || card.tokenHash !== expected.tokenHash || card.ownerId !== this.ownerId || card.scope !== "settings" || card.operationId !== operationId) {
      throw new SettingsConflict("This download no longer belongs to the current Settings request.");
    }
    const operation = this.get(operationId), file = this.file(fileId);
    if (!operation || operation.cardId !== card.state.cardId && !(card.state.input.backupDelivery &&
        (card.state.input.backupDelivery as { operationId: string; fileId: string }).operationId === operationId &&
        (card.state.input.backupDelivery as { operationId: string; fileId: string }).fileId === fileId) || operation.ownerId !== this.ownerId ||
        operation.dataEpoch !== this.control().data_epoch || operation.fileId !== fileId || !file ||
        file.operationId !== operationId || !isSettingsDownloadFile(file)) throw new SettingsConflict("This download no longer belongs to the current Settings request.");
    const download = settingsDownload(operation);
    if (!download) throw new SettingsConflict("This Settings request does not provide a download.");
    return { card, operation, file, download };
  }
  requireDownloadRead(expected: CardRecord, fileId: string, attemptId: string | undefined) {
    const context = this.downloadContext(expected, expected.operationId!, fileId), { download, file } = context;
    if (context.card.state.state === "closed" || !attemptId || download.attempts.find((a) => a.attemptId === attemptId)?.cardId !== context.card.state.cardId || attemptId !== download.currentAttemptId || download.endReason || download.localSave || !download.expiresAt ||
        this.now().getTime() >= Date.parse(download.expiresAt) || !file.sealed || file.invalidated ||
        !download.readyAt) throw new SettingsConflict("This backup's download period has ended or its attempt changed.");
    return context;
  }
  private writeDownloadState(expected: SettingsOperation, download: SettingsDownload, card: CardRecord, nextCard?: CardRecord): void {
    storedSettingsDownloadSchema.parse(download);
    this.transaction(() => {
      if (!isDeepStrictEqual(this.get(expected.operationId), expected) || expected.draft?.kind !== "download_backup") {
        throw new SettingsConflict("The download state changed before it could be saved.");
      }
      // A terminal result is immutable serialized evidence. Updating delivery
      // state must not reserialize it, even with semantically identical keys.
      this.db.prepare("UPDATE settings_operations SET preparation_json=? WHERE operation_id=?")
        .run(JSON.stringify({ download }), expected.operationId);
      const current = this.cards.get(card.state.cardId);
      if (current && current.state.state !== "closed" && !this.cards.replace(current, nextCard ?? { ...current, state: { ...current.state, revision: current.state.revision + 1 } })) {
        throw new SettingsConflict("The download card changed before its state could be saved.");
      }
    });
  }
  endDownload(id: string, reason: NonNullable<SettingsDownload["endReason"]>, finalResult?: SettingsResult): void {
    const operation = this.get(id);
    if (!operation) return;
    const download = settingsDownload(operation), card = this.cards.get(operation.cardId);
    if (!download || !card || download.endReason || download.localSave?.status === "saving") return;
    if (reason !== "server_restarted" && operation.ownerId !== this.ownerId) throw new SettingsConflict("The download owner changed.");
    const file = operation.fileId ? this.file(operation.fileId) : undefined;
    if (file && isSettingsDownloadFile(file)) this.writeFile({ ...file, invalidated: true, cleanup: "pending" });
    this.writeDownloadState(operation, { ...download, endReason: reason }, card);
    this.finishDownloadCard(id, undefined, finalResult);
  }
  expireDownloads(operationId?: string): void {
    const now = this.now().getTime();
    let failure: unknown;
    for (const operation of this.downloads(operationId)) {
      const download = settingsDownload(operation)!;
      if (!download.endReason && download.localSave?.status !== "saving" && download.expiresAt && now >= Date.parse(download.expiresAt)) {
        try { this.transaction(() => this.endDownload(operation.operationId, "expired")); }
        catch (error) { failure ??= error; }
      }
    }
    if (failure) throw failure;
  }
  downloads(operationId?: string): SettingsOperation[] {
    return (this.db.prepare(`SELECT operation_id FROM settings_operations WHERE kind='download_backup' AND owner_id=?
      ${operationId === undefined ? "" : "AND operation_id=?"}`)
      .all(this.ownerId, ...(operationId === undefined ? [] : [operationId])) as { operation_id: string }[]).map((row) => this.get(row.operation_id)!);
  }
  continueDownload(expected: CardRecord, input: SettingsDownloadFileAction): SettingsFile | undefined {
    return this.transaction(() => {
      // Validate the caller's scope before any target reads or expiry writes.
      this.downloadContext(expected, input.operationId, input.fileId);
      this.expireDownloads(input.operationId);
      const { card, operation, file, download } = this.downloadContext(expected, input.operationId, input.fileId);
      if (input.action === "settings_store_backup") {
        const save = download.localSave;
        const duplicate = save?.attempts.find((a) => a.saveAttemptId === input.saveAttemptId);
        if (duplicate) {
          if (duplicate.cardId !== card.state.cardId || save!.attemptId !== input.attemptId || duplicate.previousSaveAttemptId !== input.previousSaveAttemptId ||
              duplicate.allowPossibleCopy !== input.allowPossibleCopy) throw new SettingsConflict("This save does not match the recorded request.");
          return;
        }
        if (card.state.state !== "ready" || !card.state.input.backupDelivery || !save || save.attemptId !== input.attemptId || download.endReason || !download.expiresAt ||
            Date.parse(download.expiresAt) <= this.now().getTime() || file.invalidated || !file.sealed ||
            (save.status === "needs_consent" ? input.previousSaveAttemptId !== undefined :
              save.status !== "failed" || save.failure !== "not_published" || input.previousSaveAttemptId !== save.currentSaveAttemptId) ||
            input.allowPossibleCopy !== this.previousDeliveryPossible(download)) throw new SettingsConflict("This backup cannot be saved by that request. Check its current status.");
        const next = this.admitLocalSave(operation, file, save, input.saveAttemptId, input.allowPossibleCopy, card.state.cardId, input.previousSaveAttemptId);
        this.writeDownloadState(operation, { ...download, localSave: next }, card, { ...card, acceptedInput: input, state: { ...card.state, state: "running", revision: card.state.revision + 1 } });
        return file;
      }
      if (input.action === "settings_retry_download") {
        const duplicate = download.attempts.find((attempt) => attempt.attemptId === input.attemptId);
        if (duplicate) {
          if (duplicate.cardId !== card.state.cardId || duplicate.previousAttemptId !== input.previousAttemptId) throw new SettingsConflict("This retry does not match the recorded download attempt.");
          return;
        }
        if (card.state.state !== "ready" || !card.state.input.backupDelivery || download.currentAttemptId !== input.previousAttemptId || download.endReason || download.localSave || !download.expiresAt || !file.sealed ||
            file.invalidated || !download.readyAt) throw new SettingsConflict("This backup is no longer available for that retry.");
        const previousCardId = download.attempts.find((a) => a.attemptId === download.currentAttemptId)!.cardId;
        // A new explicit delivery attempt does not establish the earlier Host outcome.
        // Record the old card's uncertainty before the new attempt becomes current.
        this.finishDownloadCard(operation.operationId, previousCardId);
        const next: SettingsDownload = { ...download, currentAttemptId: input.attemptId,
          attempts: [...download.attempts, { attemptId: input.attemptId, cardId: card.state.cardId, previousAttemptId: input.previousAttemptId, admittedAt: this.now().toISOString() }] };
        this.writeDownloadState(this.get(operation.operationId)!, next, card, { ...card, acceptedInput: input, state: { ...card.state, state: "running", revision: card.state.revision + 1 } }); return;
      }
      const entry = download.attempts.find((attempt) => attempt.attemptId === input.attemptId);
      if (!entry || entry.cardId !== card.state.cardId) throw new SettingsConflict("This download attempt was not admitted.");
      if (input.action === "settings_report_download") {
        if (!download.readyAt) throw new SettingsConflict("The download snapshot is not ready.");
        if (entry.hostReport) {
          if (entry.hostReport !== input.status || !isDeepStrictEqual(entry.failure, input.failure)) throw new SettingsConflict("A different result was already reported for this download attempt.");
          return;
        }
        const next: SettingsDownload = { ...download, attempts: download.attempts.map((attempt) => attempt === entry
          ? { ...attempt, hostReport: input.status, ...(input.failure ? { failure: input.failure } : {}) } : attempt) };
        let admitted = false;
        if (input.status === "unsupported" && input.attemptId === download.currentAttemptId && card.state.state === "running" && !download.endReason &&
            download.expiresAt && this.now().getTime() < Date.parse(download.expiresAt) && file.sealed && !file.invalidated) {
          const save: SettingsLocalSave = { status: "needs_consent", attemptId: input.attemptId, fileId: file.fileId,
            sha256: file.sha256, totalSize: file.totalSize, destination: settingsBackupPath(operation.operationId), ownerId: this.ownerId, attempts: [] };
          if (this.previousDeliveryPossible(download)) next.localSave = save;
          else { next.localSave = this.admitLocalSave(operation, file, save, randomUUID(), false, card.state.cardId); admitted = true; }
        }
        this.writeDownloadState(operation, next, card);
        if (input.attemptId === download.currentAttemptId && input.status === "acknowledged" && !download.endReason) this.endDownload(operation.operationId, "acknowledged");
        else if (!admitted) this.finishDownloadCard(operation.operationId, card.state.cardId);
        return admitted ? file : undefined;
      } else {
        if (card.state.state === "closed" || input.attemptId !== download.currentAttemptId) throw new SettingsConflict("A different download attempt is current.");
        if (download.localSave?.status === "saving") throw new SettingsConflict("Saving has already started. Check its result before continuing.");
        this.endDownload(operation.operationId, "cancelled");
      }
    });
  }
  previousDeliveryPossible(download: SettingsDownload): boolean {
    return download.attempts.some((a) => a.attemptId !== download.currentAttemptId && a.hostReport !== "unsupported" && a.hostReport !== "not_sent");
  }
  private admitLocalSave(operation: SettingsOperation, file: SettingsFile, saved: SettingsLocalSave,
    saveAttemptId: string, allowPossibleCopy: boolean, cardId: string, previousSaveAttemptId?: string): SettingsLocalSave {
    this.claimFinal(operation.operationId); this.reserveFileIO(file.fileId, operation.operationId);
    const { failure: _failure, sourceIdentity: _identity, savedAt: _savedAt, ...base } = saved;
    return { ...base, status: "saving", currentSaveAttemptId: saveAttemptId, attempts: [...saved.attempts,
      { saveAttemptId, cardId, allowPossibleCopy, admittedAt: this.now().toISOString(), ...(previousSaveAttemptId ? { previousSaveAttemptId } : {}) }] };
  }
  localSaveContext(id: string, saveAttemptId: string) {
    const operation = this.get(id), download = operation && settingsDownload(operation), save = download?.localSave;
    const file = operation?.fileId ? this.file(operation.fileId) : undefined;
    const ownerCardId = save?.attempts.find((a) => a.saveAttemptId === save.currentSaveAttemptId)?.cardId;
    const card = ownerCardId && this.cards.get(ownerCardId);
    if (!operation || operation.ownerId !== this.ownerId || operation.dataEpoch !== this.control().data_epoch ||
        !download || !save || !file || !card || save.status !== "saving" || save.currentSaveAttemptId !== saveAttemptId ||
        save.fileId !== file.fileId || save.sha256 !== file.sha256 || save.totalSize !== file.totalSize ||
        save.destination !== settingsBackupPath(id) || this.control().active_operation_id !== id || this.control().file_io_id !== file.fileId) {
      throw new SettingsConflict("The admitted backup save changed before it could be settled.");
    }
    return { operation, download, save, file, card };
  }
  rememberLocalSaveSource(id: string, saveAttemptId: string, sourceIdentity: SettingsPhysicalFileIdentity): void {
    this.transaction(() => {
      const { operation, download, save, card } = this.localSaveContext(id, saveAttemptId);
      if (save.sourceIdentity && !isDeepStrictEqual(save.sourceIdentity, sourceIdentity)) throw new SettingsConflict("The backup file changed before saving.");
      this.writeDownloadState(operation, { ...download, localSave: { ...save, sourceIdentity } }, card);
    });
  }
  settleLocalSave(id: string, saveAttemptId: string, outcome: SettingsLocalSaveOutcome, backupLocation?: { directory: string; filename: string }): void {
    this.transaction(() => {
      const { operation, download, save, file, card } = this.localSaveContext(id, saveAttemptId);
      const expired = !download.expiresAt || this.now().getTime() >= Date.parse(download.expiresAt);
      const ended = outcome.status === "saved" ? "stored_locally" : save.ownerId !== this.ownerId ? "server_restarted"
        : expired ? "expired" : outcome.reason !== "not_published" ? "local_save_failed" : undefined;
      const localSave: SettingsLocalSave = outcome.status === "saved"
        ? { ...save, status: "saved", savedAt: this.now().toISOString() }
        : { ...save, status: "failed", failure: save.ownerId !== this.ownerId && outcome.reason === "not_published" ? "interrupted" : outcome.reason };
      this.writeDownloadState(operation, { ...download, localSave, ...(ended ? { endReason: ended } : {}) }, card);
      if (ended) this.writeFile({ ...file, invalidated: true, cleanup: "pending" });
      this.finishDownloadCard(id, card.state.cardId, undefined, backupLocation);
      this.releaseFileIO(file.fileId);
      this.db.prepare("UPDATE settings_control SET active_operation_id=NULL WHERE id=1 AND active_operation_id=?").run(id);
    });
  }
  recordDownloadReady(id: string, readyAt: string, retryWindowMs: number): void {
    const operation = this.get(id);
    if (!operation || operation.ownerId !== this.ownerId || operation.dataEpoch !== this.control().data_epoch) throw new SettingsConflict("The snapshot owner changed.");
    const download = settingsDownload(operation)!;
    if (download.readyAt) return;
    const card = this.cards.get(operation.cardId)!;
    this.writeDownloadState(operation, { ...download, readyAt,
      expiresAt: new Date(Date.parse(readyAt) + retryWindowMs).toISOString() }, card);
  }
  releaseFinal(id: string): void {
    this.db.prepare("UPDATE settings_control SET active_operation_id=NULL WHERE id=1 AND active_operation_id=?").run(id);
  }
  resultView(operation: SettingsOperation, result: SettingsResult, display?: Record<string, unknown>) {
    const file = operation.fileId ? this.file(operation.fileId) : undefined;
    const { file: _file, ...extra } = display ?? {};
    return { kind: "settings", operationId: operation.operationId, phase: "terminal", result,
      ...(operation.draft ? { draft: operation.draft } : {}), temporaryFileCleanup: this.temporaryFileCleanup(operation.operationId),
      allowedActions: [], observe: false,
      ...(operation.priorRunId ? { priorRunId: operation.priorRunId } : {}), ...(operation.nextRunId ? { nextRunId: operation.nextRunId } : {}),
      ...(operation.supersedesOperationId ? { supersedesOperationId: operation.supersedesOperationId } : {}),
      ...(operation.supersededByOperationId ? { supersededByOperationId: operation.supersededByOperationId } : {}),
      ...(file ? { file: { fileId: file.fileId, displayName: file.displayName, totalSize: file.totalSize, receivedSize: file.receivedSize,
        sha256: file.sha256, sealed: file.sealed, cleanup: file.cleanup } } : {}), ...extra };
  }
  downloadResult(operation: SettingsOperation): SettingsResult {
    const download = settingsDownload(operation);
    if (!download) throw new SettingsConflict("This Settings request does not provide a download.");
    const local = download.localSave, report = download.attempts.find((a) => a.attemptId === download.currentAttemptId)?.hostReport;
    const succeeded = download.endReason === "stored_locally" || report === "acknowledged";
    return { completionScope: "backup_delivery", outcome: succeeded ? "completed" : download.endReason === "cancelled" || download.endReason === "server_restarted" ? "interrupted" : "failed", recordedAt: this.now().toISOString(),
      message: download.endReason === "stored_locally" ? "Backup saved." : report === "acknowledged" ? "The app accepted the download request. This does not confirm that the file was saved or where it was saved."
        : download.endReason === "cancelled" ? "Backup delivery was cancelled."
        : download.endReason ? "This backup is no longer available for delivery. Ask in chat for a new Settings card to create a backup."
        : report === "not_sent" ? "The backup could not be read or checked. Nothing was sent to the app for download." : local?.status === "needs_consent" ? "A local copy needs a new explicit request because another copy may exist."
        : local?.status === "failed" && local.failure === "not_published" ? "The backup was not saved. Ask in chat for a new delivery card to retry saving the same backup."
        : "Backup delivery was not confirmed. Ask in chat for a new delivery card." };
  }
  finishDownloadCard(id: string, cardId?: string, finalResult?: SettingsResult, backupLocation?: { directory: string; filename: string }): void {
    const operation = this.get(id), download = operation && settingsDownload(operation);
    if (!operation || !download) return;
    const local = download.localSave;
    const target = cardId ?? local?.attempts.find((a) => a.saveAttemptId === local.currentSaveAttemptId)?.cardId ?? download.attempts.find((a) => a.attemptId === download.currentAttemptId)?.cardId;
    const card = target && this.cards.get(target);
    if (!card) return;
    const report = download.attempts.find((a) => a.attemptId === download.currentAttemptId)?.hostReport;
    const succeeded = download.endReason === "stored_locally" || report === "acknowledged";
    const result = finalResult ?? this.downloadResult(operation);
    const file = operation.fileId ? this.file(operation.fileId) : undefined;
    const display = { ...(file ? { file: { fileId: file.fileId, displayName: file.displayName, totalSize: file.totalSize, receivedSize: file.receivedSize,
      sha256: file.sha256, sealed: file.sealed, cleanup: file.cleanup } } : {}),
      download: { availability: download.endReason ? "ended" : download.readyAt ? "available" : "preparing", currentAttemptId: download.currentAttemptId,
        ...(report ? { hostReport: report } : {}), previousUnconfirmed: this.previousDeliveryPossible(download),
        ...(download.endReason ? { endReason: download.endReason } : {}), ...(download.expiresAt ? { expiresAt: download.expiresAt, remainingMs: Math.max(0, Date.parse(download.expiresAt) - this.now().getTime()) } : {}),
        ...(local ? { localSave: { status: local.status, currentSaveAttemptId: local.currentSaveAttemptId, failure: local.failure, savedAt: local.savedAt } } : {}), allowedFileActions: [] },
      ...(backupLocation ? { backupLocation } : {}) };
    const reason = download.endReason === "cancelled" ? "cancelled" : download.endReason === "expired" ? "expired" : download.endReason === "server_restarted" ? "server_restarted" : succeeded ? "completed" : "failed";
    if (!operation.result && operation.cardId === card.state.cardId) this.finish(id, result, display, reason);
    else if (card.state.state !== "closed" && !this.cards.replace(card, { ...card, state: { ...card.state, state: "closed", reason,
        revision: card.state.revision + 1, data: this.resultView(operation, result, display) } }, this.now())) throw new SettingsConflict("The delivery result could not be saved.");
  }
  filesForCleanup(operationId?: string): SettingsFile[] {
    const rows = this.db.prepare(`SELECT file_id FROM settings_files WHERE cleanup!='complete' AND ${SETTINGS_FILE_CLEANUP_SQL}
      ${operationId === undefined ? "" : "AND cleanup_operation_id=?"}`).all(...(operationId === undefined ? [] : [operationId])) as { file_id: string }[];
    return rows.map((row) => this.file(row.file_id)!);
  }
  finish(id: string, result: SettingsResult, display?: Record<string, unknown>, reason?: CardRecord["state"]["reason"]): boolean {
    return this.transaction(() => {
      const old = this.get(id);
      if (!old || old.ownerId !== this.ownerId) return false;
      if (old.result) return isDeepStrictEqual(old.result, result);
      if (old.dataEpoch !== this.control().data_epoch) return false;
      if (result.outcome === "completed" && (!old.admittedAt || !old.acceptedDigest ||
          !["executing", "starting"].includes(old.phase))) throw new SettingsConflict("An unconfirmed Settings change cannot complete.");
      const card = this.cards.get(old.cardId);
      if (!card || card.ownerId !== this.ownerId || card.operationId !== id) return false;
      const next: SettingsOperation = { ...old, phase: "terminal", result };
      this.write(old, next, card, { ...card, state: { ...card.state, revision: card.state.revision + 1,
        state: "closed", data: undefined, reason: card.state.reason ?? reason ?? (result.outcome === "completed" ? "completed" : result.outcome === "superseded" || !old.admittedAt ? "cancelled" : "failed") } }, display);
      this.db.prepare(`UPDATE settings_control SET active_operation_id=NULL WHERE id=1 AND active_operation_id=?`).run(id);
      this.db.prepare(`UPDATE settings_control SET wallet_input_blocked=0,wallet_block_operation_id=NULL
        WHERE id=1 AND wallet_block_operation_id=?`).run(id);
      return true;
    });
  }
  file(id: string): SettingsFile | undefined {
    const row = this.db.prepare("SELECT * FROM settings_files WHERE file_id=?").get(id) as FileRow | undefined;
    return row ? { fileId: row.file_id, operationId: row.operation_id, role: row.role, relativePath: row.relative_path,
      displayName: row.display_name, totalSize: row.total_size, receivedSize: row.received_size, sha256: row.sha256,
      sealed: row.sealed === 1, invalidated: row.invalidated === 1, cleanup: row.cleanup,
      cleanupOperationId: row.cleanup_operation_id,
      ...(row.reservation_json === null ? {} : { reservation: JSON.parse(row.reservation_json) as NonNullable<SettingsFile["reservation"]> }) } : undefined;
  }
  filesNeedingCleanup(operationId: string): SettingsFile[] {
    const rows = this.db.prepare(`SELECT file_id FROM settings_files WHERE cleanup_operation_id=? AND cleanup!='complete'
      AND ${SETTINGS_FILE_CLEANUP_SQL}`).all(operationId) as { file_id: string }[];
    return rows.map((row) => this.file(row.file_id)!);
  }
  temporaryFileCleanup(operationId: string): SettingsFile["cleanup"] | undefined {
    const row = this.db.prepare(`SELECT CASE WHEN sum(cleanup='failed')>0 THEN 'failed'
      WHEN sum(cleanup='pending' OR file_id=(SELECT file_io_id FROM settings_control WHERE id=1))>0 THEN 'pending'
      WHEN count(*)>0 THEN 'complete' ELSE NULL END AS status
      FROM settings_files WHERE cleanup_operation_id=? AND ${SETTINGS_FILE_CLEANUP_SQL}`).get(operationId) as { status: SettingsFile["cleanup"] | null };
    return row.status ?? undefined;
  }
  createFile(file: SettingsFile): void {
    this.db.prepare(`INSERT INTO settings_files
      (file_id,operation_id,cleanup_operation_id,role,relative_path,display_name,total_size,received_size,sha256,sealed,invalidated,cleanup,reservation_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(file.fileId, file.operationId, file.cleanupOperationId ?? file.operationId, file.role, file.relativePath, file.displayName,
        file.totalSize, file.receivedSize, file.sha256, Number(file.sealed), Number(file.invalidated), file.cleanup,
        file.reservation ? JSON.stringify(file.reservation) : null);
  }
  writeFile(file: SettingsFile): void {
    if (this.db.prepare(`UPDATE settings_files SET received_size=?,sealed=?,invalidated=?,cleanup=?,reservation_json=? WHERE file_id=?`)
      .run(file.receivedSize, Number(file.sealed), Number(file.invalidated), file.cleanup,
        file.reservation ? JSON.stringify(file.reservation) : null, file.fileId).changes !== 1) {
      throw new SettingsConflict("The selected file is no longer available.");
    }
  }
}

// The input is already a strict typed action. Sort object keys recursively so
// JSON-RPC ids and object insertion order never change business idempotency.
export function settingsIdentity(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input !== null && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
