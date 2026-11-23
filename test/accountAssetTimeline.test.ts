import { activityIndexGenesis } from "./fixtures/sqliteActivity.js";
import { describe, expect, it } from "vitest";
import { buildAccountAssetTimeline } from "../src/core/activity/accountAssetTimeline.js";
import {
  attachDeepbookUsdcReferencesToTimeline,
  type AccountAssetTimelineUsdcPriceHistoryReader
} from "../src/core/activity/accountAssetTimelineUsdcReferences.js";
import type {
  ExternalActivityScanRecord,
  ExternalActivityTransactionRecord
} from "../src/core/activity/activityStore.js";
import { buildExternalActivityCoverageResult } from "../src/core/activity/externalActivityCoverage.js";
import type { DeepbookUsdcPriceHistorySummary } from "../src/core/read/readServiceTypes.js";
import { deepbookUsdcPriceHistoryQuantitySemantics, deepbookUsdcPriceHistoryResponseSummary } from "../src/core/read/deepbookReadHelpers.js";
import {
  DEEPBOOK_CANDLE_RESPONSE_TEXT,
  DEEPBOOK_CANDLE_SOURCE_BASE
} from "../src/core/read/deepbookSourceOwners.js";
import type { ExternalActivityTransactionDetail } from "../src/core/activity/transactionActivityDetails.js";

const account = `0x${"a".repeat(64)}`;

