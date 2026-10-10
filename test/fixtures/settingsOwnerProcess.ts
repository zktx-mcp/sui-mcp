import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { SqliteActivityStore } from "../../src/core/activity/sqliteActivityStore.js";
import { LocalSessionStore } from "../../src/core/session/sessionStore.js";
import { WalletWorkflow } from "../../src/core/session/walletWorkflow.js";
import { SettingsWorkflow } from "../../src/core/session/settingsWorkflow.js";
import { settingsIdentity } from "../../src/core/session/sqliteSettingsWorkflowStore.js";
import { SettingsFileStore } from "../../src/core/session/settingsFileStore.js";
import { createReadCardStore } from "../../src/mcp-ui/readCards.js";
import { createDeepbookUsdcChartService } from "../../src/core/read/deepbookUsdcChartService.js";
import { RuntimeLocalSettingsService } from "../../src/runtime/localSettingsService.js";
import { RuntimeDataAccess } from "../../src/runtime/shared/dataAccess.js";
import { acquireDataDirectoryOwner } from "../../src/runtime/shared/ownerLease.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../../src/runtime/config.js";
import { SERVER_VERSION } from "../../src/mcp/serverInfo.js";
import { FixtureWalletRuntime } from "./walletRuntime.js";
import type { CardResponse } from "../../src/core/session/cardSession.js";
import type { SettingsDraft, SettingsView } from "../../src/core/session/settingsOperation.js";
import type { WalletTransport } from "../../src/core/session/walletConnection.js";
import { validateSupportedAdapterLifecycle } from "../../src/adapters/adapterLifecycleValidators.js";
import type { ChildProcess } from "node:child_process";
import { WalletSdkProcess } from "../../src/runtime/walletSdkProcess.js";
import { WalletSdkPeer } from "./walletSdkPeer.js";

// Separate OS parent, actual ownership lease/SQLite/Settings/files. The wallet
// service and endpoint sources are doubles; this does not prove SDK child exit.
const [directory, fault = "none"] = process.argv.slice(2);
if (!directory) throw new Error("A private test directory is required");
const send = (value: unknown) => process.send?.(value);
const hold = async (name: string) => { send({ event: "boundary", name }); await new Promise<void>(() => {}); };
let creations = 0;
const originalOpen = fs.open;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const downloadWrite = String(args[0]).endsWith(".download") && typeof args[1] === "number" && (args[1] & (constants.O_RDWR | constants.O_WRONLY));
  if (downloadWrite && fault === "unsupported_create") throw Object.assign(new Error("Unsupported fixture exclusive creation"), { code: "EOPNOTSUPP" });
  const handle = await originalOpen(...args);
  if (downloadWrite) {
    creations++;
    const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
    handle.writeFile = async (bytes, options) => {
      if (fault === "write_before") await hold(fault);
      if (fault === "write_partial") { await handle.write(Buffer.from(bytes as Uint8Array).subarray(0, 7)); await hold(fault); }
      await write(bytes, options);
      if (fault === "write_after") await hold(fault);
    };
    handle.sync = async () => { if (fault === "sync_before") await hold(fault); await sync(); if (fault === "sync_after") await hold(fault); };
  }
  return handle;
};
syncBuiltinESMExports();
const lease = acquireDataDirectoryOwner(join(directory, "activity.sqlite"));
const access = new RuntimeDataAccess(), ownerId = randomUUID(), logger = { info() {}, warn() {}, error() {} };
const activity = new SqliteActivityStore({ databasePath: join(directory, "activity.sqlite"), guardDatabase: access.guardDatabase,
  validateAdapterLifecycle: validateSupportedAdapterLifecycle });
const preferences = activity.createPreferencesRepository();
await preferences.ensureDefaultLocalSettings({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL });
const unexpected = async (): Promise<never> => { throw new Error("Unexpected external financial action"); };
const transport: WalletTransport = { connect: unexpected, sign: unexpected, disconnect: unexpected, restore: async () => [],
  session: () => undefined, inspect: (topic) => ({ topic, status: "absent" }), inspectAll: () => [], stop() {}, onSessionChanged: () => () => {} };
