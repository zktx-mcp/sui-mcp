import type { SqliteActivityStore } from "../../src/core/activity/sqliteActivityStore.js";
import type { SqliteLocalDataService } from "../../src/core/activity/localDataService.js";
import { createHash, randomUUID } from "node:crypto";
import { createCardStore } from "../../src/mcp-ui/readCards.js";
import { createDeepbookUsdcChartService } from "../../src/core/read/deepbookUsdcChartService.js";
import { SettingsWorkflow } from "../../src/core/session/settingsWorkflow.js";
import { SettingsFileStore } from "../../src/core/session/settingsFileStore.js";
import { RuntimeLocalSettingsService } from "../../src/runtime/localSettingsService.js";
import { validateSealedBackup } from "../../src/runtime/localBackupWorker.js";
import type { SettingsDraft, SettingsView } from "../../src/core/session/settingsOperation.js";
import type { WalletChainId } from "../../src/core/session/chainAccounts.js";
import type { CardResponse } from "../../src/core/session/cardSession.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../../src/runtime/config.js";
import { walletWorkflowFixture } from "./walletWorkflow.js";

// External endpoint/wallet/chain sources are synthetic. Settings/CardStore,
// SQLite admission/replacement, file I/O, digests and supervisor paths are real.
export async function settingsWorkflowFixture(options: Parameters<typeof walletWorkflowFixture>[0] & {
  existingWallet?: Awaited<ReturnType<typeof walletWorkflowFixture>>;
  existingLocalData?: SqliteLocalDataService;
  validateUpload?: typeof validateSealedBackup;
  verifyEndpoint?: (url: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const wallet = options.existingWallet ?? await walletWorkflowFixture(options);
  const records = wallet.run(() => wallet.activity.createSettingsWorkflowStore("fixture-owner", wallet.now));
  const preferences = wallet.run(() => wallet.activity.createPreferencesRepository());
  const localSettings = new RuntimeLocalSettingsService({ preferencesRepository: preferences, env: options.env ?? {}, now: wallet.now,
    verifyGrpcEndpoint: options.verifyEndpoint ?? (async () => {}), verifyGraphqlEndpoint: options.verifyEndpoint ?? (async () => {}) });
  const files = new SettingsFileStore(wallet.directory);
  const localData = options.existingLocalData ?? wallet.run(() => wallet.activity.createLocalDataService({ now: wallet.now,
    suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
    advanceRequestDeadlines: (now) => wallet.records.advanceRequestDeadlines(now),
    onDataReplaced: () => { wallet.access.dataReplaced(); wallet.workflow.dataReplaced(); settings.dataReplaced(); },
    verifySuiGrpcUrl: options.verifyEndpoint ?? (async () => {}), verifySuiGraphqlUrl: options.verifyEndpoint ?? (async () => {}) }));
  const settings = new SettingsWorkflow({ records, files, preferences, activity: wallet.activity, localData, validateUpload: options.validateUpload ?? validateSealedBackup, wallet: wallet.workflow,
    assertCurrent: wallet.access.assertCurrent, runMaintenance: (work) => wallet.run(work),
    resolveEndpoint: (input) => localSettings.resolveEndpointChange(input),
    verifyEndpoint: (input) => localSettings.prepareEndpointChange(input),
    interruptRun: (runId) => wallet.records.invalidateWalletRun("wallet_service_restarted", wallet.now(), runId),
    readFacts: async () => localData.readWithCounts(() => {
      const context = wallet.workflow.currentConnectionContext();
      const account = wallet.activity.getActiveAccountSync();
      return { server: { name: "sui-mcp", version: "0.6.0", network: "mainnet" },
        localSettings: localSettings.getLocalSettingsSync((key) => preferences.getLocalSettingSync(key)),
        ...(account ? { readAddress: account.address, readConnectionId: account.connectionId } : {}),
        assetReadAccount: context.assetReadAccount, walletAvailability: context.walletAvailability,
        ...(context.connectionReconciliationRequired ? { connectionReconciliationRequired: true as const } : {}) };
    }) });
  const cards = wallet.run(() => createCardStore({ records: wallet.cardRecords, ownerId: "fixture-owner", assertCurrent: wallet.access.assertCurrent,
    now: wallet.now, workflow: wallet.workflow, settings,
    readService: { summarizeAccountInventory: async () => { throw new Error("Unexpected account source"); } },
    publicChainReceiptReader: async () => { throw new Error("Unexpected receipt source"); }, chart: createDeepbookUsdcChartService() }));
  const create = (input: Record<string, unknown> = {}) => wallet.run(() => cards.create("settings", input));
  const status = (card: CardResponse) => create({ operationStatus: { operationId: (card.snapshot.data as SettingsView).operationId } });
  const delivery = (card: CardResponse) => create({ backupDelivery: { operationId: (card.snapshot.data as SettingsView).operationId, fileId: (card.snapshot.data as SettingsView).file!.fileId } });
  const read = (card: CardResponse & { permission: string }) => wallet.run(async () => ({ ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission }));
  const act = (card: CardResponse & { permission: string }, input: Record<string, unknown>) => wallet.run(() => cards.act({ cardId: card.snapshot.cardId,
    permission: card.permission, revision: card.snapshot.revision, input }));
  const prepare = async (draft: SettingsDraft) => {
    const card = await create();
    let next = { ...await act(card, { action: "settings_select", draft }), permission: card.permission };
    const operationId = (next.snapshot.data as SettingsView).operationId;
    if (next.error) throw new Error(next.error.message);
    if ((next.snapshot.data as SettingsView).phase !== "prepared") next = { ...await act(next, { action: "settings_prepare", operationId }), permission: card.permission };
    if (next.error) throw new Error(next.error.message);
    return next;
  };
  const download = (card: Awaited<ReturnType<typeof create>>, attemptId = randomUUID()) => act(card, { action: "settings_download_backup",
    operationId: (card.snapshot.data as SettingsView).operationId, attemptId });
  const saveNetworks = (card: Awaited<ReturnType<typeof create>>, chains: WalletChainId[],
    expectedChains = (card.snapshot.data as SettingsView).facts!.localSettings.walletConnectionChains) =>
    act(card, { action: "settings_save_wallet_networks", operationId: (card.snapshot.data as SettingsView).operationId, chains, expectedChains });
  const confirm = (card: Awaited<ReturnType<typeof create>>) => {
    const view = card.snapshot.data as SettingsView;
    return act(card, { action: "settings_confirm", operationId: view.operationId, preparationId: view.preparationId });
  };
  return { wallet, records, preferences, localSettings, localData, files, settings, cards, create, status, delivery, read, act, prepare, confirm, download, saveNetworks,
    async close() { cards.stop(); try { await settings.close(); } finally { if (!options.existingWallet) wallet.close(); } } };
}

// Component checks use the real sealed-file decoder and the same preview as Settings.
// Mutating checks below always open and confirm an actual scoped Settings card.
export async function previewBackup(service: SqliteLocalDataService, input: unknown, now?: Date) {
  const envelope = await validateSealedBackup(Buffer.from(JSON.stringify(input)));
  return service.previewValidatedImport(envelope, now ?? new Date());
}
export async function verifyBackup(service: SqliteLocalDataService, input: unknown) {
  return service.verifyImportEndpoints(await validateSealedBackup(Buffer.from(JSON.stringify(input))));
}

export async function confirmLocalRecords(
  owner: SqliteActivityStore | Awaited<ReturnType<typeof walletWorkflowFixture>>,
  service: SqliteLocalDataService, archive?: unknown
) {
  const f = await settingsWorkflowFixture({ ...("activity" in owner ? {existingWallet:owner} : {existingStore:owner}), existingLocalData:service });
  try { return await confirmSettingsRecords(f, archive); }
  finally { await f.close(); }
}

export async function confirmSettingsRecords(f: Awaited<ReturnType<typeof settingsWorkflowFixture>>, archive?: unknown) {
    let card = await f.create();
    const submit = async (input: Record<string, unknown>) => {
      const result = await f.act(card,input);
      if (result.error) throw new Error(result.error.message);
      card = { ...result, permission:card.permission };
      return card.snapshot.data as SettingsView;
    };
    let view = await submit({action:"settings_select",draft:{kind:archive === undefined ? "reset_local_data" : "import_local_data"}});
    const operationId = view.operationId;
    if (archive !== undefined) {
      const bytes = Buffer.from(JSON.stringify(archive));
      view = await submit({action:"settings_begin_upload",operationId,name:"backup.json",totalSize:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
      const fileId = view.file!.fileId;
      for (let offset=0; offset<bytes.length; offset+=20000) {
        await submit({action:"settings_upload_chunk",operationId,fileId,offset,chunkBase64:bytes.subarray(offset,offset+20000).toString("base64")});
      }
      view = await submit({action:"settings_seal_upload",operationId,fileId});
      if (view.restoreCheck?.status !== "can_restore") throw new Error(view.restoreCheck && "message" in view.restoreCheck ? view.restoreCheck.message : "Backup was not prepared.");
    } else if (view.phase !== "prepared") {
      view = await submit({action:"settings_prepare",operationId});
    }
    const result = await submit({action:"settings_confirm",operationId,preparationId:view.preparationId});
    if (result.result?.outcome !== "completed") throw new Error(result.result?.message ?? "Local data replacement was refused.");
    return result.result.details;
}
