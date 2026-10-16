import { seedReadAddressCleared, seedCurrentReadAccount } from "./fixtures/readAccount.js";
import { suiGrants } from "./fixtures/walletGrants.js";
import type { ActivityStore } from "../src/core/activity/activityStore.js";
import type { WalletWorkflow } from "../src/core/session/walletWorkflow.js";
import { walletWorkflowFixture } from "./fixtures/walletWorkflow.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ADAPTER_PROMPT_SURFACES } from "../src/adapters/adapterPromptSurfaces.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { mainnetCoins, type Coin } from "@mysten/deepbook-v3";
import { describe, expect, it, vi } from "vitest";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import {
  SuiReadService,
  type DeepBookCoinRegistry,
  type DeepBookReadClient,
} from "../src/core/read/readService.js";
import {
  DEEPBOOK_OFFICIAL_INDEXER_CANONICAL_USDC_COIN_TYPE,
  DEEPBOOK_OFFICIAL_INDEXER_SOURCE_STATEMENT,
  type DeepbookOfficialIndexerCandlesInput,
  type DeepbookOfficialIndexerCandle,
  type DeepbookOfficialIndexerFetchSource,
  type DeepbookOfficialIndexerPool,
  type DeepbookOfficialIndexerSourceClient
} from "../src/core/read/deepbookOfficialIndexerSource.js";
import {
  DEEPBOOK_ANSWER_USE,
  DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT,
  DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE,
  DEEPBOOK_PINNED_SDK_METADATA_SOURCE,
  DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING
} from "../src/core/read/deepbookSourceOwners.js";
import { DEEPBOOK_SCALAR_UNIT_SOURCE } from "../src/core/read/coinMetadata.js";
import { TransactionActivityService, type SuiTransactionActivitySource } from "../src/core/activity/transactionActivityService.js";
import { PreferencesStoreError, type LocalSettingsService } from "../src/core/preferences/preferencesStore.js";
import { SuiEndpointError } from "../src/core/suiEndpoint.js";
import { InMemorySessionStore } from "../src/core/session/sessionStore.js";
import { MCP_RESOURCES } from "../src/mcp/resources.js";
import { createMcpServer, type McpServerDeps } from "../src/mcp/server.js";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { CARD_METADATA_KEY, CARD_RESOURCE_URIS, CARD_TOOLS, cardSnapshotSchema } from "../src/mcp-ui/contracts.js";
import {
  toolAvailability,
  EVIDENCE_POLICY,
  IMPLEMENTED_TOOLS,
  PACKAGE_NAME,
  SERVER_INSTRUCTIONS,
  SERVER_VERSION
} from "../src/mcp/serverInfo.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { InMemoryActivityStore } from "./fixtures/inMemoryActivityStore.js";
import { MemoryCoinMetadataCache } from "./fixtures/memoryCoinMetadataCache.js";
import {
  InMemoryLocalSettingsService,
  InMemoryPreferencesRepository
} from "./fixtures/inMemoryLocalSettings.js";
import type { ActionPlan, ReviewState } from "../src/core/action/types.js";
import { DEFAULT_SUI_GRAPHQL_URL, DEFAULT_SUI_GRPC_URL } from "../src/runtime/config.js";

const walletAccount = `0x${"a".repeat(64)}`;
const replacementWalletAccount = `0x${"b".repeat(64)}`;
const deepbookManagerAddress = `0x${"c".repeat(64)}`;
const durableFixtureSessionTtlMs = 100 * 365 * 24 * 60 * 60 * 1000;
const cetusPackage =
  "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";
const testLogger = { error() {} };
const transactionDetails = {
  transactionKind: "ProgrammableTransaction",
  moveCalls: [
    {
      commandIndex: 0,
      package: cetusPackage,
      module: "pool",
      function: "swap",
      target: `${cetusPackage}::pool::swap`
    }
  ],
  balanceChanges: [
    {
      index: 0,
      owner: walletAccount,
      coinType: "0x2::sui::SUI",
      amountRaw: "-1000",
      direction: "decrease" as const
    }
  ],
  objectChanges: [],
  events: [],
  gas: {
    netGasCostRaw: "115"
  },
  truncation: {
    moveCalls: false,
    balanceChanges: false,
    objectChanges: false,
    events: false
  }
};

function deepbookCoinsWithInvalidSuiScalar(): DeepBookCoinRegistry {
  const coins = mainnetCoins as DeepBookCoinRegistry;
  const sui = coins.SUI;
  if (!sui) {
    throw new Error("SUI token fixture is missing from pinned DeepBook mainnetCoins");
  }
  return {
    ...coins,
    SUI: { ...(sui as Coin), scalar: 12 }
  };
}

const reviewPlan: ActionPlan = {
  id: "plan_review_activity",
  actionKind: "swap",
  adapterId: "deepbook-swap",
  protocol: "DeepBookV3",
  title: "Review swap",
  summary: "Review a swap",
  assetFlowPreview: {
    outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
    expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }]
  },
  adapterData: {
    requestedIntent: {
      from: "SUI",
      to: "USDC",
      amount: "1"
    }
  },
  createdAt: "2026-05-11T00:00:00.000Z"
};

async function connectTestClient(
  options: {
    activityStore?: ActivityStore;
    workflow?: WalletWorkflow;
    localSettings?: LocalSettingsService;
    readService?: SuiReadService;
    transactionActivitySource?: SuiTransactionActivitySource;
    sessionTtlMs?: number;
    sessions?: McpServerDeps["sessions"];
    cards?: McpServerDeps["cards"];
  } = {}
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const activityStore = options.activityStore ?? new InMemoryActivityStore();
  const localSettings = options.localSettings ?? (await createDefaultLocalSettings());
  const sessions = options.sessions ?? new InMemorySessionStore({
    activityStore,
    logger: testLogger,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle,
    ...(options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs })
  });
  let scanCounter = 0;
  const server = createMcpServer({
    promptSurfaces: ADAPTER_PROMPT_SURFACES,
    sessions,
    activityStore,
    ...(options.workflow ? { workflow: options.workflow } : {}),
    localSettings,
    ...(options.cards ? { cards: options.cards } : {}),
    logger: testLogger,
    readService: options.readService ?? createTestReadService(),
    transactionActivityService: new TransactionActivityService({
      activityStore,
      source: options.transactionActivitySource ?? createTestTransactionActivitySource(),
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      scanId: () => `scan_test_${++scanCounter}`
    })
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, server, sessions, activityStore };
}

async function createDefaultLocalSettings(options: ConstructorParameters<typeof InMemoryLocalSettingsService>[1] = {}) {
  const repository = new InMemoryPreferencesRepository();
  await repository.ensureDefaultLocalSettings({
    suiGrpcUrl: DEFAULT_SUI_GRPC_URL,
    suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL
  });
  return new InMemoryLocalSettingsService(repository, options);
}

function createTestTransactionActivitySource(): SuiTransactionActivitySource {
  return {
    async verifyMainnet() {
      return {
        transport: "graphql",
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
      };
    },
    async getTransaction(digest) {
      return {
        digest,
        sender: walletAccount,
        checkpoint: "123",
        timestamp: "2026-05-10T00:00:00.000Z",
        status: "success",
        details: transactionDetails
      };
    },
    async scanAccount() {
      return {
        transactions: [
          {
            digest: "5".repeat(44),
            sender: walletAccount,
            checkpoint: "123",
            timestamp: "2026-05-10T00:00:00.000Z",
            status: "success",
            details: transactionDetails
          }
        ],
        hasMore: false
      };
    },
    async scanFunction() {
      return {
        transactions: [
          {
            digest: "5".repeat(44),
            sender: walletAccount,
            checkpoint: "123",
            timestamp: "2026-05-10T00:00:00.000Z",
            status: "success",
            details: transactionDetails
          }
        ],
        hasMore: false
      };
    }
  };
}

function createTestReadService(
  options: {
    deepbook?: Partial<DeepBookReadClient>;
    deepbookCoins?: DeepBookCoinRegistry;
    deepbookOfficialIndexerSource?: DeepbookOfficialIndexerSourceClient;
  } = {}
): SuiReadService {
  const deepbook: DeepBookReadClient = {
    async midPrice() {
      return 1;
    },
    async poolBookParams() {
      return { tickSize: 1, lotSize: 1, minSize: 1 };
    },
    async getLevel2TicksFromMid() {
      return {
        bid_prices: [1],
        bid_quantities: [2],
        ask_prices: [3],
        ask_quantities: [4]
      };
    },
    async getQuoteQuantityOutRaw() {
      return { baseOutRaw: "0", quoteOutRaw: "1000000", deepRequiredRaw: "0" };
    },
    async getBaseQuantityOutRaw() {
      return { baseOutRaw: "1000000000", quoteOutRaw: "0", deepRequiredRaw: "0" };
    },
    async getBalanceManagerIds() {
      return [deepbookManagerAddress];
    },
    async accountExists() {
      return true;
    },
    async account() {
      return {
        epoch: "42",
        open_orders: { contents: ["ignored-account-open-order-source"] },
        taker_volume: 99,
        maker_volume: 88,
        active_stake: 77,
        inactive_stake: 66,
        created_proposal: true,
        voted_proposal: "proposal",
        unclaimed_rebates: { base: 1, quote: 2, deep: 3 },
        settled_balances: { base: 4, quote: 5, deep: 6 },
        owed_balances: { base: 7, quote: 8, deep: 9 }
      };
    },
    async lockedBalance() {
      return { base: 10, quote: 11, deep: 12 };
    },
    async accountOpenOrders() {
      return ["100", "101"];
    },
    ...options.deepbook
  };

  return new SuiReadService({
    network: "mainnet",
    chainIdentifier: "4c78adac",
    coinMetadataCache: new MemoryCoinMetadataCache(),
    ...(options.deepbookCoins === undefined ? {} : { deepbookCoins: options.deepbookCoins }),
    deepbookOfficialIndexerSource: options.deepbookOfficialIndexerSource ?? createTestDeepbookOfficialIndexerSource(),
    now: () => new Date("2026-05-11T00:00:00.000Z"),
    deepbookFactory: () => deepbook,
    client: {
      core: {
        async listBalances() {
          return {
            balances: [],
            hasNextPage: false,
            cursor: null
          };
        },
        async getCoinMetadata() {
          return {
            coinMetadata: {
              id: null,
              decimals: 9,
              name: "Sui",
              symbol: "SUI",
              description: "",
              iconUrl: null
            }
          };
        }
      }
    }
  });
}

function createTestDeepbookOfficialIndexerSource(): DeepbookOfficialIndexerSourceClient {
  return {
    async fetchPools() {
      return {
        source: officialSource("get_pools"),
        pools: [officialPoolFixture()]
      };
    },
    async fetchCandles(input) {
      return {
        source: officialSource("ohclv", input),
        candles: officialCandlesFixture()
      };
    }
  };
}

function officialPoolFixture(): DeepbookOfficialIndexerPool {
  return {
    pool_id: "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407",
    pool_name: "SUI_USDC",
    base_asset_id: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    base_asset_symbol: "SUI",
    base_asset_decimals: 9,
    quote_asset_id: DEEPBOOK_OFFICIAL_INDEXER_CANONICAL_USDC_COIN_TYPE,
    quote_asset_symbol: "USDC",
    quote_asset_decimals: 6
  };
}

function officialCandlesFixture(): DeepbookOfficialIndexerCandle[] {
  return [
    {
      timestampMs: Date.parse("2026-06-26T16:50:00.000Z"),
      start: "2026-06-26T16:50:00.000Z",
      end: "2026-06-26T17:05:00.000Z",
      open: "0.69507",
      high: "0.69672",
      low: "0.69287",
      close: "0.69316",
      volume: "101444.802158"
    },
    {
      timestampMs: Date.parse("2026-06-26T17:20:00.000Z"),
      start: "2026-06-26T17:20:00.000Z",
      end: "2026-06-26T17:35:00.000Z",
      open: "0.69604",
      high: "0.69797",
      low: "0.69495",
      close: "0.69734",
      volume: "86921.414432"
    },
    {
      timestampMs: Date.parse("2026-06-26T19:45:00.000Z"),
      start: "2026-06-26T19:45:00.000Z",
      end: "2026-06-26T20:00:00.000Z",
      open: "0.69846",
      high: "0.7009",
      low: "0.6978",
      close: "0.7006",
      volume: "97026.231024"
    },
    {
      timestampMs: Date.parse("2026-06-26T20:00:00.000Z"),
      start: "2026-06-26T20:00:00.000Z",
      end: "2026-06-26T20:15:00.000Z",
      open: "0.7006",
      high: "0.701",
      low: "0.699",
      close: "0.6998",
      volume: "115612.509667"
    }
  ];
}

function officialSource(
  endpoint: "get_pools" | "ohclv",
  input: Partial<DeepbookOfficialIndexerCandlesInput> = {}
): DeepbookOfficialIndexerFetchSource {
  return {
    baseUrl: "https://deepbook-indexer.mainnet.mystenlabs.com",
    endpoint,
    url:
      endpoint === "get_pools"
        ? "https://deepbook-indexer.mainnet.mystenlabs.com/get_pools"
        : `https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/${input.poolName}?interval=${input.interval}`,
    fetchedAt: "2026-06-27T00:00:00.000Z",
    sourceStatement: DEEPBOOK_OFFICIAL_INDEXER_SOURCE_STATEMENT,
    poolName: input.poolName,
    interval: input.interval,
    startTimeMs: input.startTimeMs,
    endTimeMs: input.endTimeMs,
    limit: input.limit
  };
}

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return JSON.parse((result.content as Array<{ text?: string }>)[0]?.text ?? "");
}

