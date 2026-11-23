import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { MarketReadRequests } from "../src/mcp/tools/read/marketReadRequests.js";
import { okToolResult } from "../src/mcp/result.js";
import { EXECUTION_POLLING_INTERVAL_SECONDS } from "../src/core/session/status.js";
import { DEFAULT_SESSION_TTL_MS } from "../src/core/session/localSession.js";

const tick = EXECUTION_POLLING_INTERVAL_SECONDS * 1000;
afterEach(() => vi.useRealTimers());

it.each(["connection close", "data replacement", "idle expiration"])(
  "ends an outstanding read on %s",
  async (reason) => {
    vi.useFakeTimers();
    const server = new McpServer({ name: "reader", version: "1.0.0" });
    const owner = new AbortController();
    const reads = new MarketReadRequests(server, () => owner.signal);
    let signal!: AbortSignal;
    const run = vi.fn(async (_: object, s: AbortSignal) => {
      signal = s;
      await new Promise<void>((resolve) => s.addEventListener("abort", () => resolve(), { once: true }));
      return okToolResult({ status: "ok", value: "stale" });
    });
    const first = reads.read("history", { pool: "A" }, run);
    const duplicate = reads.read("history", { pool: "A" }, run);
    await vi.advanceTimersByTimeAsync(tick);
    const response = (await first).structuredContent as { data: { requestId: string; status: string } };
    expect(response.data.status).toBe("running");
    expect((await duplicate).structuredContent).toEqual(response);
    const resume = { requestId: response.data.requestId };
    if (reason === "idle expiration") await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_TTL_MS);
    else if (reason === "data replacement") owner.abort();
    else server.server.onclose?.();
    expect(signal.aborted).toBe(true);
    expect((await reads.read("history", resume, run)).structuredContent).toMatchObject({
      data: { status: "request_unavailable" },
    });
    expect(run).toHaveBeenCalledOnce();
  },
);

it("returns the same immediate result to concurrent waiters", async () => {
  const server = new McpServer({ name: "reader", version: "1.0.0" });
  const reads = new MarketReadRequests(server);
  const result = okToolResult({ status: "ok", bars: [] });
  const run = vi.fn(async () => result);
  const start = () => reads.read("history", { pool: "A" }, run);
  expect(await Promise.all([start(), start()])).toEqual([result, result]);
  expect(run).toHaveBeenCalledOnce();
});

it("shares a resolved account snapshot across unrelated revisions, and separates changed evidence", async () => {
  const server = new McpServer({ name: "reader", version: "1.0.0" });
  const reads = new MarketReadRequests(server);
  const gate = Promise.withResolvers<void>();
  const run = vi.fn(async (data: { raw: string }) => { await gate.promise; return okToolResult(data); });
  const original = vi.fn(() => ({ raw: "7" }));
  const changed = vi.fn(() => ({ raw: "9" }));
  const get = (revision: number, load: () => { raw: string }) =>
    reads.readSnapshot("timeline", "resolved A, fixed interval", { revision, load }, run);
  const requests = [get(1, original), get(1, original), get(2, original), get(3, changed)];
  gate.resolve();
  const results = await Promise.all(requests);
  expect(results.map(r => r.structuredContent)).toEqual(["7", "7", "7", "9"].map(raw => ({ok:true,data:{raw}})));
  expect(original).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledTimes(2);
});

it("starts a fresh read after an unobserved failure and retains the original handle", async () => {
  vi.useFakeTimers();
  const server = new McpServer({ name: "reader", version: "1.0.0" });
  const reads = new MarketReadRequests(server);
  const firstSource = Promise.withResolvers<ReturnType<typeof okToolResult>>();
  const recoveredSource = Promise.withResolvers<ReturnType<typeof okToolResult>>();
  const failed = okToolResult({ status: "source_unavailable" });
  const recovered = okToolResult({ status: "available" });
  const run = vi.fn().mockReturnValueOnce(firstSource.promise).mockReturnValueOnce(recoveredSource.promise);
  const fresh = () => reads.read("history", { pool: "A" }, run);
  try {
    const first = fresh();
    await vi.advanceTimersByTimeAsync(tick);
    const initial = (await first).structuredContent as { data: { status: string; requestId: string } };
    expect(initial.data.status).toBe("running");
    firstSource.resolve(failed);
    await vi.advanceTimersByTimeAsync(0);

    const retry = fresh();
    expect(await reads.resume("history", initial.data.requestId)).toEqual(failed);
    const joined = fresh();
    recoveredSource.resolve(recovered);
    expect(await Promise.all([retry, joined])).toEqual([recovered, recovered]);
    expect(run).toHaveBeenCalledTimes(2);
  } finally { server.server.onclose?.(); }
});

it.each(["history", "timeline"])("keeps an expired %s handle dead before its timer runs", async tool => {
  vi.useFakeTimers();
  const server = new McpServer({ name: "reader", version: "1.0.0" });
  const reads = new MarketReadRequests(server);
  const gate = Promise.withResolvers<void>();
  const run = vi.fn(async () => { await gate.promise; return okToolResult({ status: "ok" }); });
  const fresh = () => tool === "history" ? reads.read(tool, {}, run)
    : reads.readSnapshot(tool, "account/window", { revision: 1, load: () => ({}) }, run);
  try {
    const first = fresh();
    await vi.advanceTimersByTimeAsync(tick);
    const { data: old } = (await first).structuredContent as { data: { expiresAt: string; requestId: string } };
    vi.setSystemTime(new Date(old.expiresAt));

    const next = fresh();
    expect((await reads.resume(tool, old.requestId)).structuredContent).toMatchObject({ data: { reason: "unknown_or_expired" } });
    await vi.advanceTimersByTimeAsync(tick);
    const { data: pending } = (await next).structuredContent as { data: { requestId: string; status: string } };
    expect(pending.status).toBe("running");
    expect(pending.requestId).not.toBe(old.requestId);
    gate.resolve();
    expect((await reads.resume(tool, pending.requestId)).structuredContent).toMatchObject({ data: { status: "ok" } });
    expect((await reads.resume(tool, old.requestId)).structuredContent).toMatchObject({ data: { reason: "unknown_or_expired" } });
    expect(run).toHaveBeenCalledTimes(2);
  } finally { gate.resolve(); server.server.onclose?.(); }
});
