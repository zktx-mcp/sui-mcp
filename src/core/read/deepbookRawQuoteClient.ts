import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  DeepBookClient,
  OrderDeepPrice,
  mainnetPools,
  mainnetCoins,
  mainnetPackageIds,
  type AccountInfo,
  type BalanceManager,
  type LockedBalances
} from "@mysten/deepbook-v3";
import {
  ReadServiceInputError,
  type DeepBookReadClient,
  type DeepbookRawQuoteReturnValues
} from "./readServiceTypes.js";

export function createDeepBookReadClient(input: {
  client: SuiGrpcClient;
  simulationSender: string;
  network: SuiClientTypes.Network;
  balanceManagers?: Record<string, BalanceManager> | undefined;
}): DeepBookReadClient {
  const sdkClient = new DeepBookClient({
    client: input.client,
    address: input.simulationSender,
    network: input.network,
    ...(input.balanceManagers === undefined ? {} : { balanceManagers: input.balanceManagers })
  });

  return {
    gasFeePolicy: (poolKey) => readDeepbookGasFeePolicy(input.client, poolKey),
    midPrice: (poolKey) => sdkClient.midPrice(poolKey),
    poolBookParams: (poolKey) => sdkClient.poolBookParams(poolKey),
    getLevel2TicksFromMid: (poolKey, ticks) => sdkClient.getLevel2TicksFromMid(poolKey, ticks),
    getQuoteQuantityOutRaw: (poolKey, baseQuantity) =>
      simulateDeepbookRawQuote({
        client: input.client,
        simulationSender: input.simulationSender,
        poolKey,
        sdkClient,
        side: "sell", payWithDeep: true,
        command: () => sdkClient.deepBook.getQuoteQuantityOut(poolKey, baseQuantity)
      }),
    getBaseQuantityOutRaw: (poolKey, quoteQuantity) =>
      simulateDeepbookRawQuote({
        client: input.client,
        simulationSender: input.simulationSender,
        poolKey,
        sdkClient,
        side: "buy", payWithDeep: true,
        command: () => sdkClient.deepBook.getBaseQuantityOut(poolKey, quoteQuantity)
      }),
    getQuoteQuantityOutInputFeeRaw: (poolKey, baseQuantity) =>
      simulateDeepbookRawQuote({
        client: input.client,
        simulationSender: input.simulationSender,
        poolKey,
        sdkClient,
        side: "sell", payWithDeep: false,
        command: () => sdkClient.deepBook.getQuoteQuantityOutInputFee(poolKey, baseQuantity)
      }),
    getBaseQuantityOutInputFeeRaw: (poolKey, quoteQuantity) =>
      simulateDeepbookRawQuote({
        client: input.client,
        simulationSender: input.simulationSender,
        poolKey,
        sdkClient,
        side: "buy", payWithDeep: false,
        command: () => sdkClient.deepBook.getBaseQuantityOutInputFee(poolKey, quoteQuantity)
      }),
    getBalanceManagerIds: (owner) => sdkClient.getBalanceManagerIds(owner),
    accountExists: (poolKey, managerKey) => sdkClient.accountExists(poolKey, managerKey),
    account: (poolKey, managerKey): Promise<AccountInfo> => sdkClient.account(poolKey, managerKey),
    lockedBalance: (poolKey, balanceManagerKey): Promise<LockedBalances> =>
      sdkClient.lockedBalance(poolKey, balanceManagerKey),
    accountOpenOrders: (poolKey, managerKey) => sdkClient.accountOpenOrders(poolKey, managerKey)
  };
}

