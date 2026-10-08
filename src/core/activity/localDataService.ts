import { hasUnsettledWalletWork } from "../session/sqliteWalletWorkflowStore.js";
import type Database from "better-sqlite3";
import type { AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";
import { SuiEndpointError, parseGraphqlUrl, parseGrpcUrl } from "../suiEndpoint.js";
import {
  LOCAL_DATA_EXPORT_FORMAT,
  LOCAL_DATA_NETWORK,
  LocalDataError,
  type AccountExportRow,
  type ActiveAccountContextExportRow,
  type ExternalActivityScanExportRow,
  type ExternalActivityTransactionExportRow,
  type LocalDataCounts,
  type LocalDataEnvelope,
  type LocalDataImportPreview,
  type LocalDataMutationResult,
  type LocalDataPayload,
  type LocalDataService,
  type LocalSettingExportRow,
  type ReviewExecutionExportRow,
  type ReviewRequestExportRow,
  type ReviewSessionExportRow,
  type ReviewStateSnapshotExportRow,
  type ReviewStatusTransitionExportRow,
  type SqliteLocalDataServiceOptions
} from "./localDataTypes.js";
import {
  activeAccountChange,
  activeAccountAddress,
  countsForPayload,
  invalidBackup,
  maxNumber,
  parseLocalDataEnvelope,
  suiGraphqlUrlFromPayload,
  suiGrpcUrlFromPayload
} from "./localDataValidation.js";

export * from "./localDataTypes.js";

type SqliteDatabase = Database.Database;
type CountRow = { count: number };

export class SqliteLocalDataService implements LocalDataService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: SqliteLocalDataServiceOptions,
    private readonly validateAdapterLifecycle: AdapterLifecycleValidator
  ) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }

  async getDataCounts(): Promise<LocalDataCounts> {
    return this.currentDataCountsSync();
  }

  currentDataCountsSync(now = this.now()): LocalDataCounts {
    return this.db.transaction(() => {
      this.options.advanceRequestDeadlines(now);
      return this.getDataCountsSync();
    }).immediate();
  }

  async exportLocalData(now = new Date()): Promise<LocalDataEnvelope> { return this.exportLocalDataSync(now); }

  exportLocalDataSync(now = this.now()): LocalDataEnvelope {
    return this.db.transaction(() => {
      const envelope = {
        format: LOCAL_DATA_EXPORT_FORMAT,
        network: LOCAL_DATA_NETWORK,
        exportedAt: now.toISOString(),
        data: {
          accounts: this.selectAll<AccountExportRow>("accounts"),
          activeAccountContext: this.selectAll<ActiveAccountContextExportRow>("active_account_context"),
          reviewSessions: this.selectAll<ReviewSessionExportRow>("review_sessions"),
          reviewStateSnapshots: this.selectAll<ReviewStateSnapshotExportRow>("review_state_snapshots"),
          reviewStatusTransitions: this.selectAll<ReviewStatusTransitionExportRow>("review_status_transitions"),
          reviewExecutions: this.selectAll<ReviewExecutionExportRow>("review_executions"),
          reviewRequests: this.selectAll<ReviewRequestExportRow>("review_requests"),
          externalActivityScans: this.selectAll<ExternalActivityScanExportRow>("external_activity_scans"),
          externalActivityTransactions: this.selectAll<ExternalActivityTransactionExportRow>("external_activity_transactions"),
          localSettings: this.selectAll<LocalSettingExportRow>("local_settings")
        }
      };
      return parseLocalDataEnvelope(envelope, {
        validateAdapterLifecycle: this.validateAdapterLifecycle
      });
    })();
  }

  async previewImportLocalData(input: unknown): Promise<LocalDataImportPreview> { return this.previewImportLocalDataSync(input); }

  previewImportLocalDataSync(input: unknown, now = this.now()): LocalDataImportPreview {
    const envelope = parseLocalDataEnvelope(input, {
      validateAdapterLifecycle: this.validateAdapterLifecycle
    });
    return this.db.transaction((): LocalDataImportPreview => {
      this.options.advanceRequestDeadlines(now);
      const currentAccounts = this.selectAll<AccountExportRow>("accounts");
      const currentContext = this.selectAll<ActiveAccountContextExportRow>("active_account_context");
      return {
        status: "valid",
        format: envelope.format,
        network: envelope.network,
        exportedAt: envelope.exportedAt,
        currentCounts: this.getDataCountsSync(),
        incomingCounts: countsForPayload(envelope.data),
        willReplace: true,
        activeAccountChange: activeAccountChange(
          currentAccounts,
          currentContext,
          envelope.data.accounts,
          envelope.data.activeAccountContext
        ),
        currentReadAddress: activeAccountAddress(currentAccounts, currentContext),
        incomingReadAddress: activeAccountAddress(envelope.data.accounts, envelope.data.activeAccountContext),
        restartRequiredAfterImport: true,
      };
    }).immediate();
  }

  async importLocalDataReplace(input: unknown, _now = new Date()): Promise<LocalDataMutationResult> {
    const envelope = await this.parseAndVerifyImportEnvelope(input);
    const result = this.db.transaction(() => this.applyValidatedReplacement(envelope, this.now()))();
    this.notifyDataReplaced();
    return result;
  }

  async resetLocalData(now = this.now()): Promise<LocalDataMutationResult> {
    const result = this.db.transaction(() => this.applyValidatedReplacement(undefined, now))();
    this.notifyDataReplaced();
    return result;
  }

  // The caller commits this primitive with the admitted Settings card/result.
  // It contains no async gap or post-commit reconstruction of its own authority.
  applyValidatedReplacement(envelope: LocalDataEnvelope | undefined, now: Date, preserveCardId?: string): LocalDataMutationResult {
    this.options.advanceRequestDeadlines(now);
    this.assertReplacementAllowed(now);
    this.resetLocalDataTables(preserveCardId);
    if (envelope) {
      this.insertAccounts(envelope.data.accounts);
      this.insertActiveAccountContext(envelope.data.activeAccountContext);
      this.insertReviewSessions(envelope.data.reviewSessions);
      this.insertReviewStateSnapshots(envelope.data.reviewStateSnapshots);
      this.insertReviewRequests(envelope.data.reviewRequests);
      this.insertReviewStatusTransitions(envelope.data.reviewStatusTransitions);
      this.insertReviewExecutions(envelope.data.reviewExecutions);
      this.insertExternalActivityScans(envelope.data.externalActivityScans);
      this.insertExternalActivityTransactions(envelope.data.externalActivityTransactions);
      this.insertLocalSettings(envelope.data.localSettings);
      this.syncSqliteSequences(envelope.data);
    } else this.insertDefaultSuiGrpcUrl(now);
    this.db.prepare("UPDATE settings_control SET data_epoch=data_epoch+1 WHERE id=1").run();
    if (preserveCardId) this.db.prepare(`UPDATE settings_operations SET data_epoch=(SELECT data_epoch FROM settings_control WHERE id=1)
      WHERE card_id=?`).run(preserveCardId);
    return { status: envelope ? "imported" : "reset", dataCounts: this.getDataCountsSync(), sessionsInvalidated: true };
  }

  notifyDataReplaced(): void { this.options.onDataReplaced?.(); }

  private resetLocalDataTables(preserveCardId?: string): void {
    this.db.prepare("UPDATE settings_files SET invalidated=1 WHERE role='upload'").run();
    if (preserveCardId) {
      // Deleted cards cannot report or retry their cleanup. Transfer cleanup
      // responsibility while preserving file identities and public backup paths.
      // Uploads remain invalidated and never replace the selected input.
      const operation = this.db.prepare("SELECT operation_id FROM settings_operations WHERE card_id=?").get(preserveCardId) as { operation_id: string } | undefined;
      if (!operation) throw new LocalDataError("internal_error", "The replacement result identity is unavailable.");
      this.db.prepare(`UPDATE settings_files SET cleanup_operation_id=? WHERE cleanup!='complete'
        AND (role='export' OR invalidated=1)`).run(operation.operation_id);
      this.db.prepare("DELETE FROM live_read_cards WHERE id!=?").run(preserveCardId);
    }
    else this.db.prepare("DELETE FROM live_read_cards").run();
    for (const table of [
      "live_execution_details",
      "live_request_authority",
      "live_transaction_materials",
      "live_private_review_artifacts",
      "live_review_sessions",
      "external_activity_transactions",
      "external_activity_scans",
      "review_state_snapshots",
      "review_status_transitions",
      "review_executions",
      "review_requests",
      "review_sessions",
      "coin_metadata_cache",
      "active_account_context",
      "accounts",
      "local_settings"
    ]) {
      this.db.prepare(`DELETE FROM ${table}`).run();
    }
    this.db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('accounts', 'review_state_snapshots', 'review_status_transitions')").run();
  }

  private insertDefaultSuiGrpcUrl(now: Date): void {
    const statement = this.db.prepare(
      `INSERT INTO local_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)`
    );
    statement.run("suiGrpcUrl", JSON.stringify(parseGrpcUrl(this.options.suiGrpcUrl)), now.toISOString());
    statement.run("suiGraphqlUrl", JSON.stringify(parseGraphqlUrl(this.options.suiGraphqlUrl)), now.toISOString());
  }

  getDataCountsSync(): LocalDataCounts {
    return {
      accounts: this.count("accounts"),
      reviewSessions: this.count("review_sessions"),
      reviewStateSnapshots: this.count("review_state_snapshots"),
      reviewStatusTransitions: this.count("review_status_transitions"),
      reviewExecutions: this.count("review_executions"),
      reviewRequests: this.count("review_requests"),
      outcomeUnknownRequests: (this.db.prepare("SELECT COUNT(*) AS count FROM review_requests WHERE request_status='outcome_unknown'").get() as CountRow).count,
      externalActivityScans: this.count("external_activity_scans"),
      externalActivityTransactions: this.count("external_activity_transactions"),
      localSettings: this.count("local_settings")
    };
  }

  private count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow).count;
  }

  private selectAll<T>(table: string): T[] {
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all() as T[];
  }

  private insertAccounts(rows: AccountExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO accounts (id, sui_address, first_seen_at, last_used_at, first_source, last_source)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(row.id, row.sui_address, row.first_seen_at, row.last_used_at, row.first_source, row.last_source);
    }
  }

  private insertActiveAccountContext(rows: ActiveAccountContextExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO active_account_context (id, account_id, source, set_at, wallet_name, wallet_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(row.id, row.account_id, row.source, row.set_at, row.wallet_name ?? null, row.wallet_id ?? null);
    }
  }

  private insertReviewSessions(rows: ReviewSessionExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO review_sessions
        (id, plan_id, action_kind, adapter_id, protocol, account_id, current_status, plan_json, intent_json, created_at, updated_at, current_attempt_id, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(
        row.id,
        row.plan_id,
        row.action_kind,
        row.adapter_id,
        row.protocol,
        row.account_id,
        row.current_status,
        row.plan_json,
        row.intent_json,
        row.created_at,
        row.updated_at, row.current_attempt_id, row.opened_at
      );
    }
  }

  private insertReviewStateSnapshots(rows: ReviewStateSnapshotExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO review_state_snapshots
        (id, review_session_id, plan_id, account_id, status, blocked_reason, refresh_reason, state_json, updated_at, recorded_at, review_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(
        row.id,
        row.review_session_id,
        row.plan_id,
        row.account_id,
        row.status,
        row.blocked_reason,
        row.refresh_reason,
        row.state_json,
        row.updated_at,
        row.recorded_at, row.review_revision
      );
    }
  }

  private insertReviewStatusTransitions(rows: ReviewStatusTransitionExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO review_status_transitions
        (id, review_session_id, event, from_status, to_status, account_id, reason, transitioned_at, domain, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(
        row.id,
        row.review_session_id,
        row.event,
        row.from_status,
        row.to_status,
        row.account_id,
        row.reason,
        row.transitioned_at, row.domain, row.attempt_id
      );
    }
  }

  private insertReviewRequests(rows: ReviewRequestExportRow[]): void {
    const insert = this.db.prepare(`INSERT INTO review_requests
      (attempt_id,review_session_id,plan_id,review_revision,account_id,transaction_digest,review_state_json,request_status,
       revision,reason,created_at,updated_at,signature_verified_at,submitted_at)
      VALUES (@attempt_id,@review_session_id,@plan_id,@review_revision,@account_id,@transaction_digest,@review_state_json,@request_status,
       @revision,@reason,@created_at,@updated_at,@signature_verified_at,@submitted_at)`);
    for (const row of rows) insert.run(row);
  }

  private insertReviewExecutions(rows: ReviewExecutionExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO review_executions
        (review_session_id, plan_id, account_id, status, tx_digest, explorer_url, failure_reason, result_json, recorded_at, updated_at, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(
        row.review_session_id,
        row.plan_id,
        row.account_id,
        row.status,
        row.tx_digest,
        row.explorer_url,
        row.failure_reason,
        row.result_json,
        row.recorded_at,
        row.updated_at, row.attempt_id
      );
    }
  }

  private insertExternalActivityScans(rows: ExternalActivityScanExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO external_activity_scans
        (scan_id, kind, account_id, relationship, input_digest, from_checkpoint, to_checkpoint,
         from_timestamp, to_timestamp, limit_count, request_cursor, response_cursor, endpoint_host,
         chain_identifier, fetched_at, stored_count, skipped_count, has_more, window_complete,
         incomplete_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(
        row.scan_id,
        row.kind,
        row.account_id,
        row.relationship,
        row.input_digest,
        row.from_checkpoint,
        row.to_checkpoint,
        row.from_timestamp,
        row.to_timestamp,
        row.limit_count,
        row.request_cursor,
        row.response_cursor,
        row.endpoint_host,
        row.chain_identifier,
        row.fetched_at,
        row.stored_count,
        row.skipped_count,
        row.has_more,
        row.window_complete,
        row.incomplete_reason
      );
    }
  }

  private insertExternalActivityTransactions(rows: ExternalActivityTransactionExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO external_activity_transactions
        (account_id, digest, relationship, checkpoint, timestamp, status, known_sender_account_id,
         first_scan_id, last_scan_id, first_fetched_at, last_fetched_at, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(
        row.account_id,
        row.digest,
        row.relationship,
        row.checkpoint,
        row.timestamp,
        row.status,
        row.known_sender_account_id,
        row.first_scan_id,
        row.last_scan_id,
        row.first_fetched_at,
        row.last_fetched_at,
        row.detail_json
      );
    }
  }

  private insertLocalSettings(rows: LocalSettingExportRow[]): void {
    const statement = this.db.prepare(
      `INSERT INTO local_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)`
    );
    for (const row of rows) {
      statement.run(row.key, row.value_json, row.updated_at);
    }
  }

  private syncSqliteSequences(data: LocalDataPayload): void {
    const sequenceRows = [
      ["accounts", maxNumber(data.accounts.map((row) => row.id))],
      ["review_state_snapshots", maxNumber(data.reviewStateSnapshots.map((row) => row.id))],
      ["review_status_transitions", maxNumber(data.reviewStatusTransitions.map((row) => row.id))]
    ] as const;
    const update = this.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?");
    const insert = this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
    for (const [name, seq] of sequenceRows) {
      if (seq > 0) {
        const result = update.run(seq, name);
        if (result.changes === 0) {
          insert.run(name, seq);
        }
      }
    }
  }

  // Preparation and final replacement use the same rule without starting wallet I/O.
  assertReplacementAllowed(now = this.now()): void {
    if (hasUnsettledWalletWork(this.db, now)) throw new LocalDataError("input_invalid", "A wallet request is still unsettled.", { reason: "wallet_request_unsettled" });
  }

  async parseAndVerifyImportEnvelope(input: unknown): Promise<LocalDataEnvelope> {
    const envelope = parseLocalDataEnvelope(input, {
      validateAdapterLifecycle: this.validateAdapterLifecycle
    });
    await this.verifyImportedSuiGrpcUrl(suiGrpcUrlFromPayload(envelope.data));
    await this.verifyImportedSuiGraphqlUrl(suiGraphqlUrlFromPayload(envelope.data));
    return envelope;
  }

  private async verifyImportedSuiGrpcUrl(url: string): Promise<void> {
    try {
      await this.options.verifySuiGrpcUrl(url);
    } catch (error) {
      if (error instanceof SuiEndpointError) {
        throw invalidBackup("invalid_sui_grpc_url_endpoint", { endpointReason: error.kind });
      }
      throw new LocalDataError("internal_error", "Could not verify imported Sui gRPC endpoint", {
        message: "Could not verify imported Sui gRPC endpoint"
      });
    }
  }

  private async verifyImportedSuiGraphqlUrl(url: string): Promise<void> {
    try {
      await this.options.verifySuiGraphqlUrl(url);
    } catch (error) {
      if (error instanceof SuiEndpointError) {
        throw invalidBackup("invalid_sui_graphql_url_endpoint", { endpointReason: error.kind });
      }
      throw new LocalDataError("internal_error", "Could not verify imported Sui GraphQL endpoint", {
        message: "Could not verify imported Sui GraphQL endpoint"
      });
    }
  }
}
