import { createRuntimeReviewDependencies } from "./reviewDependencies.js";
import { computeSmokeReview, SmokeReviewConfigError } from "./smokeReview.js";
import { parseSuiAddress } from "../core/suiAddress.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { validateSupportedAdapterLifecycle } from "../adapters/adapterLifecycleValidators.js";
import { SqliteActivityStore } from "../core/activity/sqliteActivityStore.js";
import { TransactionActivityService } from "../core/activity/transactionActivityService.js";
import { createSuiReadService } from "../core/read/readService.js";
import { DeepbookOfficialIndexerSource } from "../core/read/deepbookOfficialIndexerSource.js";
import { LocalSessionStore } from "../core/session/sessionStore.js";
import { createMcpServer } from "../mcp/server.js";
import { TOOL_NAMES } from "../mcp/toolNames.js";
import { DEFAULT_SUI_GRAPHQL_URL, DEFAULT_SUI_GRPC_URL, composeRuntimeConfig, loadBootConfig } from "./config.js";
import { RuntimeLocalSettingsService } from "./localSettingsService.js";
import { createStderrLogger } from "./logger.js";
import {
  SmokeResponseShapeError,
  type ActivitySmokeRecord,
  assertSmokeOkStatus,
  summarizeActivitySmokePayload
} from "./smokeMainnetReadAssertions.js";
import { SuiEndpointError, verifyMainnetGraphqlEndpoint, verifyMainnetGrpcEndpoint } from "./suiEndpoint.js";
import { GraphqlSuiTransactionActivitySource } from "./suiTransactionGraphqlSource.js";

const startedAt = new Date();
const smokeFunctionTarget = process.env.SUI_MCP_SMOKE_FUNCTION_TARGET;
const plannedTools = [
  TOOL_NAMES.readSummarizeWalletAssets,
  TOOL_NAMES.readInspectDeepbookOrderbook,
  TOOL_NAMES.readQuoteDeepbookAction,
  TOOL_NAMES.readScanSuiAccountActivity,
  TOOL_NAMES.readSummarizeSuiActivityScan,
  ...(smokeFunctionTarget
    ? [
        TOOL_NAMES.readScanSuiFunctionActivity,
        TOOL_NAMES.readSummarizeSuiFunctionActivityScan
      ]
    : [])
] as const;
const attemptedTools: string[] = [];
const completedTools: string[] = [];
const activitySmoke: Partial<Record<"scan" | "summary", ActivitySmokeRecord>> = {};
const functionActivitySmoke: Partial<Record<"scan" | "summary", ActivitySmokeRecord>> & {
  status?: "not_run";
  tools?: string[] | undefined;
  notRunReason?: "missing_env" | undefined;
} = smokeFunctionTarget
  ? {
      tools: [
        TOOL_NAMES.readScanSuiFunctionActivity,
        TOOL_NAMES.readSummarizeSuiFunctionActivityScan
      ]
    }
  : {
      status: "not_run",
      tools: [
        TOOL_NAMES.readScanSuiFunctionActivity,
        TOOL_NAMES.readSummarizeSuiFunctionActivityScan
      ],
      notRunReason: "missing_env"
    };
const ACTIVITY_SMOKE_LIMIT = 5;
type SmokeErrorCategory = "missing_env" | "config_error" | "tool_failure" | "runtime_error";

class SmokeMainnetError extends Error {
  constructor(readonly category: SmokeErrorCategory, message: string) {
    super(message);
  }
}

