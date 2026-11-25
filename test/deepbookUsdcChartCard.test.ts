import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { candleToCandlestickData, candleToVolumeData, chartQueryText, chartRenderer, chartResultSchema, chartSeriesData, parseUtcInputToMs, shortcutQuery } from "../src/mcp-ui/view/chart.js";
import { chartInputSchema } from "../src/core/read/readCardInputs.js";

const savedPoolId = "0x" + "1".repeat(64);

const chartApi = vi.hoisted(() => ({
  addSeries: vi.fn(() => ({ setData: vi.fn() })),
  create: vi.fn(), resize: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(), remove: vi.fn(),
  applyOptions: vi.fn(), subscribeCrosshairMove: vi.fn()
}));
vi.mock("lightweight-charts", () => ({ CandlestickSeries: "candlestick", HistogramSeries: "volume",
  createChart: (container: unknown, options: unknown) => {
    chartApi.create(container, options);
    return { ...chartApi, panes: () => [], timeScale: () => chartApi };
  }
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function prepareLayout() {
  let changed!: () => void;
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const flushFrame = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const resizeDisconnect = vi.fn(), themeDisconnect = vi.fn();
  const nodes: { className: string; isConnected: boolean; clientWidth: number; clientHeight: number; append: () => void; replaceChildren: () => void }[] = [];
  vi.stubGlobal("document", { createElement: () => {
    const node = { className: "", textContent: "", isConnected: false, clientWidth: 0, clientHeight: 0, append() {}, replaceChildren() {}, setAttribute() {} };
    nodes.push(node); return node;
  }, documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#333333" }));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { changed = callback; } observe() {} disconnect = resizeDisconnect; });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect = themeDisconnect; });
  const result = chartRenderer.result({ cardId: "saved-chart", kind: "chart", revision: 2, state: "closed", reason: "completed",
    createdAt: "2026-06-27T01:00:00.000Z", expiresAt: "2026-06-27T01:30:00.000Z", inputRemainingMs: 0, pollAfterMs: 5000, input: {},
    data: { status: "ok", query: { poolName: "SUI_USDC", interval: "15m", startTimeMs: 1782518400000, endTimeMs: 1782522000000, limit: 120 },
      candles: [{ timestampMs: 1782520200000, start: "2026-06-27T00:30:00.000Z", open: "1", high: "1", low: "1", close: "1", volume: "0" }],
      candleCount: 1, source: { endpoint: "order_fills", poolId: savedPoolId, fetchedAt: "2026-06-27T01:00:00.000Z" }, pair: { poolId: savedPoolId, baseAsset: { symbol: "SUI" }, quoteAsset: { symbol: "USDC" } } }
  });
  return { result, container: nodes.find((node) => node.className === "card-chart")!,
    resize: () => { changed(); flushFrame(); }, queueResize: () => changed(), flushFrame, frames, resizeDisconnect, themeDisconnect };
}

describe("DeepBook chart input and display", () => {
  it("retains the time shortcuts and rejects invalid windows without inventing candles", () => {
    expect(shortcutQuery("Recent", new Date("2026-06-27T03:00:00.000Z"))).toEqual({ limit: 500 });
    expect(shortcutQuery("Last 24h", new Date("2026-06-27T03:00:45.678Z"))).toEqual({
      startTimeMs: Date.parse("2026-06-26T03:00:45.678Z"), endTimeMs: Date.parse("2026-06-27T03:00:45.678Z"), limit: 10000
    });
    expect(() => parseUtcInputToMs("2026-06-27 00:00")).toThrow("YYYY-MM-DDTHH:mm");
    expect(chartInputSchema.safeParse({ poolName: "SUI_USDC", startTimeMs: 2, endTimeMs: 1 }).success).toBe(false);
    expect(chartInputSchema.safeParse({ poolName: "", limit: 500 }).success).toBe(false);
    expect(chartInputSchema.safeParse({ poolName: "SUI_USDC", limit: 10001 }).success).toBe(false);
  });
  it("maps source candle strings to display numbers while keeping the original time and quantities", () => {
    const candle = { timestampMs: 1782518400000, start: "2026-06-27T00:00:00.000Z", open: "0.7001", high: "0.7020", low: "0.6999", close: "0.7010", volume: "1200.5" };
    expect(candleToCandlestickData(candle)).toEqual({ time: 1782518400, open: 0.7001, high: 0.702, low: 0.6999, close: 0.701 });
    expect(candleToVolumeData(candle)).toMatchObject({ time: 1782518400, value: 1200.5 });
  });
  it("preserves the saved window and limit while displaying a concise UTC period", () => {
    const query = { poolName: "SUI_USDC", interval: "15m", startTimeMs: 1782518400000, endTimeMs: 1782522000000, limit: 120 };
    // One observed candle does not redefine the requested hour or requested cap.
    const candle = { timestampMs: 1782520200000, start: "2026-06-27T00:30:00.000Z", open: "0.7", high: "0.8", low: "0.6", close: "0.75", volume: "12" };
    for (const candles of [[], [candle]]) {
      const result = chartResultSchema.parse({ status: candles.length === 0 ? "empty_result" : "ok", query,
        candles, candleCount: candles.length, source: { endpoint: "order_fills", poolId: savedPoolId, fetchedAt: "2026-07-01T12:00:00.000Z" },
        pair: { poolId: savedPoolId, baseAsset: { symbol: "SUI" }, quoteAsset: { symbol: "USDC" } } });
      expect(result.query).toEqual(query);
      expect(chartQueryText(result.query)).toBe("Range (UTC): 2026-06-27 00:00:00 UTC → 2026-06-27 01:00:00 UTC");
      const { limit: _limit, ...missingLimit } = result.query;
      expect(chartResultSchema.safeParse({ ...result, query: missingLimit }).success).toBe(false);
    }
  });
  it("keeps omitted UTC boundaries explicit instead of filling them with current or candle times", () => {
    const query = { poolName: "SUI_USDC", interval: "15m", limit: 500 };
    expect(chartQueryText({})).toBe("Recent candles · UTC");
    expect(chartQueryText({ ...query, startTimeMs: 1782518400000 })).toBe("Range (UTC): 2026-06-27 00:00:00 UTC → not specified");
    expect(chartQueryText({ ...query, endTimeMs: 1782522000000 })).toBe("Range (UTC): not specified → 2026-06-27 01:00:00 UTC");
    // The source query accepts safe integer milliseconds, including values
    // outside Date's ISO range. Keep that value visible without inventing a date.
    expect(chartQueryText({ ...query, startTimeMs: 9007199254740991 })).toBe("Range (UTC): 9007199254740991 milliseconds since 1970-01-01T00:00:00Z → not specified");
  });
  it("keeps network and wallet operations outside the chart renderer", () => {
    const source = readFileSync(new URL("../src/mcp-ui/view/chart.ts", import.meta.url), "utf8");
    for (const forbidden of ["fetch(", "@mysten/dapp-kit", "SuiGrpcClient", "transactionBytes", "setInterval", "callServerTool"]) expect(source).not.toContain(forbidden);
  });
  it("retains explicit viewport boundaries without adding price or volume observations", () => {
    const candles = [{ timestampMs: 1782520200000, start: "2026-06-27T00:30:00.000Z", open: "0.7", high: "0.8", low: "0.6", close: "0.75", volume: "12" }];
    const original = structuredClone(candles);
    const query = { poolName: "SUI_USDC", interval: "15m", startTimeMs: 1782518400000, endTimeMs: 1782522000000, limit: 120 };
    const display = chartSeriesData(candles, query);
    expect(display.range).toEqual({ from: 1782518400, to: 1782522000 });
    expect(display.prices).toEqual([
      { time: 1782518400 },
      { time: 1782520200, open: 0.7, high: 0.8, low: 0.6, close: 0.75 },
      { time: 1782522000 }
    ]);
    expect(display.volumes[0]).toEqual({ time: 1782518400 });
    expect(display.volumes[2]).toEqual({ time: 1782522000 });
    expect(candles).toEqual(original);
    // Exact candle-boundary matches must not create duplicate time points.
    expect(chartSeriesData(candles, { ...query, startTimeMs: 1782520200000 }).prices).toHaveLength(2);
  });
  it("uses observed times for omitted viewport boundaries and fits latest-only results", () => {
    const candles = [
      { timestampMs: 1782519300000, start: "2026-06-27T00:15:00.000Z", open: "1", high: "1", low: "1", close: "1", volume: "0" },
      { timestampMs: 1782520200000, start: "2026-06-27T00:30:00.000Z", open: "1", high: "1", low: "1", close: "1", volume: "0" }
    ];
    const query = { poolName: "SUI_USDC", interval: "15m", limit: 500 };
    expect(chartSeriesData(candles, { ...query, startTimeMs: 1782518400000 }).range).toEqual({ from: 1782518400, to: 1782520200 });
    expect(chartSeriesData(candles, { ...query, endTimeMs: 1782522000000 }).range).toEqual({ from: 1782519300, to: 1782522000 });
    const latest = chartSeriesData(candles, query);
    expect(latest.range).toBeUndefined();
    expect(latest.prices).toHaveLength(2);
    expect(latest.prices.every((point) => "close" in point)).toBe(true);
  });
  it("waits for mounted positive dimensions, then preserves the current viewport on resize and hide/show", () => {
    // Layout notifications and chart API calls are boundary tests, not proof of
    // plotted coordinates. The real pinned module is verified in a browser too.
    const { result, container, resize, queueResize, flushFrame, frames, resizeDisconnect, themeDisconnect } = prepareLayout();
    expect(chartApi.create).not.toHaveBeenCalled();
    result.mount!(); result.mount!();
    expect(chartApi.create).not.toHaveBeenCalled();
    container.isConnected = true; resize();
    expect(chartApi.create).not.toHaveBeenCalled();
    container.clientWidth = 1000; container.clientHeight = 400; resize();
    expect(chartApi.create).toHaveBeenCalledExactlyOnceWith(container, expect.objectContaining({ width: 1000, height: 400, autoSize: false }));
    expect(chartApi.addSeries).toHaveBeenCalledTimes(2);
    for (const series of chartApi.addSeries.mock.results) {
      expect(series.value.setData.mock.calls[0]![0]).toHaveLength(3);
      expect(series.value.setData.mock.invocationCallOrder[0]).toBeLessThan(chartApi.setVisibleRange.mock.invocationCallOrder[0]!);
    }
    expect(chartApi.setVisibleRange).toHaveBeenCalledExactlyOnceWith({ from: 1782518400, to: 1782522000 });
    container.clientWidth = 0; container.clientHeight = 0; resize();
    expect(chartApi.resize).not.toHaveBeenCalled();
    container.clientWidth = 600; container.clientHeight = 400; resize(); resize();
    expect(chartApi.resize).toHaveBeenCalledExactlyOnceWith(600, 400);
    expect(chartApi.setVisibleRange).toHaveBeenCalledOnce(); expect(chartApi.fitContent).not.toHaveBeenCalled();
    queueResize(); queueResize(); expect(frames.size).toBe(1);
    result.dispose!(); result.dispose!(); expect(frames.size).toBe(0); flushFrame();
    container.clientWidth = 800; resize(); result.mount!();
    expect(chartApi.create).toHaveBeenCalledOnce(); expect(chartApi.resize).toHaveBeenCalledOnce();
    expect(resizeDisconnect).toHaveBeenCalledOnce(); expect(themeDisconnect).toHaveBeenCalledOnce(); expect(chartApi.remove).toHaveBeenCalledOnce();
  });
  it("releases a still-hidden result without creating a chart after disposal", () => {
    const { result, container, resize, resizeDisconnect } = prepareLayout();
    result.mount!(); result.dispose!();
    container.isConnected = true; container.clientWidth = 1000; container.clientHeight = 400; resize();
    expect(resizeDisconnect).toHaveBeenCalledOnce();
    expect(chartApi.create).not.toHaveBeenCalled(); expect(chartApi.remove).not.toHaveBeenCalled();
  });
  it("reports a display failure and only announces completion after a successful layout and draw", () => {
    const { result, container, flushFrame } = prepareLayout();
    chartApi.create.mockImplementationOnce(() => { throw Error("canvas unavailable"); });
    container.isConnected = true; container.clientWidth = 800; container.clientHeight = 360;
    result.mount!();
    expect(result.displayRecovery?.()?.message).toBe("Couldn’t display the chart.");
    expect(result.statusText?.()).not.toContain("Loaded");
    result.displayRecovery?.()?.retry();
    expect(result.displayRecovery?.()).toBeUndefined();
    expect(result.statusText?.()).toBe("Drawing chart…");
    flushFrame();
    expect(result.statusText?.()).toBe("Loaded 1 candle.");
    result.dispose!();
  });
});