const peers: WalletSdkPeer[] = [];
const runtime = fault === "stopping" || fault === "starting" ? new WalletSdkProcess({ dataDirectory: directory,
  projectId: "0".repeat(32), metadata: { name: "Owner recovery fixture", description: "Synthetic OS peer", url: "https://example.invalid" },
  spawn: () => { const peer = new WalletSdkPeer(fault === "starting" && peers.length ? "hold" : "ready"); peers.push(peer); return peer as unknown as ChildProcess; } })
  : new FixtureWalletRuntime(transport);
const walletRecords = activity.createWalletWorkflowStore(ownerId, undefined, () => runtime.snapshot());
const sessions = new LocalSessionStore({ ownerId, activityStore: activity, sessions: activity.createSessionRecordStore(), logger,
  artifacts: activity.createPrivateReviewArtifactStore(), transactionMaterialStore: activity.createTransactionMaterialStore(),
  validateAdapterLifecycle: validateSupportedAdapterLifecycle });
const wallet = new WalletWorkflow({ records: walletRecords, sessions, ownerId, runtime,
  computation: { adapters: {}, validateAdapterLifecycle: validateSupportedAdapterLifecycle },
  assertCurrent: access.assertCurrent, bindExternalEvent: (work) => access.bind(work), verifyReceipt: unexpected,
  submitTransaction: unexpected, verifyNetwork: async () => {}, logger });
const records = activity.createSettingsWorkflowStore(ownerId), files = new SettingsFileStore(directory);
const local = new RuntimeLocalSettingsService({ preferencesRepository: preferences, env: {}, verifyGrpcEndpoint: async () => {
  if (fault === "verify_before") await hold(fault);
}, verifyGraphqlEndpoint: async () => {} });
const localData = activity.createLocalDataService({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
  advanceRequestDeadlines: (now) => walletRecords.advanceRequestDeadlines(now),
  verifySuiGrpcUrl: async () => { if (fault === "verify_before") await hold(fault); }, verifySuiGraphqlUrl: async () => {},
  onDataReplaced: () => { access.dataReplaced(); wallet.dataReplaced(); settings.dataReplaced(); } });
const settings = new SettingsWorkflow({ records, files, activity, preferences, localData, wallet,
  assertCurrent: access.assertCurrent, runMaintenance: (work) => access.run(work), resolveEndpoint: (input) => local.resolveEndpointChange(input), verifyEndpoint: (input) => local.prepareEndpointChange(input),
  interruptRun: (run) => walletRecords.invalidateWalletRun("wallet_service_restarted", new Date(), run),
  readFacts: async () => records.transaction(() => ({ server: { name: "sui-mcp", version: SERVER_VERSION, network: "mainnet" },
    localSettings: local.getLocalSettingsSync((key) => preferences.getLocalSettingSync(key)), counts: localData.getDataCountsSync(),
    assetReadAccount: { status: "address_required" }, walletAvailability: wallet.walletAvailability() })) });
settings.recoverOwner(); await wallet.start();
const cards = createReadCardStore({ ownerId, records: activity.createCardRecordStore(), workflow: wallet, settings, assertCurrent: access.assertCurrent,
  readService: { summarizeAccountInventory: unexpected }, publicChainReceiptReader: unexpected, chart: createDeepbookUsdcChartService() });
access.ready();
await access.run(() => settings.cleanupAfterOwnerChange());
let selectedKind: SettingsDraft["kind"] | undefined;
let card: CardResponse & { permission: string };
const data = () => card.snapshot.data as SettingsView;
async function act(input: Record<string, unknown>) {
  card = { ...await cards.act({ cardId: card.snapshot.cardId, permission: card.permission, revision: card.snapshot.revision, input }), permission: card.permission };
  if (card.error) throw new Error(card.error.message);
}
if (fault === "result_before") access.run(() => records.db.exec("CREATE TRIGGER refuse_result BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'fixture result refused'); END"));
if (fault === "result_after") access.run(() => records.db.exec(`CREATE TRIGGER refuse_finished_release BEFORE UPDATE ON settings_control
  WHEN OLD.file_io_id IS NOT NULL AND NEW.file_io_id IS NULL AND EXISTS (
    SELECT 1 FROM settings_files f JOIN settings_operations o ON o.operation_id=coalesce(f.cleanup_operation_id,f.operation_id)
    WHERE f.file_id=OLD.file_io_id AND o.phase='terminal')
  BEGIN SELECT RAISE(ABORT,'finished cleanup release refused'); END`));