async function simulateDeepbookRawQuote(input: {
  client: SuiGrpcClient;
  simulationSender: string;
  poolKey: string;
  sdkClient: DeepBookClient;
  side: "buy" | "sell";
  payWithDeep: boolean;
  command: () => (tx: Transaction) => void;
  minimumCandidates?: readonly bigint[];
}): Promise<DeepbookRawQuoteReturnValues> {
  const tx = new Transaction();
  tx.setSender(input.simulationSender);
  const pool = mainnetPools[input.poolKey as keyof typeof mainnetPools];
  if (!pool) throw new ReadServiceInputError("registry_miss", "Unknown quote pool", { poolKey: input.poolKey });
  tx.add(input.command());
  const typeArguments = [mainnetCoins[pool.baseCoin]!.type, mainnetCoins[pool.quoteCoin]!.type];
  const poolObject = tx.object(pool.address);
  const target = (fn: string) => `${mainnetPackageIds.DEEPBOOK_PACKAGE_ID}::pool::${fn}` as const;
  const bookParams = tx.moveCall({ target: target("pool_book_params"), typeArguments, arguments: [poolObject] });
  tx.add(input.sdkClient.deepBook.poolTradeParams(input.poolKey));
  tx.add(input.sdkClient.deepBook.getPoolDeepPrice(input.poolKey));
  tx.moveCall({ target: target("whitelisted"), typeArguments, arguments: [poolObject] });
  tx.moveCall({ target: target(input.side === "buy" ? "best_ask_price" : "best_bid_price"),
    typeArguments, arguments: [poolObject, tx.object.clock()] });
  if (input.side === "buy") {
    tx.moveCall({ target: target("get_quote_quantity_in"), typeArguments,
      arguments: [poolObject, bookParams[2]!, tx.pure.bool(input.payWithDeep), tx.object.clock()] });
  }
  const candidates = input.minimumCandidates ?? [];
  for (const quantity of candidates) {
    tx.moveCall({ target: target(input.payWithDeep ? "get_base_quantity_out" : "get_base_quantity_out_input_fee"),
      typeArguments, arguments: [poolObject, tx.pure.u64(quantity), tx.object.clock()] });
  }
  const result = await input.client.core.simulateTransaction({
    transaction: tx, include: { commandResults: true, effects: true }
  });
  const unavailable = () => new ReadServiceInputError("quote_unavailable", "Incomplete DeepBook quote or pool parameters", { poolKey: input.poolKey });
  if (result.$kind !== "Transaction" || result.commandResults?.length !== (input.side === "buy" ? 7 : 6) + candidates.length) throw unavailable();
  const [quote, book, trade, price, whitelist, oppositePrice, minimumBuy] = result.commandResults.map((item) => item.returnValues);
  if (quote?.length !== 3 || book?.length !== 3 || trade?.length !== 3 || price?.length !== 1 || whitelist?.length !== 1) throw unavailable();
  const priceBytes = price[0]?.bcs, whitelistBytes = whitelist[0]?.bcs;
  if (priceBytes?.length !== 9 || priceBytes[0]! > 1 || whitelistBytes?.length !== 1 || whitelistBytes[0]! > 1) throw unavailable();
  const top = oppositePrice?.[0]?.bcs;
  if (oppositePrice?.length !== 1 || !top || !((top.length === 1 && top[0] === 0) || (top.length === 9 && top[0] === 1))) throw unavailable();
  const bestPrice = top[0] ? bcs.U64.parse(top.slice(1)).toString() : null;
  const deepPrice = OrderDeepPrice.parse(priceBytes);
  const [baseOutRaw, quoteOutRaw, deepRequiredRaw] = quote.map((value) => parseU64ReturnValue(value, "swap quote", input.poolKey));
  const [, lotSizeRaw, minBaseRaw] = book.map((value) => parseU64ReturnValue(value, "book parameters", input.poolKey));
  const [takerFeeRaw] = trade.map((value) => parseU64ReturnValue(value, "trade parameters", input.poolKey));
  if (lotSizeRaw === "0" || minBaseRaw === "0") throw unavailable();
  let minimumBuyQuoteRaw: string | null | undefined;
  if (input.side === "buy") {
    if (minimumBuy?.length !== 3) throw unavailable();
    const [base, cost] = minimumBuy.map(value => parseU64ReturnValue(value, "minimum buy quote", input.poolKey));
    if (base !== "0" && BigInt(base!) < BigInt(minBaseRaw!)) throw unavailable();
    if (base === "0") {
      minimumBuyQuoteRaw = null;
    } else if (baseOutRaw === "0" && cost !== undefined) {
      // Inverse multiplication floors the cost. Only publish a minimum when
      // adjacent forward quotes in the same final observation straddle the lot.
      if (!input.minimumCandidates) {
        const seed = BigInt(cost);
        const candidates = [-1n, 0n, 1n, 2n].map(offset => seed + offset)
          .filter(value => value > 0n && value <= 0xffff_ffff_ffff_ffffn);
        return simulateDeepbookRawQuote({ ...input, minimumCandidates: candidates });
      }
      let previousOutput = 0n, previousInput = 0n;
      for (const [index, quantity] of candidates.entries()) {
        const values = result.commandResults[7 + index]?.returnValues;
        if (values?.length !== 3) throw unavailable();
        const [out, returned] = values.map(value => BigInt(parseU64ReturnValue(value, "forward minimum quote", input.poolKey)));
        if (returned! > quantity) throw unavailable();
        if (previousInput + 1n === quantity && previousOutput < BigInt(minBaseRaw!) && out! >= BigInt(minBaseRaw!)) {
          minimumBuyQuoteRaw = quantity.toString();
          break;
        }
        previousInput = quantity;
        previousOutput = out!;
      }
    }
  }
  return { baseOutRaw: baseOutRaw!, quoteOutRaw: quoteOutRaw!, deepRequiredRaw: deepRequiredRaw!,
    poolTerms: { bestOppositePriceRaw: bestPrice, ...(minimumBuyQuoteRaw !== undefined ? { minimumBuyQuoteRaw } : {}), lotSizeRaw: lotSizeRaw!, minBaseRaw: minBaseRaw!, takerFeeRaw: takerFeeRaw!,
      assetIsBase: deepPrice.asset_is_base, deepPerAssetRaw: deepPrice.deep_per_asset, whitelisted: Boolean(whitelistBytes[0]) } };
}

