import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { mainnetCoins } from "@mysten/deepbook-v3";
import type { SuiClientTypes } from "@mysten/sui/client";
import { describe, expect, it } from "vitest";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import { TransactionActivityService, type SuiTransactionActivitySource } from "../src/core/activity/transactionActivityService.js";
import { decimalsFromScalar, formatRawAmount } from "../src/core/read/coinMetadata.js";
import { DEEPBOOK_PINNED_SDK_METADATA_SOURCE } from "../src/core/read/deepbookSourceOwners.js";
import { SuiReadService, type DeepBookCoinRegistry, type DeepBookReadClient } from "../src/core/read/readService.js";
import { InMemorySessionStore } from "../src/core/session/sessionStore.js";
import { createMcpServer } from "../src/mcp/server.js";
import { EVIDENCE_POLICY, IMPLEMENTED_TOOLS, PACKAGE_NAME, SERVER_VERSION } from "../src/mcp/serverInfo.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";
import { DEFAULT_SUI_GRAPHQL_URL, DEFAULT_SUI_GRPC_URL } from "../src/runtime/config.js";
import { InMemoryActivityStore } from "./fixtures/inMemoryActivityStore.js";
import {
  InMemoryLocalSettingsService,
  InMemoryPreferencesRepository
} from "./fixtures/inMemoryLocalSettings.js";
import { MemoryCoinMetadataCache } from "./fixtures/memoryCoinMetadataCache.js";
import {
  MCP_REPLAY_FORBIDDEN_CLAIMS,
  SETTLEMENT_ASSET_ONLY_RESPONSE_FIELDS,
  intentEvidenceScenarios
} from "./fixtures/intentEvidenceScenarios.js";
import { quoteDetourGoldenAnswer } from "./fixtures/intentEvidenceGoldenAnswers.js";

const accountAddress = `0x${"a".repeat(64)}`;
const mainnetChainIdentifier = "4c78adac";
const fetchedAt = "2026-05-11T00:00:00.000Z";
const logger = { error() {} };
const goldenAnswersDocumentUrl = new URL(
  "../docs/golden-scenarios/INTENT_EVIDENCE_GOLDEN_ANSWERS.md",
  import.meta.url
);

type ToolPayload = {
  ok: boolean;
  data?: Record<string, unknown>;
};

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textPayload(result: ClientToolResult): ToolPayload {
  return JSON.parse((result.content as Array<{ text?: string }>)[0]?.text ?? "");
}

function primaryResponseEvidence(data: Record<string, unknown>): Record<string, unknown> {
  const responseEvidence = data.responseEvidence as { primaryEvidenceFields: readonly string[] };
  const evidence: Record<string, unknown> = {};
  for (const field of responseEvidence.primaryEvidenceFields) {
    evidence[field] = data[field];
  }
  return evidence;
}

async function connectScenarioClient(balanceRawAmount: string) {
  return connectReplayClient(createScenarioReadService(balanceRawAmount));
}

async function connectReplayClient(readService: SuiReadService) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const activityStore = new InMemoryActivityStore();
  const sessions = new InMemorySessionStore({
    activityStore,
    logger,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle
  });
  const repository = new InMemoryPreferencesRepository();
  await repository.ensureDefaultLocalSettings({
    suiGrpcUrl: DEFAULT_SUI_GRPC_URL,
    suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL
  });
  const server = createMcpServer({
    sessions,
    activityStore,
    localSettings: new InMemoryLocalSettingsService(repository),
    logger,
    readService,
    transactionActivityService: new TransactionActivityService({
      activityStore,
      source: createUnusedTransactionActivitySource(),
      now: () => new Date(fetchedAt),
      scanId: () => "scan_intent_evidence_replay"
    })
  });
  const client = new Client({ name: "intent-evidence-scenario-replay", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function getQuoteDirectionalOutputRaw(data: Record<string, unknown>): string {
  const rawQuote = data.rawQuote as Record<string, unknown>;
  const directionalOutput = rawQuote.directionalOutput as Record<string, unknown>;
  return directionalOutput.raw as string;
}

const quoteDetourForbiddenFinalAnswerFragments = [
  "\uB2E4\uB978 \uC790\uC0B0\uAE4C\uC9C0 \uAC10\uC548",
  "\uC804\uBD80 \uBC14\uAFB8\uBA74",
  "\uD569\uC0B0 \uAC00\uB2A5",
  "\uADF8\uB798\uB3C4 \uBD80\uC871"
] as const;

function forbiddenQuoteDetourFinalAnswerFragments(answer: string): string[] {
  return quoteDetourForbiddenFinalAnswerFragments.filter((fragment) => answer.includes(fragment));
}

function requiredSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing start marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function requiredBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing block start marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing block end marker ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start + startMarker.length, end);
}

