import { bcs } from "@mysten/sui/bcs";
import { TransactionCommands, type Transaction, type Argument, type TransactionData } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { mainnetPackageIds } from "@mysten/deepbook-v3";

import { deepbookQuoteAssets, getKnownPool } from "../../core/read/deepbookRegistry.js";
import type { SwapQuotePolicyEvidence } from "../../core/action/swapQuotePolicyEvidence.js";
import { isDeepStrictEqual } from "node:util";

// Published.toml, v9 mainnet. Move abort locations can identify the original module.
export function deepbookMinimumAbort(guardIndex: number) {
  return { commandIndex: guardIndex - 1, packageId: mainnetPackageIds.DEEPBOOK_PACKAGE_ID,
    moduleOrigin: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809",
    module: "pool", code: "12" };
}

export function verifyDeepbookMinimum(data: TransactionData, quote: SwapQuotePolicyEvidence) {
  const guard = quote.enforcement, key = quote.quoteSource.poolKey, direction = quote.quoteSource.direction;
  const { base, quote: counter, deep } = deepbookQuoteAssets(key);
  if (guard?.method !== "split_and_rejoin_swap_output" || guard.commandFailure !== "InsufficientCoinBalance" ||
      quote.sourceAmount.asset.coinType !== (direction === "base_to_quote" ? base : counter).coinType ||
      quote.minimumOutput.asset.coinType !== (direction === "base_to_quote" ? counter : base).coinType) throw Error("Swap asset or enforcement method mismatch");
  const index = verifyDeepbookSwapCommands(data, { account: quote.account, poolId: getKnownPool(key).address,
    baseType: base.coinType, quoteType: counter.coinType, deepType: deep.coinType, direction,
    principal: BigInt(quote.sourceAmount.raw), minimum: BigInt(quote.minimumOutput.raw), deepBudget: BigInt(quote.separateFeeBudgetRaw ?? "0") });
  if (guard.commandIndex !== index || !isDeepStrictEqual(guard.protocolAbort, deepbookMinimumAbort(index))) throw Error("Swap minimum proof differs from the reviewed transaction");
}

type Limits = {
  account: string; poolId: string; baseType: string; quoteType: string; deepType: string;
  direction: "base_to_quote" | "quote_to_base"; principal: bigint; deepBudget: bigint; minimum: bigint;
};
const FRAMEWORK = normalizeSuiAddress("0x2");
function ref(arg: Argument): string {
  if (arg.$kind === "NestedResult") return `result:${arg.NestedResult[0]}:${arg.NestedResult[1]}`;
  if (arg.$kind === "Result") return `result:${arg.Result}:0`;
  return arg.$kind === "GasCoin" ? "gas" : `input:${arg.Input}`;
}

// A retained input coin or gas coin can receive change. An address withdrawal,
// a destroyed empty funding coin, and an SDK remainder sent back as funds cannot.
function retainedFundingCoin(data: Pick<TransactionData, "commands" | "inputs">, at: number, position: number) {
  const funding = data.commands[at]?.MoveCall?.arguments[position];
  if (funding?.$kind !== "NestedResult") return;
  const [splitAt] = funding.NestedResult;
  const source = data.commands[splitAt]?.SplitCoins?.coin;
  if (!source || !(source.$kind === "GasCoin" || (source.$kind === "Input" && data.inputs[source.Input]?.Object?.ImmOrOwnedObject))) return;
  const key = ref(source);
  for (const cmd of data.commands.slice(splitAt + 1, at)) {
    if (cmd.MoveCall?.arguments.some((a) => ref(a) === key) || cmd.TransferObjects?.objects.some((a) => ref(a) === key) ||
        cmd.MergeCoins?.sources.some((a) => ref(a) === key)) return;
  }
  return source;
}

