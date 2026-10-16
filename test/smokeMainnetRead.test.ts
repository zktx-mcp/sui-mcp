import { afterEach, expect, it, vi } from "vitest";
import type { McpServerDeps } from "../src/mcp/server.js";

const fixture = vi.hoisted(() => ({
  account: `0x${"a".repeat(64)}`,
  functionTarget: "0x2::coin::transfer",
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  report: undefined as Record<string, any> | undefined,
  close: vi.fn(async () => {})
}));
// This runs the utility entry and payload assertions with real temporary SQLite
// history preparation. The MCP client/server and read/review dependencies below
// are doubles: this proves request wiring, not MCP behavior or mainnet results.
// No network or wallet is contacted.
vi.mock("@modelcontextprotocol/client", () => ({ Client: class {
  connect = async () => {};
  close = fixture.close;
  async callTool(call: { name: string; arguments: Record<string, unknown> }) {
    fixture.calls.push(call);
    const activity = /(?:scan_sui|summarize_sui)/.test(call.name);
    const data = activity ? {
      status: "ok", account: fixture.account, accountSource: "explicit_filter",
      relationship: call.name.includes("function") ? "sent" : "affected",
      ...(call.name.includes("function") ? { function: fixture.functionTarget } : {}),
      source: { transport: "graphql", method: "Query.transactions" }, persistence: { stored: false },
      transactions: [], requestedAccountTransactionFacts: [], hasMore: false, windowComplete: true, orderingVerified: true,
      requestedAccount: { balanceChangeCompleteness: "complete", coinFlows: [], sentCount: 0, affectedOnlyCount: 0 },
      ...(call.name.includes("summarize") ? { analysis: { overview: { transactionCount: 0 }, limitations: [], coinFlows: [] } } : {})
    } : { status: "ok" };
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
  }
} }));
vi.mock("../src/mcp/server.js", () => ({ createMcpServer: (deps: McpServerDeps) => {
  return { connect: async () => {
    expect(await deps.activityStore.getActiveAccount()).toBeUndefined();
    expect(await deps.activityStore.getKnownAccount(fixture.account)).toMatchObject({ address: fixture.account });
  }, close: async () => {} };
} }));
vi.mock("../src/core/read/readService.js", () => ({ createSuiReadService: () => ({}) }));
vi.mock("../src/runtime/reviewDependencies.js", () => ({ createRuntimeReviewDependencies: () => ({}) }));
vi.mock("../src/runtime/suiEndpoint.js", async (original) => {
  const actual = await original<typeof import("../src/runtime/suiEndpoint.js")>();
  return { ...actual, verifyMainnetGrpcEndpoint: async () => ({ client: {}, chainIdentifier: actual.SUI_MAINNET_CHAIN_IDENTIFIER }) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    mkdirSync: (path: Parameters<typeof actual.mkdirSync>[0], options: any) => String(path).includes(".WORK/smoke-results") ? undefined : actual.mkdirSync(path, options),
    writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], data: any, options: any) => {
      if (String(path).includes(".WORK/smoke-results")) { fixture.report = JSON.parse(String(data)); return; }
      actual.writeFileSync(path, data, options);
    }
  };
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("runs all four activity smoke calls with the explicit address and independent explicit-filter expectations", async () => {
  for (const key of Object.keys(process.env).filter((key) => key.startsWith("SUI_MCP_SMOKE_"))) vi.stubEnv(key, undefined);
  vi.stubEnv("SUI_MCP_NETWORK", "mainnet");
  vi.stubEnv("SUI_MCP_SMOKE_ADDRESS", fixture.account);
  vi.stubEnv("SUI_MCP_SMOKE_DEEPBOOK_POOL_KEY", "DEEP_SUI");
  vi.stubEnv("SUI_MCP_SMOKE_QUOTE_AMOUNT", "1000000000");
  vi.stubEnv("SUI_MCP_SMOKE_FUNCTION_TARGET", fixture.functionTarget);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await import("../src/runtime/smokeMainnetRead.js");
  await vi.waitFor(() => expect(fixture.report, JSON.stringify(stderr.mock.calls)).toBeDefined());
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(exit, JSON.stringify(stderr.mock.calls)).not.toHaveBeenCalled();
  expect(fixture.report!.ok).toBe(true);
  const names = ["read_scan_sui_account_activity", "read_summarize_sui_activity_scan", "read_scan_sui_function_activity", "read_summarize_sui_function_activity_scan"];
  for (const name of names) expect(fixture.calls.find((call) => call.name === name)?.arguments).toEqual({
    account: fixture.account, limit: 5, ...(name.includes("function") ? { function: fixture.functionTarget } : {})
  });
  for (const group of [fixture.report!.activitySmoke, fixture.report!.functionActivitySmoke]) {
    for (const kind of ["scan", "summary"]) expect(group[kind]).toMatchObject({ accountSource: "explicit_filter", status: "empty_page" });
  }
  expect(fixture.report!.accountBoundSwapReview).toMatchObject({ status: "not_run" });
});
