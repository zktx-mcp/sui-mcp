import { describe, expect, it } from "vitest";
import {
  SmokeResponseShapeError,
  assertSmokeOkStatus,
  summarizeActivitySmokePayload
} from "../src/runtime/smokeMainnetReadAssertions.js";

describe("smoke mainnet read assertions", () => {
  it("summarizes valid activity scan smoke payloads without raw transaction details", () => {
    const record = summarizeActivitySmokePayload(activityPayload({
      accountSource: "explicit_filter",
      transactions: [{ digest: "abc" }]
    }), "read_scan_sui_account_activity", {
      expectedAccountSource: "explicit_filter",
      requireAnalysis: false
    });

    expect(record).toEqual({
      status: "ok",
      rowCount: 1,
      emptyAccepted: false,
      transactionCount: 1,
      account: "0xabc",
      accountSource: "explicit_filter",
      relationship: "affected",
      sourceTransport: "graphql",
      sourceMethod: "Query.transactions",
      hasMore: false,
      windowComplete: true,
      orderingVerified: true,
      persistenceStored: true,
      requestedAccountBalanceChangeCompleteness: "complete",
      requestedAccountCoinFlowCount: 0,
      requestedAccountSentCount: 0,
      requestedAccountAffectedOnlyCount: 0,
      requestedAccountTransactionFactCount: 1,
      requestedAccountTransactionFactBalanceChangeRowCount: 0,
      fullDetailsReturned: false,
      compactReturned: false,
      compactBalanceChangeRowCount: 0,
      compactAggregatedBalanceChangeRowCount: 0,
      transactionContextCount: 0,
      requestedAccountEffectBalanceChangeRowCount: 0,
      requestedAccountEffectTruncatedTransactionCount: 0
    });
  });

  it("treats empty activity pages as valid smoke outcomes", () => {
    const record = summarizeActivitySmokePayload(activityPayload({
      accountSource: "active_account_context",
      transactions: [],
      analysis: {
        overview: { transactionCount: 0 },
        limitations: ["empty_result"]
      }
    }), "read_summarize_sui_activity_scan", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: true
    });

    expect(record.status).toBe("empty_page");
    expect(record.rowCount).toBe(0);
    expect(record.emptyAccepted).toBe(true);
    expect(record.transactionCount).toBe(0);
    expect(record.analysisLimitationCount).toBe(1);
    expect(record.analysisCoinFlowCount).toBe(0);
  });

  it("records summary evidence-boundary metrics without storing raw details", () => {
    const record = summarizeActivitySmokePayload(activityPayload({
      accountSource: "active_account_context",
      transactions: [{
        digest: "abc",
        requestedAccountEffect: {
          account: "0xabc",
          scope: "requested_account",
          role: "affected_only",
          sentByAccount: false,
          balanceChangeCompleteness: "complete",
          balanceChangeEvidence: "account_balance_changes_returned",
          accountBalanceChangeInferencePolicy: "use_returned_account_balance_changes",
          balanceChanges: [
            {
              index: 0,
              coinType: "0x3::coin::RWA",
              amountRaw: "4000000000",
              direction: "increase"
            }
          ],
          coinFlows: [
            {
              coinType: "0x3::coin::RWA",
              increaseRaw: "4000000000",
              decreaseRaw: "0",
              netRaw: "4000000000"
            }
          ],
          limitations: []
        },
        transactionContext: {
          factScope: "transaction",
          requestedAccountScoped: false,
          moveCallTargets: ["0x3::rwa::mint"],
          objectChangeCounts: { created: 100, mutated: 0, deleted: 0 },
          eventTypes: [],
          detailTruncated: true
        }
      }],
      analysis: {
        overview: { transactionCount: 1 },
        limitations: [],
        coinFlows: [{ coinType: "0x3::coin::RWA" }]
      }
    }), "read_summarize_sui_activity_scan", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: true,
      expectNoDetails: true
    });

    expect(record).toMatchObject({
      fullDetailsReturned: false,
      compactReturned: false,
      compactBalanceChangeRowCount: 0,
      compactAggregatedBalanceChangeRowCount: 0,
      transactionContextCount: 1,
      requestedAccountTransactionFactCount: 1,
      requestedAccountTransactionFactBalanceChangeRowCount: 1,
      requestedAccountEffectBalanceChangeRowCount: 1,
      requestedAccountEffectTruncatedTransactionCount: 0,
      requestedAccountBalanceChangeCompleteness: "complete",
      requestedAccountCoinFlowCount: 1,
      analysisCoinFlowCount: 1
    });
  });

  it("rejects summary smoke payloads that return full transaction details", () => {
    expect(() => summarizeActivitySmokePayload(activityPayload({
      accountSource: "active_account_context",
      transactions: [{ digest: "abc", details: { balanceChanges: [] } }],
      analysis: {
        overview: { transactionCount: 1 },
        limitations: [],
        coinFlows: []
      }
    }), "read_summarize_sui_activity_scan", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: true,
      expectNoDetails: true
    })).toThrow(SmokeResponseShapeError);
  });

  it("rejects summary smoke payloads that return compact transaction aggregates", () => {
    expect(() => summarizeActivitySmokePayload(activityPayload({
      accountSource: "active_account_context",
      transactions: [{
        digest: "abc",
        compact: {
          factScope: "transaction",
          requestedAccountScoped: false,
          balanceChanges: []
        }
      }],
      analysis: {
        overview: { transactionCount: 1 },
        limitations: [],
        coinFlows: []
      }
    }), "read_summarize_sui_activity_scan", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: true,
      expectNoDetails: true
    })).toThrow(SmokeResponseShapeError);
  });

  it("rejects requested-account answer rows with transaction-wide balance aggregates", () => {
    const payload = activityPayload({
      accountSource: "active_account_context",
      transactions: [{ digest: "abc" }]
    });
    const facts = (payload.data as { requestedAccountTransactionFacts: Array<{ transactionContext: unknown }> })
      .requestedAccountTransactionFacts;
    facts[0]!.transactionContext = {
      factScope: "transaction",
      requestedAccountScoped: false,
      balanceChanges: []
    };

    expect(() => summarizeActivitySmokePayload(payload, "read_summarize_sui_activity_scan", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: false
    })).toThrow(SmokeResponseShapeError);
  });

  it("rejects live transaction context rows with transaction-wide balance aggregates", () => {
    expect(() => summarizeActivitySmokePayload(activityPayload({
      accountSource: "active_account_context",
      transactions: [{
        digest: "abc",
        transactionContext: {
          factScope: "transaction",
          requestedAccountScoped: false,
          balanceChanges: []
        }
      }]
    }), "read_scan_sui_account_activity", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: false
    })).toThrow(SmokeResponseShapeError);
  });

  it("rejects compact balance-change counts that are not positive", () => {
    expect(() => summarizeActivitySmokePayload(activityPayload({
      accountSource: "active_account_context",
      transactions: [{
        digest: "abc",
        compact: {
          factScope: "transaction",
          requestedAccountScoped: false,
          balanceChanges: [
            {
              coinType: "0x3::coin::RWA",
              amountRaw: "4000000000",
              direction: "increase",
              count: 0
            }
          ]
        }
      }]
    }), "read_scan_sui_account_activity", {
      expectedAccountSource: "active_account_context",
      requireAnalysis: false
    })).toThrow(SmokeResponseShapeError);
  });

  it("summarizes sent function activity smoke payloads without recording the function target", () => {
    const record = summarizeActivitySmokePayload(activityPayload({
      accountSource: "explicit_filter",
      relationship: "sent",
      functionTarget: "0x2::coin::transfer",
      transactions: []
    }), "read_scan_sui_function_activity", {
      expectedAccountSource: "explicit_filter",
      expectedRelationship: "sent",
      requireFunction: true,
      requireAnalysis: false
    });

    expect(record).toMatchObject({
      status: "empty_page",
      relationship: "sent",
      functionTargetPresent: true
    });
    expect(record).not.toHaveProperty("function");
  });

  it("rejects function activity payloads with the wrong relationship", () => {
    expect(() => summarizeActivitySmokePayload(activityPayload({
      accountSource: "explicit_filter",
      relationship: "affected",
      functionTarget: "0x2::coin::transfer",
      transactions: []
    }), "read_scan_sui_function_activity", {
      expectedAccountSource: "explicit_filter",
      expectedRelationship: "sent",
      requireFunction: true,
      requireAnalysis: false
    })).toThrow(SmokeResponseShapeError);
  });

  it("rejects activity payloads missing boundary fields", () => {
    const payload = activityPayload({ accountSource: "explicit_filter", transactions: [] });
    delete (payload.data as Record<string, unknown>).orderingVerified;

    expect(() => summarizeActivitySmokePayload(payload, "read_scan_sui_account_activity", {
      expectedAccountSource: "explicit_filter",
      requireAnalysis: false
    })).toThrow(SmokeResponseShapeError);
  });

  it("rejects non-ok tool status payloads", () => {
    expect(() => assertSmokeOkStatus({ ok: true, data: { status: "blocked" } }, "tool")).toThrow(
      SmokeResponseShapeError
    );
  });
});

