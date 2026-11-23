import { GrpcTypes, type SuiGrpcClient } from "@mysten/sui/grpc";
import { describe, expect, it, vi } from "vitest";
import {
  MarketGraphqlReader,
  DEEPBOOK_TYPE_ORIGIN,
  FOUNDATION_GRAPHQL,
  ORDER_FILLED,
  renderCandles,
  scanPoolBars,
  historicalPoolFills,
  grpcPoolFills,
  type ChainEvent,
} from "../src/core/read/deepbookChainHistory.js";
import { SUI_MAINNET_CHAIN_IDENTIFIER } from "../src/core/suiEndpoint.js";
import { normalizeStructTag } from "@mysten/sui/utils";
import { DeepbookUsdcPriceService } from "../src/core/read/deepbookUsdcPriceService.js";
import { ChainCandleSource } from "../src/core/read/chainCandleSource.js";
import {
  DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
  deepbookCandlePoolsSchema,
  parseDeepbookCandleInterval,
} from "../src/core/read/deepbookCandleSource.js";

const pool = "0x" + "a".repeat(64),
  other = "0x" + "b".repeat(64);
const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const another = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const time = "2026-11-23T01:17:00.000Z";
const cp = { sequenceNumber: 7, timestamp: time, digest };
const event = (tx: string, seq: number, p: string, price: string, base: string): ChainEvent => ({
  transaction: { digest: tx, effects: { checkpoint: cp } },
  sequenceNumber: seq,
  contents: { type: { repr: ORDER_FILLED }, json: { pool_id: p, price, base_quantity: base, quote_quantity: "1" } },
});
const reply = (data: unknown) => new Response(JSON.stringify({ data }));

function archiveReply(data: object, first = 0, last = cp.sequenceNumber) {
  return reply({ ...data, chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
    serviceConfig: { availableRange: { first: { sequenceNumber: first }, last: { sequenceNumber: last } } } });
}

