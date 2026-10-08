import { SimulationError } from "@mysten/sui/client";
import { DeepBookClient, mainnetCoins } from "@mysten/deepbook-v3";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import type { DeepbookDisplayQuoteSummary } from "../../core/read/readServiceTypes.js";
import { parseDeepbookRawU64 } from "../../core/read/deepbookReadHelpers.js";
import type { BlockedReason, RefreshReason, ReviewCheck } from "../../core/action/types.js";
import {
  type LocalTransactionMaterialDigestCommitment,
  type LocalTransactionMaterialHandle,
  type LocalTransactionMaterialStore
} from "../../core/session/transactionMaterialStore.js";
import { suiTransactionDigestSchema } from "../../core/suiAddress.js";
import type { DeepbookSwapQuotePolicyOk } from "./deepbookQuotePolicy.js";
import type {
  DeepbookSwapActionPlanIdentity,
  DeepbookSwapRequestedIntent
} from "./deepbookSwapIntent.js";
import type { resolveDeepbookPoolForSymbols } from "../../core/read/deepbookRegistry.js";
import {
  failReviewCheck,
  passReviewCheck
} from "../../core/review/reviewComputationResult.js";

export type DeepbookSwapPoolResolution = ReturnType<typeof resolveDeepbookPoolForSymbols>;

export type DeepbookSwapTransactionMaterialProducerInput = {
  reviewSessionId: string;
  plan: DeepbookSwapActionPlanIdentity;
  account: string;
  requestedIntent: DeepbookSwapRequestedIntent;
  poolResolution: DeepbookSwapPoolResolution;
  quote: DeepbookDisplayQuoteSummary;
  quotePolicy: DeepbookSwapQuotePolicyOk;
  now: Date;
};

export type DeepbookSwapTransactionMaterialProducerOutcome =
  | {
      status: "completed";
      evidence: LocalTransactionMaterialHandle;
      checks: ReviewCheck[];
    }
  | {
      status: "blocked";
      blockedReason: BlockedReason;
      checks: [ReviewCheck, ...ReviewCheck[]];
    }
  | {
      status: "refresh_required";
      refreshReason: RefreshReason;
      checks: [ReviewCheck, ...ReviewCheck[]];
    };

export type DeepbookSwapTransactionMaterialProducer = (
  input: DeepbookSwapTransactionMaterialProducerInput
) => DeepbookSwapTransactionMaterialProducerOutcome | Promise<DeepbookSwapTransactionMaterialProducerOutcome>;

export type DeepbookSwapTransactionMaterialDigestProducerInput = {
  materialHandle: LocalTransactionMaterialHandle;
  now: Date;
};

export type DeepbookSwapTransactionMaterialDigestProducerOutcome =
  | {
      status: "completed";
      evidence: LocalTransactionMaterialDigestCommitment;
      checks: ReviewCheck[];
    }
  | {
      status: "blocked";
      blockedReason: BlockedReason;
      checks: [ReviewCheck, ...ReviewCheck[]];
    }
  | {
      status: "refresh_required";
      refreshReason: RefreshReason;
      checks: [ReviewCheck, ...ReviewCheck[]];
    };

export type DeepbookSwapTransactionMaterialDigestProducer = (
  input: DeepbookSwapTransactionMaterialDigestProducerInput
) => DeepbookSwapTransactionMaterialDigestProducerOutcome | Promise<DeepbookSwapTransactionMaterialDigestProducerOutcome>;

export type DeepbookSwapTransactionMaterialProducerOptions = {
  client: SuiGrpcClient;
  network: "mainnet";
  chainIdentifier: string;
  expectedChainIdentifier: string;
  materialStore: LocalTransactionMaterialStore;
};

export type DeepbookSwapTransactionMaterialDigestProducerOptions = {
  materialStore: Pick<LocalTransactionMaterialStore, "getTransactionMaterial">;
};