function activityPayload(input: {
  accountSource: "active_account_context" | "explicit_filter";
  transactions: unknown[];
  relationship?: "affected" | "sent";
  functionTarget?: string;
  analysis?: {
    overview: { transactionCount: number };
    limitations: unknown[];
    coinFlows?: unknown[] | undefined;
  };
}): Record<string, unknown> {
  return {
    ok: true,
    data: {
      status: "ok",
      account: "0xabc",
      accountSource: input.accountSource,
      relationship: input.relationship ?? "affected",
      ...(input.functionTarget === undefined ? {} : { function: input.functionTarget }),
      source: {
        transport: "graphql",
        method: "Query.transactions"
      },
      transactions: input.transactions,
      hasMore: false,
      windowComplete: true,
      orderingVerified: true,
      persistence: { stored: true },
      requestedAccount: {
        account: "0xabc",
        relationship: input.relationship ?? "affected",
        sentCount: 0,
        affectedOnlyCount: 0,
        balanceChangeCompleteness: "complete",
        coinFlows: input.analysis?.coinFlows?.length
          ? [{
              coinType: "0x3::coin::RWA",
              increaseRaw: "4000000000",
              decreaseRaw: "0",
              netRaw: "4000000000",
              transactionCount: 1
            }]
          : []
      },
      requestedAccountTransactionFacts: input.transactions.map(requestedAccountFactForFixture),
      ...(input.analysis === undefined
        ? {}
        : { analysis: { ...input.analysis, coinFlows: input.analysis.coinFlows ?? [] } })
    }
  };
}