async function main(): Promise<void> {
  const logger = createStderrLogger("smoke-mainnet");
  const bootConfig = loadSmokeBootConfig();
  const smokeAddress = parseSuiAddress(requiredEnv("SUI_MCP_SMOKE_ADDRESS")) ?? fail("config_error", "SUI_MCP_SMOKE_ADDRESS must be a Sui address.");
  const poolKey = requiredEnv("SUI_MCP_SMOKE_DEEPBOOK_POOL_KEY");
  const quoteAmount = requiredEnv("SUI_MCP_SMOKE_QUOTE_AMOUNT");
  const inspectDigest = process.env.SUI_MCP_SMOKE_INSPECT_DIGEST;
  const inspectRandomLatest = truthyEnv("SUI_MCP_SMOKE_INSPECT_RANDOM_LATEST");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sui-mcp-smoke", version: "0.0.0" });
  let smokeDbDir: string | undefined;
  let activityStore: SqliteActivityStore | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;

  try {
    smokeDbDir = mkdtempSync(join(tmpdir(), "sui-mcp-smoke-db-"));
    activityStore = new SqliteActivityStore({
      databasePath: join(smokeDbDir, "sui-mcp.sqlite"),
      validateAdapterLifecycle: validateSupportedAdapterLifecycle
    });
    const preferencesRepository = activityStore.createPreferencesRepository();
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
    const readService = createSuiReadService({
      client: suiClient,
      network: config.network,
      chainIdentifier,
      coinMetadataCache: activityStore.createCoinMetadataCache(),
      deepbookOfficialIndexerSource: new DeepbookOfficialIndexerSource()
    });
    const transactionMaterialStore = activityStore.createTransactionMaterialStore();
    const sessions = new LocalSessionStore({
      activityStore,
      logger,
      validateAdapterLifecycle: validateSupportedAdapterLifecycle,
      sessions: activityStore.createSessionRecordStore(),
      artifacts: activityStore.createPrivateReviewArtifactStore(),
    });
    const reviewDependencies = createRuntimeReviewDependencies({ client: suiClient, chainIdentifier,
      expectedChainIdentifier: config.expectedChainIdentifier, materialStore: transactionMaterialStore, readService });
    // Utility-only read context in this script's temporary DB. This does not
    // create a live wallet session or prove address ownership.
    await activityStore.setActiveAccount(smokeAddress, "wallet_connection", new Date(), { name: "Explicit smoke read fixture" });
    server = createMcpServer({
      sessions,
      activityStore,
      localSettings,
      readService,
      transactionActivityService: new TransactionActivityService({
        activityStore,
        source: new GraphqlSuiTransactionActivitySource({
          url: config.graphqlUrl,
          expectedChainIdentifier: config.expectedChainIdentifier
        })
      }),
      logger
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const accountBoundSwapReview = await computeSmokeReview({ env: process.env, account: smokeAddress, sessions, computation: reviewDependencies });
    if (accountBoundSwapReview.status === "ok") markCompleted("account_bound_swap_review");

    const wallet = await callSmokeTool(client, TOOL_NAMES.readSummarizeWalletAssets, { account: smokeAddress });
    const orderbook = await callSmokeTool(client, TOOL_NAMES.readInspectDeepbookOrderbook, {
      poolKey,
      ticks: 5
    });
    const quote = await callSmokeTool(client, TOOL_NAMES.readQuoteDeepbookAction, {
      poolKey,
      direction: "base_to_quote",
      amountRaw: quoteAmount
    });
    const activityScan = await callSmokeTool(client, TOOL_NAMES.readScanSuiAccountActivity, {
      account: smokeAddress,
      limit: ACTIVITY_SMOKE_LIMIT
    });
    const activitySummary = await callSmokeTool(client, TOOL_NAMES.readSummarizeSuiActivityScan, {
      limit: ACTIVITY_SMOKE_LIMIT
    });

    assertSmokeOkStatus(wallet, TOOL_NAMES.readSummarizeWalletAssets);
    markCompleted(TOOL_NAMES.readSummarizeWalletAssets);
    assertSmokeOkStatus(orderbook, TOOL_NAMES.readInspectDeepbookOrderbook);
    markCompleted(TOOL_NAMES.readInspectDeepbookOrderbook);
    assertSmokeOkStatus(quote, TOOL_NAMES.readQuoteDeepbookAction);
    markCompleted(TOOL_NAMES.readQuoteDeepbookAction);
    activitySmoke.scan = summarizeActivitySmokePayload(activityScan, TOOL_NAMES.readScanSuiAccountActivity, {
      expectedAccountSource: "explicit_filter",
      requireAnalysis: false,
      expectNoDetails: true
    });
    markCompleted(TOOL_NAMES.readScanSuiAccountActivity);
    activitySmoke.summary = summarizeActivitySmokePayload(activitySummary, TOOL_NAMES.readSummarizeSuiActivityScan, {
      expectedAccountSource: "active_account_context",
      requireAnalysis: true,
      expectNoDetails: true
    });
    markCompleted(TOOL_NAMES.readSummarizeSuiActivityScan);

    if (smokeFunctionTarget) {
      const functionActivityScan = await callSmokeTool(client, TOOL_NAMES.readScanSuiFunctionActivity, {
        function: smokeFunctionTarget,
        account: smokeAddress,
        limit: ACTIVITY_SMOKE_LIMIT
      });
      const functionActivitySummary = await callSmokeTool(client, TOOL_NAMES.readSummarizeSuiFunctionActivityScan, {
        function: smokeFunctionTarget,
        limit: ACTIVITY_SMOKE_LIMIT
      });
      functionActivitySmoke.scan = summarizeActivitySmokePayload(
        functionActivityScan,
        TOOL_NAMES.readScanSuiFunctionActivity,
        {
          expectedAccountSource: "explicit_filter",
          expectedRelationship: "sent",
          requireFunction: true,
          requireAnalysis: false,
          expectNoDetails: true
        }
      );
      markCompleted(TOOL_NAMES.readScanSuiFunctionActivity);
      functionActivitySmoke.summary = summarizeActivitySmokePayload(
        functionActivitySummary,
        TOOL_NAMES.readSummarizeSuiFunctionActivityScan,
        {
          expectedAccountSource: "active_account_context",
          expectedRelationship: "sent",
          requireFunction: true,
          requireAnalysis: true,
          expectNoDetails: true
        }
      );
      markCompleted(TOOL_NAMES.readSummarizeSuiFunctionActivityScan);
    }

    if (inspectDigest) {
      const inspected = await callSmokeTool(client, TOOL_NAMES.readInspectSuiTransaction, {
        digest: inspectDigest,
        account: smokeAddress
      });
      assertSmokeOkStatus(inspected, TOOL_NAMES.readInspectSuiTransaction);
      markCompleted(TOOL_NAMES.readInspectSuiTransaction);
    } else if (inspectRandomLatest) {
      const randomLatestDigest = await pickRandomLatestTransactionDigest({
        url: config.graphqlUrl,
        expectedChainIdentifier: config.expectedChainIdentifier
      });
      const inspected = await callSmokeTool(client, TOOL_NAMES.readInspectSuiTransaction, {
        digest: randomLatestDigest
      });
      assertSmokeOkStatus(inspected, TOOL_NAMES.readInspectSuiTransaction);
      markCompleted(TOOL_NAMES.readInspectSuiTransaction);
    }

    tryWriteSmokeResult({
      accountBoundSwapReview,
      ok: true,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      chainIdentifier,
      env: smokeEnvPresence(),
      plannedTools: [...plannedTools],
      attemptedTools,
      tools: completedTools,
      activitySmoke,
      functionActivitySmoke
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          plannedTools: [...plannedTools],
          attemptedTools,
          tools: completedTools,
          activitySmoke,
          functionActivitySmoke
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled([
      ...(server ? [server.close()] : []),
      client.close(),
    ]);
    activityStore?.close();
    if (smokeDbDir) rmSync(smokeDbDir, { recursive: true, force: true });
  }
}

async function callSmokeTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  attemptedTools.push(name);
  return callTool(client, name, args);
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.type === "text" ? content[0].text : undefined;
  if (!text) {
    fail("tool_failure", `Tool ${name} did not return text JSON content`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new SmokeResponseShapeError(
      `Tool ${name} did not return valid text JSON content: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function markCompleted(name: string): void {
  if (!completedTools.includes(name)) {
    completedTools.push(name);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    fail("missing_env", `${name} is required for npm run smoke:mainnet`);
  }
  return value;
}

function truthyEnv(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "TRUE" || value === "yes" || value === "YES";
}

async function pickRandomLatestTransactionDigest(input: {
  url: string;
  expectedChainIdentifier: string;
}): Promise<string> {
  const { client } = await verifyMainnetGraphqlEndpoint({
    url: input.url,
    expectedChainIdentifier: input.expectedChainIdentifier
  });
  const result = await client.query<{
    transactions?: {
      nodes?: Array<{ digest?: unknown }> | null;
    } | null;
  }>({
    query: `
      query SuiMcpSmokeLatestTransactionSample($last: Int!) {
        transactions(last: $last) {
          nodes { digest }
        }
      }
    `,
    variables: { last: 20 }
  });
  if (result.errors && result.errors.length > 0) {
    fail("tool_failure", `Latest transaction sample query failed: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  const digests = result.data?.transactions?.nodes
    ?.flatMap((node) => typeof node.digest === "string" && node.digest.length > 0 ? [node.digest] : []) ?? [];
  if (digests.length === 0) {
    fail("tool_failure", "Latest transaction sample query returned no transaction digests");
  }
  return digests[randomInt(digests.length)] ?? fail("tool_failure", "Latest transaction sample selection failed");
}

function loadSmokeBootConfig(): ReturnType<typeof loadBootConfig> {
  try {
    return loadBootConfig();
  } catch (error) {
    throw new SmokeMainnetError("config_error", error instanceof Error ? error.message : String(error));
  }
}

function fail(category: SmokeErrorCategory, message: string): never {
  throw new SmokeMainnetError(category, message);
}

function smokeEnvPresence(): Record<string, boolean> {
  return {
    SUI_MCP_GRPC_URL: process.env.SUI_MCP_GRPC_URL !== undefined,
    SUI_MCP_GRAPHQL_URL: process.env.SUI_MCP_GRAPHQL_URL !== undefined,
    SUI_MCP_SMOKE_ADDRESS: process.env.SUI_MCP_SMOKE_ADDRESS !== undefined,
    SUI_MCP_SMOKE_DEEPBOOK_POOL_KEY: process.env.SUI_MCP_SMOKE_DEEPBOOK_POOL_KEY !== undefined,
    SUI_MCP_SMOKE_QUOTE_AMOUNT: process.env.SUI_MCP_SMOKE_QUOTE_AMOUNT !== undefined,
    SUI_MCP_SMOKE_INSPECT_DIGEST: process.env.SUI_MCP_SMOKE_INSPECT_DIGEST !== undefined,
    SUI_MCP_SMOKE_INSPECT_RANDOM_LATEST: process.env.SUI_MCP_SMOKE_INSPECT_RANDOM_LATEST !== undefined,
    SUI_MCP_SMOKE_FUNCTION_TARGET: process.env.SUI_MCP_SMOKE_FUNCTION_TARGET !== undefined,
    SUI_MCP_SMOKE_SWAP_PROTOCOL: process.env.SUI_MCP_SMOKE_SWAP_PROTOCOL !== undefined,
    SUI_MCP_SMOKE_SWAP_FROM_SYMBOL: process.env.SUI_MCP_SMOKE_SWAP_FROM_SYMBOL !== undefined,
    SUI_MCP_SMOKE_SWAP_TO_SYMBOL: process.env.SUI_MCP_SMOKE_SWAP_TO_SYMBOL !== undefined,
    SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY: process.env.SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY !== undefined
  };
}

function tryWriteSmokeResult(record: Record<string, unknown>): void {
  try {
    writeSmokeResult(record);
  } catch (error) {
    process.stderr.write(
      `smoke:mainnet result recording failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

function writeSmokeResult(record: Record<string, unknown>): void {
  const directory = join(process.cwd(), ".WORK", "smoke-results");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${record.completedAt ?? new Date().toISOString()}.json`.replace(/:/g, "-")),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function smokeErrorCategory(error: unknown): string {
  if (error instanceof SuiEndpointError) {
    return error.kind;
  }
  if (error instanceof SmokeResponseShapeError) {
    return "tool_failure";
  }
  if (error instanceof SmokeReviewConfigError) return "config_error";
  if (error instanceof SmokeMainnetError) {
    return error.category;
  }
  return "runtime_error";
}

main().catch((error: unknown) => {
  tryWriteSmokeResult({
    ok: false,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    env: smokeEnvPresence(),
    attemptedTools,
    tools: completedTools,
    plannedTools: [...plannedTools],
    activitySmoke,
    functionActivitySmoke,
    errorCategory: smokeErrorCategory(error)
  });
  process.stderr.write(
    `smoke:mainnet failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
