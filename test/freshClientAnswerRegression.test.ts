import type { ActivityStore } from "../src/core/activity/activityStore.js";
import type { WalletWorkflow } from "../src/core/session/walletWorkflow.js";
import { walletWorkflowFixture } from "./fixtures/walletWorkflow.js";
import { McpServer } from "@modelcontextprotocol/server";
import { registerActionTools } from "../src/mcp/tools/action/prepareSuiActionReview.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { mainnetCoins } from "@mysten/deepbook-v3";
import type { SuiClientTypes } from "@mysten/sui/client";
import { describe, expect, it } from "vitest";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import type { ActionPlan } from "../src/core/action/types.js";
import {
  TransactionActivityService,
  type SuiTransactionActivitySource
} from "../src/core/activity/transactionActivityService.js";
import {
  SuiReadService,
  type DeepBookCoinRegistry,
  type DeepBookReadClient
} from "../src/core/read/readService.js";
import { InMemorySessionStore } from "../src/core/session/sessionStore.js";
import { createMcpServer } from "../src/mcp/server.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/serverInfo.js";
import { DEFAULT_SUI_GRAPHQL_URL, DEFAULT_SUI_GRPC_URL } from "../src/runtime/config.js";
import {
  FRESH_CLIENT_SCENARIOS,
  type FreshClientResponseRule,
  type FreshClientScenario,
  type FreshClientToolExpectation
} from "./fixtures/freshClientScenarios.js";
import { InMemoryActivityStore } from "./fixtures/inMemoryActivityStore.js";
import {
  InMemoryLocalSettingsService,
  InMemoryPreferencesRepository
} from "./fixtures/inMemoryLocalSettings.js";
import { MemoryCoinMetadataCache } from "./fixtures/memoryCoinMetadataCache.js";

const accountAddress = `0x${"a".repeat(64)}`;
const fetchedAt = "2026-05-11T00:00:00.000Z";
const logger = { error() {} };

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ToolPayload = { ok: boolean; data?: Record<string, unknown> };

function textPayload(result: ClientToolResult): ToolPayload {
  return JSON.parse((result.content as Array<{ text?: string }>)[0]?.text ?? "");
}

function getPath(value: unknown, fieldPath: string): unknown {
  let cursor: unknown = value;
  for (const segment of fieldPath.split(".")) {
    const match = segment.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
    if (!match) {
      return undefined;
    }
    const [, key, indexValue] = match;
    if (key === undefined) {
      return undefined;
    }
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !(key in (cursor as Record<string, unknown>))
    ) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
    if (indexValue !== undefined) {
      const index = Number.parseInt(indexValue, 10);
      if (!Array.isArray(cursor) || cursor[index] === undefined) {
        return undefined;
      }
      cursor = cursor[index];
    }
  }
  return cursor;
}

function applyResponseRule(label: string, data: unknown, rule: FreshClientResponseRule): void {
  const value = getPath(data, rule.fieldPath);
  if (rule.equals !== undefined) {
    expect(value, `${label}: ${rule.fieldPath} equals`).toEqual(rule.equals);
  }
  if (rule.oneOf !== undefined) {
    expect(rule.oneOf, `${label}: ${rule.fieldPath} oneOf`).toContain(value);
  }
  if (rule.notOneOf !== undefined) {
    expect(rule.notOneOf, `${label}: ${rule.fieldPath} notOneOf`).not.toContain(value);
  }
  if (rule.arrayContains !== undefined) {
    expect(Array.isArray(value), `${label}: ${rule.fieldPath} arrayContains expects array`).toBe(true);
    for (const expected of rule.arrayContains) {
      expect(value as unknown[], `${label}: ${rule.fieldPath} arrayContains ${String(expected)}`).toContain(expected);
    }
  }
  if (rule.arrayDoesNotContain !== undefined) {
    expect(Array.isArray(value), `${label}: ${rule.fieldPath} arrayDoesNotContain expects array`).toBe(true);
    for (const forbidden of rule.arrayDoesNotContain) {
      expect(value as unknown[], `${label}: ${rule.fieldPath} arrayDoesNotContain ${String(forbidden)}`).not.toContain(
        forbidden
      );
    }
  }
}

