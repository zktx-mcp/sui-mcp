import { chartMarketBindingSchema } from "../../core/read/chartMarketBinding.js";
import { z } from "zod";
import { createChart, CandlestickSeries, HistogramSeries, type CandlestickData, type HistogramData, type UTCTimestamp, type WhitespaceData } from "lightweight-charts";
import { element, link, button, input, select, field, accordion, row, timeValue } from "../../../review-app/src/ui/ui.js";
import { formatUtc } from "../../../review-app/src/format.js";
import { t } from "../../../review-app/src/i18n/i18n.js";
import type { CardRenderer } from "./lifecycle.js";
import type { DeepbookUsdcChartCandlesResponse } from "../../core/read/deepbookUsdcChartService.js";

// These descriptions follow the source's explicit reason codes. Unknown
// messages stay diagnostic text; the View does not infer their cause.
const chartFailureLabels: Record<Extract<DeepbookUsdcChartCandlesResponse, { reason: string }>["reason"], string> = {
  candle_coverage_incomplete: "The archive could not verify this period. Trade activity is unknown.",
  source_unavailable: "Chart data is unavailable right now.",
  pool_list_incomplete: "Some markets could not be identified.",
  source_timeout: "The chart data source did not respond in time.",
  source_http_error: "The chart data source returned an error.",
  invalid_indexer_candle_evidence: "The indexer returned chart data that could not be used.",
  invalid_chain_candle_evidence: "The chart data source returned information that could not be used.",
  ambiguous_pool_name: "The source returned multiple markets under this pool name.",
  missing_pool_name: "No trading pair was selected.",
  invalid_timestamp: "Choose a valid UTC time at or before the current time.",
  market_not_created: "This pool did not exist during the requested period.",
  selected_market_changed: "The market changed after you opened this card. Choose the current pair on a new chart.",
  limit_exceeds_chart_cap: "This chart request exceeds the candle limit.",
  pool_not_in_mainnet_usdc_markets: "This trading pair is not available in the supported USDC charts."
};

const candleSchema = z.object({ start: z.string(), end: z.string().optional(), timestampMs: z.number().int(),
  open: z.string(), high: z.string(), low: z.string(), close: z.string(), volume: z.string() });
type ChartCandle = z.infer<typeof candleSchema>;
export const DEEPBOOK_USDC_CHART_SHORTCUTS = ["Recent", "Last 24h", "Last 7d", "Last 30d"] as const;
export type DeepbookUsdcChartShortcut = (typeof DEEPBOOK_USDC_CHART_SHORTCUTS)[number];
const marketReadFailureLabels = {
  coin_metadata_unavailable: "Coin metadata unavailable",
  pool_identity_mismatch: "Market identity mismatch",
  pool_object_unavailable: "Pool object unavailable"
} as const;
const marketReason = z.enum(["coin_metadata_unavailable", "pool_identity_mismatch", "pool_object_unavailable"]).optional();
const poolsSchema = z.object({ status: z.literal("ok"), unavailablePools: z.array(z.object({poolId:z.string(), poolName:z.string().optional(), unavailableReason:marketReason})).optional(), pools: z.array(z.object({ poolId: z.string(), poolName: z.string(), catalogEndpoint: z.enum(["get_pools", "pool_registry"]).optional(),
  baseAsset: z.object({ symbol: z.string() }) })), intervals: z.array(z.string()), defaultInterval: z.string(), defaultLimit: z.number().int().positive(), maxCandles: z.number().int().positive() });
export const chartResultSchema = z.object({ status: z.enum(["ok", "empty_result", "preview", "partial_coverage"]), candles: z.array(candleSchema), candleCount: z.number().int().nonnegative(),
  query: z.object({ poolName: z.string(), interval: z.string(),
    startTimeMs: z.number().int().nonnegative().optional(), endTimeMs: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive() }), source: z.object({ endpoint: z.enum(["order_fills", "ohclv"]), poolId: z.string().optional(), poolName: z.string().optional(), catalogPoolId: z.string().optional(), fetchedAt: z.string(), requestedAt: z.iso.datetime().optional(), startTimeMs: z.number().int().optional(), endTimeMs: z.number().int().optional(), coveredUntil: z.iso.datetime().optional(), indexedAt: z.iso.datetime().optional(), indexedCheckpoint: z.number().optional() }),
  pair: z.object({ poolId: z.string(), poolName: z.string().optional(), baseAsset: z.object({ symbol: z.string() }), quoteAsset: z.object({ symbol: z.literal("USDC") }) }) })
  .refine(value => value.status !== "partial_coverage" || value.source.coveredUntil !== undefined, "Partial coverage requires an indexed cutoff.")
  .refine(value => value.status !== "preview" || value.candleCount > 0, "A chart preview needs closed candles.")
  .refine(value => chartMarketBindingSchema.safeParse(value).success, "Market identity mismatch.")
  .refine((value) => value.candleCount === value.candles.length, "Candle count differs from returned rows.");

