import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { expect, it, vi } from "vitest";
import { RuntimeTermination, runtimeFailureReason, type RuntimeExitCause } from "../src/runtime/runtimeTermination.js";
import { SuiEndpointError } from "../src/core/suiEndpoint.js";
import { ActivityDatabaseFormatError } from "../src/core/activity/sqliteActivityStoreTypes.js";
import { deferred } from "./fixtures/walletWorkflow.js";

it.each([
  [{ kind: "client" }, 0], [{ kind: "signal", code: 130 }, 130], [{ kind: "signal", code: 143 }, 143],
  [{ kind: "failure", stage: "shared_server_start", error: new Error("PRIVATE") }, 1]
] as const)("preserves %j through synchronous SDK stdio close and repeated close callbacks", async (cause, code) => {
  const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
  await transport.start();
  const flushed = deferred<void>(), log = vi.fn(), exit = vi.fn();
  const close = vi.fn(async () => { await transport.close(); });
  const termination = new RuntimeTermination({ close, logger: { error: log }, flush: () => flushed.promise, exit });
  transport.onclose = () => { void termination.request({ kind: "client" }); };
  const first = termination.request(cause as RuntimeExitCause);
  expect(termination.requested).toBe(true);
  expect(termination.request({ kind: "client" })).toBe(first);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(exit).not.toHaveBeenCalled();
  flushed.resolve(); await first;
  expect(exit).toHaveBeenCalledExactlyOnceWith(code);
  expect(log).toHaveBeenCalledTimes(cause.kind === "failure" ? 1 : 0);
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});

it.each(["client", "signal", "failure"] as const)("reports cleanup failure without replacing a %s cause", async (kind) => {
  const cause: RuntimeExitCause = kind === "client" ? { kind } : kind === "signal" ? { kind, code: 143 } : { kind, stage: "owner_acquisition", error: new Error("PRIVATE") };
  const log = vi.fn(), exit = vi.fn(), close = vi.fn(async () => { throw new Error("PRIVATE-CLEANUP"); });
  const termination = new RuntimeTermination({ close, logger: { error: log }, flush: async () => {}, exit });
  await termination.request(cause);
  expect(exit).toHaveBeenCalledExactlyOnceWith(kind === "signal" ? 143 : 1); expect(close).toHaveBeenCalledOnce();
  expect(log.mock.calls.filter(([message]) => message === "runtime shutdown failed")).toHaveLength(1);
  expect(log.mock.calls.filter(([message]) => message === "fatal runtime error")).toHaveLength(kind === "failure" ? 1 : 0);
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});

it("classifies endpoint and storage failures without logging their untrusted payloads", () => {
  const mismatch = new ActivityDatabaseFormatError();
  mismatch.message = "PRIVATE-DATABASE-CONTENTS";
  const reason = runtimeFailureReason(mismatch, "shared_server_start");
  expect(reason).toContain("Local database format does not match this runtime");
  expect(reason).toContain("explicitly choose to delete");
  expect(reason).not.toContain("PRIVATE");
  expect(runtimeFailureReason(new SuiEndpointError("chain_identifier_mismatch", "PRIVATE", { url: "PRIVATE" }), "start")).toContain("chain_identifier_mismatch");
  expect(runtimeFailureReason(Object.assign(new Error("PRIVATE"), { code: "SQLITE_FULL" }), "start")).toContain("SQLITE_FULL");
  expect(runtimeFailureReason(Object.assign(new Error("PRIVATE"), { code: "PRIVATE" }), "start")).not.toContain("PRIVATE");
});