process.on("message", (message: { command: "prepare" | "confirm" | "read" | "stop" | "historical_export"; draft?: SettingsDraft; reference?: { cardId: string; permission: string } }) => {
  void access.run(async () => {
    if (message.command === "historical_export") {
      // Historical input to today's recovery reader: an old-format current-DB
      // export admitted and physically published by a departed version. This
      // setup does not exercise or reintroduce a new product export action.
      card = await cards.create("settings", {});
      const operation = records.get(data().operationId)!, record = records.cards.get(card.snapshot.cardId)!;
      const bytes = Buffer.from(JSON.stringify(localData.exportLocalDataSync(new Date()))), fileId = randomUUID();
      const input = { action: "settings_confirm", operationId: operation.operationId, preparationId: randomUUID() };
      records.transaction(() => {
        records.createFile({ fileId, operationId: operation.operationId, role: "export", relativePath: `backups/${operation.operationId}.json`,
          displayName: `${operation.operationId}.json`, totalSize: bytes.length, receivedSize: 0,
          sha256: createHash("sha256").update(bytes).digest("hex"), sealed: false, invalidated: false, cleanup: "pending" });
        records.claimFinal(operation.operationId);
        records.write(operation, { ...operation, phase: "executing", draft: { kind: "export_local_data" }, fileId,
          admittedAt: new Date().toISOString(), acceptedDigest: settingsIdentity(input) }, record,
          { ...record, acceptedInput: input, state: { ...record.state, state: "running", revision: record.state.revision + 1 } });
      });
      await fs.mkdir(join(directory, "backups"), { recursive: true });
      await fs.writeFile(join(directory, "backups", `${operation.operationId}.json`), bytes, { flag: "wx" });
      send({ event: "historical_export", card });
    } else if (message.command === "prepare") {
      card = await cards.create("settings", {});
      selectedKind = message.draft?.kind;
      await activity.setActiveAccount(`0x${"a".repeat(64)}`, "wallet_connection");
      if (selectedKind === "download_backup") { send({ event: "prepared", card }); return; }
      await act({ action: "settings_select", draft: message.draft });
      if (message.draft?.kind === "import_local_data") {
        const envelope = await localData.exportLocalData(), raw = Buffer.from(JSON.stringify(envelope));
        await act({ action: "settings_begin_upload", operationId: data().operationId, name: "backup.json", totalSize: raw.length, sha256: createHash("sha256").update(raw).digest("hex") });
        const fileId = data().file!.fileId;
        await act({ action: "settings_upload_chunk", operationId: data().operationId, fileId, offset: 0, chunkBase64: raw.toString("base64") });
        await act({ action: "settings_seal_upload", operationId: data().operationId, fileId });
      }
      await act({ action: "settings_prepare", operationId: data().operationId });
      send({ event: "prepared", card });
    } else if (message.command === "confirm") {
      if (fault === "stopping") peers[0]!.killMode = "hold";
      await act(selectedKind === "download_backup" ? { action: "settings_download_backup", operationId: data().operationId, attemptId: randomUUID() }
        : { action: "settings_confirm", operationId: data().operationId, preparationId: data().preparationId });
      send({ event: "admitted", card });
      if (fault === "result_before") {
        while (!data().result) {
          try { card = { ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission }; }
          catch { await hold(fault); }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (fault === "result_after") {
        while (!records.get(data().operationId)?.result) await new Promise<void>((resolve) => setImmediate(resolve));
        card = { ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission };
        try { await act({ action: "settings_report_download", operationId: data().operationId, fileId: data().file!.fileId,
          attemptId: data().download!.currentAttemptId, status: "acknowledged" }); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes("finished cleanup release refused")) throw error; }
        while (true) {
          const operation = records.get(data().operationId)!, file = operation.fileId && records.file(operation.fileId);
          if (operation.result && file && file.cleanup === "complete" && records.control().file_io_id === file.fileId) {
            await hold(fault); break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } else if (message.command === "read") {
      const reference = message.reference ?? { cardId: card.snapshot.cardId, permission: card.permission };
      card = { ...await cards.read(reference), permission: reference.permission };
      send({ event: "read", card, creations, control: records.control(), account: activity.getActiveAccountSync() ?? null });
    } else {
      wallet.stop(); cards.stop(); await settings.close(); await runtime.close(); activity.close(); access.close(); lease.close(); process.exit(0);
    }
  }).catch((error: unknown) => send({ event: "error", message: error instanceof Error ? error.message : "Fixture failure" }));
});
send({ event: "ready", ownerId });
