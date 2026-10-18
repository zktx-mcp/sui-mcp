import { describe, expect, it } from "vitest";
import { assertNoForbiddenMcpFields } from "../src/core/action/forbiddenFields.js";
import {
  CONSUMER_INVARIANT_MATRIX,
  PTB_VISUALIZATION_CONTRACT_VERSION,
  PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES,
  SAFETY_CRITICAL_FACT_MATRIX,
  SUI_GAS_COIN_TYPE,
  TRANSACTION_REVIEW_SCHEMA_VERSION,
  WALLET_REVIEW_REQUIRED_HUMAN_FIELDS,
  WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS,
  WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS,
  ptbVisualizationArtifactSchema,
  transactionReviewDataSchema
} from "../src/core/action/signableAdapterContract.js";

const now = "2026-05-25T00:00:00.000Z";
const account = `0x${"a".repeat(64)}`;
const coinType = `0x${"b".repeat(64)}::coin::USDC`;
const suiCoinType = SUI_GAS_COIN_TYPE;
const objectId = `0x${"c".repeat(64)}`;
const gasObjectId = `0x${"d".repeat(64)}`;
// Two distinct valid Sui transaction digests (isValidTransactionDigest === true),
// used to test the commitment equality gate without re-confirming an invented format.
const commitmentDigest = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const otherCommitmentDigest = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

function sourceReferencesById(candidate: any, id: string) {
  return candidate.sourceReferences.find((source: { id: string }) => source.id === id);
}

function evidenceClaimById(candidate: any, id: string) {
  return candidate.evidenceClaims.find((claim: { id: string }) => claim.id === id);
}

