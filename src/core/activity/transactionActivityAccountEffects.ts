import type { ExternalActivityRelationship } from "./activityStore.js";
import type {
  SuiAccountBalanceChangeCompleteness,
  SuiAccountBalanceChangeEvidence,
  SuiAccountBalanceChangeInferencePolicy,
  SuiAccountScopedBalanceChange,
  SuiRequestedAccountActivity,
  SuiTransactionAccountEffectLimitation,
  SuiTransactionAccountEffects,
  SuiTransactionActivityFact
} from "./transactionActivityTypes.js";
import { parseSuiAddress } from "../suiAddress.js";

type CoinFlowAccumulator = {
  increaseRaw: bigint;
  decreaseRaw: bigint;
  netRaw: bigint;
  digests: Set<string>;
};

export function attachRequestedAccountEffects<T extends SuiTransactionActivityFact>(
  transactions: T[],
  account: string, providerAffected = false
): Array<T & { accountEffects: SuiTransactionAccountEffects }> {
  return transactions.map((transaction) => ({
    ...transaction,
    accountEffects: requestedAccountEffectsForTransaction(transaction, account, providerAffected)
  }));
}

export function buildRequestedAccountActivity(
  input: {
    account: string;
    relationship: ExternalActivityRelationship;
    transactions: Array<SuiTransactionActivityFact & { accountEffects?: SuiTransactionAccountEffects | undefined }>;
  }
): SuiRequestedAccountActivity {
  const coinFlows = new Map<string, CoinFlowAccumulator>();
  let sentCount = 0;
  let affectedOnlyCount = 0, unconfirmedCount = 0;
  let completeness: SuiAccountBalanceChangeCompleteness = "complete";

  for (const transaction of input.transactions) {
    const effects = transaction.accountEffects ?? requestedAccountEffectsForTransaction(transaction, input.account);
    if (effects.sentByAccount) {
      sentCount += 1;
    } else if (effects.role === "affected_only") {
      affectedOnlyCount++;
    } else unconfirmedCount++;
    completeness = mergeCompleteness(completeness, effects.balanceChangeCompleteness);

    for (const change of effects.balanceChanges) {
      const entry = coinFlows.get(change.coinType) ?? {
        increaseRaw: 0n,
        decreaseRaw: 0n,
        netRaw: 0n,
        digests: new Set<string>()
      };
      const amount = BigInt(change.amountRaw);
      entry.netRaw += amount;
      if (amount > 0n) {
        entry.increaseRaw += amount;
      } else if (amount < 0n) {
        entry.decreaseRaw += -amount;
      }
      entry.digests.add(transaction.digest);
      coinFlows.set(change.coinType, entry);
    }
  }

  return {
    account: input.account,
    relationship: input.relationship,
    sentCount,
    affectedOnlyCount, unconfirmedCount,
    balanceChangeCompleteness: completeness,
    coinFlows: [...coinFlows.entries()]
      .map(([coinType, value]) => ({
        coinType,
        increaseRaw: value.increaseRaw.toString(),
        decreaseRaw: value.decreaseRaw.toString(),
        netRaw: value.netRaw.toString(),
        transactionCount: value.digests.size
      }))
      .sort(compareCoinFlowRows)
  };
}

export function requestedAccountEffectsForTransaction(
  transaction: SuiTransactionActivityFact,
  account: string, providerAffected = false
): SuiTransactionAccountEffects {
  const sentByAccount = addressMatches(transaction.sender, account);
  if (transaction.details === undefined) {
    return {
      account,
      scope: "requested_account",
      role: sentByAccount ? "sender" : providerAffected ? "affected_only" : "unconfirmed",
      sentByAccount,
      balanceChangeEvidence: "account_balance_changes_unavailable",
      accountBalanceChangeInferencePolicy: "do_not_infer_from_transaction_context",
      balanceChangeCompleteness: "unavailable",
      balanceChanges: [],
      coinFlows: [],
      limitations: ["transaction_details_unavailable"]
    };
  }

  const balanceChanges = transaction.details.balanceChanges
    .filter((change) => addressMatches(change.owner, account))
    .map((change) => ({
      index: change.index,
      coinType: change.coinType,
      amountRaw: change.amountRaw,
      direction: change.direction
    }));
  const balanceChangeCompleteness = transaction.details.partialReasons?.balanceChanges === "not_returned" ? "unavailable"
    : transaction.details.truncation.balanceChanges ? "truncated" : "complete";
  const balanceChangeEvidence = balanceChangeEvidenceFor(balanceChangeCompleteness, balanceChanges);

  return {
    account,
    scope: "requested_account",
    role: sentByAccount ? "sender" : providerAffected || balanceChanges.length ? "affected_only" : "unconfirmed",
    sentByAccount,
    balanceChangeEvidence,
    accountBalanceChangeInferencePolicy: accountBalanceChangeInferencePolicyFor(
      balanceChangeEvidence
    ),
    balanceChangeCompleteness,
    balanceChanges,
    coinFlows: coinFlowsForBalanceChanges(balanceChanges),
    limitations: limitationsForCompleteness(balanceChangeCompleteness)
  };
}