function expectNormalizedContains(source: string, fragment: string): void {
  expect(source.toLowerCase()).toContain(fragment.toLowerCase());
}

function createScenarioReadService(balanceRawAmount: string): SuiReadService {
  const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
  if (!usdc) {
    throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
  }
  return new SuiReadService({
    network: "mainnet",
    chainIdentifier: mainnetChainIdentifier,
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
                balance: balanceRawAmount,
                coinBalance: balanceRawAmount,
                addressBalance: balanceRawAmount
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
      return { baseOutRaw: "1000000", quoteOutRaw: "0", deepRequiredRaw: "0" };
    },
    async getBalanceManagerIds() {
      return [];
    },
    async accountExists() {
      return false;
    },
    async account() {
      throw new Error("DeepBook account inventory is outside intent evidence replay");
    },
    async lockedBalance() {
      throw new Error("DeepBook account inventory is outside intent evidence replay");
    },
    async accountOpenOrders() {
      throw new Error("DeepBook account inventory is outside intent evidence replay");
    }
  };
}

function createQuoteDetourReadService(): SuiReadService {
  const coins = mainnetCoins as DeepBookCoinRegistry;
  const usdc = coins.USDC;
  const sui = coins.SUI;
  const ns = coins.NS;
  if (!usdc || !sui || !ns) {
    throw new Error("SUI, NS, or USDC token fixture is missing from pinned DeepBook mainnetCoins");
  }

  return new SuiReadService({
    network: "mainnet",
    chainIdentifier: mainnetChainIdentifier,
    coinMetadataCache: new MemoryCoinMetadataCache(),
    now: () => new Date(fetchedAt),
    deepbookFactory: () => createQuoteDetourDeepbookReadClient(),
    client: {
      core: {
        async listBalances(options: SuiClientTypes.ListBalancesOptions) {
          expect(options.owner).toBe(accountAddress);
          return {
            balances: [
              { coinType: sui.type, balance: "148626825440", coinBalance: "148626825440", addressBalance: "0" },
              { coinType: ns.type, balance: "254984750", coinBalance: "254984750", addressBalance: "0" },
              { coinType: usdc.type, balance: "278890119", coinBalance: "278890119", addressBalance: "278890119" }
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

function createQuoteDetourDeepbookReadClient(): DeepBookReadClient {
  return {
    ...createDeepbookReadClient(),
    async getQuoteQuantityOutRaw(poolKey) {
      if (poolKey === "SUI_USDC") {
        return { baseOutRaw: "26825440", quoteOutRaw: "148641608", deepRequiredRaw: "954804" };
      }
      if (poolKey === "NS_USDC") {
        return { baseOutRaw: "84750", quoteOutRaw: "3456013", deepRequiredRaw: "111014" };
      }
      return { baseOutRaw: "0", quoteOutRaw: "0", deepRequiredRaw: "0" };
    }
  };
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

describe("intent evidence scenario replay", () => {
  it("keeps the durable quote-detour golden answer boundary in the document fixture", () => {
    const goldenAnswers = readFileSync(goldenAnswersDocumentUrl, "utf8");
    const quoteDetourSection = requiredSlice(
      goldenAnswers,
      `\`${quoteDetourGoldenAnswer.scenarioId}\``,
      `\`${quoteDetourGoldenAnswer.nextScenarioId}\``
    );
    const allowedConclusion = requiredBlock(
      quoteDetourSection,
      "Allowed conclusion:",
      "Forbidden conclusions:"
    );
    const forbiddenConclusions = requiredBlock(
      quoteDetourSection,
      "Forbidden conclusions:",
      "Required evidence fields:"
    );
    const requiredEvidenceFields = requiredBlock(
      quoteDetourSection,
      "Required evidence fields:",
      "Answer shape:"
    );

    for (const field of quoteDetourGoldenAnswer.expectedAmountFields) {
      expect(quoteDetourSection).toContain(field);
    }
    for (const field of quoteDetourGoldenAnswer.requiredEvidenceFields) {
      expect(requiredEvidenceFields).toContain(field);
    }
    for (const fragment of quoteDetourGoldenAnswer.allowedConclusionFragments) {
      expect(allowedConclusion).toContain(fragment);
    }
    for (const fragment of quoteDetourGoldenAnswer.forbiddenConclusionFragments) {
      expectNormalizedContains(forbiddenConclusions, fragment);
      expect(allowedConclusion.toLowerCase()).not.toContain(fragment.toLowerCase());
    }
    for (const fragment of quoteDetourGoldenAnswer.forbiddenCombinedAmountFragments) {
      expect(forbiddenConclusions).toContain(fragment);
      expect(allowedConclusion).not.toContain(fragment);
    }
  });

  it.each(intentEvidenceScenarios.map((scenario) => [scenario.id, scenario] as const))(
    "replays the MCP evidence policy for %s",
    async (_scenarioId, scenario) => {
      const { client, server } = await connectScenarioClient(scenario.balanceRawAmount);
      try {
        expect(scenario.intendedMcpToolPath).toEqual([
          TOOL_NAMES.readGetServerStatus,
          TOOL_NAMES.readListSettlementAssetGroups,
          TOOL_NAMES.readPreviewIntentEvidence
        ]);

        const statusPayload = textPayload(await client.callTool({ name: TOOL_NAMES.readGetServerStatus }));
        expect(statusPayload).toMatchObject({
          ok: true,
          data: {
            packageName: PACKAGE_NAME,
            version: SERVER_VERSION,
            network: "mainnet",
            implementedToolsCount: IMPLEMENTED_TOOLS.length,
            evidencePolicy: {
              version: EVIDENCE_POLICY.version,
              releaseGate: "intent_evidence_v1",
              requiredFirstCheck: true
            }
          }
        });

        const assetGroupsPayload = textPayload(await client.callTool({ name: TOOL_NAMES.readListSettlementAssetGroups }));
        expect(assetGroupsPayload).toMatchObject({ ok: true, data: { status: "ok" } });
        expect(assetGroupsPayload.data?.assetGroups).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "SUI_USD_SETTLEMENT_ASSETS",
              evidenceSources: expect.objectContaining({
                sdk: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.sdk,
                registry: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.registry,
                unitSource: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.unitSource
              })
            })
          ])
        );

        const evidencePayload = textPayload(
          await client.callTool({
            name: TOOL_NAMES.readPreviewIntentEvidence,
            arguments: {
              account: accountAddress,
              ...scenario.previewIntentEvidenceInput
            }
          })
        );
        expect(evidencePayload.ok).toBe(true);
        const evidence = evidencePayload.data;
        expect(evidence).toBeDefined();
        if (!evidence) {
          throw new Error("Intent evidence payload is missing data");
        }

        expect(evidence).toMatchObject({
          status: "ok",
          account: accountAddress,
          fetchedAt,
          intent: {
            denomination: "dollar",
            ...("requiredDisplayAmount" in scenario.previewIntentEvidenceInput
              ? { requiredDisplayAmount: scenario.previewIntentEvidenceInput.requiredDisplayAmount }
              : {})
          },
          userAnswerUse: {
            canAnswer: expect.arrayContaining(["usd_denominated_payment_coverage_status"]),
            cannotAnswer: expect.arrayContaining(["settlement_token_selection", "route_dependent_payment_support"]),
            answerFields: expect.arrayContaining(["responseSummary", "responseSummary.amountsUsedForAnswer"])
          },
          quantitySemantics: {
            kind: "sui_intent_evidence_report",
            transactionBuildingAvailable: false,
            signingReadinessAvailable: false,
            routeRecommendationAvailable: false,
            fiatUsdCashOutAvailable: false,
            profitAndLossAvailable: false
          },
          responseEvidence: {
            mode: "settlement_asset_only",
            primaryEvidenceFields: [...SETTLEMENT_ASSET_ONLY_RESPONSE_FIELDS],
            supportedResponseClaims: scenario.expectedSupportedClaims
          },
          responseSummary: {
            questionKind:
              scenario.previewIntentEvidenceInput.intentKind === "cover_payment_like_amount"
                ? "payment_coverage"
                : "settlement_asset_group_balance_total",
            conclusionKind:
              scenario.expectedCoverageStatus === "balance_total_only"
                ? "current_settlement_asset_total"
                : scenario.expectedCoverageStatus,
            answerCompleteness: {
              answerCompleteFor: "settlement_asset_group_answer",
              requiredAnswerFields: ["responseSummary"],
              notCompleteFor: expect.arrayContaining(["selected_target_context", "route_dependent_payment_support"])
            },
            doNotCallQuoteToolsForThisQuestion: true,
            coverageBasis: "settlement_asset_wallet_balance_only",
            assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
            currentDisplayAmount: scenario.expectedCurrentDisplayAmount,
            requiredDisplayAmount:
              "requiredDisplayAmount" in scenario.previewIntentEvidenceInput
                ? scenario.previewIntentEvidenceInput.requiredDisplayAmount
                : null,
            shortfallDisplayAmount: scenario.expectedShortfallDisplayAmount ?? null,
            doNotUseForConclusion: [
              "separate_quote_tool_results",
              "assets_outside_settlement_group",
              "route_dependent_payment_support"
            ],
            excludedFromConclusion: expect.arrayContaining([
              "separate_quote_tool_results",
              "candidate_conversion_quote_evidence",
              "assets_outside_settlement_group",
              "settlement_token_selection",
              "route_dependent_payment_support"
            ])
          },
          settlementAssetCoverage: {
            status: scenario.expectedCoverageStatus,
            currentDisplayAmount: scenario.expectedCurrentDisplayAmount
          }
        });
        expect(evidence.intent).not.toHaveProperty("targetAssetSymbol");
        expect(evidence.intent).not.toHaveProperty("targetAssetSelectionSource");
        expect(evidence).not.toHaveProperty("selectedTarget");
        if (scenario.expectedShortfallDisplayAmount !== undefined) {
          expect(evidence.settlementAssetCoverage).toMatchObject({
            shortfallDisplayAmount: scenario.expectedShortfallDisplayAmount
          });
        }
        expect((evidence.requiredUserChoices as unknown[]).length > 0).toBe(scenario.expectsRequiredChoice);
        expect(evidence.unsupportedClaims).toEqual(expect.arrayContaining([...MCP_REPLAY_FORBIDDEN_CLAIMS]));
        expect(evidence.unsupportedClaims).toEqual(expect.arrayContaining([...scenario.forbiddenClaims]));
        expect(evidence.responseEvidence).toMatchObject({
          primaryEvidenceFields: [...SETTLEMENT_ASSET_ONLY_RESPONSE_FIELDS]
        });
        expect((evidence.responseEvidence as { supportedResponseClaims: string[] }).supportedResponseClaims).not.toEqual(
          expect.arrayContaining([...scenario.forbiddenClaims])
        );

        const responseEvidence = primaryResponseEvidence(evidence);
        expect(Object.keys(responseEvidence)).toEqual([...SETTLEMENT_ASSET_ONLY_RESPONSE_FIELDS]);
        expect(JSON.stringify(responseEvidence)).not.toMatch(/\b(?:USDC|USDT|WUSDC|WUSDT)\b/);
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    }
  );

  it("keeps quote detours out of the MCP payment coverage conclusion", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    if (!usdc) {
      throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }
    const usdcScalar = usdc.scalar;
    if (usdcScalar === undefined) {
      throw new Error("USDC scalar fixture is missing from pinned DeepBook mainnetCoins");
    }
    const usdcDecimals = decimalsFromScalar(usdcScalar as number);
    if (usdcDecimals === undefined) {
      throw new Error("USDC scalar fixture does not resolve to display decimals");
    }
    const { client, server } = await connectReplayClient(createQuoteDetourReadService());
    try {
      const statusPayload = textPayload(await client.callTool({ name: TOOL_NAMES.readGetServerStatus }));
      expect(statusPayload).toMatchObject({ ok: true });

      const assetGroupsPayload = textPayload(await client.callTool({ name: TOOL_NAMES.readListSettlementAssetGroups }));
      expect(assetGroupsPayload).toMatchObject({ ok: true, data: { status: "ok" } });

      const evidencePayload = textPayload(
        await client.callTool({
          name: TOOL_NAMES.readPreviewIntentEvidence,
          arguments: {
            account: accountAddress,
            intentKind: "cover_payment_like_amount",
            denomination: "dollar",
            requiredDisplayAmount: "1000"
          }
        })
      );
      expect(evidencePayload).toMatchObject({ ok: true });

      const suiQuotePayload = textPayload(
        await client.callTool({
          name: TOOL_NAMES.readQuoteDeepbookDisplayAmount,
          arguments: {
            poolKey: "SUI_USDC",
            direction: "base_to_quote",
            amountDisplay: "148.62682544"
          }
        })
      );
      const nsQuotePayload = textPayload(
        await client.callTool({
          name: TOOL_NAMES.readQuoteDeepbookDisplayAmount,
          arguments: {
            poolKey: "NS_USDC",
            direction: "base_to_quote",
            amountDisplay: "254.98475"
          }
        })
      );
      expect(suiQuotePayload).toMatchObject({ ok: true });
      expect(nsQuotePayload).toMatchObject({ ok: true });

      const evidence = evidencePayload.data as Record<string, unknown>;
      const responseSummary = evidence.responseSummary as Record<string, unknown>;
      const suiQuote = suiQuotePayload.data as Record<string, unknown>;
      const nsQuote = nsQuotePayload.data as Record<string, unknown>;

      expect(responseSummary).toMatchObject({
        conclusionKind: "shortfall_in_settlement_asset_balance",
        answerCompleteness: {
          answerCompleteFor: "settlement_asset_group_answer",
          requiredAnswerFields: ["responseSummary"],
          notCompleteFor: expect.arrayContaining(["selected_target_context", "route_dependent_payment_support"])
        },
        doNotCallQuoteToolsForThisQuestion: true,
        currentDisplayAmount: "278.890119",
        requiredDisplayAmount: "1000",
        shortfallDisplayAmount: "721.109881",
        amountsUsedForAnswer: {
          currentDisplayAmount: "current_wallet_balance_in_settlement_asset_group",
          requiredDisplayAmount: "amount_requested_by_user",
          shortfallDisplayAmount: "required_amount_minus_current_settlement_asset_balance"
        },
        separateQuoteOutputs: {
          usedForPaymentAnswer: false,
          usedForShortfallAnswer: false,
          reason: "separate_quote_tool_outputs_are_price_estimates_only",
          paymentAnswerField: "responseSummary"
        },
        doNotUseForConclusion: [
          "separate_quote_tool_results",
          "assets_outside_settlement_group",
          "route_dependent_payment_support"
        ]
      });
      expect(suiQuote.quantitySemantics).toMatchObject({
        requiresIntentEvidenceForCoverage: true,
        canUseForPaymentAnswer: false,
        canUseForShortfallAnswer: false,
        doNotCombineWithPaymentAnswer: true,
        requiredPaymentAnswerTool: "read_preview_intent_evidence",
        paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
        requiredPaymentAnswerField: "responseSummary"
      });
      expect(suiQuote.userAnswerUse).toMatchObject({
        cannotAnswer: expect.arrayContaining(["payment_coverage", "payment_shortfall"]),
        answerFields: expect.arrayContaining(["quote.quoteOut", "rawQuote.directionalOutput"]),
        followUp: {
          tool: TOOL_NAMES.readPreviewIntentEvidence,
          answerFields: ["responseSummary"]
        }
      });
      expect(nsQuote.quantitySemantics).toMatchObject({
        requiresIntentEvidenceForCoverage: true,
        canUseForPaymentAnswer: false,
        canUseForShortfallAnswer: false,
        doNotCombineWithPaymentAnswer: true,
        requiredPaymentAnswerTool: "read_preview_intent_evidence",
        paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
        requiredPaymentAnswerField: "responseSummary"
      });
      expect(nsQuote.userAnswerUse).toMatchObject({
        cannotAnswer: expect.arrayContaining(["payment_coverage", "payment_shortfall"]),
        followUp: {
          tool: TOOL_NAMES.readPreviewIntentEvidence,
          answerFields: ["responseSummary"]
        }
      });

      const quoteOutRaw =
        BigInt(getQuoteDirectionalOutputRaw(suiQuote)) + BigInt(getQuoteDirectionalOutputRaw(nsQuote));
      const shortfallIfQuoteOutputsWereIncorrectlyAddedRaw = 1000000000n - 278890119n - quoteOutRaw;
      const shortfallIfQuoteOutputsWereIncorrectlyAddedDisplay = formatRawAmount(
        shortfallIfQuoteOutputsWereIncorrectlyAddedRaw.toString(),
        usdcDecimals
      );

      expect(shortfallIfQuoteOutputsWereIncorrectlyAddedDisplay).toBe("569.01226");
      expect(shortfallIfQuoteOutputsWereIncorrectlyAddedDisplay).not.toBe(responseSummary.shortfallDisplayAmount);

      const finalAnswerFixture = {
        currentSettlementAssetDisplayAmount: responseSummary.currentDisplayAmount,
        requiredDisplayAmount: responseSummary.requiredDisplayAmount,
        shortfallDisplayAmount: responseSummary.shortfallDisplayAmount,
        separateQuoteOutputs: responseSummary.separateQuoteOutputs
      };
      expect(finalAnswerFixture).toEqual({
        currentSettlementAssetDisplayAmount: "278.890119",
        requiredDisplayAmount: "1000",
        shortfallDisplayAmount: "721.109881",
        separateQuoteOutputs: {
          usedForPaymentAnswer: false,
          usedForShortfallAnswer: false,
          reason: "separate_quote_tool_outputs_are_price_estimates_only",
          paymentAnswerField: "responseSummary"
        }
      });
      const allowedFinalAnswer = [
        `USD settlement-asset basis current ${String(finalAnswerFixture.currentSettlementAssetDisplayAmount)}.`,
        `Required amount ${String(finalAnswerFixture.requiredDisplayAmount)}.`,
        `Shortfall ${String(finalAnswerFixture.shortfallDisplayAmount)}.`,
        "Separate SUI/NS quote outputs are price references only and are not included in this payment conclusion."
      ].join(" ");
      expect(forbiddenQuoteDetourFinalAnswerFragments(allowedFinalAnswer)).toEqual([]);
      expect(allowedFinalAnswer).not.toContain("148.641608");
      expect(allowedFinalAnswer).not.toContain("3.456013");
      expect(allowedFinalAnswer).not.toContain("569.01226");

      const forbiddenFinalAnswers = [
        "\uCC38\uACE0 \uACAC\uC801\uC744 \uBCF4\uBA74 \uB2E4\uB978 \uC790\uC0B0\uAE4C\uC9C0 \uAC10\uC548\uD574\uB3C4 $1,000\uC5D0\uB294 \uBAA8\uC790\uB78D\uB2C8\uB2E4.",
        "SUI\uC640 NS\uB97C \uC804\uBD80 \uBC14\uAFB8\uBA74 \uBD80\uC871\uBD84\uC740 569.01226\uC785\uB2C8\uB2E4.",
        "\uACAC\uC801 \uCD9C\uB825\uC744 \uD569\uC0B0 \uAC00\uB2A5\uD558\uB2E4\uACE0 \uBCF4\uBA74 \uADF8\uB798\uB3C4 \uBD80\uC871\uD569\uB2C8\uB2E4."
      ];
      for (const answer of forbiddenFinalAnswers) {
        expect(forbiddenQuoteDetourFinalAnswerFragments(answer).length).toBeGreaterThan(0);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("requires user selection provenance before replaying selected target evidence", async () => {
    const { client, server } = await connectScenarioClient("400000000");
    try {
      const statusPayload = textPayload(await client.callTool({ name: TOOL_NAMES.readGetServerStatus }));
      expect(statusPayload).toMatchObject({ ok: true });

      const assetGroupsPayload = textPayload(await client.callTool({ name: TOOL_NAMES.readListSettlementAssetGroups }));
      expect(assetGroupsPayload).toMatchObject({ ok: true, data: { status: "ok" } });

      const inferredTargetPayload = textPayload(
        await client.callTool({
          name: TOOL_NAMES.readPreviewIntentEvidence,
          arguments: {
            account: accountAddress,
            intentKind: "cover_payment_like_amount",
            denomination: "dollar",
            requiredDisplayAmount: "1000",
            targetAssetSymbol: "USDC"
          }
        })
      );
      expect(inferredTargetPayload).toMatchObject({
        ok: false,
        error: {
          kind: "input_invalid",
          details: { field: "targetAssetSelectionSource", requiredWith: "targetAssetSymbol" }
        }
      });

      const selectedTargetPayload = textPayload(
        await client.callTool({
          name: TOOL_NAMES.readPreviewIntentEvidence,
          arguments: {
            account: accountAddress,
            intentKind: "cover_payment_like_amount",
            denomination: "dollar",
            requiredDisplayAmount: "1000",
            targetAssetSymbol: "USDC",
            targetAssetSelectionSource: "user_explicit"
          }
        })
      );
      expect(selectedTargetPayload).toMatchObject({
        ok: true,
        data: {
          intent: {
            targetAssetSymbol: "USDC",
            targetAssetSelectionSource: "user_explicit"
          },
          selectedTarget: {
            symbol: "USDC",
            selectionSource: "user_explicit",
            shortfallDisplayAmount: "600"
          },
          responseEvidence: {
            mode: "selected_target_context",
            primaryEvidenceFields: expect.arrayContaining(["responseSummary", "selectedTarget"]),
            supportedResponseClaims: expect.arrayContaining(["selected_target_shortfall"])
          },
          unsupportedClaims: expect.arrayContaining(["route_dependent_payment_support", "signing_readiness"])
        }
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
