import { isDeepStrictEqual } from "node:util";
import type {
  ActionPlan,
  InternalSessionStatus,
  ReviewSession,
  ReviewState
} from "../action/types.js";
import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import {
  clonePrivateReviewArtifacts,
  type PrivateReviewArtifactStore,
  type PrivateReviewArtifacts
} from "./privateReviewArtifacts.js";
import type { SessionRecordStore } from "./sessionRecordStore.js";
import { LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION } from "./liveReviewSessionContract.js";
import { INITIAL_CHAIN_OBSERVATION_STATUSES } from "./transactionRequest.js";

export type LiveReviewSessionRow = {
  id: string;
  token_hash: string;
  status: string;
  account: string | null;
  owner_id: string;
  review_revision: number;
  preparation_id: string | null;
  preparation_error: string | null;
  wallet_connection_id: string | null;
  wallet_grant_revision: number | null;
  current_attempt_id: string | null;
  plans_json: string;
  review_state_json: string | null;
  created_at: string;
  expires_at: string;
  last_activity_at: string;
  revision: number;
  write_contract_version: string;
};

export function insertLiveReviewSessionRow(db: SqliteDatabase, session: ReviewSession): void {
  const serialized = serializeSessionForLiveReviewSessionRow(session);
  db.prepare(
    `INSERT INTO live_review_sessions
       (id, token_hash, status, account, owner_id, review_revision, preparation_id, preparation_error, wallet_connection_id, wallet_grant_revision, current_attempt_id,
        plans_json, review_state_json,
        created_at, expires_at, last_activity_at, revision, write_contract_version)
     VALUES
       (@id, @tokenHash, @status, @account, @ownerId, @reviewRevision, @preparationId, @preparationError, @walletConnectionId, @walletGrantRevision, @currentAttemptId,
        @plansJson, @reviewStateJson,
        @createdAt, @expiresAt, @lastActivityAt, 0, @writeContractVersion)`
  ).run(serialized);
}

export function updateLiveReviewSessionRow(
  db: SqliteDatabase,
  expectedRevision: number,
  session: ReviewSession
): boolean {
  const serialized = serializeSessionForLiveReviewSessionRow(session);
  const result = db
    .prepare(
      `UPDATE live_review_sessions
       SET token_hash = @tokenHash,
           status = @status,
           account = @account,
           owner_id = @ownerId,
           review_revision = @reviewRevision,
           preparation_id = @preparationId,
           preparation_error = @preparationError,
           wallet_connection_id = @walletConnectionId,
           wallet_grant_revision = @walletGrantRevision,
           current_attempt_id = @currentAttemptId,
           plans_json = @plansJson,
           review_state_json = @reviewStateJson,
           created_at = @createdAt,
           expires_at = @expiresAt,
           last_activity_at = @lastActivityAt,
           revision = revision + 1,
           write_contract_version = @writeContractVersion
       WHERE id = @id AND revision = @expectedRevision`
    )
    .run({ ...serialized, expectedRevision });
  return result.changes > 0;
}

export type SqliteSessionRecordStoreOptions = {
  usesActivityStoreLiveSessionMutations?: boolean;
};

/**
 * SQLite-backed live review-session records. Runtime product transitions are
 * committed by SqliteActivityStore when the store is created through that owner,
 * so live session state and review activity stay in one SQLite transaction.
 * Direct instances keep a low-level transition commit path for tests and mixed
 * harnesses that do not couple live state with activity rows.
 */
export class SqliteSessionRecordStore implements SessionRecordStore {
  readonly usesActivityStoreLiveSessionMutations: boolean;

  constructor(
    private readonly db: SqliteDatabase,
    options: SqliteSessionRecordStoreOptions = {}
  ) {
    this.usesActivityStoreLiveSessionMutations = options.usesActivityStoreLiveSessionMutations === true;
  }

  get(id: string): ReviewSession | undefined {
    const row = this.db
      .prepare(`SELECT * FROM live_review_sessions WHERE id = ?`)
      .get(id) as LiveReviewSessionRow | undefined;
    return row ? sessionFromLiveReviewSessionRow(row) : undefined;
  }

  revision(id: string): number | undefined { return this.getRow(id)?.revision; }
  hasAdmittedRevision(id: string, reviewRevision: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM review_requests WHERE review_session_id=? AND review_revision=?").get(id, reviewRevision);
  }

  create(id: string, session: ReviewSession): void {
    if (this.getRow(id)) {
      throw new Error(`Review session already exists: ${id}`);
    }
    insertLiveReviewSessionRow(this.db, session);
  }