function accountBalanceChangeInferencePolicyFor(
  evidence: SuiAccountBalanceChangeEvidence
): SuiAccountBalanceChangeInferencePolicy {
  if (evidence === "account_balance_changes_returned") {
    return "use_returned_account_balance_changes";
  }
  if (evidence === "no_account_balance_changes_returned") {
    return "no_account_balance_changes_in_complete_details";
  }
  return "do_not_infer_from_transaction_context";
}

function balanceChangeEvidenceFor(
  completeness: SuiAccountBalanceChangeCompleteness,
  balanceChanges: SuiAccountScopedBalanceChange[]
): SuiAccountBalanceChangeEvidence {
  if (completeness === "truncated") {
    return "incomplete_account_balance_changes";
  }
  if (completeness === "unavailable") {
    return "account_balance_changes_unavailable";
  }
  return balanceChanges.length === 0
    ? "no_account_balance_changes_returned"
    : "account_balance_changes_returned";
}

function coinFlowsForBalanceChanges(
  balanceChanges: SuiAccountScopedBalanceChange[]
): SuiTransactionAccountEffects["coinFlows"] {
  const flows = new Map<string, Omit<SuiTransactionAccountEffects["coinFlows"][number], "coinType"> & {
    increaseRawBigInt: bigint;
    decreaseRawBigInt: bigint;
    netRawBigInt: bigint;
  }>();

  for (const change of balanceChanges) {
    const amount = BigInt(change.amountRaw);
    const entry = flows.get(change.coinType) ?? {
      increaseRaw: "0",
      decreaseRaw: "0",
      netRaw: "0",
      increaseRawBigInt: 0n,
      decreaseRawBigInt: 0n,
      netRawBigInt: 0n
    };
    entry.netRawBigInt += amount;
    if (amount > 0n) {
      entry.increaseRawBigInt += amount;
    } else if (amount < 0n) {
      entry.decreaseRawBigInt += -amount;
    }
    flows.set(change.coinType, entry);
  }

  return [...flows.entries()]
    .map(([coinType, value]) => ({
      coinType,
      increaseRaw: value.increaseRawBigInt.toString(),
      decreaseRaw: value.decreaseRawBigInt.toString(),
      netRaw: value.netRawBigInt.toString()
    }))
    .sort((a, b) => {
      const absoluteNetA = absBigInt(BigInt(a.netRaw));
      const absoluteNetB = absBigInt(BigInt(b.netRaw));
      if (absoluteNetA !== absoluteNetB) {
        return absoluteNetA > absoluteNetB ? -1 : 1;
      }
      return a.coinType.localeCompare(b.coinType);
    });
}

function limitationsForCompleteness(
  completeness: SuiAccountBalanceChangeCompleteness
): SuiTransactionAccountEffectLimitation[] {
  if (completeness === "truncated") {
    return ["provider_balance_changes_truncated"];
  }
  if (completeness === "unavailable") {
    return ["transaction_details_unavailable"];
  }
  return [];
}

function mergeCompleteness(
  current: SuiAccountBalanceChangeCompleteness,
  next: SuiAccountBalanceChangeCompleteness
): SuiAccountBalanceChangeCompleteness {
  if (current === "truncated" || next === "truncated") {
    return "truncated";
  }
  if (current === "unavailable" || next === "unavailable") {
    return "unavailable";
  }
  return "complete";
}

function compareCoinFlowRows(
  a: SuiRequestedAccountActivity["coinFlows"][number],
  b: SuiRequestedAccountActivity["coinFlows"][number]
): number {
  const absoluteNetA = absBigInt(BigInt(a.netRaw));
  const absoluteNetB = absBigInt(BigInt(b.netRaw));
  if (absoluteNetA !== absoluteNetB) {
    return absoluteNetA > absoluteNetB ? -1 : 1;
  }
  return a.coinType.localeCompare(b.coinType);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function addressMatches(candidate: string | undefined, account: string): boolean {
  const normalized = candidate === undefined ? undefined : parseSuiAddress(candidate);
  return normalized !== undefined && normalized === account;
}