function requestedAccountFactForFixture(transaction: unknown): Record<string, unknown> {
  const transactionObject = objectValue(transaction);
  const effect = objectValue(transactionObject?.requestedAccountEffect) ?? {
    account: "0xabc",
    scope: "requested_account",
    role: "affected_only",
    sentByAccount: false,
    balanceChangeEvidence: "no_account_balance_changes_returned",
    accountBalanceChangeInferencePolicy: "no_account_balance_changes_in_complete_details",
    balanceChangeCompleteness: "complete",
    balanceChanges: [],
    coinFlows: [],
    limitations: []
  };
  const balanceChanges = Array.isArray(effect.balanceChanges) ? effect.balanceChanges : [];
  const balanceChangeEvidence = typeof effect.balanceChangeEvidence === "string"
    ? effect.balanceChangeEvidence
    : balanceChanges.length === 0
      ? "no_account_balance_changes_returned"
      : "account_balance_changes_returned";
  const accountBalanceChangeInferencePolicy = typeof effect.accountBalanceChangeInferencePolicy === "string"
    ? effect.accountBalanceChangeInferencePolicy
    : balanceChangeEvidence === "no_account_balance_changes_returned"
      ? "no_account_balance_changes_in_complete_details"
      : balanceChangeEvidence === "account_balance_changes_returned"
        ? "use_returned_account_balance_changes"
        : "do_not_infer_from_transaction_context";
  const requestedAccountEffect = {
    ...effect,
    accountBalanceChangeInferencePolicy
  };
  const digest = typeof transactionObject?.digest === "string" ? transactionObject.digest : "abc";
  return {
    digest,
    requestedAccount: "0xabc",
    accountScope: "requested_account",
    accountRole: effect.role ?? "affected_only",
    sentByAccount: effect.sentByAccount ?? false,
    accountBalanceChangeEvidence: balanceChangeEvidence,
    accountBalanceChangeInferencePolicy,
    accountBalanceChangeCompleteness: effect.balanceChangeCompleteness ?? "complete",
    accountBalanceChanges: balanceChanges,
    accountCoinFlows: Array.isArray(effect.coinFlows) ? effect.coinFlows : [],
    accountEffectLimitations: Array.isArray(effect.limitations) ? effect.limitations : [],
    requestedAccountEffect,
    transactionContext: {
      factScope: "transaction",
      requestedAccountScoped: false,
      moveCallTargets: [],
      objectChangeCounts: { created: 0, mutated: 0, deleted: 0 },
      eventTypes: [],
      detailTruncated: false
    },
    detailLookup: {
      tool: "read_inspect_sui_transaction",
      digest
    }
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
