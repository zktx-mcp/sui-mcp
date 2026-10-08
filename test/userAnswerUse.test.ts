import { describe, expect, it } from "vitest";
import type { UserAnswerUse } from "../src/core/evidence/userAnswerUse.js";
import type { IntentEvidenceResponseEvidence } from "../src/core/read/readServiceTypes.js";
import {
  deepbookAccountInventoryUserAnswerUse,
  deepbookMidPriceUserAnswerUse,
  deepbookOrderbookUserAnswerUse,
  deepbookQuoteUserAnswerUse,
  intentEvidenceUserAnswerUse,
  settlementAssetGroupParityUserAnswerUse,
  walletBalanceUserAnswerUse,
  walletClassificationUserAnswerUse
} from "../src/core/read/readResponseGuidance.js";
import {
  inspectSuiTransactionUserAnswerUse,
  liveSuiActivityUserAnswerUse,
  storedSuiActivityUserAnswerUse,
  transactionDetailAvailability
} from "../src/mcp/tools/read/transactionActivityOutput.js";
import {
  executionResultUserAnswerUse,
  interactionStatusUserAnswerUse,
  reviewActivityListUserAnswerUse,
  reviewFunnelUserAnswerUse,
  reviewSessionDetailUserAnswerUse,
  reviewStatusUserAnswerUse,
} from "../src/mcp/responseGuidance.js";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";

type GuidanceCase = {
  name: string;
  userAnswerUse: UserAnswerUse;
  sourceShape: unknown;
};

function objectHasPath(value: unknown, path: string): boolean {
  const segments = path.split(".");
  return hasPathSegments(value, segments);
}

