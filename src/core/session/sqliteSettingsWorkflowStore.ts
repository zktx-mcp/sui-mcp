import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import type { CardRecord } from "./cardSession.js";
import { SqliteCardRecordStore } from "./sqliteCardStore.js";
import { SettingsConflict, settingsDraftSchema, settingsResultSchema, retainedBackupRejection, type SettingsAction, type SettingsOperation, type SettingsFile, type SettingsResult } from "./settingsOperation.js";
import { SETTINGS_REUSABLE_UPLOAD_SQL, SETTINGS_RESET_PREPARATION_SQL } from "./settingsPreparationSql.js";

type OperationRow = {
  operation_id: string; card_id: string; owner_id: string; data_epoch: number;
  phase: SettingsOperation["phase"]; draft_json: string | null; preparation_id: string | null;
  fingerprint: string | null; prepared_user_data_revision: number | null; preparation_json: string | null;
  file_id: string | null; accepted_digest: string | null; admitted_at: string | null; result_json: string | null;
  prior_run_id: string | null; next_run_id: string | null; supersedes_operation_id: string | null; superseded_by_operation_id: string | null;
  checkpoint: NonNullable<SettingsOperation["checkpoint"]> | null;
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
  create(record: CardRecord): void {
    this.transaction(() => {
      if (record.scope !== "settings" || record.state.kind !== "settings" || !record.operationId || record.ownerId !== this.ownerId) {
        throw new SettingsConflict("This Settings card could not be identified.");
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
      ...(row.superseded_by_operation_id === null ? {} : { supersededByOperationId: row.superseded_by_operation_id }),
      ...(row.checkpoint === null ? {} : { checkpoint: row.checkpoint }) };
  }
  forCard(record: CardRecord): SettingsOperation {
    const operation = record.operationId && this.get(record.operationId);
    if (!operation || operation.cardId !== record.state.cardId || record.scope !== "settings") {
      throw new SettingsConflict("This Settings request does not match the open card.");
    }
    return operation;
  }
  requireInput(expected: CardRecord, operationId?: string, now = this.now()): { card: CardRecord; operation: SettingsOperation } {
    const card = this.cards.get(expected.state.cardId);
    if (!card || card.ownerId !== this.ownerId || card.tokenHash !== expected.tokenHash || card.scope !== "settings" ||
        card.state.kind !== "settings" || card.state.revision !== expected.state.revision ||
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
  write(expected: SettingsOperation, next: SettingsOperation, card: CardRecord, nextCard?: CardRecord): void {
    this.transaction(() => {
      if (!isDeepStrictEqual(this.get(expected.operationId), expected) || next.operationId !== expected.operationId ||
          next.cardId !== expected.cardId || next.ownerId !== expected.ownerId) throw new SettingsConflict("Settings state changed before it could be saved.");
      this.db.prepare(`UPDATE settings_operations SET data_epoch=@epoch,kind=@kind,phase=@phase,draft_json=@draft,
        preparation_id=@preparationId,fingerprint=@fingerprint,prepared_user_data_revision=@userRevision,preparation_json=@preparation,
        file_id=@fileId,accepted_digest=@accepted,admitted_at=@admitted,result_json=@result,
        prior_run_id=@prior,next_run_id=@next,supersedes_operation_id=@supersedes,superseded_by_operation_id=@supersededBy,checkpoint=@checkpoint
        WHERE operation_id=@id`).run({ id: next.operationId, epoch: next.dataEpoch, kind: next.draft?.kind ?? null,
        phase: next.phase, draft: next.draft ? JSON.stringify(next.draft) : null, preparationId: next.preparationId ?? null,
        fingerprint: next.fingerprint ?? null, userRevision: next.preparedUserDataRevision ?? null,
        preparation: next.preparation ? JSON.stringify(next.preparation) : null, fileId: next.fileId ?? null,
        accepted: next.acceptedDigest ?? null, admitted: next.admittedAt ?? null, result: next.result ? JSON.stringify(next.result) : null,
        prior: next.priorRunId ?? null, next: next.nextRunId ?? null,
        supersedes: next.supersedesOperationId ?? null, supersededBy: next.supersededByOperationId ?? null, checkpoint: next.checkpoint ?? null });
      if (!this.cards.replace(card, nextCard ?? { ...card, state: { ...card.state, revision: card.state.revision + 1 } })) {
        throw new SettingsConflict("The Settings card changed before it could be saved.");
      }
    });
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
  finish(id: string, result: SettingsResult): boolean {
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
        state: "closed", reason: card.state.reason ?? (result.outcome === "completed" ? "completed" : result.outcome === "superseded" || !old.admittedAt ? "cancelled" : "failed") } });
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
      AND (role='export' OR invalidated=1)`).all(operationId) as { file_id: string }[];
    return rows.map((row) => this.file(row.file_id)!);
  }
  temporaryFileCleanup(operationId: string): SettingsFile["cleanup"] | undefined {
    const row = this.db.prepare(`SELECT CASE WHEN sum(cleanup='failed')>0 THEN 'failed'
      WHEN sum(cleanup='pending' OR file_id=(SELECT file_io_id FROM settings_control WHERE id=1))>0 THEN 'pending'
      WHEN count(*)>0 THEN 'complete' ELSE NULL END AS status
      FROM settings_files WHERE cleanup_operation_id=? AND (role='export' OR invalidated=1)`).get(operationId) as { status: SettingsFile["cleanup"] | null };
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