describe("account asset timeline builder", () => {
  it("builds UTC net-flow bars per coin type without producing balance bars", () => {
    const result = buildAccountAssetTimeline({
      account,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-11T00:30:00.000Z",
      coverage: completeCoverage(),
      transactions: [
        transaction({
          digest: "a".repeat(44),
          timestamp: "2026-05-11T00:05:00.000Z",
          changes: [
            { coinType: "0x2::sui::SUI", amountRaw: "100" },
            { coinType: "0xusdc::coin::USDC", amountRaw: "-50" }
          ]
        }),
        transaction({
          digest: "b".repeat(44),
          timestamp: "2026-05-11T00:09:59.000Z",
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "-30" }]
        }),
        transaction({
          digest: "c".repeat(44),
          timestamp: "2026-05-11T00:10:00.000Z",
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "0" }]
        })
      ]
    });

    expect(result.status).toBe("ok");
    expect(result.balanceStatus).toBe("unavailable_no_balance_anchor");
    expect(result.balanceBars).toEqual([]);
    expect(result.quantitySemantics).toEqual({
      netFlowBars: "observed_account_scoped_raw_token_balance_changes",
      balanceBars: "unavailable_without_balance_anchor"
    });
    expect(result.limitations).toEqual(["no_balance_anchor"]);
    expect(result.netFlowBars).toEqual([
      {
        bucketStart: "2026-05-11T00:00:00.000Z",
        bucketEnd: "2026-05-11T00:15:00.000Z",
        coinType: "0x2::sui::SUI",
        increaseRaw: "100",
        decreaseRaw: "30",
        netRaw: "70",
        transactionCount: 3
      },
      {
        bucketStart: "2026-05-11T00:00:00.000Z",
        bucketEnd: "2026-05-11T00:15:00.000Z",
        coinType: "0xusdc::coin::USDC",
        increaseRaw: "0",
        decreaseRaw: "50",
        netRaw: "-50",
        transactionCount: 1
      }
    ]);
  });

  it("returns scan-needed status without inferring zero activity when no scans are stored", () => {
    const result = buildAccountAssetTimeline({
      account,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-11T00:30:00.000Z",
      coverage: noScanCoverage(),
      transactions: []
    });

    expect(result.status).toBe("scan_needed");
    expect(result.netFlowBars).toEqual([]);
    expect(result.balanceBars).toEqual([]);
    expect(result.limitations).toEqual([
      "no_balance_anchor",
      "no_complete_affected_account_scan",
      "no_observed_account_balance_changes",
      "no_stored_activity_scans"
    ]);
  });

  it("keeps partial coverage, missing detail, and truncated detail limitations visible", () => {
    const result = buildAccountAssetTimeline({
      account,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-11T01:00:00.000Z",
      interval: "30m",
      coverage: partialCoverage(),
      transactions: [
        transaction({
          digest: "d".repeat(44),
          timestamp: "2026-05-11T00:05:00.000Z",
          changes: undefined
        }),
        transaction({
          digest: "e".repeat(44),
          timestamp: "2026-05-11T00:35:00.000Z",
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "9" }],
          balanceChangesTruncated: true
        })
      ],
      transactionsTruncated: true
    });

    expect(result.status).toBe("partial_coverage");
    expect(result.analyzedTransactionCount).toBe(2);
    expect(result.netFlowBars).toEqual([
      {
        bucketStart: "2026-05-11T00:30:00.000Z",
        bucketEnd: "2026-05-11T01:00:00.000Z",
        coinType: "0x2::sui::SUI",
        increaseRaw: "9",
        decreaseRaw: "0",
        netRaw: "9",
        transactionCount: 1
      }
    ]);
    expect(result.limitations).toEqual([
      "no_balance_anchor",
      "no_complete_affected_account_scan",
      "provider_balance_changes_truncated",
      "scan_window_incomplete",
      "sent_only_scan_not_full_account_coverage",
      "source_transactions_truncated",
      "transaction_details_unavailable"
    ]);
  });

  it("skips rows outside the requested timestamp range without using them as zero-flow evidence", () => {
    const result = buildAccountAssetTimeline({
      account,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-11T00:30:00.000Z",
      coverage: completeCoverage(),
      transactions: [
        transaction({
          digest: "f".repeat(44),
          timestamp: undefined,
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "1" }]
        }),
        transaction({
          digest: "1".repeat(44),
          timestamp: "2026-05-11T00:31:00.000Z",
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "2" }]
        })
      ]
    });

    expect(result.sourceTransactionCount).toBe(2);
    expect(result.analyzedTransactionCount).toBe(0);
    expect(result.skippedTransactionCount).toBe(2);
    expect(result.netFlowBars).toEqual([]);
    expect(result.limitations).toEqual([
      "no_balance_anchor",
      "no_observed_account_balance_changes",
      "transaction_timestamp_unavailable"
    ]);
  });

  it("attaches DeepBook USDC references for the selected official interval", async () => {
    const timeline = buildAccountAssetTimeline({
      account,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-11T00:30:00.000Z",
      interval: "15m",
      coverage: completeCoverage(),
      transactions: [
        transaction({
          digest: "2".repeat(44),
          timestamp: "2026-05-11T00:05:00.000Z",
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "100" }]
        }),
        transaction({
          digest: "3".repeat(44),
          timestamp: "2026-05-11T00:15:00.000Z",
          changes: [{ coinType: "0x2::sui::SUI", amountRaw: "-20" }]
        })
      ]
    });
    const calls: unknown[] = [];
    const withReferences = await attachDeepbookUsdcReferencesToTimeline({
      timeline,
      getPriceHistory: async (input) => {
        calls.push(input);
        return okHistory([
          candle({
            start: "2026-05-11T00:00:00.000Z",
            end: "2026-05-11T00:15:00.000Z",
            close: "3.25"
          })
        ]);
      }
    });

    expect(calls).toEqual([
      {
        coinType: "0x2::sui::SUI",
        interval: "15m",
        start: "2026-05-11T00:00:00.000Z",
        end: "2026-05-11T00:30:00.000Z"
      }
    ]);
    expect(withReferences.usdcReferences.status).toBe("partial");
    expect(withReferences.usdcReferences.usdcIsFiatUsd).toBe(false);
    expect(withReferences.usdcReferences.usdPegGuaranteeAvailable).toBe(false);
    expect(withReferences.usdcReferences.responseSummary.usdcDisclaimer).toBe(
      DEEPBOOK_CANDLE_RESPONSE_TEXT.usdcDisclaimer
    );
    expect(withReferences.usdcReferences.coinReferences).toEqual([
      expect.objectContaining({
        coinType: "0x2::sui::SUI",
        status: "partial",
        barReferences: [
          expect.objectContaining({
            bucketStart: "2026-05-11T00:00:00.000Z",
            bucketEnd: "2026-05-11T00:15:00.000Z",
            status: "available",
            candle: expect.objectContaining({ close: "3.25" })
          }),
          {
            bucketStart: "2026-05-11T00:15:00.000Z",
            bucketEnd: "2026-05-11T00:30:00.000Z",
            status: "missing_candle"
          }
        ]
      })
    ]);
  });

  it("reads only occupied runs across a range exceeding the public history limit", async () => {
    const from = "2026-05-11T00:00:00.000Z", to = "2026-05-13T00:00:00.000Z";
    const timeline = buildAccountAssetTimeline({account, from, to, interval:"1m", coverage:completeCoverage(),
      transactions:[from, "2026-05-12T23:59:01.000Z"].map((timestamp,i) => transaction({
        digest:String(i+2).repeat(44), timestamp, changes:[{coinType:"0x2::sui::SUI",amountRaw:"7"}]
      }))});
    const windows: string[][] = [];
    const result = await attachDeepbookUsdcReferencesToTimeline({timeline, getPriceHistory:async input => {
      windows.push([input.start, input.end]);
      return okHistory([]);
    }});
    expect(windows).toEqual([[from,"2026-05-11T00:01:00.000Z"],["2026-05-12T23:59:00.000Z",to]]);
    expect(result.netFlowBars.map(bar => bar.netRaw)).toEqual(["7","7"]);
    expect(result.usdcReferences.status).toBe("unavailable");
  });

  it("keeps unsupported and unavailable DeepBook USDC references separate from net-flow bars", async () => {
    const timeline = buildAccountAssetTimeline({
      account,
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-11T00:15:00.000Z",
      interval: "15m",
      coverage: completeCoverage(),
      transactions: [
        transaction({
          digest: "4".repeat(44),
          timestamp: "2026-05-11T00:05:00.000Z",
          changes: [
            { coinType: "0xunsupported::coin::COIN", amountRaw: "1" },
            { coinType: "0xsource::coin::DOWN", amountRaw: "1" },
            { coinType: "0xoffline::coin::OFF", amountRaw: "7" }
          ]
        })
      ]
    });
    const reader: AccountAssetTimelineUsdcPriceHistoryReader = async (input) => {
      if (input.coinType === "0xoffline::coin::OFF") throw new Error("Price read interrupted");
      return input.coinType === "0xunsupported::coin::COIN" ? unsupportedPairHistory() : sourceUnavailableHistory();
    };
    const withReferences = await attachDeepbookUsdcReferencesToTimeline({ timeline, getPriceHistory: reader });

    expect(withReferences.netFlowBars).toEqual(timeline.netFlowBars);
    expect(withReferences.usdcReferences.status).toBe("unavailable");
    expect(withReferences.usdcReferences.coinReferences).toEqual([
      {
        coinType: "0xoffline::coin::OFF",
        range: { start: "2026-05-11T00:00:00.000Z", end: "2026-05-11T00:15:00.000Z" },
        status: "source_unavailable",
        reason: "chain_candle_source_unavailable"
      },
      {
        range: { start:"2026-05-11T00:00:00.000Z", end:"2026-05-11T00:15:00.000Z" },
        coinType: "0xsource::coin::DOWN",
        status: "source_unavailable",
        reason: "candle_fetch_failed",
        pair: undefined,
        source: undefined
      },
      {
        range: { start:"2026-05-11T00:00:00.000Z", end:"2026-05-11T00:15:00.000Z" },
        coinType: "0xunsupported::coin::COIN",
        status: "unsupported_asset",
        reason: "market_not_in_mainnet_pool_catalog",
        matchingPoolNames: [],
        availablePoolNames: ["SUI_USDC"]
      }
    ]);
  });
});