function hasPathSegments(value: unknown, segments: string[]): boolean {
  if (segments.length === 0) {
    return true;
  }
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    return true;
  }

  if (segment.endsWith("[]")) {
    const key = segment.slice(0, -2);
    if (!isRecord(value) || !(key in value) || !Array.isArray(value[key])) {
      return false;
    }
    const items = value[key];
    if (rest.length === 0 || items.length === 0) {
      return true;
    }
    return items.every((item) => hasPathSegments(item, rest));
  }

  if (!isRecord(value) || !(segment in value)) {
    return false;
  }
  return hasPathSegments(value[segment], rest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectPathsToExist(label: string, shape: unknown, paths: string[]): void {
  for (const path of paths) {
    expect(objectHasPath(shape, path), `${label} references missing field ${path}`).toBe(true);
  }
}

const intentEvidenceShape = {
  responseSummary: {
    conclusionKind: "shortfall_in_settlement_asset_balance",
    answerCompleteness: {
      answerCompleteFor: "settlement_asset_group_answer",
      requiredAnswerFields: [],
      notCompleteFor: []
    },
    currentDisplayAmount: "0",
    requiredDisplayAmount: "1000",
    shortfallDisplayAmount: "1000",
    amountsUsedForAnswer: [],
    doNotCallQuoteToolsForThisQuestion: true,
    separateQuoteOutputs: {},
    requiredUserChoices: [],
    doNotUseForConclusion: [],
    excludedFromConclusion: []
  },
  evidenceSources: {},
  quantitySemantics: {},
  settlementAssetGroup: {},
  balances: [],
  aggregate: {},
  selectedTarget: {
    selectionSource: "user_explicit",
    currentDisplayAmount: "0",
    shortfallDisplayAmount: "1000"
  },
  candidateConversions: [],
  blockedReasons: [],
  unsupportedClaims: [],
  uninspectedAssetClasses: []
};

const unavailableIntentEvidenceShape = {
  ...intentEvidenceShape,
  responseSummary: {
    ...intentEvidenceShape.responseSummary,
    conclusionKind: "settlement_asset_coverage_unavailable",
    currentDisplayAmount: null,
    shortfallDisplayAmount: null,
    unavailableReason: "wallet_balance_page_limit_exceeded"
  }
};

const selectedTargetQuotedResponseEvidence: IntentEvidenceResponseEvidence = {
  mode: "selected_target_context",
  primaryEvidenceFields: ["responseSummary", "selectedTarget", "candidateConversions", "requiredUserChoices"],
  supportedResponseClaims: [
    "settlement_asset_coverage_status",
    "settlement_asset_shortfall",
    "selected_target_shortfall",
    "direct_pool_quote_evidence",
    "required_user_choices",
    "unsupported_inferences"
  ]
};

const selectedTargetNoQuoteResponseEvidence: IntentEvidenceResponseEvidence = {
  ...selectedTargetQuotedResponseEvidence,
  supportedResponseClaims: selectedTargetQuotedResponseEvidence.supportedResponseClaims.filter(
    (claim) => claim !== "direct_pool_quote_evidence"
  )
};

const followUpResponseShapes: Record<string, unknown> = {
  [TOOL_NAMES.readPreviewIntentEvidence]: intentEvidenceShape,
  [TOOL_NAMES.readQuoteDeepbookDisplayAmount]: { quote: {} },
  [TOOL_NAMES.readSummarizeWalletAssets]: { balances: [] },
  [TOOL_NAMES.readGetReviewSessionDetail]: {
    session: {},
    planJson: {},
    intentJson: {},
    stateSnapshots: [],
    transitions: [],
    requests: [], requestCount: 0
  },
  [TOOL_NAMES.sessionGetReviewStatus]: {
    status: "proposed",
    pollingStatus: "pending",
    statusCategory: "non_terminal",
    reviewState: {}
  },
  [TOOL_NAMES.readInspectSuiTransaction]: {
    transaction: {}
  },
  [TOOL_NAMES.readSummarizeSuiActivityScan]: {
    requestedAccountTransactionFacts: [],
    analysis: {}
  },
  [TOOL_NAMES.sessionGetExecutionResult]: {
    executionResult: {}
  },
  [TOOL_NAMES.sessionWaitWalletConnection]: {
    status: "connected",
    account: "0x1",
    chain: "sui:mainnet",
    waitOutcome: "status_reached"
  },
  [TOOL_NAMES.accountGetActiveAccount]: {
    status: "set",
    account: "0x1",
    boundary: "read_context_only_not_signing_authorization"
  }
};

const quoteQuantitySemanticsShape = {
  canUseForPaymentAnswer: false,
  canUseForShortfallAnswer: false,
  doNotCombineWithPaymentAnswer: true,
  requiredPaymentAnswerTool: "read.preview_intent_evidence",
  requiredPaymentAnswerField: "responseSummary",
  paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer"
};

function expectGuidanceToBeSelfContained(
  label: string,
  userAnswerUse: UserAnswerUse,
  expected: {
    canAnswer: string;
    cannotAnswer: string;
    answerField: string;
    diagnosticOnlyField?: string;
    followUpTool?: string;
    followUpAnswerField?: string;
  }
): void {
  expect(userAnswerUse.canAnswer, `${label}.canAnswer`).toContain(expected.canAnswer);
  expect(userAnswerUse.cannotAnswer, `${label}.cannotAnswer`).toContain(expected.cannotAnswer);
  expect(userAnswerUse.answerFields, `${label}.answerFields`).toContain(expected.answerField);
  if (expected.diagnosticOnlyField !== undefined) {
    expect(userAnswerUse.diagnosticOnlyFields ?? [], `${label}.diagnosticOnlyFields`).toContain(
      expected.diagnosticOnlyField
    );
  }
  if (expected.followUpTool !== undefined) {
    expect(userAnswerUse.followUp?.tool, `${label}.followUp.tool`).toBe(expected.followUpTool);
    if (expected.followUpAnswerField !== undefined) {
      expect(userAnswerUse.followUp?.answerFields ?? [], `${label}.followUp.answerFields`).toContain(
        expected.followUpAnswerField
      );
    }
  }
}

describe("userAnswerUse field references", () => {
  it("keeps high-risk response guidance self-contained for copied API responses", () => {
    const cases: Array<{
      label: string;
      userAnswerUse: UserAnswerUse;
      expected: Parameters<typeof expectGuidanceToBeSelfContained>[2];
    }> = [
      {
        label: "interaction status",
        userAnswerUse: interactionStatusUserAnswerUse(),
        expected: {
          canAnswer: "connection_qualified_default_asset_account",
          cannotAnswer: "transaction_execution_result",
          answerField: "activeAccount",
          diagnosticOnlyField: "pendingReviewSessions.truncated",
          followUpTool: TOOL_NAMES.sessionGetReviewStatus,
          followUpAnswerField: "reviewState"
        }
      },
      {
        label: "execution polling",
        userAnswerUse: executionResultUserAnswerUse(),
        expected: {
          canAnswer: "current_local_execution_polling_status",
          cannotAnswer: "transaction_execution_guarantee",
          answerField: "statusCategory",
          followUpTool: TOOL_NAMES.sessionGetReviewStatus,
          followUpAnswerField: "reviewState"
        }
      },
      {
        label: "intent evidence",
        userAnswerUse: intentEvidenceUserAnswerUse(),
        expected: {
          canAnswer: "usd_denominated_payment_shortfall",
          cannotAnswer: "settlement_token_selection",
          answerField: "responseSummary",
          diagnosticOnlyField: "evidenceSources"
        }
      },
      {
        label: "DeepBook quote",
        userAnswerUse: deepbookQuoteUserAnswerUse("display"),
        expected: {
          canAnswer: "indicative_deepbook_pool_quote_for_explicit_source_input",
          cannotAnswer: "payment_coverage",
          answerField: "quote.quoteOut",
          diagnosticOnlyField: "source",
          followUpTool: TOOL_NAMES.readPreviewIntentEvidence,
          followUpAnswerField: "responseSummary"
        }
      },
      {
        label: "wallet balance",
        userAnswerUse: walletBalanceUserAnswerUse(),
        expected: {
          canAnswer: "current_coin_balance_snapshot",
          cannotAnswer: "payment_coverage_or_shortfall",
          answerField: "balances[].balance",
          diagnosticOnlyField: "source",
          followUpTool: TOOL_NAMES.readPreviewIntentEvidence,
          followUpAnswerField: "responseSummary"
        }
      },
      {
        label: "wallet classification",
        userAnswerUse: walletClassificationUserAnswerUse(),
        expected: {
          canAnswer: "current_coin_balance_classification",
          cannotAnswer: "complete_portfolio_inventory",
          answerField: "classifiedAssets[].classification",
          diagnosticOnlyField: "source",
          followUpTool: TOOL_NAMES.readPreviewIntentEvidence,
          followUpAnswerField: "responseSummary"
        }
      },
      {
        label: "inspect transaction",
        userAnswerUse: inspectSuiTransactionUserAnswerUse({
          hasSender: true,
          hasRequestedAccountEffect: true,
          hasDetails: true
        }),
        expected: {
          canAnswer: "one_sui_transaction_digest_status_and_context",
          cannotAnswer: "complete_wallet_history",
          answerField: "transaction.digest",
          diagnosticOnlyField: "source"
        }
      },
      {
        label: "live activity",
        userAnswerUse: liveSuiActivityUserAnswerUse(true),
        expected: {
          canAnswer: "bounded_requested_account_activity_page",
          cannotAnswer: "complete_wallet_history",
          answerField: "requestedAccountTransactionFacts",
          diagnosticOnlyField: "source",
          followUpTool: TOOL_NAMES.readInspectSuiTransaction,
          followUpAnswerField: "transaction"
        }
      },
      {
        label: "stored activity",
        userAnswerUse: storedSuiActivityUserAnswerUse("all"),
        expected: {
          canAnswer: "stored_local_normalized_activity_summary_for_the_selected_account",
          cannotAnswer: "profit_or_pnl",
          answerField: "summary",
          diagnosticOnlyField: "source",
          followUpTool: TOOL_NAMES.readSummarizeSuiActivityScan,
          followUpAnswerField: "analysis"
        }
      }
    ];

    for (const item of cases) {
      expectGuidanceToBeSelfContained(item.label, item.userAnswerUse, item.expected);
    }
  });

  it("points answer fields to fields present in the same response and follow-up fields to the follow-up response", () => {
    const cases: GuidanceCase[] = [
      {
        name: "wallet balance",
        userAnswerUse: walletBalanceUserAnswerUse(),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          balances: [{ coinType: "0x2::sui::SUI", balance: "1", unit: {}, display: {} }],
          source: {},
          quantitySemantics: {},
          hasNextPage: false,
          cursor: null
        }
      },
      {
        name: "wallet classification",
        userAnswerUse: walletClassificationUserAnswerUse(),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          classifiedAssets: [{ balance: {}, classification: {} }],
          uninspectedAssetClasses: [],
          source: {},
          quantitySemantics: {},
          hasNextPage: false,
          cursor: null
        }
      },
      {
        name: "settlement asset group parity",
        userAnswerUse: settlementAssetGroupParityUserAnswerUse(),
        sourceShape: {
          responseSummary: {
            min: {},
            max: {},
            mean: {},
            median: {},
            referenceAssetRole: "measurement_reference",
            excludedFromConclusion: []
          },
          fetchedAt: "2026-05-11T00:00:00.000Z",
          assets: [],
          statistics: {},
          evidenceSources: {},
          quantitySemantics: {},
          unsupportedClaims: []
        }
      },
      { name: "intent evidence", userAnswerUse: intentEvidenceUserAnswerUse(), sourceShape: intentEvidenceShape },
      {
        name: "selected target intent evidence",
        userAnswerUse: intentEvidenceUserAnswerUse(
          "shortfall_in_settlement_asset_balance",
          selectedTargetQuotedResponseEvidence
        ),
        sourceShape: {
          ...intentEvidenceShape,
          candidateConversions: [
            {
              sourceSymbol: "WUSDT",
              targetSymbol: "USDC",
              sourceDisplayAmount: "2",
              status: "quoted"
            }
          ],
          requiredUserChoices: []
        }
      },
      {
        name: "unavailable intent evidence",
        userAnswerUse: intentEvidenceUserAnswerUse("unavailable_wallet_balance_scan_incomplete"),
        sourceShape: unavailableIntentEvidenceShape
      },
      {
        name: "DeepBook orderbook",
        userAnswerUse: deepbookOrderbookUserAnswerUse(),
        sourceShape: {
          poolKey: "SUI_USDC",
          ticks: 5,
          fetchedAt: "2026-05-11T00:00:00.000Z",
          midPrice: 1,
          poolBookParams: {},
          level2TicksFromMid: [],
          source: {}
        }
      },
      {
        name: "DeepBook mid price",
        userAnswerUse: deepbookMidPriceUserAnswerUse(),
        sourceShape: {
          poolKey: "SUI_USDC",
          base: "SUI",
          quote: "USDC",
          price: 1,
          priceDirection: "quote_per_base",
          priceType: "deepbook_mid_price",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          source: {},
          priceSemantics: {}
        }
      },
      {
        name: "DeepBook raw quote",
        userAnswerUse: deepbookQuoteUserAnswerUse("raw"),
        sourceShape: {
          poolKey: "SUI_USDC",
          direction: "base_to_quote",
          amountRaw: "1000",
          quote: { baseOut: "0", quoteOut: "1", deepRequired: "0" },
          rawQuote: { directionalOutput: {}, returnValueOrder: [], boundary: {} },
          fetchedAt: "2026-05-11T00:00:00.000Z",
          source: {},
          quantitySemantics: quoteQuantitySemanticsShape
        }
      },
      {
        name: "DeepBook display quote",
        userAnswerUse: deepbookQuoteUserAnswerUse("display"),
        sourceShape: {
          pool: {},
          direction: "base_to_quote",
          inputAmount: {},
          quote: { baseOut: "0", quoteOut: "1", deepRequired: "0" },
          rawQuote: { directionalOutput: {}, returnValueOrder: [], boundary: {} },
          fetchedAt: "2026-05-11T00:00:00.000Z",
          source: {},
          quantitySemantics: quoteQuantitySemanticsShape
        }
      },
      {
        name: "DeepBook inventory discovery",
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("manager_discovery_only"),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          detailStatus: "manager_discovery_only",
          managerAddresses: [],
          requested: {},
          source: {},
          quantitySemantics: {}
        }
      },
      {
        name: "DeepBook inventory missing pool",
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("pool_key_required"),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          detailStatus: "pool_key_required",
          managerAddresses: [],
          requested: { managerAddress: "0x2" },
          source: {},
          quantitySemantics: {}
        }
      },
      {
        name: "DeepBook inventory missing manager",
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("manager_address_required"),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          detailStatus: "manager_address_required",
          managerAddresses: [],
          requested: { poolKey: "SUI_USDC" },
          pool: {},
          source: {},
          quantitySemantics: {}
        }
      },
      {
        name: "DeepBook inventory undiscovered manager",
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("manager_address_not_discovered_for_active_account"),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          detailStatus: "manager_address_not_discovered_for_active_account",
          managerAddresses: [],
          requested: { poolKey: "SUI_USDC", managerAddress: "0x2" },
          pool: {},
          source: {},
          quantitySemantics: {}
        }
      },
      {
        name: "DeepBook inventory missing pool account",
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("account_not_found"),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          detailStatus: "account_not_found",
          managerAddresses: [],
          requested: { poolKey: "SUI_USDC", managerAddress: "0x2" },
          pool: {},
          accountExists: false,
          source: {},
          quantitySemantics: {}
        }
      },
      {
        name: "DeepBook inventory detail",
        userAnswerUse: deepbookAccountInventoryUserAnswerUse("available"),
        sourceShape: {
          account: "0x1",
          fetchedAt: "2026-05-11T00:00:00.000Z",
          detailStatus: "available",
          managerAddresses: [],
          requested: {},
          pool: {},
          accountExists: true,
          accountSummary: {},
          lockedBalances: {},
          openOrderIds: [],
          openOrderCount: 0,
          source: {},
          quantitySemantics: {},
          openOrderIdsTruncated: false
        }
      },
      {
        name: "interaction status",
        userAnswerUse: interactionStatusUserAnswerUse(),
        sourceShape: {
          walletAvailability: { status: "available" }, progress: { status: "idle" },
          activeAccount: { status: "none" }, connections: [], manageableConnectionIds: [], assetReadAccount: { status: "address_required" },
          pendingWalletConnections: { limit: 5, items: [], truncated: false },
          pendingReviewSessions: { limit: 5, items: [{ reviewSessionId: "review_1" }], truncated: false }
        }
      },
      {
        name: "execution polling without result",
        userAnswerUse: executionResultUserAnswerUse(),
        sourceShape: {
          walletAvailability: { status: "available" }, progress: { status: "idle" },
          reviewSessionId: "review_1",
          status: "blocked",
          statusCategory: "user_action_required",
          lastActivityAt: "2026-05-11T00:00:00.000Z",
          pollingStatus: "blocked",
          pollingHint: {
            finalStatuses: [],
            userActionRequiredStatuses: [],
            nonTerminalStatuses: []
          }
        }
      },
      {
        name: "execution polling with result",
        userAnswerUse: executionResultUserAnswerUse({ hasExecutionResult: true, hasWaitOutcome: true }),
        sourceShape: {
          walletAvailability: { status: "available" }, progress: { status: "idle" },
          waitOutcome: "status_reached",
          reviewSessionId: "review_1",
          status: "ready_for_wallet_review",
          statusCategory: "final",
          lastActivityAt: "2026-05-11T00:00:00.000Z",
          pollingStatus: "completed",
          pollingHint: {
            finalStatuses: [],
            userActionRequiredStatuses: [],
            nonTerminalStatuses: []
          },
          executionResult: {}
        }
      },
      {
        name: "review status without review state",
        userAnswerUse: reviewStatusUserAnswerUse(false),
        sourceShape: {
          walletAvailability: { status: "available" }, progress: { status: "idle" },
          reviewSessionId: "review_1",
          status: "proposed",
          pollingStatus: "pending",
          statusCategory: "non_terminal",
          lastActivityAt: "2026-05-11T00:00:00.000Z"
        }
      },
      {
        name: "review status with review state",
        userAnswerUse: reviewStatusUserAnswerUse(true, true),
        sourceShape: {
          walletAvailability: { status: "available" }, progress: { status: "idle" },
          reviewSessionId: "review_1",
          status: "ready_for_wallet_review",
          pollingStatus: "awaiting_signature",
          statusCategory: "non_terminal",
          reviewState: {
            status: "ready_for_wallet_review",
            checks: [],
            adapterLifecycle: {
              stageCatalogId: "deepbook_swap_review_v1",
              completedStages: [],
              missingStages: []
            },
            blockedReason: null,
            refreshReason: null
          },
          lastActivityAt: "2026-05-11T00:00:00.000Z"
        }
      },
      {
        name: "review activity list",
        userAnswerUse: reviewActivityListUserAnswerUse(),
        sourceShape: {
          activities: [{ reviewSessionId: "review_1", reviewStatus: "ready_for_wallet_review", updatedAt: "2026-05-11T00:00:00.000Z" }],
          dataScope: {},
          accountSource: "active_account_context",
          lowSampleWarning: false,
          lowSampleThreshold: 5,
          truncated: false
        }
      },
      {
        name: "review funnel",
        userAnswerUse: reviewFunnelUserAnswerUse(),
        sourceShape: {
          summary: {},
          dataScope: {},
          accountSource: "active_account_context",
          lowSampleWarning: false,
          lowSampleThreshold: 5,
          truncated: false
        }
      },
      {
        name: "review session detail",
        userAnswerUse: reviewSessionDetailUserAnswerUse({ hasCurrentRequest: true, hasCurrentExecution: true, hasHistoricalExecution: true }),
        sourceShape: {
          session: { reviewSessionId: "review_1" },
          planJson: {},
          intentJson: {},
          stateSnapshots: [],
          transitions: [],
          request: { execution: {} }, requestCount: 1, requests: [{ execution: {} }],
          dataScope: {},
          accountSource: "active_account_context",
          lowSampleWarning: false,
          lowSampleThreshold: 5,
          truncated: false
        }
      },
      {
        name: "inspect Sui transaction",
        userAnswerUse: inspectSuiTransactionUserAnswerUse({
          hasSender: true,
          hasRequestedAccountEffect: true,
          hasDetails: true
        }),
        sourceShape: {
          transaction: {
            digest: "digest",
            status: "success",
            sender: "0x1",
            requestedAccountEffect: {},
            compact: {},
            details: {}
          },
          fetchedAt: "2026-05-11T00:00:00.000Z",
          source: {},
          quantitySemantics: {},
          persistence: {}
        }
      },
      {
        name: "live Sui activity",
        userAnswerUse: liveSuiActivityUserAnswerUse(true),
        sourceShape: {
          requestedAccount: {},
          requestedAccountTransactionFacts: [{ requestedAccountEffect: {}, accountCoinFlows: [] }],
          transactionDetailAvailability: {
            totalTransactions: 1,
            withDetails: 1,
            withoutDetails: 0,
            detailAvailability: "all",
            allReturnedTransactionsHaveDetails: true
          },
          transactions: [{ transactionContext: {}, detailLookup: { digest: "digest" } }],
          analysis: {},
          fetchedAt: "2026-05-11T00:00:00.000Z",
          source: {},
          quantitySemantics: {},
          persistence: {},
          hasMore: false,
          continuationCursor: null,
          windowComplete: true,
          orderingVerified: true,
          incompleteReason: null
        }
      },
      {
        name: "stored Sui activity",
        userAnswerUse: storedSuiActivityUserAnswerUse("all"),
        sourceShape: {
          summary: {},
          analysis: {},
          transactionDetailAvailability: {
            totalTransactions: 1,
            withDetails: 1,
            withoutDetails: 0,
            detailAvailability: "all",
            allReturnedTransactionsHaveDetails: true
          },
          transactions: [{ compact: {}, details: {} }],
          dataScope: { account: "0x1" },
          accountSource: "active_account_context",
          lowSampleWarning: false,
          lowSampleThreshold: 5,
          truncated: false,
          source: {},
          quantitySemantics: {}
        }
      }
    ];

    for (const item of cases) {
      expectPathsToExist(`${item.name}.answerFields`, item.sourceShape, item.userAnswerUse.answerFields);
      expectPathsToExist(
        `${item.name}.preconditionFields`,
        item.sourceShape,
        item.userAnswerUse.preconditionFields ?? []
      );
      expectPathsToExist(
        `${item.name}.conclusionRuleFields`,
        item.sourceShape,
        item.userAnswerUse.conclusionRuleFields ?? []
      );
      expectPathsToExist(`${item.name}.diagnosticOnlyFields`, item.sourceShape, item.userAnswerUse.diagnosticOnlyFields ?? []);
      const answerFields = new Set(item.userAnswerUse.answerFields);
      const conclusionRuleFields = new Set(item.userAnswerUse.conclusionRuleFields ?? []);
      const preconditionFields = new Set(item.userAnswerUse.preconditionFields ?? []);
      const diagnosticOnlyFields = new Set(item.userAnswerUse.diagnosticOnlyFields ?? []);
      for (const field of conclusionRuleFields) {
        expect(diagnosticOnlyFields.has(field), `${item.name} marks conclusion rule ${field} as diagnostic`).toBe(false);
      }
      for (const field of preconditionFields) {
        expect(diagnosticOnlyFields.has(field), `${item.name} marks precondition ${field} as diagnostic`).toBe(false);
      }
      for (const field of answerFields) {
        expect(diagnosticOnlyFields.has(field), `${item.name} marks answer field ${field} as diagnostic`).toBe(false);
      }
      if (item.userAnswerUse.followUp) {
        expectPathsToExist(`${item.name}.followUp.inputFields`, item.sourceShape, item.userAnswerUse.followUp.inputFields ?? []);
        const followUpShape = followUpResponseShapes[item.userAnswerUse.followUp.tool];
        expect(followUpShape, `${item.name} uses unknown follow-up tool ${item.userAnswerUse.followUp.tool}`).toBeDefined();
        expectPathsToExist(
          `${item.name}.followUp.answerFields`,
          followUpShape,
          item.userAnswerUse.followUp.answerFields
        );
      }
    }
  });

  it("keeps conditional intent evidence claims aligned with returned response evidence", () => {
    const withQuote = intentEvidenceUserAnswerUse(
      "shortfall_in_settlement_asset_balance",
      selectedTargetQuotedResponseEvidence
    );
    expect(withQuote.canAnswer).toEqual(
      expect.arrayContaining(["selected_target_shortfall", "direct_pool_quote_evidence_for_user_selected_target"])
    );

    const withoutQuote = intentEvidenceUserAnswerUse(
      "shortfall_in_settlement_asset_balance",
      selectedTargetNoQuoteResponseEvidence
    );
    expect(withoutQuote.canAnswer).toEqual(expect.arrayContaining(["selected_target_shortfall"]));
    expect(withoutQuote.canAnswer).not.toEqual(
      expect.arrayContaining(["direct_pool_quote_evidence_for_user_selected_target"])
    );
    expect(selectedTargetNoQuoteResponseEvidence.supportedResponseClaims).not.toEqual(
      expect.arrayContaining(["direct_pool_quote_evidence"])
    );
  });

  it("keeps USD settlement balance totals on intent evidence responseSummary", () => {
    for (const guidance of [
      intentEvidenceUserAnswerUse(),
      intentEvidenceUserAnswerUse("unavailable_wallet_balance_scan_incomplete"),
      intentEvidenceUserAnswerUse("shortfall_in_settlement_asset_balance", selectedTargetQuotedResponseEvidence)
    ]) {
      expect(guidance.conclusionRuleFields).toEqual(
        expect.arrayContaining([
          "responseSummary.doNotCallQuoteToolsForThisQuestion",
          "responseSummary.separateQuoteOutputs",
          "responseSummary.doNotUseForConclusion",
          "responseSummary.excludedFromConclusion",
          "unsupportedClaims"
        ])
      );
    }

    expect(walletBalanceUserAnswerUse().cannotAnswer).toEqual(
      expect.arrayContaining([
        "payment_coverage_or_shortfall",
        "usd_denominated_settlement_asset_balance_total"
      ])
    );
    expect(walletClassificationUserAnswerUse().cannotAnswer).toEqual(
      expect.arrayContaining([
        "payment_coverage_or_shortfall",
        "usd_denominated_settlement_asset_balance_total"
      ])
    );
  });

  it("keeps DeepBook mid-price guidance out of transaction and signing claims", () => {
    const midPrice = deepbookMidPriceUserAnswerUse();

    expect(midPrice.canAnswer).toEqual(["deepbook_pool_mid_price_context"]);
    expect(midPrice.cannotAnswer).toEqual(
      expect.arrayContaining(["transaction_building", "signing_data_or_readiness"])
    );
  });

  it("keeps DeepBook account inventory claims aligned with detailStatus", () => {
    const unavailableStatuses = [
      "manager_discovery_only",
      "pool_key_required",
      "manager_address_required",
      "manager_address_not_discovered_for_active_account",
      "account_not_found"
    ] as const;

    for (const status of unavailableStatuses) {
      const guidance = deepbookAccountInventoryUserAnswerUse(status);
      expect(guidance.preconditionFields, status).toContain("detailStatus");
      expect(guidance.canAnswer, status).not.toContain(
        "deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"
      );
      expect(guidance.cannotAnswer, status).toContain(
        "deepbook_pool_account_inventory_when_detailStatus_is_not_available"
      );
      expect(guidance.answerFields, status).not.toEqual(
        expect.arrayContaining(["accountSummary", "lockedBalances", "openOrderIds", "openOrderCount"])
      );
      expect(guidance.diagnosticOnlyFields ?? [], status).not.toContain("openOrderIdsTruncated");
    }

    expect(deepbookAccountInventoryUserAnswerUse("account_not_found").canAnswer).toContain(
      "deepbook_pool_account_absence_when_pool_and_manager_are_supplied"
    );

    const available = deepbookAccountInventoryUserAnswerUse("available");
    expect(available.preconditionFields).toContain("detailStatus");
    expect(available.canAnswer).toContain("deepbook_pool_account_inventory_when_pool_and_manager_are_supplied");
    expect(available.cannotAnswer).not.toContain("deepbook_pool_account_inventory_when_detailStatus_is_not_available");
    expect(available.answerFields).toEqual(
      expect.arrayContaining(["accountSummary", "lockedBalances", "openOrderIds", "openOrderCount"])
    );
    expect(available.diagnosticOnlyFields ?? []).toContain("openOrderIdsTruncated");
  });

  it("omits optional answer fields from response-specific guidance when those fields are absent", () => {
    const reviewDetail = reviewSessionDetailUserAnswerUse({ hasCurrentRequest: false, hasCurrentExecution: false, hasHistoricalExecution: false });
    expect(reviewDetail.canAnswer).not.toEqual(expect.arrayContaining(["stored_review_execution_result"]));
    expect(reviewDetail.cannotAnswer).toEqual(
      expect.arrayContaining(["chain_execution_result_without_execution_field"])
    );
    expect(reviewDetail.answerFields).not.toEqual(expect.arrayContaining(["request.execution", "requests[].execution"]));

    const transaction = inspectSuiTransactionUserAnswerUse({
      hasSender: false,
      hasRequestedAccountEffect: false,
      hasDetails: false
    });
    expect(transaction.canAnswer).not.toEqual(
      expect.arrayContaining([
        "requested_account_balance_effect_for_this_digest",
        "transaction_level_move_call_object_event_gas_and_protocol_label_facts"
      ])
    );
    expect(transaction.cannotAnswer).toEqual(
      expect.arrayContaining([
        "requested_account_balance_effect_without_requestedAccountEffect_field",
        "transaction_level_move_call_object_event_gas_and_protocol_label_facts_without_details_field"
      ])
    );
    expect(transaction.answerFields).not.toEqual(
      expect.arrayContaining([
        "transaction.sender",
        "transaction.requestedAccountEffect",
        "transaction.compact",
        "transaction.details"
      ])
    );

    const liveActivity = liveSuiActivityUserAnswerUse({
      includeAnalysis: false,
      transactionDetailAvailability: "none"
    });
    expect(liveActivity.canAnswer).not.toEqual(
      expect.arrayContaining(["transaction_context_for_all_returned_rows"])
    );
    expect(liveActivity.cannotAnswer).toEqual(
      expect.arrayContaining(["transaction_context_for_all_returned_rows_without_all_details"])
    );
    expect(liveActivity.answerFields).not.toEqual(expect.arrayContaining(["transactions[].transactionContext"]));

    const storedActivity = storedSuiActivityUserAnswerUse("none");
    expect(storedActivity.canAnswer).not.toEqual(
      expect.arrayContaining(["stored_transaction_context_for_all_returned_rows"])
    );
    expect(storedActivity.cannotAnswer).toEqual(
      expect.arrayContaining(["stored_transaction_context_for_all_returned_rows_without_all_details"])
    );
    expect(storedActivity.answerFields).not.toEqual(
      expect.arrayContaining(["transactions[].compact", "transactions[].details"])
    );
  });

  it("does not advertise array item fields when only some returned rows have details", () => {
    const availability = transactionDetailAvailability([{ details: {} }, {}]);
    expect(availability).toEqual({
      totalTransactions: 2,
      withDetails: 1,
      withoutDetails: 1,
      detailAvailability: "some",
      allReturnedTransactionsHaveDetails: false
    });

    const storedActivity = storedSuiActivityUserAnswerUse(availability);
    expect(storedActivity.canAnswer).toEqual(
      expect.arrayContaining(["stored_transaction_context_for_some_returned_rows"])
    );
    expect(storedActivity.canAnswer).not.toEqual(
      expect.arrayContaining(["stored_transaction_context_for_all_returned_rows"])
    );
    expect(storedActivity.cannotAnswer).toEqual(
      expect.arrayContaining(["stored_transaction_context_for_all_returned_rows_without_all_details"])
    );
    expect(storedActivity.answerFields).toEqual(expect.arrayContaining(["transactionDetailAvailability"]));
    expect(storedActivity.answerFields).not.toEqual(
      expect.arrayContaining(["transactions[].compact", "transactions[].details"])
    );
    expect(storedActivity.conclusionRuleFields).toEqual(expect.arrayContaining(["transactionDetailAvailability"]));

    const liveActivity = liveSuiActivityUserAnswerUse({
      includeAnalysis: true,
      transactionDetailAvailability: availability
    });
    expect(liveActivity.canAnswer).toEqual(expect.arrayContaining(["transaction_context_for_some_returned_rows"]));
    expect(liveActivity.canAnswer).not.toEqual(expect.arrayContaining(["transaction_context_for_all_returned_rows"]));
    expect(liveActivity.answerFields).toEqual(expect.arrayContaining(["transactionDetailAvailability", "analysis"]));
    expect(liveActivity.answerFields).not.toEqual(expect.arrayContaining(["transactions[].transactionContext"]));
    expect(liveActivity.conclusionRuleFields).toEqual(expect.arrayContaining(["transactionDetailAvailability"]));
  });
});
