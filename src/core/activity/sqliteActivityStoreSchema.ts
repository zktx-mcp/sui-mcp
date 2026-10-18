import Database from "better-sqlite3";
import { EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT } from "./activityStore.js";
import { ActivityDatabaseFormatError, type SqliteDatabase } from "./sqliteActivityStoreTypes.js";
import { SETTINGS_RESET_PREPARATION_SQL } from "../session/settingsPreparationSql.js";
import { WALLET_CHAINS } from "../session/chainAccounts.js";
import {
  LIVE_REVIEW_SESSION_INSERT_TRIGGER,
  LIVE_REVIEW_SESSION_UPDATE_TRIGGER,
  LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION
} from "../session/liveReviewSessionContract.js";

const EXTERNAL_ACTIVITY_SCAN_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_external_activity_scans_account_fetched
  ON external_activity_scans(account_id, fetched_at)`;
const WALLET_CHAIN_SQL = WALLET_CHAINS.map((chain) => `'${chain}'`).join(",");

const CURRENT_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id TEXT NOT NULL CHECK (chain_id IN (${WALLET_CHAIN_SQL})),
      address TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      first_source TEXT NOT NULL CHECK (first_source IN ('wallet_connection', 'review_execution')),
      last_source TEXT NOT NULL CHECK (last_source IN ('wallet_connection', 'review_execution')),
      UNIQUE (chain_id,address)
    );

    CREATE TABLE IF NOT EXISTS review_sessions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      current_status TEXT NOT NULL CHECK (current_status IN ('proposed','awaiting_wallet','wallet_connected','ready_for_wallet_review','refresh_required','blocked','expired')),
      current_attempt_id TEXT,
      opened_at TEXT,
      plan_json TEXT NOT NULL,
      intent_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_review_sessions_account_created
      ON review_sessions(account_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_review_sessions_status_account
      ON review_sessions(current_status, account_id, created_at);

    CREATE TABLE IF NOT EXISTS review_state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_revision INTEGER NOT NULL CHECK (review_revision >= 0),
      review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('ready_for_wallet_review', 'refresh_required', 'blocked')),
      blocked_reason TEXT,
      refresh_reason TEXT,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      CHECK (
        (status = 'blocked' AND blocked_reason IS NOT NULL AND refresh_reason IS NULL)
        OR (status = 'refresh_required' AND refresh_reason IS NOT NULL AND blocked_reason IS NULL)
        OR (status = 'ready_for_wallet_review' AND blocked_reason IS NULL AND refresh_reason IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_review_state_snapshots_session_recorded
      ON review_state_snapshots(review_session_id, recorded_at);

    CREATE TABLE IF NOT EXISTS review_status_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE RESTRICT,
      event TEXT NOT NULL CHECK (
        event IN ('created', 'opened', 'wallet_connected', 'state_computed', 'request_admitted', 'request_status_changed', 'signature_verified', 'chain_result_recorded', 'review_update_failed', 'review_invalidated', 'expired')
      ),
      attempt_id TEXT,
      domain TEXT NOT NULL DEFAULT 'review' CHECK (domain IN ('review', 'request')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      reason TEXT,
      transitioned_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_review_transitions_session_time
      ON review_status_transitions(review_session_id, transitioned_at);

    CREATE TABLE IF NOT EXISTS review_requests (
      attempt_id TEXT PRIMARY KEY,
      review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL,
      review_revision INTEGER NOT NULL CHECK (review_revision >= 0),
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      transaction_digest TEXT NOT NULL,
      review_state_json TEXT NOT NULL,
      request_status TEXT NOT NULL CHECK (request_status IN ('awaiting_signature', 'submitting', 'awaiting_chain_result', 'stopped', 'request_failed', 'outcome_unknown', 'completed')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      signature_verified_at TEXT,
      submitted_at TEXT,
      UNIQUE (review_session_id, review_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_review_requests_session ON review_requests(review_session_id, created_at);
    CREATE TABLE IF NOT EXISTS review_executions (
      attempt_id TEXT PRIMARY KEY REFERENCES review_requests(attempt_id) ON DELETE RESTRICT,
      review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
      tx_digest TEXT NOT NULL,
      explorer_url TEXT,
      failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason = 'chain_execution_failed'),
      result_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'failure' AND failure_reason IS NOT NULL) OR (status = 'success' AND failure_reason IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_review_executions_account_updated ON review_executions(account_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_review_executions_digest ON review_executions(tx_digest);
    CREATE TABLE IF NOT EXISTS live_execution_details (
      attempt_id TEXT PRIMARY KEY REFERENCES review_requests(attempt_id) ON DELETE RESTRICT,
      model_json TEXT NOT NULL,
      display_json TEXT
    );
    CREATE TABLE IF NOT EXISTS live_wallet_connections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      run_id TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      topic TEXT UNIQUE,
      current_slot INTEGER UNIQUE CHECK (current_slot IS NULL OR current_slot=1),
      data_epoch INTEGER NOT NULL CHECK (data_epoch >= 0),
      read_address_cleared INTEGER NOT NULL DEFAULT 0 CHECK (read_address_cleared IN (0,1)),
      connection_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_connection_operations (
      operation_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      data_epoch INTEGER NOT NULL CHECK (data_epoch >= 0),
      action TEXT NOT NULL CHECK (action IN ('connect','disconnect')),
      connection_id TEXT NOT NULL REFERENCES live_wallet_connections(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stopped')),
      input_json TEXT NOT NULL,
      result_json TEXT,
      sdk_pending INTEGER NOT NULL CHECK (sdk_pending IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_connection_pending ON wallet_connection_operations(connection_id,sdk_pending);
    CREATE TRIGGER IF NOT EXISTS wallet_connection_result_immutable
    BEFORE UPDATE ON wallet_connection_operations WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
    BEGIN SELECT RAISE(ABORT,'Account management results are immutable'); END;
    CREATE TABLE IF NOT EXISTS live_request_authority (
      attempt_id TEXT PRIMARY KEY REFERENCES review_requests(attempt_id) ON DELETE RESTRICT,
      owner_id TEXT NOT NULL,
      run_id TEXT,
      connection_id TEXT NOT NULL REFERENCES live_wallet_connections(id) ON DELETE RESTRICT,
      grant_revision INTEGER NOT NULL,
      can_submit INTEGER NOT NULL CHECK (can_submit IN (0,1)),
      sdk_pending INTEGER NOT NULL CHECK (sdk_pending IN (0,1)),
      submit_pending INTEGER NOT NULL CHECK (submit_pending IN (0,1)),
      lookup_pending INTEGER NOT NULL CHECK (lookup_pending IN (0,1)),
      signature_deadline TEXT NOT NULL,
      lookup_deadline TEXT,
      observation_stopped INTEGER NOT NULL DEFAULT 0 CHECK (observation_stopped IN (0,1))
    );

    ${externalActivityScansTableSql()};

    ${EXTERNAL_ACTIVITY_SCAN_INDEX_SQL};

    CREATE TABLE IF NOT EXISTS external_activity_transactions (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      digest TEXT NOT NULL,
      relationship TEXT NOT NULL CHECK (relationship IN ('affected', 'sent')),
      checkpoint TEXT,
      timestamp TEXT,
      status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'unknown')),
      known_sender_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      first_scan_id TEXT NOT NULL REFERENCES external_activity_scans(scan_id) ON DELETE RESTRICT,
      last_scan_id TEXT NOT NULL REFERENCES external_activity_scans(scan_id) ON DELETE RESTRICT,
      first_fetched_at TEXT NOT NULL,
      last_fetched_at TEXT NOT NULL,
      detail_json TEXT,
      PRIMARY KEY (account_id, digest, relationship)
    );

    CREATE INDEX IF NOT EXISTS idx_external_activity_transactions_account_time
      ON external_activity_transactions(account_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_external_activity_transactions_digest
      ON external_activity_transactions(digest);

    CREATE TABLE IF NOT EXISTS local_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coin_metadata_cache (
      coin_type TEXT NOT NULL,
      chain_identifier TEXT NOT NULL,
      decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 255),
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (coin_type, chain_identifier)
    );


    CREATE TABLE IF NOT EXISTS live_transaction_materials (
      material_id TEXT PRIMARY KEY,
      review_session_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      account TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      transaction_bytes BLOB NOT NULL,
      redacted_diagnostics_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_live_transaction_materials_session
      ON live_transaction_materials(review_session_id);

    CREATE TABLE IF NOT EXISTS live_review_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      account TEXT,
      owner_id TEXT NOT NULL,
      review_revision INTEGER NOT NULL DEFAULT 0,
      preparation_id TEXT,
      preparation_run_id TEXT,
      preparation_error TEXT,
      wallet_connection_id TEXT,
      wallet_grant_revision INTEGER,
      current_attempt_id TEXT,
      plans_json TEXT NOT NULL,
      review_state_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      write_contract_version TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_private_review_artifacts (
      review_session_id TEXT PRIMARY KEY
        REFERENCES live_review_sessions(id) ON DELETE CASCADE,
      artifacts_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_read_cards (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('account', 'receipt', 'chart', 'connect', 'disconnect', 'review', 'settings')),
      state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'closed')),
      reason TEXT CHECK (reason IN ('completed', 'expired', 'failed', 'server_restarted', 'cancelled')),
      error TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      input_json TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'connect', 'disconnect', 'review', 'review_manage', 'settings')),
      operation_id TEXT,
      accepted_input_json TEXT,
      result_json TEXT,
      receipt_display_json TEXT,
      CHECK ((state = 'closed' AND reason IS NOT NULL) OR (state != 'closed' AND reason IS NULL)),
      CHECK (state != 'running' OR accepted_input_json IS NOT NULL),
      CHECK (receipt_display_json IS NULL OR (kind = 'receipt' AND reason = 'completed'))
    );
    CREATE INDEX IF NOT EXISTS idx_live_read_cards_owner_state ON live_read_cards(owner_id, state);
    CREATE TABLE IF NOT EXISTS settings_control (
      id INTEGER PRIMARY KEY CHECK (id=1),
      data_epoch INTEGER NOT NULL DEFAULT 0 CHECK (data_epoch BETWEEN 0 AND 9007199254740991),
      user_data_revision INTEGER NOT NULL DEFAULT 0 CHECK (user_data_revision BETWEEN 0 AND 9007199254740991),
      active_operation_id TEXT,
      file_io_id TEXT,
      wallet_input_blocked INTEGER NOT NULL DEFAULT 0 CHECK (wallet_input_blocked IN (0,1)),
      wallet_block_operation_id TEXT
    );
    INSERT INTO settings_control (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS settings_operations (
      operation_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE REFERENCES live_read_cards(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      data_epoch INTEGER NOT NULL CHECK (data_epoch BETWEEN 0 AND 9007199254740991),
      kind TEXT,
      phase TEXT NOT NULL CHECK (phase IN ('draft','uploading','sealed','prepared','executing','stopping','starting','terminal')),
      draft_json TEXT,
      preparation_id TEXT,
      fingerprint TEXT,
      prepared_user_data_revision INTEGER,
      preparation_json TEXT,
      file_id TEXT,
      accepted_digest TEXT,
      admitted_at TEXT,
      result_json TEXT,
      prior_run_id TEXT,
      next_run_id TEXT,
      supersedes_operation_id TEXT,
      superseded_by_operation_id TEXT,
      CHECK ((phase='terminal' AND result_json IS NOT NULL) OR (phase!='terminal' AND result_json IS NULL))
    );
    CREATE TRIGGER IF NOT EXISTS settings_immutable_result
    BEFORE UPDATE ON settings_operations WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
    BEGIN SELECT RAISE(ABORT, 'settings terminal result is immutable'); END;
    CREATE TABLE IF NOT EXISTS settings_files (
      file_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      cleanup_operation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('upload','export')),
      relative_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      total_size INTEGER NOT NULL CHECK (total_size BETWEEN 0 AND 9007199254740991),
      received_size INTEGER NOT NULL CHECK (received_size BETWEEN 0 AND total_size),
      sha256 TEXT NOT NULL,
      sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),
      invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0,1)),
      cleanup TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup IN ('pending','complete','failed')),
      reservation_json TEXT
    );
    ${settingsRevisionTriggers()}

    CREATE TRIGGER IF NOT EXISTS live_read_cards_insert_revision
    BEFORE INSERT ON live_read_cards WHEN NEW.revision != 0
    BEGIN SELECT RAISE(ABORT, 'card insert requires revision zero'); END;
    CREATE TRIGGER IF NOT EXISTS live_card_terminal_immutable
    BEFORE UPDATE ON live_read_cards WHEN OLD.state='closed'
    BEGIN SELECT RAISE(ABORT, 'Closed card results and permissions are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS live_read_cards_update_revision
    BEFORE UPDATE ON live_read_cards WHEN NEW.revision != OLD.revision + 1
    BEGIN SELECT RAISE(ABORT, 'card update requires the next revision'); END;

    CREATE TRIGGER IF NOT EXISTS ${LIVE_REVIEW_SESSION_INSERT_TRIGGER}
    BEFORE INSERT ON live_review_sessions
    FOR EACH ROW
    WHEN NEW.revision IS NULL
      OR NEW.revision != 0
      OR NEW.write_contract_version IS NULL
      OR NEW.write_contract_version != '${LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION}'
    BEGIN
      SELECT RAISE(ABORT, 'live review session insert requires the hardened write contract');
    END;

    CREATE TRIGGER IF NOT EXISTS ${LIVE_REVIEW_SESSION_UPDATE_TRIGGER}
    BEFORE UPDATE ON live_review_sessions
    FOR EACH ROW
    WHEN NEW.revision IS NULL
      OR OLD.revision IS NULL
      OR NEW.revision != OLD.revision + 1
      OR NEW.write_contract_version IS NULL
      OR NEW.write_contract_version != '${LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION}'
    BEGIN
      SELECT RAISE(ABORT, 'live review session update requires the hardened write contract');
    END;
  `;

