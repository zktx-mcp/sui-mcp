// Run after building. Uses only synthetic public accounts and an isolated SQLite database.
import assert from "node:assert/strict";
import { SqliteActivityStore } from "../../dist/core/activity/sqliteActivityStore.js";
import { validateSealedBackup } from "../../dist/runtime/localBackupWorker.js";
import { validateSupportedAdapterLifecycle } from "../../dist/adapters/adapterLifecycleValidators.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../../dist/runtime/suiEndpoint.js";

const store = new SqliteActivityStore({ databasePath: ":memory:", validateAdapterLifecycle: validateSupportedAdapterLifecycle });
const data = store.createLocalDataService({ advanceRequestDeadlines() {}, suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
  verifySuiGrpcUrl() {}, verifySuiGraphqlUrl() {} });
try {
  await store.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL }, new Date(0));
  const original = data.exportLocalDataSync(new Date(0));
  const incoming = structuredClone(original);
  for (let i = 1; i <= 52_000; i++) incoming.data.accounts.push({
    id: i, chain_id: "sui:mainnet", address: "0x" + i.toString(16).padStart(64, "0"),
    first_seen_at: original.exportedAt, last_used_at: original.exportedAt, first_source: "wallet_connection", last_source: "wallet_connection"
  });
  for (const valid of [true, false]) {
    if (!valid) incoming.data.accounts[0].id = -1;
    const file = Buffer.from(JSON.stringify(incoming));
    assert.ok(file.length > 8 * 1024 * 1024 && file.length <= 16 * 1024 * 1024);
    let otherReads = 0, maxRss = process.memoryUsage.rss();
    const timer = setInterval(() => {
      data.currentDataCountsSync();
      otherReads++;
      maxRss = Math.max(maxRss, process.memoryUsage.rss());
    }, 10);
    const start = performance.now();
    try {
      if (valid) {
        const approved = await validateSealedBackup(file);
        assert.equal(approved.data.accounts.length, incoming.data.accounts.length);
        assert.equal(data.previewValidatedImport(approved, new Date(0)).status, "valid");
      } else {
        await assert.rejects(validateSealedBackup(file), err => err.details?.reason === "invalid_backup_shape");
      }
    } finally { clearInterval(timer); }
    assert.ok(otherReads > 0);
    assert.deepEqual(data.exportLocalDataSync(new Date(0)), original);
    console.log(JSON.stringify({ valid, fileBytes: file.length, accountRows: incoming.data.accounts.length,
      otherReads, elapsedMs: Math.round(performance.now() - start), sampledPeakRssMiB: Math.round(maxRss / 1048576) }));
  }
} finally { store.close(); }
