import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { DeepBookClient, mainnetPackageIds, mainnetPools } from "@mysten/deepbook-v3";

describe("pinned SDK API surface", () => {
  it("exposes MCP server APIs used by the runtime", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(typeof server.registerTool).toBe("function");
    expect(typeof StdioServerTransport).toBe("function");
  });

  it("exposes Sui gRPC APIs used by the mainnet guard and read-only tools", () => {
    const client = new SuiGrpcClient({
      baseUrl: "https://fullnode.mainnet.sui.io:443",
      network: "mainnet"
    });
    expect(typeof client.core.getChainIdentifier).toBe("function");
    expect(typeof client.core.simulateTransaction).toBe("function");
    expect(typeof client.core.listBalances).toBe("function");
    expect(typeof client.core.getCoinMetadata).toBe("function");
  });

  it("exposes DeepBook mainnet constants used by the generator", () => {
    expect(mainnetPackageIds.DEEPBOOK_PACKAGE_ID).toMatch(/^0x/);
    expect(Object.keys(mainnetPools).length).toBeGreaterThan(0);
  });

  it("exposes DeepBook read and transaction-builder methods used by the runtime", () => {
    const client = new SuiGrpcClient({
      baseUrl: "https://fullnode.mainnet.sui.io:443",
      network: "mainnet"
    });
    const deepbook = new DeepBookClient({
      client,
      address: "0x0000000000000000000000000000000000000000000000000000000000000000",
      network: "mainnet"
    });

    expect(typeof DeepBookClient.prototype.midPrice).toBe("function");
    expect(typeof DeepBookClient.prototype.poolBookParams).toBe("function");
    expect(typeof DeepBookClient.prototype.getLevel2TicksFromMid).toBe("function");
    expect(typeof deepbook.deepBook.getQuoteQuantityOut).toBe("function");
    expect(typeof deepbook.deepBook.getBaseQuantityOut).toBe("function");
  });
});
