import { createRuntimeReviewDependencies } from "./reviewDependencies.js";
import { acquireDataDirectoryOwner } from "./shared/ownerLease.js";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WalletSdkProcess } from "./walletSdkProcess.js";
import { WALLETCONNECT_PROJECT_ID } from "./walletConnectConfig.js";
import { WalletWorkflow } from "../core/session/walletWorkflow.js";
import { SettingsWorkflow } from "../core/session/settingsWorkflow.js";
import { SettingsFileStore } from "../core/session/settingsFileStore.js";
import { randomUUID } from "node:crypto";
import { SqliteActivityStore } from "../core/activity/sqliteActivityStore.js";
import { validateSupportedAdapterLifecycle } from "../adapters/adapterLifecycleValidators.js";
import { ADAPTER_PROMPT_SURFACES } from "../adapters/adapterPromptSurfaces.js";
import { TransactionActivityService } from "../core/activity/transactionActivityService.js";
import { createSuiReadService } from "../core/read/readService.js";
import { verifySuiChainReceipt } from "../core/action/suiChainReceiptVerifier.js";
import { readPublicChainReceipt } from "../core/action/suiChainReceiptReader.js";
import { LocalSessionStore } from "../core/session/sessionStore.js";
import { createMcpServer } from "../mcp/server.js";
import { SERVER_NAME, SERVER_NETWORK, SERVER_VERSION } from "../mcp/serverInfo.js";
import { createReviewRequestHandler } from "../review-server/server.js";
import { DEFAULT_SUI_GRAPHQL_URL, DEFAULT_SUI_GRPC_URL, composeRuntimeConfig, type BootConfig } from "./config.js";
import { DeepbookOfficialIndexerSource } from "../core/read/deepbookOfficialIndexerSource.js";
import { RuntimeLocalSettingsService } from "./localSettingsService.js";
import type { Logger } from "./logger.js";
import { verifyMainnetGraphqlEndpoint, verifyMainnetGrpcEndpoint } from "./suiEndpoint.js";
import { GraphqlSuiTransactionActivitySource } from "./suiTransactionGraphqlSource.js";

import type { CardStore } from "../core/session/cardSessionStore.js";
import { createReadCardStore } from "../mcp-ui/readCards.js";
import { createDeepbookUsdcChartService } from "../core/read/deepbookUsdcChartService.js";
import { RuntimeDataAccess } from "./shared/dataAccess.js";
import { createInternalMcpHandler } from "./shared/mcpHttp.js";
import type { SharedApplication } from "./shared/server.js";

