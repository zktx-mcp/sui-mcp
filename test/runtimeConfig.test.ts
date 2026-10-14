import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_PORT,
  DEFAULT_SUI_GRAPHQL_URL,
  DEFAULT_SUI_GRPC_URL,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  composeRuntimeConfig,
  loadBootConfig,
  resolveSuiGraphqlUrlView,
  resolveSuiGrpcUrlView
} from "../src/runtime/config.js";
import { parseGraphqlUrl, parseGrpcUrl } from "../src/runtime/suiEndpoint.js";

describe("runtime config", () => {
  it("is mainnet-only", () => {
    expect(() => loadBootConfig({ SUI_MCP_NETWORK: "testnet" })).toThrow("mainnet");
  });

  it("uses verified mainnet chain identifier and database path in boot config", () => {
    const config = loadBootConfig({});
    expect(config.network).toBe("mainnet");
    expect(config.expectedChainIdentifier).toBe(SUI_MAINNET_CHAIN_IDENTIFIER);
    expect(config.activityDatabasePath).toContain("sui-mcp.sqlite");
  });

  it("does not allow overriding the expected mainnet chain identifier", () => {
    const config = loadBootConfig({ SUI_MAINNET_CHAIN_IDENTIFIER: "fake-chain" });
    expect(config.expectedChainIdentifier).toBe(SUI_MAINNET_CHAIN_IDENTIFIER);
  });

  it("defaults the review port to a fixed value so the wallet autoconnect origin is stable", () => {
    expect(DEFAULT_REVIEW_PORT).toBe(8765);
    expect(loadBootConfig({}).reviewPort).toBe(DEFAULT_REVIEW_PORT);
  });

  it("overrides the review port from SUI_MCP_REVIEW_PORT", () => {
    expect(loadBootConfig({ SUI_MCP_REVIEW_PORT: "9123" }).reviewPort).toBe(9123);
    expect(() => loadBootConfig({ SUI_MCP_REVIEW_PORT: "0" })).toThrow("between 1 and 65535");
    expect(() => loadBootConfig({ SUI_MCP_REVIEW_PORT: "notaport" })).toThrow("between 1 and 65535");
  });

  it("uses only the current package environment and data identity", () => {
    const defaults = loadBootConfig({});
    expect(loadBootConfig({
      SAY_UR_INTENT_DATA_DIR: "/previous-package-data",
      SAY_UR_INTENT_REVIEW_PORT: "9123"
    })).toEqual(defaults);
    const selected = loadBootConfig({ SUI_MCP_DATA_DIR: "/new-package-data", SUI_MCP_REVIEW_PORT: "9124" });
    expect(selected.activityDatabasePath).toBe(resolve("/new-package-data", "sui-mcp.sqlite"));
    expect(selected.reviewPort).toBe(9124);
  });

  it("composes runtime config from local settings when env is absent", () => {
    const bootConfig = loadBootConfig({});
    const config = composeRuntimeConfig({
      bootConfig,
      env: {},
      storedSuiGrpcUrl: "https://example.sui.provider:9000"
    });
    expect(config.grpcUrl).toBe("https://example.sui.provider:9000");
    expect(config.graphqlUrl).toBe(DEFAULT_SUI_GRAPHQL_URL);
    expect(config.suiGrpcUrl).toMatchObject({
      storedValue: "https://example.sui.provider:9000",
      effectiveValue: "https://example.sui.provider:9000",
      source: "local_db"
    });
  });

  it("composes GraphQL endpoint settings with the same restart-effective source model", () => {
    const view = resolveSuiGraphqlUrlView({
      storedValue: "https://custom.graphql.provider/graphql",
      envValue: "https://override.graphql.provider/graphql"
    });
    expect(view).toEqual({
      storedValue: "https://custom.graphql.provider/graphql",
      effectiveValue: "https://override.graphql.provider/graphql",
      source: "environment",
      pendingStoredValue: "https://custom.graphql.provider/graphql",
      appliesAfter: "mcp_server_restart"
    });
  });

  it("uses env endpoint over stored settings without mutating the stored view", () => {
    const view = resolveSuiGrpcUrlView({
      storedValue: "https://example.sui.provider:9000",
      envValue: "https://override.sui.provider:9443"
    });
    expect(view).toEqual({
      storedValue: "https://example.sui.provider:9000",
      effectiveValue: "https://override.sui.provider:9443",
      source: "environment",
      pendingStoredValue: "https://example.sui.provider:9000",
      appliesAfter: "mcp_server_restart"
    });

    expect(
      resolveSuiGrpcUrlView({
        storedValue: "https://example.sui.provider:9000",
        envValue: "https://example.sui.provider:9000"
      })
    ).toEqual({
      storedValue: "https://example.sui.provider:9000",
      effectiveValue: "https://example.sui.provider:9000",
      source: "environment",
      pendingStoredValue: undefined,
      appliesAfter: undefined
    });
  });

  it("requires explicit gRPC URL ports and accepts non-default provider ports", () => {
    expect(() => parseGrpcUrl("https://fullnode.mainnet.sui.io")).toThrow("explicit port");
    expect(parseGrpcUrl("https://example.sui.provider:9000")).toBe("https://example.sui.provider:9000");
    expect(parseGrpcUrl("http://[::1]:9000")).toBe("http://[::1]:9000");
  });

  it("rejects gRPC URL paths, queries, fragments, and credentials", () => {
    expect(() => parseGrpcUrl("https://fullnode.mainnet.sui.io:443/path")).toThrow(
      "only scheme, host, and explicit port"
    );
    expect(() => parseGrpcUrl("https://fullnode.mainnet.sui.io:443?x=1")).toThrow(
      "only scheme, host, and explicit port"
    );
    expect(() => parseGrpcUrl("https://fullnode.mainnet.sui.io:443#fragment")).toThrow(
      "only scheme, host, and explicit port"
    );
    expect(() => parseGrpcUrl("https://user:pass@fullnode.mainnet.sui.io:443")).toThrow(
      "must not include credentials"
    );
  });

  it("rejects oversized gRPC URLs before parsing", () => {
    expect(() => parseGrpcUrl(`https://${"a".repeat(513)}:443`)).toThrow("512 characters or fewer");
  });

  it("parses GraphQL endpoint URLs with a path and no explicit port", () => {
    expect(parseGraphqlUrl("https://graphql.mainnet.sui.io/graphql")).toBe("https://graphql.mainnet.sui.io/graphql");
    expect(() => parseGraphqlUrl("http://graphql.mainnet.sui.io/graphql")).toThrow("must use https");
    expect(() => parseGraphqlUrl("https://user:pass@graphql.mainnet.sui.io/graphql")).toThrow(
      "must not include credentials"
    );
    expect(() => parseGraphqlUrl("https://graphql.mainnet.sui.io/graphql?x=1")).toThrow(
      "must not include a query string or fragment"
    );
  });

  it("falls back to the built-in default when no stored value exists", () => {
    const config = composeRuntimeConfig({ bootConfig: loadBootConfig({}), env: {} });
    expect(config.grpcUrl).toBe(DEFAULT_SUI_GRPC_URL);
    expect(config.graphqlUrl).toBe(DEFAULT_SUI_GRAPHQL_URL);
    expect(config.suiGrpcUrl.source).toBe("builtin_default");
    expect(config.suiGraphqlUrl.source).toBe("builtin_default");
  });
});
