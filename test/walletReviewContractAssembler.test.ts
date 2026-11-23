import { testObjectFunding } from "./fixtures/transactionMaterial.js";
import { describe, expect, it } from "vitest";
import { deriveDeepbookSwapQuotePolicy } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import { createReviewTimeSimulationProducer } from "../src/core/action/reviewTimeSimulationEvidence.js";
import { createSwapQuotePolicyEvidence } from "../src/core/action/swapQuotePolicyEvidence.js";
import {
  TRANSACTION_OBJECT_OWNERSHIP_EVIDENCE_VERSION,
  type TransactionObjectOwnershipEvidence
} from "../src/core/action/transactionObjectOwnershipEvidence.js";
import type { ActionPlan } from "../src/core/action/types.js";
import {
  assembleTransactionReviewData
} from "../src/core/action/walletReviewContractAssembler.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";
import { createTestSwapHumanReadableReviewEvidence } from "./fixtures/humanReadableReview.js";
import { createSuccessfulReviewTimeSimulationClient } from "./fixtures/reviewTimeSimulation.js";
import { recordTestTransactionMaterial } from "./fixtures/transactionMaterial.js";

const plan: Pick<ActionPlan, "id" | "actionKind" | "adapterId" | "protocol" | "title" | "summary"> = {
  id: "plan_1",
  actionKind: "swap",
  adapterId: "deepbook-swap",
  protocol: "DeepBookV3",
  title: "Review swap",
  summary: "Review a swap"
};
const walletAccount = `0x${"a".repeat(64)}`;
const suiCoinObjectType = "0x2::coin::Coin<0x2::sui::SUI>";
const sharedObjectType = "0x2::clock::Clock";

const materialRecordedAt = new Date("2026-06-06T00:00:00.000Z");
const materialComputedAt = new Date("2026-06-06T00:00:01.000Z");
const materialExpiresAt = new Date("2026-06-06T00:30:00.000Z");
const derivedAt = new Date("2026-06-06T00:00:02.000Z");
const simulatedAt = new Date("2026-06-06T00:00:03.000Z");
const assembledAt = new Date("2026-06-06T00:00:04.000Z");

function testObjectOwnershipEvidence(input: {
  materialId: string;
  transactionDigest: string;
  expiresAt: string;
  gasObjectType?: string | undefined;
}): TransactionObjectOwnershipEvidence {
  return {
    evidenceVersion: TRANSACTION_OBJECT_OWNERSHIP_EVIDENCE_VERSION,
    funding: testObjectFunding(walletAccount),
    materialId: input.materialId,
    reviewSessionId: "rs_1",
    planId: plan.id,
    account: walletAccount,
    transactionDigest: input.transactionDigest,
    objectCount: 2,
    objects: [
      {
        objectId: `0x${"b".repeat(64)}`,
        roles: ["gas_object"],
        ownership: "owned_by_account",
        ownerKind: "AddressOwner",
        ownerAccount: walletAccount,
        objectType: input.gasObjectType ?? suiCoinObjectType,
        source: "stored_transaction_data_and_mainnet_object_read"
      },
      {
        objectId: `0x${"c".repeat(64)}`,
        roles: ["shared_object"],
        ownership: "shared_object",
        ownerKind: "Shared",
        objectType: sharedObjectType,
        source: "stored_transaction_data_and_mainnet_object_read"
      }
    ],
    verifiedAt: derivedAt.toISOString(),
    expiresAt: input.expiresAt
  };
}

