import { describe, expect, it } from "vitest";
import { deepbookFeeBudget } from "../src/adapters/deepbook/deepbookQuotePolicy.js";
import { deepbookMinimumInputRaw } from "../src/core/read/deepbookReadHelpers.js";
import { deepbookDisplayQuote } from "./fixtures/deepbookQuote.js";
import { MAX_RAW_U64 } from "../src/core/numeric/rawU64.js";

describe("DeepBook pool limits", () => {
  it("covers the next base lot independently of the percentage margin and reserves only available DEEP", () => {
    const q = deepbookDisplayQuote().rawQuote;
    q.sourceMoveFunction = "pool::get_base_quantity_out";
    q.baseOut.raw = "100000000";
    q.deepRequired.raw = "5716";
    q.poolTerms = { lotSizeRaw: "100000000", minBaseRaw: "100000000", takerFeeRaw: "1000000",
      assetIsBase: true, deepPerAssetRaw: "57160000", whitelisted: false };
    expect(deepbookFeeBudget(q, 20000n).raw).toBe("11432");
    expect(deepbookFeeBudget(q, 7000n).raw).toBe("7000");
    expect(deepbookFeeBudget(q, 5716n).raw).toBe("5716");
    expect(() => deepbookFeeBudget(q, 5715n)).toThrow();
    q.baseOut.raw = MAX_RAW_U64.toString();
    expect(() => deepbookFeeBudget(q, MAX_RAW_U64)).toThrow(/u64/);
  });
  it("uses the full quote principal for a quote-basis buy and the quoted fee for a sale", () => {
    const q = deepbookDisplayQuote().rawQuote;
    q.sourceMoveFunction = "pool::get_base_quantity_out";
    q.inputAmount.raw = "1000005"; q.deepRequired.raw = "249";
    q.poolTerms = { lotSizeRaw: "100", minBaseRaw: "1000", takerFeeRaw: "250000",
      assetIsBase: false, deepPerAssetRaw: "1000000001", whitelisted: false };
    expect(deepbookFeeBudget(q, 1000n).raw).toBe("275");
    q.sourceMoveFunction = "pool::get_quote_quantity_out";
    expect(deepbookFeeBudget(q, 1000n).raw).toBe("274");
    delete q.poolTerms;
    expect(() => deepbookFeeBudget(q, 1000n)).toThrow(/missing/);
  });
  it("accounts for the input-fee divisor before rounding to a lot", () => {
    const q = deepbookDisplayQuote().rawQuote;
    expect(deepbookMinimumInputRaw(q)).toBe(1000000000n);
    q.sourceMoveFunction = "pool::get_quote_quantity_out_input_fee";
    expect(deepbookMinimumInputRaw(q)).toBe(1000250000n);
    q.sourceMoveFunction = "pool::get_base_quantity_out";
    expect(deepbookMinimumInputRaw(q)).toBeUndefined();
  });
});
