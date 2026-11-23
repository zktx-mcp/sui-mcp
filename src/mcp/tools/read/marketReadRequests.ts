import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFAULT_SESSION_TTL_MS } from "../../../core/session/localSession.js";
import { EXECUTION_POLLING_INTERVAL_SECONDS } from "../../../core/session/status.js";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../../../core/session/wait.js";
import { okToolResult } from "../../result.js";

// Per-connection admission budget for running reads and results promised to a client.
const MAX_RETAINED_READS_PER_CONNECTION = 256;

const resume = z.object({ requestId: z.uuid() }).strict();
export const readPending = z
  .object({
    status: z.literal("running"),
    requestId: z.uuid(),
    nextRead: z.object({ tool: z.string(), arguments: resume }),
    expiresAt: z.iso.datetime(),
  })
  .strict();
const unavailable = z
  .object({
    status: z.literal("request_unavailable"),
    reason: z.enum(["unknown_or_expired", "capacity"]),
  })
  .strict();

export function resumableReadInput<S extends z.ZodRawShape>(shape: S) {
  return z.union([resume, z.strictObject(shape)]).meta({ type: "object" });
}
export function resumableReadOutput<S extends z.ZodType>(output: z.ZodObject<{ ok: z.ZodLiteral<true>; data: S }>) {
  return output.extend({ data: z.union([output.shape.data, readPending, unavailable]) });
}

type Entry = {
  id: string;
  tool: string;
  key: string;
  lease: AbortController;
  result: Promise<CallToolResult>;
  expired: Promise<undefined>;
  expiresAt: number;
  snapshot?: { scope: string; revision: number; value: unknown };
  exposed?: boolean;
  delivered?: boolean;
  timer?: NodeJS.Timeout;
  owner?: AbortSignal | undefined;
  onExpired: () => void;
};

// Each MCP connection owns its public read handles. No prices, account snapshots
// or continuation credentials are added to SQLite or to the public backup.
export class MarketReadRequests {
  private readonly reads = new Map<string, Entry>();
  private readonly active = new Map<string, Entry>();

  constructor(
    server: McpServer,
    private readonly lifetime?: () => AbortSignal,
  ) {
    const close = server.server.onclose;
    server.server.onclose = () => {
      for (const entry of this.reads.values()) this.remove(entry);
      close?.();
    };
  }