function completeCoverage() {
  return buildExternalActivityCoverageResult({
    scope: { account, accountId: 1, accountSource: "explicit_filter" },
    from: "2026-05-11T00:00:00.000Z",
    to: "2026-05-11T01:00:00.000Z",
    scans: [scan({ scanId: "complete_scan", relationship: "affected", windowComplete: true })],
    scanCount: 1,
    storedTransactionCount: 0
  });
}

function noScanCoverage() {
  return buildExternalActivityCoverageResult({
    scope: { account, accountId: 1, accountSource: "explicit_filter" },
    from: "2026-05-11T00:00:00.000Z",
    to: "2026-05-11T01:00:00.000Z",
    scans: [],
    scanCount: 0,
    storedTransactionCount: 0
  });
}

function partialCoverage() {
  return buildExternalActivityCoverageResult({
    scope: { account, accountId: 1, accountSource: "explicit_filter" },
    from: "2026-05-11T00:00:00.000Z",
    to: "2026-05-11T01:00:00.000Z",
    scans: [
      scan({ scanId: "sent_scan", relationship: "sent", windowComplete: true }),
      scan({
        scanId: "incomplete_scan",
        relationship: "affected",
        windowComplete: false,
        incompleteReason: "limit_reached"
      })
    ],
    scanCount: 2,
    storedTransactionCount: 1
  });
}

