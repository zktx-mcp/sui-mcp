import { isFixtureSharedObject } from "./fixtures/transactionMaterial.js";
import { describe, expect, it } from "vitest";
import type { ActionPlan } from "../src/core/action/types.js";
import { ReadServiceInputError } from "../src/core/read/readServiceTypes.js";
import {
  adapterNotImplementedCheck,
  computeReviewResult,
  computeReviewState,
  computeReviewStateWithPrivateArtifacts,
  type ReviewComputationDeps
} from "../src/core/review/reviewComputation.js";
import {
  buildSupportedReviewAdapters,
  type DeepbookReviewAdapterWiring
} from "../src/adapters/reviewAdapters.js";
import { mapReviewComputationResultToState } from "../src/core/review/reviewComputationResult.js";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import { DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGES } from "../src/adapters/deepbook/deepbookReviewLifecycle.js";
import { createDeepbookSwapHumanReadableReviewProducer } from "../src/adapters/deepbook/deepbookHumanReviewProducer.js";
import { createTransactionObjectOwnershipProducer } from "../src/core/action/transactionObjectOwnershipProducer.js";
import { createReviewTimeSimulationProducer } from "../src/core/action/reviewTimeSimulationEvidence.js";
import { producePtbVisualizationArtifact } from "../src/core/action/ptbVisualizationProducer.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import { recordTestTransactionMaterial } from "./fixtures/transactionMaterial.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";
import { createSuccessfulReviewTimeSimulationClient } from "./fixtures/reviewTimeSimulation.js";

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
      from: {
        symbol: "SUI",
        amountDisplay: "1"
      },
      to: {
        symbol: "USDC"
      },
      maxSlippageBps: 50
    }
  },
  createdAt: "2026-05-15T00:00:00.000Z"
};

function withSupportedLifecycleValidator(
  wiring: DeepbookReviewAdapterWiring
): ReviewComputationDeps {
  return {
    validateAdapterLifecycle: validateSupportedAdapterLifecycle,
    adapters: buildSupportedReviewAdapters({ deepbook: { deepbookDeepBalanceSource: async () => "25000", gasFeePolicySource: async () => ({ enabled: false, additionalTakerFeeRaw: "1000000" }), ...wiring } })
  };
}

