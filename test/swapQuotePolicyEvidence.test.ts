import { describe, expect, it } from "vitest";
import {
  createSwapQuotePolicyEvidence,
  mapSwapQuotePolicyEvidenceToContractDraft,
  verifySwapQuotePolicyEvidence
} from "../src/core/action/swapQuotePolicyEvidence.js";
import { deriveDeepbookSwapQuotePolicy } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import { InMemoryLocalTransactionMaterialStore } from "../src/core/session/transactionMaterialStore.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";

const account = `0x${"a".repeat(64)}`;

function quoteAmount(amount: ReturnType<typeof deepbookDisplayQuote>["rawQuote"]["inputAmount"]) {
  return {
    raw: amount.raw,
    asset: {
      symbol: amount.symbol,
      coinType: amount.coinType,
      decimals: amount.decimals,
      unitSource: amount.unitSource
    }
  };
}

function buildEvidence() {
  const materialStore = new InMemoryLocalTransactionMaterialStore();
  const quote = deepbookDisplayQuote();
  const now = new Date("2026-05-15T00:00:29.000Z");
  const policy = deriveDeepbookSwapQuotePolicy({
    rawQuote: quote.rawQuote,
    fetchedAt: quote.fetchedAt,
    maxSlippageBps: 50,
    now
  });
  if (policy.status !== "ok") {
    throw new Error("quote fixture unexpectedly requires refresh");
  }
  const materialHandle = materialStore.recordTransactionMaterial(
    {
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      kind: "deepbook_swap_transaction_data",
      source: "sui_mcp_built",
      transactionBytes: new Uint8Array([1, 2, 3]),
      expiresAt: new Date("2026-05-15T00:00:30.000Z")
    },
    now
  );

  const evidence = createSwapQuotePolicyEvidence({
    materialHandle,
    adapterId: "deepbook-swap",
    protocol: "DeepBookV3",
    actionKind: "swap",
    quoteEvidenceId: `deepbook_raw_quote:${materialHandle.materialId}`,
    quoteSource: {
      provider: "DeepBookV3",
      poolKey: quote.pool.poolKey,
      direction: policy.direction,
      fetchedAt: policy.fetchedAt,
      sourceMoveFunction: quote.rawQuote.sourceMoveFunction
    },
    maxSlippageBps: policy.maxSlippageBps,
    staleAfterMs: policy.staleAfterMs,
    sourceAmount: quoteAmount(quote.rawQuote.inputAmount),
    expectedOutput: quoteAmount(quote.rawQuote.directionalOutput),
    minimumOutput: {
      raw: policy.minOutRaw,
      asset: quoteAmount(quote.rawQuote.directionalOutput).asset
    },
    inputFlow: quote.inputFlow,
    separateFeeBudgetRaw: quote.rawQuote.deepRequired.raw,
    derivedAt: now
  });

  return { evidence, materialHandle, now };
}

describe("swap quote policy evidence", () => {
  it("creates material-bound quote evidence and maps the quote-owned contract draft", () => {
    const { evidence, materialHandle, now } = buildEvidence();

    expect(verifySwapQuotePolicyEvidence({
      transactionMaterial: materialHandle,
      evidence,
      now
    })).toMatchObject({
      materialId: materialHandle.materialId,
      reviewSessionId: "review_1",
      quoteSource: {
        provider: "DeepBookV3",
        poolKey: "SUI_USDC"
      },
      minimumOutput: {
        raw: "122839506"
      }
    });

    const mapping = mapSwapQuotePolicyEvidenceToContractDraft(evidence);
    expect(mapping).toMatchObject({
      status: "mapped",
      rawQuantities: expect.arrayContaining([
        expect.objectContaining({ role: "expected_output", rawAmount: "123456789" }),
        expect.objectContaining({ role: "minimum_output", rawAmount: "122839506" })
      ]),
      evidenceClaims: expect.arrayContaining([
        expect.objectContaining({ factKind: "quote_min_out", minOutRaw: "122839506" }),
        expect.objectContaining({
          factKind: "slippage_policy",
          policySource: "adapter_policy_from_quote_evidence",
          maxSlippageBps: 50,
          minOutRaw: "122839506"
        })
      ])
    });
    expect(JSON.stringify(mapping)).not.toContain("transactionBytes");
  });

  it("rejects the earlier policy version and inconsistent input conservation", () => {
    const { evidence, materialHandle, now } = buildEvidence();
    const verify = (candidate: unknown) => verifySwapQuotePolicyEvidence({
      transactionMaterial: materialHandle, evidence: candidate as typeof evidence, now
    });
    expect(() => verify({ ...evidence, evidenceVersion: "swap-quote-policy-v1" })).toThrow();
    expect(() => verify({ ...evidence, inputFlow: { ...evidence.inputFlow, expectedReturnRaw: "1" } })).toThrow(/principal/);
    expect(() => verify({ ...evidence, separateFeeBudgetRaw: "24999" })).toThrow(/fee budget/);
  });

  it("rejects quote evidence whose min-out no longer matches the quote policy formula", () => {
    const { evidence, materialHandle, now } = buildEvidence();

    expect(() =>
      verifySwapQuotePolicyEvidence({
        transactionMaterial: materialHandle,
        evidence: {
          ...evidence,
          minimumOutput: {
            ...evidence.minimumOutput,
            raw: "122839504"
          }
        },
        now
      })
    ).toThrow(/minimumOutput\.raw/);
  });

  it("rejects quote evidence that does not match the stored material identity", () => {
    const { evidence, materialHandle, now } = buildEvidence();

    expect(() =>
      verifySwapQuotePolicyEvidence({
        transactionMaterial: materialHandle,
        evidence: {
          ...evidence,
          materialId: "txmat_other"
        },
        now
      })
    ).toThrow(/material identity/);
  });

  it("rejects quote evidence whose expiry is not derived from quote fetch time and stale window", () => {
    const { evidence, materialHandle, now } = buildEvidence();

    expect(() =>
      verifySwapQuotePolicyEvidence({
        transactionMaterial: {
          ...materialHandle,
          expiresAt: "2026-05-15T00:00:31.000Z"
        },
        evidence: {
          ...evidence,
          expiresAt: "2026-05-15T00:00:31.000Z"
        },
        now
      })
    ).toThrow(/fetchedAt plus staleAfterMs/);
  });
});