export const chartRenderer = {
  title: "DeepBook USDC chart",
  guidance: (snapshot, context) => context.recoveryNeeded && snapshot?.state !== "running"
    ? "Ask in chat for a new chart with the pair and time range you want." : undefined,
  controls(snapshot, submit) {
    const choices = poolsSchema.parse(snapshot.data);
    const form = document.createElement("form"); form.className = "ui-form";
    const pool = select({ choices: [{ label: "Choose a pair", value: "" }, ...choices.pools.map((item) => ({
      label: `${item.baseAsset.symbol} / USDC${item.catalogEndpoint === "pool_registry" ? " · Onchain" : ""}`, value: item.poolId
    }))] }); pool.required = true;
    const interval = select({ choices: choices.intervals.map((value) => ({ label: value, value })) });
    interval.value = typeof snapshot.input.interval === "string" ? snapshot.input.interval : choices.defaultInterval;
    const start = input({ placeholder: "YYYY-MM-DDTHH:mm or epoch ms" });
    const end = input({ placeholder: "YYYY-MM-DDTHH:mm or epoch ms" });
    let exactStart = typeof snapshot.input.startTimeMs === "number" ? snapshot.input.startTimeMs : undefined;
    let exactEnd = typeof snapshot.input.endTimeMs === "number" ? snapshot.input.endTimeMs : undefined;
    let latestIndexed = snapshot.input.endMode === "latest_indexed";
    let candleLimit = Number(snapshot.input.limit ?? choices.defaultLimit);
    const options = accordion("Time range & interval", exactStart !== undefined || exactEnd !== undefined);
    const rangeLabel = element("p", "ui-note", exactStart === undefined && exactEnd === undefined
      ? "Recent 7 days · UTC" : chartQueryText({ startTimeMs: exactStart, endTimeMs: exactEnd }));
    function displayRange() {
      start.value = exactStart === undefined ? "" : utcMsToInputValue(exactStart);
      end.value = exactEnd === undefined ? "" : utcMsToInputValue(exactEnd);
    }
    displayRange();
    start.addEventListener("input", () => {
      exactStart = undefined;
      rangeLabel.textContent = "Custom range · UTC";
    });
    end.addEventListener("input", () => {
      exactEnd = undefined;
      latestIndexed = false;
      rangeLabel.textContent = "Custom range · UTC";
    });
    const ranges = element("div", "card-actions");
    for (const shortcut of DEEPBOOK_USDC_CHART_SHORTCUTS) {
      const control = button(shortcut, () => {
        const range = shortcutQuery(shortcut, new Date());
        exactStart = range.startTimeMs;
        exactEnd = range.endTimeMs;
        candleLimit = range.limit;
        latestIndexed = exactEnd !== undefined;
        displayRange();
        rangeLabel.textContent = shortcut === "Recent" ? "Recent 7 days · UTC" : `${shortcut} · UTC`;
        submitSelection();
      }, "secondary");
      ranges.append(control);
    }
    const error = element("p", "ui-error"); error.setAttribute("role", "alert");
    options.body.append(field("Candle interval", interval), ranges, rangeLabel, field("Start (UTC)", start), field("End (UTC)", end));
    form.append(element("p", "ui-note", "Set the time range and interval before choosing a pair, if needed."),
      field("Choose a pair to open the chart", pool), options.details, error);
    for (const market of choices.unavailablePools ?? []) {
      form.append(row(market.unavailableReason ? marketReadFailureLabels[market.unavailableReason] : "Unavailable market", [market.poolName, market.poolId].filter(Boolean).join(" · ")));
    }
    function submitSelection(): void {
      if (!pool.value) return;
      try {
        const startTimeMs = exactStart ?? parseUtcInputToMs(start.value);
        const endTimeMs = exactEnd ?? parseUtcInputToMs(end.value);
        if (startTimeMs !== undefined && endTimeMs !== undefined && startTimeMs >= endTimeMs) throw new Error("Start must precede end.");
        submit({ ...(latestIndexed ? {endMode:"latest_indexed"} : {}), poolId: pool.value, interval: interval.value, limit: candleLimit,
          ...(startTimeMs === undefined ? {} : { startTimeMs }), ...(endTimeMs === undefined ? {} : { endTimeMs }) });
      } catch (issue) { error.textContent = issue instanceof Error ? issue.message : "Invalid chart input."; }
    }
    form.addEventListener("submit", (event) => { event.preventDefault(); submitSelection(); });
    for (const control of [pool, interval, start, end]) control.addEventListener("change", submitSelection);
    return { node: form, statusText: () => "Choose a trading pair.", selectionRecovery: { label: "Retry chart", retry: submitSelection } };
  },
  result(snapshot, _display?, _act?, _wallet?, context?) {
    const outcome = snapshot.data as { status?: string; reason?: string } | undefined;
    const marketFailure = outcome?.status === "source_unavailable" || outcome?.status === "unsupported_pool";
    if (snapshot.state === "running" && outcome?.status !== "preview" && !marketFailure) {
      const { poolName, poolId, interval, startTimeMs, endTimeMs } = snapshot.input;
      const node = element("div");
      node.append(element("p", "ui-note", [poolName ?? poolId, interval].filter(Boolean).join(" · ")));
      const range = {startTimeMs: typeof startTimeMs === "number" ? startTimeMs : undefined,
        endTimeMs: typeof endTimeMs === "number" ? endTimeMs : undefined};
      const period = range.startTimeMs === undefined ? range.endTimeMs === undefined
        ? "Last 7 days · UTC" : `Seven days ending ${formatUtc(range.endTimeMs)}` : chartQueryText(range);
      node.append(element("p", "ui-note", period), element("div", "chart-status-slot"));
      return { node };
    }
    const parsed = chartResultSchema.safeParse(snapshot.data);
    if (!parsed.success) {
      const data = snapshot.data as { status?: unknown; reason?: unknown } | undefined;
      if (data?.status === "source_unavailable" || data?.status === "unsupported_input" || data?.status === "unsupported_pool" || data?.status === "over_limit") {
        const reason = typeof data.reason === "string" ? data.reason : data.status;
        const message = Object.hasOwn(chartFailureLabels, reason as string)
          ? chartFailureLabels[reason as keyof typeof chartFailureLabels] : "The requested chart could not be loaded.";
        const node = element("div");
        node.append(element("p", "ui-note", message), element("p", "ui-note", "Ask in chat for a new chart with the pair and time range you want."));
        const details = accordion("Details");
        const candidates = z.object({candidates:z.array(z.object({poolId:z.string(),baseCoinType:z.string(),quoteCoinType:z.string(),unavailableReason:marketReason}))}).safeParse(snapshot.data);
        if (candidates.success) for (const market of candidates.data.candidates) {
          details.body.append(row(market.poolId, [market.baseCoinType + " / " + market.quoteCoinType,
            market.unavailableReason && marketReadFailureLabels[market.unavailableReason]].filter(Boolean).join(" · ")));
        }
        details.body.append(element("p", undefined, `Reported reason: ${reason}`)); node.append(details.details);
        return { node, statusText: () => "" };
      }
      throw new Error("The saved chart does not contain verified pool-bound candles. Open a new chart.");
    }
    let data = parsed.data;
    const range = data.status === "preview" ? data.query : {
      startTimeMs: data.query.startTimeMs ?? data.source.startTimeMs,
      endTimeMs: data.query.endTimeMs ?? data.source.endTimeMs
    };
    const node = element("div");
    node.append(
      element("p", "ui-note", `${data.pair.baseAsset.symbol} / USDC · ${data.query.interval}`),
      element("p", "ui-note", chartQueryText(range))
    );
    const detail = accordion("Details");
    const checked = element("p", "ui-note", `${t.common.retrievedAt}: `); checked.append(timeValue(data.source.fetchedAt)); detail.body.append(checked);
    detail.body.append(row(data.source.endpoint === "ohclv" ? "Catalog pool ID" : "Pool ID", data.pair.poolId));
    if (data.source.indexedAt) detail.body.append(row("Indexed through",timeValue(data.source.indexedAt)));
    if (data.source.coveredUntil) detail.body.append(row("Coverage through", timeValue(data.source.coveredUntil)));
    const exactTime = (value: number | undefined) => value === undefined ? "not specified" :
      new Date(value).toJSON() ?? formatUtc(value);
    detail.body.append(element("p", undefined,
      `Start: ${exactTime(range.startTimeMs)} · End: ${exactTime(range.endTimeMs)}`));
    if (data.status === "partial_coverage") node.append(element("p", "ui-note", data.source.indexedAt
      ? `Data verified through ${data.source.indexedAt}.`
      : `Data verified before ${data.source.coveredUntil!}.`));
    if (data.status !== "preview" && data.candleCount >= data.query.limit) node.append(element("p", "ui-note", `This view is limited to ${data.query.limit} candles; the requested period may contain more.`));
    const boundary = element("p", "ui-note", `${t.chart.boundaryUsdc} ${t.chart.boundaryScope} ${data.source.endpoint === "ohclv" ? "Source: DeepBook Indexer." : t.chart.source}`);
    const attribution = link(t.chart.library, "https://www.tradingview.com/");
    attribution.target = "_blank"; attribution.rel = "noopener noreferrer";
    boundary.append(` ${t.chart.renderedWith} `, attribution, ".");
    if (data.candles.length === 0) { detail.body.append(boundary); node.append(detail.details); return {
      node, statusText: () => data.status === "partial_coverage" ? "No trades in the verified portion." : data.source.endpoint === "ohclv" ? "No candles returned for this period." : "No trades in the selected period."
    }; }
    const container = element("div", "card-chart"); const legend = element("p", "ui-note");
    const last = data.candles.at(-1)!;
    const describe = (candle: ChartCandle) => `${formatUtc(candle.start)} · Open ${candle.open} · High ${candle.high} · Low ${candle.low} · Close ${candle.close} · Volume ${candle.volume}`;
    const preview = data.status === "preview";
    const readAt = Date.parse(data.source.requestedAt ?? data.source.fetchedAt);
    const openAtRetrieval = data.source.endpoint === "ohclv" && last.end !== undefined &&
      last.timestampMs <= readAt && readAt < Date.parse(last.end);
    const openAtCheckpoint = data.source.endpoint === "order_fills" && data.source.indexedAt &&
        data.source.coveredUntil && last.timestampMs <= Date.parse(data.source.indexedAt) &&
        Date.parse(data.source.indexedAt) + 1 === Date.parse(data.source.coveredUntil) &&
        last.end && Date.parse(last.end) > Date.parse(data.source.coveredUntil);
    if (openAtRetrieval || openAtCheckpoint) {
      node.append(element("p", "ui-note", "The latest candle was still forming at the recorded source time."));
    }
    legend.textContent = describe(last); detail.body.append(legend, boundary); node.append(container, detail.details);
    let chart: ReturnType<typeof createChart> | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let resizeFrame: number | undefined, drawnFrame: number | undefined;
    let mounted = false, disposed = false, drawn = false, drawFailed = false;
    let updateSeries: ((fit: boolean) => void) | undefined;
    let previousWidth = 0, previousHeight = 0;
    let automaticRedrawAvailable = true;
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      const color = (name: string) => style.getPropertyValue(name).trim();
      chart?.applyOptions({ layout: { background: { color: color("--ui-surface") }, textColor: color("--ui-text") },
        grid: { vertLines: { color: color("--ui-border") }, horzLines: { color: color("--ui-border") } } });
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true; resizeObserver?.disconnect(); themeObserver?.disconnect(); chart?.remove();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      if (drawnFrame !== undefined) cancelAnimationFrame(drawnFrame);
    };
    const resize = () => {
      if (disposed || !container.isConnected) return;
      const width = container.clientWidth, height = container.clientHeight;
      // A hidden or not-yet-laid-out frame must never set chart spacing to zero.
      // Keep the last positive size and viewport until the frame is visible.
      if (width <= 0 || height <= 0 || (width === previousWidth && height === previousHeight)) return;
      try {
        if (chart) chart.resize(width, height);
        else {
          // No pixel minimum: even the maximum candle count must fit the request.
          // Positive explicit dimensions make the resulting bar spacing positive.
          chart = createChart(container, { width, height, autoSize: false, layout: { attributionLogo: false },
            timeScale: { timeVisible: true, secondsVisible: false, minBarSpacing: 0, lockVisibleTimeRangeOnResize: true } });
          const series = chart.addSeries(CandlestickSeries, { upColor: "#167752", downColor: "#b44336", borderVisible: false,
            wickUpColor: "#167752", wickDownColor: "#b44336", priceFormat: { type: "price", precision: 6, minMove: 0.000001 } });
          const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" }, 1);
          const byTime = new Map<number, ChartCandle>();
          const timeScale = chart.timeScale();
          updateSeries = (fit) => {
            const display = chartSeriesData(data.candles, preview ? undefined : data.query);
            series.setData(display.prices); volume.setData(display.volumes);
            byTime.clear();
            for (const candle of data.candles) byTime.set(candleTime(candle), candle);
            if (display.range) timeScale.setVisibleRange(display.range);
            else if (fit) timeScale.fitContent();
          };
          updateSeries(true);
          chart.panes()[0]?.setStretchFactor(3); chart.panes()[1]?.setStretchFactor(1);
          chart.subscribeCrosshairMove((event) => { legend.textContent = describe((typeof event.time === "number" ? byTime.get(event.time) : undefined) ?? last); });
          theme();
          themeObserver = new MutationObserver(theme);
          themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        }
        previousWidth = width; previousHeight = height;
        if (!drawn && drawnFrame === undefined) {
          drawnFrame = requestAnimationFrame(() => {
            drawnFrame = undefined;
            if (!disposed && !drawFailed) { drawn = true; context?.onDisplayChange?.(); }
          });
        }
      } catch {
        drawFailed = true;
        if (drawnFrame !== undefined) { cancelAnimationFrame(drawnFrame); drawnFrame = undefined; }
        resizeObserver?.disconnect(); themeObserver?.disconnect(); chart?.remove(); chart = undefined;
        updateSeries = undefined; drawn = false; previousWidth = 0; previousHeight = 0;
        if (automaticRedrawAvailable) {
          automaticRedrawAvailable = false;
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = undefined;
            if (!disposed) retryDraw();
          });
        } else queueMicrotask(() => { if (!disposed) context?.onDisplayChange?.(); });
      }
    };
    const mount = () => {
      if (mounted || disposed) return;
      mounted = true;
      // Own sizing instead of autoSize so later zero-size notifications cannot
      // corrupt a valid chart. Resize preserves the user's current time range.
      resizeObserver = new ResizeObserver(() => {
        if (disposed || resizeFrame !== undefined) return;
        // Draw after the observer delivery phase, not while size notifications
        // are being delivered to the chart's descendant canvases.
        resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; resize(); });
      });
      resizeObserver.observe(container);
      resize();
    };
    function retryDraw() {
      drawFailed = false;
      mounted = false;
      mount();
    }
    const recovery = { message: "Couldn’t display the chart.", retry: retryDraw };
    return { node, mount, statusText: () => {
      if (!drawn) return "Drawing chart…";
      const count = `${data.candleCount} ${preview ? "verified closed " : ""}${data.candleCount === 1 ? "candle" : "candles"}`;
      return preview ? `Showing ${count}. Reading older trades…` : `Loaded ${count}.`;
    }, displayRecovery: () => drawFailed && resizeFrame === undefined ? recovery : undefined, update: (next) => {
      if (!preview || disposed || next.state !== "running" || (next.data as {status?: string} | undefined)?.status !== "preview") return false;
      const updated = chartResultSchema.parse(next.data);
      if (updated.status !== "preview" || updated.pair.poolId !== data.pair.poolId || updated.query.interval !== data.query.interval) return false;
      const visible = chart?.timeScale().getVisibleLogicalRange();
      const fit = !visible || (visible.from <= 0 && visible.to >= data.candleCount - 1);
      data = updated;
      updateSeries?.(fit);
      checked.replaceChildren(`${t.common.retrievedAt}: `, timeValue(data.source.fetchedAt));
      return true;
    }, dispose };
  }
} satisfies CardRenderer;