export function mergeSwapRefundsIntoFunding(transaction: Transaction, direction: Limits["direction"]) {
  transaction.addBuildPlugin(async (data, _options, next) => {
    const swap = data.commands.findIndex((c) => c.MoveCall?.module === "pool" &&
      c.MoveCall.function === (direction === "base_to_quote" ? "swap_exact_base_for_quote" : "swap_exact_quote_for_base"));
    const last = data.commands.length - 1, transfer = data.commands[last]?.TransferObjects;
    if (swap >= 0 && transfer) {
      const coins = [], merges = [];
      for (const coin of transfer.objects) {
        const idx = coin.$kind === "NestedResult" && coin.NestedResult[0] === swap ? coin.NestedResult[1] : -1;
        const funding = idx === (direction === "base_to_quote" ? 0 : 1) ? retainedFundingCoin(data, swap, 1)
          : idx === 2 ? retainedFundingCoin(data, swap, 2) : undefined;
        if (funding) merges.push(TransactionCommands.MergeCoins(funding, [coin]));
        else coins.push(coin);
      }
      if (merges.length) data.replaceCommand(last, [...merges, TransactionCommands.TransferObjects(coins, transfer.address)]);
    }
    await next();
  });
}
// Interpret the finished BCS, including commands inserted by SDK coin resolution.
// Exact coin amounts are needed only where a coin crosses into the pool.
export function verifyDeepbookSwapCommands(data: TransactionData, limits: Limits): number {
  const fail = (reason: string): never => { throw new Error(`Reviewed swap command mismatch: ${reason}`); };
  const pure = (arg: Argument | undefined, width: number) => {
    const value = arg?.$kind === "Input" ? data.inputs[arg.Input]?.Pure : undefined;
    if (!value) return fail("missing pure input");
    const bytes = fromBase64(value.bytes);
    return bytes.length === width ? bytes : fail("pure input width");
  };
  const raw = (arg: Argument | undefined) => BigInt(bcs.U64.parse(pure(arg, 8)));
  const self = (arg: Argument | undefined) => bcs.Address.parse(pure(arg, 32)) === limits.account;
  const object = (arg: Argument | undefined) => arg?.$kind === "Input" ? data.inputs[arg.Input]?.Object?.SharedObject?.objectId : undefined;
  if (data.sender !== limits.account || data.gasData.owner !== limits.account || limits.minimum <= 0n) fail("sender, gas owner or minimum");
  const amounts = new Map<string, bigint>();
  const consumed = new Set<string>();
  const read = (arg: Argument) => {
    const key = ref(arg);
    if (consumed.has(key)) fail("consumed coin reused");
    return amounts.get(key);
  };
  const take = (arg: Argument) => { const value = read(arg); consumed.add(ref(arg)); return value; };
  const result = (i: number, j = 0) => `result:${i}:${j}`;
  const swapName = limits.direction === "base_to_quote" ? "swap_exact_base_for_quote" : "swap_exact_quote_for_base";
  const swapIndex = data.commands.findIndex(({ MoveCall: call }) => call?.module === "pool" && call.function === swapName);
  if (swapIndex < 0) fail("missing swap");
  for (let i = 0; i < swapIndex; i++) {
    const cmd = data.commands[i]!;
    if (cmd.SplitCoins) {
      const source = read(cmd.SplitCoins.coin);
      let sum = 0n;
      for (const [j, arg] of cmd.SplitCoins.amounts.entries()) {
        const n = raw(arg); sum += n; amounts.set(result(i, j), n);
      }
      if (source !== undefined) {
        if (source < sum) fail("split exceeds available amount");
        amounts.set(ref(cmd.SplitCoins.coin), source - sum);
      }
    } else if (cmd.MergeCoins) {
      let sum = read(cmd.MergeCoins.destination);
      for (const arg of cmd.MergeCoins.sources) {
        const n = take(arg); sum = sum === undefined || n === undefined ? undefined : sum + n;
      }
      if (sum === undefined) amounts.delete(ref(cmd.MergeCoins.destination));
      else amounts.set(ref(cmd.MergeCoins.destination), sum);
    } else {
      const c = cmd.MoveCall;
      if (!c || normalizeSuiAddress(c.package) !== FRAMEWORK || c.module !== "coin") return fail("unexpected funding command");
      const [arg, recipient] = c.arguments;
      if (c.function === "zero" && c.arguments.length === 0 && normalizeStructTag(c.typeArguments[0]!) === limits.deepType) {
        amounts.set(result(i), 0n);
      } else if (c.function === "redeem_funds" && arg?.$kind === "Input" && c.arguments.length === 1) {
        const withdrawal = data.inputs[arg.Input]?.FundsWithdrawal;
        if (!withdrawal || !withdrawal.withdrawFrom.Sender || !withdrawal.typeArg.Balance ||
            normalizeStructTag(withdrawal.typeArg.Balance) !== normalizeStructTag(c.typeArguments[0]!)) return fail("withdrawal source");
        amounts.set(result(i), BigInt(withdrawal.reservation.MaxAmountU64));
      } else if (arg && ((c.function === "send_funds" && c.arguments.length === 2 && self(recipient)) ||
          (c.function === "destroy_zero" && c.arguments.length === 1))) {
        take(arg);
      } else fail("unexpected funding recipient or function");
    }
  }
  const call = data.commands[swapIndex]!.MoveCall!;
  const [pool, input, deep, floor, clock] = call.arguments;
  if (call.package !== mainnetPackageIds.DEEPBOOK_PACKAGE_ID || call.arguments.length !== 5 ||
      call.typeArguments.length !== 2 || normalizeStructTag(call.typeArguments[0]!) !== limits.baseType ||
      normalizeStructTag(call.typeArguments[1]!) !== limits.quoteType || object(pool) !== limits.poolId ||
      object(clock) !== normalizeSuiAddress("0x6") || !input || !deep || take(input) !== limits.principal ||
      take(deep) !== limits.deepBudget || raw(floor) !== limits.minimum) fail("pool, funding, types or lower bound");
  const out = result(swapIndex, limits.direction === "base_to_quote" ? 1 : 0);
  const deepOut = result(swapIndex, 2);
  const returns = new Set([result(swapIndex), result(swapIndex, 1), deepOut]);
  let splitIndex = -1, rejoined = false;
  for (let i = swapIndex + 1; i < data.commands.length; i++) {
    const cmd = data.commands[i]!;
    if (splitIndex < 0 && cmd.SplitCoins && ref(cmd.SplitCoins.coin) === out &&
        cmd.SplitCoins.amounts.length === 1 && raw(cmd.SplitCoins.amounts[0]) === limits.minimum) {
      splitIndex = i;
    } else if (splitIndex >= 0 && !rejoined && cmd.MergeCoins && ref(cmd.MergeCoins.destination) === out &&
        cmd.MergeCoins.sources.length === 1 && ref(cmd.MergeCoins.sources[0]!) === result(splitIndex)) {
      rejoined = true;
    } else if (rejoined && cmd.MergeCoins && cmd.MergeCoins.sources.length === 1 && ref(cmd.MergeCoins.sources[0]!) === deepOut &&
        ((limits.baseType === limits.deepType && ref(cmd.MergeCoins.destination) === result(swapIndex)) ||
        (limits.quoteType === limits.deepType && ref(cmd.MergeCoins.destination) === result(swapIndex, 1))) && returns.delete(deepOut)) {
      // The fee refund joins its own asset only after the output guard.
    } else if (rejoined && cmd.MoveCall && normalizeSuiAddress(cmd.MoveCall.package) === FRAMEWORK && cmd.MoveCall.module === "coin" &&
        cmd.MoveCall.function === "destroy_zero" && limits.deepBudget === 0n &&
        normalizeStructTag(cmd.MoveCall.typeArguments[0]!) === limits.deepType &&
        cmd.MoveCall.arguments.length === 1 && ref(cmd.MoveCall.arguments[0]!) === deepOut && returns.delete(deepOut)) {
      // An empty fee coin is consumed by the framework's checked destructor.
    } else if (rejoined && cmd.MergeCoins && cmd.MergeCoins.sources.length === 1) {
      const change = ref(cmd.MergeCoins.sources[0]!);
      const idx = change === deepOut ? 2 : change === result(swapIndex, limits.direction === "base_to_quote" ? 0 : 1) ? 1 : 0;
      const funding = idx && retainedFundingCoin(data, swapIndex, idx);
      if (!funding || ref(funding) !== ref(cmd.MergeCoins.destination) || !returns.delete(change)) fail("refund destination");
    } else if (rejoined && cmd.TransferObjects && self(cmd.TransferObjects.address)) {
      for (const arg of cmd.TransferObjects.objects) if (!returns.delete(ref(arg))) fail("unexpected transferred coin");
    } else fail("unexpected output operation");
  }
  if (!rejoined || returns.size || (limits.deepType === (limits.direction === "base_to_quote" ? limits.quoteType : limits.baseType) &&
      limits.deepBudget !== 0n)) fail("unprotected output, fee refund or recipient");
  return splitIndex;
}
