import { quotePoolCommandResults } from "./fixtures/deepbookQuote.js";
import { describe, expect, it } from "vitest";
import { mainnetCoins, type Coin } from "@mysten/deepbook-v3";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  ReadServiceCacheError,
  SuiReadService,
  listDeepbookTokenRegistry,
  type DeepBookCoinRegistry,
  type DeepBookReadClient,
  type IntentEvidenceSummary
} from "../src/core/read/readService.js";
import {
  DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
  DEEPBOOK_CANDLE_SOURCE_STATEMENT,
  type DeepbookCandleQuery,
  type DeepbookTradeCandle,
  type DeepbookCandleSourceEvidence,
  type DeepbookCandlePool,
  type DeepbookCandleSourceClient
} from "../src/core/read/deepbookCandleSource.js";
import {
  DEEPBOOK_ANSWER_USE, DEEPBOOK_READ_RESPONSE_UNSUPPORTED,
  DEEPBOOK_CANDLE_RESPONSE_TEXT,
  DEEPBOOK_CANDLE_SOURCE_BASE,
  DEEPBOOK_PINNED_SDK_METADATA_SOURCE,
  DEEPBOOK_SDK_SIMULATION_SOURCE_BASE
} from "../src/core/read/deepbookSourceOwners.js";
import {
  DEEPBOOK_SCALAR_UNIT_SOURCE,
  decimalsFromScalar,
  formatRawAmount,
  normalizeCoinType,
  parseDisplayAmountToRaw,
  type CoinMetadataCache
} from "../src/core/read/coinMetadata.js";
import {
  FORBIDDEN_USD_SETTLEMENT_RESPONSE_INFERENCES as forbiddenUsdSettlementResponseInferences,
  KOREAN_DOLLAR_ALIAS,
  SETTLEMENT_ASSET_ONLY_RESPONSE_FIELDS as settlementAssetOnlyAnswerFields,
  intentEvidenceScenarios,
  scenarioInputForUserPrompt,
  type IntentEvidenceScenarioPrompt
} from "./fixtures/intentEvidenceScenarios.js";
import { MemoryCoinMetadataCache } from "./fixtures/memoryCoinMetadataCache.js";

const now = () => new Date("2026-05-11T00:00:00.000Z");
const accountAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const managerAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function primaryResponseEvidence(result: IntentEvidenceSummary): Record<string, unknown> {
  const evidence: Record<string, unknown> = {};
  for (const field of result.responseEvidence.primaryEvidenceFields) {
    evidence[field] = result[field];
  }
  return evidence;
}

function createService(
  options: {
    listBalances?: (options: SuiClientTypes.ListBalancesOptions) => Promise<SuiClientTypes.ListBalancesResponse>;
    getCoinMetadata?: (options: SuiClientTypes.GetCoinMetadataOptions) => Promise<SuiClientTypes.GetCoinMetadataResponse>;
    listOwnedObjects?: (
      options: SuiClientTypes.ListOwnedObjectsOptions<{ display: true }>
    ) => Promise<SuiClientTypes.ListOwnedObjectsResponse<{ display: true }>>;
    defaultNameServiceName?: (
      options: SuiClientTypes.DefaultNameServiceNameOptions
    ) => Promise<SuiClientTypes.DefaultNameServiceNameResponse>;
    deepbook?: Partial<DeepBookReadClient>;
    now?: () => Date;
    coinMetadataCache?: CoinMetadataCache;
    coinMetadataTtlMs?: number;
    deepbookCoins?: DeepBookCoinRegistry;
    deepbookCandleSource?: DeepbookCandleSourceClient;
  } = {}
) {
  const deepbook: DeepBookReadClient = {
    async midPrice() {
      return 12.5;
    },
    async poolBookParams() {
      return { tickSize: 0.01, lotSize: 1, minSize: 1 };
    },
    async getLevel2TicksFromMid() {
      return {
        bid_prices: [12.4],
        bid_quantities: [10],
        ask_prices: [12.6],
        ask_quantities: [11]
      };
    },
    async getQuoteQuantityOutRaw() {
      return { baseOutRaw: "0", quoteOutRaw: "100000000000", deepRequiredRaw: "1000000" };
    },
    async getBaseQuantityOutRaw() {
      return { baseOutRaw: "50000000000", quoteOutRaw: "0", deepRequiredRaw: "1000000" };
    },
    async getBalanceManagerIds() {
      return [managerAddress];
    },
    async accountExists() {
      return true;
    },
    async account() {
      return {
        epoch: "42",
        open_orders: { contents: ["100", "101"] },
        taker_volume: 99,
        maker_volume: 88,
        active_stake: 77,
        inactive_stake: 66,
        created_proposal: true,
        voted_proposal: "proposal",
        unclaimed_rebates: { base: 1.1, quote: 2.2, deep: 3.3 },
        settled_balances: { base: 4.4, quote: 5.5, deep: 6.6 },
        owed_balances: { base: 7.7, quote: 8.8, deep: 9.9 }
      };
    },
    async lockedBalance() {
      return { base: 10.1, quote: 11.2, deep: 12.3 };
    },
    async accountOpenOrders() {
      return ["100", "101"];
    },
    ...options.deepbook
  };

  return new SuiReadService({
    network: "mainnet",
    chainIdentifier: "4c78adac",
    coinMetadataCache: options.coinMetadataCache ?? new MemoryCoinMetadataCache(),
    ...(options.coinMetadataTtlMs === undefined ? {} : { coinMetadataTtlMs: options.coinMetadataTtlMs }),
    ...(options.deepbookCoins === undefined ? {} : { deepbookCoins: options.deepbookCoins }),
    ...(options.deepbookCandleSource === undefined ? {} : { deepbookCandleSource: options.deepbookCandleSource }),
    now: options.now ?? (options.deepbookCandleSource ? () => new Date(officialSource("pool_registry").fetchedAt) : now),
    deepbookFactory: () => deepbook,
    client: {
      core: {
        async listBalances(listBalancesOptions) {
          return (options.listBalances?.(listBalancesOptions) as Promise<{
            balances: SuiClientTypes.Balance[];
            hasNextPage: boolean;
            cursor: string | null;
          }> | undefined) ?? {
            balances: [
              {
                coinType: "0x2::sui::SUI",
                balance: "100",
                coinBalance: "100",
                addressBalance: "100"
              }
            ],
            hasNextPage: false,
            cursor: null
          };
        },
        async getCoinMetadata(metadataOptions) {
          return options.getCoinMetadata?.(metadataOptions) ?? {
            coinMetadata: {
              id: null,
              decimals: 9,
              name: "Sui",
              symbol: "SUI",
              description: "",
              iconUrl: null
            }
          };
        },
        async listOwnedObjects(listOptions) {
          if (options.listOwnedObjects) {
            return options.listOwnedObjects(listOptions);
          }
          return { objects: [], hasNextPage: false, cursor: null } as SuiClientTypes.ListOwnedObjectsResponse<{
            display: true;
          }>;
        },
        async defaultNameServiceName(nameOptions) {
          if (options.defaultNameServiceName) {
            return options.defaultNameServiceName(nameOptions);
          }
          return { data: { name: null } };
        }
      }
    }
  });
}

function deepbookCoinsWithInvalidSuiScalar(): DeepBookCoinRegistry {
  const coins = mainnetCoins as DeepBookCoinRegistry;
  const sui = coins.SUI;
  if (!sui) {
    throw new Error("SUI token fixture is missing from pinned DeepBook mainnetCoins");
  }
  return {
    ...coins,
    SUI: { ...(sui as Coin), scalar: 12 }
  };
}

function createDeepbookCandleSourceFixture(options: {
  pools?: DeepbookCandlePool[] | undefined;
  candles?: DeepbookTradeCandle[] | undefined;
  failPools?: boolean | undefined;
  failCandles?: boolean | undefined;
} = {}): {
  source: DeepbookCandleSourceClient;
  calls: {
    pools: number;
    candles: DeepbookCandleQuery[];
  };
} {
  const calls: {
    pools: number;
    candles: DeepbookCandleQuery[];
  } = {
    pools: 0,
    candles: []
  };
  return {
    calls,
    source: {
      async fetchPools() {
        calls.pools += 1;
        if (options.failPools === true) {
          throw new Error("pool source unavailable");
        }
        return {
          source: officialSource("pool_registry"),
          pools: options.pools ?? [officialPoolFixture()]
        };
      },
      async fetchCandles(input) {
        calls.candles.push(input);
        if (options.failCandles === true) {
          throw new Error("candle source unavailable");
        }
        return {
          source: officialSource("order_fills", input),
          candles: options.candles ?? officialCandlesFixture().filter((c) =>
            (input.startTimeMs === undefined || Date.parse(c.end) > input.startTimeMs) &&
            (input.endTimeMs === undefined || c.timestampMs < input.endTimeMs))
        };
      }
    }
  };
}

function officialPoolFixture(
  poolName = "SUI_USDC",
  symbol = "SUI",
  coinType = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
): DeepbookCandlePool {
  return {
    pool_id:
      poolName === "SUI2_USDC"
        ? "0x1111111111111111111111111111111111111111111111111111111111111111"
        : "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407",
    pool_name: poolName,
    base_asset_id: coinType,
    base_asset_symbol: symbol,
    base_asset_decimals: 9,
    quote_asset_id: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
    quote_asset_symbol: "USDC",
    quote_asset_decimals: 6
  };
}

function officialCandlesFixture(): DeepbookTradeCandle[] {
  return [
    {
      timestampMs: Date.parse("2026-06-26T16:50:00.000Z"),
      start: "2026-06-26T16:50:00.000Z",
      end: "2026-06-26T17:05:00.000Z",
      open: "0.69507",
      high: "0.69672",
      low: "0.69287",
      close: "0.69316",
      volume: "101444.802158"
    },
    {
      timestampMs: Date.parse("2026-06-26T17:20:00.000Z"),
      start: "2026-06-26T17:20:00.000Z",
      end: "2026-06-26T17:35:00.000Z",
      open: "0.69604",
      high: "0.69797",
      low: "0.69495",
      close: "0.69734",
      volume: "86921.414432"
    }
  ];
}

function officialSource(
  endpoint: "pool_registry" | "order_fills",
  input: Partial<Parameters<DeepbookCandleSourceClient["fetchCandles"]>[0]> = {}
): DeepbookCandleSourceEvidence {
  return {
    baseUrl: "https://deepbook-indexer.mainnet.mystenlabs.com",
    endpoint,
    url:
      endpoint === "pool_registry"
        ? "https://deepbook-indexer.mainnet.mystenlabs.com/get_pools"
        : `https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/${input.poolName}?interval=${input.interval}`,
    fetchedAt: "2026-06-27T00:00:00.000Z",
    sourceStatement: DEEPBOOK_CANDLE_SOURCE_STATEMENT,
    poolId: input.poolId, poolName: input.poolName,
    interval: input.interval,
    startTimeMs: input.startTimeMs,
    endTimeMs: input.endTimeMs,
    limit: input.limit
  };
}

async function expectReadServiceCacheError(promise: Promise<unknown>, operation: "read" | "write") {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ReadServiceCacheError);
  expect(caught).toMatchObject({
    kind: "metadata_cache_unavailable",
    details: { resource: "coin_metadata_cache", operation }
  });
}

