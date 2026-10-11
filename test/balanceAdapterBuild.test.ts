import { GrpcTypes } from "@mysten/sui/grpc";
import { describe, expect, it } from "vitest";
import { mainnetCoins, mainnetPools } from "@mysten/deepbook-v3";
import { SUI_TYPE_ARG, normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils";
import { Transaction } from "@mysten/sui/transactions";
import { createDeepbookBuildClient, BUILD_CHAIN } from "./fixtures/deepbookBuildClient.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";
import { createDeepbookSwapTransactionMaterialProducer, createDeepbookSwapTransactionMaterialDigestProducer } from "../src/adapters/deepbook/deepbookTransactionMaterialProducer.js";
import { createDeepbookSwapActionPlan } from "../src/adapters/deepbook/deepbookSwapIntent.js";
import { deriveDeepbookSwapQuotePolicy } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import { resolveDeepbookPoolForSymbols } from "../src/core/read/deepbookRegistry.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import { createTransactionObjectOwnershipProducer } from "../src/core/action/transactionObjectOwnershipProducer.js";
import { createReviewTimeSimulationProducer } from "../src/core/action/reviewTimeSimulationEvidence.js";
import { createSuccessfulReviewTimeSimulationClient } from "./fixtures/reviewTimeSimulation.js";

const account = `0x${"a".repeat(64)}`;
const now = new Date("2026-05-15T00:00:29.000Z");
const sharedIds = [normalizeSuiAddress("0x6"), ...Object.values(mainnetPools).map((p) => p.address)];

describe("supported adapter builds use real SDK intents and gRPC resolution", () => {
  it.each([
    { label: "success", kind: undefined, blockedReason: undefined, message: undefined },
    { label: "Move abort", kind: GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT,
      blockedReason: "object_resolution_failed", message: "DeepBook transaction was rejected during build-time simulation. Refresh the review or inspect its selected constraints. Nothing was signed or submitted." },
    // The pinned Sui SDK's grpc/core.ts converts these source kinds to ExecutionError.Unknown.
    // Build failures must not reconstruct lost classification from their messages.
    { label: "gas failure decoded without its kind", kind: GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS,
      blockedReason: "object_resolution_failed", message: "DeepBook transaction was rejected during build-time simulation. Refresh the review or inspect its selected constraints. Nothing was signed or submitted." },
    { label: "coin failure decoded without its kind", kind: GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE,
      blockedReason: "object_resolution_failed", message: "DeepBook transaction was rejected during build-time simulation. Refresh the review or inspect its selected constraints. Nothing was signed or submitted." }
  ])("handles $label without inferring the cause from error text", async ({ kind, blockedReason, message }) => {
    const client = createDeepbookBuildClient({ expectedChainIdentifier: BUILD_CHAIN,
      // The text deliberately conflicts with the typed MoveAbort cause.
      ...(kind === undefined ? {} : { buildFailure: GrpcTypes.ExecutionError.create({ kind, description: "private protocol detail: insufficient balance and gas payment" }) }),
      addressBalances: { [SUI_TYPE_ARG]: "2000000000", [normalizeStructTag(mainnetCoins.DEEP!.type)]: "1000000000000" },
      coinBalances: { [SUI_TYPE_ARG]: "0", [normalizeStructTag(mainnetCoins.DEEP!.type)]: "0" }, gasPayments: [] });
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const options = { client, materialStore, network: "mainnet" as const, chainIdentifier: BUILD_CHAIN, expectedChainIdentifier: BUILD_CHAIN };
    const requestedIntent = { type: "swap" as const, from: { symbol: "SUI", amountDisplay: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 };
    const plan = createDeepbookSwapActionPlan({ type: "swap", from: { symbol: "SUI", amount: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 }, now);
    const quote = deepbookDisplayQuote();
    const quotePolicy = deriveDeepbookSwapQuotePolicy({ rawQuote: quote.rawQuote, fetchedAt: quote.fetchedAt, maxSlippageBps: 50, now });
    if (quotePolicy.status !== "ok") throw new Error("Invalid quote fixture");
    const built = await createDeepbookSwapTransactionMaterialProducer(options)({ reviewSessionId: "balance-review", plan: plan as never, account, requestedIntent,
      poolResolution: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }), quote, quotePolicy, now });
    expect(client.transactionExecutionService.simulateTransaction).toHaveBeenCalledOnce();
    if (kind !== undefined) {
      expect(built).toMatchObject({ status: "blocked", blockedReason,
        checks: [{ id: "deepbook_transaction_material_build_failed", status: "fail", message }] });
      expect(JSON.stringify(built)).not.toContain("private protocol detail");
      expect(JSON.stringify(built)).not.toContain("objects could not be resolved");
      return;
    }
    if (built.status !== "completed") throw new Error(JSON.stringify(built));
    const stored = materialStore.getTransactionMaterial(built.evidence, now)!;
    const data = Transaction.from(stored.transactionBytes).getData();
    expect(data.gasData.payment).toEqual([]);
    expect(data.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ $kind: "FundsWithdrawal" })]));
    const digest = await createDeepbookSwapTransactionMaterialDigestProducer({ materialStore })({ materialHandle: built.evidence, now });
    if (digest.status !== "completed") throw new Error("Missing digest");
    const owned = await createTransactionObjectOwnershipProducer({ ...options, fundingSource: client.core,
      objectSource: { getObject: async ({ objectId }) => {
        if (!sharedIds.includes(objectId)) throw new Error("Unexpected object from adapter build");
        return { object: { objectId, type: "0x2::clock::Clock", owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } } } };
      } } })({ materialHandle: built.evidence, materialDigest: digest.evidence, now });
    expect(owned.status).toBe("completed");
    const simulation = await createReviewTimeSimulationProducer({ ...options, client: createSuccessfulReviewTimeSimulationClient(account) })({
      transactionMaterial: built.evidence, transactionMaterialDigest: digest.evidence, now });
    expect(simulation.status).toBe("completed");
  });
});