function walletReviewContractFixture() {
  return {
    schemaVersion: TRANSACTION_REVIEW_SCHEMA_VERSION,
    adapterId: "deepbook-swap",
    protocol: "DeepBookV3",
    actionKind: "swap",
    network: "sui:mainnet",
    inputProvenance: {
      kind: "mcp_action_request",
      sourceId: "review_1",
      capturedAt: now,
      authority: "untrusted_until_review_regenerates_and_verifies",
      userSelectionSource: "user_explicit"
    },
    sourceReferences: [
      {
        id: "coin_metadata",
        kind: "pinned_sdk_registry",
        network: "sui:mainnet",
        source: "@mysten/deepbook-v3 mainnetCoins",
        verifiedAt: now,
        fields: ["coinType", "decimals"]
      },
      {
        id: "requested_source_amount",
        kind: "user_explicit_choice",
        network: "sui:mainnet",
        source: "user-selected source amount captured before local review",
        verifiedAt: now,
        fields: ["rawAmount", "asset", "amountRole", "userSelection"]
      },
      {
        id: "simulation",
        kind: "review_time_simulation",
        network: "sui:mainnet",
        source: "client.core.simulateTransaction",
        verifiedAt: now,
        fields: [
          ...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS,
          "gasBudgetRaw",
          "gasUsedRaw",
          "asset",
          "amountRole"
        ]
      },
      {
        id: "quote_policy",
        kind: "quote_evidence",
        network: "sui:mainnet",
        source: "adapter min-out policy derived from raw quote evidence",
        verifiedAt: now,
        fields: ["minOutRaw", "maxSlippageBps"]
      },
      {
        id: "user_slippage_policy",
        kind: "user_explicit_choice",
        network: "sui:mainnet",
        source: "user-selected maximum slippage policy captured before local review",
        verifiedAt: now,
        fields: ["maxSlippageBps", "userSelection"]
      },
      {
        id: "proposal_freshness",
        kind: "validated_request_fact",
        network: "sui:mainnet",
        source: "request expiry checked against the local review clock",
        verifiedAt: now,
        fields: ["expiresAt", "checkedAt"]
      },
      {
        id: "raw_quote",
        kind: "quote_evidence",
        network: "sui:mainnet",
        source: "DeepBook raw quote evidence",
        verifiedAt: now,
        fields: ["quoteEvidenceId", "minOutRaw", "asset", "amountRole"]
      },
      {
        id: "sui_coin_metadata",
        kind: "verified_mainnet_onchain_metadata",
        network: "sui:mainnet",
        source: "client.core.getCoinMetadata",
        verifiedAt: now,
        fields: ["coinType", "decimals"]
      },
      {
        id: "wallet_account_read",
        kind: "wallet_account_read",
        network: "sui:mainnet",
        source: "account-bound object ownership read",
        verifiedAt: now,
        fields: ["ownerAccount", "objects"]
      }
    ],
    evidenceClaims: [
      {
        id: "source_amount_claim",
        factKind: "raw_quantity_amount",
        sourceEvidenceId: "requested_source_amount",
        role: "input",
        asset: { symbol: "USDC", coinType },
        rawAmount: "1000000"
      },
      {
        id: "source_unit_claim",
        factKind: "unit_metadata",
        sourceEvidenceId: "coin_metadata",
        source: "pinned_sdk_metadata",
        coinType,
        decimals: 6
      },
      {
        id: "min_out_claim",
        factKind: "raw_quantity_amount",
        sourceEvidenceId: "raw_quote",
        role: "minimum_output",
        asset: { symbol: "SUI", coinType: suiCoinType },
        rawAmount: "1000"
      },
      {
        id: "min_out_unit_claim",
        factKind: "unit_metadata",
        sourceEvidenceId: "sui_coin_metadata",
        source: "verified_mainnet_onchain_metadata",
        coinType: suiCoinType,
        decimals: 9
      },
      {
        id: "gas_budget_claim",
        factKind: "raw_quantity_amount",
        sourceEvidenceId: "simulation",
        role: "gas_budget",
        asset: { symbol: "SUI", coinType: suiCoinType },
        rawAmount: "10000000"
      },
      {
        id: "gas_used_claim",
        factKind: "raw_quantity_amount",
        sourceEvidenceId: "simulation",
        role: "gas_used",
        asset: { symbol: "SUI", coinType: suiCoinType },
        rawAmount: "1000"
      },
      {
        id: "quote_min_out_claim",
        factKind: "quote_min_out",
        sourceEvidenceId: "raw_quote",
        quoteEvidenceId: "quote_1",
        minOutRaw: "1000"
      },
      {
        id: "user_slippage_policy_claim",
        factKind: "slippage_policy",
        sourceEvidenceId: "user_slippage_policy",
        policySource: "user_explicit",
        maxSlippageBps: 50
      },
      {
        id: "expiry_claim",
        factKind: "expiry_status",
        sourceEvidenceId: "proposal_freshness",
        checkedAt: now,
        status: "current",
        expiresAt: "2026-05-25T00:10:00.000Z"
      },
      {
        id: "input_ownership_claim",
        factKind: "object_ownership",
        sourceEvidenceId: "wallet_account_read",
        objectId,
        ownerAccount: account,
        ownership: "owned_by_account"
      },
      {
        id: "gas_ownership_claim",
        factKind: "object_ownership",
        sourceEvidenceId: "wallet_account_read",
        objectId: gasObjectId,
        ownerAccount: account,
        ownership: "owned_by_account"
      },
      {
        id: "simulation_claim",
        factKind: "simulation_result",
        sourceEvidenceId: "simulation",
        provider: "client.core.simulateTransaction",
        checksEnabled: true,
        simulatedAt: now,
        status: "success",
        requiredFields: [...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS],
        missingFields: []
      }
    ],
    rawQuantities: [
      {
        id: "source_amount",
        role: "input",
        asset: { symbol: "USDC", coinType },
        rawAmount: "1000000",
        unit: {
          decimals: 6,
          source: "pinned_sdk_metadata",
          sourceField: "mainnetCoins.scalar",
          unitClaimId: "source_unit_claim"
        },
        amountClaimId: "source_amount_claim",
        displayOnly: {
          amountDisplay: "1",
          reason: "presentation_only_not_signing_input"
        }
      },
      {
        id: "min_out",
        role: "minimum_output",
        asset: { symbol: "SUI", coinType: suiCoinType },
        rawAmount: "1000",
        unit: {
          decimals: 9,
          source: "verified_mainnet_onchain_metadata",
          sourceField: "client.core.getCoinMetadata.decimals",
          unitClaimId: "min_out_unit_claim"
        },
        amountClaimId: "min_out_claim"
      }
    ],
    gas: {
      source: "review_time_simulation",
      checkedAt: now,
      gasBudgetRaw: "10000000",
      gasBudgetClaimId: "gas_budget_claim",
      gasUsedRaw: "1000",
      gasUsedClaimId: "gas_used_claim",
      gasObjects: [
        {
          objectId: gasObjectId,
          ownerAccount: account,
          ownershipClaimId: "gas_ownership_claim"
        }
      ]
    },
    expiry: {
      checkedAt: now,
      status: "current",
      expiresAt: "2026-05-25T00:10:00.000Z",
      evidenceClaimId: "expiry_claim"
    },
    slippageOrMinOut: {
      status: "required_and_verified",
      quoteEvidenceId: "quote_1",
      quoteEvidenceClaimId: "quote_min_out_claim",
      maxSlippageBps: 50,
      minOutRaw: "1000",
      policySource: "user_explicit",
      policyEvidenceClaimId: "user_slippage_policy_claim"
    },
    objectOwnership: {
      checkedAt: now,
      ownerAccount: account,
      objects: [
        {
          objectId,
          role: "input_coin",
          ownership: "owned_by_account",
          evidenceClaimId: "input_ownership_claim"
        }
      ]
    },
    simulation: {
      evidenceClaimId: "simulation_claim",
      transactionDigest: commitmentDigest,
      provider: "client.core.simulateTransaction",
      checksEnabled: true,
      simulatedAt: now,
      status: "success",
      requiredFields: [...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS],
      missingFields: []
    },
    humanReadableReview: {
      fields: [...WALLET_REVIEW_REQUIRED_HUMAN_FIELDS],
      transactionDigest: commitmentDigest,
      source: "review_model_or_adapter_equivalent",
      purpose: "human_review_before_wallet_authorization"
    },
    outputBoundary: {
      runtimeStatus: "emitted_pre_handoff",
      mcpAndReviewUiMayExpose: [
        "human_readable_review",
        "ptb_visualization_artifact",
        "diagnostics",
        "status_checks"
      ],
      prohibited: [
        ...WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS
      ]
    },
    reviewedTransactionDigest: commitmentDigest
  };
}

