import { describe, expect, it } from "vitest";
import {
  DEEPBOOK_REVIEW_QUOTE_STALE_AFTER_MS,
  deriveDeepbookSwapQuotePolicy
} from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import { DEEPBOOK_SCALAR_UNIT_SOURCE } from "../src/core/read/coinMetadata.js";
import type { DeepbookRawQuoteEvidence } from "../src/core/read/readServiceTypes.js";

function rawQuote(overrides: Partial<DeepbookRawQuoteEvidence> = {}): DeepbookRawQuoteEvidence {
  const amount = (raw: string, symbol: string, decimals: number) => ({
    raw,
    symbol,
    coinType: `0x2::${symbol.toLowerCase()}::${symbol}`,
    decimals,
    unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
  });

  return {
    kind: "deepbook_quote_raw_u64",
    sourceMoveFunction: "pool::get_quote_quantity_out",
    returnValueSourceMoveFunction: "pool::get_quantity_out",
    returnValueOrder: ["base_quantity_out", "quote_quantity_out", "deep_quantity_required"],
    inputAmount: amount("1000000000", "SUI", 9),
    baseOut: amount("0", "SUI", 9),
    quoteOut: amount("123456789", "USDC", 6),
    deepRequired: amount("25000", "DEEP", 6),
    directionalOutput: amount("123456789", "USDC", 6),
    boundary: {
      outputBeforeSlippagePolicy: true,
      notFor: [
        "final_min_out",
        "transaction_building",
        "signing_data",
        "signing_readiness",
        "price_impact",
        "mid_price_slippage",
        "quote_vs_mid_slippage",
        "effective_price",
        "venue_comparison",
        "best_route",
        "route_recommendation",
        "fiat_usd_cash_out",
        "external_market_price_conversion",
        "external_market_lookup",
        "usd_peg_assumption",
        "bank_cash_out_estimate",
        "profit_or_pnl",
        "cost_basis"
      ]
    },
    ...overrides
  };
}