  private finish(entry: Entry) {
    delete entry.snapshot;
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key);
  }

  private remove(entry: Entry) {
    clearTimeout(entry.timer);
    this.reads.delete(entry.id);
    this.finish(entry);
    entry.owner?.removeEventListener("abort", entry.onExpired);
    entry.lease.abort();
  }

  private live(entry: Entry | undefined, now: number) {
    if (entry && entry.expiresAt <= now) {
      this.remove(entry);
      return undefined;
    }
    return entry;
  }

  private atCapacity(now: number) {
    // Cleanup timers may still be queued after a clock jump or a suspended process.
    if (this.reads.size < MAX_RETAINED_READS_PER_CONNECTION) return false;
    for (const entry of this.reads.values()) this.live(entry, now);
    return this.reads.size >= MAX_RETAINED_READS_PER_CONNECTION;
  }

  private renew(entry: Entry, now: number) {
    clearTimeout(entry.timer);
    entry.expiresAt = now + DEFAULT_SESSION_TTL_MS;
    entry.timer = setTimeout(entry.onExpired, DEFAULT_SESSION_TTL_MS);
    entry.timer.unref();
  }

  async read<T extends object>(
    tool: string,
    input: T | { requestId: string },
    run: (input: T, signal: AbortSignal) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    if ("requestId" in input) return this.resume(tool, input.requestId);
    const key = JSON.stringify([tool, Object.entries(input).sort(([a], [b]) => a.localeCompare(b))]);
    const now = Date.now();
    const entry = this.live(this.active.get(key), now);
    return entry ? this.observe(entry, false, now) : this.start(tool, key, signal => run(input, signal));
  }

  readSnapshot<T>(
    tool: string, scope: string, binding: { revision: number; load(): T },
    run: (value: T, signal: AbortSignal) => Promise<CallToolResult>
  ): Promise<CallToolResult> {
    // Equal revisions on the same resolved scope need no second SQLite read.
    // A different revision is only a reason to compare the relevant rows.
    const now = Date.now();
    const candidates = [...this.active.values()].filter(entry =>
      entry.tool === tool && entry.snapshot?.scope === scope && this.live(entry, now));
    const unchanged = candidates.find(entry => entry.snapshot!.revision === binding.revision);
    if (unchanged) return this.observe(unchanged, false, now);
    if (!candidates.length && this.atCapacity(now)) {
      return Promise.resolve(okToolResult({status: "request_unavailable", reason: "capacity"}));
    }
    const value = binding.load();
    const equivalent = candidates.find(entry => isDeepStrictEqual(entry.snapshot!.value, value));
    if (equivalent) {
      equivalent.snapshot!.revision = binding.revision;
      return this.observe(equivalent, false, now);
    }
    const key = JSON.stringify([tool, scope, binding.revision]);
    return this.start(tool, key, signal => run(value, signal), { scope, revision: binding.revision, value });
  }

  private async start(tool: string, key: string, run: (signal: AbortSignal) => Promise<CallToolResult>, snapshot?: Entry["snapshot"]) {
    // Never evict a promised result to admit a different request.
    const now = Date.now();
    if (this.atCapacity(now))
      return okToolResult({ status: "request_unavailable", reason: "capacity" });
    const lease = new AbortController();
    const owner = this.lifetime?.();
    owner?.throwIfAborted();
    const created: Entry = {
      id: randomUUID(),
      tool,
      key,
      ...(snapshot ? { snapshot } : {}),
      lease,
      owner,
      expiresAt: 0,
      onExpired: () => this.remove(created),
      expired: new Promise((resolve) =>
        lease.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      ),
      result: Promise.resolve().then(() => run(lease.signal)).finally(() => {
        // A new query can start as soon as the source settles. An exposed ID
        // still owns its original result until expiry or invalidation.
        this.finish(created);
      }),
    };
    owner?.addEventListener("abort", created.onExpired, { once: true });
    this.active.set(key, created);
    this.reads.set(created.id, created);
    return this.observe(created, false, now);
  }

  async resume(tool: string, requestId: string): Promise<CallToolResult> {
    const now = Date.now();
    const entry = this.live(this.reads.get(requestId), now);
    if (!entry || entry.tool !== tool) {
      return okToolResult({ status: "request_unavailable", reason: "unknown_or_expired" });
    }
    return this.observe(entry, true, now);
  }

  private async observe(entry: Entry, polling: boolean, now: number): Promise<CallToolResult> {
    this.renew(entry, now);
    // The original call yields after one observation interval. A continuation
    // waits for the same read within the existing public long-poll budget.
    let timer: NodeJS.Timeout | undefined;
    const pending = new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(undefined),
        polling ? DEFAULT_WAIT_TIMEOUT_MS : EXECUTION_POLLING_INTERVAL_SECONDS * 1000,
      );
    });
    try {
      const result = await Promise.race([entry.result, entry.expired, pending]);
      if (!entry.delivered && !this.live(this.reads.get(entry.id), Date.now()))
        return okToolResult({ status: "request_unavailable", reason: "unknown_or_expired" });
      if (result) {
        if (!polling && !entry.exposed) {
          entry.delivered = true;
          this.remove(entry);
        }
        return result;
      }
      entry.exposed = true;
      return okToolResult({
        status: "running",
        requestId: entry.id,
        nextRead: { tool: entry.tool, arguments: { requestId: entry.id } },
        expiresAt: new Date(entry.expiresAt).toISOString(),
      });
    } catch (error) {
      if (!this.live(this.reads.get(entry.id), Date.now()) && entry.exposed)
        return okToolResult({ status: "request_unavailable", reason: "unknown_or_expired" });
      if (!entry.exposed) this.remove(entry);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
