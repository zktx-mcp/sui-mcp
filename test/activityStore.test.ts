import { seedCurrentReadAccount } from "./fixtures/readAccount.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import type { ActionPlan, ReviewState } from "../src/core/action/types.js";
import {
  type ActivityStore,
  ActivityStoreReadError,
  REVIEW_ACTIVITY_DETAIL_MAX_ITEMS
} from "../src/core/activity/activityStore.js";
import { EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES } from "../src/core/activity/transactionActivityDetails.js";
import type { ExternalActivityTransactionDetail } from "../src/core/activity/transactionActivityDetails.js";
import {
  ACTIVITY_DATABASE_FILENAME,
  resolveActivityDatabasePath,
  SqliteActivityStore
} from "../src/core/activity/sqliteActivityStore.js";
import { SuiEndpointError } from "../src/core/suiEndpoint.js";
import { InMemoryActivityStore } from "./fixtures/inMemoryActivityStore.js";

const walletAccount = `0x${"a".repeat(64)}`;
const otherWalletAccount = `0x${"b".repeat(64)}`;

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
  createdAt: new Date(0).toISOString()
};

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function externalActivityDetail(
  amountRaw: string,
  owner = walletAccount
): ExternalActivityTransactionDetail {
  return {
    transactionKind: "ProgrammableTransaction",
    moveCalls: [],
    balanceChanges: [
      {
        index: 0,
        owner,
        coinType: "0x2::sui::SUI",
        amountRaw,
        direction: amountRaw.startsWith("-") ? "decrease" : "increase"
      }
    ],
    objectChanges: [],
    events: [],
    truncation: {
      moveCalls: false,
      balanceChanges: false,
      objectChanges: false,
      events: false
    }
  };
}

function planFor(id: string, requestedIntent?: unknown): ActionPlan {
  return {
    ...plan,
    id,
    adapterData: requestedIntent === undefined ? {} : { requestedIntent },
    createdAt: iso(0)
  };
}

function withTempDb<T>(fn: (store: SqliteActivityStore, dbPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "sui-mcp-activity-test-"));
  const dbPath = join(dir, "sui-mcp.sqlite");
  const store = newTestSqliteActivityStore(dbPath);
  return fn(store, dbPath).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

async function withCoverageStores(fn: (store: ActivityStore) => Promise<void>): Promise<void> {
  await withTempDb(async (store) => {
    await fn(store);
  });
  await fn(new InMemoryActivityStore());
}

function newTestSqliteActivityStore(databasePath: string): SqliteActivityStore {
  return new SqliteActivityStore({
    databasePath,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle
  });
}

function localDataOptions(
  suiGrpcUrl = "https://fullnode.mainnet.sui.io:443",
  suiGraphqlUrl = "https://graphql.mainnet.sui.io/graphql"
) {
  return {
    suiGrpcUrl,
    suiGraphqlUrl,
    // These local-data fixtures contain stored history, not live wallet authority.
    advanceRequestDeadlines: (_now: Date) => {},
    verifySuiGrpcUrl: async (_url: string) => {},
    verifySuiGraphqlUrl: async (_url: string) => {}
  };
}

function externalActivityScansCreateSql(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_activity_scans'")
    .get() as { sql: string } | undefined;
  if (!row) {
    throw new Error("external_activity_scans table missing");
  }
  return row.sql;
}