function testSwapQuotePolicyEvidence(input: {
  materialHandle: Awaited<ReturnType<typeof recordTestTransactionMaterial>>["handle"];
}) {
  const quote = deepbookDisplayQuote({ fetchedAt: "2026-06-06T00:00:00.000Z" });
  const policy = deriveDeepbookSwapQuotePolicy({
    rawQuote: quote.rawQuote,
    fetchedAt: quote.fetchedAt,
    maxSlippageBps: 50,
    staleAfterMs: materialExpiresAt.getTime() - Date.parse(quote.fetchedAt),
    now: derivedAt
  });
  if (policy.status !== "ok") {
    throw new Error("quote fixture unexpectedly requires refresh");
  }
  const amount = (rawAmount: typeof quote.rawQuote.inputAmount) => ({
    raw: rawAmount.raw,
    asset: {
      symbol: rawAmount.symbol,
      coinType: rawAmount.coinType,
      decimals: rawAmount.decimals,
      unitSource: rawAmount.unitSource
    }
  });
  return createSwapQuotePolicyEvidence({
    materialHandle: input.materialHandle,
    adapterId: plan.adapterId,
    protocol: plan.protocol,
    actionKind: plan.actionKind,
    quoteEvidenceId: `deepbook_raw_quote:${input.materialHandle.materialId}`,
    quoteSource: {
      provider: plan.protocol,
      poolKey: quote.pool.poolKey,
      direction: policy.direction,
      fetchedAt: policy.fetchedAt,
      sourceMoveFunction: quote.rawQuote.sourceMoveFunction
    },
    maxSlippageBps: policy.maxSlippageBps,
    staleAfterMs: policy.staleAfterMs,
    sourceAmount: amount(quote.rawQuote.inputAmount),
    expectedOutput: amount(quote.rawQuote.directionalOutput),
    minimumOutput: {
      raw: policy.minOutRaw,
      asset: amount(quote.rawQuote.directionalOutput).asset
    },
    inputFlow: quote.inputFlow,
    separateFeeBudgetRaw: quote.rawQuote.deepRequired.raw,
    derivedAt
  });
}

async function buildAssemblyArtifacts(options: { gasObjectType?: string | undefined } = {}) {
  const materialStore = new InMemoryLocalTransactionMaterialStore();
  const { handle, digest } = await recordTestTransactionMaterial({
    materialStore,
    reviewSessionId: "rs_1",
    planId: plan.id,
    account: walletAccount,
    now: materialRecordedAt,
    computedAt: materialComputedAt,
    expiresAt: materialExpiresAt,
    includeSharedObject: true
  });
  const quotePolicy = testSwapQuotePolicyEvidence({ materialHandle: handle });
  const objectOwnership = testObjectOwnershipEvidence({
    materialId: handle.materialId,
    transactionDigest: digest.transactionDigest,
    expiresAt: handle.expiresAt,
    gasObjectType: options.gasObjectType
  });
  const humanReadableReview = createTestSwapHumanReadableReviewEvidence({
    plan,
    account: walletAccount,
    materialHandle: handle,
    digest,
    swapQuotePolicy: quotePolicy,
    transactionObjectOwnership: objectOwnership,
    derivedAt,
    displayAmount: "1"
  });
  const producer = createReviewTimeSimulationProducer({
    client: createSuccessfulReviewTimeSimulationClient(walletAccount),
    materialStore,
    network: "mainnet",
    chainIdentifier: "mainnet-chain",
    expectedChainIdentifier: "mainnet-chain"
  });
  const outcome = await producer({
    transactionMaterial: handle,
    transactionMaterialDigest: digest,
    now: simulatedAt
  });
  if (outcome.status !== "completed") {
    throw new Error("test review-time simulation evidence was not produced");
  }
  return { handle, digest, quotePolicy, objectOwnership, humanReadableReview, reviewTimeSimulation: outcome.evidence };
}

function assemblyInputFrom(artifacts: Awaited<ReturnType<typeof buildAssemblyArtifacts>>) {
  return {
    adapterId: plan.adapterId,
    protocol: plan.protocol,
    actionKind: plan.actionKind,
    provenance: {
      kind: "mcp_action_request" as const,
      sourceId: plan.id,
      capturedAt: materialRecordedAt.toISOString()
    },
    quotePolicy: artifacts.quotePolicy,
    objectOwnership: artifacts.objectOwnership,
    humanReadableReview: artifacts.humanReadableReview,
    reviewTimeSimulation: artifacts.reviewTimeSimulation,
    reviewedTransactionDigest: artifacts.digest.transactionDigest,
    now: assembledAt
  };
}

