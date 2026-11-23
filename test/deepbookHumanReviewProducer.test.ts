import { testObjectFunding } from "./fixtures/transactionMaterial.js";
import { describe, expect, it } from "vitest";
import {
  createDeepbookSwapHumanReadableReviewProducer
} from "../src/adapters/deepbook/deepbookHumanReviewProducer.js";
import { deriveDeepbookSwapQuotePolicy } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import type { DeepbookSwapRequestedIntent } from "../src/adapters/deepbook/deepbookSwapIntent.js";
import type { ActionPlan } from "../src/core/action/types.js";
import {
  createSwapQuotePolicyEvidence
} from "../src/core/action/swapQuotePolicyEvidence.js";
import {
  TRANSACTION_OBJECT_OWNERSHIP_EVIDENCE_VERSION,
  type TransactionObjectOwnershipEvidence
} from "../src/core/action/transactionObjectOwnershipEvidence.js";
import {
  publicHumanReadableReviewFromEvidence
} from "../src/core/action/humanReadableReviewEvidence.js";
import {
  verifySwapHumanReadableReviewEvidence
} from "../src/core/action/swapHumanReadableReviewProjection.js";
import { resolveDeepbookPoolForSymbols } from "../src/core/read/deepbookRegistry.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";
import { recordTestTransactionMaterial } from "./fixtures/transactionMaterial.js";

const account = `0x${"a".repeat(64)}`;
const requestedIntent: DeepbookSwapRequestedIntent = {
  type: "swap",
  from: { symbol: "SUI", amountDisplay: "1" },
  to: { symbol: "USDC" },
  maxSlippageBps: 50
};
const plan: ActionPlan & {
  actionKind: "swap";
  adapterId: "deepbook-swap";
  protocol: "DeepBookV3";
} = {
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
  adapterData: { requestedIntent },
  createdAt: "2026-05-15T00:00:00.000Z"
};

