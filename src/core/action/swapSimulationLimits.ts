import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import type { ReviewTimeSimulationEvidence } from "./reviewTimeSimulationEvidence.js";
import type { SwapQuotePolicyEvidence } from "./swapQuotePolicyEvidence.js";

// Sum signed effects per account asset. Refunds and DEEP principal can share
// a balance row. The verified PTB separately constrains each input coin.
export function simulationWithinSwapLimits(simulation: ReviewTimeSimulationEvidence, quote: SwapQuotePolicyEvidence): boolean {
  if (quote.enforcement?.transactionDigest !== simulation.transactionDigest || quote.account !== simulation.account) return false;
  const minimumNet = new Map<string, bigint>();
  const add = (map: Map<string, bigint>, type: string, value: bigint) => map.set(type, (map.get(type) ?? 0n) + value);
  add(minimumNet, quote.sourceAmount.asset.coinType, -BigInt(quote.sourceAmount.raw));
  add(minimumNet, quote.minimumOutput.asset.coinType, BigInt(quote.minimumOutput.raw));
  if (quote.inputFlow.fee.kind === "separate_coin") {
    if (quote.separateFeeBudgetRaw === null) return false;
    add(minimumNet, quote.inputFlow.fee.amount.asset.coinType, -BigInt(quote.separateFeeBudgetRaw));
  }
  const changes = new Map<string, bigint>();
  for (const change of simulation.balanceChanges) if (change.address === quote.account) add(changes, change.coinType, BigInt(change.amount));
  const gas = simulation.effects.gasCostSummary;
  add(changes, SUI_TYPE_ARG, BigInt(gas.computationCostRaw) + BigInt(gas.storageCostRaw) - BigInt(gas.storageRebateRaw));
  for (const [type, floor] of minimumNet) if ((changes.get(type) ?? 0n) < floor) return false;
  for (const [type, amount] of changes) if (!minimumNet.has(type) && amount < 0n) return false;
  return true;
}
