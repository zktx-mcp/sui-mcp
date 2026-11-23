import {
  type Coin,
  mainnetCoins,
  mainnetPools,
  type Pool
} from "@mysten/deepbook-v3";
import {
  DEEPBOOK_SCALAR_UNIT_SOURCE,
  decimalsFromScalar,
  normalizeCoinType
} from "./coinMetadata.js";
import {
  ReadServiceInputError,
  type DeepBookCoinRegistry,
  type QuoteDirection,
  type DeepbookTokenRegistryEntry
} from "./readServiceTypes.js";

export const PINNED_DEEPBOOK_COINS: DeepBookCoinRegistry = Object.freeze(Object.fromEntries(
  Object.entries(mainnetCoins).map(([symbol, coin]) => [symbol, Object.freeze({ ...coin })])
));

// Curated DeepBook USDC chart pairs: the meaningful Sui-ecosystem base tokens worth
// featuring against USDC, in display order. This is a deliberate editorial allowlist
// — NOT a dynamic volume cut — so the chart shows a stable, hand-picked set and never
// surfaces the dead/dust pools the indexer also lists (stable-vs-stable, wrapped
// duplicates, single-trade listings). Each entry is a token judged worth registering
// on its own merits:
//   SUI  — Sui L1 gas / native token
//   DEEP — DeepBook protocol token (this venue's own token)
//   WAL  — Walrus decentralized storage (Mysten)
//   NS   — SuiNS name service
//   IKA  — Ika MPC / dWallet network
//   XBTC — Bitcoin on Sui
//   USDT — Tether USD stablecoin
// Edit this list to change which pairs the chart offers; order here is display order.
const CURATED_USDC_CHART_BASE_ORDER: ReadonlyMap<string, number> = new Map(
  ["SUI", "DEEP", "WAL", "NS", "IKA", "XBTC", "USDT"].map((symbol, index) => [symbol, index])
);

export const curatedChartCoinTypes = [...CURATED_USDC_CHART_BASE_ORDER.keys()].map(symbol => normalizeCoinType(PINNED_DEEPBOOK_COINS[symbol]!.type));

// A display symbol is not an asset identity. Select the exact registered
// mainnet coin types and keep the established display order.
export function curateUsdcChartPools<T extends { baseAsset: { coinType: string } }>(pools: readonly T[]): T[] {
  const ranks = new Map(curatedChartCoinTypes.map((type, index) => [type, index]));
  return pools.filter(pool => ranks.has(normalizeCoinType(pool.baseAsset.coinType)))
    .sort((a,b) => ranks.get(normalizeCoinType(a.baseAsset.coinType))! - ranks.get(normalizeCoinType(b.baseAsset.coinType))!);
}

type DeepbookCoinEntry = { symbol: string; coin: Coin };
let pinnedIndex: Map<string, DeepbookCoinEntry> | undefined;