function ptbVisualizationFixture() {
  return {
    contractVersion: PTB_VISUALIZATION_CONTRACT_VERSION,
    artifactKind: "ptb_visualization",
    generatedAt: now,
    source: {
      adapterId: "deepbook-swap",
      planId: "plan_1",
      sourceKind: "review_time_ir",
      authority: "visualization_only_not_wallet_authorization",
      renderer: {
        name: "fixture renderer",
        packageName: "fixture-renderer",
        version: "0.0.0-test"
      }
    },
    mermaid: {
      diagramType: "flowchart",
      text: "flowchart TD\n  sender[Sender]\n  quote[Quote policy]\n  simulate[Simulation]\n  sender --> quote --> simulate",
      namedText: "flowchart TD\n  sender[Sender]\n  quote[Quote policy]\n  simulate[Simulation]\n  sender --> quote --> simulate"
    },
    diagnostics: [
      {
        severity: "info",
        code: "renderer_candidate_deferred",
        message: "Renderer output is visualization evidence only.",
        source: "renderer"
      }
    ],
    unsupportedUse: [
      ...PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES
    ],
    executableMaterial: {
      included: false,
      policy: "mcp_and_review_ui_outputs_must_not_include_executable_transaction_material"
    }
  };
}

describe("signable adapter and PTB visualization contract", () => {
  it("accepts a contract whose review, simulation, and handoff commitments are equal", () => {
    expect(transactionReviewDataSchema.safeParse(walletReviewContractFixture()).success).toBe(true);
  });

  it("rejects a contract missing the transaction material commitment", () => {
    const missingCommitment = walletReviewContractFixture();
    delete (missingCommitment as { reviewedTransactionDigest?: unknown }).reviewedTransactionDigest;
    const result = transactionReviewDataSchema.safeParse(missingCommitment);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "reviewedTransactionDigest")).toBe(true);
    }
  });

  it("rejects a contract whose commitment is not a valid Sui transaction digest", () => {
    const invalidDigest = walletReviewContractFixture();
    invalidDigest.reviewedTransactionDigest = "e".repeat(64);
    invalidDigest.simulation.transactionDigest = "e".repeat(64);
    invalidDigest.humanReadableReview.transactionDigest = "e".repeat(64);
    expect(transactionReviewDataSchema.safeParse(invalidDigest).success).toBe(false);
  });

  it("rejects a contract whose simulation commitment differs from the handoff commitment", () => {
    const mismatch = walletReviewContractFixture();
    mismatch.simulation.transactionDigest = otherCommitmentDigest;
    const result = transactionReviewDataSchema.safeParse(mismatch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "simulation.transactionDigest")).toBe(true);
    }
  });

  it("rejects a contract whose human-readable review commitment differs from the handoff commitment", () => {
    const mismatch = walletReviewContractFixture();
    mismatch.humanReadableReview.transactionDigest = otherCommitmentDigest;
    const result = transactionReviewDataSchema.safeParse(mismatch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "humanReadableReview.transactionDigest")).toBe(true);
    }
  });

  it("defines a contract-only wallet-review evidence shape without forbidden MCP field names", () => {
    const contract = transactionReviewDataSchema.parse(walletReviewContractFixture());

    expect(contract.outputBoundary.runtimeStatus).toBe("emitted_pre_handoff");
    expect(contract.outputBoundary.prohibited).toEqual(
      expect.arrayContaining([
        ...WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS
      ])
    );
    expect(contract.humanReadableReview.fields).toEqual(
      expect.arrayContaining([...WALLET_REVIEW_REQUIRED_HUMAN_FIELDS])
    );
    expect(contract.simulation.requiredFields).toEqual(
      expect.arrayContaining([...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS])
    );
    expect(Object.keys(SAFETY_CRITICAL_FACT_MATRIX)).toEqual(
      expect.arrayContaining(["raw_quantity_amount", "unit_metadata", "gas_unresolved_status", "simulation_result"])
    );
    expect(CONSUMER_INVARIANT_MATRIX.gasBudgetClaimId).toMatchObject({
      role: "gas_budget",
      assetCoinType: SUI_GAS_COIN_TYPE,
      rawUnit: "MIST"
    });
    expect(CONSUMER_INVARIANT_MATRIX.gasObjectOwnershipClaimId).toMatchObject({
      ownership: "owned_by_account"
    });
    expect(contract.evidenceClaims.map((claim) => claim.factKind)).toEqual(
      expect.arrayContaining(["raw_quantity_amount", "unit_metadata", "quote_min_out", "slippage_policy", "expiry_status", "object_ownership", "simulation_result"])
    );
    expect(() => assertNoForbiddenMcpFields(contract)).not.toThrow();
  });

  it("rejects display-like text, floating-point text, and invalid coin types as raw quantities", () => {
    for (const rawAmount of ["1.5", "1e3", "-1", " 1", "1 SUI"]) {
      const candidate = walletReviewContractFixture();
      candidate.rawQuantities = [{
        ...candidate.rawQuantities[0]!,
        rawAmount
      }, ...candidate.rawQuantities.slice(1)];

      expect(transactionReviewDataSchema.safeParse(candidate).success).toBe(false);
    }

    const symbolOnlyAsset = walletReviewContractFixture() as any;
    delete symbolOnlyAsset.rawQuantities[0].asset.coinType;
    expect(transactionReviewDataSchema.safeParse(symbolOnlyAsset).success).toBe(false);

    for (const invalidCoinType of ["USDC", "0x2::sui::SUI", "not-a-coin-type"]) {
      const invalidSourceCoinType = walletReviewContractFixture() as any;
      invalidSourceCoinType.rawQuantities[0].asset.coinType = invalidCoinType;
      evidenceClaimById(invalidSourceCoinType, "source_amount_claim").asset.coinType = invalidCoinType;
      evidenceClaimById(invalidSourceCoinType, "source_unit_claim").coinType = invalidCoinType;
      expect(transactionReviewDataSchema.safeParse(invalidSourceCoinType).success).toBe(false);
    }
  });

  it("requires verified min-out policy, complete simulation fields, and human review fields", () => {
    const missingMinOut = walletReviewContractFixture() as any;
    missingMinOut.slippageOrMinOut = {
      status: "required_and_verified",
      quoteEvidenceId: "quote_1",
      quoteEvidenceClaimId: "quote_min_out_claim",
      maxSlippageBps: 50
    };
    expect(transactionReviewDataSchema.safeParse(missingMinOut).success).toBe(false);

    const missingSimulationField = walletReviewContractFixture() as any;
    missingSimulationField.simulation = {
      ...missingSimulationField.simulation,
      requiredFields: ["effects", "balanceChanges", "transaction"]
    };
    expect(transactionReviewDataSchema.safeParse(missingSimulationField).success).toBe(false);

    const missingHumanField = walletReviewContractFixture() as any;
    missingHumanField.humanReadableReview = {
      ...missingHumanField.humanReadableReview,
      fields: WALLET_REVIEW_REQUIRED_HUMAN_FIELDS.filter((field) => field !== "unsupportedClaims")
    };
    expect(transactionReviewDataSchema.safeParse(missingHumanField).success).toBe(false);
  });

  it("rejects slippage and min-out scalars without typed evidence claims", () => {
    const minOutWithoutClaim = walletReviewContractFixture() as any;
    delete minOutWithoutClaim.slippageOrMinOut.quoteEvidenceId;
    delete minOutWithoutClaim.slippageOrMinOut.quoteEvidenceClaimId;
    minOutWithoutClaim.slippageOrMinOut.status = "stale";
    expect(transactionReviewDataSchema.safeParse(minOutWithoutClaim).success).toBe(false);

    const slippageWithoutClaim = walletReviewContractFixture() as any;
    delete slippageWithoutClaim.slippageOrMinOut.policySource;
    delete slippageWithoutClaim.slippageOrMinOut.policyEvidenceClaimId;
    slippageWithoutClaim.slippageOrMinOut.status = "stale";
    expect(transactionReviewDataSchema.safeParse(slippageWithoutClaim).success).toBe(false);

    const minOutWithoutRawQuantity = walletReviewContractFixture() as any;
    minOutWithoutRawQuantity.rawQuantities = minOutWithoutRawQuantity.rawQuantities.filter(
      (quantity: { role: string }) => quantity.role !== "minimum_output"
    );
    expect(transactionReviewDataSchema.safeParse(minOutWithoutRawQuantity).success).toBe(false);
  });

  it("requires all evidence claim ids to resolve to typed evidence claims", () => {
    const cases: Array<[string, (candidate: any) => void]> = [
      ["raw quantity amount claim", (candidate) => {
        candidate.rawQuantities[1].amountClaimId = "missing_min_out_claim";
      }],
      ["raw quantity unit claim", (candidate) => {
        candidate.rawQuantities[0].unit.unitClaimId = "missing_source_unit_claim";
      }],
      ["gas budget claim", (candidate) => {
        candidate.gas.gasBudgetClaimId = "missing_gas_budget_claim";
      }],
      ["gas used claim", (candidate) => {
        candidate.gas.gasUsedClaimId = "missing_gas_used_claim";
      }],
      ["gas object ownership claim", (candidate) => {
        candidate.gas.gasObjects[0].ownershipClaimId = "missing_gas_ownership_claim";
      }],
      ["expiry claim", (candidate) => {
        candidate.expiry.evidenceClaimId = "missing_expiry_claim";
      }],
      ["quote min-out claim", (candidate) => {
        candidate.slippageOrMinOut.quoteEvidenceClaimId = "missing_quote_claim";
      }],
      ["slippage policy claim", (candidate) => {
        candidate.slippageOrMinOut.policyEvidenceClaimId = "missing_user_policy_claim";
      }],
      ["object ownership claim", (candidate) => {
        candidate.objectOwnership.objects[0].evidenceClaimId = "missing_wallet_read_claim";
      }],
      ["simulation claim", (candidate) => {
        candidate.simulation.evidenceClaimId = "missing_simulation_claim";
      }]
    ];

    for (const [, mutate] of cases) {
      const candidate = walletReviewContractFixture() as any;
      mutate(candidate);
      expect(transactionReviewDataSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("requires every evidence claim to resolve to sourceReferences", () => {
    const missingClaimSource = walletReviewContractFixture() as any;
    evidenceClaimById(missingClaimSource, "source_amount_claim").sourceEvidenceId = "missing_source";

    expect(transactionReviewDataSchema.safeParse(missingClaimSource).success).toBe(false);
  });

  it("requires source evidence kind and fields to match each safety-critical fact", () => {
    const rawAmountFromMetadata = walletReviewContractFixture() as any;
    evidenceClaimById(rawAmountFromMetadata, "source_amount_claim").sourceEvidenceId = "coin_metadata";
    expect(transactionReviewDataSchema.safeParse(rawAmountFromMetadata).success).toBe(false);

    const rawAmountMissingFields = walletReviewContractFixture() as any;
    sourceReferencesById(rawAmountMissingFields, "requested_source_amount").fields = ["asset", "amountRole"];
    expect(transactionReviewDataSchema.safeParse(rawAmountMissingFields).success).toBe(false);

    const unitFromUserChoice = walletReviewContractFixture() as any;
    evidenceClaimById(unitFromUserChoice, "source_unit_claim").sourceEvidenceId = "requested_source_amount";
    expect(transactionReviewDataSchema.safeParse(unitFromUserChoice).success).toBe(false);

    const minOutFromMetadata = walletReviewContractFixture() as any;
    evidenceClaimById(minOutFromMetadata, "min_out_claim").sourceEvidenceId = "coin_metadata";
    expect(transactionReviewDataSchema.safeParse(minOutFromMetadata).success).toBe(false);

    const gasBudgetMissingFields = walletReviewContractFixture() as any;
    sourceReferencesById(gasBudgetMissingFields, "simulation").fields = [
      ...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS,
      "gasUsedRaw",
      "asset",
      "amountRole"
    ];
    expect(transactionReviewDataSchema.safeParse(gasBudgetMissingFields).success).toBe(false);

    const userPolicyFromQuoteEvidence = walletReviewContractFixture() as any;
    evidenceClaimById(userPolicyFromQuoteEvidence, "user_slippage_policy_claim").sourceEvidenceId = "quote_policy";
    expect(transactionReviewDataSchema.safeParse(userPolicyFromQuoteEvidence).success).toBe(false);

    const userPolicyMissingChoice = walletReviewContractFixture() as any;
    sourceReferencesById(userPolicyMissingChoice, "user_slippage_policy").fields = ["maxSlippageBps"];
    expect(transactionReviewDataSchema.safeParse(userPolicyMissingChoice).success).toBe(false);

    const adapterPolicyFromQuoteEvidence = walletReviewContractFixture() as any;
    adapterPolicyFromQuoteEvidence.slippageOrMinOut = {
      ...adapterPolicyFromQuoteEvidence.slippageOrMinOut,
      policySource: "adapter_policy_from_quote_evidence"
    };
    evidenceClaimById(adapterPolicyFromQuoteEvidence, "user_slippage_policy_claim").sourceEvidenceId = "quote_policy";
    evidenceClaimById(adapterPolicyFromQuoteEvidence, "user_slippage_policy_claim").policySource = "adapter_policy_from_quote_evidence";
    evidenceClaimById(adapterPolicyFromQuoteEvidence, "user_slippage_policy_claim").minOutRaw = "1000";
    expect(transactionReviewDataSchema.safeParse(adapterPolicyFromQuoteEvidence).success).toBe(true);
  });

  it("rejects payload values that do not match their typed evidence claims", () => {
    const cases: Array<[string, (candidate: any) => void]> = [
      ["raw quantity amount", (candidate) => {
        evidenceClaimById(candidate, "source_amount_claim").rawAmount = "999";
      }],
      ["raw quantity asset", (candidate) => {
        evidenceClaimById(candidate, "source_amount_claim").asset.symbol = "SUI";
      }],
      ["unit decimals", (candidate) => {
        evidenceClaimById(candidate, "source_unit_claim").decimals = 9;
      }],
      ["gas budget", (candidate) => {
        evidenceClaimById(candidate, "gas_budget_claim").rawAmount = "999";
      }],
      ["gas used", (candidate) => {
        evidenceClaimById(candidate, "gas_used_claim").role = "gas_budget";
      }],
      ["expiry", (candidate) => {
        evidenceClaimById(candidate, "expiry_claim").expiresAt = "2026-05-25T00:20:00.000Z";
      }],
      ["quote min-out", (candidate) => {
        evidenceClaimById(candidate, "quote_min_out_claim").minOutRaw = "999";
      }],
      ["slippage policy", (candidate) => {
        evidenceClaimById(candidate, "user_slippage_policy_claim").maxSlippageBps = 51;
      }],
      ["object ownership", (candidate) => {
        evidenceClaimById(candidate, "input_ownership_claim").ownership = "not_owned_by_account";
      }],
      ["simulation", (candidate) => {
        evidenceClaimById(candidate, "simulation_claim").status = "failed";
        evidenceClaimById(candidate, "simulation_claim").failureReason = "claim differs from payload";
      }]
    ];

    for (const [, mutate] of cases) {
      const candidate = walletReviewContractFixture() as any;
      mutate(candidate);
      expect(transactionReviewDataSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("requires gas quantities to pass the raw amount claim matrix", () => {
    const missingGasClaim = walletReviewContractFixture() as any;
    delete missingGasClaim.gas.gasBudgetClaimId;
    expect(transactionReviewDataSchema.safeParse(missingGasClaim).success).toBe(false);

    const wrongGasClaimRole = walletReviewContractFixture() as any;
    wrongGasClaimRole.gas.gasBudgetClaimId = "min_out_claim";
    expect(transactionReviewDataSchema.safeParse(wrongGasClaimRole).success).toBe(false);

    const unresolved = walletReviewContractFixture() as any;
    sourceReferencesById(unresolved, "simulation").fields = [
      ...WALLET_REVIEW_REQUIRED_SIMULATION_FIELDS,
      "checkedAt",
      "gasResolutionStatus",
      "unresolvedReason"
    ];
    unresolved.evidenceClaims = unresolved.evidenceClaims.filter(
      (claim: { id: string }) => !["gas_budget_claim", "gas_used_claim"].includes(claim.id)
    );
    unresolved.evidenceClaims.push({
      id: "gas_unresolved_claim",
      factKind: "gas_unresolved_status",
      sourceEvidenceId: "simulation",
      checkedAt: now,
      status: "unresolved",
      reason: "Review-time simulation did not return gas quantities."
    });
    unresolved.gas = {
      source: "review_time_simulation",
      checkedAt: now,
      unresolvedReason: "Review-time simulation did not return gas quantities.",
      unresolvedClaimId: "gas_unresolved_claim"
    };
    expect(transactionReviewDataSchema.safeParse(unresolved).success).toBe(true);
  });

  it("requires gas consumer claims to use SUI gas assets and owned gas objects", () => {
    const wrongBudgetAsset = walletReviewContractFixture() as any;
    evidenceClaimById(wrongBudgetAsset, "gas_budget_claim").asset = { symbol: "USDC", coinType };
    expect(transactionReviewDataSchema.safeParse(wrongBudgetAsset).success).toBe(false);

    const wrongUsedAsset = walletReviewContractFixture() as any;
    evidenceClaimById(wrongUsedAsset, "gas_used_claim").asset = { symbol: "USDC", coinType };
    expect(transactionReviewDataSchema.safeParse(wrongUsedAsset).success).toBe(false);

    const nonOwnedGasObject = walletReviewContractFixture() as any;
    evidenceClaimById(nonOwnedGasObject, "gas_ownership_claim").ownership = "not_owned_by_account";
    expect(transactionReviewDataSchema.safeParse(nonOwnedGasObject).success).toBe(false);
  });

  it("requires status-specific expiry evidence and source fields", () => {
    const missingExpiresAt = walletReviewContractFixture() as any;
    delete missingExpiresAt.expiry.expiresAt;
    expect(transactionReviewDataSchema.safeParse(missingExpiresAt).success).toBe(false);

    const missingClaim = walletReviewContractFixture() as any;
    delete missingClaim.expiry.evidenceClaimId;
    expect(transactionReviewDataSchema.safeParse(missingClaim).success).toBe(false);

    const currentAlreadyExpired = walletReviewContractFixture() as any;
    currentAlreadyExpired.expiry.expiresAt = now;
    expect(transactionReviewDataSchema.safeParse(currentAlreadyExpired).success).toBe(false);

    const expiredInFuture = walletReviewContractFixture() as any;
    expiredInFuture.expiry = {
      ...expiredInFuture.expiry,
      status: "expired",
      expiresAt: "2026-05-25T00:10:00.000Z"
    };
    expect(transactionReviewDataSchema.safeParse(expiredInFuture).success).toBe(false);

    const sourceMissingRequiredField = walletReviewContractFixture() as any;
    sourceReferencesById(sourceMissingRequiredField, "proposal_freshness").fields = ["checkedAt"];
    expect(transactionReviewDataSchema.safeParse(sourceMissingRequiredField).success).toBe(false);

    for (const status of ["not_provided", "not_applicable"]) {
      const unavailableWithExpiresAt = walletReviewContractFixture() as any;
      sourceReferencesById(unavailableWithExpiresAt, "proposal_freshness").fields = ["checkedAt", "expiryStatus"];
      unavailableWithExpiresAt.expiry = {
        checkedAt: now,
        status,
        evidenceClaimId: "expiry_claim",
        reason: "Expiry timestamp evidence is unavailable for this reviewed request.",
        expiresAt: "2026-05-25T00:10:00.000Z"
      };
      evidenceClaimById(unavailableWithExpiresAt, "expiry_claim").status = status;
      evidenceClaimById(unavailableWithExpiresAt, "expiry_claim").reason = "Expiry timestamp evidence is unavailable for this reviewed request.";
      expect(transactionReviewDataSchema.safeParse(unavailableWithExpiresAt).success).toBe(false);

      const unavailableWithoutReason = walletReviewContractFixture() as any;
      sourceReferencesById(unavailableWithoutReason, "proposal_freshness").fields = ["checkedAt", "expiryStatus"];
      unavailableWithoutReason.expiry = {
        checkedAt: now,
        status,
        evidenceClaimId: "expiry_claim"
      };
      evidenceClaimById(unavailableWithoutReason, "expiry_claim").status = status;
      delete evidenceClaimById(unavailableWithoutReason, "expiry_claim").expiresAt;
      expect(transactionReviewDataSchema.safeParse(unavailableWithoutReason).success).toBe(false);

      const unavailable = walletReviewContractFixture() as any;
      sourceReferencesById(unavailable, "proposal_freshness").fields = ["checkedAt", "expiryStatus"];
      unavailable.expiry = {
        checkedAt: now,
        status,
        evidenceClaimId: "expiry_claim",
        reason: "Expiry timestamp evidence is unavailable for this reviewed request."
      };
      evidenceClaimById(unavailable, "expiry_claim").status = status;
      evidenceClaimById(unavailable, "expiry_claim").reason = "Expiry timestamp evidence is unavailable for this reviewed request.";
      delete evidenceClaimById(unavailable, "expiry_claim").expiresAt;
      expect(transactionReviewDataSchema.safeParse(unavailable).success).toBe(true);
    }
  });

  it("requires sourceReferences and evidence claim ids to be unique", () => {
    const duplicateSource = walletReviewContractFixture() as any;
    duplicateSource.sourceReferences[1].id = duplicateSource.sourceReferences[0].id;
    expect(transactionReviewDataSchema.safeParse(duplicateSource).success).toBe(false);

    const duplicateClaim = walletReviewContractFixture() as any;
    duplicateClaim.evidenceClaims[1].id = duplicateClaim.evidenceClaims[0].id;
    expect(transactionReviewDataSchema.safeParse(duplicateClaim).success).toBe(false);
  });

  it("requires every prohibited output boundary to be present", () => {
    const candidate = walletReviewContractFixture() as any;
    candidate.outputBoundary.prohibited = WALLET_REVIEW_REQUIRED_PROHIBITED_OUTPUTS.filter(
      (value) => value !== "signing_readiness"
    );

    expect(transactionReviewDataSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires failed or unavailable simulation evidence to explain why it blocks review", () => {
    for (const status of ["failed", "unavailable"]) {
      const candidate = walletReviewContractFixture() as any;
      candidate.simulation = {
        ...candidate.simulation,
        status
      };

      expect(transactionReviewDataSchema.safeParse(candidate).success).toBe(false);
    }

    const successWithReason = walletReviewContractFixture() as any;
    successWithReason.simulation = {
      ...successWithReason.simulation,
      failureReason: "should not be present on a successful simulation"
    };

    expect(transactionReviewDataSchema.safeParse(successWithReason).success).toBe(false);

    const claimWithoutReason = walletReviewContractFixture() as any;
    evidenceClaimById(claimWithoutReason, "simulation_claim").status = "failed";
    expect(transactionReviewDataSchema.safeParse(claimWithoutReason).success).toBe(false);
  });

  it("defines PTB visualization as Mermaid diagnostics only, not executable material", () => {
    const artifact = ptbVisualizationArtifactSchema.parse(ptbVisualizationFixture());

    expect(artifact.executableMaterial.included).toBe(false);
    expect(artifact.unsupportedUse).toEqual(
      expect.arrayContaining([
        ...PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES
      ])
    );
    expect(() => assertNoForbiddenMcpFields(artifact)).not.toThrow();
  });

  it("requires every PTB visualization unsupported use to be present", () => {
    const candidate = ptbVisualizationFixture();
    candidate.unsupportedUse = PTB_VISUALIZATION_REQUIRED_UNSUPPORTED_USES.filter(
      (value) => value !== "payment_execution_readiness"
    );

    expect(ptbVisualizationArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects PTB visualization text that carries executable material or long encoded payloads", () => {
    for (const text of [
      "flowchart TD\n  a[transaction bytes: abc]",
      `flowchart TD\n  a[${"A".repeat(180)}]`
    ]) {
      const candidate = ptbVisualizationFixture() as any;
      candidate.mermaid = {
        ...candidate.mermaid,
        text
      };

      expect(ptbVisualizationArtifactSchema.safeParse(candidate).success).toBe(false);
    }

    expect(
      ptbVisualizationArtifactSchema.safeParse({
        ...ptbVisualizationFixture(),
        serializedTransaction: "abc"
      }).success
    ).toBe(false);
  });

});
