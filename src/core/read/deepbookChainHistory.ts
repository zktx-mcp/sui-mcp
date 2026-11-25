// Only exhausted pages within a finalized checkpoint range establish coverage.
import { GrpcTypes, type SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { z } from "zod";
import { SUI_MAINNET_CHAIN_IDENTIFIER, withRpcDeadline } from "../suiEndpoint.js";
import { suiTransactionDigestSchema } from "../suiAddress.js";
import {
  DeepbookCandleSourceError,
  DEFAULT_DEEPBOOK_CANDLE_FETCH_TIMEOUT_MS,
  candleBucketStart,
  deepbookCandleIntervalDurationMs,
  type DeepbookTradeCandle,
  type DeepbookCandleInterval,
} from "./deepbookCandleSource.js";

export const FOUNDATION_GRAPHQL = "https://graphql.mainnet.sui.io/graphql";
export const DEEPBOOK_TYPE_ORIGIN = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809";
export const ORDER_FILLED = DEEPBOOK_TYPE_ORIGIN + "::order_info::OrderFilled";
const uint = z
  .string()
  .max(20)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn);
const sequence = z.number().int().nonnegative().safe();
const objectId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((value) => normalizeSuiAddress(value));
const checkpoint = z.object({
  sequenceNumber: sequence,
  timestamp: z.iso.datetime(),
  digest: suiTransactionDigestSchema,
});
export type ChainCheckpoint = z.infer<typeof checkpoint>;
// The archive can return events from unrelated Move modules in a pool
// transaction. Request only the four scalar fields needed by the fill reader.
const fieldValue = z.object({ json: z.unknown() }).nullable();
const projectedContents = z
  .object({
    type: z.object({ repr: z.string() }),
    pool: fieldValue,
    price: fieldValue,
    base: fieldValue,
    quote: fieldValue,
  })
  .transform(({ type, pool, price, base, quote }) => ({
    type,
    json: { pool_id: pool?.json, price: price?.json, base_quantity: base?.json, quote_quantity: quote?.json },
  }));
const eventSelection = `sequenceNumber contents{type{repr} pool:extract(path:"pool_id"){json} price:extract(path:"price"){json}
  base:extract(path:"base_quantity"){json} quote:extract(path:"quote_quantity"){json}}`;