async function collect<T>(items: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

function wire(row: ChainEvent) {
  const { pool_id, price, base_quantity, quote_quantity } = row.contents.json;
  return {
    ...row,
    contents: {
      type: row.contents.type,
      pool: { json: pool_id },
      price: { json: price },
      base: { json: base_quantity },
      quote: { json: quote_quantity },
    },
  };
}
function tx(row: ChainEvent, extra: ChainEvent[] = []) {
  return {
    digest: row.transaction.digest,
    effects: {
      checkpoint: row.transaction.effects.checkpoint,
      events: { nodes: [row, ...extra].map(wire), pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}
function bars(reader: MarketGraphqlReader) {
  const signal = new AbortController().signal;
  return scanPoolBars(reader, historicalPoolFills(reader, pool, 7, 8, 50, signal), 7, 8, 50, signal, "1m");
}
describe("mainnet fill candles", () => {
  it("uses committed transaction order across pages and keeps identical amounts in distinct fills", async () => {
    const a = event(digest, 4, pool, "1000001", "9007199254740993");
    const b = event(another, 0, pool, "1000003", "9007199254740993");
    const foreign = event(another, 1, other, "9999999", "1");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        archiveReply({
          transactions: {
            nodes: [tx(a)],
            pageInfo: { hasNextPage: true, endCursor: "page" },
          },
        }),
      )
      .mockResolvedValueOnce(
        archiveReply({
          transactions: {
            nodes: [tx(a), tx(b, [foreign])],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      )
      .mockImplementation(async () =>
        archiveReply({
          checkpoint: {
            digest,
            transactions: {
              nodes: [{ digest: another }, { digest }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );
    const parts = await collect(bars(new MarketGraphqlReader(fetch)));
    const bar = parts[0]!;
    expect(bar).toMatchObject({
      open: "1000003",
      high: "1000003",
      low: "1000001",
      close: "1000001",
      volume: "18014398509481986",
      fills: 2,
    });
    expect(renderCandles([bar], "1m", 9, 6)[0]).toMatchObject({
      open: "1.000003",
      close: "1.000001",
      volume: "18014398.509481986",
    });
    expect(fetch.mock.calls.every(([url]) => url === FOUNDATION_GRAPHQL)).toBe(true);
  });

  it.each(["wrong type", "wrong checkpoint", "invalid amount", "bad cursor", "GraphQL errors", "HTTP error"])(
    "refuses incomplete data: %s",
    async (reason) => {
      const row = event(digest, 0, pool, "1000", "1000");
      if (reason === "wrong type") row.contents.type.repr = "0x2::unrelated::OrderFilled";
      if (reason === "wrong checkpoint") row.transaction.effects.checkpoint = { ...cp, sequenceNumber: 9 };
      if (reason === "invalid amount")
        row.contents.json = { pool_id: pool, price: "1e2", base_quantity: "1", quote_quantity: "1" };
      const reader = new MarketGraphqlReader(async () =>
        reason === "HTTP error"
          ? new Response("", { status: 503 })
          : reason === "GraphQL errors"
            ? new Response(JSON.stringify({ data: null, errors: [{ message: "partial" }] }))
            : archiveReply({
                transactions: { nodes: [tx(row)], pageInfo: { hasNextPage: reason === "bad cursor", endCursor: null } },
              }),
      );
      if (reason === "wrong type") expect(await collect(bars(reader))).toEqual([]);
      else await expect(collect(bars(reader))).rejects.toThrow();
    },
  );

  it("recognizes an exhausted range without adding an artificial trade", async () => {
    const reader = new MarketGraphqlReader(async () =>
      archiveReply({ transactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }),
    );
    const parts = await collect(bars(reader));
    expect(parts).toEqual([]);
    expect(renderCandles([], "1w", 9, 6)).toEqual([]);
  });

  it("aborts a stalled body and rejects unsupported intervals and malformed market metadata", async () => {
    const controller = new AbortController();
    const reader = new MarketGraphqlReader(
      async (_, init) =>
        new Response(
          new ReadableStream({
            start(body) {
              init!.signal!.addEventListener("abort", () => body.error(init!.signal!.reason));
            },
          }),
        ),
    );
    const pending = reader.range(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(() => parseDeepbookCandleInterval("2m")).toThrow();
    expect(deepbookCandlePoolsSchema.safeParse([{ pool_id: "invalid" }]).success).toBe(false);
  });
});

it("uses matched ledger transactions once across stream limits and requires the terminal checkpoint", async () => {
  const value = (text: string) => ({ kind: { oneofKind: "stringValue", stringValue: text } });
  const row = (type: string, price: string) => ({
    eventType: ORDER_FILLED,
    json: {
      kind: {
        oneofKind: "structValue",
        structValue: {
          fields: { pool_id: value(type), price: value(price), base_quantity: value("10"), quote_quantity: value("1") },
        },
      },
    },
  });
  const first = {
    digest: another,
    checkpoint: 7n,
    transactionIndex: 1n,
    timestamp: { seconds: BigInt(Date.parse(time) / 1000), nanos: 0 },
    events: { events: [row(pool, "13"), row(other, "100")] },
  };
  const second = { ...first, digest, transactionIndex: 0n, events: { events: [row(pool, "10")] } };
  let complete = true;
  const listTransactions = vi.fn((request: GrpcTypes.ListTransactionsRequest) => ({
    responses: (async function* () {
      if (!request.options!.before)
        yield {
          transaction: first,
          watermark: { cursor: Uint8Array.of(1) },
          end: { reason: GrpcTypes.QueryEndReason.ITEM_LIMIT },
        };
      else {
        yield { transaction: second, watermark: { cursor: Uint8Array.of(2) } };
        if (complete)
          yield {
            watermark: { cursor: Uint8Array.of(3), checkpoint: 7n },
            end: { reason: GrpcTypes.QueryEndReason.CHECKPOINT_BOUND },
          };
      }
    })(),
  }));
  const rpc = { ledgerService: { listTransactions } } as unknown as SuiGrpcClient;
  const reader = new MarketGraphqlReader(() => {
    throw Error("Ledger positions already establish transaction order.");
  });
  const signal = new AbortController().signal;
  const collectBars = () =>
    collect(scanPoolBars(reader, grpcPoolFills(rpc, pool, 7, 8, signal), 7, 8, 50, signal, "1m"));
  expect(await collectBars()).toMatchObject([
    { open: "10", high: "13", low: "10", close: "13", volume: "20", fills: 2 },
  ]);
  expect(listTransactions.mock.calls[0]![0].filter?.terms[0]?.literals).toMatchObject([
    { predicate: { affectedObject: { objectId: pool } } },
    { predicate: { eventType: { eventType: ORDER_FILLED } } },
  ]);
  complete = false;
  await expect(collectBars()).rejects.toThrow("coverage");
});

it("keeps indexed history through a later end and searches across verified pool creation", async () => {
  const start = Date.parse(time);
  const iso = (offset: number) => new Date(start + offset).toISOString();
  const creation = { sequenceNumber: 1, timestamp: iso(2000), digest };
  const tip = { sequenceNumber: 2, timestamp: iso(29000), digest: another };
  const fill = event(digest, 0, pool, "2500000", "3000000000");
  fill.transaction.effects.checkpoint = creation;
  const graphql = vi.fn<typeof fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("transactions:maxPageSize")) return reply({
      chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER, serviceConfig: {
        range: { first: { ...cp, sequenceNumber: 0, timestamp: iso(-3600000) }, last: tip },
        fills: null, fillPage: 50, transactions: 50, events: 50, order: 50
      }
    });
    if (query.includes("previousTransaction")) return reply({ object: { previousTransaction: { effects: { checkpoint: creation } } } });
    if (query.includes("transactions(filter:$filter,last:$size")) {
      expect(variables.filter).toMatchObject({ affectedObject: pool, afterCheckpoint: 0, beforeCheckpoint: 3 });
      return archiveReply({ transactions: { nodes: [tx(fill)], pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    throw Error("Unexpected archive request.");
  });
  const rpc = {
    ledgerService: { getServiceInfo: () => ({ response: Promise.resolve({
      chainId: SUI_MAINNET_CHAIN_IDENTIFIER, lowestAvailableCheckpoint: 10n, checkpointHeight: 11n
    }) }) },
    core: {
      getObject: async () => ({ object: { type: `${DEEPBOOK_TYPE_ORIGIN}::pool::Pool<0x2::sui::SUI,${DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE}>`,
        owner: { Shared: { initialSharedVersion: "1" } } } }),
      getCoinMetadata: async ({ coinType }: { coinType: string }) => ({ coinMetadata:
        coinType === DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE ? { symbol: "USDC", decimals: 6 } : { symbol: "SUI", decimals: 9 } })
    }
  } as unknown as SuiGrpcClient;
  vi.stubGlobal("fetch", graphql);
  const source = new ChainCandleSource(rpc);
  try {
    const service = new DeepbookUsdcPriceService(source, () => iso(30000));
    const selector = { poolId: pool, interval: "1m" } as const;
    const history = await service.prepareHistory({ ...selector, start: time, end: iso(180000) }).read();
    expect(history).toMatchObject({ status: "ok", candleAvailability: "partial_coverage", barCount: 1,
      requested: { range: { end: iso(180000) } }, source: { candles: { coveredFrom: time, coveredUntil: iso(29001) } },
      bars: [{ start: time, open: "2.5", high: "2.5", low: "2.5", close: "2.5", volume: "3" }] });
    const point = await service.preparePoint({ ...selector, targetTime: iso(-1000), maxDistanceMinutes: 1 }).read();
    expect(point).toMatchObject({ status: "ok", match: { kind: "nearest_after" }, matchedCandle: { start: time, close: "2.5" } });
    const empty = await service.preparePoint({ ...selector, targetTime: iso(-120000), maxDistanceMinutes: 1 }).read();
    expect(empty).toMatchObject({ status: "no_price_in_search_window", candleAvailability: "no_candles_in_range" });
  } finally {
    source.close();
    vi.unstubAllGlobals();
  }
});

it("reports only the archive origin when a moving gRPC floor leaves the range uncovered", async () => {
  const endpoint = "https://market.example.invalid/private-path";
  const graphql = vi.fn<typeof fetch>(async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("transactions:maxPageSize"))
      return reply({
        chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
        serviceConfig: {
          range: { first: { ...cp, sequenceNumber: 0 }, last: cp },
          fills: null,
          fillPage: 50,
          transactions: 50,
          events: 50,
          order: 50,
        },
      });
    if (query.includes("previousTransaction"))
      return reply({ object: { previousTransaction: { effects: { checkpoint: { sequenceNumber: 0, timestamp: time } } } } });
    if (query.includes("transactions(filter:$filter,last:$size"))
      return archiveReply({ transactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    if (query.includes("transactions(last:1"))
      return reply({
        chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
        serviceConfig: { availableRange: { first: { sequenceNumber: 0 }, last: { sequenceNumber: 7 } } },
        transactions: { nodes: [] },
      });
    throw Error("Unexpected source lookup.");
  });
  vi.stubGlobal("fetch", graphql);
  const rpc = {
    ledgerService: {
      getServiceInfo: () => ({
        response: Promise.resolve({
          chainId: SUI_MAINNET_CHAIN_IDENTIFIER,
          lowestAvailableCheckpoint: 0n,
          checkpointHeight: 7n,
        }),
      }),
      listTransactions: () => ({
        responses: (async function* () {
          throw Object.assign(Error("Retention moved"), { code: "OUT_OF_RANGE" });
        })(),
      }),
    },
  } as unknown as SuiGrpcClient;
  const source = new ChainCandleSource(rpc, endpoint);
  try {
    const market = {
      pool_id: pool,
      pool_name: "SUI_USDC",
      base_asset_id: "0x2::sui::SUI",
      base_asset_symbol: "SUI",
      base_asset_decimals: 9,
      quote_asset_id: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
      quote_asset_symbol: "USDC",
      quote_asset_decimals: 6,
      initialSharedVersion: "1",
    };
    const result = await source.fetchCandles({
      poolId: pool,
      market,
      directId: true,
      poolName: market.pool_name,
      interval: "1m",
      startTimeMs: Date.parse(time),
      endTimeMs: Date.parse(time),
    });
    expect(result.candles).toEqual([]);
    expect(result.source).toMatchObject({
      baseUrl: new URL(endpoint).origin,
      url: new URL(endpoint).origin,
      readEndpoints: [new URL(endpoint).origin],
    });
    expect(JSON.stringify(result)).not.toContain("private-path");
    const relative = {poolId:pool, market, directId:true, poolName:market.pool_name, interval:"1m" as const,
      startTimeMs:Date.parse(time), endTimeMs:Date.parse(time)+60_000};
    await expect(source.fetchCandles(relative)).rejects.toMatchObject({reason:"source_unavailable"});
    await expect(source.fetchCandles({...relative,endMode:"latest_indexed"})).resolves.toMatchObject({
      candles:[],source:{coverage:"partial_tail", endTimeMs:relative.endTimeMs, coveredUntil:"2026-11-23T01:17:00.001Z"}
    });
  } finally {
    source.close();
    vi.unstubAllGlobals();
  }
});

it("reuses the typed fill page when it covers the archive window, without paging unrelated pool activity", async () => {
  const row = event(digest, 0, pool, "11", "7"),
    foreign = event(another, 0, other, "500", "99");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      archiveReply({ transactions: { nodes: [tx(row)], pageInfo: { hasNextPage: true, endCursor: "unused-pool-cursor" } } }),
    )
    .mockResolvedValueOnce(
      archiveReply({ events: { nodes: [wire(row), wire(foreign)], pageInfo: { hasNextPage: false, endCursor: null } } }),
    );
  const reader = new MarketGraphqlReader(fetch),
    signal = new AbortController().signal;
  const fills = historicalPoolFills(reader, pool, 7, 8, 50, signal, true);
  expect(await collect(scanPoolBars(reader, fills, 7, 8, 50, signal, "1m"))).toMatchObject([
    { open: "11", close: "11", volume: "7", fills: 1 },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [, init] of fetch.mock.calls) {
    const query = JSON.parse(String(init?.body)).query;
    expect(query).toContain('extract(path:"pool_id")');
    expect(query).not.toContain("contents{type{repr} json}");
  }
});

it.each(["pool", "type"] as const)("refuses an exhausted %s index page when its coverage moved", async index => {
  const row = event(digest, 0, pool, "11", "7");
  const more = { hasNextPage: true, endCursor: "next" };
  const end = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const reader = new MarketGraphqlReader(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const events = query.includes("events(filter:$filter");
    expect(query).toContain(events ? 'field:"events",filters:["type"]' : 'field:"transactions",filters:["affectedObject"]');
    expect(variables.filter.beforeCheckpoint).toBe(8);
    if (variables.before) {
      expect(events).toBe(index === "type");
      return archiveReply(events ? { events: end } : { transactions: end }, 8, 9);
    }
    return archiveReply(events
      ? { events: { nodes: [wire(row)], pageInfo: more } }
      : { transactions: { nodes: [tx(row)], pageInfo: more } });
  });
  const pages = reader.poolFillPages(pool, 7, 8, 50, new AbortController().signal, index === "type");
  expect((await pages.next()).value?.nodes).toHaveLength(1);
  await expect(pages.next()).rejects.toMatchObject({ reason: "candle_coverage_incomplete" });
});

it.each(["pool", "type"] as const)("uses the covered first page when only the %s index retains the interval", async retained => {
  const row = event(digest, 0, pool, "11", "7");
  const older = event(another, 0, pool, "10", "6");
  const reader = new MarketGraphqlReader(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("events(filter:$filter")) {
      const covered = retained === "type";
      return archiveReply({ events: { nodes: covered ? [wire(older), wire(row)] : [], pageInfo: { hasNextPage: false, endCursor: null } } },
        covered ? 7 : 8, 9);
    }
    const covered = retained === "pool";
    const more = covered && !variables.before;
    return archiveReply({ transactions: { nodes: covered ? [tx(more ? row : older)] : [], pageInfo: { hasNextPage: more, endCursor: more ? "next" : null } } },
      covered ? 7 : 8, 9);
  });
  const fills = await collect(historicalPoolFills(reader, pool, 7, 8, 50, new AbortController().signal, true));
  expect(fills.map(fill => fill.digest)).toEqual([digest, another]);
});

it.each(["GraphQL error", "body read failure", "malformed JSON"] as const)("handles %s on the optional event query", async failure => {
  const newest = event(digest, 0, pool, "11", "7"), oldest = event(another, 0, pool, "10", "6");
  const calls: string[] = [];
  const reader = new MarketGraphqlReader(async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body));
    if (variables.filter.type) {
      calls.push("events");
      if (failure === "malformed JSON") return new Response("{");
      if (failure === "body read failure") {
        return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("Connection closed")); }
        }));
      }
      return Response.json({ errors: [{ message: "Event index unavailable" }] });
    }
    calls.push(variables.before ?? "start");
    return archiveReply({transactions: {
      nodes: [tx(variables.before ? oldest : newest)],
      pageInfo: variables.before ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: "older" }
    }});
  });
  const fills = collect(historicalPoolFills(reader, pool, 7, 8, 50, new AbortController().signal, true));
  if (failure === "malformed JSON") {
    await expect(fills).rejects.toThrow(SyntaxError);
    expect(calls).toEqual(["start", "events"]);
  } else {
    expect((await fills).map(fill => fill.digest)).toEqual([digest, another]);
    expect(calls).toEqual(["start", "events", "older"]);
  }
});

it("keeps the retained half and joins just the pruned checkpoints into the same UTC candle", async () => {
  const firstTime = Date.parse(time);
  const recentTime = new Date(firstTime + 20_000).toISOString();
  const oldCp = { ...cp, sequenceNumber: 6 };
  const cutoff = { ...cp, sequenceNumber: 8, timestamp: recentTime };
  let archiveEnd: number | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("transactions:maxPageSize"))
      return reply({
        chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
        serviceConfig: {
          range: { first: { ...cp, sequenceNumber: 0 }, last: cutoff },
          fills: null,
          fillPage: 50,
          transactions: 50,
          events: 50,
          order: 50,
        },
      });
    if (query.includes("previousTransaction"))
      return reply({ object: { previousTransaction: { effects: { checkpoint: { sequenceNumber: 0, timestamp: time } } } } });
    if (query.includes("transactions(filter:$filter")) {
      archiveEnd = variables.filter.beforeCheckpoint;
      const old = event(another, 0, pool, "20", "7");
      old.transaction.effects.checkpoint = oldCp;
      return archiveReply({ transactions: { nodes: [tx(old)], pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    throw Error("Unexpected source read.");
  });
  let infoReads = 0;
  const string = (value: string) => ({ kind: { oneofKind: "stringValue", stringValue: value } });
  const lists = vi.fn((input: GrpcTypes.ListTransactionsRequest) => ({
    responses: (async function* () {
      if (input.startCheckpoint === 6n) throw Object.assign(Error("Retention moved."), { code: "OUT_OF_RANGE" });
      yield {
        watermark: { cursor: Uint8Array.of(1) },
        transaction: {
          digest,
          checkpoint: 8n,
          transactionIndex: 0n,
          timestamp: { seconds: BigInt(firstTime / 1000 + 20), nanos: 0 },
          events: {
            events: [
              {
                eventType: ORDER_FILLED,
                json: {
                  kind: {
                    oneofKind: "structValue",
                    structValue: {
                      fields: {
                        pool_id: string(pool),
                        price: string("30"),
                        base_quantity: string("11"),
                        quote_quantity: string("1"),
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      };
      yield {
        watermark: { cursor: Uint8Array.of(2), checkpoint: input.startCheckpoint },
        end: { reason: GrpcTypes.QueryEndReason.CHECKPOINT_BOUND },
      };
    })(),
  }));
  const rpc = {
    ledgerService: {
      getServiceInfo: () => ({
        response: Promise.resolve({
          chainId: SUI_MAINNET_CHAIN_IDENTIFIER,
          lowestAvailableCheckpoint: infoReads++ === 0 ? 5n : 7n,
          checkpointHeight: 8n,
        }),
      }),
      listTransactions: lists,
    },
  } as unknown as SuiGrpcClient;
  vi.stubGlobal("fetch", fetch);
  const source = new ChainCandleSource(rpc);
  try {
    const market = {
      pool_id: pool,
      pool_name: "SUI_USDC",
      base_asset_id: "0x2::sui::SUI",
      base_asset_symbol: "SUI",
      base_asset_decimals: 9,
      quote_asset_id: DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE,
      quote_asset_symbol: "USDC",
      quote_asset_decimals: 6,
      initialSharedVersion: "1",
    };
    const result = await source.fetchCandles({
      poolId: pool,
      market,
      directId: true,
      poolName: market.pool_name,
      interval: "1m",
      startTimeMs: firstTime,
      endTimeMs: firstTime + 20000,
    });
    expect(lists.mock.calls.map(([r]) => [r.startCheckpoint, r.endCheckpoint])).toEqual([
      [7n, 9n],
      [6n, 7n],
    ]);
    expect(archiveEnd).toBe(7);
    expect(result.candles).toMatchObject([
      { open: "0.00002", high: "0.00003", low: "0.00002", close: "0.00003", volume: "0.000000018" },
    ]);
    expect(result.source.readEndpoints).toEqual(["https://fullnode.mainnet.sui.io:443", FOUNDATION_GRAPHQL]);
  } finally {
    source.close();
    vi.unstubAllGlobals();
  }
});

it("isolates unreadable coin metadata and hydrates only eligible Chart pools", async () => {
  const base = normalizeStructTag("0x2::sui::SUI"), missing = normalizeStructTag("0x9::asset::SUI");
  const quote = DEEPBOOK_CANDLE_CANONICAL_USDC_COIN_TYPE;
  const registry = DEEPBOOK_TYPE_ORIGIN + "::registry::";
  const entries = [[pool, base], [other, missing]] as const;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const {query} = JSON.parse(String(init.body));
    if (query.includes("asMoveObject")) return reply({chainIdentifier:SUI_MAINNET_CHAIN_IDENTIFIER,
      checkpoint:{sequenceNumber:7},object:{asMoveObject:{contents:{
        type:{repr:registry+"Registry"},json:{inner:{id:other,version:"1"}}
      }}}});
    if (query.includes("dynamicField(name")) return reply({checkpoint:{query:{address:{dynamicField:{value:{
      type:{repr:registry+"RegistryInner"},json:{pools:{id:other}}
    }}}}}});
    if (query.includes("dynamicFields(after")) return reply({checkpoint:{query:{address:{dynamicFields:{
      nodes:entries.map(([address,coin]) => ({name:{type:{repr:registry+"PoolKey"},json:{base:coin,quote}},
        value:{type:{repr:normalizeStructTag("0x2::object::ID")},json:address}})),
      pageInfo:{hasNextPage:false,endCursor:null}
    }}}}});
    throw new Error("Unexpected registry lookup.");
  });
  const objects: string[] = [];
  const rpc = {
    ledgerService:{getServiceInfo:() => ({response:Promise.resolve({chainId:SUI_MAINNET_CHAIN_IDENTIFIER})})},
    core:{
      async getObject({objectId}:{objectId:string}) {
        objects.push(objectId);
        return {object:{type:DEEPBOOK_TYPE_ORIGIN+"::pool::Pool<"+(objectId === pool ? base : missing)+","+quote+">",owner:{Shared:{initialSharedVersion:"1"}}}};
      },
      async getCoinMetadata({coinType}:{coinType:string}) {
        return {coinMetadata:coinType === missing ? null : coinType === base ? {symbol:"SUI",decimals:9} : {symbol:"USDC",decimals:6}};
      }
    }
  } as unknown as SuiGrpcClient;
  const source = new ChainCandleSource(rpc);
  try {
    const menu = await source.fetchMenuPools();
    expect(objects).toEqual([pool]);
    expect(menu.pools.map(row => row.pool_id)).toEqual([pool]);
    const directory = await source.fetchPools();
    expect(directory.pools.map(row => row.pool_id)).toEqual([pool]);
    expect(directory.unavailablePools).toEqual([{poolId:other,baseCoinType:missing,quoteCoinType:quote,unavailableReason:"coin_metadata_unavailable"}]);
    await expect(source.fetchPools(other)).rejects.toThrow("coin_metadata_unavailable");
  } finally { source.close(); vi.unstubAllGlobals(); }
});