describe("DeepBook human-readable review producer", () => {
  it("creates digest-bound human-readable review evidence without public material identifiers", async () => {
    const fixture = await buildHumanReviewFixture();
    const producer = createDeepbookSwapHumanReadableReviewProducer();

    const outcome = await producer({
      plan,
      account,
      requestedIntent,
      poolResolution: fixture.poolResolution,
      quotePolicy: fixture.quotePolicy,
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: fixture.swapQuotePolicy,
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      now: fixture.now
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("human-readable review producer did not complete");
    }
    expect(outcome.evidence).toMatchObject({
      materialId: fixture.material.handle.materialId,
      transactionDigest: fixture.material.digest.transactionDigest,
      review: {
        kind: "swap_human_readable_review",
        proposedAction: {
          adapterId: "deepbook-swap",
          protocol: "DeepBookV3",
          network: "sui:mainnet"
        },
        assetFlow: {
          outgoing: [expect.objectContaining({ role: "input", rawAmount: "1000000000" })],
          expectedIncoming: [expect.objectContaining({ role: "expected_output", rawAmount: "123456789" })],
          minimumIncoming: [expect.objectContaining({ role: "minimum_output", rawAmount: "122839506" })],
          fees: [expect.objectContaining({ role: "fee", rawAmount: "25000" })]
        },
        missingEvidence: [
          expect.objectContaining({ id: "review_time_simulation" })
        ],
        unsupportedClaims: expect.arrayContaining([
          expect.objectContaining({ id: "no_signing_readiness" }),
          expect.objectContaining({ id: "no_execution_readiness" })
        ])
      }
    });
    expect(verifySwapHumanReadableReviewEvidence({
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: fixture.swapQuotePolicy,
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      evidence: outcome.evidence,
      now: fixture.now
    })).toEqual(outcome.evidence);
    const publicReview = publicHumanReadableReviewFromEvidence(outcome.evidence);
    expect(JSON.stringify(publicReview)).not.toContain("transactionBytes");
    expect(JSON.stringify(publicReview)).not.toContain(fixture.material.handle.materialId);
    expect(JSON.stringify(publicReview)).not.toContain(fixture.material.digest.transactionDigest);
  });

  it("fails closed when the quote policy evidence is for different material", async () => {
    const fixture = await buildHumanReviewFixture();
    const producer = createDeepbookSwapHumanReadableReviewProducer();

    const outcome = await producer({
      plan,
      account,
      requestedIntent,
      poolResolution: fixture.poolResolution,
      quotePolicy: fixture.quotePolicy,
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: {
        ...fixture.swapQuotePolicy,
        materialId: "txmat_other"
      },
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      now: fixture.now
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      checks: [{ id: "deepbook_human_readable_review_failed", status: "fail" }]
    });
  });

  it("rejects human-readable evidence whose public action identity diverges from the private evidence identity", async () => {
    const fixture = await buildHumanReviewFixture();
    const producer = createDeepbookSwapHumanReadableReviewProducer();
    const outcome = await producer({
      plan,
      account,
      requestedIntent,
      poolResolution: fixture.poolResolution,
      quotePolicy: fixture.quotePolicy,
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: fixture.swapQuotePolicy,
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      now: fixture.now
    });
    if (outcome.status !== "completed") {
      throw new Error("human-readable review producer did not complete");
    }

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...outcome.evidence,
          review: {
            ...outcome.evidence.review,
            proposedAction: {
              ...outcome.evidence.review.proposedAction,
              protocol: "WrongProtocol"
            }
          }
        },
        now: fixture.now
      })
    ).toThrow("review proposedAction must match the human-readable review evidence identity");
  });

  it("rejects duplicate required human-readable review fields", async () => {
    const fixture = await buildHumanReviewFixture();
    const producer = createDeepbookSwapHumanReadableReviewProducer();
    const outcome = await producer({
      plan,
      account,
      requestedIntent,
      poolResolution: fixture.poolResolution,
      quotePolicy: fixture.quotePolicy,
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: fixture.swapQuotePolicy,
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      now: fixture.now
    });
    if (outcome.status !== "completed") {
      throw new Error("human-readable review producer did not complete");
    }

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...outcome.evidence,
          fields: [...outcome.evidence.fields, outcome.evidence.fields[0]!]
        },
        now: fixture.now
      })
    ).toThrow("Human-readable review fields contains duplicate field");
  });

  it("rejects human-readable amount facts that do not project the swap quote policy", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            assetFlow: {
              ...evidence.review.assetFlow,
              expectedIncoming: [
                {
                  ...evidence.review.assetFlow.expectedIncoming[0]!,
                  rawAmount: "123456788"
                }
              ]
            }
          }
        },
        now: fixture.now
      })
    ).toThrow("swap human-readable review expected incoming amount must match swap quote policy evidence");
  });

  it("rejects human-readable asset facts that do not project the swap quote policy", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            assetFlow: {
              ...evidence.review.assetFlow,
              minimumIncoming: [
                {
                  ...evidence.review.assetFlow.minimumIncoming[0]!,
                  coinType: `0x${"d".repeat(64)}::coin::USDC`
                }
              ]
            }
          }
        },
        now: fixture.now
      })
    ).toThrow("swap human-readable review minimum incoming amount must match swap quote policy evidence");
  });

  it("rejects human-readable target facts that do not project the swap quote source", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            targets: [
              {
                ...evidence.review.targets[0]!,
                poolKey: "WRONG_POOL"
              }
            ]
          }
        },
        now: fixture.now
      })
    ).toThrow("swap human-readable review target must match swap quote policy output asset and quote source");
  });

  it("rejects human-readable recipient facts that do not match the reviewed account", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            recipients: [
              evidence.review.recipients[0]!,
              {
                ...evidence.review.recipients[1]!,
                address: `0x${"e".repeat(64)}`
              }
            ]
          }
        },
        now: fixture.now
      })
    ).toThrow("swap human-readable review recipients must match the reviewed account");
  });

  it("rejects human-readable reviews missing current-alpha boundary claims", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            unsupportedClaims: evidence.review.unsupportedClaims.filter(
              (claim) => claim.id !== "no_signing_readiness"
            )
          }
        },
        now: fixture.now
      })
    ).toThrow("human-readable review unsupportedClaims must include 'no_signing_readiness'");
  });

  it("rejects human-readable reviews that omit required evidence source references", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            evidenceUsed: evidence.review.evidenceUsed.filter(
              (fact) => fact.source !== "digest_commitment"
            )
          }
        },
        now: fixture.now
      })
    ).toThrow("human-readable review evidenceUsed must include source 'digest_commitment'");
  });

  it("allows adapter-owned simulation blocking check ids while enforcing the simulation blocker", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    const parsed = verifySwapHumanReadableReviewEvidence({
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: fixture.swapQuotePolicy,
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      evidence: {
        ...evidence,
        review: {
          ...evidence.review,
          blockingChecks: [
            {
              ...evidence.review.blockingChecks[0]!,
              id: "adapter_owned_simulation_missing"
            }
          ]
        }
      },
      now: fixture.now
    });

    expect(parsed.review.blockingChecks[0]).toMatchObject({
      id: "adapter_owned_simulation_missing",
      source: "simulation",
      status: "fail"
    });
  });

  it("rejects human-readable reviews without a failed simulation blocking check", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            blockingChecks: [
              {
                ...evidence.review.blockingChecks[0]!,
                source: "adapter"
              }
            ]
          }
        },
        now: fixture.now
      })
    ).toThrow("human-readable review blockingChecks must include a failed simulation check");
  });

  it("fails closed when producer source inputs disagree about pool or direction", async () => {
    const fixture = await buildHumanReviewFixture();
    const producer = createDeepbookSwapHumanReadableReviewProducer();

    const outcome = await producer({
      plan,
      account,
      requestedIntent,
      poolResolution: { ...fixture.poolResolution, poolKey: "WRONG_POOL" },
      quotePolicy: fixture.quotePolicy,
      transactionMaterial: fixture.material.handle,
      transactionMaterialDigest: fixture.material.digest,
      swapQuotePolicy: fixture.swapQuotePolicy,
      transactionObjectOwnership: fixture.transactionObjectOwnership,
      now: fixture.now
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "asset_mismatch",
      checks: [{
        id: "deepbook_human_readable_review_failed",
        status: "fail",
        message: "human-readable review pool target must match swap quote policy poolKey"
      }]
    });
  });

  it("rejects human-readable raw amounts outside the raw u64 source of truth", async () => {
    const fixture = await buildHumanReviewFixture();
    const evidence = await produceCompletedHumanReviewEvidence(fixture);

    expect(() =>
      verifySwapHumanReadableReviewEvidence({
        transactionMaterial: fixture.material.handle,
        transactionMaterialDigest: fixture.material.digest,
        swapQuotePolicy: fixture.swapQuotePolicy,
        transactionObjectOwnership: fixture.transactionObjectOwnership,
        evidence: {
          ...evidence,
          review: {
            ...evidence.review,
            assetFlow: {
              ...evidence.review.assetFlow,
              outgoing: [
                {
                  ...evidence.review.assetFlow.outgoing[0]!,
                  rawAmount: "18446744073709551616"
                }
              ]
            }
          }
        },
        now: fixture.now
      })
    ).toThrow("Expected a raw u64 amount string");
  });
});