function scan(input: {
  scanId: string;
  relationship: "affected" | "sent";
  windowComplete: boolean;
  incompleteReason?: "limit_reached" | undefined;
}): ExternalActivityScanRecord {
  return {
    scanId: input.scanId, continuity: { sourceLower: activityIndexGenesis, rootScanId: input.scanId },
    kind: "account_scan",
    accountId: 1,
    account,
    relationship: input.relationship,
    fromTimestamp: "2026-05-11T00:00:00.000Z",
    toTimestamp: "2026-05-11T01:00:00.000Z",
    limit: 100,
    sourceUpperTimestamp: "2026-12-01T00:00:00.000Z", sourceUpperCheckpoint: "10000000",
    endpointHost: "graphql.mainnet.sui.io",
    chainIdentifier: "mainnet-chain",
    fetchedAt: "2026-05-11T01:00:01.000Z",
    storedCount: 0,
    skippedCount: 0,
    hasMore: false,
    windowComplete: input.windowComplete,
    incompleteReason: input.incompleteReason
  };
}

function transaction(input: {
  digest: string;
  timestamp: string | undefined;
  changes: Array<{ coinType: string; amountRaw: string }> | undefined;
  balanceChangesTruncated?: boolean | undefined;
}): ExternalActivityTransactionRecord {
  return {
    accountId: 1,
    account,
    digest: input.digest,
    relationship: "affected",
    checkpoint: "100",
    timestamp: input.timestamp,
    status: "success",
    firstScanId: "scan",
    lastScanId: "scan",
    firstFetchedAt: "2026-05-11T01:00:01.000Z",
    lastFetchedAt: "2026-05-11T01:00:01.000Z",
    details: input.changes === undefined
      ? undefined
      : details(input.changes, input.balanceChangesTruncated === true)
  };
}

function details(
  changes: Array<{ coinType: string; amountRaw: string }>,
  balanceChangesTruncated: boolean
): ExternalActivityTransactionDetail {
  return {
    moveCalls: [],
    balanceChanges: changes.map((change, index) => ({
      index,
      owner: account,
      coinType: change.coinType,
      amountRaw: change.amountRaw,
      direction: directionForRaw(change.amountRaw)
    })),
    objectChanges: [],
    events: [],
    truncation: {
      moveCalls: false,
      balanceChanges: balanceChangesTruncated,
      objectChanges: false,
      events: false
    }
  };
}

function directionForRaw(raw: string): "increase" | "decrease" | "zero" {
  const value = BigInt(raw);
  if (value > 0n) return "increase";
  if (value < 0n) return "decrease";
  return "zero";
}