export function configureDatabase(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
}

// SQLite normalizes its own DDL. Compare only schema metadata, never user rows.
// The reference is built once from the single current schema, not from the DB being checked.
let currentSchemaSignature: string | undefined;
function schemaSignature(db: SqliteDatabase): string {
  return JSON.stringify(db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all());
}
function expectedSchemaSignature(): string {
  if (currentSchemaSignature !== undefined) return currentSchemaSignature;
  const reference = new Database(":memory:");
  try {
    reference.exec(CURRENT_SCHEMA_SQL);
    currentSchemaSignature = schemaSignature(reference);
    return currentSchemaSignature;
  } finally {
    reference.close();
  }
}

export function assertCurrentDatabaseFormat(db: SqliteDatabase): "empty" | "current" {
  const signature = schemaSignature(db);
  if (signature === "[]" && !db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) return "empty";
  if (signature === expectedSchemaSignature()) return "current";
  throw new ActivityDatabaseFormatError();
}

export function initializeDatabase(db: SqliteDatabase): void {
  if (assertCurrentDatabaseFormat(db) === "current") return;
  db.transaction(() => {
    db.exec(CURRENT_SCHEMA_SQL);
  })();
}

function externalActivityScansTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS external_activity_scans (
    scan_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('digest_lookup', 'account_scan', 'function_scan')),
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL CHECK (relationship IN ('affected', 'sent')),
    input_digest TEXT,
    from_checkpoint TEXT,
    to_checkpoint TEXT,
    from_timestamp TEXT,
    to_timestamp TEXT,
    limit_count INTEGER NOT NULL CHECK (limit_count >= 1 AND limit_count <= ${EXTERNAL_ACTIVITY_SCAN_MAX_LIMIT}),
    request_cursor TEXT,
    response_cursor TEXT,
    endpoint_host TEXT NOT NULL,
    chain_identifier TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    stored_count INTEGER NOT NULL CHECK (stored_count >= 0),
    skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
    has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
    window_complete INTEGER CHECK (window_complete IN (0, 1)),
    incomplete_reason TEXT CHECK (
      incomplete_reason IS NULL
      OR incomplete_reason IN ('limit_reached', 'ordering_unverified', 'cursor_invalid', 'provider_error')
    )
  )`;
}

// Exported user data has one durable revision, including writers outside Settings.
// A prepared confirmation is invalidated once, in the writer's own transaction.
function settingsRevisionTriggers(): string {
  const userTables = ["accounts", "review_sessions", "review_state_snapshots",
    "review_status_transitions", "review_executions", "review_requests", "external_activity_scans",
    "external_activity_transactions", "local_settings"];
  const walletTables = ["live_wallet_connections", "wallet_connection_operations", "live_review_sessions", "live_request_authority"];
  const invalidate = (condition: string) => `
    UPDATE live_read_cards SET revision=revision+1
      WHERE state!='closed' AND id IN (SELECT card_id FROM settings_operations WHERE phase='prepared' AND (${condition}));
    ${SETTINGS_RESET_PREPARATION_SQL}
      WHERE phase='prepared' AND (${condition});`;
  return [...new Set([...userTables, ...walletTables])].flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((event) => `
      CREATE TRIGGER settings_revision_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
      BEGIN
        ${userTables.includes(table) ? "UPDATE settings_control SET user_data_revision=user_data_revision+1 WHERE id=1;" : ""}
        ${invalidate([...(userTables.includes(table) ? ["kind IN ('import_local_data','reset_local_data')"] : []),
          ...(walletTables.includes(table) || table === "review_requests" ? ["kind='restart_wallet_service'"] : []),
          ...(table === "local_settings" ? ["kind IN ('set_endpoint','restore_endpoint')", `kind='set_wallet_networks' AND ${event === "DELETE" ? "OLD" : "NEW"}.key='walletConnectionChains'`] : [])].join(" OR ") || "0")}
      END;`)).join("\n");
}