const DEEPBOOK_SWAP_GAS_BUDGET_MIST = 50_000_000n;

const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export type DeepbookSwapBalanceRequirement = {
  symbol: string;
  coinType: string;
  decimals: number;
  requiredRaw: bigint;
};

export function deepbookSwapBalanceRequirements(input: {
  sourceSymbol: string;
  sourceCoinType: string;
  sourceDecimals: number;
  sourceAmountRaw: bigint;
}): DeepbookSwapBalanceRequirement[] {
  if (input.sourceCoinType === SUI_COIN_TYPE) {
    return [
      {
        symbol: input.sourceSymbol,
        coinType: SUI_COIN_TYPE,
        decimals: input.sourceDecimals,
        requiredRaw: input.sourceAmountRaw + DEEPBOOK_SWAP_GAS_BUDGET_MIST
      }
    ];
  }
  return [
    {
      symbol: input.sourceSymbol,
      coinType: input.sourceCoinType,
      decimals: input.sourceDecimals,
      requiredRaw: input.sourceAmountRaw
    },
    { symbol: "SUI", coinType: SUI_COIN_TYPE, decimals: 9, requiredRaw: DEEPBOOK_SWAP_GAS_BUDGET_MIST }
  ];
}

function displayRaw(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function createDeepbookSwapTransactionMaterialProducer(
  options: DeepbookSwapTransactionMaterialProducerOptions
): DeepbookSwapTransactionMaterialProducer {
  return async (input) => {
    if (options.network !== "mainnet" || options.chainIdentifier !== options.expectedChainIdentifier) {
      return {
        status: "blocked",
        blockedReason: "network_mismatch",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_network_mismatch",
            "Transaction material network",
            "DeepBook transaction material build requires a verified Sui mainnet gRPC endpoint and matching mainnet chain identifier.",
            "network"
          )
        ]
      };
    }

    if (input.poolResolution.direction !== input.quotePolicy.direction || input.quote.direction !== input.quotePolicy.direction) {
      return {
        status: "blocked",
        blockedReason: "amount_mismatch",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_quote_direction_mismatch",
            "Transaction material quote policy",
            "DeepBook transaction material build requires pool direction, quote evidence, and quote policy to describe the same swap direction.",
            "adapter"
          )
        ]
      };
    }

    const quoteExpiresAt = quotePolicyExpiresAt(input.quotePolicy);
    if (quoteExpiresAt.getTime() <= input.now.getTime()) {
      return {
        status: "refresh_required",
        refreshReason: "quote_stale",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_quote_expired",
            "Transaction material quote policy",
            "DeepBook transaction material was not built because the quote policy expired before build.",
            "quote"
          )
        ]
      };
    }

    let sourceAmountRaw: bigint;
    let minOutRaw: bigint;
    let deepAmountRaw: bigint;
    try {
      sourceAmountRaw = parseDeepbookRawU64(input.quotePolicy.sourceAmountRaw, "sourceAmountRaw", { positive: true });
      minOutRaw = parseDeepbookRawU64(input.quotePolicy.minOutRaw, "minOutRaw", { positive: true });
      deepAmountRaw = parseDeepbookRawU64(input.quotePolicy.deepAmountRaw, "deepAmountRaw");
    } catch (error) {
      return {
        status: "blocked",
        blockedReason: "amount_mismatch",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_raw_amount_invalid",
            "Transaction material quote policy",
            error instanceof Error ? error.message : "DeepBook transaction material requires valid raw u64 quote policy amounts.",
            "quote"
          )
        ]
      };
    }

    try {
      const sourceQuoteAmount = input.quote.rawQuote.inputAmount;
      const requirements = deepbookSwapBalanceRequirements({
        sourceSymbol: sourceQuoteAmount.symbol,
        sourceCoinType: sourceQuoteAmount.coinType,
        sourceDecimals: sourceQuoteAmount.decimals,
        sourceAmountRaw: sourceAmountRaw
      });
      for (const requirement of requirements) {
        const balance = await options.client.core.getBalance({
          owner: input.account,
          coinType: requirement.coinType
        });
        const heldRaw = BigInt(balance.balance.balance);
        if (heldRaw < requirement.requiredRaw) {
          const isGasOnly = requirement.coinType === SUI_COIN_TYPE && sourceQuoteAmount.coinType !== SUI_COIN_TYPE;
          return {
            status: "blocked",
            blockedReason: "insufficient_balance",
            checks: [
              failReviewCheck(
                "deepbook_transaction_material_build_failed",
                "Transaction material build",
                `Insufficient balance: this swap needs ${displayRaw(requirement.requiredRaw, requirement.decimals)} ${requirement.symbol}${isGasOnly ? " for gas" : requirement.coinType === SUI_COIN_TYPE ? " (amount + gas)" : ""}, but the account holds ${displayRaw(heldRaw, requirement.decimals)} ${requirement.symbol}. Nothing was signed and no funds moved.`,
                "adapter"
              )
            ]
          };
        }
      }
      const deepbook = new DeepBookClient({
        client: options.client,
        address: input.account,
        network: options.network
      });
      const transaction = new Transaction();
      transaction.setSender(input.account);
      // Set the product's explicit 0.05 SUI spending cap before the SDK's
      // setGasBudgetIfNotSet fallback (0.25 SUI). This is not a cost estimate;
      // funding and checks-enabled simulation must validate each transaction.
      transaction.setGasBudget(DEEPBOOK_SWAP_GAS_BUDGET_MIST);
      // input_coin fee mode swaps with an explicit zero DEEP coin; the Move
      // entry point then charges the taker fee in the source coin at the
      // protocol penalty. The explicit zero coin avoids SDK coin selection,
      // which cannot resolve a zero balance for accounts holding no DEEP.
      const inputFeeMode = input.quotePolicy.feeMode === "input_coin";
      const zeroDeepCoin = inputFeeMode
        ? transaction.moveCall({
            target: "0x2::coin::zero",
            typeArguments: [mainnetCoins.DEEP!.type]
          })
        : undefined;
      const swapDeepAmountRaw = inputFeeMode ? 0n : deepAmountRaw;
      const [baseCoinResult, quoteCoinResult, deepCoinResult] =
        input.quotePolicy.direction === "base_to_quote"
          ? deepbook.deepBook.swapExactBaseForQuote({
              poolKey: input.poolResolution.poolKey,
              amount: sourceAmountRaw,
              minOut: minOutRaw,
              deepAmount: swapDeepAmountRaw,
              ...(zeroDeepCoin ? { deepCoin: zeroDeepCoin } : {})
            })(transaction)
          : deepbook.deepBook.swapExactQuoteForBase({
              poolKey: input.poolResolution.poolKey,
              amount: sourceAmountRaw,
              minOut: minOutRaw,
              deepAmount: swapDeepAmountRaw,
              ...(zeroDeepCoin ? { deepCoin: zeroDeepCoin } : {})
            })(transaction);
      transaction.transferObjects([baseCoinResult, quoteCoinResult, deepCoinResult], input.account);
      const transactionBytes = await transaction.build({ client: options.client });
      options.materialStore.deleteReviewSessionTransactionMaterials(input.reviewSessionId);
      const handle = options.materialStore.recordTransactionMaterial(
        {
          reviewSessionId: input.reviewSessionId,
          planId: input.plan.id,
          account: input.account,
          kind: "deepbook_swap_transaction_data",
          source: "sui_mcp_built",
          transactionBytes,
          expiresAt: quoteExpiresAt,
          redactedDiagnostics: {
            protocol: input.plan.protocol,
            adapterId: input.plan.adapterId,
            actionKind: input.plan.actionKind,
            poolKey: input.poolResolution.poolKey,
            direction: input.quotePolicy.direction,
            quoteFetchedAt: input.quotePolicy.fetchedAt,
            quoteExpiresAt: quoteExpiresAt.toISOString(),
            sourceAmountRaw: input.quotePolicy.sourceAmountRaw,
            minOutRaw: input.quotePolicy.minOutRaw,
            deepAmountRaw: input.quotePolicy.deepAmountRaw
          }
        },
        input.now
      );

      return {
        status: "completed",
        evidence: handle,
        checks: [
          passReviewCheck(
            "deepbook_transaction_material_built",
            "Transaction material build",
            "Built account-bound DeepBook swap transaction material from Sui MCP quote policy and stored the unsigned transaction bytes only in the local material store until quote expiry. This is not wallet handoff, signing data, signing readiness, or execution readiness.",
            "adapter"
          )
        ]
      };
    } catch (error) {
      return {
        status: "blocked",
        blockedReason: "object_resolution_failed",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_build_failed",
            "Transaction material build",
            buildFailureMessage(error),
            "adapter"
          )
        ]
      };
    }
  };
}