export function chartSeriesData(candles: ChartCandle[], query?: z.infer<typeof chartResultSchema>["query"]) {
  const prices: (CandlestickData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = candles.map(candleToCandlestickData);
  const volumes: (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = candles.map(candleToVolumeData);
  const times = new Set(prices.map((point) => point.time));
  // Lightweight Charts clamps visible ranges to known time points. Whitespace
  // anchors preserve requested boundaries without inventing prices or volume.
  // They are display-only; the saved source candles remain unchanged.
  for (const boundary of [query?.startTimeMs, query?.endTimeMs]) {
    if (boundary === undefined) continue;
    const time = boundary / 1000 as UTCTimestamp;
    if (!times.has(time)) { prices.push({ time }); volumes.push({ time }); times.add(time); }
  }
  prices.sort((a, b) => a.time - b.time); volumes.sort((a, b) => a.time - b.time);
  const from = query?.startTimeMs === undefined ? prices[0]?.time : query.startTimeMs / 1000 as UTCTimestamp;
  const to = query?.endTimeMs === undefined ? prices.at(-1)?.time : query.endTimeMs / 1000 as UTCTimestamp;
  const hasBoundary = query?.startTimeMs !== undefined || query?.endTimeMs !== undefined;
  return { prices, volumes, range: hasBoundary && from !== undefined && to !== undefined && from < to ? { from, to } : undefined };
}

export function chartQueryText(query: Pick<z.infer<typeof chartResultSchema>["query"], "startTimeMs" | "endTimeMs">): string {
  if (query.startTimeMs === undefined && query.endTimeMs === undefined) {
    return "Recent candles · UTC";
  }
  const utc = (timestamp: number | undefined) => timestamp === undefined ? "not specified" : formatUtc(timestamp);
  return `Range (UTC): ${utc(query.startTimeMs)} → ${utc(query.endTimeMs)}`;
}

export function shortcutQuery(
  shortcut: DeepbookUsdcChartShortcut,
  now: Date
): { startTimeMs?: number; endTimeMs?: number; limit: number } {
  if (shortcut === "Recent") {
    return { limit: 500 };
  }
  const durationMs =
    shortcut === "Last 24h"
      ? 24 * 60 * 60 * 1000
      : shortcut === "Last 7d"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  const end = now.getTime();
  const start = end - durationMs;
  return { startTimeMs: start, endTimeMs: end, limit: 10000 };
}

export function parseUtcInputToMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^(0|[1-9]\d*)$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (!Number.isSafeInteger(ms)) throw new Error("Epoch milliseconds must be a safe integer.");
    return ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    throw new Error("UTC timestamps must use YYYY-MM-DDTHH:mm or nonnegative epoch milliseconds.");
  }
  const ms = Date.parse(`${trimmed}:00.000Z`);
  if (!Number.isSafeInteger(ms) || ms < 0 || utcMsToInputValue(ms) !== trimmed) {
    throw new Error("UTC timestamp is invalid.");
  }
  return ms;
}

function utcMsToInputValue(ms: number): string {
  const iso = new Date(ms).toJSON();
  // Extended years and values beyond Date's range also round-trip through the editor.
  return iso && !iso.startsWith("+") ? iso.slice(0, 16) : String(ms);
}

export function candleToCandlestickData(candle: ChartCandle): CandlestickData<UTCTimestamp> {
  return {
    time: candleTime(candle) as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close)
  };
}

export function candleToVolumeData(candle: ChartCandle): HistogramData<UTCTimestamp> {
  return {
    time: candleTime(candle) as UTCTimestamp,
    value: Number(candle.volume),
    color: Number(candle.close) >= Number(candle.open) ? "rgba(22, 119, 82, 0.45)" : "rgba(180, 67, 54, 0.45)"
  };
}

function candleTime(candle: ChartCandle): number {
  return Math.floor(candle.timestampMs / 1000);
}
