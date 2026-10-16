import { seedCurrentReadAccount } from "./fixtures/readAccount.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ActionPlan, ReviewSession, ReviewState } from "../src/core/action/types.js";
import { SqliteActivityStore } from "../src/core/activity/sqliteActivityStore.js";
import {
  configureDatabase,
  initializeDatabase
} from "../src/core/activity/sqliteActivityStoreSchema.js";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import { SqliteSessionRecordStore } from "../src/core/session/sqliteSessionStore.js";
import type { SessionRecordStore } from "../src/core/session/sessionRecordStore.js";

const walletAccount = `0x${"a".repeat(64)}`;

const plan: ActionPlan = {
  id: "plan_1",
  actionKind: "swap",
  adapterId: "deepbook-swap",
  protocol: "DeepBookV3",
  title: "Review swap",
  summary: "Review a swap",
  assetFlowPreview: {
    outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
    expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }]
  },
  adapterData: {},
  createdAt: "2026-06-26T00:00:00.000Z"
};

function readyReviewState(reviewSessionId = "review_1"): ReviewState {
  return {
    planId: plan.id,
    reviewSessionId,
    account: walletAccount,
    status: "ready_for_wallet_review",
    checks: [],
    updatedAt: "2026-06-26T00:00:00.000Z"
  };
}

function readySession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: "review_1",
    tokenHash: "token_hash", ownerId: "fixture-owner", reviewRevision: 0,
    status: "ready_for_wallet_review",
    account: walletAccount,
    plans: [plan],
    reviewState: readyReviewState(),
    createdAt: "2026-06-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:30:00.000Z",
    lastActivityAt: "2026-06-26T00:00:00.000Z",
    ...overrides
  };
}

function awaitingWalletSession(): ReviewSession {
  return {
    id: "review_1",
    tokenHash: "token_hash", ownerId: "fixture-owner", reviewRevision: 0,
    status: "awaiting_wallet",
    plans: [plan],
    createdAt: "2026-06-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:30:00.000Z",
    lastActivityAt: "2026-06-26T00:00:00.000Z"
  };
}