const moveEvent = z.object({
  sequenceNumber: sequence,
  transaction: z.object({ digest: suiTransactionDigestSchema, effects: z.object({ checkpoint }) }),
  contents: projectedContents,
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const eventsPage = z.object({ nodes: z.array(moveEvent), pageInfo });
type FillPage = z.infer<typeof eventsPage>;
export type ChainEvent = z.infer<typeof moveEvent>;
const fillBody = z.object({ pool_id: objectId, price: uint, base_quantity: uint, quote_quantity: uint });

const archiveIndex = {
  poolTransactions: 'type:"Query",field:"transactions",filters:["affectedObject"]',
  typedEvents: 'type:"Query",field:"events",filters:["type"]',
  checkpointOrder: 'type:"Checkpoint",field:"transactions"',
} as const;
const checkpointNumber = z.object({ sequenceNumber: sequence });
const checkpointInterval = z.object({ first: checkpointNumber.nullable(), last: checkpointNumber.nullable() }).nullable();
const pageRangeSchema = z.object({
  chainIdentifier: z.literal(SUI_MAINNET_CHAIN_IDENTIFIER),
  serviceConfig: z.object({ availableRange: checkpointInterval }),
});

function archiveCoverageError() {
  return new DeepbookCandleSourceError("candle_coverage_incomplete", "The archive index does not cover the requested checkpoints.");
}

// Only an unavailable first probe may yield to another covered index. Invalid
// evidence and cancellation must still propagate to the consumer.
class ArchiveQueryUnavailable extends Error {}

export class MarketGraphqlReader {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    readonly url = FOUNDATION_GRAPHQL,
  ) {}

  async query<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    owner?: AbortSignal,
  ): Promise<T> {
    return withRpcDeadline(
      DEFAULT_DEEPBOOK_CANDLE_FETCH_TIMEOUT_MS,
      async (signal) => {
        let responseText: string;
        try {
          const response = await this.fetchImpl(this.url, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, variables }),
          });
          if (!response.ok) throw new ArchiveQueryUnavailable(`Mainnet GraphQL returned HTTP ${response.status}.`);
          responseText = await response.text();
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ArchiveQueryUnavailable) throw error;
          throw new ArchiveQueryUnavailable("The mainnet GraphQL response could not be received.", { cause: error });
        }
        const body = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
          .parse(JSON.parse(responseText));
        if (body.errors?.length) {
          if (body.data && typeof body.data === "object" && "chainIdentifier" in body.data &&
              body.data.chainIdentifier != null && body.data.chainIdentifier !== SUI_MAINNET_CHAIN_IDENTIFIER) {
            throw new Error("Unexpected GraphQL chain identifier.");
          }
          throw new ArchiveQueryUnavailable("Mainnet GraphQL could not supply the complete requested facts.");
        }
        return schema.parse(body.data);
      },
      owner,
    );
  }

  // An index can prune checkpoints between requests. Read the watermark and the
  // connection under the same GraphQL request scope, including on continuation.
  private async archivePage<T>(
    index: keyof typeof archiveIndex, from: number, until: number,
    page: { parameters: string; selection: string; variables: Record<string, unknown>; schema: z.ZodType<T> },
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const result = await this.query(
      `query(${page.parameters}){chainIdentifier
        serviceConfig{availableRange(${archiveIndex[index]}){first{sequenceNumber} last{sequenceNumber}}}
        ${page.selection}}`,
      page.variables, page.schema.and(pageRangeSchema), signal,
    );
    const range = result.serviceConfig.availableRange;
    if (!range?.first || !range.last || range.first.sequenceNumber > from || range.last.sequenceNumber < until - 1)
      return undefined;
    return result;
  }

  async range(signal?: AbortSignal) {
    const data = await this.query(
      `{chainIdentifier serviceConfig{
      range:availableRange(${archiveIndex.poolTransactions}){first{sequenceNumber timestamp digest} last{sequenceNumber timestamp digest}}
      fills:availableRange(${archiveIndex.typedEvents}){first{sequenceNumber} last{sequenceNumber}}
      fillPage:maxPageSize(type:"Query",field:"events")
      transactions:maxPageSize(type:"Query",field:"transactions") events:maxPageSize(type:"TransactionEffects",field:"events")
      order:maxPageSize(type:"Checkpoint",field:"transactions")}}`,
      {},
      z.object({
        chainIdentifier: z.literal(SUI_MAINNET_CHAIN_IDENTIFIER),
        serviceConfig: z.object({
          range: z.object({ first: checkpoint, last: checkpoint }),
          fills: checkpointInterval,
          fillPage: z.number().int().positive(),
          transactions: z.number().int().positive(),
          events: z.number().int().positive(),
          order: z.number().int().positive(),
        }),
      }),
      signal,
    );
    const { range, fills, fillPage, transactions, events, order } = data.serviceConfig;
    return { range, fills: fills?.first && fills.last ? { first: fills.first, last: fills.last } : null, maxPageSize: Math.min(transactions, events, order, fillPage) };
  }

  async checkpoint(height: number, signal?: AbortSignal) {
    const data = await this.query(
      "query($cp:UInt53!){checkpoint(sequenceNumber:$cp){sequenceNumber timestamp digest}}",
      { cp: height },
      z.object({ checkpoint }),
      signal,
    );
    if (data.checkpoint.sequenceNumber !== height) throw new Error("Checkpoint identity mismatch.");
    return data.checkpoint;
  }

  async firstAtOrAfter(
    time: number,
    first: ChainCheckpoint,
    last: ChainCheckpoint,
    signal?: AbortSignal,
  ): Promise<number> {
    if (time <= Date.parse(first.timestamp)) return first.sequenceNumber;
    if (time > Date.parse(last.timestamp)) return last.sequenceNumber + 1;
    let lower = first,
      upper = last;
    while (upper.sequenceNumber - lower.sequenceNumber > 1) {
      const span = upper.sequenceNumber - lower.sequenceNumber;
      const fraction =
        (time - Date.parse(lower.timestamp)) / (Date.parse(upper.timestamp) - Date.parse(lower.timestamp));
      const step = Math.max(1, Math.min(span - 1, Math.floor(span * fraction)));
      const candidate = await this.checkpoint(lower.sequenceNumber + step, signal);
      if (Date.parse(candidate.timestamp) < time) lower = candidate;
      else upper = candidate;
    }
    return upper.sequenceNumber;
  }

  async lastPoolUse(poolId: string, from: number, until: number, signal: AbortSignal) {
    const result = await this.archivePage(
      "poolTransactions", from, until, {
        parameters: "$filter:TransactionFilter!",
        selection: "transactions(last:1,filter:$filter){nodes{effects{checkpoint{sequenceNumber timestamp digest}}}}",
        variables: { filter: { affectedObject: poolId, ...(from ? { afterCheckpoint: from - 1 } : {}), beforeCheckpoint: until } },
        schema: z.object({ transactions: z.object({ nodes: z.array(z.object({ effects: z.object({ checkpoint }) })).max(1) }) }),
      },
      signal,
    );
    if (!result) throw archiveCoverageError();
    const cp = result.transactions.nodes[0]?.effects.checkpoint;
    if (cp && (cp.sequenceNumber < from || cp.sequenceNumber >= until))
      throw new Error("Pool transaction outside query.");
    return cp;
  }

  private async typedFillPage(
    from: number,
    until: number,
    size: number,
    before: string | null,
    signal: AbortSignal,
  ): Promise<FillPage | undefined> {
    const filter = { type: ORDER_FILLED, ...(from ? { afterCheckpoint: from - 1 } : {}), beforeCheckpoint: until };
    const page = await this.archivePage(
      "typedEvents", from, until, {
        parameters: "$filter:EventFilter!,$size:Int!,$before:String",
        selection: `events(filter:$filter,last:$size,before:$before){nodes{${eventSelection} transaction{digest effects{checkpoint{sequenceNumber timestamp digest}}}}
      pageInfo{hasNextPage:hasPreviousPage endCursor:startCursor}}`,
        variables: { filter, size, before },
        schema: z.object({ events: eventsPage }),
      }, signal,
    );
    if (!page) return undefined;
    const { events } = page;
    for (const e of events.nodes) {
      const cp = e.transaction.effects.checkpoint.sequenceNumber;
      if (e.contents.type.repr !== ORDER_FILLED || cp < from || cp >= until)
        throw new Error("Event outside the requested fill stream.");
    }
    return events;
  }

  async *poolFillPages(
    poolId: string,
    from: number,
    until: number,
    size: number,
    signal: AbortSignal,
    typedIndexAvailable = false,
  ): AsyncGenerator<FillPage> {
    const eventRows = z.object({ nodes: z.array(moveEvent.pick({ sequenceNumber: true, contents: true })), pageInfo });
    const transactions = z.object({
      nodes: z.array(
        z.object({
          digest: suiTransactionDigestSchema,
          effects: z.object({ checkpoint, events: eventRows }),
        }),
      ),
      pageInfo,
    });
    const eventFields = `nodes{${eventSelection}} pageInfo{hasNextPage endCursor}`;
    const filter = { affectedObject: poolId, ...(from ? { afterCheckpoint: from - 1 } : {}), beforeCheckpoint: until };
    const cursors = new Set<string>();
    let before: string | null = null;
    for (;;) {
      const result: { transactions: z.infer<typeof transactions> } | undefined = await this.archivePage(
        "poolTransactions", from, until, {
          parameters: "$filter:TransactionFilter!,$size:Int!,$before:String",
          selection: `transactions(filter:$filter,last:$size,before:$before){
          nodes{digest effects{checkpoint{sequenceNumber timestamp digest} events(first:$size){${eventFields}}}}
          pageInfo{hasNextPage:hasPreviousPage endCursor:startCursor}}`,
          variables: { filter, size, before },
          schema: z.object({ transactions }),
        }, signal,
      );
      if (before === null && typedIndexAvailable && (!result || result.transactions.pageInfo.hasNextPage)) {
        // Prefer a covered stream. When both cover the interval, retain the
        // first page that reaches further back, including its rows and cursor.
        let typed: FillPage | undefined;
        try {
          typed = await this.typedFillPage(from, until, size, null, signal);
        } catch (error) {
          signal.throwIfAborted();
          const timeout = error instanceof DOMException && error.name === "TimeoutError";
          if (!result || !(error instanceof ArchiveQueryUnavailable || timeout)) throw error;
        }
        const oldestFill = typed?.nodes[0]?.transaction.effects.checkpoint.sequenceNumber;
        const oldestTx = result?.transactions.nodes[0]?.effects.checkpoint.sequenceNumber;
        if (typed && (
          !result || !typed.pageInfo.hasNextPage ||
          (oldestFill !== undefined && oldestTx !== undefined && oldestFill <= oldestTx)
        )) {
          for (;;) {
            yield typed;
            if (!typed.pageInfo.hasNextPage) return;
            const cursor = typed.pageInfo.endCursor;
            if (!cursor || !typed.nodes.length || cursors.has(cursor))
              throw new Error("Fill cursor failed to advance.");
            cursors.add(cursor);
            typed = await this.typedFillPage(from, until, size, cursor, signal);
            if (!typed) throw archiveCoverageError();
          }
        }
      }
      if (!result) throw archiveCoverageError();
      const nodes: ChainEvent[] = [];
      for (const tx of result.transactions.nodes) {
        const cp = tx.effects.checkpoint;
        if (cp.sequenceNumber < from || cp.sequenceNumber >= until)
          throw new Error("Pool transaction outside requested checkpoints.");
        // These pages belong to the immutable events of a single digest.
        let events = tx.effects.events;
        const pages = new Set<string>();
        for (;;) {
          for (const event of events.nodes)
            if (event.contents.type.repr === ORDER_FILLED) {
              nodes.push({ ...event, transaction: { digest: tx.digest, effects: { checkpoint: cp } } });
            }
          if (!events.pageInfo.hasNextPage) break;
          const after = events.pageInfo.endCursor;
          if (!after || pages.has(after) || !events.nodes.length)
            throw new Error("Pool event cursor failed to advance.");
          pages.add(after);
          const next = await this.query(
            `query($digest:String!,$size:Int!,$after:String!){chainIdentifier transaction(digest:$digest){
            digest effects{events(first:$size,after:$after){${eventFields}}}}}`,
            { digest: tx.digest, size, after },
            z.object({
              chainIdentifier: z.literal(SUI_MAINNET_CHAIN_IDENTIFIER),
              transaction: z.object({ digest: z.literal(tx.digest), effects: z.object({ events: eventRows }) }),
            }),
            signal,
          );
          events = next.transaction.effects.events;
          if (!events.nodes.length) throw new Error("Missing continued transaction events.");
        }
      }
      yield { nodes, pageInfo: result.transactions.pageInfo };
      if (!result.transactions.pageInfo.hasNextPage) break;
      before = result.transactions.pageInfo.endCursor;
      if (!before || !result.transactions.nodes.length || cursors.has(before))
        throw new Error("Pool transaction cursor failed to advance.");
      cursors.add(before);
    }
  }

  async transactionOrder(cp: ChainCheckpoint, size: number, signal?: AbortSignal) {
    const order = new Map<string, number>(),
      cursors = new Set<string>();
    const orderPage = z.object({ nodes: z.array(z.object({ digest: suiTransactionDigestSchema })), pageInfo });
    const schema = z.object({ checkpoint: z.object({ digest: z.literal(cp.digest), transactions: orderPage }) });
    let after: string | null = null;
    for (;;) {
      const result = await this.archivePage(
        "checkpointOrder", cp.sequenceNumber, cp.sequenceNumber + 1, {
          parameters: "$cp:UInt53!,$after:String,$size:Int!",
          selection: `checkpoint(sequenceNumber:$cp){
            digest transactions(first:$size,after:$after){nodes{digest} pageInfo{hasNextPage endCursor}}}`,
          variables: { cp: cp.sequenceNumber, after, size },
          schema,
        }, signal,
      );
      if (!result) throw archiveCoverageError();
      const page: z.infer<typeof orderPage> = result.checkpoint.transactions;
      for (const tx of page.nodes) {
        if (order.has(tx.digest)) throw new Error("Duplicated transaction in checkpoint order.");
        order.set(tx.digest, order.size);
      }
      if (!page.pageInfo.hasNextPage) return order;
      after = page.pageInfo.endCursor;
      if (!after || !page.nodes.length || cursors.has(after)) throw new Error("Checkpoint pagination did not advance.");
      cursors.add(after);
    }
  }
}