function okHistory(bars: Extract<DeepbookUsdcPriceHistorySummary, { status: "ok" }>["bars"]): DeepbookUsdcPriceHistorySummary {
  return {
    status: "ok",
    fetchedAt: "2026-05-11T00:20:01.000Z",
    requested: {
      selector: { kind: "coin_type", value: "0x2::sui::SUI" },
      range: {
        start: "2026-05-11T00:00:00.000Z",
        end: "2026-05-11T00:30:00.000Z",
        timeZone: "UTC",
        interval: "15m",
        intervalDurationMs: 900000,
        maxBars: 1008,
        requestedCandleSlots: 2
      }
    },
    pair: {
      poolName: "SUI_USDC",
      poolId: `0x${"1".repeat(64)}`,
      baseAsset: {
        symbol: "SUI",
        coinType: "0x2::sui::SUI",
        decimals: 9
      },
      quoteAsset: {
        symbol: "USDC",
        coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        decimals: 6
      },
      priceConvention: "USDC_PER_BASE"
    },
    candleAvailability: "available",
    barCount: bars.length,
    bars,
    source: {
      kind: DEEPBOOK_CANDLE_SOURCE_BASE.kind,
      baseUrl: "https://deepbook-indexer.mainnet.mystenlabs.com",
      sourceStatement: DEEPBOOK_CANDLE_RESPONSE_TEXT.sourceStatement,
      poolList: {
        url: "https://deepbook-indexer.mainnet.mystenlabs.com/get_pools",
        fetchedAt: "2026-05-11T00:20:01.000Z"
      },
      candles: {
        poolId: `0x${"1".repeat(64)}`,
        url: "https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/SUI_USDC?interval=15m",
        fetchedAt: "2026-05-11T00:20:01.000Z",
        poolName: "SUI_USDC",
        interval: "15m",
        startTimeMs: Date.parse("2026-05-11T00:00:00.000Z"),
        endTimeMs: Date.parse("2026-05-11T00:30:00.000Z"),
        limit: 1008
      },
      chainRecomputedBySuiMcp: true
    },
    userAnswerUse: { canAnswer: [], cannotAnswer: [], answerFields: [] },
    quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
    responseSummary: deepbookUsdcPriceHistoryResponseSummary(),
    unsupportedClaims: [...deepbookUsdcPriceHistoryResponseSummary().excludedFromConclusion]
  };
}

function unsupportedPairHistory(): DeepbookUsdcPriceHistorySummary {
  return {
    status: "unsupported_pair",
    fetchedAt: "2026-05-11T00:20:01.000Z",
    requested: okHistory([]).requested,
    reason: "market_not_in_mainnet_pool_catalog",
    matchingPoolNames: [],
    availablePoolNames: ["SUI_USDC"],
    userAnswerUse: { canAnswer: [], cannotAnswer: [], answerFields: [] },
    quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
    responseSummary: deepbookUsdcPriceHistoryResponseSummary(),
    unsupportedClaims: [...deepbookUsdcPriceHistoryResponseSummary().excludedFromConclusion]
  };
}

function sourceUnavailableHistory(): DeepbookUsdcPriceHistorySummary {
  return {
    status: "source_unavailable",
    fetchedAt: "2026-05-11T00:20:01.000Z",
    requested: okHistory([]).requested,
    reason: "candle_fetch_failed",
    userAnswerUse: { canAnswer: [], cannotAnswer: [], answerFields: [] },
    quantitySemantics: deepbookUsdcPriceHistoryQuantitySemantics(),
    responseSummary: deepbookUsdcPriceHistoryResponseSummary(),
    unsupportedClaims: [...deepbookUsdcPriceHistoryResponseSummary().excludedFromConclusion]
  };
}

function candle(input: { start: string; end: string; close: string }): Extract<DeepbookUsdcPriceHistorySummary, { status: "ok" }>["bars"][number] {
  return {
    timestampMs: Date.parse(input.start),
    start: input.start,
    end: input.end,
    open: input.close,
    high: input.close,
    low: input.close,
    close: input.close,
    volume: "325"
  };
}