async function buildHumanReviewFixture() {
  const now = new Date("2026-05-15T00:00:29.000Z");
  const materialStore = new InMemoryLocalTransactionMaterialStore();
  const material = await recordTestTransactionMaterial({
    materialStore,
    reviewSessionId: "review_1",
    planId: plan.id,
    account,
    now,
    expiresAt: new Date("2026-05-15T00:00:30.000Z"),
    includeSharedObject: true
  });
  const quote = deepbookDisplayQuote();
  const quotePolicy = deriveDeepbookSwapQuotePolicy({
    rawQuote: quote.rawQuote,
    fetchedAt: quote.fetchedAt,
    maxSlippageBps: 50,
    now
  });
  if (quotePolicy.status !== "ok") {
    throw new Error("quote fixture unexpectedly requires refresh");
  }
  const poolResolution = resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" });
  const amount = (rawAmount: typeof quote.rawQuote.inputAmount) => ({
    raw: rawAmount.raw,
    asset: {
      symbol: rawAmount.symbol,
      coinType: rawAmount.coinType,
      decimals: rawAmount.decimals,
      unitSource: rawAmount.unitSource
    }
  });
  const swapQuotePolicy = createSwapQuotePolicyEvidence({
    materialHandle: material.handle,
    adapterId: plan.adapterId,
    protocol: plan.protocol,
    actionKind: plan.actionKind,
    quoteEvidenceId: `deepbook_raw_quote:${material.handle.materialId}`,
    quoteSource: {
      provider: plan.protocol,
      poolKey: quote.pool.poolKey,
      direction: quotePolicy.direction,
      fetchedAt: quotePolicy.fetchedAt,
      sourceMoveFunction: quote.rawQuote.sourceMoveFunction
    },
    maxSlippageBps: quotePolicy.maxSlippageBps,
    staleAfterMs: quotePolicy.staleAfterMs,
    sourceAmount: amount(quote.rawQuote.inputAmount),
    expectedOutput: amount(quote.rawQuote.directionalOutput),
    minimumOutput: {
      raw: quotePolicy.minOutRaw,
      asset: amount(quote.rawQuote.directionalOutput).asset
    },
    inputFlow: quote.inputFlow,
    separateFeeBudgetRaw: quote.rawQuote.deepRequired.raw,
    derivedAt: now
  });
  const transactionObjectOwnership: TransactionObjectOwnershipEvidence = {
    evidenceVersion: TRANSACTION_OBJECT_OWNERSHIP_EVIDENCE_VERSION,
    funding: testObjectFunding(account),
    materialId: material.handle.materialId,
    reviewSessionId: material.handle.reviewSessionId,
    planId: material.handle.planId,
    account: material.handle.account,
    transactionDigest: material.digest.transactionDigest,
    objectCount: 2,
    objects: [
      {
        objectId: `0x${"b".repeat(64)}`,
        roles: ["gas_object"],
        ownership: "owned_by_account",
        ownerKind: "AddressOwner",
        ownerAccount: account,
        objectType: "0x2::coin::Coin<0x2::sui::SUI>",
        source: "stored_transaction_data_and_mainnet_object_read"
      },
      {
        objectId: `0x${"c".repeat(64)}`,
        roles: ["shared_object"],
        ownership: "shared_object",
        ownerKind: "Shared",
        objectType: "0x2::clock::Clock",
        source: "stored_transaction_data_and_mainnet_object_read"
      }
    ],
    verifiedAt: now.toISOString(),
    expiresAt: material.handle.expiresAt
  };
  return { now, material, quotePolicy, poolResolution, swapQuotePolicy, transactionObjectOwnership };
}

async function produceCompletedHumanReviewEvidence(
  fixture: Awaited<ReturnType<typeof buildHumanReviewFixture>>
) {
  const producer = createDeepbookSwapHumanReadableReviewProducer();
  const outcome = await producer({
    plan,
    account,
    requestedIntent,
    poolResolution: fixture.poolResolution,
    quotePolicy: fixture.quotePolicy,
    transactionMaterial: fixture.material.handle,
    transactionMaterialDigest: fixture.material.digest,
    swapQuotePolicy: fixture.swapQuotePolicy,
    transactionObjectOwnership: fixture.transactionObjectOwnership,
    now: fixture.now
  });
  if (outcome.status !== "completed") {
    throw new Error("human-readable review producer did not complete");
  }
  return outcome.evidence;
}
