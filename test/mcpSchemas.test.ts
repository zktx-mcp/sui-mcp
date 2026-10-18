import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  actionPlanSchema,
  executionPollingStatusSchema,
  transactionExecutionSummarySchema,
  humanReadableReviewSummarySchema,
  reviewCheckSchema,
  reviewStateStructuralInvariantSchema
} from "../src/core/action/schemas.js";
import type { ActionPlan } from "../src/core/action/types.js";
import { INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES } from "../src/core/read/readServiceTypes.js";
import {
  DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGES,
  deepbookSwapReviewLifecycleSchema
} from "../src/adapters/deepbook/deepbookReviewLifecycle.js";
import { okToolResult } from "../src/mcp/result.js";
import { successOutputSchema } from "../src/mcp/schemas.js";
import { SUPPORTED_PROTOCOLS } from "../src/mcp/tools/read/index.js";
import { fetchedAtSchema, utcTimestampInputSchema } from "../src/mcp/tools/read/commonSchemas.js";

const plan: ActionPlan = {
  id: "plan_1",
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
      type: "swap",
      from: { symbol: "SUI", amountDisplay: "1" },
      to: { symbol: "USDC" },
      maxSlippageBps: 50
    }
  },
  createdAt: new Date(0).toISOString(),
  preliminaryChecks: [
    {
      id: "account_bound_review_required",
      label: "Account-bound review",
      status: "warning",
      message: "Account-bound review required",
      source: "adapter"
    }
  ]
};

const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function deepbookLifecycle(completedCount: number) {
  return deepbookSwapReviewLifecycleSchema.parse({
    stageCatalogId: "deepbook_swap_review_v1",
    adapterId: "deepbook-swap",
    protocol: "DeepBookV3",
    actionKind: "swap",
    completedStages: DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGES.slice(0, completedCount),
    missingStages: DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGES.slice(completedCount)
  });
}

function simulationSummary() {
  return {
    provider: "client.core.simulateTransaction" as const,
    checksEnabled: true,
    success: true,
    gasCostSummary: {
      computationCostRaw: "100",
      storageCostRaw: "50",
      storageRebateRaw: "20",
      nonRefundableStorageFeeRaw: "0"
    },
    balanceChanges: [
      {
        address: account,
        coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        amount: "-1000"
      }
    ],
    objectChanges: [
      {
        objectId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        inputState: "Exists",
        outputState: "ObjectWrite",
        idOperation: "None"
      }
    ]
  };
}

function humanReadableReviewSummary() {
  return humanReadableReviewSummarySchema.parse({
    kind: "swap_human_readable_review",
    proposedAction: {
      title: "Review swap",
      summary: "Review a swap",
      actionKind: "swap",
      adapterId: "deepbook-swap",
      protocol: "DeepBookV3",
      network: "sui:mainnet"
    },
    assetFlow: {
      outgoing: [{
        role: "input",
        symbol: "SUI",
        coinType: "0x2::sui::SUI",
        decimals: 9,
        rawAmount: "1000000000",
        rawAmountSource: "quote_policy_evidence"
      }],
      expectedIncoming: [{
        role: "expected_output",
        symbol: "USDC",
        coinType: "0x2::coin::Coin<0x123::usdc::USDC>",
        decimals: 6,
        rawAmount: "123456789",
        rawAmountSource: "quote_policy_evidence"
      }],
      minimumIncoming: [{
        role: "minimum_output",
        symbol: "USDC",
        coinType: "0x2::coin::Coin<0x123::usdc::USDC>",
        decimals: 6,
        rawAmount: "122839505",
        rawAmountSource: "quote_policy_evidence"
      }],
      fees: [{
        role: "fee",
        symbol: "DEEP",
        coinType: "0x2::deep::DEEP",
        decimals: 6,
        rawAmount: "10",
        rawAmountSource: "quote_policy_evidence"
      }]
    },
    recipients: [
      { role: "connected_account", address: account },
      { role: "output_recipient", address: account }
    ],
    targets: [{
      kind: "swap_output_asset",
      symbol: "USDC",
      coinType: "0x2::coin::Coin<0x123::usdc::USDC>",
      protocol: "DeepBookV3",
      poolKey: "SUI_USDC",
      direction: "base_to_quote"
    }],
    evidenceUsed: [{
      id: "swap_quote_policy",
      label: "Swap quote policy",
      source: "quote",
      summary: "Quote policy evidence is bound to the local material."
    }],
    missingEvidence: [],
    requiredUserChoices: [],
    unsupportedClaims: [{
      id: "no_signing_readiness",
      label: "No signing readiness",
      reason: "This review evidence is not signing readiness."
    }],
    freshness: {
      status: "current",
      evaluatedAt: new Date(0).toISOString(),
      expiresAt: new Date(1_000).toISOString(),
      reason: "Evidence expires with the stored material."
    },
    blockingChecks: []
  });
}