describe("MCP discoverability", () => {
  it("exposes server instructions through initialize", async () => {
    const { client, server } = await connectTestClient();
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      expect(client.getInstructions()).toContain("mainnet-only");
      expect(client.getInstructions()).toContain("Ordinary MCP tools return evidence or internal cards");
      expect(client.getInstructions()).toContain("never signing authority, bytes or signatures");
      expect(client.getInstructions()).toContain("Only user card input and wallet approval authorize WalletConnect");
      expect(client.getInstructions()).toContain("Request status is separate from chain success/failure");
      expect(client.getInstructions()).toContain("toolAvailability.requiredToolsAvailable");
      expect(client.getInstructions()).toContain("userAnswerUse.answerFields");
      expect(client.getInstructions()).toContain("active account context");
      expect(client.getInstructions()).toContain("suimcp://docs/agent-behavior");
    } finally {
      await server.close();
    }
  });

  it("marks response-local answer source status unusable when a required tool is missing", () => {
    expect(toolAvailability([TOOL_NAMES.readGetServerStatus, "missing.tool"])).toMatchObject({
      requiredTools: expect.arrayContaining([
        { name: TOOL_NAMES.readGetServerStatus, available: true },
        { name: "missing.tool", available: false }
      ]),
      missingRequiredTools: ["missing.tool"],
      requiredToolsAvailable: false,
      unavailableReason: "required_tool_missing_from_current_server_build"
    });
  });

  it("exposes only product-facing resources", async () => {
    const { client, server } = await connectTestClient();
    try {
      const result = await client.listResources();
      const uris = result.resources.map((resource) => resource.uri).sort();

      expect(uris).toEqual([
        "suimcp://docs/agent-behavior",
        "suimcp://docs/mcp-setup",
        "suimcp://docs/mcp-tools",
        "suimcp://docs/readme",
        "suimcp://docs/wallet-connection",
        "suimcp://protocols/deepbook-margin",
        "suimcp://protocols/deepbook-v3",
        "ui://sui-mcp/account.html",
        "ui://sui-mcp/chart.html",
        "ui://sui-mcp/connect.html",
        "ui://sui-mcp/disconnect.html",
        "ui://sui-mcp/receipt.html",
        "ui://sui-mcp/review.html",
        "ui://sui-mcp/settings.html"
      ]);

      for (const expectedResource of MCP_RESOURCES) {
        const listedResource = result.resources.find((resource) => resource.uri === expectedResource.uri);
        expect(listedResource).toMatchObject({
          name: expectedResource.name,
          title: expectedResource.title,
          description: expectedResource.description
        });
        const resource = await client.readResource({ uri: expectedResource.uri });
        const firstContent = resource.contents[0];
        expect(firstContent).toBeDefined();
        expect(firstContent).toMatchObject({
          uri: expectedResource.uri,
          mimeType: "text/markdown"
        });
        expect(firstContent && "text" in firstContent ? firstContent.text.length : 0).toBeGreaterThan(0);
      }
    } finally {
      await server.close();
    }
  });

  it("exposes prompts without claiming unsupported signing support", async () => {
    const { client, server } = await connectTestClient();
    try {
      const result = await client.listPrompts();
      expect(result.prompts.map((prompt) => prompt.name).sort()).toEqual([
        "inspect-supported-sui-actions",
        "prepare-reviewable-sui-action",
        "swap",
        "swap-deep"
      ]);
      const status = await client.callTool({ name: TOOL_NAMES.readGetServerStatus });
      const catalog = (status.structuredContent as { data: { prompts: { count: number; names: string[] } } }).data.prompts;
      expect(catalog.count).toBe(4);
      expect([...catalog.names].sort()).toEqual(result.prompts.map((prompt) => prompt.name).sort());
      // Adapter prompt surfaces take exactly one free-text intent argument;
      // the static prompts stay zero-argument. No prompt claims signing
      // support.
      for (const prompt of result.prompts) {
        if (prompt.name === "swap") {
          // The current single adapter provides the bare action shorthand.
          expect((prompt.arguments ?? []).map((argument) => argument.name)).toEqual(["intent"]);
        } else if (prompt.name === "swap-deep") {
          expect((prompt.arguments ?? []).map((argument) => argument.name)).toEqual(["intent"]);
        } else {
          expect(prompt.arguments ?? []).toEqual([]);
        }
      }

      const surfacePrompt = await client.getPrompt({
        name: "swap-deep",
        arguments: { intent: "10 sui to usdc" }
      });
      const surfaceText = surfacePrompt.messages
        .map((message) => (message.content.type === "text" ? message.content.text : ""))
        .join("\n");
      expect(surfaceText).toContain('intent: "10 sui to usdc"');
      expect(surfaceText).toContain("action_start_review");
      expect(surfaceText).toContain("never contains signing data, transaction bytes, or signing readiness");
      expect(surfaceText).toContain("request status is separate from server-verified chain execution facts");

      const prompt = await client.getPrompt({ name: "prepare-reviewable-sui-action" });
      const text = prompt.messages
        .map((message) => (message.content.type === "text" ? message.content.text : ""))
        .join("\n");
      expect(text).toContain("never contains signing data, transaction bytes, or signing readiness");
      expect(text).toContain("request status is separate from server-verified chain execution facts");
      expect(text).toContain("read-only local review and never become signing material");
      expect(text).not.toContain("Safe to sign");
    } finally {
      await server.close();
    }
  });

  it("reports server status as a read-only tool", async () => {
    const { client, server } = await connectTestClient();
    try {
      const result = await client.callTool({ name: TOOL_NAMES.readGetServerStatus });
      const content = result.content as Array<{ type: string; text?: string }>;
      const firstContent = content[0];
      expect(firstContent).toBeDefined();
      expect(firstContent?.type).toBe("text");
      const payload = JSON.parse(firstContent?.type === "text" ? (firstContent.text ?? "") : "");
      expect(payload).toMatchObject({
        ok: true,
        data: {
          packageName: PACKAGE_NAME,
          version: SERVER_VERSION,
          evidencePolicy: {
            version: EVIDENCE_POLICY.version,
            releaseGate: "intent_evidence_v1",
            requiredFirstCheck: true,
            requiredStatusFields: [
              "packageName",
              "version",
              "evidencePolicy.version",
              "network",
              "implementedToolsCount"
            ],
            gates: expect.arrayContaining([
              "server_status_version_check",
              "natural_language_settlement_asset_group_evidence",
              "sdk_sot_no_duplicate_registry_or_amount_parser",
              "requested_account_inference_policy",
              "wallet_balance_snapshot_not_receipt_proof",
              "deepbook_quote_no_fiat_or_route_inference",
              "pnl_unsupported"
            ])
          },
          network: "mainnet",
          runtime: "local_stdio",
          transport: "grpc_graphql",
          implementedToolsCount: IMPLEMENTED_TOOLS.length,
          protocolsTool: TOOL_NAMES.readListSupportedProtocols,
          resources: {
            count: MCP_RESOURCES.length,
            uris: MCP_RESOURCES.map((resource) => resource.uri),
            items: MCP_RESOURCES.map((resource) => ({
              name: resource.name,
              uri: resource.uri,
              title: resource.title,
              description: resource.description
            }))
          }
        }
      });
      const data = payload.data as {
        failClosedTools: string[];
        implementedTools: string[];
        implementedToolsCount: number;
      };
      expect(payload.data.packageName).toBe(PACKAGE_NAME);
      const limitations = (payload.data.limitations as string[] | undefined)?.join("\n") ?? "";
      expect(limitations).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.officialIndexerCandleData);
      expect(limitations).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.officialIndexerCandleReferences);
      expect(limitations).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.officialIndexerUsdcDenominatedCandles);
      expect(limitations).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.pinnedSdkSnapshots);
      expect(limitations).toContain(DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.usdcNotFiatUsdAndNotPeg);
      expect(limitations).not.toMatch(
        /official Indexer[\s\S]{0,120}(owns|provides|supports|returns|is used for)\s+(orderbook|mid-price|quote|account inventory)/i
      );
      expect(limitations).not.toMatch(/DeepBook source owner contract[\s\S]{0,120}FlowX/i);
      expect(data.implementedToolsCount).toBe(data.implementedTools.length);
      expect(data.failClosedTools).not.toContain(TOOL_NAMES.readQuoteDeepbookAction);
      expect(data.failClosedTools).not.toContain(TOOL_NAMES.readQuoteDeepbookDisplayAmount);
      expect(data.implementedTools).toContain(TOOL_NAMES.readQuoteDeepbookAction);
      expect(data.implementedTools).toContain(TOOL_NAMES.readQuoteDeepbookDisplayAmount);
      expect(data.implementedTools).toEqual(
        expect.arrayContaining([
          TOOL_NAMES.readListDeepbookTokens,
          TOOL_NAMES.readGetDeepbookMidPrice,
          TOOL_NAMES.readGetDeepbookUsdcPriceHistory,
          TOOL_NAMES.readQuoteDeepbookDisplayAmount,
          TOOL_NAMES.readSummarizeDeepbookAccountInventory,
          TOOL_NAMES.readClassifyWalletAssets,
          TOOL_NAMES.readListSettlementAssetGroups,
          TOOL_NAMES.readSummarizeSettlementAssetGroupParity,
          TOOL_NAMES.readPreviewIntentEvidence,
          TOOL_NAMES.settingsCreateLocalSettingsSession,
          TOOL_NAMES.settingsGetLocalSettings,
          TOOL_NAMES.sessionWaitWalletConnectionCard,
          TOOL_NAMES.sessionGetInteractionStatus,
          TOOL_NAMES.sessionWaitExecutionResult,
        ])
      );
    } finally {
      await server.close();
    }
  });

  it("keeps server status tool lists in sync with registered MCP tools", async () => {
    const { client, server } = await connectTestClient();
    try {
      const status = textPayload(await client.callTool({ name: TOOL_NAMES.readGetServerStatus })) as {
        data: { failClosedTools: string[]; implementedTools: string[]; implementedToolsCount: number };
      };
      const registeredToolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
      const reportedToolNames = [
        ...status.data.implementedTools,
        ...status.data.failClosedTools
      ].sort();

      expect(new Set(status.data.implementedTools).size).toBe(status.data.implementedTools.length);
      expect(status.data.implementedToolsCount).toBe(status.data.implementedTools.length);
      expect(new Set(status.data.failClosedTools).size).toBe(status.data.failClosedTools.length);
      for (const failClosedTool of status.data.failClosedTools) {
        expect(status.data.implementedTools).not.toContain(failClosedTool);
      }
      expect(reportedToolNames).toEqual(registeredToolNames);
      expect(registeredToolNames).not.toContain("read.list_flowx_pools");
      expect(registeredToolNames).not.toContain("read.quote_flowx_swap");
    } finally {
      await server.close();
    }
  });

  it("marks lifecycle writes and intent evidence annotations according to product authority", async () => {
    const { client, server } = await connectTestClient();
    try {
      const tools = await client.listTools();
      const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));

      for (const toolName of [
        TOOL_NAMES.sessionOpenWalletConnectionCard,
        TOOL_NAMES.sessionGetWalletConnectionCard,
        TOOL_NAMES.sessionWaitWalletConnectionCard,
        TOOL_NAMES.sessionGetInteractionStatus,
        TOOL_NAMES.sessionGetReviewStatus,
        TOOL_NAMES.sessionGetExecutionResult,
        TOOL_NAMES.sessionWaitExecutionResult
      ]) {
        expect(toolsByName.get(toolName)?.annotations).toMatchObject({
          readOnlyHint: false,
          openWorldHint: false
        });
      }

      expect(toolsByName.get(TOOL_NAMES.readSummarizeWalletAssets)?.annotations).toMatchObject({
        readOnlyHint: false,
        openWorldHint: false
      });
      expect(toolsByName.get(TOOL_NAMES.readClassifyWalletAssets)?.annotations).toMatchObject({
        readOnlyHint: false,
        openWorldHint: false
      });
      expect(toolsByName.get(TOOL_NAMES.readPreviewIntentEvidence)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false
      });
      expect(JSON.stringify(toolsByName.get(TOOL_NAMES.readPreviewIntentEvidence)?.inputSchema)).toContain(
        "targetAssetSelectionSource"
      );
      expect(JSON.stringify(toolsByName.get(TOOL_NAMES.readPreviewIntentEvidence)?.inputSchema)).toContain(
        "user_explicit"
      );
      expect(toolsByName.get(TOOL_NAMES.readListSettlementAssetGroups)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false
      });
      expect(toolsByName.get(TOOL_NAMES.readSummarizeSettlementAssetGroupParity)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false
      });
      expect(toolsByName.get(TOOL_NAMES.readSummarizeDeepbookAccountInventory)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false
      });
      expect(toolsByName.get(TOOL_NAMES.readQuoteDeepbookDisplayAmount)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false
      });

      expect(toolsByName.get(TOOL_NAMES.accountGetActiveAccount)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false
      });
    } finally {
      await server.close();
    }
  });

  it("exposes local settings tools through MCP", async () => {
    const f = await settingsWorkflowFixture();
    const { client, server } = await connectTestClient({ activityStore: f.wallet.activity, localSettings: f.localSettings,
      cards: { store: f.cards }, workflow: f.wallet.workflow });
    try {
      const tools = await client.listTools();
      const settingsTools = tools.tools.filter((tool) => tool.name.startsWith("settings_"));
      expect(settingsTools.map((tool) => tool.name).sort()).toEqual([
        TOOL_NAMES.settingsCreateLocalSettingsSession,
        TOOL_NAMES.settingsGetLocalSettings
      ].sort());
      for (const tool of settingsTools) {
        expect(tool.description).not.toMatch(/must|should|always/i);
      }

      expect(tools.tools.find((tool) => tool.name === TOOL_NAMES.settingsCreateLocalSettingsSession)?._meta).toMatchObject({ ui: { resourceUri: CARD_RESOURCE_URIS.settings } });
      const created = await f.wallet.run(() => client.callTool({ name: TOOL_NAMES.settingsCreateLocalSettingsSession }));
      const createdPayload = textPayload(created) as { ok: boolean; data: unknown };
      expect(createdPayload.ok).toBe(true);
      expect(cardSnapshotSchema.parse(createdPayload.data)).toMatchObject({ kind: "settings", state: "ready", input: {}, data: { phase: "draft" } });
      expect(JSON.stringify(createdPayload)).not.toMatch(/settingsUrl|openTarget|settingsSessionId|permission/);
      expect(created._meta?.[CARD_METADATA_KEY]).toHaveProperty("permission");
      for (const name of [CARD_TOOLS.act, CARD_TOOLS.readSettingsFile]) {
        expect(tools.tools.find((tool) => tool.name === name)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
      }
      expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.wallet.connect).not.toHaveBeenCalled();

      const current = await f.wallet.run(() => client.callTool({ name: TOOL_NAMES.settingsGetLocalSettings }));
      expect(textPayload(current)).toMatchObject({
        ok: true,
        data: {
          suiGrpcUrl: {
            storedValue: "https://fullnode.mainnet.sui.io:443",
            effectiveValue: "https://fullnode.mainnet.sui.io:443",
            source: "builtin_default"
          }
        }
      });
    } finally {
      await server.close();
      f.close();
    }
  });

  it("reports env-overridden local settings metadata through MCP", async () => {
    const { client, server } = await connectTestClient({
      localSettings: await createDefaultLocalSettings({
        env: { SUI_MCP_GRPC_URL: "https://override.sui.provider:9443" }
      })
    });
    try {
      const current = await client.callTool({ name: TOOL_NAMES.settingsGetLocalSettings });
      expect(textPayload(current)).toMatchObject({
        ok: true,
        data: {
          suiGrpcUrl: {
            storedValue: "https://fullnode.mainnet.sui.io:443",
            effectiveValue: "https://override.sui.provider:9443",
            source: "environment",
            pendingStoredValue: "https://fullnode.mainnet.sui.io:443",
            appliesAfter: "mcp_server_restart"
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("maps local settings repository and endpoint value failures deterministically", async () => {
    const failingStoreErrors: Array<{ error: Error; reason: string }> = [
      {
        error: new PreferencesStoreError("malformed_json", "Malformed local setting JSON", { key: "suiGrpcUrl" }),
        reason: "malformed_json"
      },
      {
        error: new PreferencesStoreError("invalid_value", "suiGrpcUrl setting value must be a string", {
          key: "suiGrpcUrl"
        }),
        reason: "invalid_value"
      },
      {
        error: new PreferencesStoreError("unknown_key", "Unknown local setting key", { key: "unexpected" }),
        reason: "unknown_key"
      },
      {
        error: new PreferencesStoreError("not_recorded", "Local setting was not recorded", { key: "suiGrpcUrl" }),
        reason: "not_recorded"
      },
      {
        error: new SuiEndpointError("invalid_url", "Sui gRPC URL must include only scheme, host, and explicit port"),
        reason: "invalid_url"
      }
    ];

    for (const { error, reason } of failingStoreErrors) {
      const { client, server } = await connectTestClient({
        localSettings: {
          async getLocalSettings() {
            throw error;
          },
          async setSuiGrpcUrl() {
            throw error;
          },
          async resetSuiGrpcUrl() {
            throw error;
          },
          async setSuiGraphqlUrl() {
            throw error;
          },
          async resetSuiGraphqlUrl() {
            throw error;
          }
        }
      });
      try {
        const calls = [{ name: TOOL_NAMES.settingsGetLocalSettings }];
        for (const call of calls) {
          const current = await client.callTool(call);
          expect(textPayload(current)).toMatchObject({
            ok: false,
            error: {
              kind: "internal_error",
              details: { reason }
            }
          });
        }
      } finally {
        await server.close();
      }
    }
  });

  it("exposes live read-only tools through MCP", async () => {
    const walletFixture = await walletWorkflowFixture();
    try { await walletFixture.run(async () => {
    const { client, server } = await connectTestClient({ activityStore: walletFixture.activity, workflow: walletFixture.workflow });
    try {
      const tools = await client.listTools();
      const deepbookReadToolNames = new Set<string>([
        TOOL_NAMES.readListDeepbookPools,
        TOOL_NAMES.readListDeepbookTokens,
        TOOL_NAMES.readInspectDeepbookOrderbook,
        TOOL_NAMES.readGetDeepbookMidPrice,
        TOOL_NAMES.readGetDeepbookUsdcPriceHistory,
        TOOL_NAMES.readQuoteDeepbookAction,
        TOOL_NAMES.readSummarizeDeepbookAccountInventory
      ]);
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...deepbookReadToolNames]));
      for (const tool of tools.tools.filter((item) => deepbookReadToolNames.has(item.name))) {
        expect(tool.description).not.toMatch(/must|should|always/i);
      }

      const pendingWallet = await client.callTool({
        name: TOOL_NAMES.readSummarizeWalletAssets,
        arguments: {}
      });
      expect(JSON.parse((pendingWallet.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({
        ok: false,
        error: {
          kind: "active_account_not_set",
          details: { action: "provide_account" }
        }
      });
      const pendingClassification = await client.callTool({
        name: TOOL_NAMES.readClassifyWalletAssets,
        arguments: {}
      });
      expect(textPayload(pendingClassification)).toMatchObject({
        ok: false,
        error: {
          kind: "active_account_not_set",
          details: { action: "provide_account" }
        }
      });
      const explicitWallet = await client.callTool({
        name: TOOL_NAMES.readSummarizeWalletAssets,
        arguments: { account: replacementWalletAccount }
      });
      expect(textPayload(explicitWallet)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          account: replacementWalletAccount,
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["current_coin_balance_snapshot"]),
            cannotAnswer: expect.arrayContaining([
              "payment_coverage_or_shortfall",
              "usd_denominated_settlement_asset_balance_total"
            ]),
            answerFields: expect.arrayContaining(["balances[].display"]),
            followUp: {
              tool: TOOL_NAMES.readPreviewIntentEvidence,
              inputFields: ["account"],
              answerFields: ["responseSummary"]
            }
          },
          quantitySemantics: {
            kind: "sui_wallet_balance_snapshot",
            currentBalanceSnapshot: true,
            transactionReceiptProofAvailable: false,
            transactionBalanceDeltaAvailable: false,
            acquisitionSourceAvailable: false,
            objectProvenanceAvailable: false,
            notFor: expect.arrayContaining(["transaction_receipt_proof", "specific_transaction_balance_delta"])
          },
          balances: []
        }
      });
      const explicitClassification = await client.callTool({
        name: TOOL_NAMES.readClassifyWalletAssets,
        arguments: { account: replacementWalletAccount }
      });
      expect(textPayload(explicitClassification)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          account: replacementWalletAccount,
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["current_coin_balance_classification"]),
            cannotAnswer: expect.arrayContaining([
              "payment_coverage_or_shortfall",
              "usd_denominated_settlement_asset_balance_total"
            ]),
            answerFields: expect.arrayContaining(["classifiedAssets[].classification"])
          },
          quantitySemantics: {
            kind: "sui_wallet_balance_snapshot",
            transactionHistoryAvailable: false,
            transactionReceiptProofAvailable: false
          },
          classifiedAssets: []
        }
      });
      const pendingIntentEvidence = await client.callTool({
        name: TOOL_NAMES.readPreviewIntentEvidence,
        arguments: {
          intentKind: "cover_payment_like_amount",
          denomination: "dollar",
          requiredDisplayAmount: "1"
        }
      });
      expect(textPayload(pendingIntentEvidence)).toMatchObject({
        ok: false,
        error: {
          kind: "active_account_not_set",
          details: { action: "provide_account" }
        }
      });
      const pendingDeepbookAccount = await client.callTool({
        name: TOOL_NAMES.readSummarizeDeepbookAccountInventory,
        arguments: {}
      });
      expect(textPayload(pendingDeepbookAccount)).toMatchObject({
        ok: false,
        error: {
          kind: "active_account_not_set",
          details: { reason: "connected_account_required", followUp: { tool: TOOL_NAMES.sessionGetInteractionStatus } }
        }
      });
      await walletFixture.connectSession({ topic: "inventory-source", grants: suiGrants([walletAccount]), expiresAt: new Date(walletFixture.now().getTime() + 60000).toISOString() });
      const wallet = await client.callTool({
        name: TOOL_NAMES.readSummarizeWalletAssets,
        arguments: {}
      });
      expect(JSON.parse((wallet.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          quantitySemantics: {
            kind: "sui_wallet_balance_snapshot",
            transactionReceiptProofAvailable: false
          }
        }
      });
      const settlementFamilies = await client.callTool({
        name: TOOL_NAMES.readListSettlementAssetGroups,
        arguments: {}
      });
      expect(textPayload(settlementFamilies)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          assetGroups: [
            {
              id: "SUI_USD_SETTLEMENT_ASSETS",
              aliases: expect.arrayContaining(["dollar", "stablecoins"]),
              includedAssets: expect.arrayContaining([expect.objectContaining({ symbol: "USDC" })]),
              evidenceSources: {
                sdk: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.sdk,
                registry: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.registry,
                unitSource: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.unitSource
              }
            }
          ]
        }
      });
      const settlementParity = await client.callTool({
        name: TOOL_NAMES.readSummarizeSettlementAssetGroupParity,
        arguments: { denomination: "dollar" }
      });
      expect(textPayload(settlementParity)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          denomination: "dollar",
          assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
          referenceAsset: {
            symbol: "USDC",
            role: "measurement_reference_not_settlement_choice"
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["settlement_asset_group_internal_parity_statistics"]),
            cannotAnswer: expect.arrayContaining(["settlement_token_selection", "payment_coverage_or_shortfall"]),
            answerFields: expect.arrayContaining(["responseSummary"]),
            preconditionFields: expect.arrayContaining(["toolAvailability"]),
            diagnosticOnlyFields: expect.not.arrayContaining(["toolAvailability"])
          },
          toolAvailability: {
            statusTool: TOOL_NAMES.readGetServerStatus,
            packageName: PACKAGE_NAME,
            version: SERVER_VERSION,
            evidencePolicyVersion: EVIDENCE_POLICY.version,
            network: "mainnet",
            implementedToolsCount: IMPLEMENTED_TOOLS.length,
            requiredTools: expect.arrayContaining([
              { name: TOOL_NAMES.readGetServerStatus, available: true },
              { name: TOOL_NAMES.readListSettlementAssetGroups, available: true },
              { name: TOOL_NAMES.readSummarizeSettlementAssetGroupParity, available: true }
            ]),
            missingRequiredTools: [],
            requiredToolsAvailable: true,
            unavailableReason: null
          },
          quantitySemantics: {
            kind: "settlement_asset_group_parity_snapshot",
            allowedUse: "settlement_asset_group_internal_parity_evidence",
            settlementTokenSelectionAvailable: false,
            fiatUsdCashOutAvailable: false
          },
          assets: expect.arrayContaining([
            expect.objectContaining({
              symbol: "USDC",
              status: "reference_asset",
              priceInReferenceAsset: 1
            })
          ]),
          statistics: {
            status: "available",
            sampleCount: 7,
            unavailableAssetCount: 0,
            parityDirection: "reference_asset_per_group_asset"
          },
          responseSummary: {
            questionKind: "settlement_asset_group_parity",
            conclusionKind: "parity_statistics_available",
            referenceAssetRole: "measurement_reference_not_settlement_choice",
            min: expect.objectContaining({ priceInReferenceAsset: expect.any(Number) }),
            max: expect.objectContaining({ priceInReferenceAsset: expect.any(Number) }),
            mean: expect.objectContaining({ priceInReferenceAsset: expect.any(Number) }),
            median: expect.objectContaining({ priceInReferenceAsset: expect.any(Number) })
          },
          unsupportedClaims: expect.arrayContaining(["settlement_token_selection", "fiat_usd_cash_out"])
        }
      });
      const classified = await client.callTool({
        name: TOOL_NAMES.readClassifyWalletAssets,
        arguments: {}
      });
      expect(textPayload(classified)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["current_coin_balance_classification"]),
            cannotAnswer: expect.arrayContaining([
              "complete_portfolio_inventory",
              "usd_denominated_settlement_asset_balance_total"
            ])
          },
          quantitySemantics: {
            kind: "sui_wallet_balance_snapshot",
            transactionReceiptProofAvailable: false
          },
          classifiedAssets: [],
          uninspectedAssetClasses: [
            { assetClass: "staked_or_locked_asset" },
            { assetClass: "deepbook_balance_manager_or_open_order" },
            { assetClass: "lp_vault_or_position" },
            { assetClass: "nft_or_object_asset" }
          ]
        }
      });
      const intentEvidence = await client.callTool({
        name: TOOL_NAMES.readPreviewIntentEvidence,
        arguments: {
          intentKind: "cover_payment_like_amount",
          denomination: "dollar",
          requiredDisplayAmount: "1"
        }
      });
      expect(textPayload(intentEvidence)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          intent: {
            intentKind: "cover_payment_like_amount",
            denomination: "dollar",
            requiredDisplayAmount: "1"
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["usd_denominated_payment_shortfall"]),
            cannotAnswer: expect.arrayContaining(["settlement_token_selection", "route_dependent_payment_support"]),
            answerFields: expect.arrayContaining([
              "responseSummary",
              "responseSummary.amountsUsedForAnswer",
              "responseSummary.shortfallDisplayAmount"
            ]),
            conclusionRuleFields: expect.arrayContaining([
              "responseSummary.doNotCallQuoteToolsForThisQuestion",
              "responseSummary.doNotUseForConclusion",
              "responseSummary.excludedFromConclusion"
            ]),
            preconditionFields: expect.arrayContaining(["toolAvailability"]),
            diagnosticOnlyFields: expect.not.arrayContaining(["toolAvailability"])
          },
          toolAvailability: {
            statusTool: TOOL_NAMES.readGetServerStatus,
            packageName: PACKAGE_NAME,
            version: SERVER_VERSION,
            evidencePolicyVersion: EVIDENCE_POLICY.version,
            network: "mainnet",
            implementedToolsCount: IMPLEMENTED_TOOLS.length,
            requiredTools: expect.arrayContaining([
              { name: TOOL_NAMES.readGetServerStatus, available: true },
              { name: TOOL_NAMES.readListSettlementAssetGroups, available: true },
              { name: TOOL_NAMES.readPreviewIntentEvidence, available: true }
            ]),
            missingRequiredTools: [],
            requiredToolsAvailable: true,
            unavailableReason: null
          },
          quantitySemantics: {
            kind: "sui_intent_evidence_report",
            transactionBuildingAvailable: false,
            signingReadinessAvailable: false,
            routeRecommendationAvailable: false
          },
          aggregate: {
            status: "available",
            requiredRawAmount: "1000000",
            currentRawAmount: "0",
            shortfallRawAmount: "1000000"
          },
          settlementAssetCoverage: {
            status: "shortfall_in_settlement_asset_balance",
            requiredDisplayAmount: "1",
            currentDisplayAmount: "0",
            shortfallDisplayAmount: "1"
          },
          responseEvidence: {
            mode: "settlement_asset_only",
            primaryEvidenceFields: ["responseSummary"],
            supportedResponseClaims: [
              "settlement_asset_coverage_status",
              "settlement_asset_shortfall",
              "required_user_choices",
              "unsupported_inferences"
            ]
          },
          responseSummary: {
            questionKind: "payment_coverage",
            conclusionKind: "shortfall_in_settlement_asset_balance",
            coverageBasis: "settlement_asset_wallet_balance_only",
            assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
            currentDisplayAmount: "0",
            requiredDisplayAmount: "1",
            shortfallDisplayAmount: "1",
            excludedFromConclusion: expect.arrayContaining([
              "separate_quote_tool_results",
              "assets_outside_settlement_group",
              "route_dependent_payment_support"
            ])
          },
          blockedReasons: [],
          candidateConversions: [],
          unsupportedClaims: expect.arrayContaining([
            "settlement_token_selection",
            "payment_execution_readiness",
            "signing_readiness"
          ])
        }
      });

      const inferredTargetEvidence = await client.callTool({
        name: TOOL_NAMES.readPreviewIntentEvidence,
        arguments: {
          intentKind: "cover_payment_like_amount",
          denomination: "dollar",
          requiredDisplayAmount: "1",
          targetAssetSymbol: "USDC"
        }
      });
      expect(textPayload(inferredTargetEvidence)).toMatchObject({
        ok: false,
        error: {
          kind: "input_invalid",
          details: { field: "targetAssetSelectionSource", requiredWith: "targetAssetSymbol" }
        }
      });

      const selectedTargetEvidence = await client.callTool({
        name: TOOL_NAMES.readPreviewIntentEvidence,
        arguments: {
          intentKind: "cover_payment_like_amount",
          denomination: "dollar",
          requiredDisplayAmount: "1",
          targetAssetSymbol: "USDC",
          targetAssetSelectionSource: "user_explicit"
        }
      });
      expect(textPayload(selectedTargetEvidence)).toMatchObject({
        ok: true,
        data: {
          intent: {
            targetAssetSymbol: "USDC",
            targetAssetSelectionSource: "user_explicit"
          },
          selectedTarget: {
            symbol: "USDC",
            selectionSource: "user_explicit",
            currentDisplayAmount: "0",
            shortfallDisplayAmount: "1"
          },
          responseEvidence: {
            mode: "selected_target_context",
            primaryEvidenceFields: [
              "responseSummary",
              "selectedTarget",
              "candidateConversions",
              "requiredUserChoices"
            ]
          }
        }
      });

      const balanceTotalIntentEvidence = await client.callTool({
        name: TOOL_NAMES.readPreviewIntentEvidence,
        arguments: {
          intentKind: "summarize_settlement_asset_group_balance",
          denomination: "dollar"
        }
      });
      expect(textPayload(balanceTotalIntentEvidence)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          intent: {
            intentKind: "summarize_settlement_asset_group_balance",
            denomination: "dollar"
          },
          aggregate: {
            status: "available",
            currentRawAmount: "0",
            currentDisplayAmount: "0"
          },
          settlementAssetCoverage: {
            status: "balance_total_only",
            currentDisplayAmount: "0"
          },
          responseEvidence: {
            mode: "settlement_asset_only",
            primaryEvidenceFields: ["responseSummary"],
            supportedResponseClaims: ["current_settlement_asset_total", "required_user_choices", "unsupported_inferences"]
          },
          responseSummary: {
            questionKind: "settlement_asset_group_balance_total",
            conclusionKind: "current_settlement_asset_total",
            coverageBasis: "settlement_asset_wallet_balance_only",
            currentDisplayAmount: "0",
            requiredDisplayAmount: null,
            shortfallDisplayAmount: null
          },
          requiredUserChoices: [],
          candidateConversions: []
        }
      });

      const quote = await client.callTool({
        name: TOOL_NAMES.readQuoteDeepbookAction,
        arguments: { poolKey: "DEEP_SUI", direction: "base_to_quote", amountRaw: "10" }
      });
      expect(JSON.parse((quote.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          source: { method: "getQuoteQuantityOut" }
        }
      });

      const displayQuote = await client.callTool({
        name: TOOL_NAMES.readQuoteDeepbookDisplayAmount,
        arguments: { poolKey: "SUI_USDC", direction: "base_to_quote", amountDisplay: "10" }
      });
      const displayQuotePayload = textPayload(displayQuote) as { data: { quote: unknown } };
      expect(displayQuotePayload).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          pool: { poolKey: "SUI_USDC", base: "SUI", quote: "USDC" },
          inputAmount: {
            display: "10",
            raw: "10000000000",
            asset: { symbol: "SUI", unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE }
          },
          source: { method: "getQuoteQuantityOut" },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["indicative_deepbook_pool_quote_for_explicit_source_input"]),
            cannotAnswer: expect.arrayContaining(["payment_coverage", "payment_shortfall", "final_min_out"]),
            answerFields: expect.arrayContaining(["quote.quoteOut", "rawQuote.directionalOutput"]),
            followUp: {
              tool: TOOL_NAMES.readPreviewIntentEvidence,
              answerFields: ["responseSummary"]
            }
          },
          rawQuote: {
            kind: "deepbook_quote_raw_u64",
            sourceMoveFunction: "pool::get_quote_quantity_out",
            returnValueSourceMoveFunction: "pool::get_quantity_out",
            directionalOutput: { raw: "1000000", symbol: "USDC" },
            boundary: {
              outputBeforeSlippagePolicy: true,
              notFor: [
                "final_min_out",
                "transaction_building",
                "signing_data",
                "signing_readiness",
                "price_impact",
                "mid_price_slippage",
                "quote_vs_mid_slippage",
                "effective_price",
                "venue_comparison",
                "best_route",
                "route_recommendation",
                "fiat_usd_cash_out",
                "external_market_price_conversion",
                "external_market_lookup",
                "usd_peg_assumption",
                "bank_cash_out_estimate",
                "profit_or_pnl",
                "cost_basis"
              ]
            }
          },
          quantitySemantics: {
            kind: "deepbook_quote_display_amount",
            inputAmountKind: "display_source_amount_converted_to_raw_u64",
            allowedUse: "indicative_deepbook_pool_quote",
            rawAmountAvailable: true,
            rawEvidenceField: "rawQuote",
            paymentCoverageAvailable: false,
            shortfallContributionAvailable: false,
            routeDependentPaymentSupportAvailable: false,
            requiresIntentEvidenceForCoverage: true,
            canUseForPaymentAnswer: false,
            canUseForShortfallAnswer: false,
            doNotCombineWithPaymentAnswer: true,
            requiredPaymentAnswerTool: "read_preview_intent_evidence",
            paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
            requiredPaymentAnswerField: "responseSummary",
            fiatUsdCashOutAvailable: false,
            externalMarketPriceConversionAvailable: false,
            externalMarketLookupAvailable: false,
            usdPegAssumptionAvailable: false,
            bankCashOutEstimateAvailable: false,
            profitAndLossAvailable: false,
            costBasisAvailable: false,
            priceImpactAvailable: false,
            midPriceSlippageAvailable: false,
            venueComparisonAvailable: false,
            routeRecommendationAvailable: false,
            notFor: [
              "signing",
              "funding",
              "payment_coverage",
              "shortfall_contribution",
              "route_dependent_payment_support",
              "route_liquidity",
              "min_out",
              "liquidity_verdict",
              "price_impact",
              "mid_price_slippage",
              "quote_vs_mid_slippage",
              "effective_price",
              "venue_comparison",
              "best_route",
              "route_recommendation",
              "transaction_building",
              "fiat_usd_cash_out",
              "external_market_price_conversion",
              "external_market_lookup",
              "usd_peg_assumption",
              "bank_cash_out_estimate",
              "profit_or_pnl",
              "cost_basis"
            ]
          }
        }
      });
      expect(displayQuotePayload.data.quote).toEqual({ baseOut: "0", quoteOut: "1", deepRequired: "0" });
      expect(displayQuotePayload.data.quote).not.toHaveProperty("baseQuantity");
      expect(displayQuotePayload.data.quote).not.toHaveProperty("quoteQuantity");

      const deepbookAccountDiscovery = await client.callTool({
        name: TOOL_NAMES.readSummarizeDeepbookAccountInventory,
        arguments: {}
      });
      expect(textPayload(deepbookAccountDiscovery)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          detailStatus: "manager_discovery_only",
          account: walletAccount,
          managerAddresses: [deepbookManagerAddress],
          source: { methods: ["getBalanceManagerIds"] },
          userAnswerUse: {
            canAnswer: ["active_account_deepbook_balance_manager_discovery"],
            cannotAnswer: expect.arrayContaining(["deepbook_pool_account_inventory_when_detailStatus_is_not_available"]),
            preconditionFields: ["detailStatus"],
            answerFields: expect.arrayContaining(["managerAddresses", "detailStatus"])
          }
        }
      });

      const deepbookAccountDetail = await client.callTool({
        name: TOOL_NAMES.readSummarizeDeepbookAccountInventory,
        arguments: { poolKey: "SUI_USDC", managerAddress: deepbookManagerAddress }
      });
      const deepbookAccountDetailPayload = textPayload(deepbookAccountDetail) as {
        data: { userAnswerUse: { cannotAnswer: string[] } };
      };
      expect(deepbookAccountDetailPayload).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          detailStatus: "available",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"]),
            preconditionFields: ["detailStatus"],
            cannotAnswer: expect.arrayContaining(["current_wallet_coin_balance", "funding_source"]),
            answerFields: expect.arrayContaining(["accountSummary", "lockedBalances"]),
            followUp: {
              tool: TOOL_NAMES.readSummarizeWalletAssets,
              answerFields: ["balances"]
            }
          },
          quantitySemantics: {
            kind: "deepbook_display_number",
            rawAmountAvailable: false,
            notFor: ["signing", "funding", "route_liquidity", "withdrawal_readiness", "transaction_building"]
          },
          accountSummary: {
            epoch: "42",
            settledBalances: { base: 4, quote: 5, deep: 6 },
            owedBalances: { base: 7, quote: 8, deep: 9 },
            unclaimedRebates: { base: 1, quote: 2, deep: 3 }
          },
          lockedBalances: { base: 10, quote: 11, deep: 12 },
          openOrderIds: ["100", "101"],
          openOrderCount: 2,
          openOrderIdsTruncated: false
        }
      });
      expect(deepbookAccountDetailPayload.data.userAnswerUse.cannotAnswer).not.toContain(
        "deepbook_pool_account_inventory_when_detailStatus_is_not_available"
      );

      const tokens = await client.callTool({ name: TOOL_NAMES.readListDeepbookTokens });
      expect(textPayload(tokens)).toMatchObject({
        ok: true,
        data: {
          source: "@mysten/deepbook-v3 mainnetCoins",
          tokens: expect.arrayContaining([
            expect.objectContaining({ symbol: "SUI", poolKeys: expect.arrayContaining(["SUI_USDC"]) }),
            expect.objectContaining({ symbol: "USDC" }),
            expect.objectContaining({ symbol: "DEEP" })
          ])
        }
      });

      const midPrice = await client.callTool({
        name: TOOL_NAMES.readGetDeepbookMidPrice,
        arguments: { poolKey: "SUI_USDC" }
      });
      expect(textPayload(midPrice)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          poolKey: "SUI_USDC",
          base: "SUI",
          quote: "USDC",
          priceDirection: "quote_per_base",
          priceType: "deepbook_mid_price",
          source: {
            method: "midPrice",
            precision: "deepbook_v3_to_fixed_9_js_number"
          },
          userAnswerUse: {
            canAnswer: ["deepbook_pool_mid_price_context"],
            cannotAnswer: expect.arrayContaining([
              "payment_coverage_or_shortfall",
              "price_impact",
              "transaction_building",
              "signing_data_or_readiness"
            ]),
            answerFields: expect.arrayContaining(["price", "fetchedAt"]),
            followUp: {
              tool: TOOL_NAMES.readPreviewIntentEvidence,
              answerFields: ["responseSummary"]
            }
          },
          priceSemantics: {
            kind: "deepbook_mid_price_snapshot",
            externalMarketLookupAvailable: false,
            usdPegAssumptionAvailable: false,
            notFor: expect.arrayContaining([
              "price_impact",
              "venue_comparison",
              "fiat_usd_cash_out",
              "external_market_lookup",
              "usd_peg_assumption",
              "transaction_building",
              "signing_data",
              "signing_readiness"
            ])
          }
        }
      });

      const priceHistory = await client.callTool({
        name: TOOL_NAMES.readGetDeepbookUsdcPriceHistory,
        arguments: {
          poolName: "SUI_USDC",
          start: "2026-06-26T19:40:00.000Z",
          end: "2026-06-26T20:10:00.000Z"
        }
      });
      expect(textPayload(priceHistory)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          requested: {
            selector: { kind: "pool_name", value: "SUI_USDC" },
            range: {
              start: "2026-06-26T19:40:00.000Z",
              end: "2026-06-26T20:10:00.000Z",
              timeZone: "UTC",
              interval: "15m",
              intervalDurationMs: 900000,
              maxBars: 1008,
              requestedCandleSlots: 2
            }
          },
          pair: {
            poolName: "SUI_USDC",
            quoteAsset: {
              symbol: "USDC",
              coinType: DEEPBOOK_OFFICIAL_INDEXER_CANONICAL_USDC_COIN_TYPE,
              decimals: 6
            },
            priceConvention: "USDC_PER_BASE"
          },
          candleAvailability: "available",
          barCount: 2,
          source: {
            kind: DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind,
            baseUrl: "https://deepbook-indexer.mainnet.mystenlabs.com",
            poolList: {
              url: "https://deepbook-indexer.mainnet.mystenlabs.com/get_pools"
            },
            candles: {
              poolName: "SUI_USDC",
              interval: "15m"
            },
            chainRecomputedBySuiMcp: false
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining([DEEPBOOK_ANSWER_USE.officialUsdcCandleHistory]),
            cannotAnswer: expect.arrayContaining([
              "fiat_usd_cash_out",
              "usd_peg_assumption",
              "signing_data_or_readiness"
            ]),
            answerFields: expect.arrayContaining(["bars", "source.candles", "responseSummary"])
          },
          quantitySemantics: {
            kind: "deepbook_official_indexer_candles",
            allowedUse: DEEPBOOK_ANSWER_USE.officialUsdcCandleHistory,
            source: DEEPBOOK_OFFICIAL_INDEXER_SOURCE_BASE.kind,
            quoteAsset: "USDC",
            priceConvention: "USDC_PER_BASE",
            usdcIsFiatUsd: false,
            usdPegGuaranteeAvailable: false,
            chainRecomputedBySuiMcp: false,
            liveQuoteAvailable: false,
            historicalMidPriceAvailable: false,
            routeRecommendationAvailable: false,
            transactionBuildingAvailable: false,
            signingReadinessAvailable: false,
            profitAndLossAvailable: false,
            costBasisAvailable: false,
            notFor: expect.arrayContaining([
              "fiat_usd_cash_out",
              "usd_peg_assumption",
              "historical_mid_price",
              "live_quote",
              "route_recommendation",
              "best_route",
              "transaction_building",
              "signing_data",
              "signing_readiness",
              "profit_or_pnl",
              "cost_basis"
            ])
          },
          responseSummary: {
            sourceStatement: DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.sourceStatement,
            usdcDisclaimer: DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.usdcDisclaimer,
            candleMeaning: "Each candle is returned by the DeepBookV3 official Indexer for the requested interval.",
            excludedFromConclusion: expect.arrayContaining(["fiat_usd_cash_out", "usd_peg_assumption"])
          },
          unsupportedClaims: expect.arrayContaining([
            "fiat_usd_cash_out",
            "usd_peg_assumption",
            "route_recommendation",
            "best_route",
            "transaction_building",
            "signing_readiness",
            "profit_or_pnl",
            "cost_basis",
            "independent_chain_recomputation"
          ])
        }
      });
      const priceHistoryPayload = textPayload(priceHistory) as {
        data: {
          bars: Array<{ start: string; open: string }>;
        };
      };
      expect(priceHistoryPayload.data.bars[0]).toMatchObject({
        start: "2026-06-26T19:45:00.000Z",
        open: "0.69846"
      });

      const priceAtTime = await client.callTool({
        name: TOOL_NAMES.readGetDeepbookUsdcPriceAtTime,
        arguments: {
          poolName: "SUI_USDC",
          targetTime: "2026-06-26T16:55:00.000Z"
        }
      });
      expect(textPayload(priceAtTime)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          target: {
            targetTime: "2026-06-26T16:55:00.000Z",
            searchWindow: { maxDistanceMinutes: 360 }
          },
          pair: { poolName: "SUI_USDC", priceConvention: "USDC_PER_BASE" },
          match: {
            kind: "exact_bucket",
            distanceMinutes: 0,
            representativePrice: {
              field: "matchedCandle.close",
              value: "0.69316",
              quoteAsset: "USDC",
              baseAssetSymbol: "SUI",
              priceConvention: "USDC_PER_BASE"
            }
          },
          matchedCandle: {
            start: "2026-06-26T16:50:00.000Z",
            end: "2026-06-26T17:05:00.000Z",
            close: "0.69316"
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["representative_close_price_for_the_matched_candle"]),
            cannotAnswer: expect.arrayContaining(["global_market_price", "profit_or_pnl", "signing_data_or_readiness"]),
            answerFields: expect.arrayContaining(["match.representativePrice", "matchedCandle.close", "responseSummary"])
          },
          quantitySemantics: {
            kind: "deepbook_official_indexer_candles",
            usdcIsFiatUsd: false,
            chainRecomputedBySuiMcp: false,
            liveQuoteAvailable: false,
            globalMarketPriceAvailable: false
          },
          responseSummary: {
            usdcDisclaimer: DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.usdcDisclaimer
          },
          unsupportedClaims: expect.arrayContaining(["fiat_usd_cash_out", "usd_peg_assumption"])
        }
      });

      const orderbook = await client.callTool({
        name: TOOL_NAMES.readInspectDeepbookOrderbook,
        arguments: { poolKey: "DEEP_SUI", ticks: 5 }
      });
      expect(JSON.parse((orderbook.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["deepbook_pool_orderbook_context_at_fetchedAt"]),
            cannotAnswer: expect.arrayContaining(["indicative_quote_for_a_source_amount"]),
            answerFields: expect.arrayContaining(["level2TicksFromMid"])
          },
          source: { methods: ["midPrice", "poolBookParams", "getLevel2TicksFromMid"] }
        }
      });
    } finally {
      await server.close();
    }
    }); } finally { walletFixture.close(); }
  });

  it("fails DeepBook token listing closed when pinned scalar metadata is invalid", async () => {
    const { client, server } = await connectTestClient({
      readService: createTestReadService({ deepbookCoins: deepbookCoinsWithInvalidSuiScalar() })
    });
    try {
      const result = await client.callTool({ name: TOOL_NAMES.readListDeepbookTokens });
      expect(textPayload(result)).toMatchObject({
        ok: false,
        error: {
          kind: "registry_miss",
          details: {
            symbol: "SUI",
            scalar: 12
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("maps DeepBook mid-price read failures through MCP", async () => {
    const unavailableClient = await connectTestClient({
      readService: createTestReadService({
        deepbook: {
          async midPrice() {
            return 0;
          }
        }
      })
    });
    try {
      const unavailable = await unavailableClient.client.callTool({
        name: TOOL_NAMES.readGetDeepbookMidPrice,
        arguments: { poolKey: "SUI_USDC" }
      });
      expect(textPayload(unavailable)).toMatchObject({
        ok: false,
        error: {
          kind: "quote_unavailable",
          details: { poolKey: "SUI_USDC", source: "midPrice" }
        }
      });

      const unknown = await unavailableClient.client.callTool({
        name: TOOL_NAMES.readGetDeepbookMidPrice,
        arguments: { poolKey: "UNKNOWN_POOL" }
      });
      expect(textPayload(unknown)).toMatchObject({
        ok: false,
        error: {
          kind: "registry_miss",
          details: { poolKey: "UNKNOWN_POOL" }
        }
      });
    } finally {
      await unavailableClient.server.close();
    }

    const internalErrorClient = await connectTestClient({
      readService: createTestReadService({
        deepbook: {
          async midPrice() {
            throw new Error("network down");
          }
        }
      })
    });
    try {
      const failed = await internalErrorClient.client.callTool({
        name: TOOL_NAMES.readGetDeepbookMidPrice,
        arguments: { poolKey: "SUI_USDC" }
      });
      expect(textPayload(failed)).toMatchObject({
        ok: false,
        error: {
          kind: "internal_error",
          details: { message: "Read service call failed" }
        }
      });
    } finally {
      await internalErrorClient.server.close();
    }
  });

  it("maps DeepBook display quote read failures through MCP without active account context", async () => {
    const { client, server } = await connectTestClient();
    try {
      const unknown = await client.callTool({
        name: TOOL_NAMES.readQuoteDeepbookDisplayAmount,
        arguments: { poolKey: "UNKNOWN_POOL", direction: "base_to_quote", amountDisplay: "10" }
      });
      expect(textPayload(unknown)).toMatchObject({
        ok: false,
        error: {
          kind: "registry_miss",
          details: { poolKey: "UNKNOWN_POOL" }
        }
      });

      const invalidAmount = await client.callTool({
        name: TOOL_NAMES.readQuoteDeepbookDisplayAmount,
        arguments: { poolKey: "SUI_USDC", direction: "base_to_quote", amountDisplay: "0" }
      });
      expect(textPayload(invalidAmount)).toMatchObject({
        ok: false,
        error: {
          kind: "input_invalid",
          details: { field: "amountDisplay" }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("exposes local review activity read tools through MCP", async () => {
    const { client, server, sessions, activityStore } = await connectTestClient();
    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          TOOL_NAMES.readListReviewActivity,
          TOOL_NAMES.readSummarizeReviewFunnel,
          TOOL_NAMES.readGetReviewSessionDetail
        ])
      );
      const reviewActivityToolNames = new Set<string>([
        TOOL_NAMES.readListReviewActivity,
        TOOL_NAMES.readSummarizeReviewFunnel,
        TOOL_NAMES.readGetReviewSessionDetail
      ]);
      for (const tool of tools.tools.filter((item) => reviewActivityToolNames.has(item.name))) {
        expect(tool.description).not.toMatch(/must|should|always/i);
      }

      const noActive = await client.callTool({ name: TOOL_NAMES.readListReviewActivity, arguments: {} });
      expect(textPayload(noActive)).toMatchObject({
        ok: false,
        error: { kind: "active_account_not_set" }
      });
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:03.000Z"));
      const { session: reviewSession } = await sessions.createReviewSession([reviewPlan], new Date("2026-05-11T00:01:00.000Z"));
      await sessions.recordWalletConnected(reviewSession.id, walletAccount, new Date("2026-05-11T00:01:02.000Z"));
      const reviewState: ReviewState = {
        reviewSessionId: reviewSession.id,
        planId: reviewPlan.id,
        account: walletAccount,
        status: "ready_for_wallet_review",
        checks: [],
        updatedAt: "2026-05-11T00:01:03.000Z"
      };
      await sessions.recordReviewState(reviewSession.id, reviewState, new Date("2026-05-11T00:01:03.000Z"));

      const list = await client.callTool({ name: TOOL_NAMES.readListReviewActivity, arguments: {} });
      expect(textPayload(list)).toMatchObject({
        ok: true,
        data: {
          dataScope: {
            account: walletAccount,
            recordCount: 1
          },
          accountSource: "active_account_context",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["local_review_session_rows_for_the_selected_account"]),
            cannotAnswer: expect.arrayContaining(["sui_wallet_transaction_history", "signing_data_or_readiness"]),
            answerFields: expect.arrayContaining(["activities[].reviewStatus"]),
            followUp: {
              tool: TOOL_NAMES.readGetReviewSessionDetail,
              inputFields: ["activities[].reviewSessionId"],
              answerFields: ["session", "planJson", "intentJson", "stateSnapshots", "transitions", "requests"]
            }
          },
          lowSampleWarning: true,
          lowSampleThreshold: 5,
          activities: [
            {
              reviewSessionId: reviewSession.id,
              reviewStatus: "ready_for_wallet_review",
              snapshotCount: 1
            }
          ]
        }
      });

      const summary = await client.callTool({
        name: TOOL_NAMES.readSummarizeReviewFunnel,
        arguments: { account: walletAccount.toUpperCase() }
      });
      expect(textPayload(summary)).toMatchObject({
        ok: true,
        data: {
          accountSource: "explicit_filter",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["local_review_lifecycle_counts_for_the_selected_account"]),
            answerFields: ["summary"]
          },
          dataScope: {
            account: walletAccount,
            recordCount: 1
          },
          summary: {
            total: 1,
            opened: 0,
            walletConnected: 1,
            stateComputed: 1
          }
        }
      });

      const detail = await client.callTool({
        name: TOOL_NAMES.readGetReviewSessionDetail,
        arguments: { reviewSessionId: reviewSession.id }
      });
      expect(textPayload(detail)).toMatchObject({
        ok: true,
        data: {
          dataScope: {
            account: walletAccount,
            recordCount: 1
          },
          lowSampleWarning: true,
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["stored_local_review_session_plan_and_lifecycle_detail"]),
            cannotAnswer: expect.arrayContaining([
              "chain_execution_result_without_execution_field",
              "transaction_execution_guarantee",
              "signing_data_or_readiness"
            ]),
            answerFields: expect.arrayContaining(["stateSnapshots", "transitions"]),
            followUp: {
              tool: TOOL_NAMES.sessionGetReviewStatus,
              inputFields: ["session.reviewSessionId"],
              answerFields: ["status", "pollingStatus", "reviewState"]
            }
          },
          session: {
            reviewSessionId: reviewSession.id,
            planId: reviewPlan.id
          },
          intentJson: {
            from: "SUI",
            to: "USDC",
            amount: "1"
          },
          truncated: {
            activities: false,
            snapshots: false,
            transitions: false
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("exposes user-requested Sui activity tools without claiming complete wallet history", async () => {
    const { client, server, activityStore } = await connectTestClient();
    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          TOOL_NAMES.readInspectSuiTransaction,
          TOOL_NAMES.readScanSuiAccountActivity,
          TOOL_NAMES.readSummarizeSuiActivityScan,
          TOOL_NAMES.readScanSuiFunctionActivity,
          TOOL_NAMES.readSummarizeSuiFunctionActivityScan,
          TOOL_NAMES.readSummarizeSuiAccountActivity,
          TOOL_NAMES.readGetAccountAssetTimeline
        ])
      );
      const activityToolNames = new Set<string>([
        TOOL_NAMES.readInspectSuiTransaction,
        TOOL_NAMES.readScanSuiAccountActivity,
        TOOL_NAMES.readSummarizeSuiActivityScan,
        TOOL_NAMES.readScanSuiFunctionActivity,
        TOOL_NAMES.readSummarizeSuiFunctionActivityScan,
        TOOL_NAMES.readSummarizeSuiAccountActivity,
        TOOL_NAMES.readGetAccountAssetTimeline
      ]);
      for (const tool of tools.tools.filter((item) => activityToolNames.has(item.name))) {
        expect(tool.description).not.toMatch(/must|should|always/i);
        expect(tool.description).not.toMatch(/signing|transaction building|route recommendation/i);
      }
      const storedSummaryTool = tools.tools.find((tool) => tool.name === TOOL_NAMES.readSummarizeSuiAccountActivity);
      expect(JSON.stringify(storedSummaryTool?.inputSchema)).not.toMatch(/kind|function|functionScan/);
      expect(tools.tools.find((tool) => tool.name === TOOL_NAMES.readScanSuiAccountActivity)?.description)
        .toMatch(/requested-account facts/);
      expect(tools.tools.find((tool) => tool.name === TOOL_NAMES.readSummarizeSuiActivityScan)?.description)
        .toMatch(/requested-account facts/);

      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      const digestLookup = await client.callTool({
        name: TOOL_NAMES.readInspectSuiTransaction,
        arguments: { digest: "5".repeat(44) }
      });
      expect(textPayload(digestLookup)).toMatchObject({
        ok: true,
        data: {
          source: {
            transport: "graphql",
            method: "Query.transaction"
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["one_sui_transaction_digest_status_and_context"]),
            cannotAnswer: expect.arrayContaining(["complete_wallet_history", "profit_or_pnl"]),
            answerFields: expect.arrayContaining(["transaction.requestedAccountEffect", "transaction.details"])
          },
          quantitySemantics: {
            kind: "sui_activity_raw_amounts",
            displayConversionRequires: "verified_coin_metadata_decimals",
            notFor: expect.arrayContaining(["display_conversion_without_verified_decimals", "profit_or_pnl"])
          },
          transaction: {
            digest: "5".repeat(44),
            sender: walletAccount,
            requestedAccountEffect: {
              account: walletAccount,
              scope: "requested_account",
              role: "sender",
              sentByAccount: true,
              balanceChangeEvidence: "account_balance_changes_returned",
              accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
              balanceChangeCompleteness: "complete",
              balanceChanges: [
                {
                  index: 0,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "-1000",
                  direction: "decrease"
                }
              ],
              coinFlows: [{ coinType: "0x2::sui::SUI", increaseRaw: "0", decreaseRaw: "1000", netRaw: "-1000" }],
              limitations: []
            },
            compact: {
              factScope: "transaction",
              requestedAccountScoped: false,
              moveCallTargets: [`${cetusPackage}::pool::swap`],
              balanceChanges: [{ coinType: "0x2::sui::SUI", amountRaw: "-1000", direction: "decrease" }],
              objectChangeCounts: { created: 0, mutated: 0, deleted: 0 },
              eventTypes: [],
              gasNetCostRaw: "115",
              detailTruncated: false,
              protocolMatches: [
                expect.objectContaining({
                  protocolId: "cetus-clmm",
                  primaryAction: "swap",
                  matchBasis: "direct_move_call"
                })
              ]
            },
            details: {
              moveCalls: [{ target: `${cetusPackage}::pool::swap` }],
              balanceChanges: [{ owner: walletAccount, amountRaw: "-1000" }],
              gas: { netGasCostRaw: "115" }
            }
          },
          persistence: {
            stored: true,
            account: walletAccount,
            relationship: "sent"
          }
        }
      });

      const scan = await client.callTool({
        name: TOOL_NAMES.readScanSuiAccountActivity,
        arguments: { relationship: "affected" }
      });
      const scanText = (scan.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(scanText.indexOf('"requestedAccountTransactionFacts"')).toBeGreaterThan(-1);
      expect(scanText.indexOf('"requestedAccountTransactionFacts"')).toBeLessThan(
        scanText.indexOf('"transactions"')
      );
      const scanTransactionsIndex = scanText.indexOf('"transactions"');
      const scanRowRequestedAccountEffectIndex = scanText.indexOf(
        '"requestedAccountEffect"',
        scanTransactionsIndex
      );
      expect(scanRowRequestedAccountEffectIndex).toBeGreaterThan(scanTransactionsIndex);
      expect(scanText).not.toContain('"details"');
      expect(scanText).not.toContain('"compact"');
      expect(textPayload(scan)).toMatchObject({
        ok: true,
        data: {
          account: walletAccount,
          accountKnown: true,
          relationship: "affected",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["bounded_requested_account_activity_page"]),
            cannotAnswer: expect.arrayContaining(["complete_wallet_history", "profit_or_pnl"]),
            answerFields: expect.arrayContaining(["requestedAccountTransactionFacts"]),
            followUp: {
              tool: TOOL_NAMES.readInspectSuiTransaction,
              inputFields: ["transactions[].detailLookup.digest"],
              answerFields: ["transaction"]
            }
          },
          requestedAccount: {
            account: walletAccount,
            relationship: "affected",
            sentCount: 1,
            affectedOnlyCount: 0,
            balanceChangeCompleteness: "complete",
            coinFlows: [
              {
                coinType: "0x2::sui::SUI",
                increaseRaw: "0",
                decreaseRaw: "1000",
                netRaw: "-1000",
                transactionCount: 1
              }
            ]
          },
          quantitySemantics: {
            kind: "sui_activity_raw_amounts",
            displayConversionRequires: "verified_coin_metadata_decimals",
            notFor: expect.arrayContaining(["display_conversion_without_verified_decimals", "profit_or_pnl"])
          },
          requestedAccountTransactionFacts: [
            {
              digest: "5".repeat(44),
              requestedAccount: walletAccount,
              accountScope: "requested_account",
              accountRole: "sender",
              sentByAccount: true,
              accountBalanceChangeEvidence: "account_balance_changes_returned",
              accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
              accountBalanceChangeCompleteness: "complete",
              accountBalanceChanges: [
                {
                  index: 0,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "-1000",
                  direction: "decrease"
                }
              ],
              accountCoinFlows: [
                {
                  coinType: "0x2::sui::SUI",
                  increaseRaw: "0",
                  decreaseRaw: "1000",
                  netRaw: "-1000"
                }
              ],
              accountEffectLimitations: [],
              requestedAccountEffect: {
                account: walletAccount,
                scope: "requested_account",
                role: "sender",
                sentByAccount: true,
                balanceChangeEvidence: "account_balance_changes_returned",
                accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
                balanceChangeCompleteness: "complete",
                balanceChanges: [
                  {
                    index: 0,
                    coinType: "0x2::sui::SUI",
                    amountRaw: "-1000",
                    direction: "decrease"
                  }
                ],
                coinFlows: [{ coinType: "0x2::sui::SUI", increaseRaw: "0", decreaseRaw: "1000", netRaw: "-1000" }],
                limitations: []
              },
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                requestedAccountScoped: false,
                moveCallTargets: [`${cetusPackage}::pool::swap`],
                objectChangeCounts: { created: 0, mutated: 0, deleted: 0 },
                gasNetCostRaw: "115",
                detailTruncated: false
              }),
              detailLookup: {
                tool: TOOL_NAMES.readInspectSuiTransaction,
                digest: "5".repeat(44)
              }
            }
          ],
          windowComplete: null,
          transactions: [
            expect.objectContaining({
              digest: "5".repeat(44),
              requestedAccountEffect: {
                account: walletAccount,
                scope: "requested_account",
                role: "sender",
                sentByAccount: true,
                balanceChangeEvidence: "account_balance_changes_returned",
                accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
                balanceChangeCompleteness: "complete",
                balanceChanges: [
                  {
                    index: 0,
                    coinType: "0x2::sui::SUI",
                    amountRaw: "-1000",
                    direction: "decrease"
                  }
                ],
                coinFlows: [{ coinType: "0x2::sui::SUI", increaseRaw: "0", decreaseRaw: "1000", netRaw: "-1000" }],
                limitations: []
              },
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                requestedAccountScoped: false,
                moveCallTargets: [`${cetusPackage}::pool::swap`],
                protocolMatches: [
                  expect.objectContaining({
                    protocolId: "cetus-clmm",
                    primaryAction: "swap",
                    matchBasis: "direct_move_call"
                  })
                ]
              })
            })
          ],
          persistence: {
            stored: true,
            scan: {
              account: walletAccount,
              relationship: "affected",
              storedCount: 1
            }
          }
        }
      });
      const scanPayload = textPayload(scan) as { data: { transactions: Array<Record<string, unknown>> } };
      expect(scanPayload.data.transactions[0]).not.toHaveProperty("details");
      expect(scanPayload.data.transactions[0]).not.toHaveProperty("compact");
      expect(scanPayload.data.transactions[0]?.transactionContext).not.toHaveProperty("balanceChanges");

      const scanSummary = await client.callTool({
        name: TOOL_NAMES.readSummarizeSuiActivityScan,
        arguments: { relationship: "affected" }
      });
      const scanSummaryText = (scanSummary.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(scanSummaryText.indexOf('"requestedAccountTransactionFacts"')).toBeGreaterThan(-1);
      expect(scanSummaryText.indexOf('"requestedAccountTransactionFacts"')).toBeLessThan(
        scanSummaryText.indexOf('"transactions"')
      );
      const scanSummaryPayload = textPayload(scanSummary) as { data: { transactions: Array<Record<string, unknown>> } };
      expect(scanSummaryPayload).toMatchObject({
        ok: true,
        data: {
          account: walletAccount,
          accountKnown: true,
          relationship: "affected",
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["deterministic_summary_over_returned_normalized_rows"]),
            answerFields: expect.arrayContaining(["analysis", "requestedAccountTransactionFacts"])
          },
          requestedAccount: {
            account: walletAccount,
            relationship: "affected",
            sentCount: 1,
            affectedOnlyCount: 0,
            balanceChangeCompleteness: "complete",
            coinFlows: [
              {
                coinType: "0x2::sui::SUI",
                increaseRaw: "0",
                decreaseRaw: "1000",
                netRaw: "-1000",
                transactionCount: 1
              }
            ]
          },
          requestedAccountTransactionFacts: [
            expect.objectContaining({
              digest: "5".repeat(44),
              accountBalanceChangeEvidence: "account_balance_changes_returned",
              accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
              accountBalanceChangeCompleteness: "complete",
              accountBalanceChanges: [
                {
                  index: 0,
                  coinType: "0x2::sui::SUI",
                  amountRaw: "-1000",
                  direction: "decrease"
                }
              ],
              accountCoinFlows: [
                { coinType: "0x2::sui::SUI", increaseRaw: "0", decreaseRaw: "1000", netRaw: "-1000" }
              ],
              requestedAccountEffect: expect.objectContaining({
                scope: "requested_account",
                role: "sender",
                balanceChangeEvidence: "account_balance_changes_returned",
                accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
                coinFlows: [{ coinType: "0x2::sui::SUI", increaseRaw: "0", decreaseRaw: "1000", netRaw: "-1000" }]
              }),
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                requestedAccountScoped: false,
                moveCallTargets: [`${cetusPackage}::pool::swap`],
                detailTruncated: false
              }),
              detailLookup: {
                tool: TOOL_NAMES.readInspectSuiTransaction,
                digest: "5".repeat(44)
              }
            })
          ],
          analysis: {
            overview: {
              transactionCount: 1,
              analyzedTransactionCount: 1,
              statusCounts: { success: 1, failure: 0, unknown: 0 },
              relationshipCounts: { affected: 1, sent: 0 }
            },
            moveCallTargets: [{ target: `${cetusPackage}::pool::swap`, count: 1 }],
            protocols: [{ protocolId: "cetus-clmm", displayName: "Cetus CLMM", count: 1 }],
            coinFlows: [
              {
                coinType: "0x2::sui::SUI",
                increaseRaw: "0",
                decreaseRaw: "1000",
                netRaw: "-1000",
                transactionCount: 1
              }
            ],
            gas: {
              transactionCount: 1,
              netGasCostRaw: "115",
              netGasCost: expect.objectContaining({
                netCostRaw: "115",
                display: "0.000000115",
                displayUnit: "SUI"
              })
            },
            limitations: expect.arrayContaining(["window_latest_only"])
          },
          transactions: [
            expect.objectContaining({
              digest: "5".repeat(44),
              requestedAccountEffect: {
                account: walletAccount,
                scope: "requested_account",
                role: "sender",
                sentByAccount: true,
                balanceChangeEvidence: "account_balance_changes_returned",
                accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
                balanceChangeCompleteness: "complete",
                balanceChanges: [
                  {
                    index: 0,
                    coinType: "0x2::sui::SUI",
                    amountRaw: "-1000",
                    direction: "decrease"
                  }
                ],
                coinFlows: [{ coinType: "0x2::sui::SUI", increaseRaw: "0", decreaseRaw: "1000", netRaw: "-1000" }],
                limitations: []
              },
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                requestedAccountScoped: false,
                protocolMatches: [
                  expect.objectContaining({
                    protocolId: "cetus-clmm"
                  })
                ]
              }),
              detailLookup: {
                tool: TOOL_NAMES.readInspectSuiTransaction,
                digest: "5".repeat(44)
              }
            })
          ],
          persistence: {
            stored: true
          }
        }
      });
      expect(scanSummaryPayload.data.transactions[0]).not.toHaveProperty("details");
      expect(scanSummaryPayload.data.transactions[0]).not.toHaveProperty("compact");
      expect(scanSummaryPayload.data.transactions[0]?.transactionContext).not.toHaveProperty("balanceChanges");

      const functionScan = await client.callTool({
        name: TOOL_NAMES.readScanSuiFunctionActivity,
        arguments: { function: `${cetusPackage}::pool::swap` }
      });
      expect(textPayload(functionScan)).toMatchObject({
        ok: true,
        data: {
          account: walletAccount,
          accountKnown: true,
          function: `${cetusPackage}::pool::swap`,
          relationship: "sent",
          requestedAccount: {
            account: walletAccount,
            relationship: "sent",
            sentCount: 1,
            affectedOnlyCount: 0,
            balanceChangeCompleteness: "complete",
            coinFlows: [
              {
                coinType: "0x2::sui::SUI",
                increaseRaw: "0",
                decreaseRaw: "1000",
                netRaw: "-1000",
                transactionCount: 1
              }
            ]
          },
          requestedAccountTransactionFacts: [
            expect.objectContaining({
              digest: "5".repeat(44),
              accountBalanceChangeEvidence: "account_balance_changes_returned",
              accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
              requestedAccountEffect: expect.objectContaining({
                scope: "requested_account",
                role: "sender",
                sentByAccount: true,
                balanceChangeEvidence: "account_balance_changes_returned",
                accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes"
              }),
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                moveCallTargets: [`${cetusPackage}::pool::swap`]
              })
            })
          ],
          transactions: [
            expect.objectContaining({
              digest: "5".repeat(44),
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                moveCallTargets: [`${cetusPackage}::pool::swap`],
                protocolMatches: [
                  expect.objectContaining({
                    protocolId: "cetus-clmm",
                    primaryAction: "swap"
                  })
                ]
              })
            })
          ],
          persistence: {
            stored: true,
            scan: {
              account: walletAccount,
              kind: "function_scan",
              relationship: "sent",
              storedCount: 1
            }
          }
        }
      });
      const functionScanPayload = textPayload(functionScan) as { data: { transactions: Array<Record<string, unknown>> } };
      expect(functionScanPayload.data.transactions[0]).not.toHaveProperty("details");
      expect(functionScanPayload.data.transactions[0]).not.toHaveProperty("compact");
      expect(functionScanPayload.data.transactions[0]?.transactionContext).not.toHaveProperty("balanceChanges");

      const functionSummary = await client.callTool({
        name: TOOL_NAMES.readSummarizeSuiFunctionActivityScan,
        arguments: { function: `${cetusPackage}::pool::swap` }
      });
      const functionSummaryPayload = textPayload(functionSummary) as { data: { transactions: Array<Record<string, unknown>> } };
      expect(functionSummaryPayload).toMatchObject({
        ok: true,
        data: {
          account: walletAccount,
          accountKnown: true,
          function: `${cetusPackage}::pool::swap`,
          relationship: "sent",
          requestedAccount: {
            account: walletAccount,
            relationship: "sent",
            sentCount: 1,
            affectedOnlyCount: 0,
            balanceChangeCompleteness: "complete",
            coinFlows: [
              {
                coinType: "0x2::sui::SUI",
                increaseRaw: "0",
                decreaseRaw: "1000",
                netRaw: "-1000",
                transactionCount: 1
              }
            ]
          },
          requestedAccountTransactionFacts: [
            expect.objectContaining({
              digest: "5".repeat(44),
              accountBalanceChangeEvidence: "account_balance_changes_returned",
              accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
              requestedAccountEffect: expect.objectContaining({
                scope: "requested_account",
                role: "sender",
                sentByAccount: true,
                balanceChangeEvidence: "account_balance_changes_returned",
                accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes"
              }),
              transactionContext: expect.objectContaining({
                factScope: "transaction",
                moveCallTargets: [`${cetusPackage}::pool::swap`]
              })
            })
          ],
          analysis: {
            overview: {
              transactionCount: 1,
              relationshipCounts: { affected: 0, sent: 1 }
            },
            moveCallTargets: [{ target: `${cetusPackage}::pool::swap`, count: 1 }]
          },
          transactions: [
            expect.objectContaining({
              digest: "5".repeat(44),
              detailLookup: {
                tool: TOOL_NAMES.readInspectSuiTransaction,
                digest: "5".repeat(44)
              }
            })
          ],
          persistence: {
            stored: true
          }
        }
      });
      expect(functionSummaryPayload.data.transactions[0]).not.toHaveProperty("details");
      expect(functionSummaryPayload.data.transactions[0]).not.toHaveProperty("compact");
      expect(functionSummaryPayload.data.transactions[0]?.transactionContext).not.toHaveProperty("balanceChanges");

      const summary = await client.callTool({
        name: TOOL_NAMES.readSummarizeSuiAccountActivity,
        arguments: { account: walletAccount }
      });
      expect(textPayload(summary)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          source: {
            transport: "local_db",
            method: "stored_normalized_facts"
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["stored_local_normalized_activity_summary_for_the_selected_account"]),
            cannotAnswer: expect.arrayContaining(["live_latest_activity", "profit_or_pnl"]),
            answerFields: expect.arrayContaining(["summary", "analysis", "transactions"]),
            followUp: {
              tool: TOOL_NAMES.readSummarizeSuiActivityScan,
              inputFields: ["dataScope.account"],
              answerFields: ["requestedAccountTransactionFacts", "analysis"]
            }
          },
          dataScope: {
            account: walletAccount
          },
          summary: {
            transactionCount: 2
          },
          analysis: {
            overview: {
              transactionCount: 2,
              analyzedTransactionCount: 2
            },
            protocols: [
              expect.objectContaining({
                protocolId: "cetus-clmm",
                count: 2
              })
            ]
          },
          transactions: expect.arrayContaining([
            expect.objectContaining({
              digest: "5".repeat(44),
              compact: expect.objectContaining({
                factScope: "transaction",
                moveCallTargets: [`${cetusPackage}::pool::swap`],
                balanceChanges: [{ coinType: "0x2::sui::SUI", amountRaw: "-1000", direction: "decrease" }],
                gasNetCostRaw: "115",
                detailTruncated: false,
                protocolMatches: [
                  expect.objectContaining({
                    protocolId: "cetus-clmm",
                    primaryAction: "swap",
                    matchBasis: "direct_move_call"
                  })
                ]
              }),
              details: expect.objectContaining({
                moveCalls: [expect.objectContaining({ target: `${cetusPackage}::pool::swap` })],
                balanceChanges: [expect.objectContaining({ owner: walletAccount, amountRaw: "-1000" })],
                gas: { netGasCostRaw: "115" }
              }),
              detailLookup: {
                tool: TOOL_NAMES.readInspectSuiTransaction,
                digest: "5".repeat(44)
              }
            })
          ])
        }
      });
    } finally {
      await server.close();
    }
  });

  it("returns stored account asset timeline evidence without claiming balances or complete wallet history", async () => {
    const { client, server, activityStore } = await connectTestClient();
    try {
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-06-26T19:40:00.000Z"));

      const scanNeeded = await client.callTool({
        name: TOOL_NAMES.readGetAccountAssetTimeline,
        arguments: {
          account: walletAccount,
          start: "2026-06-26T19:40:00.000Z",
          end: "2026-06-26T20:10:00.000Z"
        }
      });
      expect(textPayload(scanNeeded)).toMatchObject({
        ok: true,
        data: {
          status: "scan_needed",
          balanceStatus: "unavailable_no_balance_anchor",
          netFlowBars: [],
          scanNeeded: {
            tool: TOOL_NAMES.readScanSuiAccountActivity,
            relationship: "affected"
          },
          userAnswerUse: {
            canAnswer: expect.not.arrayContaining([
              "stored_account_asset_net_flow_timeline_for_selected_account",
              "deepbook_usdc_token_denominated_reference_candles_for_supported_assets"
            ]),
            answerFields: expect.not.arrayContaining(["netFlowBars", "usdcReferences"]),
            cannotAnswer: expect.arrayContaining([
              "complete_wallet_history",
              "held_balances_without_balanceBars",
              "profit_or_pnl",
              "signing_data_or_readiness"
            ])
          }
        }
      });

      const unknownAccount = await client.callTool({
        name: TOOL_NAMES.readGetAccountAssetTimeline,
        arguments: {
          account: `0x${"c".repeat(64)}`,
          start: "2026-06-26T19:40:00.000Z",
          end: "2026-06-26T20:10:00.000Z"
        }
      });
      const unknownAccountPayload = textPayload(unknownAccount) as {
        data: { scanNeeded?: unknown };
      };
      expect(unknownAccountPayload).toMatchObject({
        ok: true,
        data: {
          status: "account_not_known",
          coverage: {
            accountKnown: false,
            coverageStatus: "no_stored_scans"
          },
          netFlowBars: [],
          limitations: expect.arrayContaining(["account_not_known"]),
          userAnswerUse: {
            canAnswer: expect.not.arrayContaining([
              "stored_account_asset_net_flow_timeline_for_selected_account",
              "deepbook_usdc_token_denominated_reference_candles_for_supported_assets"
            ]),
            answerFields: expect.not.arrayContaining(["netFlowBars", "usdcReferences"])
          }
        }
      });
      expect(unknownAccountPayload.data.scanNeeded).toBeUndefined();

      await activityStore.recordExternalActivityScan({
        scanId: "timeline_scan",
        kind: "account_scan",
        account: walletAccount,
        relationship: "affected",
        fromTimestamp: "2026-06-26T19:40:00.000Z",
        toTimestamp: "2026-06-26T20:10:00.000Z",
        limit: 100,
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "mainnet-chain",
        fetchedAt: "2026-06-26T20:10:01.000Z",
        hasMore: false,
        windowComplete: true,
        transactions: [
          {
            digest: "7".repeat(44),
            relationship: "affected",
            checkpoint: "1000",
            timestamp: "2026-06-26T19:45:00.000Z",
            status: "success",
            details: transactionDetails
          }
        ]
      });

      const timeline = await client.callTool({
        name: TOOL_NAMES.readGetAccountAssetTimeline,
        arguments: {
          account: walletAccount,
          start: "2026-06-26T19:40:00.000Z",
          end: "2026-06-26T20:10:00.000Z"
        }
      });

      expect(textPayload(timeline)).toMatchObject({
        ok: true,
        data: {
          status: "ok",
          source: {
            transport: "local_db",
            method: "stored_normalized_facts"
          },
          coverage: {
            coverageStatus: "complete",
            coverageEvidence: {
              completeAffectedAccountScanIds: ["timeline_scan"]
            }
          },
          sourceTransactions: {
            storedTransactionCount: 1,
            returnedTransactionCount: 1,
            truncated: false,
            detailAvailability: {
              detailAvailability: "all"
            }
          },
          balanceStatus: "unavailable_no_balance_anchor",
          balanceBars: [],
          netFlowBars: [
            {
              bucketStart: "2026-06-26T19:45:00.000Z",
              bucketEnd: "2026-06-26T20:00:00.000Z",
              coinType: "0x2::sui::SUI",
              increaseRaw: "0",
              decreaseRaw: "1000",
              netRaw: "-1000",
              transactionCount: 1
            }
          ],
          quantitySemantics: {
            kind: "sui_account_asset_timeline_raw_net_flows",
            balanceBarsAvailable: false,
            notFor: expect.arrayContaining([
              "held_balance_without_balance_anchor",
              "complete_wallet_history",
              "fiat_usd_cash_out",
              "usd_peg_assumption",
              "profit_or_pnl",
              "cost_basis",
              "signing_data_or_readiness"
            ])
          },
          usdcReferences: {
            status: "available",
            quoteAsset: "USDC",
            usdcIsFiatUsd: false,
            usdPegGuaranteeAvailable: false,
            chainRecomputedBySuiMcp: false,
            coinReferences: [
              expect.objectContaining({
                coinType: "0x2::sui::SUI",
                status: "available",
                barReferences: [
                  expect.objectContaining({
                    bucketStart: "2026-06-26T19:45:00.000Z",
                    bucketEnd: "2026-06-26T20:00:00.000Z",
                    status: "available"
                  })
                ]
              })
            ],
            responseSummary: {
              usdcDisclaimer: DEEPBOOK_OFFICIAL_INDEXER_RESPONSE_TEXT.usdcDisclaimer
            }
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining([
              "stored_account_asset_net_flow_timeline_for_selected_account",
              "deepbook_usdc_token_denominated_reference_candles_for_supported_assets"
            ]),
            cannotAnswer: expect.arrayContaining([
              "complete_wallet_history",
              "held_balances_without_balanceBars",
              "fiat_usd_cash_out",
              "usd_peg_assumption",
              "profit_or_pnl",
              "cost_basis",
              "signing_data_or_readiness"
            ])
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("does not list stored transaction details as an all-row answer field for mixed stored rows", async () => {
    const mixedDetailsSource: SuiTransactionActivitySource = {
      ...createTestTransactionActivitySource(),
      async scanAccount() {
        return {
          transactions: [
            {
              digest: "6".repeat(44),
              sender: walletAccount,
              checkpoint: "124",
              timestamp: "2026-05-10T00:01:00.000Z",
              status: "success",
              details: transactionDetails
            },
            {
              digest: "5".repeat(44),
              sender: walletAccount,
              checkpoint: "123",
              timestamp: "2026-05-10T00:00:00.000Z",
              status: "success"
            }
          ],
          hasMore: false
        };
      }
    };
    const { client, server, activityStore } = await connectTestClient({
      transactionActivitySource: mixedDetailsSource
    });
    try {
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
      await client.callTool({
        name: TOOL_NAMES.readScanSuiAccountActivity,
        arguments: { relationship: "sent" }
      });

      const summary = textPayload(
        await client.callTool({
          name: TOOL_NAMES.readSummarizeSuiAccountActivity,
          arguments: { account: walletAccount }
        })
      ) as {
        data: {
          userAnswerUse: { answerFields: string[]; canAnswer: string[]; cannotAnswer: string[] };
          transactions: Array<Record<string, unknown>>;
        };
      };

      expect(summary).toMatchObject({
        ok: true,
        data: {
          transactionDetailAvailability: {
            totalTransactions: 2,
            withDetails: 1,
            withoutDetails: 1,
            detailAvailability: "some",
            allReturnedTransactionsHaveDetails: false
          },
          userAnswerUse: {
            answerFields: expect.arrayContaining(["summary", "analysis", "transactions", "transactionDetailAvailability"]),
            canAnswer: expect.arrayContaining(["stored_transaction_context_for_some_returned_rows"]),
            cannotAnswer: expect.arrayContaining(["stored_transaction_context_for_all_returned_rows_without_all_details"])
          },
          summary: {
            transactionCount: 2
          }
        }
      });
      expect(summary.data.userAnswerUse.answerFields).not.toEqual(
        expect.arrayContaining(["transactions[].compact", "transactions[].details"])
      );
      expect(summary.data.transactions.some((transaction) => "details" in transaction)).toBe(true);
      expect(summary.data.transactions.some((transaction) => !("details" in transaction))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("refuses swap review creation when its wallet service dependency is absent", async () => {
    const { client, server } = await connectTestClient();
    try {
      const result = await client.callTool({
        name: TOOL_NAMES.actionStartReview,
        arguments: {
          intent: {
            type: "swap",
            from: { symbol: "SUI", amount: "1" },
            to: { symbol: "USDC" },
            maxSlippageBps: 50,
            protocol: "deep"
          }
        }
      });
      // A swap review is account-bound; with no connected account the tool must
      // refuse instead of creating a hollow proposal that can never compute.
      expect(textPayload(result)).toMatchObject({
        ok: false,
        error: { kind: "wallet_unavailable", details: { action: "check_exact_wallet_account", reason: "wallet_unavailable" } }
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("reports blocked execution waits as user action required through MCP", async () => {
    const { client, server, sessions, activityStore } = await connectTestClient({ sessionTtlMs: durableFixtureSessionTtlMs });
    try {
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:03.000Z"));
      const { session: reviewSession } = await sessions.createReviewSession([reviewPlan], new Date("2026-05-11T00:01:00.000Z"));
      await sessions.recordWalletConnected(reviewSession.id, walletAccount, new Date("2026-05-11T00:01:02.000Z"));
      await sessions.recordReviewState(
        reviewSession.id,
        {
          reviewSessionId: reviewSession.id,
          planId: reviewPlan.id,
          account: walletAccount,
          status: "blocked",
          blockedReason: "producer_stage_missing",
          adapterLifecycle: {
            stageCatalogId: "deepbook_swap_review_v1",
            adapterId: "deepbook-swap",
            protocol: "DeepBookV3",
            actionKind: "swap",
            completedStages: [
              "intent_normalized",
              "pool_resolved",
              "quote_evidence_fetched",
              "quote_policy_derived"
            ],
            missingStages: [
              "transaction_material_build_or_verify",
              "digest_commitment",
              "object_ownership",
              "human_readable_review",
              "review_time_simulation"
            ]
          },
          checks: [],
          updatedAt: "2026-05-11T00:01:03.000Z"
        },
        new Date("2026-05-11T00:01:03.000Z")
      );

      const waited = await client.callTool({
        name: TOOL_NAMES.sessionWaitExecutionResult,
        arguments: { reviewSessionId: reviewSession.id, timeoutMs: 1 }
      });
      expect(textPayload(waited)).toMatchObject({
        ok: true,
        data: {
          waitOutcome: "status_reached",
          reviewSessionId: reviewSession.id,
          status: "blocked",
          statusCategory: "user_action_required"
        }
      });
    } finally {
      await server.close();
    }
  });

  it("exposes active account tools through MCP", async () => {
    const { client, server, activityStore } = await connectTestClient();
    try {
      const empty = await client.callTool({ name: TOOL_NAMES.accountGetActiveAccount });
      expect(JSON.parse((empty.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({
        ok: true,
        data: { status: "none" }
      });
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:03.000Z"));

      const active = await client.callTool({ name: TOOL_NAMES.accountGetActiveAccount });
      expect(JSON.parse((active.content as Array<{ text?: string }>)[0]?.text ?? "")).toMatchObject({
        ok: true,
        data: {
          status: "set",
          account: walletAccount,
          source: "wallet_connection",
          setAt: "2026-05-11T00:00:03.000Z",
          boundary: "read_context_only_not_signing_authorization"
        }
      });

      await expect(client.callTool({ name: "account.clear_active_account" })).rejects.toMatchObject({
        code: -32602, message: "Tool account.clear_active_account not found"
      });
      expect(await activityStore.getActiveAccount()).toMatchObject({ address: walletAccount });

    } finally {
      await server.close();
    }
  });

  it("logs unexpected read service failures without leaking provider details to tool output", async () => {
    const logger = { error: vi.fn() };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const activityStore = new InMemoryActivityStore();
    const sessions = new InMemorySessionStore({
      activityStore,
      logger,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    const server = createMcpServer({
      sessions,
      activityStore,
      localSettings: new InMemoryLocalSettingsService(),
      logger,
      readService: new SuiReadService({
        network: "mainnet",
        chainIdentifier: "4c78adac",
        coinMetadataCache: new MemoryCoinMetadataCache(),
        deepbookFactory: () => {
          throw new Error("not used");
        },
        client: {
          core: {
            async listBalances() {
              throw new Error("provider quota exceeded");
            },
            async getCoinMetadata() {
              return { coinMetadata: null };
            }
          }
        }
      }),
      transactionActivityService: new TransactionActivityService({
        activityStore,
        source: createTestTransactionActivitySource()
      })
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:03.000Z"));
      const result = await client.callTool({
        name: TOOL_NAMES.readSummarizeWalletAssets,
        arguments: { account: walletAccount }
      });
      const payload = JSON.parse((result.content as Array<{ text?: string }>)[0]?.text ?? "");
      expect(payload).toMatchObject({
        ok: false,
        error: { kind: "internal_error", details: { message: "Read service call failed" } }
      });
      expect(logger.error).toHaveBeenCalledWith("read service call failed", {
        error: "provider quota exceeded"
      });
    } finally {
      await Promise.allSettled([server.close(), client.close()]);
    }
  });

  it("maps coin metadata cache failures to a typed MCP error without leaking the raw cause", async () => {
    const readService = new SuiReadService({
      network: "mainnet",
      chainIdentifier: "4c78adac",
      coinMetadataCache: {
        async getCoinMetadata() {
          return { status: "miss" };
        },
        async setCoinMetadata() {
          throw new Error("cache write failed");
        }
      },
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      deepbookFactory: () => {
        throw new Error("not used");
      },
      client: {
        core: {
          async listBalances() {
            return {
              balances: [{ coinType: "0x2::sui::SUI", balance: "100", coinBalance: "100", addressBalance: "100" }],
              hasNextPage: false,
              cursor: null
            };
          },
          async getCoinMetadata() {
            return {
              coinMetadata: {
                id: null,
                decimals: 9,
                name: "Sui",
                symbol: "SUI",
                description: "",
                iconUrl: null
              }
            };
          }
        }
      }
    });
    const { client, server, activityStore } = await connectTestClient({ readService });

    try {
      await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:03.000Z"));
      const result = await client.callTool({
        name: TOOL_NAMES.readSummarizeWalletAssets,
        arguments: { account: walletAccount }
      });
      expect(textPayload(result)).toMatchObject({
        ok: false,
        error: {
          kind: "metadata_cache_unavailable",
          details: { resource: "coin_metadata_cache", operation: "write" }
        }
      });
      expect(JSON.stringify(textPayload(result))).not.toContain("cache write failed");
    } finally {
      await Promise.allSettled([server.close(), client.close()]);
    }
  });

  it("maps activity store failures to MCP error payloads instead of handler rejections", async () => {
    const logger = { error: vi.fn() };
    const activityStore = new InMemoryActivityStore();
    const getActiveAccount = vi
      .spyOn(activityStore, "getActiveAccount")
      .mockRejectedValue(new Error("local database unavailable"));
    const serverWithLogger = createMcpServer({
      sessions: new InMemorySessionStore({
        activityStore,
        logger,
        validateAdapterLifecycle: validateSupportedAdapterLifecycle
      }),
      activityStore,
      localSettings: new InMemoryLocalSettingsService(),
      logger,
      readService: createTestReadService(),
      transactionActivityService: new TransactionActivityService({
        activityStore,
        source: createTestTransactionActivitySource()
      })
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const replacementClient = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
    try {
      await Promise.all([serverWithLogger.connect(serverTransport), replacementClient.connect(clientTransport)]);

      const getResult = await replacementClient.callTool({
        name: TOOL_NAMES.accountGetActiveAccount,
        arguments: {}
      });
      expect(textPayload(getResult)).toMatchObject({
        ok: false,
        error: { kind: "internal_error", details: { message: "Activity store call failed" } }
      });

      const walletAssetsResult = await replacementClient.callTool({
        name: TOOL_NAMES.readSummarizeWalletAssets,
        arguments: {}
      });
      expect(textPayload(walletAssetsResult)).toMatchObject({
        ok: false,
        error: { kind: "internal_error", details: { message: "Activity store call failed" } }
      });

      const interactionStatusResult = await replacementClient.callTool({
        name: TOOL_NAMES.sessionGetInteractionStatus,
        arguments: {}
      });
      expect(textPayload(interactionStatusResult)).toMatchObject({
        ok: false,
        error: { kind: "internal_error", details: { message: "Activity store call failed" } }
      });

      await expect(replacementClient.callTool({ name: "account.clear_active_account", arguments: {} })).rejects.toMatchObject({
        code: -32602, message: "Tool account.clear_active_account not found"
      });
      expect(logger.error).toHaveBeenCalledWith("activity store call failed", {
        error: "local database unavailable"
      });
    } finally {
      getActiveAccount.mockRestore();
      await Promise.allSettled([serverWithLogger.close(), replacementClient.close()]);
    }
  });

  it("maps session store failures to MCP error payloads instead of handler rejections", async () => {
    const logger = { error: vi.fn() };
    const activityStore = new InMemoryActivityStore();
    // Account-bound prepare needs an active account to reach the (mocked)
    // session store call this test exercises.
    await seedCurrentReadAccount(activityStore, walletAccount, new Date("2026-05-11T00:00:00.000Z"));
    const sessions = new InMemorySessionStore({
      activityStore,
      logger,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });


    const getReview = vi
      .spyOn(sessions, "getReviewSession")
      .mockRejectedValue(new Error("session database unavailable"));

    const listReviews = vi
      .spyOn(sessions, "reviewSessionIds")
      .mockImplementation(() => { throw new Error("session database unavailable"); });
    const createReview = vi
      .spyOn(sessions, "createReviewSession")
      .mockRejectedValue(new Error("session database unavailable"));
    const server = createMcpServer({
      sessions,
      activityStore,
      localSettings: new InMemoryLocalSettingsService(),
      logger,
      readService: createTestReadService(),
      transactionActivityService: new TransactionActivityService({
        activityStore,
        source: createTestTransactionActivitySource()
      })
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      for (const call of [
        { name: TOOL_NAMES.sessionGetInteractionStatus, arguments: {} },
        { name: TOOL_NAMES.sessionGetReviewStatus, arguments: { reviewSessionId: "review" } },
        { name: TOOL_NAMES.sessionGetExecutionResult, arguments: { reviewSessionId: "review" } },
        {
          name: TOOL_NAMES.sessionWaitExecutionResult,
          arguments: { reviewSessionId: "review", timeoutMs: 1 }
        },
        {
          name: TOOL_NAMES.actionCreateProposalReview,
          arguments: {
            proposal: {
              type: "payment",
              id: "payment_1",
              source: { kind: "mcp_server", name: "external-payments" },
              network: "sui:mainnet",
              createdAt: "2026-05-24T23:59:00.000Z",
              purpose: "Pay invoice",
              payment: {
                amount: { amountDisplay: "100", symbol: "USDC" },
                recipient: { address: walletAccount }
              }
            }
          }
        }
      ]) {
        const result = await client.callTool(call);
        expect(textPayload(result)).toMatchObject({
          ok: false,
          error: { kind: "internal_error", details: { message: "Session store call failed" } }
        });
      }
      expect(logger.error).toHaveBeenCalledWith("session store call failed");
    } finally {
      getReview.mockRestore();
      listReviews.mockRestore();
      createReview.mockRestore();
      await Promise.allSettled([server.close(), client.close()]);
    }
  });
});

it.each(["missing_selection", "disconnected", "expired", "pending_disconnect", "sdk_missing", "different_account", "cleared", "unavailable", "workflow_absent", "database_error"] as const)("keeps asset recovery usable for each input contract after %s", async (condition) => {
  const f = await walletWorkflowFixture();
  const readService = createTestReadService();
  const inventory = vi.spyOn(readService, "summarizeDeepbookAccountInventory");
  let finishDisconnect: (() => void) | undefined;
  let connectionId: string | undefined;
  try { await f.run(async () => {
    if (condition !== "missing_selection") connectionId = (await f.approve()).connection.connectionId;
    const approved = f.transport.session("fixture-topic");
    if (condition === "disconnected") f.notify();
    if (condition === "sdk_missing") vi.spyOn(f.transport, "session").mockReturnValue(undefined);
    if (condition === "different_account") vi.spyOn(f.transport, "session").mockReturnValue({ ...approved!, grants: suiGrants([replacementWalletAccount]) });
    if (condition === "expired") vi.spyOn(f.transport, "session").mockReturnValue({ ...approved!, expiresAt: new Date(f.now().getTime() - 1).toISOString() });
    if (condition === "unavailable") vi.spyOn(f.transport, "session").mockImplementation(() => { throw new Error("PRIVATE SDK FAILURE"); });
    if (["sdk_missing", "different_account", "expired", "unavailable"].includes(condition)) f.observe();
    if (condition === "cleared") await seedReadAddressCleared(f.activity);
    if (condition === "database_error") vi.spyOn(f.activity, "getActiveAccount").mockRejectedValue(new Error("PRIVATE DB FAILURE"));
    if (condition === "pending_disconnect") {
      const pending = new Promise<void>((resolve) => { finishDisconnect = resolve; });
      vi.mocked(f.transport.disconnect).mockImplementationOnce(() => pending);
      const card = await f.createDisconnection(); await f.act(card, { action: "disconnect", connectionId });
    }
    const { client, server } = await connectTestClient({ activityStore: f.activity, readService,
      ...(condition === "workflow_absent" ? {} : { workflow: f.workflow }) });
    try {
      const result = await client.callTool({ name: TOOL_NAMES.readSummarizeDeepbookAccountInventory, arguments: {} });
      expect(result.isError).toBe(true);
      const error = (textPayload(result) as { error: { kind: string; details: Record<string, any> } }).error;
      const unavailable = condition === "unavailable" || condition === "workflow_absent";
      expect(error.kind).toBe(condition === "database_error" ? "internal_error" : unavailable ? "wallet_unavailable" : ["missing_selection", "cleared"].includes(condition) ? "active_account_not_set" : "input_invalid");
      expect(error.details.field).toBeUndefined(); expect(error.details.action).not.toBe("provide_account");
      expect(JSON.stringify(error)).not.toMatch(/Please provide a Sui address|PRIVATE SDK FAILURE|PRIVATE DB FAILURE/);
      expect(inventory).not.toHaveBeenCalled();
      if (condition === "cleared") expect(error.details.message).toContain("The saved read address was cleared in Settings");
      if (!unavailable && condition !== "database_error") {
        expect(error.details.followUp).toMatchObject({ tool: TOOL_NAMES.sessionGetInteractionStatus,
          answerFields: ["walletAvailability", "connection", "pendingWalletConnections", "assetReadAccount"] });
        const tools = (await client.listTools()).tools;
        expect(tools.some((tool) => tool.name === error.details.followUp.tool)).toBe(true);
        const state = (textPayload(await client.callTool({ name: error.details.followUp.tool, arguments: {} })) as { data: unknown }).data;
        for (const field of error.details.followUp.answerFields) expect(state).toHaveProperty(field);
        expect(tools.find((tool) => tool.name === TOOL_NAMES.readSummarizeDeepbookAccountInventory)!.inputSchema.properties).not.toHaveProperty("account");
      }
      for (const [name, args] of [
        [TOOL_NAMES.readSummarizeWalletAssets, { account: walletAccount }],
        [TOOL_NAMES.readClassifyWalletAssets, { account: walletAccount }],
        [TOOL_NAMES.readPreviewIntentEvidence, { account: walletAccount, intentKind: "cover_payment_like_amount", denomination: "dollar", requiredDisplayAmount: "1000" }]
      ] as const) expect(textPayload(await client.callTool({ name, arguments: args }))).toMatchObject({ ok: true });
      if (condition === "missing_selection") {
        await f.approve();
        expect(textPayload(await client.callTool({ name: TOOL_NAMES.readSummarizeDeepbookAccountInventory, arguments: {} }))).toMatchObject({ ok: true, data: { account: f.account } });
        expect(inventory).toHaveBeenCalledOnce();
      }
      expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  }); } finally {
    if (finishDisconnect) {
      finishDisconnect();
      await vi.waitFor(() => expect(f.run(() => f.records.connection(connectionId!)?.sdkPending)).toBe(false));
    }
    inventory.mockRestore(); f.close();
  }
});


it("asks for an explicit address across activity reads after Clear without changing the live wallet", async () => {
  const f = await walletWorkflowFixture();
  try { await f.run(async () => {
    const { connection } = await f.approve();
    const { client, server, sessions } = await connectTestClient({ activityStore: f.activity, workflow: f.workflow });
    try {
      const { session } = await sessions.createReviewSession([reviewPlan], f.now());
      await sessions.recordWalletConnected(session.id, f.account, f.now());
      await seedReadAddressCleared(f.activity);
      const current = f.records.currentConnection();
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
        { name: TOOL_NAMES.readListReviewActivity, arguments: {} },
        { name: TOOL_NAMES.readSummarizeReviewFunnel, arguments: {} },
        { name: TOOL_NAMES.readGetReviewSessionDetail, arguments: { reviewSessionId: session.id } },
        { name: TOOL_NAMES.readScanSuiAccountActivity, arguments: {} },
        { name: TOOL_NAMES.readSummarizeSuiActivityScan, arguments: {} },
        { name: TOOL_NAMES.readScanSuiFunctionActivity, arguments: { function: "0x2::coin::transfer" } },
        { name: TOOL_NAMES.readSummarizeSuiFunctionActivityScan, arguments: { function: "0x2::coin::transfer" } },
        { name: TOOL_NAMES.readSummarizeSuiAccountActivity, arguments: {} },
        { name: TOOL_NAMES.readGetAccountAssetTimeline, arguments: {
          start: "2026-06-26T19:40:00.000Z", end: "2026-06-26T20:10:00.000Z"
        } }
      ];
      for (const call of calls) {
        expect(textPayload(await client.callTool(call))).toMatchObject({ ok: false,
          error: { kind: "active_account_not_set", details: { action: "provide_account" } } });
        const explicit = textPayload(await client.callTool({ ...call, arguments: { ...call.arguments, account: f.account } }));
        expect(explicit).toMatchObject({ ok: true, data: call.name === TOOL_NAMES.readGetAccountAssetTimeline
          ? { account: f.account, coverage: { accountSource: "explicit_filter" } }
          : { accountSource: "explicit_filter" } });
      }
      expect(f.records.currentConnection()).toEqual(current);
      expect(f.workflow.resolveReviewTarget()).toEqual({ status: "available", connectionId: connection.connectionId, account: f.account });
      expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  }); } finally { f.close(); }
});

it("reports an unrecorded wallet session through the review gateway without creating another review or financial effect", async () => {
  const f = await walletWorkflowFixture();
  try { await f.run(async () => {
    const { connection } = await f.approve(), ready = await f.prepare(connection.connectionId);
    const { client, server } = await connectTestClient({ activityStore: f.activity, workflow: f.workflow,
      sessions: f.sessions, cards: { store: f.cards } });
    const createSession = vi.spyOn(f.sessions, "createReviewSession"), createCard = vi.spyOn(f.cards, "create");
    try {
      const originalReview = f.sessions.readReviewSession(ready.session.id);
      expect(originalReview).toMatchObject({ status: "ready_for_wallet_review", walletConnectionId: connection.connectionId, account: f.account });
      f.notify({ topic: "unrecorded-gateway-session", grants: suiGrants([f.account]), expiresAt: connection.expiresAt });
      expect(f.runtime.availability().status).toBe("available");
      expect(f.records.isUsableConnection(connection.connectionId)).toBe(true);
      const result = await client.callTool({ name: TOOL_NAMES.actionStartReview, arguments: { intent: {
        type: "swap", from: { symbol: "SUI", amount: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50, protocol: "deep"
      } } });
      expect(result.isError).toBe(true);
      expect(textPayload(result)).toMatchObject({ ok: false, error: { kind: "input_invalid",
        details: { reason: "connection_state_unconfirmed", action: "check_exact_wallet_account" } } });
      expect(createSession).not.toHaveBeenCalled(); expect(createCard).not.toHaveBeenCalled();
      expect(f.sessions.readReviewSession(ready.session.id)).toEqual(originalReview);
      expect(f.records.currentRequest(ready.session.id)).toBeUndefined();
      expect(f.quote).toHaveBeenCalledOnce(); expect(f.connect).toHaveBeenCalledOnce();
      expect(f.transport.disconnect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    } finally { createSession.mockRestore(); createCard.mockRestore(); await client.close(); await server.close(); }
  }); } finally { f.close(); }
});