export function listDeepbookTokenRegistry(
  coins: DeepBookCoinRegistry = PINNED_DEEPBOOK_COINS
): DeepbookTokenRegistryEntry[] {
  assertDeepbookScalars(coins);
  const poolKeysBySymbol = new Map<string, string[]>();

  for (const [poolKey, pool] of Object.entries(mainnetPools as Record<string, Pool>)) {
    for (const symbol of [pool.baseCoin, pool.quoteCoin]) {
      const current = poolKeysBySymbol.get(symbol) ?? [];
      current.push(poolKey);
      poolKeysBySymbol.set(symbol, current);
    }
  }

  return Object.entries(coins)
    .map(([symbol, coin]) => toDeepbookTokenRegistryEntry(symbol, coin, (poolKeysBySymbol.get(symbol) ?? []).sort()))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export function deepbookUnitForCoinType(
  coinType: string,
  coins: DeepBookCoinRegistry
): { decimals: number; symbol: string; name: string } | undefined {
  const entry = findDeepbookCoinEntry(coinType, coins);
  if (!entry) {
    return undefined;
  }
  const decimals = decimalsFromScalar(entry.coin.scalar);
  if (decimals === undefined) {
    throw invalidDeepbookScalar(entry.symbol, entry.coin.scalar);
  }
  return { decimals, symbol: entry.symbol, name: entry.symbol };
}

export function findDeepbookCoinEntry(
  normalizedCoinType: string,
  coins: DeepBookCoinRegistry
): DeepbookCoinEntry | undefined {
  // Validate the whole pinned token unit registry before using any DeepBook
  // coin match so one bad scalar cannot make the registry look partially trustworthy.
  assertDeepbookScalars(coins);
  if (coins === PINNED_DEEPBOOK_COINS) return pinnedIndex!.get(normalizedCoinType);
  for (const [symbol, coin] of Object.entries(coins)) {
    if (normalizeCoinType(coin.type) === normalizedCoinType) {
      return { symbol, coin };
    }
  }
  return undefined;
}

export function canonicalDeepbookSymbol(
  symbol: string,
  coins: DeepBookCoinRegistry = PINNED_DEEPBOOK_COINS
): string | undefined {
  const trimmed = symbol.trim();
  if (!trimmed) {
    return undefined;
  }
  const matches = Object.keys(coins).filter((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

export function getKnownPool(poolKey: string): Pool {
  const pool = (mainnetPools as Record<string, Pool>)[poolKey];
  if (!pool) {
    throw new ReadServiceInputError("registry_miss", "Unknown DeepBook mainnet pool key", { poolKey });
  }
  return pool;
}

export function deepbookQuoteAssets(poolKey: string, coins: DeepBookCoinRegistry = PINNED_DEEPBOOK_COINS) {
  const pool = getKnownPool(poolKey);
  assertDeepbookScalars(coins);
  const asset = (symbol: string) => {
    const coin = coins[symbol];
    if (!coin) throw new ReadServiceInputError("registry_miss", "Missing DeepBook quote asset", { poolKey, symbol });
    return { symbol, coinType: normalizeCoinType(coin.type), decimals: decimalsFromScalar(coin.scalar)!,
      unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE };
  };
  return { base: asset(pool.baseCoin), quote: asset(pool.quoteCoin), deep: asset("DEEP") };
}

export type DeepbookSymbolPairResolution = {
  poolKey: string;
  pool: Pool;
  direction: QuoteDirection;
  sourceSymbol: string;
  targetSymbol: string;
};

export function resolveDeepbookPoolForSymbols(input: {
  sourceSymbol: string;
  targetSymbol: string;
}): DeepbookSymbolPairResolution {
  const matches: DeepbookSymbolPairResolution[] = [];
  for (const [poolKey, pool] of Object.entries(mainnetPools as Record<string, Pool>)) {
    if (pool.baseCoin === input.sourceSymbol && pool.quoteCoin === input.targetSymbol) {
      matches.push({
        poolKey,
        pool,
        direction: "base_to_quote",
        sourceSymbol: input.sourceSymbol,
        targetSymbol: input.targetSymbol
      });
    }
    if (pool.quoteCoin === input.sourceSymbol && pool.baseCoin === input.targetSymbol) {
      matches.push({
        poolKey,
        pool,
        direction: "quote_to_base",
        sourceSymbol: input.sourceSymbol,
        targetSymbol: input.targetSymbol
      });
    }
  }

  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new ReadServiceInputError("registry_miss", "DeepBook symbol pair resolves to multiple mainnet pools", {
      sourceSymbol: input.sourceSymbol,
      targetSymbol: input.targetSymbol,
      poolKeys: matches.map((match) => match.poolKey)
    });
  }
  throw new ReadServiceInputError("registry_miss", "DeepBook symbol pair is not a known direct mainnet pool", {
    sourceSymbol: input.sourceSymbol,
    targetSymbol: input.targetSymbol
  });
}

export function invalidDeepbookScalar(symbol: string, scalar: number): ReadServiceInputError {
  return new ReadServiceInputError("registry_miss", "DeepBook token scalar is not a power of ten", {
    symbol,
    scalar
  });
}

function toDeepbookTokenRegistryEntry(symbol: string, coin: Coin, poolKeys: string[]): DeepbookTokenRegistryEntry {
  const decimals = decimalsFromScalar(coin.scalar);
  if (decimals === undefined) {
    throw invalidDeepbookScalar(symbol, coin.scalar);
  }
  return {
    symbol,
    address: coin.address,
    type: coin.type,
    scalar: coin.scalar,
    decimals,
    unitSource: DEEPBOOK_SCALAR_UNIT_SOURCE,
    ...(coin.feed === undefined ? {} : { feed: coin.feed }),
    ...(coin.currencyId === undefined ? {} : { currencyId: coin.currencyId }),
    ...(coin.priceInfoObjectId === undefined ? {} : { priceInfoObjectId: coin.priceInfoObjectId }),
    poolKeys
  };
}

function assertDeepbookScalars(coins: DeepBookCoinRegistry): void {
  if (coins === PINNED_DEEPBOOK_COINS && pinnedIndex) return;
  const index = coins === PINNED_DEEPBOOK_COINS ? new Map<string, DeepbookCoinEntry>() : undefined;
  for (const [symbol, coin] of Object.entries(coins)) {
    if (decimalsFromScalar(coin.scalar) === undefined) {
      throw invalidDeepbookScalar(symbol, coin.scalar);
    }
    index?.set(normalizeCoinType(coin.type), { symbol, coin });
  }
  if (index) pinnedIndex = index;
}