export function createDeepbookSwapTransactionMaterialDigestProducer(
  options: DeepbookSwapTransactionMaterialDigestProducerOptions
): DeepbookSwapTransactionMaterialDigestProducer {
  return async (input) => {
    const material = options.materialStore.getTransactionMaterial(input.materialHandle, input.now);
    if (!material) {
      return {
        status: "refresh_required",
        refreshReason: "quote_stale",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_digest_unavailable",
            "Transaction material digest",
            "DeepBook transaction material digest was not computed because the stored local material was unavailable or expired; refresh the review evidence before continuing.",
            "adapter"
          )
        ]
      };
    }

    let transactionDigest: string;
    try {
      transactionDigest = await Transaction.from(material.transactionBytes).getDigest();
    } catch {
      return {
        status: "blocked",
        blockedReason: "object_resolution_failed",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_digest_failed",
            "Transaction material digest",
            "DeepBook transaction material digest could not be derived from the stored local transaction bytes.",
            "adapter"
          )
        ]
      };
    }

    const parsedDigest = suiTransactionDigestSchema.safeParse(transactionDigest);
    if (!parsedDigest.success) {
      return {
        status: "blocked",
        blockedReason: "object_resolution_failed",
        checks: [
          failReviewCheck(
            "deepbook_transaction_material_digest_invalid",
            "Transaction material digest",
            "DeepBook transaction material digest did not match the pinned Sui SDK transaction digest format.",
            "adapter"
          )
        ]
      };
    }

    return {
      status: "completed",
      evidence: {
        materialId: material.materialId,
        reviewSessionId: material.reviewSessionId,
        planId: material.planId,
        account: material.account,
        kind: material.kind,
        source: material.source,
        digestKind: "sui_transaction_digest",
        transactionDigest: parsedDigest.data,
        computedAt: input.now.toISOString(),
        expiresAt: material.expiresAt
      },
      checks: [
        passReviewCheck(
          "deepbook_transaction_material_digest_commitment",
          "Transaction material digest",
          "Derived a Sui transaction digest from the stored local unsigned transaction material. The digest and bytes remain internal until later review stages bind object ownership, human-readable review, and simulation evidence.",
          "adapter"
        )
      ]
    };
  };
}

function quotePolicyExpiresAt(policy: DeepbookSwapQuotePolicyOk): Date {
  return new Date(Date.parse(policy.fetchedAt) + policy.staleAfterMs);
}

function buildFailureMessage(error: unknown): string {
  // The pinned SDK discards some gRPC error kinds when building a transaction.
  // Its error text cannot establish an account-balance or gas shortfall.
  if (error instanceof SimulationError && error.executionError) {
    return "DeepBook transaction was rejected during build-time simulation. Refresh the review or inspect its selected constraints. Nothing was signed or submitted.";
  }
  return "DeepBook transaction material could not be built and verified. Nothing was signed or submitted.";
}