function withTwoStores<T>(fn: (stores: {
  first: SessionRecordStore;
  second: SessionRecordStore;
  firstDb: Database.Database;
  secondDb: Database.Database;
}) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sui-mcp-shared-state-baseline-"));
  const dbPath = join(dir, "sui-mcp.sqlite");
  const firstDb = new Database(dbPath);
  const secondDb = new Database(dbPath);
  try {
    for (const db of [firstDb, secondDb]) {
      configureDatabase(db);
      initializeDatabase(db);
    }
    return fn({
      first: new SqliteSessionRecordStore(firstDb),
      second: new SqliteSessionRecordStore(secondDb),
      firstDb,
      secondDb
    });
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("shared SQLite state hardening baseline", () => {

  it("prevents stale active-account binding from overwriting the committed account", () => {
    withTwoStores(({ first, second }) => {
      first.create("review_1", awaitingWalletSession());
      const staleForBinding = first.get("review_1")!;
      const secondCurrent = second.get("review_1")!;

      expect(second.commitReviewSessionTransition("review_1", secondCurrent, {
        ...secondCurrent,
        account: `0x${"b".repeat(64)}`,
        lastActivityAt: "2026-06-26T00:00:09.000Z"
      })).toBe(true);
      expect(first.commitReviewSessionTransition("review_1", staleForBinding, {
        ...staleForBinding,
        status: "wallet_connected",
        account: walletAccount,
        lastActivityAt: "2026-06-26T00:00:10.000Z"
      })).toBe(false);

      expect(second.get("review_1")).toMatchObject({
        account: `0x${"b".repeat(64)}`
      });
    });
  });

  it("rejects revision-unaware SQL writers after the hardened schema exists", () => {
    withTwoStores(({ first, secondDb }) => {
      first.create("review_1", readySession());

      expect(() => {
        secondDb
          .prepare(
            `UPDATE live_review_sessions
             SET status = 'refresh_required'
             WHERE id = ?`
          )
          .run("review_1");
      }).toThrow("hardened write contract");

      expect(first.get("review_1")).toMatchObject({
        status: "ready_for_wallet_review"
      });

      expect(() => {
        secondDb
          .prepare(
            `INSERT INTO live_review_sessions
               (id, token_hash, status, plans_json, created_at, expires_at, last_activity_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "review_2",
            "token_hash",
            "proposed",
            JSON.stringify([plan]),
            "2026-06-26T00:00:00.000Z",
            "2026-06-26T00:30:00.000Z",
            "2026-06-26T00:00:00.000Z"
          );
      }).toThrow();
    });
  });

  it("refuses legacy live review sessions without rewriting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "sui-mcp-live-session-migration-"));
    const dbPath = join(dir, "sui-mcp.sqlite");
    const db = new Database(dbPath);
    try {
      configureDatabase(db);
      db.exec(`
        CREATE TABLE live_review_sessions (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          account TEXT,
          pending_handoff_digest TEXT,
          plans_json TEXT NOT NULL,
          review_state_json TEXT,
          execution_result_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL
        );
        CREATE TABLE live_private_review_artifacts (
          review_session_id TEXT PRIMARY KEY
            REFERENCES live_review_sessions(id) ON DELETE CASCADE,
          artifacts_json TEXT NOT NULL
        );
      `);
      const session = readySession();
      db.prepare(
        `INSERT INTO live_review_sessions
           (id, token_hash, status, account, pending_handoff_digest, plans_json,
            review_state_json, execution_result_json, created_at, expires_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        session.id,
        session.tokenHash,
        session.status,
        session.account ?? null,
        null,
        JSON.stringify(session.plans),
        JSON.stringify(session.reviewState),
        null,
        session.createdAt,
        session.expiresAt,
        session.lastActivityAt
      );
      db.prepare(`INSERT INTO live_private_review_artifacts (review_session_id, artifacts_json) VALUES (?, ?)`)
        .run(session.id, JSON.stringify({ transactionMaterial: { materialId: "material_1" } }));

      expect(() => initializeDatabase(db)).toThrow("format does not match");
      expect(db.prepare("SELECT plans_json FROM live_review_sessions WHERE id = ?").get(session.id))
        .toEqual({ plans_json: JSON.stringify(session.plans) });
      expect((db.prepare("SELECT COUNT(*) AS count FROM live_private_review_artifacts").get() as { count: number }).count).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back audit writes when a stale live-session transition loses the race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sui-mcp-shared-state-activity-"));
    const dbPath = join(dir, "sui-mcp.sqlite");
    const firstStore = new SqliteActivityStore({
      databasePath: dbPath,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    const secondStore = new SqliteActivityStore({
      databasePath: dbPath,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    const observerDb = new Database(dbPath);
    try {
      const firstSessions = firstStore.createSessionRecordStore();
      const secondSessions = secondStore.createSessionRecordStore();
      const initial = readySession();
      expect(
        await firstStore.recordReviewSessionWithLiveSession?.(
          {
            reviewSessionId: initial.id,
            plan,
            currentStatus: initial.status,
            createdAt: initial.createdAt
          },
          { next: initial }
        )
      ).toBe(true);

      const firstExpected = firstSessions.get(initial.id)!;
      const staleForExpiry = secondSessions.get(initial.id)!;
      const updatedSession: ReviewSession = {
        ...firstExpected, reviewRevision: 1,
        lastActivityAt: "2026-06-26T00:00:10.000Z"
      };
      await firstStore.recordReviewStateSnapshotWithLiveSession(
        { reviewSessionId: initial.id, fromStatus: firstExpected.status, state: updatedSession.reviewState!,
          reviewRevision: 1, recordedAt: updatedSession.lastActivityAt },
        { expected: firstExpected, next: updatedSession }
      );

      const expiredSession: ReviewSession = {
        ...staleForExpiry,
        status: "expired",
        lastActivityAt: "2026-06-26T00:00:11.000Z"
      };
      const staleCommitted = await secondStore.recordReviewTransitionWithLiveSession?.(
        {
          reviewSessionId: initial.id,
          event: "expired",
          fromStatus: staleForExpiry.status,
          toStatus: "expired",
          transitionedAt: "2026-06-26T00:00:11.000Z"
        },
        { expected: staleForExpiry, next: expiredSession, deleteTransactionMaterials: true }
      );

      expect(staleCommitted).toBe(false);
      expect(firstSessions.get(initial.id)).toMatchObject({
        status: "ready_for_wallet_review", reviewRevision: 1
      });
      expect(
        (
          observerDb
            .prepare(`SELECT COUNT(*) AS count FROM review_status_transitions WHERE event = 'expired'`)
            .get() as { count: number }
        ).count
      ).toBe(0);
      expect(
        (
          observerDb
            .prepare(`SELECT status, review_revision FROM review_state_snapshots WHERE review_session_id = ?`)
            .get(initial.id) as { status: string; review_revision: number }
        )
      ).toEqual({ status: "ready_for_wallet_review", review_revision: 1 });
    } finally {
      observerDb.close();
      firstStore.close();
      secondStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds the reviewed account without retargeting it to a concurrent default change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sui-mcp-active-account-binding-"));
    const dbPath = join(dir, "sui-mcp.sqlite");
    const firstStore = new SqliteActivityStore({
      databasePath: dbPath,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    const secondStore = new SqliteActivityStore({
      databasePath: dbPath,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    const observerDb = new Database(dbPath);
    try {
      const sessions = firstStore.createSessionRecordStore();
      const initial = awaitingWalletSession();
      expect(
        await firstStore.recordReviewSessionWithLiveSession?.(
          {
            reviewSessionId: initial.id,
            plan,
            currentStatus: initial.status,
            createdAt: initial.createdAt
          },
          { next: initial }
        )
      ).toBe(true);
      await seedCurrentReadAccount(firstStore, walletAccount, new Date("2026-06-26T00:00:01.000Z"));
      const staleExpected = sessions.get(initial.id)!;
      await seedCurrentReadAccount(secondStore, `0x${"b".repeat(64)}`, new Date("2026-06-26T00:00:02.000Z"));

      await expect(
        firstStore.recordReviewTransitionWithLiveSession?.(
          {
            reviewSessionId: initial.id,
            event: "wallet_connected",
            fromStatus: initial.status,
            toStatus: "wallet_connected",
            account: walletAccount,
            transitionedAt: "2026-06-26T00:00:03.000Z"
          },
          {
            expected: staleExpected,
            next: {
              ...staleExpected,
              status: "wallet_connected",
              account: walletAccount,
              lastActivityAt: "2026-06-26T00:00:03.000Z"
            }
          }
        )
      ).resolves.toBe(true);

      expect(sessions.get(initial.id)).toMatchObject({ status: "wallet_connected", account: walletAccount });
      expect((await firstStore.getActiveAccount())?.address).toBe(`0x${"b".repeat(64)}`);
      expect(
        (
          observerDb
            .prepare(`SELECT COUNT(*) AS count FROM review_status_transitions WHERE event = 'wallet_connected'`)
            .get() as { count: number }
        ).count
      ).toBe(1);
    } finally {
      observerDb.close();
      firstStore.close();
      secondStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