describe("review computation", () => {
  it("rejects non-canonical adapter lifecycle while mapping computed review state", () => {
    expect(() =>
      mapReviewComputationResultToState(
        {
          reviewSessionId: "review_1",
          planId: plan.id,
          account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          now: new Date("2026-05-15T00:00:29.000Z")
        },
        {
          status: "blocked",
          blockedReason: "producer_stage_missing",
          checks: [],
          adapterLifecycle: {
            stageCatalogId: "deepbook_swap_review_v1",
            adapterId: "deepbook-swap",
            protocol: "DeepBookV3",
            actionKind: "swap",
            completedStages: [
              "intent_normalized",
              "quote_evidence_fetched"
            ],
            missingStages: DEEPBOOK_SWAP_REVIEW_LIFECYCLE_STAGES.filter(
              (stage) => stage !== "intent_normalized" && stage !== "quote_evidence_fetched"
            )
          }
        },
        validateSupportedAdapterLifecycle
      )
    ).toThrow();
  });

  it("keeps adapter evidence separate from public review-state identity", async () => {
    const result = await computeReviewResult(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        }
      })
    );

    expect(result).toMatchObject({
      status: "blocked",
      blockedReason: "producer_stage_missing",
      adapterLifecycle: {
        stageCatalogId: "deepbook_swap_review_v1",
        completedStages: [
          "intent_normalized",
          "pool_resolved",
          "quote_evidence_fetched",
          "quote_policy_derived"
        ],
        missingStages: expect.arrayContaining([
          "transaction_material_build_or_verify",
          "digest_commitment",
          "object_ownership",
          "human_readable_review",
          "review_time_simulation"
        ])
      }
    });
    expect(result).not.toHaveProperty("planId");
    expect(result).not.toHaveProperty("reviewSessionId");
    expect(result).not.toHaveProperty("account");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("keeps current release review computation blocked when no evidence source is injected", async () => {
    const state = await computeReviewState({
      reviewSessionId: "review_1",
      plan,
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now: new Date("2026-05-15T00:00:30.000Z")
    });

    expect(state).toEqual({
      planId: "plan_1",
      reviewSessionId: "review_1",
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "blocked",
      blockedReason: "adapter_not_implemented",
      checks: [adapterNotImplementedCheck()],
      updatedAt: "2026-05-15T00:00:30.000Z"
    });
  });

  it("adds DeepBook quote and policy evidence while keeping signing blocked", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async (input) => {
            expect(input).toMatchObject({
              poolKey: "SUI_USDC",
              direction: "base_to_quote",
              amountDisplay: "1",
              simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            });
            return deepbookDisplayQuote();
          }
        }
      })
    );

    expect(state.status).toBe("blocked");
    expect(state).toMatchObject({
      blockedReason: "producer_stage_missing",
      updatedAt: "2026-05-15T00:00:29.000Z",
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
        missingStages: expect.arrayContaining([
          "transaction_material_build_or_verify",
          "digest_commitment",
          "object_ownership",
          "human_readable_review",
          "review_time_simulation"
        ])
      }
    });
    expect(state.checks.map((check) => check.id)).toEqual([
      "deepbook_display_intent",
      "deepbook_pool_resolution",
      "deepbook_raw_quote_evidence",
      "deepbook_fee_mode",
      "deepbook_quote_policy",
      "deepbook_transaction_material_build_or_verify_missing"
    ]);
    const quoteRules = state.checks.find((check) => check.id === "deepbook_quote_policy")!;
    expect(quoteRules).toMatchObject({ status: "pass", source: "quote" });
    // 50 bps: 123456789 - floor(123456789 * 50 / 10000) = 122839506 raw units.
    expect(quoteRules.message).toContain("review minimum receive 122839506");
    expect(quoteRules.message).toContain("DEEP fee 25000");
    expect(state.status).not.toBe("ready_for_wallet_review");
  });

  it("advances transaction material lifecycle only through an injected local producer", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        },
        deepbookTransactionMaterialProducer: async (input) => {
          expect(input.reviewSessionId).toBe("review_1");
          expect(input.plan.id).toBe("plan_1");
          expect(input.requestedIntent.from.amountDisplay).toBe("1");
          expect(input.poolResolution.poolKey).toBe("SUI_USDC");
          expect(input.quotePolicy.minOutRaw).toBe("122839506");

          const { handle } = await recordTestTransactionMaterial({
            materialStore,
            reviewSessionId: "review_1",
            planId: input.plan.id,
            account: input.account,
            now: input.now,
            expiresAt: new Date("2026-05-15T00:00:30.000Z"),
            includeSharedObject: true
          });
          return {
            status: "completed",
            evidence: handle,
            checks: [
              {
                id: "deepbook_transaction_material_build_or_verify",
                label: "Transaction material build or verify",
                status: "pass",
                message:
                  "Local-only transaction material was produced for the review session. Raw bytes remain internal and are not review-state output.",
                source: "adapter"
              }
            ]
          };
        }
      })
    );

    expect(state).toMatchObject({
      status: "blocked",
      blockedReason: "producer_stage_missing",
      adapterLifecycle: {
        completedStages: [
          "intent_normalized",
          "pool_resolved",
          "quote_evidence_fetched",
          "quote_policy_derived",
          "transaction_material_build_or_verify"
        ],
        missingStages: [
          "digest_commitment",
          "object_ownership",
          "human_readable_review",
          "review_time_simulation"
        ]
      }
    });
    expect(state.checks.map((check) => check.id)).toContain("deepbook_digest_commitment_missing");
    expect(JSON.stringify(state)).not.toContain("transactionBytes");
    expect(JSON.stringify(state)).not.toContain("txmat_");
    expect(JSON.stringify(state)).not.toContain("commandCount");
    expect(state.status).not.toBe("ready_for_wallet_review");
  });

  it("binds private material handle and digest artifacts without public leakage", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    let materialDigest: Awaited<ReturnType<typeof recordTestTransactionMaterial>>["digest"] | undefined;
    const computed = await computeReviewStateWithPrivateArtifacts(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        },
        deepbookTransactionMaterialProducer: async (input) => {
          const material = await recordTestTransactionMaterial({
            materialStore,
            reviewSessionId: "review_1",
            planId: input.plan.id,
            account: input.account,
            now: input.now,
            expiresAt: new Date("2026-05-15T00:00:30.000Z"),
            includeSharedObject: true
          });
          materialDigest = material.digest;
          return {
            status: "completed",
            evidence: material.handle,
            checks: [
              {
                id: "deepbook_transaction_material_build_or_verify",
                label: "Transaction material build or verify",
                status: "pass",
                message: "Local-only transaction material was produced for the review session.",
                source: "adapter"
              }
            ]
          };
        },
        deepbookTransactionMaterialDigestProducer: async () => {
          if (!materialDigest) {
            throw new Error("test material digest was not produced");
          }
          return {
            status: "completed",
            evidence: materialDigest,
            checks: [
              {
                id: "deepbook_transaction_material_digest_commitment",
                label: "Transaction material digest",
                status: "pass",
                message: "Digest commitment was derived from the stored material.",
                source: "adapter"
              }
            ]
          };
        }
      })
    );
    if (!materialDigest) {
      throw new Error("test material digest was not produced");
    }

    expect(computed.state).toMatchObject({
      status: "blocked",
      blockedReason: "producer_stage_missing",
      adapterLifecycle: {
        completedStages: [
          "intent_normalized",
          "pool_resolved",
          "quote_evidence_fetched",
          "quote_policy_derived",
          "transaction_material_build_or_verify",
          "digest_commitment"
        ],
        missingStages: [
          "object_ownership",
          "human_readable_review",
          "review_time_simulation"
        ]
      }
    });
    expect(computed.privateArtifacts).toMatchObject({
      transactionMaterial: {
        reviewSessionId: "review_1",
        planId: "plan_1"
      },
      transactionMaterialDigest: {
        digestKind: "sui_transaction_digest",
        transactionDigest: materialDigest.transactionDigest
      }
    });
    expect(JSON.stringify(computed.state)).not.toContain("transactionBytes");
    expect(JSON.stringify(computed.state)).not.toContain("txmat_");
    expect(JSON.stringify(computed.state)).not.toContain(materialDigest.transactionDigest);
  });

  it("advances object ownership only through verified stored material and object reads", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    let materialDigest: Awaited<ReturnType<typeof recordTestTransactionMaterial>>["digest"] | undefined;
    const computed = await computeReviewStateWithPrivateArtifacts(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        },
        deepbookTransactionMaterialProducer: async (input) => {
          const material = await recordTestTransactionMaterial({
            materialStore,
            reviewSessionId: "review_1",
            planId: input.plan.id,
            account: input.account,
            now: input.now,
            expiresAt: new Date("2026-05-15T00:00:30.000Z"),
            includeSharedObject: true
          });
          materialDigest = material.digest;
          return {
            status: "completed",
            evidence: material.handle,
            checks: [
              {
                id: "deepbook_transaction_material_build_or_verify",
                label: "Transaction material build or verify",
                status: "pass",
                message: "Local-only transaction material was produced for the review session.",
                source: "adapter"
              }
            ]
          };
        },
        deepbookTransactionMaterialDigestProducer: async () => {
          if (!materialDigest) {
            throw new Error("test material digest was not produced");
          }
          return {
            status: "completed",
            evidence: materialDigest,
            checks: [
              {
                id: "deepbook_transaction_material_digest_commitment",
                label: "Transaction material digest",
                status: "pass",
                message: "Digest commitment was derived from the stored material.",
                source: "adapter"
              }
            ]
          };
        },
        transactionObjectOwnershipProducer: createTransactionObjectOwnershipProducer({
          materialStore,
          objectSource: {
            async getObject(input) {
              expect([`0x${"b".repeat(64)}`, `0x${"c".repeat(64)}`]).toContain(input.objectId);
              if (input.objectId === `0x${"c".repeat(64)}`) {
                return {
                  object: {
                    objectId: input.objectId,
                    owner: {
                      $kind: "Shared",
                      Shared: { initialSharedVersion: "1" }
                    },
                    type: "0x2::clock::Clock"
                  }
                };
              }
              return {
                object: {
                  objectId: input.objectId,
                  owner: {
                    $kind: "AddressOwner",
                    AddressOwner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  type: "0x2::coin::Coin<0x2::sui::SUI>"
                }
              };
            }
          },
          network: "mainnet",
          chainIdentifier: "mainnet-chain",
          expectedChainIdentifier: "mainnet-chain"
        })
      })
    );

    expect(computed.state).toMatchObject({
      status: "blocked",
      blockedReason: "producer_stage_missing",
      adapterLifecycle: {
        completedStages: [
          "intent_normalized",
          "pool_resolved",
          "quote_evidence_fetched",
          "quote_policy_derived",
          "transaction_material_build_or_verify",
          "digest_commitment",
          "object_ownership"
        ],
        missingStages: [
          "human_readable_review",
          "review_time_simulation"
        ]
      }
    });
    expect(computed.privateArtifacts).toBeDefined();
    if (!computed.privateArtifacts) {
      throw new Error("private artifacts were not produced");
    }
    expect(computed.privateArtifacts.transactionObjectOwnership).toMatchObject({
      materialId: computed.privateArtifacts.transactionMaterial?.materialId,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      transactionDigest: computed.privateArtifacts.transactionMaterialDigest?.transactionDigest,
      objectCount: 2,
      objects: expect.arrayContaining([
        expect.objectContaining({
          objectId: `0x${"b".repeat(64)}`,
          roles: ["gas_object"],
          ownership: "owned_by_account"
        }),
        expect.objectContaining({
          objectId: `0x${"c".repeat(64)}`,
          roles: ["shared_object"],
          ownership: "shared_object"
        })
      ])
    });
    expect(computed.state.checks.map((check) => check.id)).toContain("transaction_object_ownership_verified");
    expect(computed.state.checks.map((check) => check.id)).toContain("deepbook_human_readable_review_missing");
    expect(JSON.stringify(computed.state)).not.toContain("transactionBytes");
    expect(JSON.stringify(computed.state)).not.toContain("txmat_");
    expect(JSON.stringify(computed.state)).not.toContain(computed.privateArtifacts.transactionObjectOwnership?.transactionDigest);
  });

  it("advances human-readable review through digest-bound private evidence and remains blocked on simulation", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    let materialDigest: Awaited<ReturnType<typeof recordTestTransactionMaterial>>["digest"] | undefined;
    const computed = await computeReviewStateWithPrivateArtifacts(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        },
        deepbookTransactionMaterialProducer: async (input) => {
          const material = await recordTestTransactionMaterial({
            materialStore,
            reviewSessionId: "review_1",
            planId: input.plan.id,
            account: input.account,
            now: input.now,
            expiresAt: new Date("2026-05-15T00:00:30.000Z"),
            includeSharedObject: true
          });
          materialDigest = material.digest;
          return {
            status: "completed",
            evidence: material.handle,
            checks: [
              {
                id: "deepbook_transaction_material_build_or_verify",
                label: "Transaction material build or verify",
                status: "pass",
                message: "Local-only transaction material was produced for the review session.",
                source: "adapter"
              }
            ]
          };
        },
        deepbookTransactionMaterialDigestProducer: async () => {
          if (!materialDigest) {
            throw new Error("test material digest was not produced");
          }
          return {
            status: "completed",
            evidence: materialDigest,
            checks: [
              {
                id: "deepbook_transaction_material_digest_commitment",
                label: "Transaction material digest",
                status: "pass",
                message: "Digest commitment was derived from the stored material.",
                source: "adapter"
              }
            ]
          };
        },
        transactionObjectOwnershipProducer: createTransactionObjectOwnershipProducer({
          materialStore,
          objectSource: {
            async getObject(input) {
              if (input.objectId === `0x${"c".repeat(64)}`) {
                return {
                  object: {
                    objectId: input.objectId,
                    owner: {
                      $kind: "Shared",
                      Shared: { initialSharedVersion: "1" }
                    },
                    type: "0x2::clock::Clock"
                  }
                };
              }
              return {
                object: {
                  objectId: input.objectId,
                  owner: {
                    $kind: "AddressOwner",
                    AddressOwner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  type: "0x2::coin::Coin<0x2::sui::SUI>"
                }
              };
            }
          },
          network: "mainnet",
          chainIdentifier: "mainnet-chain",
          expectedChainIdentifier: "mainnet-chain"
        }),
        deepbookHumanReadableReviewProducer: createDeepbookSwapHumanReadableReviewProducer()
      })
    );

    expect(computed.state).toMatchObject({
      status: "blocked",
      blockedReason: "producer_stage_missing",
      adapterLifecycle: {
        completedStages: [
          "intent_normalized",
          "pool_resolved",
          "quote_evidence_fetched",
          "quote_policy_derived",
          "transaction_material_build_or_verify",
          "digest_commitment",
          "object_ownership",
          "human_readable_review"
        ],
        missingStages: ["review_time_simulation"]
      },
      humanReadableReview: {
        kind: "swap_human_readable_review",
        proposedAction: {
          adapterId: "deepbook-swap",
          protocol: "DeepBookV3"
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
          expect.objectContaining({ id: "no_signing_readiness" })
        ])
      }
    });
    expect(computed.privateArtifacts).toBeDefined();
    if (!computed.privateArtifacts) {
      throw new Error("expected private human-readable review artifacts");
    }
    expect(computed.privateArtifacts.humanReadableReview).toMatchObject({
      materialId: computed.privateArtifacts.transactionMaterial?.materialId,
      transactionDigest: computed.privateArtifacts.transactionMaterialDigest?.transactionDigest
    });
    expect(computed.state.checks.map((check) => check.id)).toContain("deepbook_human_readable_review_evidence");
    expect(computed.state.checks.at(-1)).toMatchObject({
      id: "deepbook_review_time_simulation_missing",
      status: "fail"
    });
    expect(JSON.stringify(computed.state)).not.toContain("transactionBytes");
    expect(JSON.stringify(computed.state)).not.toContain("txmat_");
    expect(JSON.stringify(computed.state)).not.toContain(computed.privateArtifacts?.humanReadableReview?.transactionDigest);
  });

  it.each(["complete", "missing_success"] as const)("maps %s simulation evidence into the review lifecycle and wallet contract", async (responseKind) => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    let materialDigest: Awaited<ReturnType<typeof recordTestTransactionMaterial>>["digest"] | undefined;
    const simulationClient = createSuccessfulReviewTimeSimulationClient(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    if (responseKind === "missing_success") {
      const simulate = simulationClient.transactionExecutionService.simulateTransaction;
      simulationClient.transactionExecutionService.simulateTransaction = async (request) => {
        const result = await simulate(request);
        delete result.response.transaction!.effects!.status!.success;
        return result;
      };
    }
    const computed = await computeReviewStateWithPrivateArtifacts(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        },
        deepbookTransactionMaterialProducer: async (input) => {
          const material = await recordTestTransactionMaterial({
            swap: input,
            materialStore,
            reviewSessionId: "review_1",
            planId: input.plan.id,
            account: input.account,
            now: input.now,
            expiresAt: new Date("2026-05-15T00:00:30.000Z"),
            includeSharedObject: true
          });
          materialDigest = material.digest;
          return {
            status: "completed",
            evidence: material.handle, ...(material.guardCommand !== undefined ? { guardCommand:material.guardCommand } : {}),
            checks: [
              {
                id: "deepbook_transaction_material_build_or_verify",
                label: "Transaction material build or verify",
                status: "pass",
                message: "Local-only transaction material was produced for the review session.",
                source: "adapter"
              }
            ]
          };
        },
        deepbookTransactionMaterialDigestProducer: async () => {
          if (!materialDigest) {
            throw new Error("test material digest was not produced");
          }
          return {
            status: "completed",
            evidence: materialDigest,
            checks: [
              {
                id: "deepbook_transaction_material_digest_commitment",
                label: "Transaction material digest",
                status: "pass",
                message: "Digest commitment was derived from the stored material.",
                source: "adapter"
              }
            ]
          };
        },
        transactionObjectOwnershipProducer: createTransactionObjectOwnershipProducer({
          materialStore,
          objectSource: {
            async getObject(input) {
              if (isFixtureSharedObject(input.objectId)) {
                return {
                  object: {
                    objectId: input.objectId,
                    owner: {
                      $kind: "Shared",
                      Shared: { initialSharedVersion: "1" }
                    },
                    type: "0x2::clock::Clock"
                  }
                };
              }
              return {
                object: {
                  objectId: input.objectId,
                  owner: {
                    $kind: "AddressOwner",
                    AddressOwner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  type: "0x2::coin::Coin<0x2::sui::SUI>"
                }
              };
            }
          },
          network: "mainnet",
          chainIdentifier: "mainnet-chain",
          expectedChainIdentifier: "mainnet-chain"
        }),
        deepbookHumanReadableReviewProducer: createDeepbookSwapHumanReadableReviewProducer(),
        reviewTimeSimulationProducer: createReviewTimeSimulationProducer({
          client: simulationClient,
          materialStore,
          network: "mainnet",
          chainIdentifier: "mainnet-chain",
          expectedChainIdentifier: "mainnet-chain"
        }),
        ptbVisualizationProducer: (vizInput) =>
          producePtbVisualizationArtifact({ materialStore, ...vizInput })
      })
    );

    if (responseKind === "missing_success") {
      expect(simulationClient.rpcCalls).toHaveLength(1);
      expect(computed.state).toMatchObject({
        status: "blocked", blockedReason: "object_resolution_failed",
        adapterLifecycle: {
          completedStages: ["intent_normalized", "pool_resolved", "quote_evidence_fetched", "quote_policy_derived",
            "transaction_material_build_or_verify", "digest_commitment", "object_ownership", "human_readable_review"],
          missingStages: ["review_time_simulation"]
        }
      });
      expect(computed.state.checks).toContainEqual({
        id: "review_time_simulation_result_invalid", label: "Review-time simulation", status: "fail",
        message: "Review-time simulation returned incomplete or unverifiable evidence. Nothing was signed or submitted.",
        source: "simulation"
      });
      expect(computed.state.transactionReviewData).toBeUndefined();
      expect(computed.state.simulation).toBeUndefined();
      expect(computed.privateArtifacts?.reviewTimeSimulation).toBeUndefined();
      expect(computed.privateArtifacts?.humanReadableReview).toBeDefined();
      return;
    }

    expect(computed.state).toMatchObject({
      status: "ready_for_wallet_review",
      adapterLifecycle: {
        completedStages: [
          "intent_normalized",
          "pool_resolved",
          "quote_evidence_fetched",
          "quote_policy_derived",
          "transaction_material_build_or_verify",
          "digest_commitment",
          "object_ownership",
          "human_readable_review",
          "review_time_simulation"
        ],
        missingStages: []
      },
      simulation: {
        provider: "client.transactionExecutionService.simulateTransaction",
        checksEnabled: true,
        success: true,
        gasCostSummary: {
          computationCostRaw: "100",
          storageCostRaw: "50",
          storageRebateRaw: "20",
          nonRefundableStorageFeeRaw: "0"
        }
      }
    });
    expect(computed.state.checks.map((check) => check.id)).toContain("review_time_simulation_evidence");
    expect(computed.state.checks.at(-1)).toMatchObject({
      id: "deepbook_wallet_review_contract_emitted",
      status: "pass"
    });
    expect(computed.privateArtifacts).toBeDefined();
    if (!computed.privateArtifacts) {
      throw new Error("expected private review-time simulation artifacts");
    }
    expect(computed.privateArtifacts.reviewTimeSimulation).toMatchObject({
      materialId: computed.privateArtifacts.transactionMaterial?.materialId,
      transactionDigest: computed.privateArtifacts.transactionMaterialDigest?.transactionDigest,
      status: "success"
    });
    const contract = computed.state.transactionReviewData;
    expect(contract).toBeDefined();
    if (!contract) {
      throw new Error("expected an emitted wallet review adapter contract");
    }
    const internalDigest = computed.privateArtifacts.transactionMaterialDigest?.transactionDigest;
    expect(contract.reviewedTransactionDigest).toBe(internalDigest);
    expect(contract.humanReadableReview.transactionDigest).toBe(internalDigest);
    expect(contract.simulation.transactionDigest).toBe(internalDigest);
    expect(contract.outputBoundary.prohibited).toContain("transaction_bytes");
    expect(computed.state.ptbVisualization?.mermaid.diagramType).toBe("flowchart");
    expect(computed.state.ptbVisualization?.source.authority).toBe("visualization_only_not_wallet_authorization");
    expect(computed.state.checks.map((check) => check.id)).toContain("deepbook_ptb_visualization");
    expect(simulationClient.calls[0]?.include).not.toHaveProperty("bcs");
    expect(JSON.stringify(computed.state)).not.toContain("transactionBytes");
    expect(JSON.stringify(computed.state)).not.toContain("txmat_");
    expect(computed.state.status).toBe("ready_for_wallet_review");
    expect(computed.state.blockedReason).toBeUndefined();
  });

  it("reports no completed lifecycle stages when DeepBook adapter data is invalid", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan: { ...plan, adapterData: {} },
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        }
      })
    );

    expect(state).toMatchObject({
      status: "blocked",
      blockedReason: "unsupported_action",
      adapterLifecycle: {
        stageCatalogId: "deepbook_swap_review_v1",
        completedStages: [],
        missingStages: expect.arrayContaining(["intent_normalized"])
      }
    });
  });

  it("blocks malformed DeepBook plan identity before lifecycle or quote work", async () => {
    const malformedPlans: ActionPlan[] = [
      { ...plan, protocol: "WrongProtocol" },
      { ...plan, actionKind: "stake" }
    ];

    for (const malformedPlan of malformedPlans) {
      let quoteCalled = false;
      const state = await computeReviewState(
        {
          reviewSessionId: "review_1",
          plan: malformedPlan,
          account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          now: new Date("2026-05-15T00:00:29.000Z")
        },
        withSupportedLifecycleValidator({
          deepbookQuoteSource: {
            quoteDeepbookDisplayAmount: async () => {
              quoteCalled = true;
              return deepbookDisplayQuote();
            }
          }
        })
      );

      expect(state).toMatchObject({
        status: "blocked",
        blockedReason: "unsupported_action",
        checks: [
          {
            id: "deepbook_swap_plan_identity_invalid",
            status: "fail",
            source: "adapter"
          }
        ]
      });
      expect(state).not.toHaveProperty("adapterLifecycle");
      expect(quoteCalled).toBe(false);
    }
  });

  it("reports only intent normalization when DeepBook pool resolution fails", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan: planWithSymbols("NOPE", "USDC"),
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        }
      })
    );

    expect(state).toMatchObject({
      status: "blocked",
      blockedReason: "asset_mismatch",
      adapterLifecycle: {
        stageCatalogId: "deepbook_swap_review_v1",
        completedStages: ["intent_normalized"],
        missingStages: expect.arrayContaining(["pool_resolved", "quote_evidence_fetched"])
      }
    });
  });

  it("reports quote evidence as missing when the DeepBook quote source is unavailable", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => {
            throw new ReadServiceInputError("quote_unavailable", "quote unavailable", {});
          }
        }
      })
    );

    expect(state).toMatchObject({
      status: "refresh_required",
      refreshReason: "quote_unavailable",
      adapterLifecycle: {
        stageCatalogId: "deepbook_swap_review_v1",
        completedStages: ["intent_normalized", "pool_resolved"],
      missingStages: expect.arrayContaining(["quote_evidence_fetched", "quote_policy_derived"])
      }
    });
  });

  it("blocks unknown quote source errors instead of marking them refreshable", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:29.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => {
            throw new Error("quote adapter request shape bug");
          }
        }
      })
    );

    expect(state).toMatchObject({
      status: "blocked",
      blockedReason: "object_resolution_failed",
      adapterLifecycle: {
        stageCatalogId: "deepbook_swap_review_v1",
        completedStages: ["intent_normalized", "pool_resolved"],
        missingStages: expect.arrayContaining(["quote_evidence_fetched", "quote_policy_derived"])
      },
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "deepbook_quote_source_failed",
          status: "fail",
          source: "quote"
        })
      ])
    });
  });

  it("returns refresh_required when the refreshed quote evidence is stale by policy time", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date("2026-05-15T00:00:31.000Z")
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () => deepbookDisplayQuote()
        }
      })
    );

    expect(state.status).toBe("refresh_required");
    expect(state).toMatchObject({
      refreshReason: "quote_stale"
    });
    expect(state.checks.at(-1)).toMatchObject({
      id: "deepbook_quote_policy_refresh_required",
      status: "fail",
      source: "quote"
    });
    expect(state.adapterLifecycle).toMatchObject({
      stageCatalogId: "deepbook_swap_review_v1",
      completedStages: [
        "intent_normalized",
        "pool_resolved",
        "quote_evidence_fetched"
      ],
      missingStages: expect.arrayContaining(["quote_policy_derived"])
    });
  });

  it("uses a policy timestamp after quote refresh when no test time is injected", async () => {
    const state = await computeReviewState(
      {
        reviewSessionId: "review_1",
        plan,
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      withSupportedLifecycleValidator({
        deepbookQuoteSource: {
          quoteDeepbookDisplayAmount: async () =>
            deepbookDisplayQuote({ fetchedAt: new Date(Date.now() - 1_000).toISOString() })
        }
      })
    );

    expect(state.status).toBe("blocked");
    expect(state).toMatchObject({ blockedReason: "producer_stage_missing" });
    expect(JSON.stringify(state)).not.toContain("quote_timestamp_in_future");
  });
});

function planWithSymbols(sourceSymbol: string, targetSymbol: string): ActionPlan {
  return {
    ...plan,
    adapterData: {
      requestedIntent: {
        type: "swap",
        from: {
          symbol: sourceSymbol,
          amountDisplay: "1"
        },
        to: {
          symbol: targetSymbol
        },
        maxSlippageBps: 50
      }
    }
  };
}