  commitReviewSessionTransition(id: string, expected: ReviewSession, next: ReviewSession): boolean {
    const commit = this.db.transaction(() => {
      const row = this.getRow(id);
      if (!row || !isDeepStrictEqual(sessionFromLiveReviewSessionRow(row), expected)) {
        return false;
      }
      return updateLiveReviewSessionRow(this.db, row.revision, next);
    });
    return commit.immediate();
  }

  ids(): string[] {
    const rows = this.db.prepare(`SELECT id FROM live_review_sessions`).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM live_review_sessions`).run();
  }

  hasUnsettledRequest(id: string, now: Date): boolean {
    return !!this.db.prepare(`SELECT 1 FROM live_request_authority l JOIN review_requests r ON r.attempt_id=l.attempt_id
      WHERE r.review_session_id=? AND (l.sdk_pending=1 OR l.submit_pending=1 OR l.lookup_pending=1
        OR (r.request_status IN (SELECT value FROM json_each(?)) AND (l.lookup_deadline IS NULL OR l.lookup_deadline>?))) LIMIT 1`)
      .get(id, JSON.stringify(INITIAL_CHAIN_OBSERVATION_STATUSES), now.toISOString());
  }
  private getRow(id: string): LiveReviewSessionRow | undefined {
    return this.db.prepare("SELECT * FROM live_review_sessions WHERE id=?").get(id) as LiveReviewSessionRow | undefined;
  }
}

export class SqlitePrivateReviewArtifactStore implements PrivateReviewArtifactStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(reviewSessionId: string): PrivateReviewArtifacts | undefined {
    const row = this.db
      .prepare(`SELECT artifacts_json FROM live_private_review_artifacts WHERE review_session_id = ?`)
      .get(reviewSessionId) as { artifacts_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    // clonePrivateReviewArtifacts re-parses/validates the evidence on read, matching
    // the in-memory store's clone-on-read behaviour.
    return clonePrivateReviewArtifacts(JSON.parse(row.artifacts_json) as PrivateReviewArtifacts);
  }

  set(reviewSessionId: string, artifacts: PrivateReviewArtifacts): void {
    const json = JSON.stringify(clonePrivateReviewArtifacts(artifacts));
    this.db
      .prepare(
        `INSERT INTO live_private_review_artifacts (review_session_id, artifacts_json)
         VALUES (?, ?)
         ON CONFLICT(review_session_id) DO UPDATE SET artifacts_json = excluded.artifacts_json`
      )
      .run(reviewSessionId, json);
  }

  delete(reviewSessionId: string): void {
    this.db.prepare(`DELETE FROM live_private_review_artifacts WHERE review_session_id = ?`).run(reviewSessionId);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM live_private_review_artifacts`).run();
  }
}

// Reconstruct the ReviewSession from columns + JSON blobs. Optional fields are
// omitted (not set to undefined) so the shape matches the in-memory store exactly.
export function sessionFromLiveReviewSessionRow(row: LiveReviewSessionRow): ReviewSession {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    status: row.status as InternalSessionStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastActivityAt: row.last_activity_at,
    plans: JSON.parse(row.plans_json) as ActionPlan[],
    ...(row.account === null ? {} : { account: row.account }),
    ...(row.review_state_json === null
      ? {}
      : { reviewState: JSON.parse(row.review_state_json) as ReviewState }),
    ownerId: row.owner_id,
    reviewRevision: row.review_revision,
    ...(row.wallet_connection_id === null ? {} : { walletConnectionId: row.wallet_connection_id }),
    ...(row.wallet_grant_revision === null ? {} : { walletGrantRevision: row.wallet_grant_revision }),
    ...(row.preparation_error === null ? {} : { preparationError: row.preparation_error }),
    ...(row.preparation_id === null ? {} : { preparationId: row.preparation_id }),
    ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id })
  };
}

export function serializeSessionForLiveReviewSessionRow(session: ReviewSession): Record<string, unknown> {
  return {
    id: session.id,
    tokenHash: session.tokenHash,
    status: session.status,
    account: session.account ?? null,
    ownerId: session.ownerId,
    reviewRevision: session.reviewRevision,
    preparationId: session.preparationId ?? null,
    preparationError: session.preparationError ?? null,
    walletConnectionId: session.walletConnectionId ?? null,
    walletGrantRevision: session.walletGrantRevision ?? null,
    currentAttemptId: session.currentAttemptId ?? null,
    plansJson: JSON.stringify(session.plans),
    reviewStateJson: session.reviewState ? JSON.stringify(session.reviewState) : null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastActivityAt: session.lastActivityAt,
    writeContractVersion: LIVE_REVIEW_SESSION_WRITE_CONTRACT_VERSION
  };
}