export async function createRuntimeApplication(bootConfig: BootConfig, logger: Logger, ownerId: string = randomUUID()): Promise<SharedApplication> {
  const access = new RuntimeDataAccess();
  const ownership = acquireDataDirectoryOwner(bootConfig.activityDatabasePath);
  let walletRuntime: WalletSdkProcess | undefined;
  let activityStore: SqliteActivityStore | undefined;
  let cards: CardStore | undefined;
  let workflow: WalletWorkflow | undefined;
  let settings: SettingsWorkflow | undefined;
  let chart: ReturnType<typeof createDeepbookUsdcChartService> | undefined;
  try {
    const store = new SqliteActivityStore({
      databasePath: bootConfig.activityDatabasePath,
      guardDatabase: access.guardDatabase,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    activityStore = store;
    const preferencesRepository = store.createPreferencesRepository();
    await preferencesRepository.ensureDefaultLocalSettings({
      suiGrpcUrl: DEFAULT_SUI_GRPC_URL,
      suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL
    });
    const storedSuiGrpcUrl = await preferencesRepository.getSuiGrpcUrl();
    const storedSuiGraphqlUrl = await preferencesRepository.getSuiGraphqlUrl();
    const config = composeRuntimeConfig({
      bootConfig,
      env: process.env,
      storedSuiGrpcUrl: storedSuiGrpcUrl?.value,
      storedSuiGraphqlUrl: storedSuiGraphqlUrl?.value,
      defaultSuiGrpcUrl: DEFAULT_SUI_GRPC_URL,
      defaultSuiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL
    });
    const { client: suiClient, chainIdentifier } = await verifyMainnetGrpcEndpoint({
      url: config.grpcUrl,
      expectedChainIdentifier: config.expectedChainIdentifier
    });
    const localSettings = new RuntimeLocalSettingsService({
      preferencesRepository,
      env: process.env,
      defaultSuiGrpcUrl: DEFAULT_SUI_GRPC_URL,
      defaultSuiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
      bootSuiGrpcUrl: config.suiGrpcUrl,
      bootSuiGraphqlUrl: config.suiGraphqlUrl
    });
    const workflowRecords = store.createWalletWorkflowStore(ownerId, () => new Date(), () => walletRuntime?.snapshot());
    const localData = store.createLocalDataService({
      advanceRequestDeadlines: (now) => workflowRecords.advanceRequestDeadlines(now),
      onDataReplaced: () => { access.dataReplaced(); workflow?.dataReplaced(); settings?.dataReplaced(); chart?.clearCache(); },
      suiGrpcUrl: DEFAULT_SUI_GRPC_URL,
      suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
      verifySuiGrpcUrl: async (url) => {
        await verifyMainnetGrpcEndpoint({
          url,
          expectedChainIdentifier: config.expectedChainIdentifier
        });
      },
      verifySuiGraphqlUrl: async (url) => {
        await verifyMainnetGraphqlEndpoint({
          url,
          expectedChainIdentifier: config.expectedChainIdentifier
        });
      }
    });
    const transactionMaterialStore = store.createTransactionMaterialStore();
    const sessions = new LocalSessionStore({
      activityStore: store,
      transactionMaterialStore,
      logger,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle,
      sessions: store.createSessionRecordStore(),
      artifacts: store.createPrivateReviewArtifactStore(),
      ownerId
    });
    const readService = createSuiReadService({
      client: suiClient,
      network: config.network,
      chainIdentifier,
      coinMetadataCache: store.createCoinMetadataCache(),
      deepbookOfficialIndexerSource: new DeepbookOfficialIndexerSource()
    });
    const chainReceiptVerifier = (input: Parameters<typeof verifySuiChainReceipt>[1]) =>
      verifySuiChainReceipt(
        {
          client: suiClient,
          network: config.network,
          expectedChainIdentifier: config.expectedChainIdentifier
        },
        input
      );
    const publicChainReceiptReader = (input: Parameters<typeof readPublicChainReceipt>[1]) =>
      readPublicChainReceipt(
        {
          client: suiClient,
          network: config.network,
          expectedChainIdentifier: config.expectedChainIdentifier,
          resolveCoinUnit: (coinType) => readService.resolveCoinUnit(coinType)
        },
        input
      );
    const reviewComputationDeps = createRuntimeReviewDependencies({ client: suiClient, chainIdentifier,
      expectedChainIdentifier: config.expectedChainIdentifier, materialStore: transactionMaterialStore, readService });
    const httpHandler = createReviewRequestHandler({ logger });
    const cardRecords = store.createCardRecordStore();
    let metadata: { name: string; description: string; homepage: string } | undefined;
    try {
      metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
        name: string; description: string; homepage: string;
      };
    } catch {
      logger.error("WalletConnect initialization unavailable", { stage: "initialization_failed" });
    }
    walletRuntime = new WalletSdkProcess({ projectId: WALLETCONNECT_PROJECT_ID, dataDirectory: dirname(bootConfig.activityDatabasePath),
      ...(metadata ? { metadata: { name: metadata.name, description: metadata.description, url: metadata.homepage } } : {}) });
    workflow = new WalletWorkflow({ records: workflowRecords, sessions, ownerId,
      runtime: walletRuntime, computation: reviewComputationDeps, verifyReceipt: chainReceiptVerifier, readReceipt: publicChainReceiptReader, signatureClient: suiClient,
      assertCurrent: access.assertCurrent, bindExternalEvent: (work) => access.bind(work), logger,
      verifyNetwork: async () => {
        const actual = await suiClient.core.getChainIdentifier();
        if (actual.chainIdentifier !== config.expectedChainIdentifier) throw new Error("Sui mainnet verification failed.");
      },
      submitTransaction: (transaction, signature) => suiClient.core.executeTransaction({ transaction, signatures: [signature] })
    });
    const settingsRecords = store.createSettingsWorkflowStore(ownerId);
    settings = new SettingsWorkflow({ records: settingsRecords, files: new SettingsFileStore(dirname(bootConfig.activityDatabasePath)),
      activity: store, localData, preferences: preferencesRepository, wallet: workflow, assertCurrent: access.assertCurrent, runMaintenance: (work) => access.run(work),
      resolveEndpoint: (input) => localSettings.resolveEndpointChange(input),
      verifyEndpoint: (input) => localSettings.prepareEndpointChange(input),
      interruptRun: (runId) => workflowRecords.invalidateWalletRun("wallet_service_restarted", new Date(), runId),
      readFacts: async () => settingsRecords.transaction(() => {
        const context = workflow!.currentConnectionContext(), account = store.getActiveAccountSync();
        const observedAt = context.walletObservation?.observedAt;
        return { server: { name: SERVER_NAME, version: SERVER_VERSION, network: SERVER_NETWORK },
          localSettings: localSettings.getLocalSettingsSync((key) => preferencesRepository.getLocalSettingSync(key)),
          ...(account ? { readAddress: account.address } : {}),
          assetReadAccount: context.assetReadAccount, walletAvailability: context.walletAvailability,
          ...(context.connectionReconciliationRequired ? { connectionReconciliationRequired: true as const } : {}),
          ...(observedAt ? { observedAt } : {}), counts: localData.getDataCountsSync() };
      }) });
    settings.recoverOwner();
    await workflow.start();

    chart = createDeepbookUsdcChartService({ assertCurrent: access.assertCurrent });
    cards = createReadCardStore({ readService, publicChainReceiptReader, chart, records: cardRecords, ownerId, assertCurrent: access.assertCurrent, logger, workflow, settings });
    const transactionActivityService = new TransactionActivityService({
        activityStore: store,
        source: new GraphqlSuiTransactionActivitySource({
          url: config.graphqlUrl,
          expectedChainIdentifier: config.expectedChainIdentifier
        })
      });
    const mcp = createInternalMcpHandler(() => createMcpServer({
      cards: { store: cards! },
      workflow,
      promptSurfaces: ADAPTER_PROMPT_SURFACES,
      sessions,
      activityStore: store,
      readService,
      transactionActivityService,
      localSettings,
      logger
    }));

    access.ready();
    void access.run(() => settings!.cleanupAfterOwnerChange()).catch(() => {
      try { logger.error("Temporary settings file cleanup is incomplete", { stage: "settings_file_cleanup" }); } catch { /* Stored cleanup facts remain authoritative. */ }
    });
    return {
      handleMcp: (request, response) => access.run(() => mcp.handle(request, response)),
      handleHttp: (request, response) => access.run(() => httpHandler(request, response)),
      async close() {
        workflow?.stop(); cards?.stop(); chart?.clearCache();
        try { await settings!.close(); }
        finally { access.close(); try { await walletRuntime!.close(); } finally { try { await mcp.close(); } finally { store.close(); ownership.close(); } } }
      }
    };
  } catch (error) {
    workflow?.stop(); access.close(); cards?.stop();
    try { await walletRuntime?.close(); } finally { activityStore?.close(); ownership.close(); }
    throw error;
  }
}