export type RawFill = {
  poolId: string;
  price: string;
  base: string;
  quote: string;
  checkpoint: Omit<ChainCheckpoint, "digest"> & { digest?: string };
  digest: string;
  sequence: number;
  position?: number;
};
export function readFill(event: ChainEvent): RawFill {
  if (event.contents.type.repr !== ORDER_FILLED) throw new Error("Unexpected DeepBook fill type.");
  const body = fillBody.parse(event.contents.json);
  return {
    poolId: body.pool_id,
    price: body.price,
    base: body.base_quantity,
    quote: body.quote_quantity,
    checkpoint: event.transaction.effects.checkpoint,
    digest: event.transaction.digest,
    sequence: event.sequenceNumber,
  };
}
export type RawCandle = {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  fills: number;
};
function decimal(raw: string, decimals: number): string {
  if (decimals <= 0) return (BigInt(raw) * 10n ** BigInt(-decimals)).toString();
  const digits = BigInt(raw)
    .toString()
    .padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? "." + fraction : "");
}

export function renderCandles(
  bars: readonly RawCandle[],
  interval: DeepbookCandleInterval,
  baseDecimals: number,
  quoteDecimals: number,
): DeepbookTradeCandle[] {
  const price = (raw: string) => decimal(raw, 9 + quoteDecimals - baseDecimals);
  const width = deepbookCandleIntervalDurationMs(interval);
  return bars.map((bar, index) => {
    if (bar.start !== candleBucketStart(bar.start, interval) || (index > 0 && bar.start <= bars[index - 1]!.start)) {
      throw new Error("Invalid UTC candle ordering.");
    }
    return {
      timestampMs: bar.start,
      start: new Date(bar.start).toISOString(),
      end: new Date(bar.start + width).toISOString(),
      open: price(bar.open),
      high: price(bar.high),
      low: price(bar.low),
      close: price(bar.close),
      volume: decimal(bar.volume, baseDecimals),
    };
  });
}