describe("MCP schemas", () => {
  it.each([
    ["2026-10-11T00:00:00Z", "2026-10-11T00:00:00.000Z"],
    ["2026-10-11T00:00:00.1Z", "2026-10-11T00:00:00.100Z"],
    ["2026-10-11T00:00:00.12Z", "2026-10-11T00:00:00.120Z"],
    ["2026-10-11T00:00:00.123Z", "2026-10-11T00:00:00.123Z"],
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["+010000-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"]
  ])("normalizes only read timestamp input %s to %s", (input, expected) => {
    expect(utcTimestampInputSchema.parse(input)).toBe(expected);
    expect(fetchedAtSchema.parse(expected)).toBe(expected);
    expect(fetchedAtSchema.safeParse(input).success).toBe(input === expected);
  });

  it.each([
    "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z",
    "2026-10-11T24:00:00Z", "2026-10-11T00:60:00Z", "2026-10-11T00:00:60Z",
    "2026-10-11T00:00:00", "2026-10-11T00:00:00+00:00", "2026-10-11T09:00:00+09:00",
    "2026-10-11", "2026-10-11T00:00Z", "2026-10-11T00:00:00.1234Z",
    " 2026-10-11T00:00:00Z", "2026-10-11T00:00:00Z ", "not-a-date"
  ])("rejects invalid or unsupported read timestamp input %s", (input) => {
    expect(utcTimestampInputSchema.safeParse(input).success).toBe(false);
  });

  it("describes the shared okToolResult wrapper, not raw data", () => {
    const schema = successOutputSchema({ value: z.string() });
    const result = okToolResult({ value: "ok" });

    expect(schema.safeParse(result.structuredContent).success).toBe(true);
    expect(schema.safeParse({ value: "ok" }).success).toBe(false);
  });

  it("keeps intent evidence target selection provenance explicit and finite", () => {
    const schema = z.object({
      targetAssetSymbol: z.string().optional(),
      targetAssetSelectionSource: z.enum(INTENT_EVIDENCE_TARGET_ASSET_SELECTION_SOURCES).optional()
    });

    expect(schema.safeParse({ targetAssetSymbol: "USDC", targetAssetSelectionSource: "user_explicit" }).success).toBe(
      true
    );
    expect(
      schema.safeParse({
        targetAssetSymbol: "USDC",
        targetAssetSelectionSource: "prior_user_explicit_context"
      }).success
    ).toBe(true);
    expect(schema.safeParse({ targetAssetSymbol: "USDC", targetAssetSelectionSource: "agent_inferred" }).success).toBe(
      false
    );
  });

  it("keeps execution polling guidance in structured data instead of tool descriptions", () => {
    const schema = successOutputSchema({
        reviewSessionId: z.string(),
        status: z.enum(["pending"]),
        pollingHint: z.object({
          nonTerminalStatuses: z.array(z.string()),
          waitStoppingStatuses: z.array(z.string()),
          finalStatuses: z.array(z.string()),
          userActionRequiredStatuses: z.array(z.string()),
          recommendedIntervalSeconds: z.number().int().positive()
        })
      });

    expect(
      schema.safeParse({
        ok: true,
        data: {
          reviewSessionId: "session_1",
          status: "pending",
          pollingHint: {
            nonTerminalStatuses: ["pending"],
            waitStoppingStatuses: ["success", "failure", "refresh_required", "blocked", "expired"],
            finalStatuses: ["success", "failure", "expired"],
            userActionRequiredStatuses: ["refresh_required", "blocked"],
            recommendedIntervalSeconds: 3
          }
        }
      }).success
    ).toBe(true);
  });

  it("validates lifecycle statuses and conditional reasons", () => {
    expect(executionPollingStatusSchema.safeParse("awaiting_wallet").success).toBe(true);
    expect(executionPollingStatusSchema.safeParse("refresh_required").success).toBe(true);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        adapterLifecycle: deepbookLifecycle(4),
        checks: [],
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(true);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "wallet_review_contract_emit_missing",
        adapterLifecycle: deepbookLifecycle(9),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        simulation: {
          ...simulationSummary(),
          success: false,
          error: "MoveAbort"
        },
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "wallet_review_contract_emit_missing",
        adapterLifecycle: deepbookLifecycle(9),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        simulation: {
          ...simulationSummary(),
          error: "unexpected successful summary error"
        },
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    {
      const { gasCostSummary, ...simulationWithoutGasCostSummary } = simulationSummary();
      expect(
        reviewStateStructuralInvariantSchema.safeParse({
          planId: "plan_1",
          reviewSessionId: "session_1",
          account,
          status: "blocked",
          blockedReason: "wallet_review_contract_emit_missing",
          adapterLifecycle: deepbookLifecycle(9),
          checks: [],
          humanReadableReview: humanReadableReviewSummary(),
          simulation: simulationWithoutGasCostSummary,
          updatedAt: new Date(0).toISOString()
        }).success
      ).toBe(false);
    }

    {
      const { balanceChanges, ...simulationWithoutBalanceChanges } = simulationSummary();
      expect(
        reviewStateStructuralInvariantSchema.safeParse({
          planId: "plan_1",
          reviewSessionId: "session_1",
          account,
          status: "blocked",
          blockedReason: "wallet_review_contract_emit_missing",
          adapterLifecycle: deepbookLifecycle(9),
          checks: [],
          humanReadableReview: humanReadableReviewSummary(),
          simulation: simulationWithoutBalanceChanges,
          updatedAt: new Date(0).toISOString()
        }).success
      ).toBe(false);
    }

    {
      const { objectChanges, ...simulationWithoutObjectChanges } = simulationSummary();
      expect(
        reviewStateStructuralInvariantSchema.safeParse({
          planId: "plan_1",
          reviewSessionId: "session_1",
          account,
          status: "blocked",
          blockedReason: "wallet_review_contract_emit_missing",
          adapterLifecycle: deepbookLifecycle(9),
          checks: [],
          humanReadableReview: humanReadableReviewSummary(),
          simulation: simulationWithoutObjectChanges,
          updatedAt: new Date(0).toISOString()
        }).success
      ).toBe(false);
    }

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        checks: [],
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        adapterLifecycle: deepbookLifecycle(4),
        checks: [],
        simulation: simulationSummary(),
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        adapterLifecycle: deepbookLifecycle(4),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        adapterLifecycle: deepbookLifecycle(8),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(true);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        adapterLifecycle: deepbookLifecycle(9),
        checks: [],
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "wallet_review_contract_emit_missing",
        adapterLifecycle: deepbookLifecycle(9),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        simulation: simulationSummary(),
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(true);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "wallet_review_contract_emit_missing",
        adapterLifecycle: deepbookLifecycle(9),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "wallet_review_contract_emit_missing",
        adapterLifecycle: deepbookLifecycle(8),
        checks: [],
        humanReadableReview: humanReadableReviewSummary(),
        simulation: simulationSummary(),
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account,
        status: "blocked",
        blockedReason: "producer_stage_missing",
        adapterLifecycle: {
          stageCatalogId: "deepbook_swap_review_v1",
          adapterId: "deepbook-swap",
          protocol: "DeepBookV3",
          actionKind: "swap",
          completedStages: ["intent_normalized", "intent_normalized"],
          missingStages: [
            "quote_evidence_fetched",
            "quote_policy_derived",
            "transaction_material_build_or_verify",
            "digest_commitment",
            "object_ownership",
            "human_readable_review",
            "review_time_simulation"
          ]
        },
        checks: [],
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);
    expect(
      deepbookSwapReviewLifecycleSchema.safeParse({
        stageCatalogId: "deepbook_swap_review_v1",
        adapterId: "deepbook-swap",
        protocol: "DeepBookV3",
        actionKind: "swap",
        completedStages: ["intent_normalized", "quote_evidence_fetched"],
        missingStages: [
          "pool_resolved",
          "quote_policy_derived",
          "transaction_material_build_or_verify",
          "digest_commitment",
          "object_ownership",
          "human_readable_review",
          "review_time_simulation"
        ]
      }).success
    ).toBe(false);
    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "blocked",
        checks: [],
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);
    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "refresh_required",
        refreshReason: "quote_stale",
        checks: [],
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(true);
    expect(
      transactionExecutionSummarySchema.safeParse({
        reviewSessionId: "session_1",
        planId: "plan_1",
        status: "failure",
        failureReason: "network_error",
        recordedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);
    expect(
      transactionExecutionSummarySchema.safeParse({
        reviewSessionId: "session_1",
        planId: "plan_1",
        status: "failure",
        recordedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);
  });

  it("keeps asset flow preview display-intent amounts separate from actual flows", () => {
    const legacyPlan = {
      ...plan,
      assetFlowPreview: {
        outgoing: [{ symbol: "SUI", amount: "1" }],
        expectedIncoming: [{ symbol: "USDC", amount: "unknown", approx: true }]
      }
    };
    const parsedPlan = actionPlanSchema.parse(legacyPlan);
    expect(parsedPlan.assetFlowPreview.outgoing[0]).toMatchObject({
      amountKind: "display_intent"
    });
    expect(parsedPlan.assetFlowPreview.expectedIncoming[0]).toMatchObject({
      amountKind: "display_intent"
    });

    const invalidAmountKind = ["signable", "raw"].join("_");
    expect(
      actionPlanSchema.safeParse({
        ...plan,
        assetFlowPreview: {
          outgoing: [{ symbol: "SUI", amount: "1", amountKind: invalidAmountKind }],
          expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }]
        }
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready_for_wallet_review",
        checks: [],
        assetFlowActual: {
          outgoing: [{ symbol: "SUI", amount: "1" }],
          expectedIncoming: [{ symbol: "USDC", amount: "2" }]
        },
        beforeAfterBalance: {
          before: [{ symbol: "SUI", amount: "3" }],
          after: [{ symbol: "SUI", amount: "2" }],
          delta: [{ symbol: "SUI", amount: "-1" }]
        },
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(true);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready_for_wallet_review",
        checks: [],
        assetFlowActual: {
          outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
          expectedIncoming: [{ symbol: "USDC", amount: "2" }]
        },
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);

    expect(
      reviewStateStructuralInvariantSchema.safeParse({
        planId: "plan_1",
        reviewSessionId: "session_1",
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready_for_wallet_review",
        checks: [],
        beforeAfterBalance: {
          before: [{ symbol: "SUI", amount: "3", amountKind: "display_intent" }],
          after: [{ symbol: "SUI", amount: "2" }],
          delta: [{ symbol: "SUI", amount: "-1" }]
        },
        updatedAt: new Date(0).toISOString()
      }).success
    ).toBe(false);
  });

  it("validates action review output with explicit plan and check schemas", () => {
    const schema = successOutputSchema({
        reviewSessionId: z.string(),
        reviewUrl: z.string(),
        plans: z.array(actionPlanSchema),
        preliminaryChecks: z.array(reviewCheckSchema)
      });

    expect(
      schema.safeParse({
        ok: true,
        data: {
          reviewSessionId: "session_1",
          reviewUrl: "http://127.0.0.1:4173/review/session_1#token",
          plans: [plan],
          preliminaryChecks: plan.preliminaryChecks ?? []
        }
      }).success
    ).toBe(true);
  });

  it("exposes only allowlisted mainnet product protocols", () => {
    expect(SUPPORTED_PROTOCOLS.every((protocol) => protocol.status === "mainnet")).toBe(true);
    expect(SUPPORTED_PROTOCOLS.map((protocol) => protocol.id)).toEqual([
      "deepbook-v3",
      "deepbook-margin"
    ]);
    expect(
      SUPPORTED_PROTOCOLS.find((protocol) => protocol.id === "deepbook-v3")?.support
    ).toBe("read_and_local_review");
  });
});


it("distinguishes invalidated failed evidence from an incomplete fresh computation", () => {
  const failure = { planId: "plan_1", reviewSessionId: "session_1", account, status: "blocked",
    blockedReason: "wallet_review_contract_emit_missing", checks: [], adapterLifecycle: deepbookLifecycle(9), updatedAt: new Date(0).toISOString() };
  expect(reviewStateStructuralInvariantSchema.safeParse(failure).success).toBe(false);
  const invalidated = { ...failure, evidenceValidity: "invalidated" };
  expect(reviewStateStructuralInvariantSchema.safeParse(invalidated).success).toBe(true);
  expect(reviewStateStructuralInvariantSchema.safeParse({ ...invalidated, adapterLifecycle: undefined }).success).toBe(false);
  expect(reviewStateStructuralInvariantSchema.safeParse({ ...invalidated, adapterLifecycle: deepbookLifecycle(8) }).success).toBe(false);
  for (const facts of [{ humanReadableReview: humanReadableReviewSummary() }, { simulation: simulationSummary() },
    { assetFlowActual: { outgoing: [], expectedIncoming: [] } }, { beforeAfterBalance: { before: [], after: [], delta: [] } }]) {
    expect(reviewStateStructuralInvariantSchema.safeParse({ ...failure, humanReadableReview: humanReadableReviewSummary(), simulation: simulationSummary(), ...facts }).success).toBe(true);
    expect(reviewStateStructuralInvariantSchema.safeParse({ ...invalidated, ...facts }).success).toBe(false);
  }
  expect(reviewStateStructuralInvariantSchema.safeParse({ ...invalidated, status: "ready_for_wallet_review", blockedReason: undefined }).success).toBe(false);
});