describe("assembleTransactionReviewData", () => {
  it("emits a schema-valid contract binding all three commitments to the stored material digest", async () => {
    const artifacts = await buildAssemblyArtifacts();
    const outcome = assembleTransactionReviewData(assemblyInputFrom(artifacts));

    if (outcome.status !== "emitted") {
      throw new Error(`expected emitted contract, got: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.contract.reviewedTransactionDigest).toBe(artifacts.digest.transactionDigest);
    expect(outcome.contract.humanReadableReview.transactionDigest).toBe(artifacts.digest.transactionDigest);
    expect(outcome.contract.simulation.transactionDigest).toBe(artifacts.digest.transactionDigest);
    expect(outcome.contract.objectOwnership.objects).toHaveLength(2);
    expect(outcome.contract.objectOwnership.ownerAccount).toBe(walletAccount);
    expect(outcome.contract.slippageOrMinOut.status).toBe("required_and_verified");
    expect(outcome.contract.gas.source).toBe("review_time_simulation");
    expect(outcome.contract.gas.gasUsedRaw).toBeDefined();
    expect(outcome.contract.gas.unresolvedReason).toBeUndefined();
    expect(outcome.contract.expiry.status).toBe("current");
    expect(outcome.contract.outputBoundary.prohibited).toContain("transaction_bytes");
  });

  it.each([
    { rebate: "200", net: undefined },
    { rebate: "150", net: "0" }
  ])("preserves gas budget without inventing gas spending when rebate is $rebate", async ({ rebate, net }) => {
    const artifacts = await buildAssemblyArtifacts();
    // Independent source values: costs are 100 + 50 MIST. Rebates produce
    // either -50 MIST (no unsigned spending claim) or exactly zero MIST.
    artifacts.reviewTimeSimulation.effects.gasCostSummary = {
      computationCostRaw: "100", storageCostRaw: "50",
      storageRebateRaw: rebate, nonRefundableStorageFeeRaw: "0"
    };
    const outcome = assembleTransactionReviewData(assemblyInputFrom(artifacts));
    if (outcome.status !== "emitted") throw new Error(JSON.stringify(outcome));
    expect(outcome.contract.gas.gasBudgetRaw).toBe(artifacts.reviewTimeSimulation.transaction.gasBudgetRaw);
    expect(outcome.contract.gas.gasBudgetClaimId).toBeDefined();
    expect(outcome.contract.gas.gasObjects).toHaveLength(1);
    expect(outcome.contract.gas.gasUsedRaw).toBe(net);
    expect(outcome.contract.evidenceClaims.filter((claim) => claim.factKind === "raw_quantity_amount" && claim.role === "gas_used"))
      .toHaveLength(net === undefined ? 0 : 1);
    expect(outcome.contract.gas.gasUsedClaimId === undefined).toBe(net === undefined);
    expect(artifacts.reviewTimeSimulation.effects.gasCostSummary.storageRebateRaw).toBe(rebate);
    expect(outcome.contract.simulation.status).toBe("success");
  });

  it("declines when the gas object is not an account-owned Coin<SUI> object", async () => {
    const artifacts = await buildAssemblyArtifacts({ gasObjectType: sharedObjectType });
    const outcome = assembleTransactionReviewData(assemblyInputFrom(artifacts));

    expect(outcome.status).toBe("declined");
    if (outcome.status === "declined") {
      expect(outcome.reason).toContain("gas objects must be owned by the connected account");
    }
  });

  it("declines when the assembly commitment differs from the evidence-bound material digest", async () => {
    const artifacts = await buildAssemblyArtifacts();
    const otherStore = new InMemoryLocalTransactionMaterialStore();
    const other = await recordTestTransactionMaterial({
      materialStore: otherStore,
      reviewSessionId: "rs_2",
      planId: plan.id,
      account: walletAccount,
      now: materialRecordedAt,
      computedAt: materialComputedAt,
      expiresAt: materialExpiresAt,
      includeSharedObject: false
    });
    expect(other.digest.transactionDigest).not.toBe(artifacts.digest.transactionDigest);
    const outcome = assembleTransactionReviewData({
      ...assemblyInputFrom(artifacts),
      reviewedTransactionDigest: other.digest.transactionDigest
    });

    expect(outcome.status).toBe("declined");
    if (outcome.status === "declined") {
      expect(outcome.reason).toContain("contract schema rejected");
    }
  });
});
