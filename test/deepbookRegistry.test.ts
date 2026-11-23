import { mainnetCoins } from "@mysten/deepbook-v3";
import { describe, expect, it } from "vitest";
import { curateUsdcChartPools } from "../src/core/read/deepbookRegistry.js";

describe("curateUsdcChartPools (chart pair curation)", () => {
  it("keeps only curated base tokens, in curated display order, matched by full coin type", () => {
    // The indexer lists pools in an arbitrary order and includes tokens that are not
    // on the curated allowlist (WUSDT, BETH). Matching is by base SYMBOL, so the
    // indexer's BWETH_USDC pool name does not matter — BETH is simply not curated.
    const input = [
      { poolName: "WUSDT_USDC", baseAsset: { symbol: "WUSDT", coinType: mainnetCoins.WUSDT!.type } },
      { poolName: "BWETH_USDC", baseAsset: { symbol: "BETH", coinType: mainnetCoins.BETH!.type } },
      { poolName: "WAL_USDC", baseAsset: { symbol: "WAL", coinType: mainnetCoins.WAL!.type } },
      { poolName: "DEEP_USDC", baseAsset: { symbol: "DEEP", coinType: mainnetCoins.DEEP!.type } },
      { poolName: "SUI_USDC", baseAsset: { symbol: "SUI", coinType: mainnetCoins.SUI!.type } }
    ];

    // Non-curated tokens dropped; the rest in the curated order (SUI, DEEP, WAL, …).
    expect(curateUsdcChartPools(input).map((pool) => pool.poolName)).toEqual([
      "SUI_USDC",
      "DEEP_USDC",
      "WAL_USDC"
    ]);
  });

  it("preserves the entry objects (not just the symbol)", () => {
    const input = [
      { poolName: "DEEP_USDC", baseAsset: { symbol: "DEEP", coinType: mainnetCoins.DEEP!.type } },
      { poolName: "SUI_USDC", baseAsset: { symbol: "SUI", coinType: mainnetCoins.SUI!.type } }
    ];
    expect(curateUsdcChartPools(input)).toEqual([
      { poolName: "SUI_USDC", baseAsset: { symbol: "SUI", coinType: mainnetCoins.SUI!.type } },
      { poolName: "DEEP_USDC", baseAsset: { symbol: "DEEP", coinType: mainnetCoins.DEEP!.type } }
    ]);
  });
});
