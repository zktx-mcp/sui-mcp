import { createReadCardStore } from "../../src/mcp-ui/readCards.js";
import { createDeepbookUsdcChartService } from "../../src/core/read/deepbookUsdcChartService.js";
import { SettingsWorkflow } from "../../src/core/session/settingsWorkflow.js";
import { SettingsFileStore } from "../../src/core/session/settingsFileStore.js";
import { RuntimeLocalSettingsService } from "../../src/runtime/localSettingsService.js";
import type { SettingsDraft, SettingsView } from "../../src/core/session/settingsOperation.js";
import type { CardResponse } from "../../src/core/session/cardSession.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../../src/runtime/config.js";
import { walletWorkflowFixture } from "./walletWorkflow.js";

// External endpoint/wallet/chain sources are synthetic. Settings/CardStore,
// SQLite admission/replacement, file I/O, digests and supervisor paths are real.
export async function settingsWorkflowFixture(options: Parameters<typeof walletWorkflowFixture>[0] & {
  verifyEndpoint?: (url: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const wallet = await walletWorkflowFixture(options);
  const records = wallet.run(() => wallet.activity.createSettingsWorkflowStore("fixture-owner", wallet.now));
  const preferences = wallet.run(() => wallet.activity.createPreferencesRepository());
  const localSettings = new RuntimeLocalSettingsService({ preferencesRepository: preferences, env: options.env ?? {}, now: wallet.now,
    verifyGrpcEndpoint: options.verifyEndpoint ?? (async () => {}), verifyGraphqlEndpoint: options.verifyEndpoint ?? (async () => {}) });
  const files = new SettingsFileStore(wallet.directory);
  const localData = wallet.run(() => wallet.activity.createLocalDataService({ now: wallet.now,
    suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
    advanceRequestDeadlines: (now) => wallet.records.advanceRequestDeadlines(now),
    onDataReplaced: () => { wallet.access.dataReplaced(); wallet.workflow.dataReplaced(); },
    verifySuiGrpcUrl: options.verifyEndpoint ?? (async () => {}), verifySuiGraphqlUrl: options.verifyEndpoint ?? (async () => {}) }));
  const settings = new SettingsWorkflow({ records, files, preferences, activity: wallet.activity, localData, wallet: wallet.workflow,
    assertCurrent: wallet.access.assertCurrent,
    resolveEndpoint: (input) => localSettings.resolveEndpointChange(input),
    verifyEndpoint: (input) => localSettings.prepareEndpointChange(input),
    interruptRun: (runId) => wallet.records.invalidateWalletRun("wallet_service_restarted", wallet.now(), runId),
    readFacts: async () => records.transaction(() => {
      const context = wallet.workflow.currentConnectionContext();
      const account = wallet.activity.getActiveAccountSync();
      return { server: { name: "sui-mcp", version: "0.6.0", network: "mainnet" },
        localSettings: localSettings.getLocalSettingsSync((key) => preferences.getLocalSettingSync(key)),
        ...(account ? { readAddress: account.address } : {}),
        assetReadAccount: context.assetReadAccount, walletAvailability: context.walletAvailability,
        ...(context.connectionReconciliationRequired ? { connectionReconciliationRequired: true as const } : {}),
        counts: wallet.localData.getDataCountsSync() };
    }) });
  const cards = wallet.run(() => createReadCardStore({ records: wallet.cardRecords, ownerId: "fixture-owner", assertCurrent: wallet.access.assertCurrent,
    now: wallet.now, workflow: wallet.workflow, settings,
    readService: { summarizeAccountInventory: async () => { throw new Error("Unexpected account source"); } },
    publicChainReceiptReader: async () => { throw new Error("Unexpected receipt source"); }, chart: createDeepbookUsdcChartService() }));
  const create = () => wallet.run(() => cards.create("settings", {}));
  const read = (card: CardResponse & { permission: string }) => wallet.run(async () => ({ ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission }));
  const act = (card: CardResponse & { permission: string }, input: Record<string, unknown>) => wallet.run(() => cards.act({ cardId: card.snapshot.cardId,
    permission: card.permission, revision: card.snapshot.revision, input }));
  const prepare = async (draft: SettingsDraft) => {
    const card = await create();
    let next = { ...await act(card, { action: "settings_select", draft }), permission: card.permission };
    const operationId = (next.snapshot.data as SettingsView).operationId;
    next = { ...await act(next, { action: "settings_prepare", operationId }), permission: card.permission };
    if (next.error) throw new Error(next.error.message);
    return next;
  };
  const confirm = (card: Awaited<ReturnType<typeof create>>) => {
    const view = card.snapshot.data as SettingsView;
    return act(card, { action: "settings_confirm", operationId: view.operationId, preparationId: view.preparationId });
  };
  return { wallet, records, preferences, localSettings, localData, files, settings, cards, create, read, act, prepare, confirm,
    close() { cards.stop(); wallet.close(); } };
}