describe("SuiReadService", () => {
  it("tracks pinned DeepBook coin registry field shape", () => {
    const coinKeys = [...new Set(Object.values(mainnetCoins).flatMap((coin) => Object.keys(coin)))].sort();
    expect(coinKeys).toEqual(["address", "currencyId", "feed", "priceInfoObjectId", "scalar", "type"]);
  });

  it("exposes only the supported DeepBook token registry fields", () => {
    const allowedKeys = new Set([
      "address",
      "currencyId",
      "decimals",
      "feed",
      "poolKeys",
      "priceInfoObjectId",
      "scalar",
      "symbol",
      "type",
      "unitSource"
    ]);
    const tokens = listDeepbookTokenRegistry();

    expect(tokens.find((token) => token.symbol === "SUI")).toMatchObject({
      symbol: "SUI",
      decimals: 9,
      unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE,
      poolKeys: expect.arrayContaining(["SUI_USDC"])
    });
    for (const token of tokens) {
      expect(Object.keys(token).every((key) => allowedKeys.has(key))).toBe(true);
    }
  });

  it("derives DeepBook decimals only from power-of-ten scalars", () => {
    expect(decimalsFromScalar(1)).toBe(0);
    expect(decimalsFromScalar(1_000_000)).toBe(6);
    expect(decimalsFromScalar(100_000_000)).toBe(8);
    expect(decimalsFromScalar(1_000_000_000)).toBe(9);
    expect(decimalsFromScalar(12)).toBeUndefined();
    expect(decimalsFromScalar(0)).toBeUndefined();
  });

  it("formats raw amounts without floating point conversion", () => {
    expect(formatRawAmount("0", 9)).toBe("0");
    expect(formatRawAmount("1000000000", 9)).toBe("1");
    expect(formatRawAmount("1234500000", 9)).toBe("1.2345");
    expect(formatRawAmount("1", 9)).toBe("0.000000001");
    expect(formatRawAmount("100", 0)).toBe("100");
  });

  it("parses display amounts to raw strings without rounding", () => {
    expect(parseDisplayAmountToRaw("0", 6)).toBe("0");
    expect(parseDisplayAmountToRaw("0001.2300", 6)).toBe("1230000");
    expect(parseDisplayAmountToRaw("1", 0)).toBe("1");
    expect(parseDisplayAmountToRaw("0.000001", 6)).toBe("1");
    for (const invalid of [" 1", "-1", "+1", "1,000", "1e3", ".", "1.", ".1"]) {
      expect(() => parseDisplayAmountToRaw(invalid, 6)).toThrow("display amount must be an unsigned decimal string");
    }
    expect(() => parseDisplayAmountToRaw("1.0000001", 6)).toThrow(
      "display amount has more fractional digits than verified decimals"
    );
  });

  it("summarizes wallet balances with ISO UTC fetchedAt", async () => {
    const result = await createService().summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result).toMatchObject({
      status: "ok",
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      source: {
        sdk: "@mysten/sui",
        transport: "grpc",
        method: "client.core.listBalances"
      },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["current_coin_balance_snapshot"]),
        cannotAnswer: expect.arrayContaining([
          "transaction_history",
          "payment_coverage_or_shortfall",
          "usd_denominated_settlement_asset_balance_total"
        ]),
        answerFields: expect.arrayContaining(["balances[].display"]),
        followUp: {
          tool: "read_preview_intent_evidence",
          inputFields: ["account"],
          answerFields: ["responseSummary"]
        }
      },
      quantitySemantics: {
        kind: "sui_wallet_balance_snapshot",
        allowedUse: "current_coin_balance_snapshot",
        transactionReceiptProofAvailable: false,
        transactionBalanceDeltaAvailable: false,
        acquisitionSourceAvailable: false,
        objectProvenanceAvailable: false,
        profitAndLossAvailable: false,
        costBasisAvailable: false,
        notFor: expect.arrayContaining([
          "transaction_receipt_proof",
          "specific_transaction_balance_delta",
          "acquisition_source",
          "object_provenance",
          "profit_or_pnl",
          "cost_basis"
        ])
      }
    });
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
    expect(result.fetchedAt).toBe("2026-05-11T00:00:00.000Z");
    expect(result.balances[0]).toMatchObject({
      unit: {
        status: "available",
        source: "sui_core_getCoinMetadata",
        decimals: 9,
        symbol: "SUI",
        cacheStatus: "miss"
      },
      display: {
        amount: "0.0000001",
        symbol: "SUI",
        source: "raw_balance_with_verified_decimals"
      }
    });
  });

  it("passes wallet balance cursors through to the gRPC client", async () => {
    let listBalancesOptions: unknown;
    const result = await createService({
      async listBalances(options) {
        listBalancesOptions = options;
        return {
          balances: [],
          hasNextPage: true,
          cursor: "next-cursor"
        };
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cursor: "cursor-1" });

    expect(listBalancesOptions).toEqual({ owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cursor: "cursor-1" });
    expect(result.cursor).toBe("next-cursor");
    expect(result.hasNextPage).toBe(true);
  });

  it("summarizeAccountInventory splits coins, NFTs, and other objects and resolves the SuiNS name", async () => {
    const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = await createService({
      defaultNameServiceName: async () => ({ data: { name: "alice.sui" } }),
      listOwnedObjects: async () =>
        ({
          objects: [
            { objectId: "0xc1", type: "0x2::coin::Coin<0x2::sui::SUI>", display: null },
            {
              objectId: "0xn1",
              type: "0xabc::art::Piece",
              display: { output: { name: "Cool NFT", image_url: "https://example.test/y.png" } }
            },
            { objectId: "0xo1", type: "0xabc::game::Sword", display: null },
            { objectId: "0xo2", type: "0xabc::game::Sword", display: null }
          ],
          hasNextPage: false,
          cursor: null
        }) as unknown as SuiClientTypes.ListOwnedObjectsResponse<{ display: true }>
    }).summarizeAccountInventory({ account });

    expect(result.name).toBe("alice.sui");
    // The Coin object stays in the balance view; only the NFT and the grouped
    // other objects come from the object scan.
    expect(result.nfts).toEqual([
      { objectId: "0xn1", type: "0xabc::art::Piece", name: "Cool NFT", imageUrl: "https://example.test/y.png" }
    ]);
    expect(result.objectGroups).toEqual([{ type: "0xabc::game::Sword", count: 2 }]);
    expect(result.objectsTruncated).toBe(false);
    expect(result.balances.length).toBeGreaterThan(0);
  });

  it("keeps independent account sections and counts observed Display rows beyond the rendering cap", async () => {
    const display = Array.from({ length: 61 }, (_, i) => ({ objectId: "piece-" + i, type: "0xab::art::Piece", display: { output: { name: "Art" } } }));
    const objectTypes = ["0xabc::coin::Coin<0x2::sui::SUI>", "0xabc::wrap::Box<0x2::coin::Coin<0x2::sui::SUI>>"];
    const result = await createService({
      listBalances: async () => { throw new Error("balance source unavailable"); },
      defaultNameServiceName: async () => ({ data: { name: "alice.sui" } }),
      listOwnedObjects: async () => ({ hasNextPage: false, cursor: null,
        objects: [...display, ...objectTypes.map((type, i) => ({ objectId: "other-" + i, type, display: null }))]
      } as unknown as SuiClientTypes.ListOwnedObjectsResponse<{ display: true }>)
    }).summarizeAccountInventory({ account: managerAddress });
    expect(result).toMatchObject({ name: "alice.sui", nameStatus: "found", balancePages: 0,
      balancesIncompleteReason: "wallet_balance_source_unavailable", objectScanStatus: "complete",
      displayObjectCount: 61, displayObjectsTruncated: true, scannedObjects: 63 });
    expect(result.nfts).toHaveLength(60);
    expect(result.objectGroups.map(group => group.type)).toEqual(objectTypes);
  });

  it.each([["70", 1], ["71", 0]] as const)("deduplicates paginated wallet totals and excludes conflicts", async (last, retained) => {
    const coin = (coinType: string, amount: string) => ({ coinType, balance: amount, coinBalance: amount, addressBalance: "0" });
    const result = await createService({
      listBalances: async ({ cursor }) => cursor === "third" ? { balances: [coin("0x2::sui::SUI", last)], hasNextPage: false, cursor: null }
        : cursor === "second" ? { balances: [coin("0x2::sui::SUI","70")], hasNextPage: true, cursor: "third" }
        : { balances: [coin("0x2::empty::EMPTY","0")], hasNextPage: true, cursor: "second" }
    }).summarizeAccountInventory({ account: managerAddress });
    expect(result.balancePages).toBe(3);
    expect(result.balances).toHaveLength(retained);
    if (retained) expect(result.balances[0]?.balance).toBe("70");
    else expect(result.balancesIncompleteReason).toBe("wallet_balance_conflict");
  });

  it("summarizeAccountInventory reports a null name when the account has none", async () => {
    const result = await createService({
      defaultNameServiceName: async () => {
        throw new Error("NOT_FOUND");
      }
    }).summarizeAccountInventory({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(result.name).toBeNull();
  });

  it("summarizeAccountInventory drops zero-balance coins from the list", async () => {
    const result = await createService({
      listBalances: async () => ({
        balances: [
          { coinType: "0x2::sui::SUI", balance: "100", coinBalance: "100", addressBalance: "0" },
          { coinType: "0xdead::z::Z", balance: "0", coinBalance: "0", addressBalance: "0" }
        ],
        hasNextPage: false,
        cursor: null
      })
    }).summarizeAccountInventory({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const coinTypes = result.balances.map((balance) => balance.coinType);
    expect(coinTypes).toContain("0x2::sui::SUI");
    expect(coinTypes).not.toContain("0xdead::z::Z");
  });

  it("classifies wallet coin balances with balanceStatus and roles", async () => {
    const result = await createService({
      async listBalances() {
        return {
          balances: [
            { coinType: "0x2::sui::SUI", balance: "100", coinBalance: "100", addressBalance: "100" },
            { coinType: "0x2::custom::COIN", balance: "5", coinBalance: "5", addressBalance: "5" }
          ],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata({ coinType }) {
        if (coinType === normalizeCoinType("0x2::custom::COIN")) {
          return { coinMetadata: null };
        }
        return {
          coinMetadata: {
            id: null,
            decimals: 9,
            name: "Sui",
            symbol: "SUI",
            description: "",
            iconUrl: null
          }
        };
      }
    }).classifyWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result).toMatchObject({
      status: "ok",
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      source: { method: "client.core.listBalances" },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["current_coin_balance_classification"]),
        cannotAnswer: expect.arrayContaining([
          "complete_portfolio_inventory",
          "payment_coverage_or_shortfall",
          "usd_denominated_settlement_asset_balance_total"
        ]),
        answerFields: expect.arrayContaining(["classifiedAssets[].classification"]),
        followUp: {
          tool: "read_preview_intent_evidence",
          inputFields: ["account"],
          answerFields: ["responseSummary"]
        }
      },
      quantitySemantics: {
        kind: "sui_wallet_balance_snapshot",
        currentBalanceSnapshot: true,
        transactionHistoryAvailable: false,
        transactionReceiptProofAvailable: false
      },
      classifiedAssets: [
        {
          classification: {
            assetClass: "coin_balance",
            balanceStatus: "nonzero",
            roles: ["gas_candidate", "deepbook_registered"]
          }
        },
        {
          balance: { unit: { status: "unavailable", reason: "metadata_not_found" } },
          classification: {
            assetClass: "coin_balance",
            balanceStatus: "nonzero",
            roles: []
          }
        }
      ],
      uninspectedAssetClasses: [
        {
          assetClass: "staked_or_locked_asset",
          reason: "requires_separate_stake_read_not_inspected"
        },
        {
          assetClass: "deepbook_balance_manager_or_open_order",
          reason: "requires_separate_deepbook_account_read_not_inspected"
        },
        {
          assetClass: "lp_vault_or_position",
          reason: "requires_separate_protocol_read_not_inspected"
        },
        {
          assetClass: "nft_or_object_asset",
          reason: "requires_separate_object_read_not_inspected"
        }
      ]
    });
  });

  it("classifies empty wallet pages and preserves pagination fields", async () => {
    const result = await createService({
      async listBalances() {
        return {
          balances: [],
          hasNextPage: true,
          cursor: "next-cursor"
        };
      }
    }).classifyWalletAssets({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      cursor: "cursor-1"
    });

    expect(result.classifiedAssets).toEqual([]);
    expect(result.uninspectedAssetClasses).toHaveLength(4);
    expect(result.hasNextPage).toBe(true);
    expect(result.cursor).toBe("next-cursor");
  });

  it("returns independent not-inspected asset boundary objects", async () => {
    const service = createService({
      async listBalances() {
        return {
          balances: [],
          hasNextPage: false,
          cursor: null
        };
      }
    });
    const first = await service.classifyWalletAssets({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    first.uninspectedAssetClasses[0] = {
      assetClass: "staked_or_locked_asset",
      reason: "requires_separate_stake_read_not_inspected"
    };
    (first.uninspectedAssetClasses[0] as { reason: string }).reason = "mutated";

    const second = await service.classifyWalletAssets({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(second.uninspectedAssetClasses[0]).toEqual({
      assetClass: "staked_or_locked_asset",
      reason: "requires_separate_stake_read_not_inspected"
    });
  });

  it("classifies zero SUI balances without dropping gas or DeepBook roles", async () => {
    const result = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: "0x2::sui::SUI", balance: "0", coinBalance: "0", addressBalance: "0" }],
          hasNextPage: false,
          cursor: null
        };
      }
    }).classifyWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result.classifiedAssets[0]).toMatchObject({
      classification: {
        assetClass: "coin_balance",
        balanceStatus: "zero",
        roles: ["gas_candidate", "deepbook_registered"]
      }
    });
  });

  it("uses the DeepBook fallback matcher for registered token classification", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    if (!usdc) {
      throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }
    const result = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: usdc.type, balance: "1000000", coinBalance: "1000000", addressBalance: "1000000" }],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).classifyWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result.classifiedAssets[0]).toMatchObject({
      balance: {
        unit: {
          status: "available",
          source: DEEPBOOK_SCALAR_UNIT_SOURCE
        }
      },
      classification: {
        balanceStatus: "nonzero",
        roles: ["deepbook_registered"]
      }
    });
  });

  it("fails wallet asset classification closed when DeepBook scalar metadata is invalid", async () => {
    await expect(
      createService({
        deepbookCoins: deepbookCoinsWithInvalidSuiScalar(),
        async getCoinMetadata() {
          return { coinMetadata: null };
        }
      }).classifyWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    ).rejects.toThrow("DeepBook token scalar is not a power of ten");
  });

  it("inherits corrupt coin metadata decimal failures for wallet asset classification", async () => {
    await expect(
      createService({
        async getCoinMetadata() {
          return {
            coinMetadata: {
              id: null,
              decimals: 300,
              name: "Broken",
              symbol: "BRK",
              description: "",
              iconUrl: null
            }
          };
        }
      }).classifyWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    ).rejects.toThrow("Coin metadata decimals must be an integer from 0 to 255");
  });

  it("inherits coin metadata cache write failures for wallet asset classification", async () => {
    const cache: CoinMetadataCache = {
      async getCoinMetadata() {
        return { status: "miss" };
      },
      async setCoinMetadata() {
        throw new Error("cache write failed");
      }
    };

    await expectReadServiceCacheError(
      createService({ coinMetadataCache: cache }).classifyWalletAssets({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      "write"
    );
  });

  it("classifies coin metadata cache read failures for wallet read paths", async () => {
    const cache: CoinMetadataCache = {
      async getCoinMetadata() {
        throw new Error("cache read failed");
      },
      async setCoinMetadata() {}
    };

    await expectReadServiceCacheError(
      createService({ coinMetadataCache: cache }).summarizeWalletAssets({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      "read"
    );
    await expectReadServiceCacheError(
      createService({ coinMetadataCache: cache }).classifyWalletAssets({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      "read"
    );
    await expectReadServiceCacheError(
      createService({ coinMetadataCache: cache }).previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1"
      }),
      "read"
    );
  });

  it("lists the pinned Sui USD-denominated settlement asset group", () => {
    const result = createService().listSettlementAssetGroups();

    expect(result).toMatchObject({
      status: "ok",
      fetchedAt: "2026-05-11T00:00:00.000Z",
      assetGroups: [
        {
          id: "SUI_USD_SETTLEMENT_ASSETS",
          aliases: expect.arrayContaining(["dollar", "usd", "stablecoins"]),
          evidenceSources: {
            sdk: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.sdk,
            registry: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.registry,
            network: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.network,
            unitSource: DEEPBOOK_PINNED_SDK_METADATA_SOURCE.unitSource
          },
          limitations: expect.arrayContaining([
            "static_pinned_sdk_registry_not_live_liquidity",
            "not_route_recommendation",
            "not_signing_readiness"
          ])
        }
      ]
    });
    expect(result.assetGroups[0]?.includedAssets.map((asset) => asset.symbol)).toEqual(
      expect.arrayContaining(["USDC", "USDT", "WUSDC", "WUSDT", "AUSD", "USDSUI", "SUIUSDE"])
    );
    expect(result.assetGroups[0]?.includedAssets.map((asset) => asset.symbol)).not.toContain("SUI");
    expect(result.assetGroups[0]?.excludedAssets).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: "SUI", reason: "gas_or_volatile_asset" })])
    );
  });

  it("summarizes USD-denominated settlement asset group parity without selecting a settlement token", async () => {
    const result = await createService({
      deepbook: {
        async midPrice(poolKey) {
          const prices: Record<string, number> = {
            AUSD_USDC: 0.825005,
            SUIUSDE_USDC: 0.9997485,
            USDSUI_USDC: 1.001288,
            USDT_USDC: 0.9991955,
            WUSDC_USDC: 2.798605,
            WUSDT_USDC: 1.0325
          };
          return prices[poolKey] ?? 1;
        }
      }
    }).summarizeSettlementAssetGroupParity({
      denomination: KOREAN_DOLLAR_ALIAS,
      simulationSender: "0x0000000000000000000000000000000000000000000000000000000000000000"
    });

    expect(result).toMatchObject({
      status: "ok",
      denomination: "dollar",
      assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
      referenceAsset: {
        symbol: "USDC",
        role: "measurement_reference_not_settlement_choice"
      },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["settlement_asset_group_internal_parity_statistics"]),
        cannotAnswer: expect.arrayContaining(["settlement_token_selection", "payment_coverage_or_shortfall"]),
        answerFields: expect.arrayContaining(["responseSummary", "responseSummary.referenceAssetRole"])
      },
      quantitySemantics: {
        kind: "settlement_asset_group_parity_snapshot",
        allowedUse: "settlement_asset_group_internal_parity_evidence",
        referenceAssetRole: "measurement_reference_not_settlement_choice",
        settlementTokenSelectionAvailable: false,
        fiatUsdCashOutAvailable: false,
        routeRecommendationAvailable: false
      },
      statistics: {
        sampleCount: 7,
        unavailableAssetCount: 0,
        parityDirection: "reference_asset_per_group_asset",
        min: { symbol: "AUSD", priceInReferenceAsset: 0.825005 },
        max: { symbol: "WUSDC", priceInReferenceAsset: 2.798605 },
        mean: { priceInReferenceAsset: 1.236620286 },
        median: { priceInReferenceAsset: 1 }
      },
      responseSummary: {
        questionKind: "settlement_asset_group_parity",
        conclusionKind: "parity_statistics_available",
        assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
        referenceAssetSymbol: "USDC",
        referenceAssetRole: "measurement_reference_not_settlement_choice",
        parityDirection: "reference_asset_per_group_asset",
        min: { symbol: "AUSD", priceInReferenceAsset: 0.825005 },
        max: { symbol: "WUSDC", priceInReferenceAsset: 2.798605 },
        mean: { priceInReferenceAsset: 1.236620286 },
        median: { priceInReferenceAsset: 1 },
        excludedFromConclusion: expect.arrayContaining(["settlement_token_selection", "best_route"])
      },
      unsupportedClaims: expect.arrayContaining(["settlement_token_selection", "fiat_usd_cash_out", "best_route"])
    });
    expect(result.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "USDC",
          status: "reference_asset",
          priceInReferenceAsset: 1
        }),
        expect.objectContaining({
          symbol: "USDT",
          status: "measured",
          poolKey: "USDT_USDC",
          direction: "base_to_quote",
          poolMidPrice: 0.9991955,
          priceInReferenceAsset: 0.9991955
        })
      ])
    );
  });

  it("returns a reference but no parity statistics when every market price is unavailable", async () => {
    const result = await createService({ deepbook: { async midPrice() { throw new Error("Unavailable"); } } })
      .summarizeSettlementAssetGroupParity({ denomination: "USD", simulationSender: managerAddress });
    expect(result.assets).toContainEqual(expect.objectContaining({ status: "reference_asset", priceInReferenceAsset: 1 }));
    expect(result.statistics).toMatchObject({ status: "unavailable", sampleCount: 0 });
    expect(result.responseSummary).toMatchObject({ conclusionKind: "parity_statistics_unavailable", reason: "no_measured_market_prices" });
    for (const key of ["min", "max", "mean", "median"]) {
      expect(result.statistics).not.toHaveProperty(key);
      expect(result.responseSummary).not.toHaveProperty(key);
      expect(result.userAnswerUse.answerFields).not.toContain("responseSummary." + key);
    }
    expect(result.userAnswerUse.canAnswer).not.toContain("settlement_asset_group_internal_parity_statistics");
  });

  it("builds intent evidence for a natural-language dollar target across wallet balance pages", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    if (!usdc) {
      throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }
    const seenCursors: Array<string | null | undefined> = [];
    const result = await createService({
      async listBalances(options) {
        seenCursors.push(options.cursor);
        if (options.cursor === "page-2") {
          return {
            balances: [{ coinType: usdc.type, balance: "1500000000", coinBalance: "1500000000", addressBalance: "1500000000" }],
            hasNextPage: false,
            cursor: null
          };
        }
        return {
          balances: [{ coinType: "0x2::sui::SUI", balance: "1000000000", coinBalance: "1000000000", addressBalance: "1000000000" }],
          hasNextPage: true,
          cursor: "page-2"
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "cover_payment_like_amount",
      denomination: KOREAN_DOLLAR_ALIAS,
      requiredDisplayAmount: "1000"
    });

    expect(seenCursors).toEqual([undefined, "page-2"]);
    expect(result).toMatchObject({
      status: "ok",
      intent: {
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1000"
      },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["usd_denominated_payment_coverage_status"]),
        cannotAnswer: expect.arrayContaining(["settlement_token_selection", "route_dependent_payment_support"]),
        answerFields: expect.arrayContaining([
          "responseSummary",
          "responseSummary.amountsUsedForAnswer",
          "responseSummary.shortfallDisplayAmount"
        ])
      },
      quantitySemantics: {
        kind: "sui_intent_evidence_report",
        transactionBuildingAvailable: false,
        signingReadinessAvailable: false,
        routeRecommendationAvailable: false,
        fiatUsdCashOutAvailable: false,
        profitAndLossAvailable: false
      },
      blockedReasons: [],
      responseEvidence: {
        mode: "settlement_asset_only",
        primaryEvidenceFields: settlementAssetOnlyAnswerFields,
        supportedResponseClaims: [
          "settlement_asset_coverage_status",
          "settlement_asset_shortfall",
          "required_user_choices",
          "unsupported_inferences"
        ]
      },
      aggregate: {
        status: "available",
        requiredDisplayAmount: "1000",
        requiredRawAmount: "1000000000",
        currentRawAmount: "1500000000",
        currentDisplayAmount: "1500",
        shortfallRawAmount: "0"
      },
      settlementAssetCoverage: {
        status: "covered_by_settlement_asset_balance",
        requiredDisplayAmount: "1000",
        currentDisplayAmount: "1500",
        shortfallDisplayAmount: "0",
        boundary: [
          "current_wallet_coin_balance_snapshot",
          "settlement_asset_assets_only",
          "not_settlement_token_selection",
          "not_route_dependent_payment_support",
          "not_payment_execution_readiness",
          "not_gas_readiness"
        ]
      },
      responseSummary: {
        questionKind: "payment_coverage",
        conclusionKind: "covered_by_settlement_asset_balance",
        coverageBasis: "settlement_asset_wallet_balance_only",
        assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
        currentDisplayAmount: "1500",
        requiredDisplayAmount: "1000",
        shortfallDisplayAmount: "0",
        excludedFromConclusion: expect.arrayContaining([
          "separate_quote_tool_results",
          "assets_outside_settlement_group",
          "settlement_token_selection",
          "route_dependent_payment_support",
          "gas_reserve_or_fee_readiness"
        ])
      },
      inspectedBalancePages: 2,
      inspectedCoinBalanceCount: 2,
      balances: expect.arrayContaining([
        expect.objectContaining({
          symbol: "USDC",
          coinType: normalizeCoinType(usdc.type),
          currentRawAmount: "1500000000",
          currentDisplayAmount: "1500"
        })
      ]),
      candidateConversions: [
        {
          sourceSymbol: "USDC",
          sourceRawAmount: "1500000000",
          sourceDisplayAmount: "1500",
          status: "target_asset_not_selected"
        }
      ],
      requiredUserChoices: [
        "Choose the onchain settlement asset or merchant-accepted USD-denominated asset set before target-specific settlement evidence can be completed."
      ],
      unsupportedClaims: expect.arrayContaining([
        "settlement_token_selection",
        "gas_reserve_or_fee_readiness",
        "route_dependent_payment_support",
        "payment_execution_readiness",
        "transaction_building",
        "signing_readiness"
      ])
    });
    expect(JSON.stringify(primaryResponseEvidence(result))).not.toMatch(/\b(?:USDC|USDT|WUSDC|WUSDT)\b/);
  });

  it("summarizes settlement-asset USD-denominated balances without inventing a payment target", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    const wusdt = (mainnetCoins as DeepBookCoinRegistry).WUSDT;
    if (!usdc || !wusdt) {
      throw new Error("USDC or WUSDT token fixture is missing from pinned DeepBook mainnetCoins");
    }

    const result = await createService({
      async listBalances() {
        return {
          balances: [
            { coinType: usdc.type, balance: "1200000", coinBalance: "1200000", addressBalance: "1200000" },
            { coinType: wusdt.type, balance: "300000", coinBalance: "300000", addressBalance: "300000" }
          ],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "summarize_settlement_asset_group_balance",
      denomination: "dollar"
    });

    expect(result.intent).toEqual({
      intentKind: "summarize_settlement_asset_group_balance",
      denomination: "dollar"
    });
    expect(result.aggregate).toMatchObject({
      status: "available",
      currentRawAmount: "1500000",
      currentDisplayAmount: "1.5"
    });
    expect(result.aggregate).not.toHaveProperty("requiredDisplayAmount");
    expect(result.settlementAssetCoverage).toMatchObject({
      status: "balance_total_only",
      currentRawAmount: "1500000",
      currentDisplayAmount: "1.5"
    });
    expect(result.responseEvidence).toEqual({
      mode: "settlement_asset_only",
      primaryEvidenceFields: settlementAssetOnlyAnswerFields,
      supportedResponseClaims: ["current_settlement_asset_total", "required_user_choices", "unsupported_inferences"]
    });
    expect(result.responseSummary).toMatchObject({
      questionKind: "settlement_asset_group_balance_total",
      conclusionKind: "current_settlement_asset_total",
      coverageBasis: "settlement_asset_wallet_balance_only",
      assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
      currentDisplayAmount: "1.5",
      requiredDisplayAmount: null,
      shortfallDisplayAmount: null,
      amountsUsedForAnswer: {
        currentDisplayAmount: "current_wallet_balance_in_settlement_asset_group",
        requiredDisplayAmount: null,
        shortfallDisplayAmount: null
      },
      separateQuoteOutputs: {
        usedForPaymentAnswer: false,
        usedForShortfallAnswer: false,
        reason: "separate_quote_tool_outputs_are_price_estimates_only",
        paymentAnswerField: "responseSummary"
      },
      requiredUserChoices: [],
      excludedFromConclusion: expect.arrayContaining(["separate_quote_tool_results", "settlement_token_selection"])
    });
    expect(result.candidateConversions).toEqual([]);
    expect(result.requiredUserChoices).toEqual([]);
    expect(result.unsupportedClaims).toEqual(
      expect.arrayContaining(["settlement_token_selection", "payment_execution_readiness", "signing_readiness"])
    );
  });

  it("reports settlement-asset shortfall without selecting a settlement token", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    if (!usdc) {
      throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }

    const result = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: usdc.type, balance: "400000000", coinBalance: "400000000", addressBalance: "400000000" }],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "cover_payment_like_amount",
      denomination: "dollar",
      requiredDisplayAmount: "1000"
    });

    expect(result.settlementAssetCoverage).toMatchObject({
      status: "shortfall_in_settlement_asset_balance",
      requiredDisplayAmount: "1000",
      currentDisplayAmount: "400",
      shortfallDisplayAmount: "600",
      boundary: expect.arrayContaining(["not_settlement_token_selection", "not_payment_execution_readiness"])
    });
    expect(result.responseEvidence).toEqual({
      mode: "settlement_asset_only",
      primaryEvidenceFields: settlementAssetOnlyAnswerFields,
      supportedResponseClaims: [
        "settlement_asset_coverage_status",
        "settlement_asset_shortfall",
        "required_user_choices",
        "unsupported_inferences"
      ]
    });
    expect(result.responseSummary).toMatchObject({
      questionKind: "payment_coverage",
      conclusionKind: "shortfall_in_settlement_asset_balance",
      coverageBasis: "settlement_asset_wallet_balance_only",
      assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
      currentDisplayAmount: "400",
      requiredDisplayAmount: "1000",
      shortfallDisplayAmount: "600",
      amountsUsedForAnswer: {
        currentDisplayAmount: "current_wallet_balance_in_settlement_asset_group",
        requiredDisplayAmount: "amount_requested_by_user",
        shortfallDisplayAmount: "required_amount_minus_current_settlement_asset_balance"
      },
      separateQuoteOutputs: {
        usedForPaymentAnswer: false,
        usedForShortfallAnswer: false,
        reason: "separate_quote_tool_outputs_are_price_estimates_only",
        paymentAnswerField: "responseSummary"
      },
      excludedFromConclusion: expect.arrayContaining([
        "separate_quote_tool_results",
        "assets_outside_settlement_group",
        "route_dependent_payment_support"
      ])
    });
    expect(result.requiredUserChoices).toEqual([
      "Choose the onchain settlement asset or merchant-accepted USD-denominated asset set before target-specific settlement evidence can be completed."
    ]);
    expect(result.candidateConversions).toEqual([
      expect.objectContaining({
        sourceSymbol: "USDC",
        status: "target_asset_not_selected"
      })
    ]);
  });

  it("keeps non-group quote output out of payment coverage after wallet and quote detours", async () => {
    const coins = mainnetCoins as DeepBookCoinRegistry;
    const usdc = coins.USDC;
    const sui = coins.SUI;
    const ns = coins.NS;
    if (!usdc || !sui || !ns) {
      throw new Error("SUI, NS, or USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }

    const service = createService({
      async listBalances() {
        return {
          balances: [
            { coinType: sui.type, balance: "148626825440", coinBalance: "148626825440", addressBalance: "0" },
            { coinType: ns.type, balance: "254984750", coinBalance: "254984750", addressBalance: "0" },
            { coinType: usdc.type, balance: "278890119", coinBalance: "278890119", addressBalance: "0" }
          ],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      },
      deepbook: {
        async getQuoteQuantityOutRaw(poolKey) {
          if (poolKey === "SUI_USDC") {
            return { baseOutRaw: "26825440", quoteOutRaw: "148641608", deepRequiredRaw: "954804" };
          }
          if (poolKey === "NS_USDC") {
            return { baseOutRaw: "84750", quoteOutRaw: "3456013", deepRequiredRaw: "111014" };
          }
          return { baseOutRaw: "0", quoteOutRaw: "0", deepRequiredRaw: "0" };
        }
      }
    });

    const intentEvidence = await service.previewIntentEvidence({
      account: accountAddress,
      intentKind: "cover_payment_like_amount",
      denomination: "dollar",
      requiredDisplayAmount: "1000"
    });
    const walletSnapshot = await service.summarizeWalletAssets({ account: accountAddress });
    const suiQuote = await service.quoteDeepbookDisplayAmount({
      poolKey: "SUI_USDC",
      direction: "base_to_quote",
      amountDisplay: "148.62682544",
      simulationSender: accountAddress
    });
    const nsQuote = await service.quoteDeepbookDisplayAmount({
      poolKey: "NS_USDC",
      direction: "base_to_quote",
      amountDisplay: "254.98475",
      simulationSender: accountAddress
    });

    expect(walletSnapshot.balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ display: expect.objectContaining({ amount: "148.62682544", symbol: "SUI" }) }),
        expect.objectContaining({ display: expect.objectContaining({ amount: "254.98475", symbol: "NS" }) })
      ])
    );
    expect(suiQuote.quote.quoteOut).toBe("148.641608");
    expect(nsQuote.quote.quoteOut).toBe("3.456013");
    expect(suiQuote.quantitySemantics).toMatchObject({
      paymentCoverageAvailable: false,
      shortfallContributionAvailable: false,
      routeDependentPaymentSupportAvailable: false,
      requiresIntentEvidenceForCoverage: true,
      canUseForPaymentAnswer: false,
      canUseForShortfallAnswer: false,
      doNotCombineWithPaymentAnswer: true,
      requiredPaymentAnswerTool: "read_preview_intent_evidence",
      paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
      requiredPaymentAnswerField: "responseSummary"
    });
    expect(nsQuote.quantitySemantics).toMatchObject({
      paymentCoverageAvailable: false,
      shortfallContributionAvailable: false,
      routeDependentPaymentSupportAvailable: false,
      requiresIntentEvidenceForCoverage: true,
      canUseForPaymentAnswer: false,
      canUseForShortfallAnswer: false,
      doNotCombineWithPaymentAnswer: true,
      requiredPaymentAnswerTool: "read_preview_intent_evidence",
      paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
      requiredPaymentAnswerField: "responseSummary"
    });
    expect(intentEvidence.responseEvidence).toEqual({
      mode: "settlement_asset_only",
      primaryEvidenceFields: settlementAssetOnlyAnswerFields,
      supportedResponseClaims: [
        "settlement_asset_coverage_status",
        "settlement_asset_shortfall",
        "required_user_choices",
        "unsupported_inferences"
      ]
    });
    expect(intentEvidence.userAnswerUse).toMatchObject({
      answerFields: expect.arrayContaining(["responseSummary"]),
      conclusionRuleFields: expect.arrayContaining([
        "responseSummary.doNotCallQuoteToolsForThisQuestion",
        "responseSummary.doNotUseForConclusion",
        "responseSummary.excludedFromConclusion"
      ]),
      diagnosticOnlyFields: expect.not.arrayContaining([
        "responseSummary.doNotCallQuoteToolsForThisQuestion",
        "responseSummary.doNotUseForConclusion",
        "responseSummary.excludedFromConclusion"
      ])
    });
    expect(intentEvidence.responseSummary).toMatchObject({
      questionKind: "payment_coverage",
      conclusionKind: "shortfall_in_settlement_asset_balance",
      answerCompleteness: {
        answerCompleteFor: "settlement_asset_group_answer",
        requiredAnswerFields: ["responseSummary"],
        notCompleteFor: expect.arrayContaining(["selected_target_context", "route_dependent_payment_support"])
      },
      coverageBasis: "settlement_asset_wallet_balance_only",
      currentDisplayAmount: "278.890119",
      requiredDisplayAmount: "1000",
      shortfallDisplayAmount: "721.109881",
      amountsUsedForAnswer: {
        currentDisplayAmount: "current_wallet_balance_in_settlement_asset_group",
        requiredDisplayAmount: "amount_requested_by_user",
        shortfallDisplayAmount: "required_amount_minus_current_settlement_asset_balance"
      },
      separateQuoteOutputs: {
        usedForPaymentAnswer: false,
        usedForShortfallAnswer: false,
        reason: "separate_quote_tool_outputs_are_price_estimates_only",
        paymentAnswerField: "responseSummary"
      },
      excludedFromConclusion: expect.arrayContaining([
        "separate_quote_tool_results",
        "assets_outside_settlement_group",
        "route_dependent_payment_support"
      ])
    });
  });

  it.each(intentEvidenceScenarios.map((scenario) => [scenario.id, scenario] as const))(
    "grounds a Korean USD-denominated release prompt in settlement-asset answer evidence: %s",
    async (_scenarioId, scenario) => {
      const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
      if (!usdc) {
        throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
      }
      const intentInput = scenarioInputForUserPrompt(scenario.userPrompt as IntentEvidenceScenarioPrompt);
      expect(intentInput).toEqual(scenario.previewIntentEvidenceInput);

      const result = await createService({
        async listBalances() {
          return {
            balances: [
              {
                coinType: usdc.type,
                balance: scenario.balanceRawAmount,
                coinBalance: scenario.balanceRawAmount,
                addressBalance: scenario.balanceRawAmount
              }
            ],
            hasNextPage: false,
            cursor: null
          };
        },
        async getCoinMetadata() {
          return { coinMetadata: null };
        }
      }).previewIntentEvidence({
        account: accountAddress,
        ...intentInput
      });

      expect(result.intent.denomination).toBe("dollar");
      if ("targetAmountSource" in scenario) {
        expect(scenario.targetAmountSource).toBe("prior_conversation_required_display_amount");
        expect(result.intent).toMatchObject({ requiredDisplayAmount: "1000" });
      }
      expect(result.responseEvidence).toEqual({
        mode: "settlement_asset_only",
        primaryEvidenceFields: settlementAssetOnlyAnswerFields,
        supportedResponseClaims: scenario.expectedSupportedClaims
      });
      expect(result.settlementAssetCoverage).toMatchObject({
        status: scenario.expectedCoverageStatus,
        currentDisplayAmount: scenario.expectedCurrentDisplayAmount
      });
      if (scenario.expectedShortfallDisplayAmount !== undefined) {
        expect(result.settlementAssetCoverage).toMatchObject({
          shortfallDisplayAmount: scenario.expectedShortfallDisplayAmount
        });
      }
      expect(result.responseSummary).toMatchObject({
        questionKind:
          scenario.previewIntentEvidenceInput.intentKind === "cover_payment_like_amount"
            ? "payment_coverage"
            : "settlement_asset_group_balance_total",
        conclusionKind:
          scenario.expectedCoverageStatus === "balance_total_only"
            ? "current_settlement_asset_total"
            : scenario.expectedCoverageStatus,
        coverageBasis: "settlement_asset_wallet_balance_only",
        assetGroupId: "SUI_USD_SETTLEMENT_ASSETS",
        currentDisplayAmount: scenario.expectedCurrentDisplayAmount,
        requiredDisplayAmount:
          "requiredDisplayAmount" in scenario.previewIntentEvidenceInput
            ? scenario.previewIntentEvidenceInput.requiredDisplayAmount
            : null,
        shortfallDisplayAmount: scenario.expectedShortfallDisplayAmount ?? null,
        separateQuoteOutputs: {
          usedForPaymentAnswer: false,
          usedForShortfallAnswer: false,
          reason: "separate_quote_tool_outputs_are_price_estimates_only",
          paymentAnswerField: "responseSummary"
        },
        requiredUserChoices: expect.any(Array),
        excludedFromConclusion: expect.arrayContaining([
          "separate_quote_tool_results",
          "candidate_conversion_quote_evidence",
          "assets_outside_settlement_group",
          "settlement_token_selection",
          "route_dependent_payment_support"
        ])
      });
      expect(result.requiredUserChoices.length > 0).toBe(scenario.expectsRequiredChoice);
      expect(result.unsupportedClaims).toEqual(expect.arrayContaining([...forbiddenUsdSettlementResponseInferences]));

      const responseEvidence = primaryResponseEvidence(result);
      expect(Object.keys(responseEvidence)).toEqual([...settlementAssetOnlyAnswerFields]);
      expect(JSON.stringify(responseEvidence)).not.toMatch(/\b(?:USDC|USDT|WUSDC|WUSDT)\b/);
      expect(result.responseEvidence.supportedResponseClaims).not.toEqual(
        expect.arrayContaining([
          "settlement_token_selection",
          "fiat_usd_cash_out",
          "best_route_or_venue_comparison",
          "transaction_building",
          "signing_readiness",
          "profit_or_pnl"
        ])
      );
    }
  );

  it("quotes direct DeepBook candidates only after a target settlement asset is selected", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    const wusdt = (mainnetCoins as DeepBookCoinRegistry).WUSDT;
    if (!usdc || !wusdt) {
      throw new Error("USDC or WUSDT token fixture is missing from pinned DeepBook mainnetCoins");
    }
    const result = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: wusdt.type, balance: "2000000", coinBalance: "2000000", addressBalance: "2000000" }],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "cover_payment_like_amount",
      denomination: "stablecoins",
      requiredDisplayAmount: "10",
      targetAssetSymbol: "USDC",
      targetAssetSelectionSource: "user_explicit"
    });

    expect(result.intent).toMatchObject({
      targetAssetSymbol: "USDC",
      targetAssetSelectionSource: "user_explicit"
    });
    expect(result.selectedTarget).toMatchObject({
      symbol: "USDC",
      selectionSource: "user_explicit",
      currentRawAmount: "0",
      requiredRawAmount: "10000000",
      shortfallRawAmount: "10000000"
    });
    expect(result.settlementAssetCoverage).toMatchObject({
      status: "shortfall_in_settlement_asset_balance",
      requiredDisplayAmount: "10",
      currentDisplayAmount: "2",
      shortfallDisplayAmount: "8"
    });
    expect(result.responseEvidence).toEqual({
      mode: "selected_target_context",
      primaryEvidenceFields: [
        "responseSummary",
        "selectedTarget",
        "candidateConversions",
        "requiredUserChoices"
      ],
      supportedResponseClaims: [
        "settlement_asset_coverage_status",
        "settlement_asset_shortfall",
        "selected_target_shortfall",
        "direct_pool_quote_evidence",
        "required_user_choices",
        "unsupported_inferences"
      ]
    });
    expect(result.responseSummary.answerCompleteness).toMatchObject({
      answerCompleteFor: "selected_target_context_answer",
      requiredAnswerFields: ["responseSummary", "selectedTarget", "candidateConversions", "requiredUserChoices"]
    });
    expect(result.userAnswerUse).toMatchObject({
      canAnswer: expect.arrayContaining(["selected_target_shortfall", "direct_pool_quote_evidence_for_user_selected_target"]),
      answerFields: expect.arrayContaining(["selectedTarget", "candidateConversions", "requiredUserChoices"]),
      conclusionRuleFields: expect.arrayContaining([
        "responseSummary.doNotCallQuoteToolsForThisQuestion",
        "responseSummary.doNotUseForConclusion",
        "responseSummary.excludedFromConclusion"
      ]),
      diagnosticOnlyFields: expect.not.arrayContaining([
        "selectedTarget",
        "candidateConversions",
        "responseSummary.doNotCallQuoteToolsForThisQuestion",
        "responseSummary.doNotUseForConclusion",
        "responseSummary.excludedFromConclusion"
      ])
    });
    expect(result.candidateConversions).toEqual([
      expect.objectContaining({
        sourceSymbol: "WUSDT",
        targetSymbol: "USDC",
        sourceRawAmount: "2000000",
        sourceDisplayAmount: "2",
        status: "quoted",
        directPool: { poolKey: "WUSDT_USDC", direction: "base_to_quote" },
        boundary: [
          "quote_snapshot_only",
          "not_final_min_out",
          "not_route_recommendation",
          "not_route_dependent_payment_support",
          "not_payment_readiness",
          "not_signing_readiness"
        ],
        quote: expect.objectContaining({
          status: "ok",
          poolKey: "WUSDT_USDC",
          direction: "base_to_quote"
        })
      })
    ]);
    expect(result.requiredUserChoices).toEqual([
      "Choose which quoted candidate assets, if any, the user wants to convert."
    ]);
  });

  it("omits direct quote claims from selected-target response evidence when no quote evidence exists", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    if (!usdc) {
      throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }

    const result = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: usdc.type, balance: "2000000", coinBalance: "2000000", addressBalance: "2000000" }],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).previewIntentEvidence({
      account: accountAddress,
      intentKind: "cover_payment_like_amount",
      denomination: "dollar",
      requiredDisplayAmount: "10",
      targetAssetSymbol: "USDC",
      targetAssetSelectionSource: "prior_user_explicit_context"
    });

    expect(result.intent).toMatchObject({
      targetAssetSymbol: "USDC",
      targetAssetSelectionSource: "prior_user_explicit_context"
    });
    expect(result.selectedTarget).toMatchObject({
      symbol: "USDC",
      selectionSource: "prior_user_explicit_context",
      currentDisplayAmount: "2",
      shortfallDisplayAmount: "8"
    });
    expect(result.candidateConversions).toEqual([]);
    expect(result.requiredUserChoices).toEqual([]);
    expect(result.responseEvidence).toEqual({
      mode: "selected_target_context",
      primaryEvidenceFields: [
        "responseSummary",
        "selectedTarget",
        "candidateConversions",
        "requiredUserChoices"
      ],
      supportedResponseClaims: [
        "settlement_asset_coverage_status",
        "settlement_asset_shortfall",
        "selected_target_shortfall",
        "required_user_choices",
        "unsupported_inferences"
      ]
    });
    expect(result.userAnswerUse).toMatchObject({
      canAnswer: expect.arrayContaining(["selected_target_shortfall"]),
      answerFields: expect.arrayContaining(["selectedTarget", "candidateConversions", "requiredUserChoices"])
    });
    expect(result.userAnswerUse.canAnswer).not.toEqual(
      expect.arrayContaining(["direct_pool_quote_evidence_for_user_selected_target"])
    );
  });

  it("reports wallet pagination blockers inside intent evidence", async () => {
    const usdc = (mainnetCoins as DeepBookCoinRegistry).USDC;
    if (!usdc) {
      throw new Error("USDC token fixture is missing from pinned DeepBook mainnetCoins");
    }

    const repeatedCursor = await createService({
      async listBalances(options) {
        return {
          balances: [
            {
              coinType: usdc.type,
              balance: "400000000",
              coinBalance: "400000000",
              addressBalance: "400000000"
            }
          ],
          hasNextPage: true,
          cursor: options.cursor === "same-cursor" ? "same-cursor" : "same-cursor"
        };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "cover_payment_like_amount",
      denomination: "dollar",
      requiredDisplayAmount: "1"
    });
    expect(repeatedCursor.balances.find(asset => asset.symbol === "USDC")).toMatchObject({ currentRawAmount: "400000000" });
    const unknown = repeatedCursor.balances.find(asset => asset.symbol === "USDT");
    expect(unknown?.walletBalanceEvidence).toBe("unavailable");
    expect(unknown).not.toHaveProperty("currentRawAmount");
    expect(unknown).not.toHaveProperty("currentDisplayAmount");
    expect(repeatedCursor).toMatchObject({
      blockedReasons: ["wallet_balance_pagination_did_not_advance"],
      aggregate: {
        status: "unavailable_wallet_balance_scan_incomplete",
        requiredDisplayAmount: "1",
        reason: "wallet_balance_pagination_did_not_advance"
      },
      settlementAssetCoverage: {
        status: "unavailable_wallet_balance_scan_incomplete",
        requiredDisplayAmount: "1",
        reason: "wallet_balance_pagination_did_not_advance"
      },
      responseEvidence: {
        mode: "settlement_asset_only",
        primaryEvidenceFields: ["responseSummary"],
        supportedResponseClaims: [
          "settlement_asset_coverage_unavailable",
          "required_user_choices",
          "unsupported_inferences"
        ]
      },
      responseSummary: {
        conclusionKind: "settlement_asset_coverage_unavailable",
        answerCompleteness: {
          answerCompleteFor: "settlement_asset_coverage_unavailable_answer",
          requiredAnswerFields: [
            "responseSummary.unavailableReason",
            "blockedReasons",
            "responseSummary.requiredUserChoices"
          ],
          notCompleteFor: expect.arrayContaining(["payment_coverage_status", "payment_shortfall"])
        },
        currentDisplayAmount: null,
        requiredDisplayAmount: "1",
        shortfallDisplayAmount: null,
        unavailableReason: "wallet_balance_pagination_did_not_advance",
        amountsUsedForAnswer: {
          currentDisplayAmount: null,
          requiredDisplayAmount: "amount_requested_by_user",
          shortfallDisplayAmount: null
        }
      },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["why_usd_denominated_payment_coverage_is_unavailable"]),
        cannotAnswer: expect.arrayContaining([
          "usd_denominated_settlement_asset_balance_total",
          "usd_denominated_payment_coverage_status",
          "usd_denominated_payment_shortfall"
        ]),
        answerFields: expect.arrayContaining([
          "responseSummary.unavailableReason",
          "blockedReasons"
        ]),
        conclusionRuleFields: expect.arrayContaining([
          "responseSummary.doNotCallQuoteToolsForThisQuestion",
          "responseSummary.doNotUseForConclusion",
          "responseSummary.excludedFromConclusion"
        ]),
        diagnosticOnlyFields: expect.not.arrayContaining([
          "responseSummary.doNotCallQuoteToolsForThisQuestion",
          "responseSummary.doNotUseForConclusion",
          "responseSummary.excludedFromConclusion"
        ])
      },
      supportedClaims: ["settlement_asset_coverage_unavailable"]
    });

    const missingCursor = await createService({
      async listBalances() {
        return {
          balances: [],
          hasNextPage: true,
          cursor: undefined as unknown as string | null
        };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "cover_payment_like_amount",
      denomination: "dollar",
      requiredDisplayAmount: "1"
    });
    expect(missingCursor).toMatchObject({
      blockedReasons: ["wallet_balance_pagination_did_not_advance"],
      aggregate: {
        status: "unavailable_wallet_balance_scan_incomplete",
        reason: "wallet_balance_pagination_did_not_advance"
      },
      responseSummary: {
        conclusionKind: "settlement_asset_coverage_unavailable",
        currentDisplayAmount: null,
        shortfallDisplayAmount: null,
        unavailableReason: "wallet_balance_pagination_did_not_advance"
      }
    });

    let page = 0;
    const pageLimit = await createService({
      async listBalances() {
        page += 1;
        return {
          balances: [],
          hasNextPage: true,
          cursor: `cursor-${page}`
        };
      }
    }).previewIntentEvidence({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intentKind: "cover_payment_like_amount",
      denomination: "dollar",
      requiredDisplayAmount: "1"
    });
    expect(pageLimit).toMatchObject({
      blockedReasons: ["wallet_balance_page_limit_exceeded"],
      aggregate: {
        status: "unavailable_wallet_balance_scan_incomplete",
        reason: "wallet_balance_page_limit_exceeded"
      },
      settlementAssetCoverage: {
        status: "unavailable_wallet_balance_scan_incomplete",
        reason: "wallet_balance_page_limit_exceeded"
      },
      responseSummary: {
        conclusionKind: "settlement_asset_coverage_unavailable",
        currentDisplayAmount: null,
        shortfallDisplayAmount: null,
        unavailableReason: "wallet_balance_page_limit_exceeded"
      },
      inspectedBalancePages: 20
    });
  });

  it("fails intent evidence for unsupported denominations or non-group targets", async () => {
    const service = createService();
    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "euro",
        requiredDisplayAmount: "1"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "denomination" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1",
        targetAssetSymbol: "USDC"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "targetAssetSelectionSource", requiredWith: "targetAssetSymbol" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1",
        targetAssetSymbol: "USDC",
        targetAssetSelectionSource: "agent_inferred" as never
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "targetAssetSelectionSource", value: "agent_inferred" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1",
        targetAssetSelectionSource: "user_explicit"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "targetAssetSymbol", requiredWith: "targetAssetSelectionSource" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1",
        targetAssetSymbol: "SUI"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "targetAssetSelectionSource", requiredWith: "targetAssetSymbol" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1",
        targetAssetSymbol: "SUI",
        targetAssetSelectionSource: "user_explicit"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "targetAssetSymbol", canonicalSymbol: "SUI", assetGroupId: "SUI_USD_SETTLEMENT_ASSETS" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1",
        targetAssetSymbol: "USDC",
        targetAssetSelectionSource: "user_explicit",
        acceptedSourceAssetSymbols: ["SUI"]
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "acceptedSourceAssetSymbols[0]", canonicalSymbol: "SUI", assetGroupId: "SUI_USD_SETTLEMENT_ASSETS" }
    });

    await expect(
      service.previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "summarize_settlement_asset_group_balance",
        denomination: "dollar",
        requiredDisplayAmount: "1"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "requiredDisplayAmount", intentKind: "summarize_settlement_asset_group_balance" }
    });
  });

  it("inherits intent evidence unit failures from wallet reads", async () => {
    await expect(
      createService({
        async getCoinMetadata() {
          return {
            coinMetadata: {
              id: null,
              decimals: 300,
              name: "Broken",
              symbol: "BRK",
              description: "",
              iconUrl: null
            }
          };
        }
      }).previewIntentEvidence({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        intentKind: "cover_payment_like_amount",
        denomination: "dollar",
        requiredDisplayAmount: "1"
      })
    ).rejects.toThrow("Coin metadata decimals must be an integer from 0 to 255");
  });

  it("uses fresh cached coin metadata without calling the Sui metadata endpoint", async () => {
    const cache = new MemoryCoinMetadataCache();
    await cache.setCoinMetadata({
      coinType: normalizeCoinType("0x2::sui::SUI"),
      chainIdentifier: "4c78adac",
      decimals: 9,
      symbol: "SUI",
      name: "Sui",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      expiresAt: "2026-05-12T00:00:00.000Z"
    });
    const result = await createService({
      coinMetadataCache: cache,
      async getCoinMetadata() {
        throw new Error("metadata endpoint should not be called");
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result.balances[0]).toMatchObject({
      unit: { status: "available", cacheStatus: "hit" },
      display: { amount: "0.0000001" }
    });
  });

  it("ignores expired metadata cache rows and records refetched metadata", async () => {
    const cache = new MemoryCoinMetadataCache();
    await cache.setCoinMetadata({
      coinType: normalizeCoinType("0x2::sui::SUI"),
      chainIdentifier: "4c78adac",
      decimals: 9,
      symbol: "OLD",
      name: "Old",
      fetchedAt: "2026-05-09T00:00:00.000Z",
      expiresAt: "2026-05-10T00:00:00.000Z"
    });
    const result = await createService({ coinMetadataCache: cache }).summarizeWalletAssets({
      account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result.balances[0]).toMatchObject({
      unit: { status: "available", symbol: "SUI", cacheStatus: "expired_refetched" }
    });
    expect(cache.records.get(`4c78adac:${normalizeCoinType("0x2::sui::SUI")}`)).toMatchObject({ symbol: "SUI" });
  });

  it("falls back to DeepBook scalar units when Sui metadata is unavailable", async () => {
    const result = await createService({
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result.balances[0]).toMatchObject({
      unit: {
        status: "available",
        source: DEEPBOOK_SCALAR_UNIT_SOURCE,
        decimals: 9,
        symbol: "SUI"
      },
      display: { amount: "0.0000001" }
    });
    expect(result.balances[0]?.unit).not.toHaveProperty("cacheStatus");
  });

  it("fails the DeepBook token registry closed when a pinned scalar is not a power of ten", async () => {
    expect(() => listDeepbookTokenRegistry(deepbookCoinsWithInvalidSuiScalar())).toThrow(
      "DeepBook token scalar is not a power of ten"
    );
  });

  it("does not guess wallet decimals when DeepBook scalar fallback is invalid", async () => {
    const result = await createService({
      deepbookCoins: deepbookCoinsWithInvalidSuiScalar(),
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result.balances[0]).toMatchObject({
      unit: { status: "unavailable", reason: "no_verified_decimals" }
    });
    expect(result.balances[0]).not.toHaveProperty("display");
  });

  it("does not classify successful metadata reads as unavailable when cache writes fail", async () => {
    const cache: CoinMetadataCache = {
      async getCoinMetadata() {
        return { status: "miss" };
      },
      async setCoinMetadata() {
        throw new Error("cache write failed");
      }
    };

    await expectReadServiceCacheError(
      createService({ coinMetadataCache: cache }).summarizeWalletAssets({
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      "write"
    );
  });

  it("keeps metadata lookup failures isolated to the affected asset", async () => {
    const result = await createService({
      async listBalances() {
        return {
          balances: [
            { coinType: "0x2::sui::SUI", balance: "100", coinBalance: "100", addressBalance: "100" },
            { coinType: "0x2::custom::COIN", balance: "5", coinBalance: "5", addressBalance: "5" }
          ],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata({ coinType }) {
        if (coinType === normalizeCoinType("0x2::sui::SUI")) {
          throw new Error("metadata failed");
        }
        return {
          coinMetadata: {
            id: null,
            decimals: 2,
            name: "Custom",
            symbol: "CST",
            description: "",
            iconUrl: null
          }
        };
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    expect(result.balances[0]).toMatchObject({
      unit: { status: "unavailable", reason: "metadata_lookup_failed" }
    });
    expect(result.balances[1]).toMatchObject({
      unit: { status: "available", symbol: "CST" },
      display: { amount: "0.05" }
    });
  });

  it("marks unresolved or unverified coin units without guessing decimals", async () => {
    const unresolved = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: "not-a-coin-type", balance: "1", coinBalance: "1", addressBalance: "1" }],
          hasNextPage: false,
          cursor: null
        };
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(unresolved.balances[0]).toMatchObject({
      unit: { status: "unavailable", reason: "coin_type_unresolved" }
    });

    const noMetadata = await createService({
      async listBalances() {
        return {
          balances: [{ coinType: "0x2::custom::COIN", balance: "1", coinBalance: "1", addressBalance: "1" }],
          hasNextPage: false,
          cursor: null
        };
      },
      async getCoinMetadata() {
        return { coinMetadata: null };
      }
    }).summarizeWalletAssets({ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(noMetadata.balances[0]).toMatchObject({
      unit: { status: "unavailable", reason: "metadata_not_found" }
    });
  });

  it("inspects DeepBook orderbook through the read client", async () => {
    const result = await createService().inspectDeepbookOrderbook({
      poolKey: "DEEP_SUI",
      ticks: 5,
      simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result).toMatchObject({
      status: "ok",
      poolKey: "DEEP_SUI",
      ticks: 5,
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["deepbook_pool_orderbook_context_at_fetchedAt"]),
        cannotAnswer: expect.arrayContaining(["indicative_quote_for_a_source_amount", "payment_coverage_or_shortfall"]),
        answerFields: expect.arrayContaining(["level2TicksFromMid"])
      },
      source: { simulation: DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation },
      midPrice: 12.5
    });
  });

  it("returns DeepBook pool mid price metadata", async () => {
    const result = await createService().getDeepbookMidPrice({
      poolKey: "SUI_USDC",
      simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result).toMatchObject({
      status: "ok",
      poolKey: "SUI_USDC",
      base: "SUI",
      quote: "USDC",
      price: 12.5,
      userAnswerUse: {
        canAnswer: ["deepbook_pool_mid_price_context"],
        cannotAnswer: expect.arrayContaining([
          "payment_coverage_or_shortfall",
          "price_impact",
          "transaction_building",
          "signing_data_or_readiness"
        ]),
        answerFields: expect.arrayContaining(["price", "fetchedAt"]),
        followUp: {
          tool: "read_preview_intent_evidence",
          answerFields: ["responseSummary"]
        }
      },
      priceDirection: "quote_per_base",
      priceType: "deepbook_mid_price",
      source: {
        simulation: DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation,
        method: "midPrice",
        precision: "deepbook_v3_to_fixed_9_js_number"
      },
      priceSemantics: {
        kind: "deepbook_mid_price_snapshot",
        externalMarketLookupAvailable: false,
        usdPegAssumptionAvailable: false,
        notFor: expect.arrayContaining([
          "price_impact",
          "venue_comparison",
          "fiat_usd_cash_out",
          "external_market_lookup",
          "usd_peg_assumption",
          "transaction_building",
          "signing_data",
          "signing_readiness"
        ])
      }
    });
  });

  it("returns official DeepBook USDC candle history with interval and range metadata", async () => {
    const { source, calls } = createDeepbookCandleSourceFixture();
    const result = await createService({ deepbookCandleSource: source }).getDeepbookUsdcPriceHistory({
      assetSymbol: "SUI",
      interval: "15m",
      start: "2026-06-26T16:50:00.000Z",
      end: "2026-06-26T17:35:00.000Z"
    });

    expect(calls.pools).toBe(1);
    expect(calls.candles).toEqual([
      {
        poolId: officialPoolFixture().pool_id, market: officialPoolFixture(), directId: false, window: "history",
        poolName: "SUI_USDC",
        interval: "15m",
        startTimeMs: Date.parse("2026-06-26T16:50:00.000Z"),
        endTimeMs: Date.parse("2026-06-26T17:35:00.000Z"),
        limit: 1008
      }
    ]);
    expect(result).toMatchObject({
      status: "ok",
      requested: {
        selector: { kind: "asset_symbol", value: "SUI" },
        range: {
          start: "2026-06-26T16:50:00.000Z",
          end: "2026-06-26T17:35:00.000Z",
          timeZone: "UTC",
          interval: "15m",
          intervalDurationMs: 900000,
          maxBars: 1008,
          requestedCandleSlots: 3
        }
      },
      pair: {
        poolName: "SUI_USDC",
        poolId: "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407",
        quoteAsset: {
          symbol: "USDC",
          coinType: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
          decimals: 6
        },
        priceConvention: "USDC_PER_BASE"
      },
      candleAvailability: "available",
      barCount: 2,
      source: {
        kind: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
        baseUrl: "https://deepbook-indexer.mainnet.mystenlabs.com",
        candles: {
          poolName: "SUI_USDC",
          interval: "15m"
        },
        chainRecomputedBySuiMcp: true
      },
      responseSummary: {
        sourceStatement: DEEPBOOK_CANDLE_RESPONSE_TEXT.sourceStatement,
        usdcDisclaimer: DEEPBOOK_CANDLE_RESPONSE_TEXT.usdcDisclaimer
      },
      quantitySemantics: {
        allowedUse: DEEPBOOK_ANSWER_USE.poolUsdcCandleHistory,
        quoteAsset: "USDC",
        usdcIsFiatUsd: false,
        usdPegGuaranteeAvailable: false,
        chainRecomputedBySuiMcp: true,
        routeRecommendationAvailable: false,
        signingReadinessAvailable: false
      },
      userAnswerUse: {
        canAnswer: [DEEPBOOK_ANSWER_USE.poolUsdcCandleHistory, DEEPBOOK_ANSWER_USE.candleAvailabilityForRequestedUtcRange],
        cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.officialUsdcCandles]
      },
      unsupportedClaims: expect.arrayContaining([
        "fiat_usd_cash_out",
        "usd_peg_assumption",
        "route_recommendation",
        "signing_readiness",
        "profit_or_pnl",
        "cost_basis",
      ])
    });
    if (result.status !== "ok") {
      throw new Error("expected ok history result");
    }
    expect(result.bars.map((bar) => bar.start)).toEqual([
      "2026-06-26T16:50:00.000Z",
      "2026-06-26T17:20:00.000Z"
    ]);
    expect(result.responseSummary.usdcDisclaimer).toContain("not fiat USD");
    expect(result.responseSummary.usdcDisclaimer).toContain("not a USDC/USD peg guarantee");
  });

  it("resolves official DeepBook USDC history by pool name and coin type", async () => {
    const byPool = createDeepbookCandleSourceFixture();
    await expect(
      createService({ deepbookCandleSource: byPool.source }).getDeepbookUsdcPriceHistory({
        poolName: "sui_usdc",
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "ok",
      requested: { selector: { kind: "pool_name", value: "SUI_USDC" } },
      pair: { poolName: "SUI_USDC" }
    });

    const byCoinType = createDeepbookCandleSourceFixture();
    await expect(
      createService({ deepbookCandleSource: byCoinType.source }).getDeepbookUsdcPriceHistory({
        coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "ok",
      requested: { selector: { kind: "coin_type" } },
      pair: { poolName: "SUI_USDC" }
    });
  });

  it("returns explicit unsupported pool statuses without fetching candles", async () => {
    const missing = createDeepbookCandleSourceFixture();
    await expect(
      createService({ deepbookCandleSource: missing.source }).getDeepbookUsdcPriceHistory({
        assetSymbol: "UNKNOWN",
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "unsupported_pair",
      reason: "market_not_in_mainnet_pool_catalog",
      userAnswerUse: { canAnswer: [], cannotAnswer: expect.arrayContaining(["signing_data_or_readiness"]), answerFields: expect.not.arrayContaining(["bars"]) },
      matchingPoolNames: [],
      availablePoolNames: ["SUI_USDC"]
    });
    expect(missing.calls.candles).toEqual([]);

    const ambiguous = createDeepbookCandleSourceFixture({
      pools: [
        officialPoolFixture("SUI_USDC", "SUI", "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"),
        officialPoolFixture("SUI2_USDC", "SUI", "0x9999999999999999999999999999999999999999999999999999999999999999::sui::SUI")
      ]
    });
    await expect(
      createService({ deepbookCandleSource: ambiguous.source }).getDeepbookUsdcPriceHistory({
        assetSymbol: "SUI",
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "unsupported_pair",
      reason: "selector_resolves_to_multiple_usdc_pools",
      matchingPoolNames: ["SUI_USDC", "SUI2_USDC"]
    });
    expect(ambiguous.calls.candles).toEqual([]);

    const original = officialPoolFixture();
    const namesake = { ...officialPoolFixture("SUI2_USDC", "SUI", "0x12::coin::SUI"), pool_name:original.pool_name };
    const catalog = createDeepbookCandleSourceFixture({ pools:[original,namesake] }).source;
    const range = { start:"2026-06-26T16:50:00.000Z", end:"2026-06-26T17:05:00.000Z" };
    const service = createService({deepbookCandleSource:catalog});
    await expect(service.getDeepbookUsdcPriceHistory({...range, coinType:original.base_asset_id})).resolves.toMatchObject({
      status:"ok", pair:{poolId:original.pool_id}
    });
    await expect(service.getDeepbookUsdcPriceHistory({...range, poolName:original.pool_name})).resolves.toMatchObject({
      status:"unsupported_pair", candidates:[{poolId:original.pool_id, baseCoinType:original.base_asset_id},{poolId:namesake.pool_id, baseCoinType:namesake.base_asset_id}]
    });
    const directory = await catalog.fetchPools();
    catalog.fetchPools = async () => ({...directory,pools:[original],unavailablePools:[{
      poolId:namesake.pool_id,baseCoinType:namesake.base_asset_id,quoteCoinType:namesake.quote_asset_id
    }]});
    await expect(service.getDeepbookUsdcPriceHistory({...range, coinType:original.base_asset_id})).resolves.toMatchObject({status:"ok"});
    await expect(service.getDeepbookUsdcPriceHistory({...range, assetSymbol:"SUI"})).resolves.toMatchObject({
      status:"source_unavailable", reason:"pool_list_incomplete", candidates:[{poolId:original.pool_id},{poolId:namesake.pool_id}]
    });
  });

  it("retains the indexed cutoff when no candle can be observed at the target", async () => {
    const fixture = createDeepbookCandleSourceFixture({candles:[]});
    const fetch = fixture.source.fetchCandles.bind(fixture.source);
    fixture.source.fetchCandles = async query => {
      const result = await fetch(query);
      return {...result,source:{...result.source,coverage:"partial_tail",indexedAt:"2026-06-26T17:02:00.000Z",coveredUntil:"2026-06-26T17:02:00.001Z"}};
    };
    const service = createService({deepbookCandleSource:fixture.source});
    await expect(service.getDeepbookUsdcPriceHistory({poolName:"SUI_USDC",start:"2026-06-26T17:00:00.000Z",end:"2026-06-26T17:05:00.000Z"}))
      .resolves.toMatchObject({status:"ok",barCount:0,candleAvailability:"partial_coverage",source:{candles:{coveredUntil:"2026-06-26T17:02:00.001Z"}}});
    await expect(service.getDeepbookUsdcPriceAtTime({poolName:"SUI_USDC",targetTime:"2026-06-26T17:01:00.000Z"}))
      .resolves.toMatchObject({status:"source_unavailable",reason:"candle_coverage_incomplete"});
  });

  it("proves a nearest-after match within the indexed prefix and reports the union of the two reads", async () => {
    const at = (minute: number) => Date.UTC(2026, 0, 1, 10, minute);
    const iso = (minute: number) => new Date(at(minute)).toISOString();
    const candle = { ...officialCandlesFixture()[0]!, timestampMs: at(5), start: iso(5), end: iso(6) };
    const { source, calls } = createDeepbookCandleSourceFixture({ candles: [candle] });
    const read = source.fetchCandles.bind(source);
    source.fetchCandles = async query => {
      if (query.endTimeMs! > at(7) + 1) throw new Error("Outside the indexed prefix");
      const result = await read(query);
      return { ...result, source: { ...result.source, coveredFrom: new Date(query.startTimeMs!).toISOString(),
        coveredUntil: new Date(query.endTimeMs!).toISOString(), indexedAt: iso(7), indexedCheckpoint: 7 } };
    };
    const result = await createService({ deepbookCandleSource: source }).getDeepbookUsdcPriceAtTime({
      poolName: "SUI_USDC", targetTime: iso(4), interval: "1m", maxDistanceMinutes: 6
    });
    expect(result).toMatchObject({ status: "ok", matchedCandle: candle, match: { kind: "nearest_after", distanceMinutes: 1 },
      requested: { selector: { kind: "pool_name" }, range: { start: iso(-3), end: new Date(at(7) + 1).toISOString() } },
      source: { candles: { startTimeMs: at(-3), endTimeMs: at(7) + 1 } } });
    expect(calls.pools).toBe(1);
  });

  it("returns source-unavailable when official candles cannot be read", async () => {
    const { source } = createDeepbookCandleSourceFixture({ failCandles: true });
    await expect(
      createService({ deepbookCandleSource: source }).getDeepbookUsdcPriceHistory({
        poolName: "SUI_USDC",
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "source_unavailable",
      reason: "candle_fetch_failed",
      pair: { poolName: "SUI_USDC" },
      source: {
        kind: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
        poolList: { url: "https://deepbook-indexer.mainnet.mystenlabs.com/get_pools" }
      }
    });
  });

  it("returns a target-time DeepBook USDC candle with close as the representative price", async () => {
    const result = await createService({
      deepbookCandleSource: createDeepbookCandleSourceFixture().source
    }).getDeepbookUsdcPriceAtTime({
      poolName: "SUI_USDC",
      targetTime: "2026-06-26T16:55:00.000Z"
    });

    expect(result).toMatchObject({
      status: "ok",
      target: {
        targetTime: "2026-06-26T16:55:00.000Z",
        searchWindow: { maxDistanceMinutes: 360 }
      },
      pair: { poolName: "SUI_USDC", priceConvention: "USDC_PER_BASE" },
      match: {
        kind: "exact_bucket",
        distanceMinutes: 0,
        representativePrice: {
          field: "matchedCandle.close",
          value: "0.69316",
          quoteAsset: "USDC",
          baseAssetSymbol: "SUI",
          priceConvention: "USDC_PER_BASE"
        }
      },
      matchedCandle: {
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z",
        close: "0.69316"
      },
      userAnswerUse: {
        canAnswer: [DEEPBOOK_ANSWER_USE.poolUsdcCandleForRequestedTime, DEEPBOOK_ANSWER_USE.representativeClosePriceForMatchedCandle],
        answerFields: expect.arrayContaining(["match.representativePrice", "matchedCandle.close", "responseSummary"]),
        cannotAnswer: [...DEEPBOOK_READ_RESPONSE_UNSUPPORTED.officialUsdcCandles]
      },
      quantitySemantics: {
        allowedUse: DEEPBOOK_ANSWER_USE.poolUsdcCandleHistory,
        usdcIsFiatUsd: false,
        chainRecomputedBySuiMcp: true
      }
    });
  });

  it("uses the nearest official candle when the target bucket has no candle", async () => {
    const result = await createService({
      deepbookCandleSource: createDeepbookCandleSourceFixture().source
    }).getDeepbookUsdcPriceAtTime({
      poolName: "SUI_USDC",
      targetTime: "2026-06-26T17:10:00.000Z"
    });

    expect(result).toMatchObject({
      status: "ok",
      match: {
        kind: "nearest_before",
        distanceMinutes: 5,
        representativePrice: { field: "matchedCandle.close", value: "0.69316" }
      },
      matchedCandle: {
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      }
    });
  });

  it("uses the nearest-after official candle when the target time is before the first candle", async () => {
    const result = await createService({
      deepbookCandleSource: createDeepbookCandleSourceFixture().source
    }).getDeepbookUsdcPriceAtTime({
      poolName: "SUI_USDC",
      targetTime: "2026-06-26T16:45:00.000Z"
    });

    expect(result).toMatchObject({
      status: "ok",
      match: {
        kind: "nearest_after",
        distanceMinutes: 5,
        representativePrice: { field: "matchedCandle.close", value: "0.69316" }
      },
      matchedCandle: {
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      }
    });
  });

  it("uses half-open official candle boundaries for target-time matching", async () => {
    const service = createService({
      deepbookCandleSource: createDeepbookCandleSourceFixture().source
    });

    await expect(
      service.getDeepbookUsdcPriceAtTime({
        poolName: "SUI_USDC",
        targetTime: "2026-06-26T16:50:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "ok",
      match: { kind: "exact_bucket", distanceMinutes: 0 },
      matchedCandle: {
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      }
    });

    await expect(
      service.getDeepbookUsdcPriceAtTime({
        poolName: "SUI_USDC",
        targetTime: "2026-06-26T17:05:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "ok",
      match: { kind: "nearest_before", distanceMinutes: 0 },
      matchedCandle: {
        start: "2026-06-26T16:50:00.000Z",
        end: "2026-06-26T17:05:00.000Z"
      }
    });

    await expect(
      service.getDeepbookUsdcPriceAtTime({
        poolName: "SUI_USDC",
        targetTime: "2026-06-26T17:20:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "ok",
      match: { kind: "exact_bucket", distanceMinutes: 0 },
      matchedCandle: {
        start: "2026-06-26T17:20:00.000Z",
        end: "2026-06-26T17:35:00.000Z"
      }
    });
  });

  it("does not invent a price when no official candle is inside the search window", async () => {
    const result = await createService({
      deepbookCandleSource: createDeepbookCandleSourceFixture().source
    }).getDeepbookUsdcPriceAtTime({
      poolName: "SUI_USDC",
      targetTime: "2026-06-26T17:10:00.000Z",
      maxDistanceMinutes: 1
    });

    expect(result).toMatchObject({
      status: "no_price_in_search_window",
      target: {
        targetTime: "2026-06-26T17:10:00.000Z",
        searchWindow: { maxDistanceMinutes: 1 }
      },
      pair: { poolName: "SUI_USDC" },
      userAnswerUse: {
        canAnswer: [DEEPBOOK_ANSWER_USE.candleAvailabilityForRequestedUtcRange],
        cannotAnswer: expect.arrayContaining(["signing_data_or_readiness"]),
        answerFields: expect.not.arrayContaining(["matchedCandle.close"])
      }
    });
  });

  it("rejects unsupported official candle intervals before reading the official source", async () => {
    const { source, calls } = createDeepbookCandleSourceFixture();
    await expect(
      createService({ deepbookCandleSource: source }).getDeepbookUsdcPriceAtTime({
        poolName: "SUI_USDC",
        interval: "not-an-interval" as never,
        targetTime: "2026-06-26T16:55:00.000Z"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "interval", value: "not-an-interval" }
    });
    expect(calls.pools).toBe(0);
    expect(calls.candles).toEqual([]);
  });

  it("rejects wholly future price requests but keeps a crossing range and a derived point window", async () => {
    const { source, calls } = createDeepbookCandleSourceFixture();
    const service = createService({ deepbookCandleSource: source, now: () => new Date("2026-06-26T17:01:00.000Z") });
    const future = "2026-06-26T17:02:00.000Z";
    await expect(service.getDeepbookUsdcPriceHistory({poolName:"SUI_USDC",start:future,end:"2026-06-26T17:10:00.000Z"}))
      .rejects.toMatchObject({kind:"input_invalid",details:{field:"start"}});
    await expect(service.getDeepbookUsdcPriceAtTime({poolName:"SUI_USDC",targetTime:future}))
      .rejects.toMatchObject({kind:"input_invalid",details:{field:"targetTime"}});
    expect(calls.pools).toBe(0);expect(calls.candles).toHaveLength(0);
    await expect(service.getDeepbookUsdcPriceHistory({poolName:"SUI_USDC",start:"2026-06-26T16:59:00.000Z",end:future}))
      .resolves.toMatchObject({status:"ok"});
    await expect(service.getDeepbookUsdcPriceAtTime({poolName:"SUI_USDC",targetTime:"2026-06-26T17:01:00.000Z"}))
      .resolves.toMatchObject({status:"ok"});
  });

  it("returns unsupported-range before reading the official source", async () => {
    const { source, calls } = createDeepbookCandleSourceFixture();
    const result = await createService({ deepbookCandleSource: source }).getDeepbookUsdcPriceHistory({
      poolName: "SUI_USDC",
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-30T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      status: "unsupported_range",
      reason: "requested_range_exceeds_max_bars",
      requested: { range: { maxBars: 1008 } }
    });
    expect(calls.pools).toBe(0);
    expect(calls.candles).toEqual([]);
  });

  it("fails closed when DeepBook mid price is unavailable", async () => {
    for (const midPrice of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const service = createService({
        deepbook: {
          async midPrice() {
            return midPrice;
          }
        }
      });

      const expectedError = {
        kind: "quote_unavailable",
        details: { poolKey: "SUI_USDC", source: "midPrice" }
      };

      await expect(
        service.getDeepbookMidPrice({
          poolKey: "SUI_USDC",
          simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      ).rejects.toMatchObject(expectedError);
      await expect(
        service.inspectDeepbookOrderbook({
          poolKey: "SUI_USDC",
          ticks: 5,
          simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      ).rejects.toMatchObject(expectedError);
    }
  });

  it.each(["quote first", "policy first"] as const)("dates a public quote at the raw response (%s)", async order => {
    const start = now().getTime();
    let clock = start;
    const quote = Promise.withResolvers<{ baseOutRaw: string; quoteOutRaw: string; deepRequiredRaw: string }>();
    const policy = Promise.withResolvers<{ enabled: boolean; additionalTakerFeeRaw: string }>();
    const service = createService({ now: () => new Date(clock), deepbook: {
      getQuoteQuantityOutRaw: () => quote.promise, gasFeePolicy: () => policy.promise
    } });
    const pending = service.quoteDeepbookDisplayAmount({ poolKey: "SUI_USDC", direction: "base_to_quote", amountDisplay: "1", simulationSender: accountAddress });
    const finishQuote = () => quote.resolve({ baseOutRaw: "0", quoteOutRaw: "500000", deepRequiredRaw: "1000" });
    const finishPolicy = () => policy.resolve({ enabled: false, additionalTakerFeeRaw: "0" });
    if (order === "quote first") finishQuote(); else finishPolicy();
    await new Promise<void>(resolve => setImmediate(resolve));
    clock += 40_000;
    if (order === "quote first") finishPolicy(); else finishQuote();
    expect((await pending).fetchedAt).toBe(new Date(order === "quote first" ? start : clock).toISOString());
  });

  it("quotes DeepBook actions in both directions", async () => {
    const service = createService();

    await expect(
      service.quoteDeepbookAction({
        poolKey: "DEEP_SUI",
        direction: "base_to_quote",
        amountRaw: "10",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).resolves.toMatchObject({
      status: "ok",
      source: { method: "getQuoteQuantityOut", simulation: DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation },
      quote: { quoteOut: "100" },
      rawQuote: {
        kind: "deepbook_quote_raw_u64",
        sourceMoveFunction: "pool::get_quote_quantity_out",
        returnValueSourceMoveFunction: "pool::get_quantity_out",
        directionalOutput: { raw: "100000000000", symbol: "SUI" },
        deepRequired: { raw: "1000000", symbol: "DEEP" }
      },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["indicative_deepbook_pool_quote_for_explicit_source_input"]),
        cannotAnswer: expect.arrayContaining(["payment_coverage", "payment_shortfall"]),
        answerFields: expect.arrayContaining(["quote.quoteOut", "rawQuote.directionalOutput"]),
        followUp: {
          tool: "read_preview_intent_evidence",
          answerFields: ["responseSummary"]
        }
      },
      quantitySemantics: {
        inputAmountKind: "raw_u64",
        rawAmountAvailable: true,
        rawEvidenceField: "rawQuote",
        paymentCoverageAvailable: false,
        shortfallContributionAvailable: false,
        routeDependentPaymentSupportAvailable: false,
        requiresIntentEvidenceForCoverage: true,
        canUseForPaymentAnswer: false,
        canUseForShortfallAnswer: false,
        doNotCombineWithPaymentAnswer: true,
        requiredPaymentAnswerTool: "read_preview_intent_evidence",
        paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
        requiredPaymentAnswerField: "responseSummary"
      }
    });

    await expect(
      service.quoteDeepbookAction({
        poolKey: "DEEP_SUI",
        direction: "quote_to_base",
        amountRaw: "10",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).resolves.toMatchObject({
      status: "ok",
      source: { method: "getBaseQuantityOut", simulation: DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation },
      quote: { baseOut: "50000" },
      rawQuote: {
        sourceMoveFunction: "pool::get_base_quantity_out",
        returnValueSourceMoveFunction: "pool::get_quantity_out",
        directionalOutput: { raw: "50000000000", symbol: "DEEP" }
      }
    });
  });

  it("quotes raw DeepBook actions through SDK transaction-builder simulation return values", async () => {
    let simulatedTransactionSeen = false;
    const service = new SuiReadService({
      network: "mainnet",
      chainIdentifier: "4c78adac",
      coinMetadataCache: new MemoryCoinMetadataCache(),
      now,
      client: {
        core: {
          async listBalances() {
            return { balances: [], hasNextPage: false, cursor: null };
          },
          async getCoinMetadata() {
            return { coinMetadata: null };
          },
          async simulateTransaction(options: { include?: { commandResults?: boolean } }) {
            simulatedTransactionSeen = options.include?.commandResults === true;
            return {
              $kind: "Transaction",
              commandResults: quotePoolCommandResults([0n, 123_456_789n, 25_000n])
            };
          }
        }
      } as unknown as ConstructorParameters<typeof SuiReadService>[0]["client"]
    });

    const result = await service.quoteDeepbookAction({
      poolKey: "SUI_USDC",
      direction: "base_to_quote",
      amountRaw: "1000000000",
      simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(simulatedTransactionSeen).toBe(true);
    expect(result).toMatchObject({
      source: { method: "getQuoteQuantityOut", returnValueEncoding: "bcs.u64" },
      rawQuote: {
        kind: "deepbook_quote_raw_u64",
        sourceMoveFunction: "pool::get_quote_quantity_out",
        returnValueSourceMoveFunction: "pool::get_quantity_out",
        inputAmount: { raw: "1000000000", symbol: "SUI" },
        quoteOut: { raw: "123456789", symbol: "USDC" },
        deepRequired: { raw: "25000", symbol: "DEEP" },
        directionalOutput: { raw: "123456789", symbol: "USDC" }
      },
      quote: { baseOut: "0", quoteOut: "123.456789", deepRequired: "0.025" }
    });
  });

  it.each([
    ["FailedTransaction", [8, 8, 8]], ["Transaction", [8, 8]], ["Transaction", [8, 8, 8, 8]],
    ["Transaction", [8, 9, 8]], ["Transaction", [7, 8, 8]]
  ] as const)("refuses an unsuccessful or malformed quote result %s %j", async (kind, widths) => {
    const service = new SuiReadService({
      network: "mainnet", chainIdentifier: "4c78adac", now, coinMetadataCache: new MemoryCoinMetadataCache(),
      client: { core: { simulateTransaction: async () => ({
        $kind: kind, commandResults: [{ returnValues: widths.map((n) => ({ bcs: new Uint8Array(n) })) }, ...quotePoolCommandResults([]).slice(1)]
      }) } } as unknown as ConstructorParameters<typeof SuiReadService>[0]["client"]
    });
    await expect(service.quoteDeepbookAction({ poolKey: "SUI_USDC", direction: "base_to_quote", amountRaw: "1",
      simulationSender: "0x2" })).rejects.toMatchObject({ kind: "quote_unavailable" });
  });

  it.each([
    ["10", "0", "no_output", "0"], ["3", "8", "input_returned", "7"], ["0", "8", "full_input_spend", "10"]
  ])("reports return %s and output %s consistently for both public input kinds", async (returned, output, quoteOutcome, consumed) => {
    const service = createService({ deepbook: { getQuoteQuantityOutRaw: async () => ({
      baseOutRaw: returned!, quoteOutRaw: output!, deepRequiredRaw: "0"
    }) } });
    const input = { poolKey: "SUI_USDC", direction: "base_to_quote" as const, simulationSender: "0x2" };
    const raw = await service.quoteDeepbookAction({ ...input, amountRaw: "10" });
    const display = await service.quoteDeepbookDisplayAmount({ ...input, amountDisplay: "0.000000010" });
    expect(raw).toMatchObject({ quoteOutcome, inputFlow: { expectedSpendRaw: consumed, expectedReturnRaw: returned } });
    expect(display.inputFlow).toEqual(raw.inputFlow);
    expect(display.quoteOutcome).toBe(quoteOutcome);
    const candidateService = createService({
      listBalances: async () => ({ balances: [{ coinType: mainnetCoins.WUSDT!.type, balance: "10", coinBalance: "10", addressBalance: "0" }],
        hasNextPage: false, cursor: null }),
      deepbook: { getQuoteQuantityOutRaw: async () => ({ baseOutRaw: returned!, quoteOutRaw: output!, deepRequiredRaw: "0" }) }
    });
    const preview = await candidateService.previewIntentEvidence({ account: accountAddress, intentKind: "cover_payment_like_amount",
      denomination: "dollar", requiredDisplayAmount: "1", targetAssetSymbol: "USDC", targetAssetSelectionSource: "user_explicit" });
    expect(preview.candidateConversions).toMatchObject([{ status: "quoted", sourceSymbol: "WUSDT",
      quote: { quoteOutcome, inputFlow: { expectedSpendRaw: consumed, expectedReturnRaw: returned } } }]);
    expect(preview.selectedTarget?.shortfallRawAmount).toBe("1000000");
  });

  it("formats raw DeepBook quote display fields without floating point conversion", async () => {
    const service = createService({
      deepbook: {
        async getQuoteQuantityOutRaw() {
          return { baseOutRaw: "0", quoteOutRaw: "9007199254740993", deepRequiredRaw: "1000000" };
        }
      }
    });

    const result = await service.quoteDeepbookAction({
      poolKey: "SUI_USDC",
      direction: "base_to_quote",
      amountRaw: "1000000000",
      simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result).toMatchObject({
      rawQuote: {
        quoteOut: { raw: "9007199254740993", symbol: "USDC" }
      },
      quote: {
        baseOut: "0",
        quoteOut: "9007199254.740993",
        deepRequired: "1"
      }
    });
  });

  it("fails raw DeepBook quotes closed when raw return values cannot be displayed", async () => {
    const service = createService({
      deepbook: {
        async getQuoteQuantityOutRaw() {
          return { baseOutRaw: "0", quoteOutRaw: "not-a-u64", deepRequiredRaw: "1000000" };
        }
      }
    });

    await expect(
      service.quoteDeepbookAction({
        poolKey: "DEEP_SUI",
        direction: "base_to_quote",
        amountRaw: "10",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      kind: "quote_unavailable",
      details: { raw: "not-a-u64" }
    });
  });

  it("rejects raw DeepBook quote amounts that exceed the SDK u64 input boundary", async () => {
    const service = createService();

    await expect(
      service.quoteDeepbookAction({
        poolKey: "DEEP_SUI",
        direction: "base_to_quote",
        amountRaw: "18446744073709551616",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "amountRaw", maxRawAmount: "18446744073709551615" }
    });
  });

  it("quotes DeepBook display amounts through verified DeepBook scalar units", async () => {
    let seenBaseQuantity: number | bigint | undefined;
    const service = createService({
      deepbook: {
        async getQuoteQuantityOutRaw(_poolKey, baseQuantity) {
          seenBaseQuantity = baseQuantity;
          return { baseOutRaw: "0", quoteOutRaw: "100000000", deepRequiredRaw: "1000000" };
        }
      }
    });

    const result = await service.quoteDeepbookDisplayAmount({
      poolKey: "SUI_USDC",
      direction: "base_to_quote",
      amountDisplay: "10",
      simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(seenBaseQuantity).toBe(10_000_000_000n);
    expect(result).toMatchObject({
      status: "ok",
      pool: { poolKey: "SUI_USDC", base: "SUI", quote: "USDC" },
      direction: "base_to_quote",
      inputAmount: {
        display: "10",
        raw: "10000000000",
        asset: {
          symbol: "SUI",
          decimals: 9,
          unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE
        }
      },
      source: { method: "getQuoteQuantityOut", simulation: DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation },
      quote: { baseOut: "0", quoteOut: "100", deepRequired: "1" },
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["raw_sdk_quote_return_values_before_slippage_policy"]),
        cannotAnswer: expect.arrayContaining(["payment_coverage", "payment_shortfall", "final_min_out"]),
        answerFields: expect.arrayContaining(["inputAmount", "quote.quoteOut"]),
        followUp: {
          tool: "read_preview_intent_evidence",
          answerFields: ["responseSummary"]
        }
      },
      rawQuote: {
        inputAmount: { raw: "10000000000", symbol: "SUI" },
        directionalOutput: { raw: "100000000", symbol: "USDC" },
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
        }
      },
      quantitySemantics: {
        kind: "deepbook_quote_display_amount",
        inputAmountKind: "display_source_amount_converted_to_raw_u64",
        allowedUse: "indicative_deepbook_pool_quote",
        rawAmountAvailable: true,
        rawEvidenceField: "rawQuote",
        paymentCoverageAvailable: false,
        shortfallContributionAvailable: false,
        routeDependentPaymentSupportAvailable: false,
        requiresIntentEvidenceForCoverage: true,
        canUseForPaymentAnswer: false,
        canUseForShortfallAnswer: false,
        doNotCombineWithPaymentAnswer: true,
        requiredPaymentAnswerTool: "read_preview_intent_evidence",
        paymentAnswerUseBlockedReason: "quote_output_is_price_reference_not_payment_answer",
        requiredPaymentAnswerField: "responseSummary",
        fiatUsdCashOutAvailable: false,
        externalMarketPriceConversionAvailable: false,
        externalMarketLookupAvailable: false,
        usdPegAssumptionAvailable: false,
        bankCashOutEstimateAvailable: false,
        profitAndLossAvailable: false,
        costBasisAvailable: false,
        priceImpactAvailable: false,
        midPriceSlippageAvailable: false,
        venueComparisonAvailable: false,
        routeRecommendationAvailable: false,
        notFor: [
          "signing",
          "funding",
          "payment_coverage",
          "shortfall_contribution",
          "route_dependent_payment_support",
          "route_liquidity",
          "min_out",
          "liquidity_verdict",
          "price_impact",
          "mid_price_slippage",
          "quote_vs_mid_slippage",
          "effective_price",
          "venue_comparison",
          "best_route",
          "route_recommendation",
          "transaction_building",
          "fiat_usd_cash_out",
          "external_market_price_conversion",
          "external_market_lookup",
          "usd_peg_assumption",
          "bank_cash_out_estimate",
          "profit_or_pnl",
          "cost_basis"
        ]
      }
    });
    expect(result.quote).not.toHaveProperty("baseQuantity");
    expect(result.quote).not.toHaveProperty("quoteQuantity");
  });

  it("omits SDK quote input echoes from quote-to-base display quote outputs", async () => {
    const result = await createService().quoteDeepbookDisplayAmount({
      poolKey: "SUI_USDC",
      direction: "quote_to_base",
      amountDisplay: "10",
      simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result).toMatchObject({
      direction: "quote_to_base",
      inputAmount: {
        display: "10",
        raw: "10000000",
        asset: { symbol: "USDC", decimals: 6 }
      },
      quote: { baseOut: "50", quoteOut: "0", deepRequired: "1" },
      rawQuote: { directionalOutput: { raw: "50000000000", symbol: "SUI" } }
    });
    expect(result.quote).not.toHaveProperty("baseQuantity");
    expect(result.quote).not.toHaveProperty("quoteQuantity");
  });

  it("rejects invalid DeepBook display quote amounts as amountDisplay errors", async () => {
    const service = createService();

    for (const amountDisplay of [
      "0",
      "0.0",
      "-1",
      "+1",
      " 1",
      "1e3",
      "0x10",
      "NaN",
      "Infinity",
      "1.0000000001",
      "18446744073.709551616"
    ]) {
      await expect(
        service.quoteDeepbookDisplayAmount({
          poolKey: "SUI_USDC",
          direction: "base_to_quote",
          amountDisplay,
          simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      ).rejects.toMatchObject({
        kind: "input_invalid",
        details: { field: "amountDisplay" }
      });
    }
  });

  it("fails DeepBook display quotes closed when pinned scalar metadata is invalid", async () => {
    const service = createService({ deepbookCoins: deepbookCoinsWithInvalidSuiScalar() });

    await expect(
      service.quoteDeepbookDisplayAmount({
        poolKey: "SUI_USDC",
        direction: "base_to_quote",
        amountDisplay: "10",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      kind: "registry_miss",
      details: { symbol: "SUI", scalar: 12 }
    });
  });

  it("fails raw DeepBook quotes closed when display units cannot be verified", async () => {
    const service = createService({ deepbookCoins: deepbookCoinsWithInvalidSuiScalar() });

    await expect(
      service.quoteDeepbookAction({
        poolKey: "SUI_USDC",
        direction: "base_to_quote",
        amountRaw: "1000000000",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      kind: "registry_miss",
      details: { symbol: "SUI", scalar: 12 }
    });
  });

  it("fails DeepBook display quotes closed when raw quote evidence cannot be displayed", async () => {
    const service = createService({
      deepbook: {
        async getQuoteQuantityOutRaw() {
          return { baseOutRaw: "not-a-u64", quoteOutRaw: "100000000", deepRequiredRaw: "1000000" };
        }
      }
    });

    await expect(
      service.quoteDeepbookDisplayAmount({
        poolKey: "SUI_USDC",
        direction: "base_to_quote",
        amountDisplay: "10",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      kind: "quote_unavailable",
      details: { raw: "not-a-u64" }
    });
  });

  it("summarizes DeepBook account inventory discovery without detail inputs", async () => {
    const result = await createService().summarizeDeepbookAccountInventory({ account: accountAddress });

    expect(result).toMatchObject({
      status: "ok",
      account: accountAddress,
      fetchedAt: "2026-05-11T00:00:00.000Z",
      source: {
        simulation: DEEPBOOK_SDK_SIMULATION_SOURCE_BASE.simulation,
        methods: ["getBalanceManagerIds"]
      },
      requested: {},
      detailStatus: "manager_discovery_only",
      managerAddresses: [managerAddress],
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["active_account_deepbook_balance_manager_discovery"]),
        cannotAnswer: expect.arrayContaining([
          "deepbook_pool_account_inventory_when_detailStatus_is_not_available",
          "current_wallet_coin_balance",
          "funding_source"
        ]),
        preconditionFields: ["detailStatus"],
        answerFields: expect.arrayContaining(["managerAddresses", "detailStatus"]),
        followUp: {
          tool: "read_summarize_wallet_assets",
          answerFields: ["balances"]
        }
      },
      quantitySemantics: {
        kind: "deepbook_display_number",
        rawAmountAvailable: false,
        notFor: ["signing", "funding", "route_liquidity", "withdrawal_readiness", "transaction_building"]
      }
    });
    expect(result.userAnswerUse.canAnswer).not.toContain(
      "deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"
    );
    expect(result.userAnswerUse.answerFields).not.toEqual(
      expect.arrayContaining(["accountSummary", "lockedBalances", "openOrderIds", "openOrderCount"])
    );
    expect(result.userAnswerUse.diagnosticOnlyFields ?? []).not.toContain("openOrderIdsTruncated");
  });

  it("keeps DeepBook account inventory guidance scoped to each detail status", async () => {
    const service = createService();

    const missingPool = await service.summarizeDeepbookAccountInventory({
      account: accountAddress,
      managerAddress
    });
    expect(missingPool).toMatchObject({
      detailStatus: "pool_key_required",
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["why_deepbook_pool_account_inventory_detail_is_unavailable"]),
        cannotAnswer: expect.arrayContaining(["deepbook_pool_account_inventory_when_detailStatus_is_not_available"]),
        preconditionFields: ["detailStatus"]
      }
    });
    expect(missingPool.userAnswerUse.canAnswer).not.toContain(
      "deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"
    );

    const missingManager = await service.summarizeDeepbookAccountInventory({
      account: accountAddress,
      poolKey: "SUI_USDC"
    });
    expect(missingManager).toMatchObject({
      detailStatus: "manager_address_required",
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["why_deepbook_pool_account_inventory_detail_is_unavailable"]),
        cannotAnswer: expect.arrayContaining(["deepbook_pool_account_inventory_when_detailStatus_is_not_available"]),
        preconditionFields: ["detailStatus"]
      }
    });
    expect(missingManager.userAnswerUse.canAnswer).not.toContain(
      "deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"
    );

    const undiscoveredManager = await service.summarizeDeepbookAccountInventory({
      account: accountAddress,
      poolKey: "SUI_USDC",
      managerAddress: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    });
    expect(undiscoveredManager).toMatchObject({
      detailStatus: "manager_address_not_discovered_for_active_account",
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["why_deepbook_pool_account_inventory_detail_is_unavailable"]),
        cannotAnswer: expect.arrayContaining(["deepbook_pool_account_inventory_when_detailStatus_is_not_available"]),
        preconditionFields: ["detailStatus"]
      }
    });
    expect(undiscoveredManager.userAnswerUse.canAnswer).not.toContain(
      "deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"
    );

    const accountNotFoundService = createService({
      deepbook: {
        async accountExists() {
          return false;
        },
        async account() {
          throw new Error("account should not be called for account_not_found guidance");
        },
        async lockedBalance() {
          throw new Error("lockedBalance should not be called for account_not_found guidance");
        },
        async accountOpenOrders() {
          throw new Error("accountOpenOrders should not be called for account_not_found guidance");
        }
      }
    });
    const accountNotFound = await accountNotFoundService.summarizeDeepbookAccountInventory({
      account: accountAddress,
      poolKey: "SUI_USDC",
      managerAddress
    });
    expect(accountNotFound).toMatchObject({
      detailStatus: "account_not_found",
      accountExists: false,
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["deepbook_pool_account_absence_when_pool_and_manager_are_supplied"]),
        cannotAnswer: expect.arrayContaining([
          "deepbook_pool_account_inventory_when_detailStatus_is_not_available",
          "current_wallet_coin_balance",
          "funding_source"
        ]),
        preconditionFields: ["detailStatus"]
      }
    });
    expect(accountNotFound.userAnswerUse.canAnswer).not.toContain(
      "deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"
    );

    const availableService = createService({
      deepbook: {
        async getBalanceManagerIds() {
          return [managerAddress];
        },
        async accountExists() {
          return true;
        },
        async account() {
          return {
            epoch: "42",
            open_orders: { contents: [] },
            taker_volume: 0,
            maker_volume: 0,
            active_stake: 0,
            inactive_stake: 0,
            created_proposal: false,
            voted_proposal: "",
            unclaimed_rebates: { base: 1, quote: 2, deep: 3 },
            settled_balances: { base: 4, quote: 5, deep: 6 },
            owed_balances: { base: 7, quote: 8, deep: 9 }
          };
        },
        async lockedBalance() {
          return { base: 10, quote: 11, deep: 12 };
        },
        async accountOpenOrders() {
          return ["100"];
        }
      }
    });
    const available = await availableService.summarizeDeepbookAccountInventory({
      account: accountAddress,
      poolKey: "SUI_USDC",
      managerAddress
    });
    expect(available).toMatchObject({
      detailStatus: "available",
      userAnswerUse: {
        canAnswer: expect.arrayContaining(["deepbook_pool_account_inventory_when_pool_and_manager_are_supplied"]),
        preconditionFields: ["detailStatus"],
        answerFields: expect.arrayContaining([
          "managerAddresses",
          "detailStatus",
          "accountSummary",
          "lockedBalances",
          "openOrderIds",
          "openOrderCount"
        ]),
        diagnosticOnlyFields: expect.arrayContaining(["openOrderIdsTruncated"])
      }
    });
    expect(available.userAnswerUse.cannotAnswer).not.toContain(
      "deepbook_pool_account_inventory_when_detailStatus_is_not_available"
    );
  });

  it("reports empty DeepBook manager discovery without treating it as an error", async () => {
    const service = createService({
      deepbook: {
        async getBalanceManagerIds() {
          return [];
        }
      }
    });

    await expect(service.summarizeDeepbookAccountInventory({ account: accountAddress })).resolves.toMatchObject({
      detailStatus: "manager_discovery_only",
      managerAddresses: []
    });
    await expect(
      service.summarizeDeepbookAccountInventory({
        account: accountAddress,
        poolKey: "SUI_USDC",
        managerAddress
      })
    ).resolves.toMatchObject({
      detailStatus: "manager_address_not_discovered_for_active_account",
      managerAddresses: []
    });
  });

  it("requires both pool and discovered manager address for DeepBook account detail reads", async () => {
    const service = createService();

    await expect(
      service.summarizeDeepbookAccountInventory({
        account: accountAddress,
        managerAddress
      })
    ).resolves.toMatchObject({
      detailStatus: "pool_key_required",
      requested: { managerAddress }
    });
    await expect(
      service.summarizeDeepbookAccountInventory({
        account: accountAddress,
        poolKey: "SUI_USDC"
      })
    ).resolves.toMatchObject({
      detailStatus: "manager_address_required",
      pool: { poolKey: "SUI_USDC", base: "SUI", quote: "USDC" }
    });
    await expect(
      service.summarizeDeepbookAccountInventory({
        account: accountAddress,
        poolKey: "SUI_USDC",
        managerAddress: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      })
    ).resolves.toMatchObject({
      detailStatus: "manager_address_not_discovered_for_active_account"
    });
    await expect(
      service.summarizeDeepbookAccountInventory({
        account: accountAddress,
        managerAddress: "not-an-address"
      })
    ).rejects.toMatchObject({
      kind: "input_invalid",
      details: { field: "managerAddress" }
    });
  });

  it("rejects unsupported DeepBook inventory detail pools before account discovery", async () => {
    const calls: string[] = [];
    const service = createService({
      deepbook: {
        async getBalanceManagerIds() {
          calls.push("getBalanceManagerIds");
          return [managerAddress];
        }
      }
    });

    await expect(
      service.summarizeDeepbookAccountInventory({
        account: accountAddress,
        poolKey: "UNKNOWN_POOL",
        managerAddress
      })
    ).rejects.toMatchObject({ kind: "registry_miss" });
    expect(calls).toEqual([]);
  });

  it("uses an ephemeral manager-address registry for DeepBook account detail reads", async () => {
    const factoryCalls: Array<{
      simulationSender: string;
      balanceManagers: Record<string, { address: string }> | undefined;
    }> = [];
    const detailOpenOrderIds = Array.from({ length: 101 }, (_, index) => String(1_000 + index));
    const deepbook: DeepBookReadClient = {
      async midPrice() {
        return 1;
      },
      async poolBookParams() {
        return { tickSize: 1, lotSize: 1, minSize: 1 };
      },
      async getLevel2TicksFromMid() {
        return {
          bid_prices: [1],
          bid_quantities: [2],
          ask_prices: [3],
          ask_quantities: [4]
        };
      },
      async getQuoteQuantityOutRaw() {
        return { baseOutRaw: "0", quoteOutRaw: "1000000", deepRequiredRaw: "0" };
      },
      async getBaseQuantityOutRaw() {
        return { baseOutRaw: "1000000000", quoteOutRaw: "0", deepRequiredRaw: "0" };
      },
      async getBalanceManagerIds() {
        return [managerAddress];
      },
      async accountExists() {
        return true;
      },
      async account() {
        return {
          epoch: "42",
          open_orders: { contents: ["ignored-account-open-order-source"] },
          taker_volume: 99,
          maker_volume: 88,
          active_stake: 77,
          inactive_stake: 66,
          created_proposal: true,
          voted_proposal: "proposal",
          unclaimed_rebates: { base: 1.1, quote: 2.2, deep: 3.3 },
          settled_balances: { base: 4.4, quote: 5.5, deep: 6.6 },
          owed_balances: { base: 7.7, quote: 8.8, deep: 9.9 }
        };
      },
      async lockedBalance() {
        return { base: 10.1, quote: 11.2, deep: 12.3 };
      },
      async accountOpenOrders() {
        return detailOpenOrderIds;
      }
    };
    const registryService = new SuiReadService({
      network: "mainnet",
      chainIdentifier: "4c78adac",
      coinMetadataCache: new MemoryCoinMetadataCache(),
      now,
      deepbookFactory: (simulationSender, options) => {
        factoryCalls.push({ simulationSender, balanceManagers: options?.balanceManagers });
        return deepbook;
      },
      client: {
        core: {
          async listBalances() {
            return { balances: [], hasNextPage: false, cursor: null };
          },
          async getCoinMetadata() {
            return { coinMetadata: null };
          }
        }
      }
    });

    const result = await registryService.summarizeDeepbookAccountInventory({
      account: accountAddress,
      poolKey: "SUI_USDC",
      managerAddress: `0x${"b".repeat(64)}`
    });

    expect(factoryCalls).toEqual([
      { simulationSender: accountAddress, balanceManagers: undefined },
      {
        simulationSender: accountAddress,
        balanceManagers: {
          [managerAddress]: { address: managerAddress }
        }
      }
    ]);
    expect(result).toMatchObject({
      detailStatus: "available",
      source: {
        methods: ["getBalanceManagerIds", "accountExists", "account", "lockedBalance", "accountOpenOrders"]
      },
      accountExists: true,
      accountSummary: {
        epoch: "42",
        settledBalances: { base: 4.4, quote: 5.5, deep: 6.6 },
        owedBalances: { base: 7.7, quote: 8.8, deep: 9.9 },
        unclaimedRebates: { base: 1.1, quote: 2.2, deep: 3.3 }
      },
      lockedBalances: { base: 10.1, quote: 11.2, deep: 12.3 },
      openOrderCount: 101,
      openOrderIdsTruncated: true
    });
    expect(result.accountSummary).not.toHaveProperty("open_orders");
    expect(result.accountSummary).not.toHaveProperty("taker_volume");
    expect(result.openOrderIds).toHaveLength(100);
    expect(result.openOrderIds?.[0]).toBe("1000");
    expect(result.openOrderIds?.[99]).toBe("1099");
  });

  it("reports missing DeepBook pool accounts without reading account detail", async () => {
    const calls: string[] = [];
    const service = createService({
      deepbook: {
        async getBalanceManagerIds() {
          calls.push("getBalanceManagerIds");
          return [managerAddress];
        },
        async accountExists() {
          calls.push("accountExists");
          return false;
        },
        async account() {
          calls.push("account");
          throw new Error("account should not be called");
        },
        async lockedBalance() {
          calls.push("lockedBalance");
          throw new Error("lockedBalance should not be called");
        },
        async accountOpenOrders() {
          calls.push("accountOpenOrders");
          throw new Error("accountOpenOrders should not be called");
        }
      }
    });

    const result = await service.summarizeDeepbookAccountInventory({
      account: accountAddress,
      poolKey: "SUI_USDC",
      managerAddress
    });

    expect(calls).toEqual(["getBalanceManagerIds", "accountExists"]);
    expect(result).toMatchObject({
      detailStatus: "account_not_found",
      accountExists: false,
      source: { methods: ["getBalanceManagerIds", "accountExists"] }
    });
    expect(result).not.toHaveProperty("accountSummary");
    expect(result).not.toHaveProperty("openOrderIds");
  });

  it("fails closed for unknown pools and non-raw amounts", async () => {
    const service = createService();

    await expect(
      service.inspectDeepbookOrderbook({ poolKey: "UNKNOWN_POOL", ticks: 5, simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    ).rejects.toMatchObject({ kind: "registry_miss" });
    await expect(
      service.getDeepbookMidPrice({ poolKey: "UNKNOWN_POOL", simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    ).rejects.toMatchObject({ kind: "registry_miss" });
    await expect(
      service.inspectDeepbookOrderbook({ poolKey: "DEEP_SUI", ticks: 51, simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    ).rejects.toMatchObject({ kind: "input_invalid", details: { field: "ticks", max: 50 } });
    await expect(
      service.quoteDeepbookAction({
        poolKey: "DEEP_SUI",
        direction: "base_to_quote",
        amountRaw: "1.5",
        simulationSender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({ kind: "input_invalid" });
  });
});