describe("DeepBook quote policy", () => {
  it("derives fresh BigInt signable quote policy fields from raw quote evidence", () => {
    expect(
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote(),
        fetchedAt: "2026-05-15T00:00:00.000Z",
        now: new Date("2026-05-15T00:00:29.999Z"),
        maxSlippageBps: 50
      })
    ).toEqual({
      status: "ok",
      direction: "base_to_quote",
      feeMode: "deep",
      quoteFresh: true,
      expiresAt: "2026-05-15T00:00:30.000Z",
      fetchedAt: "2026-05-15T00:00:00.000Z",
      quoteAgeMs: 29_999,
      staleAfterMs: DEEPBOOK_REVIEW_QUOTE_STALE_AFTER_MS,
      maxSlippageBps: 50,
      sourceAmountRaw: "1000000000",
      expectedOutRaw: "123456789",
      minOutRaw: "122839506",
      quotedDeepRequiredRaw: "25000"
    });
  });

  it("uses the quote-to-base source entrypoint to preserve direction", () => {
    expect(
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote({
          sourceMoveFunction: "pool::get_base_quantity_out",
          directionalOutput: {
            raw: "987654321",
            symbol: "SUI",
            coinType: "0x2::sui::SUI",
            decimals: 9,
            unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
          }
        }),
        fetchedAt: "2026-05-15T00:00:00.000Z",
        now: new Date("2026-05-15T00:00:01.000Z"),
        maxSlippageBps: 1000
      })
    ).toMatchObject({
      status: "ok",
      direction: "quote_to_base",
      expectedOutRaw: "987654321",
      minOutRaw: "888888889"
    });
  });

  it("requires refresh when the quote is exactly 30 seconds old", () => {
    expect(
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote(),
        fetchedAt: "2026-05-15T00:00:00.000Z",
        now: new Date("2026-05-15T00:00:30.000Z"),
        maxSlippageBps: 50
      })
    ).toMatchObject({
      status: "refresh_required",
      refreshReason: "quote_stale",
      reason: "quote_stale",
      quoteAgeMs: 30_000,
      staleAfterMs: 30_000
    });
  });

  it("requires refresh when the quote timestamp is in the future", () => {
    expect(
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote(),
        fetchedAt: "2026-05-15T00:00:31.000Z",
        now: new Date("2026-05-15T00:00:00.000Z"),
        maxSlippageBps: 50
      })
    ).toMatchObject({
      status: "refresh_required",
      refreshReason: "quote_stale",
      reason: "quote_timestamp_in_future",
      quoteAgeMs: 0,
      clockSkewMs: 31_000
    });
  });

  it("requires refresh even for a small future timestamp", () => {
    expect(
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote(),
        fetchedAt: "2026-05-15T00:00:00.400Z",
        now: new Date("2026-05-15T00:00:00.000Z"),
        maxSlippageBps: 50
      })
    ).toMatchObject({
      status: "refresh_required",
      reason: "quote_timestamp_in_future",
      quoteAgeMs: 0,
      clockSkewMs: 400
    });
  });

  it("rejects a requested fee mode inconsistent with the quote getter", () => {
    const base = {
      rawQuote: rawQuote(),
      fetchedAt: "2026-05-15T00:00:00.000Z",
      now: new Date("2026-05-15T00:00:01.000Z"),
      maxSlippageBps: 50
    };
    expect(deriveDeepbookSwapQuotePolicy(base)).toMatchObject({ status: "ok", feeMode: "deep" });
    expect(() => deriveDeepbookSwapQuotePolicy({ ...base, feeMode: "input_coin" })).toThrow(/fee mode/);
  });

  it("keeps base_to_quote direction for the input-fee quote source function", () => {
    const quote = rawQuote();
    expect(
      deriveDeepbookSwapQuotePolicy({
        rawQuote: { ...quote, sourceMoveFunction: "pool::get_quote_quantity_out_input_fee" },
        fetchedAt: "2026-05-15T00:00:00.000Z",
        now: new Date("2026-05-15T00:00:01.000Z"),
        maxSlippageBps: 50,
        feeMode: "input_coin"
      })
    ).toMatchObject({ status: "ok", direction: "base_to_quote", feeMode: "input_coin" });
  });

  it("rejects non-ISO quote timestamps before signable quantity derivation", () => {
    for (const fetchedAt of ["2026-05-15", "2026-05-15T00:00:00Z", "not-a-date"]) {
      expect(() =>
        deriveDeepbookSwapQuotePolicy({
          rawQuote: rawQuote(),
          fetchedAt,
          now: new Date("2026-05-15T00:00:01.000Z"),
          maxSlippageBps: 50
        })
      ).toThrow(/fetchedAt must be an ISO 8601 UTC timestamp/);
    }
  });

  it("rejects invalid now timestamps before signable quantity derivation", () => {
    expect(() =>
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote(),
        fetchedAt: "2026-05-15T00:00:00.000Z",
        now: new Date("not-a-date"),
        maxSlippageBps: 50
      })
    ).toThrow(/now must be a valid Date/);
  });

  it.each(["1", "101", "9007199254740993"])("keeps output %s within the requested 1 bp tolerance", (raw) => {
    const quote = rawQuote();
    const output = { ...quote.quoteOut, raw };
    const policy = deriveDeepbookSwapQuotePolicy({
      rawQuote: { ...quote, quoteOut: output, directionalOutput: output }, fetchedAt: "2026-05-15T00:00:00.000Z",
      now: new Date("2026-05-15T00:00:01.000Z"), maxSlippageBps: 1
    });
    expect(policy.status).toBe("ok");
    if (policy.status !== "ok") throw Error("Expected a positive minimum");
    const expected = BigInt(raw), minimum = BigInt(policy.minOutRaw);
    expect(10_000n * (expected - minimum)).toBeLessThanOrEqual(expected);
    expect(10_000n * (expected - minimum + 1n)).toBeGreaterThan(expected);
  });

  it("rejects invalid slippage policy inputs before signable quantity derivation", () => {
    expect(() =>
      deriveDeepbookSwapQuotePolicy({
        rawQuote: rawQuote(),
        fetchedAt: "2026-05-15T00:00:00.000Z",
        now: new Date("2026-05-15T00:00:01.000Z"),
        maxSlippageBps: 0
      })
    ).toThrow(/maxSlippageBps/);
  });
});