function applyToolExpectation(
  label: string,
  userAnswerUse: Record<string, unknown> | undefined,
  expectation: FreshClientToolExpectation
): void {
  expect(userAnswerUse, `${label}: response must include userAnswerUse`).toBeDefined();
  const ua = userAnswerUse as {
    canAnswer?: string[];
    cannotAnswer?: string[];
    answerFields?: string[];
    preconditionFields?: string[];
    conclusionRuleFields?: string[];
    followUp?: { tool: string; answerFields: string[] };
  };

  const expectFields = (
    actual: string[] | undefined,
    required: readonly string[] | undefined,
    suffix: string
  ) => {
    if (!required) return;
    for (const field of required) {
      expect(actual ?? [], `${label}.${suffix} must include ${field}`).toContain(field);
    }
  };
  const expectNotFields = (
    actual: string[] | undefined,
    forbidden: readonly string[] | undefined,
    suffix: string
  ) => {
    if (!forbidden) return;
    for (const field of forbidden) {
      expect(actual ?? [], `${label}.${suffix} must NOT include ${field}`).not.toContain(field);
    }
  };
  const expectNotFieldPatterns = (
    actual: string[] | undefined,
    forbidden: readonly RegExp[] | undefined,
    suffix: string
  ) => {
    if (!forbidden) return;
    for (const pattern of forbidden) {
      for (const field of actual ?? []) {
        expect(field, `${label}.${suffix} must NOT match ${pattern}`).not.toMatch(pattern);
      }
    }
  };

  expectFields(ua.answerFields, expectation.requiredAnswerFields, "answerFields");
  expectNotFields(ua.answerFields, expectation.forbiddenAnswerFields, "answerFields");
  expectNotFieldPatterns(ua.answerFields, expectation.forbiddenAnswerFieldPatterns, "answerFields");
  expectFields(ua.canAnswer, expectation.requiredCanAnswerClaims, "canAnswer");
  expectNotFields(ua.canAnswer, expectation.forbiddenCanAnswerClaims, "canAnswer");
  expectFields(ua.cannotAnswer, expectation.requiredCannotAnswerClaims, "cannotAnswer");
  expectFields(ua.conclusionRuleFields, expectation.requiredConclusionRuleFields, "conclusionRuleFields");
  expectFields(ua.preconditionFields, expectation.requiredPreconditionFields, "preconditionFields");

  if (expectation.expectedFollowUpTool !== undefined) {
    expect(ua.followUp?.tool, `${label}.followUp.tool`).toBe(expectation.expectedFollowUpTool);
  }
  if (expectation.expectedFollowUpAnswerFields !== undefined) {
    for (const field of expectation.expectedFollowUpAnswerFields) {
      expect(ua.followUp?.answerFields ?? [], `${label}.followUp.answerFields must include ${field}`).toContain(
        field
      );
    }
  }
}

function createUnusedTransactionActivitySource(): SuiTransactionActivitySource {
  return {
    async verifyMainnet() {
      return {
        transport: "graphql",
        endpointHost: "graphql.mainnet.sui.io",
        chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
      };
    },
    async getTransaction() {
      return null;
    },
    async scanAccount() {
      return { transactions: [], hasMore: false };
    },
    async scanFunction() {
      return { transactions: [], hasMore: false };
    }
  };
}

function createActivityScanWithoutDetails(): SuiTransactionActivitySource {
  return {
    ...createUnusedTransactionActivitySource(),
    async scanAccount() {
      return {
        transactions: [
          {
            digest: "5".repeat(44),
            sender: accountAddress,
            checkpoint: "1",
            timestamp: "2026-05-10T00:00:00.000Z",
            status: "success"
            // details intentionally omitted so detailAvailability === "none"
          }
        ],
        hasMore: false
      };
    }
  };
}

function createDeepbookReadClient(): DeepBookReadClient {
  return {
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
      return [];
    },
    async accountExists() {
      return false;
    },
    async account() {
      throw new Error("DeepBook account inventory is outside fresh-client regression");
    },
    async lockedBalance() {
      throw new Error("DeepBook account inventory is outside fresh-client regression");
    },
    async accountOpenOrders() {
      throw new Error("DeepBook account inventory is outside fresh-client regression");
    }
  };
}

function createFreshClientReadService(): SuiReadService {
  const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
  if (!usdc) {
    throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
  }
  return new SuiReadService({
    network: "mainnet",
    chainIdentifier: "4c78adac",
    coinMetadataCache: new MemoryCoinMetadataCache(),
    now: () => new Date(fetchedAt),
    deepbookFactory: () => createDeepbookReadClient(),
    client: {
      core: {
        async listBalances(options: SuiClientTypes.ListBalancesOptions) {
          expect(options.owner).toBe(accountAddress);
          return {
            balances: [
              {
                coinType: usdc.type,
                balance: "1500000000",
                coinBalance: "1500000000",
                addressBalance: "1500000000"
              }
            ],
            hasNextPage: false,
            cursor: null
          };
        },
        async getCoinMetadata() {
          return { coinMetadata: null };
        }
      }
    }
  });
}

