import { Transaction } from "@mysten/sui/transactions";
import { verifyDeepbookSwapCommands } from "../src/adapters/deepbook/deepbookSwapCommands.js";
import { describe, expect, it } from "vitest";
import {
  createDeepbookSwapTransactionMaterialDigestProducer,
  createDeepbookSwapTransactionMaterialProducer
} from "../src/adapters/deepbook/deepbookTransactionMaterialProducer.js";
import { deriveDeepbookSwapQuotePolicy } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import type { DeepbookSwapRequestedIntent } from "../src/adapters/deepbook/deepbookSwapIntent.js";
import { resolveDeepbookPoolForSymbols } from "../src/core/read/deepbookRegistry.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import type { ActionPlan } from "../src/core/action/types.js";
import { createDeepbookBuildClient } from "./fixtures/deepbookBuildClient.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";

const account = `0x${"a".repeat(64)}`;
const expectedChainIdentifier = "mainnet-chain";
const requestedIntent: DeepbookSwapRequestedIntent = {
  type: "swap",
  from: {
    symbol: "SUI",
    amountDisplay: "1"
  },
  to: {
    symbol: "USDC"
  },
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
  adapterData: {
    requestedIntent
  },
  createdAt: "2026-05-15T00:00:00.000Z"
};

describe("DeepBook transaction material producer", () => {
  it("builds account-bound transaction material into the local store without returning bytes", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const producer = createDeepbookSwapTransactionMaterialProducer({
      client: createDeepbookBuildClient({ expectedChainIdentifier }),
      network: "mainnet",
      chainIdentifier: expectedChainIdentifier,
      expectedChainIdentifier,
      materialStore
    });
    const quote = deepbookDisplayQuote();
    const policy = deriveDeepbookSwapQuotePolicy({
      rawQuote: quote.rawQuote,
      fetchedAt: quote.fetchedAt,
      maxSlippageBps: 50,
      now: new Date("2026-05-15T00:00:29.000Z")
    });
    if (policy.status !== "ok") {
      throw new Error("quote fixture unexpectedly requires refresh");
    }

    const outcome = await producer({
      reviewSessionId: "review_1",
      plan,
      account,
      requestedIntent,
      poolResolution: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }),
      quote,
      quotePolicy: { ...policy, feeBudgetRaw: "27500" },
      now: new Date("2026-05-15T00:00:29.000Z")
    });

    expect(outcome).toMatchObject({
      status: "completed",
      checks: [
        {
          id: "deepbook_transaction_material_built",
          status: "pass",
          source: "adapter"
        }
      ]
    });
    if (outcome.status !== "completed") {
      throw new Error("producer did not complete");
    }
    expect(outcome.evidence).not.toHaveProperty("transactionBytes");
    expect(outcome.evidence.expiresAt).toBe("2026-05-15T00:00:30.000Z");
    const stored = materialStore.getTransactionMaterial(outcome.evidence, new Date("2026-05-15T00:00:29.500Z"));
    expect(stored?.transactionBytes.byteLength).toBeGreaterThan(0);
    const data = Transaction.from(stored!.transactionBytes).getData();
    const limits = { account, poolId: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }).pool.address,
      baseType: quote.rawQuote.baseOut.coinType, quoteType: quote.rawQuote.quoteOut.coinType, deepType: quote.rawQuote.deepRequired.coinType,
      direction: policy.direction, principal: BigInt(policy.sourceAmountRaw), deepBudget: 27500n, minimum: BigInt(policy.minOutRaw) };
    const guard = verifyDeepbookSwapCommands(data, limits);
    expect(guard).toBe(outcome.guardCommand);
    expect(() => verifyDeepbookSwapCommands(data, { ...limits, minimum: limits.minimum + 1n })).toThrow();
    expect(() => verifyDeepbookSwapCommands(data, { ...limits, deepBudget: limits.deepBudget - 1n })).toThrow();
    const incorrectOutput = structuredClone(data);
    incorrectOutput.commands[guard]!.SplitCoins!.coin = { $kind: "NestedResult", NestedResult: [guard - 1, 0] };
    expect(() => verifyDeepbookSwapCommands(incorrectOutput, limits)).toThrow();

    expect(stored?.redactedDiagnostics).toMatchObject({
      poolKey: "SUI_USDC",
      direction: "base_to_quote",
      sourceAmountRaw: "1000000000",
      minOutRaw: "122839506",
      feeBudgetRaw: "27500"
    });

    const digestOutcome = await createDeepbookSwapTransactionMaterialDigestProducer({
      materialStore
    })({
      materialHandle: outcome.evidence,
      now: new Date("2026-05-15T00:00:29.500Z")
    });
    expect(digestOutcome).toMatchObject({
      status: "completed",
      evidence: {
        materialId: outcome.evidence.materialId,
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        digestKind: "sui_transaction_digest"
      },
      checks: [
        {
          id: "deepbook_transaction_material_digest_commitment",
          status: "pass",
          source: "adapter"
        }
      ]
    });
    if (digestOutcome.status !== "completed") {
      throw new Error("digest producer did not complete");
    }
    expect(digestOutcome.evidence.transactionDigest).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("fails closed on non-mainnet chain identity before building material", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const producer = createDeepbookSwapTransactionMaterialProducer({
      client: createDeepbookBuildClient({ expectedChainIdentifier }),
      network: "mainnet",
      chainIdentifier: "wrong-chain",
      expectedChainIdentifier,
      materialStore
    });
    const quote = deepbookDisplayQuote();
    const policy = deriveDeepbookSwapQuotePolicy({
      rawQuote: quote.rawQuote,
      fetchedAt: quote.fetchedAt,
      maxSlippageBps: 50,
      now: new Date("2026-05-15T00:00:29.000Z")
    });
    if (policy.status !== "ok") {
      throw new Error("quote fixture unexpectedly requires refresh");
    }

    const outcome = await producer({
      reviewSessionId: "review_1",
      plan,
      account,
      requestedIntent,
      poolResolution: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }),
      quote,
      quotePolicy: { ...policy, feeBudgetRaw: "27500" },
      now: new Date("2026-05-15T00:00:29.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "network_mismatch",
      checks: [{ id: "deepbook_transaction_material_network_mismatch", status: "fail" }]
    });
  });

  it("fails closed instead of throwing when raw quote policy amounts are malformed", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const producer = createDeepbookSwapTransactionMaterialProducer({
      client: createDeepbookBuildClient({ expectedChainIdentifier }),
      network: "mainnet",
      chainIdentifier: expectedChainIdentifier,
      expectedChainIdentifier,
      materialStore
    });
    const quote = deepbookDisplayQuote();
    const policy = deriveDeepbookSwapQuotePolicy({
      rawQuote: quote.rawQuote,
      fetchedAt: quote.fetchedAt,
      maxSlippageBps: 50,
      now: new Date("2026-05-15T00:00:29.000Z")
    });
    if (policy.status !== "ok") {
      throw new Error("quote fixture unexpectedly requires refresh");
    }

    const outcome = await producer({
      reviewSessionId: "review_1",
      plan,
      account,
      requestedIntent,
      poolResolution: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }),
      quote,
      quotePolicy: { ...policy, feeBudgetRaw: "27500", sourceAmountRaw: "1.5" },
      now: new Date("2026-05-15T00:00:29.000Z")
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blockedReason: "amount_mismatch",
      checks: [{ id: "deepbook_transaction_material_raw_amount_invalid", status: "fail" }]
    });
  });

  it.each([
    "transaction bytes: abc private key material",
    "gas payment RPC unavailable",
    "RPC failed while checking insufficient balance"
  ])("does not infer a shortage or echo an opaque SDK build error: %s", async (message) => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const client = createDeepbookBuildClient({ expectedChainIdentifier, buildError: new Error(message) });
    const producer = createDeepbookSwapTransactionMaterialProducer({
      client,
      network: "mainnet",
      chainIdentifier: expectedChainIdentifier,
      expectedChainIdentifier,
      materialStore
    });
    const quote = deepbookDisplayQuote();
    const policy = deriveDeepbookSwapQuotePolicy({
      rawQuote: quote.rawQuote,
      fetchedAt: quote.fetchedAt,
      maxSlippageBps: 50,
      now: new Date("2026-05-15T00:00:29.000Z")
    });
    if (policy.status !== "ok") {
      throw new Error("quote fixture unexpectedly requires refresh");
    }

    const outcome = await producer({
      reviewSessionId: "review_1",
      plan,
      account,
      requestedIntent,
      poolResolution: resolveDeepbookPoolForSymbols({ sourceSymbol: "SUI", targetSymbol: "USDC" }),
      quote,
      quotePolicy: { ...policy, feeBudgetRaw: "27500" },
      now: new Date("2026-05-15T00:00:29.000Z")
    });

    expect(client.transactionExecutionService.simulateTransaction).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ status: "blocked", blockedReason: "object_resolution_failed" });
    expect(outcome.checks[0].message).toBe("DeepBook transaction material could not be built and verified. Nothing was signed or submitted.");
    expect(outcome.checks[0].message).not.toContain(message);
  });

  it("fails closed when the stored local material is unavailable for digest commitment", async () => {
    const materialStore = new InMemoryLocalTransactionMaterialStore();
    const handle = materialStore.recordTransactionMaterial(
      {
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: new Uint8Array([1, 2, 3]),
        expiresAt: new Date("2026-05-15T00:00:30.000Z")
      },
      new Date("2026-05-15T00:00:29.000Z")
    );
    const producer = createDeepbookSwapTransactionMaterialDigestProducer({ materialStore });

    const outcome = await producer({
      materialHandle: handle,
      now: new Date("2026-05-15T00:00:30.000Z")
    });

    expect(outcome).toMatchObject({
      status: "refresh_required",
      refreshReason: "quote_stale",
      checks: [{ id: "deepbook_transaction_material_digest_unavailable", status: "fail" }]
    });
  });
});