function parseU64ReturnValue(value: unknown, field: string, poolKey: string): string {
  const bcsValue = typeof value === "object" && value !== null && "bcs" in value ? value.bcs : undefined;
  if (!(bcsValue instanceof Uint8Array) || bcsValue.byteLength !== 8) {
    throw new ReadServiceInputError("quote_unavailable", "DeepBook raw quote return value is unavailable", {
      poolKey,
      field
    });
  }

  try {
    return bcs.U64.parse(bcsValue).toString();
  } catch (error) {
    throw new ReadServiceInputError("quote_unavailable", "DeepBook raw quote return value is not a u64", {
      poolKey,
      field,
      reason: error instanceof Error ? error.message : "unknown"
    });
  }
}

// The versioned pool owns this dynamic field; the pinned SDK does not export its MoveStruct.
const ewmaState = bcs.struct("EWMAState", {
  mean: bcs.U64, variance: bcs.U64, alpha: bcs.U64, zScoreThreshold: bcs.U64,
  additionalTakerFee: bcs.U64, lastUpdatedTimestamp: bcs.U64, enabled: bcs.Bool
});
export async function readDeepbookGasFeePolicy(client: SuiGrpcClient, poolKey: string) {
  const pool = mainnetPools[poolKey as keyof typeof mainnetPools];
  if (!pool) throw new Error("The fee policy pool is unavailable.");
  const { dynamicField } = await client.core.getDynamicField({ parentId: pool.address, name: {
    type: "vector<u8>", bcs: bcs.vector(bcs.U8).serialize(new TextEncoder().encode("ewma")).toBytes()
  } });
  const { type, bcs: bytes } = dynamicField.value;
  // Verified type origin for the EWMA state introduced in the mainnet upgrade.
  if (type !== "0x00c1a56ec8c4c623a848b2ed2f03d23a25d17570b670c22106f336eb933785cc::ewma::EWMAState" ||
      bytes.length !== 49 || bytes[48]! > 1) throw new Error("Unrecognized DeepBook gas fee policy.");
  const state = ewmaState.parse(bytes);
  return { enabled: state.enabled, additionalTakerFeeRaw: state.additionalTakerFee };
}