const DURABLE_SESSION_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function createFreshClientReviewPlan(id: string): ActionPlan {
  return {
    id,
    actionKind: "swap",
    adapterId: "deepbook-swap",
    protocol: "DeepBookV3",
    title: "Fresh-client ready review scenario",
    summary: "Ready review scenario plan",
    assetFlowPreview: {
      outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
      expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }]
    },
    adapterData: {
      requestedIntent: {
        type: "swap",
        from: { symbol: "SUI", amountDisplay: "1" },
        to: { symbol: "USDC" },
        maxSlippageBps: 50
      }
    },
    createdAt: "2026-05-11T00:01:00.000Z"
  };
}

async function createReadyFreshClientReviewSession(sessions: InMemorySessionStore, activityStore: ActivityStore) {
  await activityStore.setActiveAccount(accountAddress, "wallet_connection", new Date("2026-05-11T00:00:03.000Z"));

  const reviewPlan = createFreshClientReviewPlan("plan_fresh_client_ready");
  const { session: reviewSession } = await sessions.createReviewSession(
    [reviewPlan],
    new Date("2026-05-11T00:01:00.000Z")
  );
  await sessions.recordWalletConnected(reviewSession.id, accountAddress, new Date("2026-05-11T00:01:02.000Z"));
  const readySession = await sessions.recordReviewState(
    reviewSession.id,
    {
      reviewSessionId: reviewSession.id,
      planId: reviewPlan.id,
      account: accountAddress,
      status: "ready_for_wallet_review",
      checks: [],
      updatedAt: "2026-05-11T00:01:03.000Z"
    },
    new Date("2026-05-11T00:01:03.000Z")
  );

  return { reviewSession: readySession, reviewPlan };
}

async function connectFreshClient(options: {
  activityStore?: ActivityStore;
  workflow?: WalletWorkflow;
  transactionActivitySource?: SuiTransactionActivitySource;
  sessionTtlMs?: number;
} = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const activityStore = options.activityStore ?? new InMemoryActivityStore();
  const sessions = new InMemorySessionStore({
    activityStore,
    logger,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle,
    ...(options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs })
  });
  const repository = new InMemoryPreferencesRepository();
  await repository.ensureDefaultLocalSettings({
    suiGrpcUrl: DEFAULT_SUI_GRPC_URL,
    suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL
  });
  const transactionActivitySource =
    options.transactionActivitySource ?? createUnusedTransactionActivitySource();
  const server = createMcpServer({
    sessions,
    activityStore,
    ...(options.workflow ? { workflow: options.workflow } : {}),
    localSettings: new InMemoryLocalSettingsService(repository),
    logger,
    readService: createFreshClientReadService(),
    transactionActivityService: new TransactionActivityService({
      activityStore,
      source: transactionActivitySource,
      now: () => new Date(fetchedAt),
      scanId: () => "scan_fresh_client_regression"
    })
  });
  const client = new Client({ name: "fresh-client-regression", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, sessions, activityStore };
}

type ScenarioInvoker = (
  scenario: FreshClientScenario
) => Promise<ToolPayload>;