function createIncompatibleExternalActivityTables(
  db: Database.Database,
  options: { includeDetails: boolean; invalidScanReference?: boolean } = { includeDetails: true }
): void {
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      first_seen_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      first_source TEXT NOT NULL CHECK (first_source IN ('wallet_connection', 'review_execution')),
      last_source TEXT NOT NULL CHECK (last_source IN ('wallet_connection', 'review_execution'))
    );
    INSERT INTO accounts
      (id, address, first_seen_at, last_used_at, first_source, last_source)
    VALUES
      (1, '${walletAccount}', '2026-05-11T00:00:00.000Z', '2026-05-11T00:00:00.000Z', 'wallet_connection', 'wallet_connection');

    CREATE TABLE external_activity_scans (
      scan_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('digest_lookup', 'account_scan')),
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      relationship TEXT NOT NULL CHECK (relationship IN ('affected', 'sent')),
      input_digest TEXT,
      from_checkpoint TEXT,
      to_checkpoint TEXT,
      from_timestamp TEXT,
      to_timestamp TEXT,
      limit_count INTEGER NOT NULL CHECK (limit_count >= 1 AND limit_count <= 100),
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
    );
    CREATE INDEX idx_external_activity_scans_account_fetched
      ON external_activity_scans(account_id, fetched_at);
    INSERT INTO external_activity_scans
      (scan_id, kind, account_id, relationship, input_digest, from_checkpoint, to_checkpoint,
       from_timestamp, to_timestamp, limit_count, request_cursor, response_cursor, endpoint_host,
       chain_identifier, fetched_at, stored_count, skipped_count, has_more, window_complete,
       incomplete_reason)
    VALUES
      ('scan_legacy', 'account_scan', 1, 'sent', NULL, NULL, NULL, NULL, NULL, 100, NULL, NULL,
       'graphql.mainnet.sui.io', 'mainnet-chain', '2026-05-11T00:00:00.000Z', 1, 0, 0, 1, NULL);

    CREATE TABLE external_activity_transactions (
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
      last_fetched_at TEXT NOT NULL
      ${options.includeDetails ? ", detail_json TEXT" : ""}
      ,
      PRIMARY KEY (account_id, digest, relationship)
    );
    INSERT INTO external_activity_transactions
      (account_id, digest, relationship, checkpoint, timestamp, status, known_sender_account_id,
       first_scan_id, last_scan_id, first_fetched_at, last_fetched_at${options.includeDetails ? ", detail_json" : ""})
    VALUES
      (1, '${"5".repeat(44)}', 'sent', '100', '2026-05-11T00:00:00.000Z', 'success', 1,
       ${options.invalidScanReference ? "'missing_scan'" : "'scan_legacy'"},
       ${options.invalidScanReference ? "'missing_scan'" : "'scan_legacy'"},
       '2026-05-11T00:00:00.000Z', '2026-05-11T00:00:00.000Z'${options.includeDetails ? ", NULL" : ""});
    PRAGMA foreign_keys=ON;
  `);
}

async function recordConnectedReview(
  store: SqliteActivityStore,
  input: {
    reviewSessionId: string;
    planId: string;
    account: string;
    createdAtSeconds: number;
    state?: ReviewState["status"] | undefined;
    requestedIntent?: unknown;
  }
): Promise<void> {
  const reviewPlan = planFor(input.planId, input.requestedIntent);
  await store.recordReviewSession({
    reviewSessionId: input.reviewSessionId,
    plan: reviewPlan,
    currentStatus: "proposed",
    createdAt: iso(input.createdAtSeconds)
  });
  store.createWalletWorkflowStore("activity-fixture").markReviewOpened(input.reviewSessionId, new Date(iso(input.createdAtSeconds + 1)));
  await store.recordReviewTransition({
    reviewSessionId: input.reviewSessionId,
    event: "wallet_connected",
    fromStatus: "awaiting_wallet",
    toStatus: "wallet_connected",
    account: input.account,
    transitionedAt: iso(input.createdAtSeconds + 2)
  });
  if (input.state) {
    await store.recordReviewStateSnapshot({
      reviewRevision: 1,
      reviewSessionId: input.reviewSessionId,
      fromStatus: "wallet_connected",
      state: reviewStateFor(input.reviewSessionId, input.planId, input.account, input.state, iso(input.createdAtSeconds + 3)),
      recordedAt: iso(input.createdAtSeconds + 3)
    });
  }

}

function reviewStateFor(
  reviewSessionId: string,
  planId: string,
  account: string,
  status: ReviewState["status"],
  updatedAt: string
): ReviewState {
  if (status === "blocked") {
    return {
      reviewSessionId,
      planId,
      account,
      status,
      blockedReason: "adapter_not_implemented",
      checks: [],
      updatedAt
    };
  }
  if (status === "refresh_required") {
    return {
      reviewSessionId,
      planId,
      account,
      status,
      refreshReason: "quote_stale",
      checks: [],
      updatedAt
    };
  }
  return {
    reviewSessionId,
    planId,
    account,
    status,
    checks: [],
    updatedAt
  };
}

function withNonCanonicalDeepbookLifecycle(state: ReviewState): ReviewState {
  return {
    ...state,
    adapterLifecycle: {
      stageCatalogId: "deepbook_swap_review_v1",
      adapterId: "deepbook-swap",
      protocol: "DeepBookV3",
      actionKind: "swap",
      completedStages: ["intent_normalized", "quote_evidence_fetched"],
      missingStages: [
        "pool_resolved",
        "quote_policy_derived",
        "transaction_material_build_or_verify",
        "digest_commitment",
        "object_ownership",
        "human_readable_review",
        "review_time_simulation"
      ]
    }
  };
}

describe("SqliteActivityStore", () => {
  it("creates the current database and keeps schema opening idempotent", async () => {
    await withTempDb(async (_store, dbPath) => {
      const db = new Database(dbPath);
      try {
        expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
        expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
        const tables = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(tables).toEqual(
          expect.arrayContaining([
            "accounts",
            "live_wallet_connections",
            "review_sessions",
            "review_state_snapshots",
            "review_status_transitions",
            "review_executions",
            "external_activity_scans",
            "external_activity_transactions",
            "local_settings",
            "coin_metadata_cache"
          ])
        );
        const indexes = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(indexes).toEqual(
          expect.arrayContaining([
            "idx_review_sessions_account_created",
            "idx_review_sessions_status_account",
            "idx_review_state_snapshots_session_recorded",
            "idx_review_transitions_session_time",
            "idx_review_executions_account_updated",
            "idx_review_executions_digest",
            "idx_external_activity_scans_account_fetched",
            "idx_external_activity_transactions_account_time",
            "idx_external_activity_transactions_digest"
          ])
        );
        expect(externalActivityScansCreateSql(db)).toContain("'function_scan'");
      } finally {
        db.close();
      }

      const reopened = newTestSqliteActivityStore(dbPath);
      try {
        expect(await reopened.getActiveAccount()).toBeUndefined();
      } finally {
        reopened.close();
      }
    });
  });

  it("wraps activity data directory creation failures with a product error", () => {
    const dir = mkdtempSync(join(tmpdir(), "sui-mcp-data-dir-error-test-"));
    const fileParent = join(dir, "not-a-directory");
    writeFileSync(fileParent, "not a directory");
    try {
      expect(() => newTestSqliteActivityStore(join(fileParent, "db.sqlite"))).toThrow(
        "Could not create the local activity data directory"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unrelated existing SQLite schema before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sui-mcp-activity-test-"));
    const dbPath = join(dir, "sui-mcp.sqlite");
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE unrelated (value TEXT NOT NULL)");
    } finally {
      db.close();
    }
    try {
      expect(() => newTestSqliteActivityStore(dbPath)).toThrow("format does not match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("rejects an incomplete schema (details: %s) without changing its bytes", (includeDetails) => {
    const dir = mkdtempSync(join(tmpdir(), "sui-mcp-format-refusal-"));
    const path = join(dir, "sui-mcp.sqlite");
    const db = new Database(path);
    try { createIncompatibleExternalActivityTables(db, { includeDetails }); } finally { db.close(); }
    const before = readFileSync(path);
    try {
      expect(() => newTestSqliteActivityStore(path)).toThrow("format does not match");
      expect(readFileSync(path)).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("stores local settings defaults without overwriting custom values", async () => {
    await withTempDb(async (store) => {
      const preferences = store.createPreferencesRepository();
      await preferences.ensureDefaultLocalSettings(
        {
          suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
          suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
        },
        new Date("2026-05-11T00:00:00.000Z")
      );
      expect(await preferences.getSuiGrpcUrl()).toMatchObject({
        key: "suiGrpcUrl",
        value: "https://fullnode.mainnet.sui.io:443",
        updatedAt: "2026-05-11T00:00:00.000Z"
      });

      await preferences.setSuiGrpcUrl(
        "https://example.sui.provider:9000",
        new Date("2026-05-11T00:00:01.000Z")
      );
      await preferences.ensureDefaultLocalSettings(
        {
          suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
          suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
        },
        new Date("2026-05-11T00:00:02.000Z")
      );
      expect(await preferences.getSuiGrpcUrl()).toMatchObject({
        value: "https://example.sui.provider:9000",
        updatedAt: "2026-05-11T00:00:01.000Z"
      });
    });
  });

  it("keeps local settings key allowlisted and JSON encoded", async () => {
    await withTempDb(async (store, dbPath) => {
      const preferences = store.createPreferencesRepository();
      await expect(preferences.setLocalSetting("dataDir", "/tmp/nope")).rejects.toThrow(
        "Unknown local setting key"
      );
      await expect(preferences.setSuiGrpcUrl(
        "https://example.sui.provider:9000/",
        new Date("2026-05-11T00:00:00.000Z")
      )).resolves.toMatchObject({
        storedValue: "https://example.sui.provider:9000"
      });

      const db = new Database(dbPath);
      try {
        expect(
          db.prepare("SELECT value_json FROM local_settings WHERE key = ?").get("suiGrpcUrl")
        ).toEqual({
          value_json: JSON.stringify("https://example.sui.provider:9000")
        });
      } finally {
        db.close();
      }
    });
  });

  it("rejects malformed local setting JSON deterministically", async () => {
    await withTempDb(async (store, dbPath) => {
      const db = new Database(dbPath);
      try {
        db.prepare("INSERT INTO local_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
          "suiGrpcUrl",
          "{bad json",
          "2026-05-11T00:00:00.000Z"
        );
      } finally {
        db.close();
      }

      await expect(store.createPreferencesRepository().getSuiGrpcUrl()).rejects.toThrow(
        "Malformed local setting JSON"
      );
    });
  });

  it("rejects malformed local setting values deterministically", async () => {
    await withTempDb(async (store, dbPath) => {
      const db = new Database(dbPath);
      try {
        db.prepare("INSERT INTO local_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
          "suiGrpcUrl",
          JSON.stringify("https://fullnode.mainnet.sui.io:443/path"),
          "2026-05-11T00:00:00.000Z"
        );
      } finally {
        db.close();
      }

      await expect(store.createPreferencesRepository().getSuiGrpcUrl()).rejects.toThrow(
        "only scheme, host, and explicit port"
      );
    });
  });

  it("stores only fresh mainnet coin metadata cache rows by coin type and chain identifier", async () => {
    await withTempDb(async (store) => {
      const cache = store.createCoinMetadataCache();
      await cache.setCoinMetadata({
        coinType: "0x2::sui::SUI",
        chainIdentifier: "mainnet-chain",
        decimals: 9,
        symbol: "SUI",
        name: "Sui",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        expiresAt: "2026-05-12T00:00:00.000Z"
      });

      await expect(
        cache.getCoinMetadata({
          coinType: "0x2::sui::SUI",
          chainIdentifier: "mainnet-chain",
          now: new Date("2026-05-11T00:01:00.000Z")
        })
      ).resolves.toMatchObject({
        status: "hit",
        record: {
          coinType: "0x2::sui::SUI",
          chainIdentifier: "mainnet-chain",
          decimals: 9,
          symbol: "SUI"
        }
      });
      await expect(
        cache.getCoinMetadata({
          coinType: "0x2::sui::SUI",
          chainIdentifier: "mainnet-chain",
          now: new Date("2026-05-12T00:00:01.000Z")
        })
      ).resolves.toMatchObject({ status: "expired" });
      await expect(
        cache.getCoinMetadata({
          coinType: "0x2::sui::SUI",
          chainIdentifier: "other-chain",
          now: new Date("2026-05-11T00:01:00.000Z")
        })
      ).resolves.toEqual({ status: "miss" });
    });
  });

  it("records bounded external activity only for known accounts and deduplicates transactions", async () => {
    await withTempDb(async (store) => {
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await expect(
        store.recordExternalActivityScan({
          scanId: "unknown_account_scan",
          kind: "account_scan",
          account: otherWalletAccount,
          relationship: "affected",
          limit: 100,
          endpointHost: "graphql.mainnet.sui.io",
          chainIdentifier: "mainnet-chain",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          hasMore: false,
          windowComplete: true,
          transactions: []
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "account_not_known" }
      });

      await store.recordExternalActivityScan({
        scanId: "scan_1",
        kind: "account_scan",
        account: walletAccount,
        relationship: "sent",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: true,
        windowComplete: null,
        transactions: [
          {
            digest: "5".repeat(44),
            relationship: "sent",
            checkpoint: "100",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId,
            details: {
              transactionKind: "ProgrammableTransaction",
              moveCalls: [
                {
                  commandIndex: 0,
                  package: "0x2",
                  module: "coin",
                  function: "transfer",
                  target: "0x2::coin::transfer"
                }
              ],
              balanceChanges: [
                {
                  index: 0,
                  owner: walletAccount,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "-10",
                  direction: "decrease"
                }
              ],
              objectChanges: [],
              events: [],
              gas: {
                computationCostRaw: "100",
                storageCostRaw: "20",
                storageRebateRaw: "5",
                netGasCostRaw: "115"
              },
              truncation: {
                moveCalls: false,
                balanceChanges: false,
                objectChanges: false,
                events: false
              }
            }
          }
        ]
      });
      await store.recordExternalActivityScan({
        scanId: "scan_2",
        kind: "account_scan",
        account: walletAccount,
        relationship: "sent",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:01:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "5".repeat(44),
            relationship: "sent",
            checkpoint: "101",
            timestamp: "2026-05-11T00:01:00.000Z",
            status: "failure",
            knownSenderAccountId: active.accountId
          }
        ]
      });

      await expect(store.summarizeExternalActivity({ account: walletAccount })).resolves.toMatchObject({
        dataScope: { account: walletAccount },
        summary: {
          transactionCount: 1,
          statusCounts: { success: 0, failure: 1, unknown: 0 },
          relationshipCounts: { affected: 0, sent: 1 }
        },
        transactions: [
          {
            account: walletAccount,
            digest: "5".repeat(44),
            relationship: "sent",
            checkpoint: "101",
            status: "failure",
            firstScanId: "scan_1",
            lastScanId: "scan_2",
            lastScanIncompleteReason: undefined,
            details: {
              moveCalls: [{ target: "0x2::coin::transfer" }],
              balanceChanges: [{ amountRaw: "-10" }],
              gas: { netGasCostRaw: "115" }
            }
          }
        ]
      });
    });
  });

  it("summarizes stored external activity over the full scope and orders checkpoints numerically", async () => {
    await withTempDb(async (store) => {
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await store.recordExternalActivityScan({
        scanId: "scan_summary_scope",
        kind: "account_scan",
        account: walletAccount,
        relationship: "sent",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "9".repeat(44),
            relationship: "sent",
            checkpoint: "99",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "failure",
            knownSenderAccountId: active.accountId
          },
          {
            digest: "8".repeat(44),
            relationship: "sent",
            checkpoint: "100",
            timestamp: "2026-05-11T00:01:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId
          }
        ]
      });

      await expect(store.summarizeExternalActivity({ account: walletAccount, limit: 1 })).resolves.toMatchObject({
        truncated: true,
        summary: {
          transactionCount: 2,
          statusCounts: { success: 1, failure: 1, unknown: 0 },
          relationshipCounts: { sent: 2, affected: 0 },
          earliestTimestamp: "2026-05-11T00:00:00.000Z",
          latestTimestamp: "2026-05-11T00:01:00.000Z"
        },
        transactions: [
          {
            digest: "8".repeat(44),
            checkpoint: "100"
          }
        ]
      });
    });
  });

  it("reports no stored external activity coverage for a known account with no scans", async () => {
    await withCoverageStores(async (store) => {
      await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));

      await expect(
        store.getExternalActivityCoverage({
          account: walletAccount,
          from: "2026-05-11T00:00:00.000Z",
          to: "2026-05-11T01:00:00.000Z"
        })
      ).resolves.toMatchObject({
        accountKnown: true,
        coverageStatus: "no_stored_scans",
        scanCount: 0,
        storedTransactionCount: 0,
        limitations: ["no_complete_affected_account_scan", "no_stored_activity_scans"],
        scans: []
      });
    });
  });

  it("treats an enclosing complete affected-account scan as complete coverage even when it found no transactions", async () => {
    await withCoverageStores(async (store) => {
      await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await store.recordExternalActivityScan({
        scanId: "scan_empty_complete",
        kind: "account_scan",
        account: walletAccount,
        relationship: "affected",
        fromTimestamp: "2026-05-11T00:00:00.000Z",
        toTimestamp: "2026-05-11T02:00:00.000Z",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T02:00:01.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: []
      });

      await expect(
        store.getExternalActivityCoverage({
          account: walletAccount,
          from: "2026-05-11T00:30:00.000Z",
          to: "2026-05-11T01:30:00.000Z"
        })
      ).resolves.toMatchObject({
        coverageStatus: "complete",
        scanCount: 1,
        storedTransactionCount: 0,
        coverageEvidence: {
          completeAffectedAccountScanIds: ["scan_empty_complete"],
          incompleteScanIds: [],
          sentOnlyScanIds: []
        },
        limitations: []
      });
    });
  });

  it("keeps sent-only and incomplete scans as partial coverage while still reporting stored transactions", async () => {
    await withCoverageStores(async (store) => {
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await store.recordExternalActivityScan({
        scanId: "scan_sent_only",
        kind: "account_scan",
        account: walletAccount,
        relationship: "sent",
        fromTimestamp: "2026-05-11T00:00:00.000Z",
        toTimestamp: "2026-05-11T02:00:00.000Z",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T02:00:01.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "a".repeat(44),
            relationship: "sent",
            checkpoint: "100",
            timestamp: "2026-05-11T00:40:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId
          }
        ]
      });
      await store.recordExternalActivityScan({
        scanId: "scan_affected_incomplete",
        kind: "account_scan",
        account: walletAccount,
        relationship: "affected",
        fromTimestamp: "2026-05-11T00:00:00.000Z",
        toTimestamp: "2026-05-11T02:00:00.000Z",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T02:00:02.000Z",
        hasMore: true,
        windowComplete: false,
        incompleteReason: "limit_reached",
        transactions: []
      });

      await expect(
        store.getExternalActivityCoverage({
          account: walletAccount,
          from: "2026-05-11T00:30:00.000Z",
          to: "2026-05-11T01:30:00.000Z"
        })
      ).resolves.toMatchObject({
        coverageStatus: "partial",
        scanCount: 2,
        storedTransactionCount: 1,
        storedTransactionRange: {
          earliestTimestamp: "2026-05-11T00:40:00.000Z",
          latestTimestamp: "2026-05-11T00:40:00.000Z",
          earliestCheckpoint: "100",
          latestCheckpoint: "100"
        },
        coverageEvidence: {
          completeAffectedAccountScanIds: [],
          incompleteScanIds: ["scan_affected_incomplete"],
          sentOnlyScanIds: ["scan_sent_only"]
        },
        limitations: [
          "no_complete_affected_account_scan",
          "scan_window_incomplete",
          "sent_only_scan_not_full_account_coverage"
        ]
      });
    });
  });

  it("does not double-count a repeated stored digest when reporting coverage transaction count", async () => {
    await withCoverageStores(async (store) => {
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      const repeatedDigest = "b".repeat(44);
      const scanBase = {
        kind: "account_scan" as const,
        account: walletAccount,
        relationship: "affected" as const,
        fromTimestamp: "2026-05-11T00:00:00.000Z",
        toTimestamp: "2026-05-11T02:00:00.000Z",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        hasMore: false,
        windowComplete: true
      };
      await store.recordExternalActivityScan({
        ...scanBase,
        scanId: "scan_repeat_1",
        fetchedAt: "2026-05-11T02:00:01.000Z",
        transactions: [
          {
            digest: repeatedDigest,
            relationship: "affected",
            checkpoint: "100",
            timestamp: "2026-05-11T00:40:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId
          }
        ]
      });
      await store.recordExternalActivityScan({
        ...scanBase,
        scanId: "scan_repeat_2",
        fetchedAt: "2026-05-11T02:00:02.000Z",
        transactions: [
          {
            digest: repeatedDigest,
            relationship: "affected",
            checkpoint: "101",
            timestamp: "2026-05-11T00:41:00.000Z",
            status: "failure",
            knownSenderAccountId: active.accountId
          }
        ]
      });

      await expect(
        store.getExternalActivityCoverage({
          account: walletAccount,
          from: "2026-05-11T00:30:00.000Z",
          to: "2026-05-11T01:30:00.000Z"
        })
      ).resolves.toMatchObject({
        coverageStatus: "complete",
        scanCount: 2,
        storedTransactionCount: 1,
        storedTransactionRange: {
          earliestTimestamp: "2026-05-11T00:41:00.000Z",
          latestTimestamp: "2026-05-11T00:41:00.000Z",
          earliestCheckpoint: "101",
          latestCheckpoint: "101"
        },
        coverageEvidence: {
          completeAffectedAccountScanIds: ["scan_repeat_2", "scan_repeat_1"]
        }
      });
    });
  });

  it("returns canonical half-open effect transactions for account timelines", async () => {
    await withCoverageStores(async (store) => {
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      const sharedDigest = "c".repeat(44);
      const endBoundaryDigest = "d".repeat(44);
      const scanBase = {
        kind: "account_scan" as const,
        account: walletAccount,
        fromTimestamp: "2026-05-11T00:00:00.000Z",
        toTimestamp: "2026-05-11T01:00:00.000Z",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        hasMore: false,
        windowComplete: true
      };

      await store.recordExternalActivityScan({
        ...scanBase,
        scanId: "scan_timeline_sent",
        relationship: "sent",
        fetchedAt: "2026-05-11T01:00:01.000Z",
        transactions: [
          {
            digest: sharedDigest,
            relationship: "sent",
            checkpoint: "100",
            timestamp: "2026-05-11T00:10:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId,
            details: externalActivityDetail("-999")
          },
          {
            digest: endBoundaryDigest,
            relationship: "sent",
            checkpoint: "101",
            timestamp: "2026-05-11T00:20:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId,
            details: externalActivityDetail("50")
          }
        ]
      });
      await store.recordExternalActivityScan({
        ...scanBase,
        scanId: "scan_timeline_affected",
        relationship: "affected",
        fetchedAt: "2026-05-11T01:00:02.000Z",
        transactions: [
          {
            digest: sharedDigest,
            relationship: "affected",
            checkpoint: "100",
            timestamp: "2026-05-11T00:10:00.000Z",
            status: "success",
            knownSenderAccountId: active.accountId,
            details: externalActivityDetail("100")
          }
        ]
      });

      await expect(
        store.getExternalActivityCoverage({
          account: walletAccount,
          from: "2026-05-11T00:00:00.000Z",
          to: "2026-05-11T00:20:00.000Z"
        })
      ).resolves.toMatchObject({
        storedTransactionCount: 1,
        storedTransactionRange: {
          earliestTimestamp: "2026-05-11T00:10:00.000Z",
          latestTimestamp: "2026-05-11T00:10:00.000Z",
          earliestCheckpoint: "100",
          latestCheckpoint: "100"
        }
      });

      await expect(
        store.listExternalActivityEffectTransactions({
          account: walletAccount,
          from: "2026-05-11T00:00:00.000Z",
          to: "2026-05-11T00:20:00.000Z"
        })
      ).resolves.toMatchObject({
        accountKnown: true,
        transactionCount: 1,
        truncated: false,
        transactions: [
          {
            digest: sharedDigest,
            relationship: "affected",
            details: {
              balanceChanges: [{ amountRaw: "100" }]
            }
          }
        ]
      });
    });
  });

  it("rejects forbidden external activity fields before local DB write", async () => {
    await withTempDb(async (store) => {
      await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));

      await expect(
        store.recordExternalActivityScan({
          scanId: "forbidden_scan",
          kind: "digest_lookup",
          account: walletAccount,
          relationship: "sent",
          inputDigest: "6".repeat(44),
          limit: 1,
          endpointHost: "graphql.mainnet.sui.io",
          chainIdentifier: "mainnet-chain",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          hasMore: false,
          windowComplete: true,
          transactions: [
            {
              digest: "6".repeat(44),
              relationship: "sent",
              status: "success",
              bytes: "forbidden"
            } as never
          ]
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "forbidden_field" }
      });
      await expect(store.summarizeExternalActivity({ account: walletAccount })).resolves.toMatchObject({
        summary: { transactionCount: 0 }
      });
    });
  });

  it("rejects malformed and oversized external activity details before local DB write", async () => {
    await withTempDb(async (store) => {
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      const baseTransaction = {
        digest: "7".repeat(44),
        relationship: "sent" as const,
        status: "success" as const,
        knownSenderAccountId: active.accountId
      };
      const baseInput = {
        kind: "digest_lookup" as const,
        account: walletAccount,
        relationship: "sent" as const,
        inputDigest: "7".repeat(44),
        limit: 1,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [baseTransaction]
      };

      await expect(
        store.recordExternalActivityScan({
          ...baseInput,
          scanId: "scan_malformed_detail",
          transactions: [
            {
              ...baseTransaction,
              details: {
                moveCalls: [],
                balanceChanges: [],
                objectChanges: [],
                events: []
              }
            } as never
          ]
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_external_activity_detail_json" }
      });

      await expect(
        store.recordExternalActivityScan({
          ...baseInput,
          scanId: "scan_non_known_detail_owner",
          transactions: [
            {
              ...baseTransaction,
              details: {
                moveCalls: [],
                balanceChanges: [
                  {
                    index: 0,
                    owner: otherWalletAccount,
                    coinType: "0x2::sui::SUI",
                    amountRaw: "1000",
                    direction: "increase"
                  }
                ],
                objectChanges: [],
                events: [],
                truncation: {
                  moveCalls: false,
                  balanceChanges: false,
                  objectChanges: false,
                  events: false
                }
              }
            }
          ]
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_external_activity_detail_json" }
      });

      await expect(
        store.recordExternalActivityScan({
          ...baseInput,
          scanId: "scan_large_detail",
          transactions: [
            {
              ...baseTransaction,
              details: {
                moveCalls: [],
                balanceChanges: [],
                objectChanges: [],
                events: [],
                executionError: {
                  message: "x".repeat(EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES)
                },
                truncation: {
                  moveCalls: false,
                  balanceChanges: false,
                  objectChanges: false,
                  events: false
                }
              }
            }
          ]
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "external_activity_detail_too_large" }
      });

      await expect(store.summarizeExternalActivity({ account: walletAccount })).resolves.toMatchObject({
        summary: { transactionCount: 0 }
      });
    });
  });

  it("exports and imports logical local data without changing schema files directly", async () => {
    await withTempDb(async (source) => {
      await source.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
      await source.createCoinMetadataCache().setCoinMetadata({
        coinType: "0x2::sui::SUI",
        chainIdentifier: "mainnet-chain",
        decimals: 9,
        symbol: "SUI",
        name: "Sui",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        expiresAt: "2026-05-12T00:00:00.000Z"
      });
      await recordConnectedReview(source, {
        reviewSessionId: "review_export",
        planId: "plan_export",
        account: walletAccount,
        createdAtSeconds: 1,
        state: "blocked",
      });
      const knownAccount = await source.getKnownAccount(walletAccount);
      if (!knownAccount) {
        throw new Error("Expected wallet account to be recorded");
      }
      await source.recordExternalActivityScan({
        scanId: "scan_export",
        kind: "function_scan",
        account: walletAccount,
        relationship: "sent",
        limit: 5,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "7".repeat(44),
            relationship: "sent",
            checkpoint: "42",
            timestamp: "2026-05-11T00:00:00.000Z",
            status: "success",
            knownSenderAccountId: knownAccount.id
          }
        ]
      });
      const sourceLocalData = source.createLocalDataService(localDataOptions());
      const exported = await sourceLocalData.exportLocalData(new Date("2026-05-11T00:00:00.000Z"));
      expect(exported).toMatchObject({
        format: "sui-mcp.local-data",
        network: "mainnet",
        data: {
          externalActivityScans: [
            expect.objectContaining({
              kind: "function_scan"
            })
          ]
        }
      });
      expect(exported.data).not.toHaveProperty("coinMetadataCache");

      await withTempDb(async (target) => {
        await target.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
        const targetCache = target.createCoinMetadataCache();
        await targetCache.setCoinMetadata({
          coinType: "0x2::sui::SUI",
          chainIdentifier: "mainnet-chain",
          decimals: 9,
          symbol: "SUI",
          name: "Sui",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          expiresAt: "2026-05-12T00:00:00.000Z"
        });
        const targetLocalData = target.createLocalDataService(localDataOptions());
        const preview = await targetLocalData.previewImportLocalData(exported);
        expect(preview).toMatchObject({
          status: "valid",
          incomingCounts: {
            accounts: 1,
            reviewSessions: 1,
            reviewStateSnapshots: 1,
            reviewStatusTransitions: 4,
            reviewExecutions: 0,
            reviewRequests: 0,
            externalActivityScans: 1,
            externalActivityTransactions: 1,
            localSettings: 3
          },
          willReplace: true,
          restartRequiredAfterImport: true
        });
        await targetLocalData.importLocalDataReplace(exported);
        await expect(
          targetCache.getCoinMetadata({
            coinType: "0x2::sui::SUI",
            chainIdentifier: "mainnet-chain",
            now: new Date("2026-05-11T00:00:00.000Z")
          })
        ).resolves.toEqual({ status: "miss" });
        const reexported = await targetLocalData.exportLocalData(new Date("2026-05-11T00:01:00.000Z"));
        expect(reexported.data).toEqual(exported.data);
      });
    });
  });

  it("rejects local data imports with non-canonical stored adapter lifecycle snapshots", async () => {
    await withTempDb(async (source) => {
      await source.createPreferencesRepository().ensureDefaultLocalSettings({
        suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
        suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
      });
      await recordConnectedReview(source, {
        reviewSessionId: "review_noncanonical_backup",
        planId: "plan_noncanonical_backup",
        account: walletAccount,
        createdAtSeconds: 0,
        state: "blocked"
      });
      const exported = await source.createLocalDataService(localDataOptions()).exportLocalData(
        new Date("2026-05-11T00:00:00.000Z")
      );
      const snapshot = exported.data.reviewStateSnapshots[0];
      if (!snapshot) {
        throw new Error("expected review state snapshot fixture");
      }
      const invalidBackup = {
        ...exported,
        data: {
          ...exported.data,
          reviewStateSnapshots: [
            {
              ...snapshot,
              state_json: JSON.stringify(
                withNonCanonicalDeepbookLifecycle(JSON.parse(snapshot.state_json) as ReviewState)
              )
            }
          ]
        }
      };

      await withTempDb(async (target) => {
        await expect(
          target.createLocalDataService(localDataOptions()).previewImportLocalData(invalidBackup)
        ).rejects.toMatchObject({
          kind: "input_invalid",
          details: { reason: "invalid_json_shape", field: "state_json" }
        });
        await expect(
          target.createLocalDataService(localDataOptions()).importLocalDataReplace(invalidBackup)
        ).rejects.toMatchObject({
          kind: "input_invalid",
          details: { reason: "invalid_json_shape", field: "state_json" }
        });
      });
    });
  });

  it("rejects local data imports with unknown external activity scan kinds", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({
        suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
        suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
      });
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      const exported = await store
        .createLocalDataService(localDataOptions())
        .exportLocalData(new Date("2026-05-11T00:00:00.000Z"));

      await expect(
        store.createLocalDataService(localDataOptions()).previewImportLocalData({
          ...exported,
          data: {
            ...exported.data,
            externalActivityScans: [
              {
                scan_id: "scan_unknown_kind",
                kind: "package_scan",
                account_id: exported.data.accounts[0]?.id ?? 1,
                relationship: "sent",
                input_digest: null,
                from_checkpoint: null,
                to_checkpoint: null,
                from_timestamp: null,
                to_timestamp: null,
                limit_count: 1,
                request_cursor: null,
                response_cursor: null,
                endpoint_host: "graphql.mainnet.sui.io",
                chain_identifier: "mainnet-chain",
                fetched_at: "2026-05-11T00:00:00.000Z",
                stored_count: 0,
                skipped_count: 0,
                has_more: 0,
                window_complete: 1,
                incomplete_reason: null
              }
            ]
          }
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_backup_shape" }
      });
    });
  });

  it("previews address history counts without inventing active connection changes", async () => {
  await withTempDb(async (source) => {
    await source.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
    await seedCurrentReadAccount(source, otherWalletAccount, new Date(0));
    const exported = await source.createLocalDataService(localDataOptions()).exportLocalData(new Date("2026-05-11T00:00:00.000Z"));
    await withTempDb(async (target) => {
      await seedCurrentReadAccount(target, walletAccount, new Date(0));
      const preview = await target.createLocalDataService(localDataOptions()).previewImportLocalData(exported);
      expect(preview.currentCounts.accounts).toBe(1); expect(preview.incomingCounts.accounts).toBe(1);
      expect(preview).not.toHaveProperty("accountContextChanges");
      expect(await target.getActiveAccount()).toMatchObject({ address: walletAccount });
    });
  });
});

  it("rejects old or incomplete backups without filling fields or replacing current settings", async () => {
    await withTempDb(async (source) => {
      await source.createPreferencesRepository().ensureDefaultLocalSettings({
        suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
        suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
      });
      await seedCurrentReadAccount(source, walletAccount, new Date(0));
      const exported = await source.createLocalDataService(localDataOptions()).exportLocalData(new Date("2026-05-11T00:00:00.000Z"));
      const legacyData = {
        ...exported.data,
        localSettings: exported.data.localSettings.filter((row) => row.key === "suiGrpcUrl")
      } as Record<string, unknown>;
      delete legacyData.externalActivityScans;
      delete legacyData.externalActivityTransactions;
      const legacyBackup = {
        ...exported,
        data: legacyData
      };

      await withTempDb(async (target) => {
        await target.createPreferencesRepository().ensureDefaultLocalSettings({
          suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
          suiGraphqlUrl: "https://example.sui.provider/graphql"
        });
        const targetLocalData = target.createLocalDataService(localDataOptions());
        const oldFormat: Record<string, unknown> = { ...exported };
        delete oldFormat.format;
        for (const backup of [legacyBackup, oldFormat]) {
          await expect(targetLocalData.previewImportLocalData(backup)).rejects.toMatchObject({ kind: "input_invalid" });
          await expect(targetLocalData.importLocalDataReplace(backup)).rejects.toMatchObject({ kind: "input_invalid" });
        }
        await expect(target.createPreferencesRepository().getSuiGraphqlUrl()).resolves.toMatchObject({
          value: "https://example.sui.provider/graphql"
        });
      });
    });
  });

  it("rolls back invalid local data imports before replacing existing data", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      const service = store.createLocalDataService(localDataOptions());
      const exported = await service.exportLocalData(new Date("2026-05-11T00:00:00.000Z"));
      const invalid = {
        ...exported,
        data: {
          ...exported.data,
          localSettings: [
            {
              key: "suiGrpcUrl",
              value_json: JSON.stringify("https://fullnode.mainnet.sui.io/path"),
              updated_at: "2026-05-11T00:00:00.000Z"
            }
          ]
        }
      };

      await expect(service.importLocalDataReplace(invalid)).rejects.toMatchObject({
        kind: "input_invalid"
      });
      await expect(store.getActiveAccount()).resolves.toMatchObject({ address: walletAccount });
      await expect(store.createPreferencesRepository().getSuiGrpcUrl()).resolves.toMatchObject({
        value: "https://fullnode.mainnet.sui.io:443"
      });
    });
  });

  it("does not contact imported Sui gRPC endpoints while previewing local data", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      const exported = await store
        .createLocalDataService(localDataOptions())
        .exportLocalData(new Date("2026-05-11T00:00:00.000Z"));
      const customEndpointExport = {
        ...exported,
        data: {
          ...exported.data,
          localSettings: exported.data.localSettings.map((setting) =>
            setting.key === "suiGrpcUrl"
              ? {
                  ...setting,
                  value_json: JSON.stringify("https://custom.sui.provider:9443"),
                  updated_at: "2026-05-11T00:00:00.000Z"
                }
              : setting
          )
        }
      };
      const checkedUrls: string[] = [];
      const service = store.createLocalDataService({
        ...localDataOptions(),
        verifySuiGrpcUrl: async (url) => {
          checkedUrls.push(url);
          throw new SuiEndpointError("chain_identifier_mismatch", "wrong chain", {
            chainIdentifier: "wrong-chain",
            expectedChainIdentifier: "mainnet-chain"
          });
        }
      });

      await expect(service.previewImportLocalData(customEndpointExport)).resolves.toMatchObject({
        status: "valid"
      });
      await expect(service.importLocalDataReplace(customEndpointExport)).rejects.toMatchObject({
        kind: "input_invalid",
        details: {
          reason: "invalid_sui_grpc_url_endpoint",
          endpointReason: "chain_identifier_mismatch"
        }
      });
      expect(checkedUrls).toEqual(["https://custom.sui.provider:9443"]);
      await expect(store.getActiveAccount()).resolves.toMatchObject({ address: walletAccount });
      await expect(store.createPreferencesRepository().getSuiGrpcUrl()).resolves.toMatchObject({
        value: "https://fullnode.mainnet.sui.io:443"
      });
    });
  });

  it("rejects local data imports with invalid account addresses or review statuses before writing", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
      await recordConnectedReview(store, {
        reviewSessionId: "review_invalid_import",
        planId: "plan_invalid_import",
        account: walletAccount,
        createdAtSeconds: 1,
        state: "blocked"
      });
      await seedCurrentReadAccount(store, walletAccount, new Date(10));
      const service = store.createLocalDataService(localDataOptions());
      const exported = await service.exportLocalData(new Date("2026-05-11T00:00:00.000Z"));

      await expect(
        service.previewImportLocalData({
          ...exported,
          data: {
            ...exported.data,
            accounts: [{ ...exported.data.accounts[0], address: "not-an-address" }]
          }
        })
      ).rejects.toMatchObject({ kind: "input_invalid" });

      await expect(
        service.previewImportLocalData({
          ...exported,
          data: {
            ...exported.data,
            reviewSessions: [{ ...exported.data.reviewSessions[0], current_status: "unexpected_status" }]
          }
        })
      ).rejects.toMatchObject({ kind: "input_invalid" });

      await expect(store.getActiveAccount()).resolves.toMatchObject({ address: walletAccount });
    });
  });

  it("rejects local data imports that include raw external activity payload fields", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({
        suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
        suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
      });
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await store.recordExternalActivityScan({
        scanId: "scan_payload_reject",
        kind: "digest_lookup",
        account: walletAccount,
        relationship: "sent",
        inputDigest: "8".repeat(44),
        limit: 1,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "8".repeat(44),
            relationship: "sent",
            status: "success",
            knownSenderAccountId: active.accountId
          }
        ]
      });
      const service = store.createLocalDataService(localDataOptions());
      const exported = await service.exportLocalData(new Date("2026-05-11T00:00:00.000Z"));

      await expect(
        service.previewImportLocalData({
          ...exported,
          data: {
            ...exported.data,
            externalActivityTransactions: [
              {
                ...exported.data.externalActivityTransactions[0],
                rawPayload: "{}"
              }
            ]
          }
        })
      ).rejects.toMatchObject({ kind: "input_invalid" });
    });
  });

  it("rejects local data imports with malformed normalized external activity details", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({
        suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
        suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
      });
      const active = await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await store.recordExternalActivityScan({
        scanId: "scan_detail_shape_reject",
        kind: "digest_lookup",
        account: walletAccount,
        relationship: "sent",
        inputDigest: "8".repeat(44),
        limit: 1,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "8".repeat(44),
            relationship: "sent",
            status: "success",
            knownSenderAccountId: active.accountId,
            details: {
              moveCalls: [],
              balanceChanges: [],
              objectChanges: [],
              events: [],
              truncation: {
                moveCalls: false,
                balanceChanges: false,
                objectChanges: false,
                events: false
              }
            }
          }
        ]
      });
      const service = store.createLocalDataService(localDataOptions());
      const exported = await service.exportLocalData(new Date("2026-05-11T00:00:00.000Z"));
      const previewWithDetail = (detail: unknown) => service.previewImportLocalData({
        ...exported,
        data: {
          ...exported.data,
          externalActivityTransactions: [
            {
              ...exported.data.externalActivityTransactions[0],
              detail_json: JSON.stringify(detail)
            }
          ]
        }
      });

      await expect(
        previewWithDetail({
          moveCalls: [],
          balanceChanges: [],
          objectChanges: [],
          events: []
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_external_activity_detail_json" }
      });

      await expect(
        previewWithDetail({
          moveCalls: [],
          balanceChanges: [],
          objectChanges: [],
          events: [],
          truncation: {
            moveCalls: false,
            balanceChanges: false,
            objectChanges: false,
            events: false
          },
          providerPayloadSummary: "not part of the normalized detail contract"
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_external_activity_detail_json" }
      });

      await expect(
        previewWithDetail({
          moveCalls: [],
          balanceChanges: [
            {
              index: 0,
              owner: otherWalletAccount,
              coinType: "0x2::sui::SUI",
              amountRaw: "1000",
              direction: "increase"
            }
          ],
          objectChanges: [],
          events: [],
          truncation: {
            moveCalls: false,
            balanceChanges: false,
            objectChanges: false,
            events: false
          }
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_external_activity_detail_json" }
      });

      await expect(
        previewWithDetail({
          moveCalls: [],
          balanceChanges: [],
          objectChanges: [],
          events: [
            {
              sequenceNumber: "0",
              sender: otherWalletAccount,
              eventType: "0x2::event::Example"
            }
          ],
          truncation: {
            moveCalls: false,
            balanceChanges: false,
            objectChanges: false,
            events: false
          }
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "invalid_external_activity_detail_json" }
      });

      await expect(
        previewWithDetail({
          moveCalls: [],
          balanceChanges: [],
          objectChanges: [],
          events: [],
          executionError: {
            message: "x".repeat(EXTERNAL_ACTIVITY_TRANSACTION_DETAIL_JSON_MAX_BYTES)
          },
          truncation: {
            moveCalls: false,
            balanceChanges: false,
            objectChanges: false,
            events: false
          }
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { reason: "external_activity_detail_too_large" }
      });
    });
  });

  it("resets logical local data and restores the default Sui gRPC URL", async () => {
    await withTempDb(async (store) => {
      await store.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: "https://fullnode.mainnet.sui.io:443", suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql" });
      await store.createPreferencesRepository().setSuiGrpcUrl("https://example.sui.provider:9443");
      await store.createPreferencesRepository().setSuiGraphqlUrl("https://example.sui.provider/graphql");
      await recordConnectedReview(store, {
        reviewSessionId: "review_reset",
        planId: "plan_reset",
        account: walletAccount,
        createdAtSeconds: 1,
        state: "blocked"
      });
      const knownAccount = await store.getKnownAccount(walletAccount);
      if (!knownAccount) {
        throw new Error("Expected wallet account to be recorded");
      }
      await store.recordExternalActivityScan({
        scanId: "scan_reset",
        kind: "account_scan",
        account: walletAccount,
        relationship: "affected",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "9".repeat(44),
            relationship: "affected",
            status: "success",
            knownSenderAccountId: knownAccount.id
          }
        ]
      });
      const cache = store.createCoinMetadataCache();
      await cache.setCoinMetadata({
        coinType: "0x2::sui::SUI",
        chainIdentifier: "mainnet-chain",
        decimals: 9,
        symbol: "SUI",
        name: "Sui",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        expiresAt: "2026-05-12T00:00:00.000Z"
      });
      const service = store.createLocalDataService(localDataOptions());
      await service.resetLocalData(new Date("2026-05-11T00:00:00.000Z"));
      await expect(store.listReviewActivity({ account: walletAccount })).resolves.toMatchObject({
        activities: []
      });
      await expect(store.getActiveAccount()).resolves.toBeUndefined();
      await expect(store.createPreferencesRepository().getSuiGrpcUrl()).resolves.toMatchObject({
        value: "https://fullnode.mainnet.sui.io:443"
      });
      await expect(store.createPreferencesRepository().getSuiGraphqlUrl()).resolves.toMatchObject({
        value: "https://graphql.mainnet.sui.io/graphql"
      });
      await expect(store.summarizeExternalActivity({ account: walletAccount })).resolves.toMatchObject({
        summary: { transactionCount: 0 }
      });
      await expect(
        cache.getCoinMetadata({
          coinType: "0x2::sui::SUI",
          chainIdentifier: "mainnet-chain",
          now: new Date("2026-05-11T00:00:00.000Z")
        })
      ).resolves.toEqual({ status: "miss" });
    });
  });

  it("projects the current connection read address and honors Settings clearing", async () => {
    await withTempDb(async (store) => {
      const first = await seedCurrentReadAccount(store, walletAccount.toUpperCase(), new Date(0));
      expect(first).toMatchObject({
        address: walletAccount,
        source: "wallet_connection",
        setAt: new Date(0).toISOString()
      });

      const second = await seedCurrentReadAccount(store, otherWalletAccount, new Date(1));
      expect(second.address).toBe(otherWalletAccount);
      expect(await store.getActiveAccount()).toMatchObject({
        accountId: second.accountId,
        address: otherWalletAccount,
        setAt: new Date(1).toISOString()
      });

      const target = await store.getActiveAccount();
      store.createSettingsWorkflowStore("read-fixture").clearReadAddress(target!.connectionId!, target!.address);
      expect(await store.getActiveAccount()).toBeUndefined();
    });
  });

  it("preserves first account source and tracks last account source", async () => {
    await withTempDb(async (store) => {
      const initial = await store.upsertAccount(walletAccount, "wallet_connection", new Date(0));
      expect(initial).toMatchObject({
        firstSource: "wallet_connection",
        lastSource: "wallet_connection"
      });

      const reused = await store.upsertAccount(walletAccount, "review_execution", new Date(1));
      expect(reused).toMatchObject({
        id: initial.id,
        firstSource: "wallet_connection",
        lastSource: "review_execution",
        firstSeenAt: new Date(0).toISOString(),
        lastUsedAt: new Date(1).toISOString()
      });
    });
  });

  it("enforces the singleton connection slot and the read-address suppression flag", async () => {
    await withTempDb(async (store, dbPath) => {
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      const db = new Database(dbPath);
      try {
        expect(() => db.prepare("UPDATE live_wallet_connections SET current_slot=2").run()).toThrow(/CHECK constraint/);
        expect(() => db.prepare("UPDATE live_wallet_connections SET read_address_cleared=2").run()).toThrow(/CHECK constraint/);
        expect(await store.getActiveAccount()).toMatchObject({ address: walletAccount });
      } finally { db.close(); }
    });
  });

  it("records review session, state snapshots, and transitions as append-only evidence", async () => {
    await withTempDb(async (store, dbPath) => {
      const planWithIntent: ActionPlan = {
        ...plan,
        adapterData: {
          requestedIntent: {
            from: "SUI",
            to: "USDC",
            amount: "1"
          }
        }
      };
      await store.recordReviewSession({
        reviewSessionId: "review_flow",
        plan: planWithIntent,
        currentStatus: "proposed",
        createdAt: new Date(0).toISOString()
      });
      await store.recordReviewTransition({
        reviewSessionId: "review_flow",
        event: "opened",
        fromStatus: "proposed",
        toStatus: "awaiting_wallet",
        transitionedAt: new Date(1).toISOString()
      });
      await store.recordReviewTransition({
        reviewSessionId: "review_flow",
        event: "wallet_connected",
        fromStatus: "awaiting_wallet",
        toStatus: "wallet_connected",
        account: walletAccount,
        transitionedAt: new Date(2).toISOString()
      });
      await store.recordReviewStateSnapshot({
      reviewRevision: 1,
        reviewSessionId: "review_flow",
        fromStatus: "wallet_connected",
        state: {
          reviewSessionId: "review_flow",
          planId: plan.id,
          account: walletAccount,
          status: "blocked",
          blockedReason: "adapter_not_implemented",
          checks: [],
          updatedAt: new Date(3).toISOString()
        },
        recordedAt: new Date(3).toISOString()
      });
      await store.recordReviewStateSnapshot({
      reviewRevision: 1,
        reviewSessionId: "review_flow",
        fromStatus: "blocked",
        state: {
          reviewSessionId: "review_flow",
          planId: plan.id,
          account: walletAccount,
          status: "ready_for_wallet_review",
          checks: [],
          updatedAt: new Date(4).toISOString()
        },
        recordedAt: new Date(4).toISOString()
      });

      const db = new Database(dbPath);
      try {
        const session = db.prepare("SELECT current_status, intent_json FROM review_sessions WHERE id = ?").get("review_flow");
        expect(session).toMatchObject({
          current_status: "ready_for_wallet_review"
        });
        expect(JSON.parse((session as { intent_json: string }).intent_json)).toEqual({
          from: "SUI",
          to: "USDC",
          amount: "1"
        });
        const snapshotCount = db
          .prepare("SELECT COUNT(*) AS count FROM review_state_snapshots WHERE review_session_id = ?")
          .get("review_flow") as { count: number };
        expect(snapshotCount.count).toBe(2);
        const transitions = db
          .prepare(
            `SELECT event, from_status, to_status, reason
             FROM review_status_transitions
             WHERE review_session_id = ?
             ORDER BY transitioned_at, id`
          )
          .all("review_flow");
        expect(transitions).toEqual([
          { event: "created", from_status: null, to_status: "proposed", reason: null },
          { event: "opened", from_status: "proposed", to_status: "awaiting_wallet", reason: null },
          { event: "wallet_connected", from_status: "awaiting_wallet", to_status: "wallet_connected", reason: null },
          { event: "state_computed", from_status: "wallet_connected", to_status: "blocked", reason: "adapter_not_implemented" },
          { event: "state_computed", from_status: "blocked", to_status: "ready_for_wallet_review", reason: null }
        ]);
      } finally {
        db.close();
      }
    });
  });

  it("rejects forbidden JSON evidence before writing rows", async () => {
    await withTempDb(async (store, dbPath) => {
      await expect(
        store.recordReviewSession({
          reviewSessionId: "bad_review",
          plan: {
            ...plan,
            adapterData: { transactionBytes: "forbidden" }
          },
          currentStatus: "proposed",
          createdAt: new Date(0).toISOString()
        })
      ).rejects.toThrow("forbidden field");

      await expect(
        store.recordReviewSession({
          reviewSessionId: "bad_token_review",
          plan: {
            ...plan,
            adapterData: { sessionToken: "forbidden" }
          },
          currentStatus: "proposed",
          createdAt: new Date(0).toISOString()
        })
      ).rejects.toThrow("forbidden field");

      await expect(
        store.recordReviewSession({
          reviewSessionId: "bad_shape_review",
          plan: {
            ...plan,
            adapterData: null
          } as unknown as typeof plan,
          currentStatus: "proposed",
          createdAt: new Date(0).toISOString()
        })
      ).rejects.toThrow("Invalid review session action plan evidence");

      const db = new Database(dbPath);
      try {
        const count = db.prepare("SELECT COUNT(*) AS count FROM review_sessions").get() as { count: number };
        expect(count.count).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it("lists review activity with active fallback, explicit filters, inclusive ranges, and stable sorting", async () => {
    await withTempDb(async (store) => {
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      await recordConnectedReview(store, {
        reviewSessionId: "review_old",
        planId: "plan_old",
        account: walletAccount,
        createdAtSeconds: 10,
        state: "ready_for_wallet_review",
      });
      await recordConnectedReview(store, {
        reviewSessionId: "review_new",
        planId: "plan_new",
        account: walletAccount,
        createdAtSeconds: 20,
        state: "blocked"
      });
      await recordConnectedReview(store, {
        reviewSessionId: "review_other",
        planId: "plan_other",
        account: otherWalletAccount,
        createdAtSeconds: 30,
        state: "ready_for_wallet_review"
      });

      const fallback = await store.listReviewActivity({ limit: 1 });
      expect(fallback).toMatchObject({
        accountSource: "active_account_context",
        truncated: {
          activities: true,
          snapshots: false,
          transitions: false
        },
        dataScope: {
          account: walletAccount,
          recordCount: 2
        },
        lowSampleWarning: true
      });
      expect(fallback.activities.map((row) => row.reviewSessionId)).toEqual(["review_new"]);

      const explicit = await store.listReviewActivity({ account: otherWalletAccount.toUpperCase() });
      expect(explicit).toMatchObject({
        accountSource: "explicit_filter",
        dataScope: {
          account: otherWalletAccount,
          recordCount: 1
        }
      });
      expect(explicit.activities.map((row) => row.reviewSessionId)).toEqual(["review_other"]);
      expect(await store.getActiveAccount()).toMatchObject({ address: walletAccount });

      const successOnly = await store.listReviewActivity({ reviewStatus: "ready_for_wallet_review" });
      expect(successOnly.activities.map((row) => row.reviewSessionId)).toEqual(["review_old"]);

      const boundary = await store.listReviewActivity({
        from: iso(10),
        to: iso(10)
      });
      expect(boundary.activities.map((row) => row.reviewSessionId)).toEqual(["review_old"]);

      const unknown = await store.listReviewActivity({
        account: `0x${"c".repeat(64)}`
      });
      expect(unknown).toMatchObject({
        accountSource: "explicit_filter",
        dataScope: {
          account: `0x${"c".repeat(64)}`,
          recordCount: 0
        },
        lowSampleWarning: true,
        activities: []
      });
    });
  });

  it("rejects invalid review activity filters deterministically", async () => {
    await withTempDb(async (store) => {
      await expect(store.listReviewActivity({ account: "not-an-address" })).rejects.toMatchObject({
        kind: "input_invalid"
      });
      await expect(store.listReviewActivity({ from: "2026-05-11" })).rejects.toMatchObject({
        kind: "input_invalid"
      });
      await expect(store.summarizeReviewFunnel({ from: iso(2), to: iso(1) })).rejects.toMatchObject({
        kind: "input_invalid"
      });
      await expect(store.listReviewActivity({ limit: 101 })).rejects.toMatchObject({
        kind: "input_invalid"
      });
    });
  });

  it("summarizes review funnel counts and timing from transition evidence", async () => {
    await withTempDb(async (store) => {
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      await recordConnectedReview(store, {
        reviewSessionId: "review_success",
        planId: "plan_success",
        account: walletAccount,
        createdAtSeconds: 0,
        state: "blocked"
      });
      await store.recordReviewStateSnapshot({
      reviewRevision: 1,
        reviewSessionId: "review_success",
        fromStatus: "blocked",
        state: reviewStateFor("review_success", "plan_success", walletAccount, "ready_for_wallet_review", iso(4)),
        recordedAt: iso(4)
      });

      await store.recordReviewSession({
        reviewSessionId: "review_expired",
        plan: planFor("plan_expired"),
        currentStatus: "proposed",
        createdAt: iso(10)
      });
      store.createWalletWorkflowStore("activity-fixture").markReviewOpened("review_expired", new Date(iso(11)));
      await store.recordReviewTransition({
        reviewSessionId: "review_expired",
        event: "wallet_connected",
        fromStatus: "awaiting_wallet",
        toStatus: "wallet_connected",
        account: walletAccount,
        transitionedAt: iso(12)
      });
      await store.recordReviewTransition({
        reviewSessionId: "review_expired",
        event: "expired",
        fromStatus: "wallet_connected",
        toStatus: "expired",
        account: walletAccount,
        transitionedAt: iso(13)
      });

      const summary = await store.summarizeReviewFunnel({});
      expect(summary.dataScope.recordCount).toBe(2);
      expect(summary.lowSampleWarning).toBe(true);
      expect(summary.summary).toMatchObject({
        total: 2,
        opened: 2,
        walletConnected: 2,
        stateComputed: 1,
        everAwaitedChainResult: 0,
        withoutRequest: 2, withoutExecutionResult: 2,
        executionStatusCounts: { success: 0, failure: 0 },
        expiredWithoutExecutionResult: 1,
        avgCreatedToSignatureVerifiedSeconds: null,
        avgOpenedToSignatureVerifiedSeconds: null
      });
      expect(summary.summary.reviewStatusCounts.ready_for_wallet_review).toBe(1);
      expect(summary.summary.reviewStatusCounts.expired).toBe(1);
      expect(summary.summary.everReachedReviewStateCounts.blocked).toBe(1);
      expect(summary.summary.everReachedReviewStateCounts.ready_for_wallet_review).toBe(1);
    });
  });

  it("returns scoped review session detail with capped append-only evidence", async () => {
    await withTempDb(async (store) => {
      await seedCurrentReadAccount(store, walletAccount, new Date(0));
      await recordConnectedReview(store, {
        reviewSessionId: "review_detail",
        planId: "plan_detail",
        account: walletAccount,
        createdAtSeconds: 0,
        requestedIntent: { from: "SUI", to: "USDC", amount: "1" },
      });
      for (let index = 0; index < REVIEW_ACTIVITY_DETAIL_MAX_ITEMS + 1; index += 1) {
        await store.recordReviewStateSnapshot({
      reviewRevision: 1,
          reviewSessionId: "review_detail",
          fromStatus: index === 0 ? "wallet_connected" : "ready_for_wallet_review",
          state: reviewStateFor("review_detail", "plan_detail", walletAccount, "ready_for_wallet_review", iso(20 + index)),
          recordedAt: iso(20 + index)
        });
      }

      const detail = await store.getReviewSessionDetail({ reviewSessionId: "review_detail" });
      expect(detail).toMatchObject({
        accountSource: "active_account_context",
        lowSampleWarning: true,
        dataScope: {
          account: walletAccount,
          recordCount: 1
        },
        session: {
          reviewSessionId: "review_detail",
          planId: "plan_detail",
          reviewStatus: "ready_for_wallet_review"
        },
        intentJson: { from: "SUI", to: "USDC", amount: "1" },
        truncated: {
          activities: false,
          snapshots: true,
          transitions: true
        }
      });
      expect(detail.stateSnapshots).toHaveLength(REVIEW_ACTIVITY_DETAIL_MAX_ITEMS);
      expect(detail.transitions).toHaveLength(REVIEW_ACTIVITY_DETAIL_MAX_ITEMS);
      expect(detail.transitions[0]?.isNoOp).toBe(false);
      expect(detail.transitions.some((transition) => transition.isNoOp)).toBe(true);
      expect(detail.request).toBeUndefined();
      expect(detail.requests).toEqual([]);

      await expect(
        store.getReviewSessionDetail({ reviewSessionId: "review_detail", account: otherWalletAccount })
      ).rejects.toMatchObject({
        kind: "session_not_found"
      });
    });
  });

  it("treats malformed or shape-invalid persisted JSON as an internal activity read error", async () => {
    const cases: Array<{
      name: string;
      column: "plan_json" | "state_json";
      invalidJson: string;
    }> = [
      { name: "syntax-invalid plan JSON", column: "plan_json", invalidJson: "{not json" },
      { name: "shape-invalid plan JSON", column: "plan_json", invalidJson: "[]" },
      { name: "shape-invalid state JSON", column: "state_json", invalidJson: "[]" },
    ];

    for (const testCase of cases) {
      await withTempDb(async (store, dbPath) => {
        const reviewSessionId = `review_bad_json_${testCase.name.replaceAll(/[^a-z]+/g, "_")}`;
        await seedCurrentReadAccount(store, walletAccount, new Date(0));
        await recordConnectedReview(store, {
          reviewSessionId,
          planId: `plan_${reviewSessionId}`,
          account: walletAccount,
          createdAtSeconds: 0,
          state: "ready_for_wallet_review",
        });
        const db = new Database(dbPath);
        try {
          if (testCase.column === "plan_json") {
            db.prepare("UPDATE review_sessions SET plan_json = ? WHERE id = ?").run(
              testCase.invalidJson,
              reviewSessionId
            );
          } else if (testCase.column === "state_json") {
            db.prepare("UPDATE review_state_snapshots SET state_json = ? WHERE review_session_id = ?").run(
              testCase.invalidJson,
              reviewSessionId
            );
          } else {
            db.prepare("UPDATE review_executions SET result_json = ? WHERE review_session_id = ?").run(
              testCase.invalidJson,
              reviewSessionId
            );
          }
        } finally {
          db.close();
        }

        await expect(store.getReviewSessionDetail({ reviewSessionId })).rejects.toMatchObject({
          kind: "internal_error"
        });
        await expect(store.getReviewSessionDetail({ reviewSessionId })).rejects.toBeInstanceOf(
          ActivityStoreReadError
        );
      });
    }
  });

  it("rejects non-canonical adapter lifecycle before writing review state snapshots", async () => {
    await withTempDb(async (store) => {
      await store.recordReviewSession({
        reviewSessionId: "review_reject_bad_lifecycle_write",
        plan,
        currentStatus: "proposed",
        createdAt: iso(0)
      });
      await store.recordReviewTransition({
        reviewSessionId: "review_reject_bad_lifecycle_write",
        event: "opened",
        fromStatus: "proposed",
        toStatus: "awaiting_wallet",
        transitionedAt: iso(1)
      });
      await store.recordReviewTransition({
        reviewSessionId: "review_reject_bad_lifecycle_write",
        event: "wallet_connected",
        fromStatus: "awaiting_wallet",
        toStatus: "wallet_connected",
        account: walletAccount,
        transitionedAt: iso(2)
      });

      await expect(
        store.recordReviewStateSnapshot({
      reviewRevision: 1,
          reviewSessionId: "review_reject_bad_lifecycle_write",
          fromStatus: "wallet_connected",
          state: withNonCanonicalDeepbookLifecycle(
            reviewStateFor(
              "review_reject_bad_lifecycle_write",
              plan.id,
              walletAccount,
              "blocked",
              iso(3)
            )
          ),
          recordedAt: iso(3)
        })
      ).rejects.toThrow("completedStages must be the canonical DeepBook swap review lifecycle prefix");
    });
  });

  it("rejects non-canonical adapter lifecycle stored in review activity snapshots", async () => {
    await withTempDb(async (store, dbPath) => {
      const reviewSessionId = "review_bad_lifecycle_read";
      await recordConnectedReview(store, {
        reviewSessionId,
        planId: "plan_bad_lifecycle_read",
        account: walletAccount,
        createdAtSeconds: 0,
        state: "blocked"
      });
      const db = new Database(dbPath);
      try {
        const row = db
          .prepare("SELECT state_json FROM review_state_snapshots WHERE review_session_id = ?")
          .get(reviewSessionId) as { state_json: string };
        db.prepare("UPDATE review_state_snapshots SET state_json = ? WHERE review_session_id = ?").run(
          JSON.stringify(withNonCanonicalDeepbookLifecycle(JSON.parse(row.state_json) as ReviewState)),
          reviewSessionId
        );
      } finally {
        db.close();
      }

      await expect(store.getReviewSessionDetail({ reviewSessionId, account: walletAccount })).rejects.toMatchObject({
        kind: "internal_error"
      });
      await expect(store.getReviewSessionDetail({ reviewSessionId, account: walletAccount })).rejects.toBeInstanceOf(
        ActivityStoreReadError
      );
    });
  });

  it("default-fills legacy asset flow preview amount kinds while reading persisted plans", async () => {
    await withTempDb(async (store, dbPath) => {
      const reviewSessionId = "review_legacy_asset_flow_preview";
      await recordConnectedReview(store, {
        reviewSessionId,
        planId: `plan_${reviewSessionId}`,
        account: walletAccount,
        createdAtSeconds: 0,
        state: "blocked"
      });

      const legacyPlanJson = JSON.stringify({
        ...planFor(`plan_${reviewSessionId}`),
        assetFlowPreview: {
          outgoing: [{ symbol: "SUI", amount: "1" }],
          expectedIncoming: [{ symbol: "USDC", amount: "unknown", approx: true }]
        }
      });
      const db = new Database(dbPath);
      try {
        db.prepare("UPDATE review_sessions SET plan_json = ? WHERE id = ?").run(
          legacyPlanJson,
          reviewSessionId
        );
      } finally {
        db.close();
      }

      const detail = await store.getReviewSessionDetail({ reviewSessionId, account: walletAccount });
      expect(detail.planJson.assetFlowPreview.outgoing[0]).toMatchObject({
        amountKind: "display_intent"
      });
      expect(detail.planJson.assetFlowPreview.expectedIncoming[0]).toMatchObject({
        amountKind: "display_intent"
      });
    });
  });

  it("resolves data directory overrides and rejects null bytes", () => {
    expect(
      resolveActivityDatabasePath({ SUI_MCP_DATA_DIR: "/tmp/sui-mcp-test" } as NodeJS.ProcessEnv)
    ).toBe(join("/tmp/sui-mcp-test", ACTIVITY_DATABASE_FILENAME));
    expect(() =>
      resolveActivityDatabasePath({ SUI_MCP_DATA_DIR: "/tmp/bad\0path" } as NodeJS.ProcessEnv)
    ).toThrow("SUI_MCP_DATA_DIR must not contain null bytes");
  });
});


it("rejects a previous-package backup without replacing current data", async () => {
  await withTempDb(async (store) => {
    await store.createPreferencesRepository().ensureDefaultLocalSettings({
      suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
      suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
    });
    await seedCurrentReadAccount(store, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const localData = store.createLocalDataService(localDataOptions());
    const at = new Date("2026-05-11T00:00:00.000Z");
    const exported = await localData.exportLocalData(at);
    expect(exported.format).toBe("sui-mcp.local-data");
    await expect(localData.previewImportLocalData(exported)).resolves.toMatchObject({ status: "valid" });
    const previousPackage = { ...exported, format: "say-ur-intent.local-data" };
    await expect(localData.previewImportLocalData(previousPackage)).rejects.toMatchObject({ kind: "input_invalid", details: { reason: "invalid_backup_shape" } });
    await expect(localData.importLocalDataReplace(previousPackage)).rejects.toMatchObject({ kind: "input_invalid", details: { reason: "invalid_backup_shape" } });
    expect(await localData.exportLocalData(at)).toEqual(exported);
  });
});