// Only finalized chain records selected by this pool object and the defining
// event type enter the stream. A multi-pool transaction still needs a per-event ID check.
export async function* grpcPoolFills(
  rpc: SuiGrpcClient,
  poolId: string,
  from: number,
  until: number,
  owner: AbortSignal,
): AsyncGenerator<RawFill> {
  const stream = new AbortController();
  const abort = AbortSignal.any([owner, stream.signal]);
  const literals: GrpcTypes.TransactionLiteral[] = [
    { negated: false, predicate: { oneofKind: "affectedObject", affectedObject: { objectId: poolId } } },
    { negated: false, predicate: { oneofKind: "eventType", eventType: { eventType: ORDER_FILLED } } },
  ];
  let before: Uint8Array | undefined;
  let retried = false;
  try {
    for (;;) {
      const call = rpc.ledgerService.listTransactions(
        {
          startCheckpoint: BigInt(from),
          endCheckpoint: BigInt(until),
          filter: { terms: [{ literals }] },
          readMask: {
            paths: [
              "digest",
              "checkpoint",
              "transaction_index",
              "timestamp",
              "events.events.event_type",
              "events.events.json",
            ],
          },
          // The Foundation node caps a stream at 500 matching transactions.
          // A smaller operator limit still resumes at its terminal watermark.
          options: { limit: 500, ordering: GrpcTypes.Ordering.DESCENDING, ...(before ? { before } : {}) },
        },
        { abort, timeout: DEFAULT_DEEPBOOK_CANDLE_FETCH_TIMEOUT_MS },
      );
      let end: GrpcTypes.QueryEndReason | undefined;
      let cursor: Uint8Array | undefined, covered: bigint | undefined;
      try {
        for await (const frame of call.responses) {
          if (end !== undefined || !frame.watermark?.cursor?.length)
            throw new Error("Invalid ledger stream watermark.");
          end = frame.end?.reason;
          cursor = frame.watermark.cursor;
          covered = frame.watermark.checkpoint;
          const tx = frame.transaction;
          if (!tx) continue;
          if (
            tx.checkpoint === undefined ||
            tx.checkpoint < BigInt(from) ||
            tx.checkpoint >= BigInt(until) ||
            tx.transactionIndex === undefined ||
            !tx.timestamp ||
            !tx.digest ||
            !tx.events
          )
            throw new Error("Incomplete ledger transaction.");
          const position = sequence.parse(Number(tx.transactionIndex));
          const digest = suiTransactionDigestSchema.parse(tx.digest);
          const timestamp = new Date(
            Number(tx.timestamp.seconds) * 1000 + Math.floor(tx.timestamp.nanos / 1_000_000),
          ).toISOString();
          for (let index = tx.events.events.length - 1; index >= 0; index--) {
            const event = tx.events.events[index]!;
            if (!event.eventType) throw new Error("Missing ledger event type.");
            if (event.eventType !== ORDER_FILLED) continue;
            const value = event.json?.kind;
            if (value?.oneofKind !== "structValue") throw new Error("Missing ledger fill.");
            const fields = value.structValue.fields;
            const read = (key: string) => {
              const v = fields[key]?.kind;
              return v?.oneofKind === "stringValue" ? v.stringValue : undefined;
            };
            const id = objectId.parse(read("pool_id"));
            if (id !== poolId) continue;
            yield {
              poolId: id,
              price: uint.parse(read("price")),
              base: uint.parse(read("base_quantity")),
              quote: uint.parse(read("quote_quantity")),
              checkpoint: { sequenceNumber: Number(tx.checkpoint), timestamp },
              digest,
              sequence: index,
              position,
            };
          }
        }
      } catch (error) {
        abort.throwIfAborted();
        if (!(
          error instanceof Error &&
          "code" in error &&
          ["UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(String(error.code))
        ))
          throw error;
        const progressed = cursor && (!before || !Buffer.from(before).equals(cursor));
        if (!progressed && retried) throw error;
        before = cursor ?? before;
        retried = !progressed;
        continue;
      }
      if (end === GrpcTypes.QueryEndReason.CHECKPOINT_BOUND && covered === BigInt(from)) return;
      if (
        !(end === GrpcTypes.QueryEndReason.ITEM_LIMIT || end === GrpcTypes.QueryEndReason.SCAN_LIMIT) ||
        !cursor ||
        (before && Buffer.from(before).equals(cursor))
      )
        throw new Error("Ledger stream did not establish continuous coverage.");
      before = cursor;
      retried = false;
    }
  } finally {
    stream.abort();
  }
}

export async function* historicalPoolFills(
  reader: MarketGraphqlReader,
  poolId: string,
  from: number,
  until: number,
  size: number,
  signal: AbortSignal,
  typedIndexAvailable = false,
) {
  for await (const page of reader.poolFillPages(poolId, from, until, size, signal, typedIndexAvailable)) {
    for (const event of page.nodes.reverse()) {
      const fill = readFill(event);
      if (fill.poolId === poolId) yield fill;
    }
  }
}

// Page and transport boundaries can split a UTC bucket. Complete that bucket
// before emitting it, retaining only its extrema, volume and boundary transactions.
type SegmentBoundary = { bar: RawCandle; newestTime: string; oldestTime: string };

export async function* scanPoolBars(
  reader: MarketGraphqlReader,
  source: AsyncIterable<RawFill>,
  from: number,
  until: number,
  size: number,
  signal: AbortSignal,
  interval: DeepbookCandleInterval,
  boundary?: (edge: SegmentBoundary) => void,
): AsyncGenerator<RawCandle> {
  let height = until;
  let current: RawFill["checkpoint"] | undefined;
  let newestTime: string | undefined;
  const fills = new Map<string, RawFill>();
  let bar: RawCandle | undefined;
  let earliest: RawFill[] = [],
    latest: RawFill[] = [];

  function consumeCheckpoint() {
    if (!fills.size) return;
    const rows = Array.from(fills.values());
    earliest = rows;
    if (!bar) latest = rows;
    for (const fill of rows) {
      const start = candleBucketStart(Date.parse(fill.checkpoint.timestamp), interval);
      if (!bar)
        bar = { start, open: fill.price, close: fill.price, high: fill.price, low: fill.price, volume: "0", fills: 0 };
      if (BigInt(fill.price) > BigInt(bar.high)) bar.high = fill.price;
      if (BigInt(fill.price) < BigInt(bar.low)) bar.low = fill.price;
      bar.volume = (BigInt(bar.volume) + BigInt(fill.base)).toString();
      bar.fills++;
    }
    fills.clear();
  }
  async function completeBucket(raw: RawCandle): Promise<RawCandle> {
    const order = async (rows: RawFill[]) => {
      const first = rows[0]!;
      if (rows.every((row) => row.price === first.price)) return { first: first.price, last: first.price };
      const nativePositions = rows.every((row) => row.position !== undefined);
      const positions =
        !nativePositions && rows.some((row) => row.digest !== first.digest)
          ? await reader.transactionOrder(checkpoint.parse(first.checkpoint), size, signal)
          : undefined;
      if (positions && rows.some((row) => !positions.has(row.digest))) throw new Error("Fill missing from checkpoint.");
      const sorted = rows.toSorted(
        (a, b) =>
          (nativePositions
            ? a.position! - b.position!
            : positions
              ? positions.get(a.digest)! - positions.get(b.digest)!
              : 0) || a.sequence - b.sequence,
      );
      return { first: sorted[0]!.price, last: sorted.at(-1)!.price };
    };
    const open = await order(earliest);
    const close = earliest === latest ? open : await order(latest);
    return { ...raw, open: open.first, close: close.last };
  }
  for await (const fill of source) {
    const cp = fill.checkpoint;
    newestTime ??= cp.timestamp;
    if (
      cp.sequenceNumber < from ||
      cp.sequenceNumber >= until ||
      cp.sequenceNumber > height ||
      (current &&
        (Date.parse(cp.timestamp) > Date.parse(current.timestamp) ||
          (cp.sequenceNumber === height &&
            (cp.digest !== current.digest || Date.parse(cp.timestamp) !== Date.parse(current.timestamp)))))
    ) {
      throw new Error(
        `Checkpoint ${cp.sequenceNumber} (${cp.timestamp}) conflicts with the next checkpoint ${height} (${current?.timestamp}).`,
      );
    }
    if (cp.sequenceNumber !== height) {
      consumeCheckpoint();
      if (bar && candleBucketStart(Date.parse(cp.timestamp), interval) < bar.start) {
        yield await completeBucket(bar);
        bar = undefined;
      }
    }
    height = cp.sequenceNumber;
    current = cp;
    const key = fill.digest + "/" + fill.sequence;
    const prior = fills.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(fill)) throw new Error("Conflicting duplicate Sui event.");
    fills.set(key, fill);
  }
  consumeCheckpoint();
  if (bar) {
    const tail = await completeBucket(bar);
    if (boundary) boundary({bar: tail, newestTime: newestTime!, oldestTime: current!.timestamp});
    else yield tail;
  }
}

