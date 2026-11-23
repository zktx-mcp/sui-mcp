import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp/toolNames.js";

describe("stdio MCP transport e2e", () => {
  it("initializes, lists tools, and calls server status over real stdio transport", { timeout: 15_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(process.cwd(), "test/fixtures/stdioMcpServer.ts")],
      cwd: process.cwd(),
      stderr: "pipe"
    });
    const client = new Client({ name: "stdio-e2e-test", version: "0.0.0" });

    try {
      await client.connect(transport);

      expect(client.getInstructions()).toContain("mainnet-only");

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(TOOL_NAMES.readGetServerStatus);

      const result = await client.callTool({ name: TOOL_NAMES.readGetServerStatus });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(text).toBeDefined();

      const payload = JSON.parse(text ?? "");
      expect(payload).toMatchObject({
        ok: true,
        data: {
          runtime: "local_stdio",
          transport: "grpc_graphql",
          protocolsTool: TOOL_NAMES.readListSupportedProtocols
        }
      });
      for (const direction of ["base_to_quote", "quote_to_base"] as const) {
        const amountRaw = direction === "base_to_quote" ? "1000000000" : "1000000";
        for (const feeMode of ["deep", "input_coin"] as const) {
          for (const [name, amount] of [
            [TOOL_NAMES.readQuoteDeepbookAction, { amountRaw }],
            [TOOL_NAMES.readQuoteDeepbookDisplayAmount, { amountDisplay: "1" }]
          ] as const) {
            const response = await client.callTool({ name, arguments: { poolKey: "SUI_USDC", direction, feeMode, ...amount } });
            expect(response.isError).not.toBe(true);
            const { data } = response.structuredContent as { data: Record<string, unknown> };
            expect(data).toMatchObject({
              direction, fetchedAt: expect.any(String), quoteOutcome: "full_input_spend",
              rawQuote: { inputAmount: { raw: amountRaw }, directionalOutput: { symbol: direction === "base_to_quote" ? "USDC" : "SUI" } },
              inputFlow: { expectedSpendRaw: amountRaw, expectedReturnRaw: "0", fee: { kind: feeMode === "deep" ? "separate_coin" : "included_in_input" } }
            });
            for (const key of ["expiresAt", "minOutRaw", "separateFeeBudgetRaw"]) expect(data).not.toHaveProperty(key);
          }
        }
      }
    } finally {
      await client.close();
    }
  });
});
