import { seedCurrentReadAccount } from "./readAccount.js";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { SqliteActivityStore } from "../../src/core/activity/sqliteActivityStore.js";
import { LocalSessionStore } from "../../src/core/session/sessionStore.js";
import { WalletWorkflow } from "../../src/core/session/walletWorkflow.js";
import { SettingsWorkflow } from "../../src/core/session/settingsWorkflow.js";
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
import { settingsDownload, type SettingsDraft, type SettingsView } from "../../src/core/session/settingsOperation.js";
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
let creations = 0, publications = 0;
const originalLink = fs.link, originalUnlink = fs.unlink, originalLstat = fs.lstat;
fs.link = async (...args) => {
  publications++;
  if (fault === "link_before") await hold(fault);
  await originalLink(...args);
  if (fault === "link_after") await hold(fault);
};
fs.unlink = async (...args) => {
  if (String(args[0]).endsWith(".download") && fault === "cleanup_before") await hold(fault);
  await originalUnlink(...args);
  if (String(args[0]).endsWith(".download") && fault === "cleanup_after") await hold(fault);
};
fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
  const result = await originalLstat(...args);
  if (String(args[0]).endsWith(".download") && fault === "source_identity_before") await hold(fault);
  return result;
}) as typeof fs.lstat;
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
if (fault === "saved_before") {
  const inspect = files.inspectDownloadPublication.bind(files);
  files.inspectDownloadPublication = async (...args) => {
    const result = await inspect(...args);
    if (result.status === "saved") await hold(fault);
    return result;
  };
}
settings.recoverOwner();
// Capture the committed result before physical cleanup can change file facts.
const recoveryResults = Object.fromEntries((records.db.prepare("SELECT id,result_json FROM live_read_cards WHERE kind='settings' AND state='closed'")
  .all() as Array<{ id: string; result_json: string }>).map((row) => [row.id, JSON.parse(row.result_json)]));
await wallet.start();
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
if (fault === "result_before") access.run(() => records.db.exec("CREATE TRIGGER refuse_result BEFORE UPDATE ON settings_operations WHEN json_extract(NEW.preparation_json,'$.download.readyAt') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture readiness refused'); END"));
if (fault === "result_after") access.run(() => records.db.exec(`CREATE TRIGGER refuse_finished_release BEFORE UPDATE ON settings_control
  WHEN OLD.file_io_id IS NOT NULL AND NEW.file_io_id IS NULL AND EXISTS (
    SELECT 1 FROM settings_files f JOIN settings_operations o ON o.operation_id=coalesce(f.cleanup_operation_id,f.operation_id)
    WHERE f.file_id=OLD.file_io_id AND o.phase='terminal')
  BEGIN SELECT RAISE(ABORT,'finished cleanup release refused'); END`));
process.on("message", (message: { command: "prepare" | "confirm" | "unsupported" | "read" | "status" | "delivery" | "stop"; draft?: SettingsDraft; reference?: { cardId: string; permission: string } }) => {
  void access.run(async () => {
    if (message.command === "prepare") {
      card = await cards.create("settings", {});
      selectedKind = message.draft?.kind;
      await seedCurrentReadAccount(activity, `0x${"a".repeat(64)}`);
      if (selectedKind === "download_backup") { send({ event: "prepared", card }); return; }
      await act({ action: "settings_select", draft: message.draft });
      if (message.draft?.kind === "import_local_data") {
        const envelope = await localData.exportLocalData(), raw = Buffer.from(JSON.stringify(envelope));
        await act({ action: "settings_begin_upload", operationId: data().operationId, name: "backup.json", totalSize: raw.length, sha256: createHash("sha256").update(raw).digest("hex") });
        const fileId = data().file!.fileId;
        await act({ action: "settings_upload_chunk", operationId: data().operationId, fileId, offset: 0, chunkBase64: raw.toString("base64") });
        await act({ action: "settings_seal_upload", operationId: data().operationId, fileId });
      }
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
        while (!settingsDownload(records.get(data().operationId)!)?.readyAt) await new Promise<void>((resolve) => setImmediate(resolve));
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
    } else if (message.command === "unsupported") {
      while (data().download?.availability !== "available") {
        card = { ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission };
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await act({ action: "settings_report_download", operationId: data().operationId, fileId: data().file!.fileId,
        attemptId: data().download!.currentAttemptId, status: "unsupported", failure: { method: "ui/download-file", code: -32601 } });
      send({ event: "reported", card });
    } else if (message.command === "delivery") {
      const existing = data();
      card = await cards.create("settings", { backupDelivery: { operationId: existing.operationId, fileId: existing.file!.fileId } });
      send({ event: "delivery", card });
    } else if (message.command === "read" || message.command === "status") {
      const reference = message.reference ?? { cardId: card.snapshot.cardId, permission: card.permission };
      card = { ...await cards.read(reference), permission: reference.permission };
      if (message.command === "status") card = await cards.create("settings", { operationStatus: { operationId: data().operationId } });
      send({ event: "read", card, creations, publications, control: records.control(), account: activity.getActiveAccountSync() ?? null });
    } else {
      wallet.stop(); cards.stop(); await settings.close(); await runtime.close(); activity.close(); access.close(); lease.close(); process.exit(0);
    }
  }).catch((error: unknown) => send({ event: "error", message: error instanceof Error ? error.message : "Fixture failure" }));
});
send({ event: "ready", ownerId, recoveryResults });