// Each checkpoint belongs to one reader. Only the oldest bucket of the newer
// segment can continue into the older one. Keep it private until both sides
// have established coverage and transaction order.
export async function* scanSplitPoolBars(
  reader: MarketGraphqlReader,
  fills: (from: number, until: number, signal: AbortSignal) => AsyncIterable<RawFill>,
  from: number, until: number, size: number, owner: AbortSignal,
  interval: DeepbookCandleInterval, indexedAt: number,
): AsyncGenerator<RawCandle> {
  const mid = from + Math.floor((until - from) / 2);
  const controller = new AbortController();
  const signal = AbortSignal.any([owner, controller.signal]);
  let newerEdge: SegmentBoundary | undefined, olderEdge: SegmentBoundary | undefined;
  let olderJob: Promise<void> | undefined;
  const older: RawCandle[] = [];
  const startOlder = () => {
    olderJob ??= (async () => {
      for await (const bar of scanPoolBars(reader, fills(from, mid, signal), from, mid, size, signal, interval, edge => { olderEdge = edge; })) {
        older.push(bar);
      }
      if (olderEdge) older.push(olderEdge.bar);
    })().catch(error => { controller.abort(error); });
    return olderJob;
  };
  try {
    for await (const bar of scanPoolBars(reader, fills(mid, until, signal), mid, until, size, signal, interval, edge => { newerEdge = edge; })) {
      yield bar;
      // Give the first closed candle the full connection before overlapping
      // the remaining work. An empty newer segment still starts the older one.
      if (bar.start + deepbookCandleIntervalDurationMs(interval) <= indexedAt + 1) startOlder();
    }
    await startOlder();
    signal.throwIfAborted();
    const adjacent = older[0];
    if (newerEdge) {
      if (olderEdge && Date.parse(olderEdge.newestTime) > Date.parse(newerEdge.oldestTime))
        throw new Error("Checkpoint times conflict across the split.");
      const recent = newerEdge.bar;
      if (adjacent?.start === recent.start) {
        older[0] = { start: recent.start, open: adjacent.open, close: recent.close,
          high: BigInt(adjacent.high) > BigInt(recent.high) ? adjacent.high : recent.high,
          low: BigInt(adjacent.low) < BigInt(recent.low) ? adjacent.low : recent.low,
          volume: String(BigInt(adjacent.volume) + BigInt(recent.volume)), fills: adjacent.fills + recent.fills };
      } else yield recent;
    }
    yield* older;
  } finally {
    controller.abort();
    await olderJob;
  }
}