const scenarioInvokers: Record<string, ScenarioInvoker> = {
  payment_coverage_1000_usd: async (scenario) => {
    const { client, server } = await connectFreshClient();
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: {
            account: accountAddress,
            intentKind: "cover_payment_like_amount",
            denomination: "dollar",
            requiredDisplayAmount: "1000"
          }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  settlement_balance_total_check: async (scenario) => {
    const { client, server } = await connectFreshClient();
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: {
            account: accountAddress,
            intentKind: "summarize_settlement_asset_group_balance",
            denomination: "dollar"
          }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  settlement_asset_group_parity_reference_not_choice: async (scenario) => {
    const { client, server } = await connectFreshClient();
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: {
            denomination: "usd",
            referenceAssetSymbol: "USDC"
          }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  deepbook_quote_is_price_reference_not_payment: async (scenario) => {
    const { client, server } = await connectFreshClient();
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: {
            poolKey: "SUI_USDC",
            direction: "base_to_quote",
            amountDisplay: "1"
          }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  deepbook_mid_price_not_transaction_or_signing: async (scenario) => {
    const { client, server } = await connectFreshClient();
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: { poolKey: "SUI_USDC" }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  deepbook_inventory_discovery_not_detail_inventory: async (scenario) => {
    const f = await walletWorkflowFixture();
    try { return await f.run(async () => {
      const { client, server, activityStore } = await connectFreshClient({ activityStore: f.activity, workflow: f.workflow });
      try {
        const { connection } = await f.approve();
        f.notify({ ...f.transport.session("fixture-topic")!, accounts: [accountAddress] });
        await activityStore.setActiveAccount(accountAddress, "wallet_connection", new Date("2026-05-11T00:00:00.000Z"), { id: connection.connectionId });
        return textPayload(await client.callTool({ name: scenario.tool, arguments: {} }));
      } finally { await Promise.allSettled([client.close(), server.close()]); }
    }); } finally { f.close(); }
  },
  deepbook_swap_review_signing_blocked: async (scenario) => {
    const f = await walletWorkflowFixture();
    const server = new McpServer({ name: "fresh-review", version: "1" });
    registerActionTools(server, { sessions: f.sessions, activityStore: f.activity, cards: { store: f.cards }, logger });
    const client = new Client({ name: "fresh-review-client", version: "1" }, { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection"));
      return textPayload(await f.run(() => client.callTool({ name: scenario.tool, arguments: {
        intent: { type: "swap", from: { symbol: "SUI", amount: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50, protocol: "deep" }
      } })));
    } finally { await client.close(); await server.close(); f.close(); }
  },
  execution_wait_user_action_required_not_final: async (scenario) => {
    const { client, server, sessions, activityStore } = await connectFreshClient({
      sessionTtlMs: DURABLE_SESSION_TTL_MS
    });
    try {
      await activityStore.setActiveAccount(accountAddress, "wallet_connection", new Date("2026-05-11T00:00:03.000Z"));

      const reviewPlan: ActionPlan = {
        id: "plan_fresh_client_wait",
        actionKind: "swap",
        adapterId: "deepbook-swap",
        protocol: "DeepBookV3",
        title: "Fresh-client wait scenario",
        summary: "Wait scenario plan",
        assetFlowPreview: {
          outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
          expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }]
        },
        adapterData: {
          requestedIntent: { type: "swap", from: { symbol: "SUI", amountDisplay: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 }
        },
        createdAt: "2026-05-11T00:01:00.000Z"
      };
      const { session: reviewSession } = await sessions.createReviewSession(
        [reviewPlan],
        new Date("2026-05-11T00:01:00.000Z")
      );
      await sessions.recordWalletConnected(reviewSession.id, accountAddress, new Date("2026-05-11T00:01:02.000Z"));
      await sessions.recordReviewState(
        reviewSession.id,
        {
          reviewSessionId: reviewSession.id,
          planId: reviewPlan.id,
          account: accountAddress,
          status: "blocked",
          blockedReason: "adapter_not_implemented",
          checks: [],
          updatedAt: "2026-05-11T00:01:03.000Z"
        },
        new Date("2026-05-11T00:01:03.000Z")
      );

      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: { reviewSessionId: reviewSession.id, timeoutMs: 1 }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  review_status_ready_not_signing_or_safety: async (scenario) => {
    const { client, server, sessions, activityStore } = await connectFreshClient({
      sessionTtlMs: DURABLE_SESSION_TTL_MS
    });
    try {
      const { reviewSession } = await createReadyFreshClientReviewSession(sessions, activityStore);
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: { reviewSessionId: reviewSession.id }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  execution_result_absent_not_execution_proof: async (scenario) => {
    const { client, server, sessions, activityStore } = await connectFreshClient({
      sessionTtlMs: DURABLE_SESSION_TTL_MS
    });
    try {
      const { reviewSession } = await createReadyFreshClientReviewSession(sessions, activityStore);
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: { reviewSessionId: reviewSession.id }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  recent_activity_summary_with_no_details: async (scenario) => {
    const { client, server } = await connectFreshClient({
      transactionActivitySource: createActivityScanWithoutDetails()
    });
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: { account: accountAddress, limit: 5 }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  wallet_balance_refuses_profit_calculation: async (scenario) => {
    const { client, server } = await connectFreshClient();
    try {
      return textPayload(
        await client.callTool({
          name: scenario.tool,
          arguments: { account: accountAddress }
        })
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
};

describe("fresh-client answer regression", () => {
  for (const scenario of FRESH_CLIENT_SCENARIOS) {
    it(`keeps the response self-sufficient for: ${scenario.id}`, async () => {
      const invoke = scenarioInvokers[scenario.id];
      if (!invoke) {
        throw new Error(`No invoker registered for fresh-client scenario ${scenario.id}`);
      }
      const payload = await invoke(scenario);
      expect(payload.ok, `${scenario.id}: tool call must succeed`).toBe(true);
      expect(payload.data, `${scenario.id}: response must include data`).toBeDefined();
      const data = payload.data!;

      applyToolExpectation(
        scenario.id,
        data.userAnswerUse as Record<string, unknown> | undefined,
        scenario.toolExpectation
      );

      for (const rule of scenario.responseRules ?? []) {
        applyResponseRule(scenario.id, data, rule);
      }
    });
  }

  it("does not duplicate response-surface rules in SERVER_INSTRUCTIONS prose", () => {
    // These rules are structurally enforced on the relevant tool response
    // (userAnswerUse.cannotAnswer, conclusionRuleFields, quantitySemantics, or
    // pollingHint) or live in suimcp://docs/agent-behavior. Keep
    // SERVER_INSTRUCTIONS short and non-duplicative.
    const responseSurfaceRulesThatMustNotReturnAsProse: RegExp[] = [
      /DeepBook signing (?:is|remains) blocked in (?:this|the current) release/i,
      /doNotCombineWithPaymentAnswer: true as the rule for the conclusion/i,
      /Wallet asset reads are current coin-balance snapshots only/i,
      /Sui activity gas raw fields use MIST\. Prefer/i,
      /Sui activity amountRaw and \*Raw balance fields are raw integer facts/i,
      /transactionContext facts are transaction-level context/i,
      /accountBalanceChangeInferencePolicy=do_not_infer_from_transaction_context/i,
      /Do not provide profit formulas or hypothetical profit examples/i,
      /Use session_create_wallet_identity when a wallet-account read needs/i,
      /For DeepBook-supported price questions, use pinned DeepBook read tools/i,
      /summarize_settlement_asset_group_parity\.responseSummary for the user-facing answer/i
    ];
    for (const pattern of responseSurfaceRulesThatMustNotReturnAsProse) {
      expect(SERVER_INSTRUCTIONS, `SERVER_INSTRUCTIONS must not re-bloat with: ${pattern}`).not.toMatch(
        pattern
      );
    }
  });

  it("keeps SERVER_INSTRUCTIONS to a short, abstract runtime brief", () => {
    // The instruction surface is for short, abstract runtime direction only:
    // product identity, the userAnswerUse priority, USD preflight, active
    // account read context, the unsupported-category list, and a docs link.
    // Detailed answer-shape rules belong in per-response fields or in
    // suimcp://docs/agent-behavior. The thresholds below are slack-aware
    // ceilings, not targets.
    const lineCount = SERVER_INSTRUCTIONS.split("\n").length;
    expect(lineCount, "SERVER_INSTRUCTIONS line count must stay short").toBeLessThanOrEqual(8);
    expect(
      SERVER_INSTRUCTIONS.length,
      "SERVER_INSTRUCTIONS character length must stay short"
    ).toBeLessThanOrEqual(2000);
  });

  it("keeps the required runtime directions present in SERVER_INSTRUCTIONS", () => {
    // The slim surface must still carry the directions that are not derivable
    // from a single tool response: product identity, the userAnswerUse
    // priority, the USD preflight chain, the active-account read-context
    // framing, the unsupported-category list, and the docs link.
    const requiredDirections: RegExp[] = [
      /mainnet-only Sui DeFi intent evidence toolkit/i,
      /userAnswerUse\.answerFields/i,
      /toolAvailability\.requiredToolsAvailable/i,
      /read_get_server_status, then read_list_settlement_asset_groups, then read_preview_intent_evidence/i,
      /read_summarize_settlement_asset_group_parity/i,
      /active account context/i,
      /Unsupported:/i,
      /suimcp:\/\/docs\/agent-behavior/i
    ];
    for (const pattern of requiredDirections) {
      expect(SERVER_INSTRUCTIONS, `SERVER_INSTRUCTIONS must still carry: ${pattern}`).toMatch(pattern);
    }
  });
});
