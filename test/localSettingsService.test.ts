import { describe, expect, it, vi } from "vitest";
import { LocalSettingsError } from "../src/core/preferences/preferencesStore.js";
import { RuntimeLocalSettingsService } from "../src/runtime/localSettingsService.js";
import { SuiEndpointError } from "../src/runtime/suiEndpoint.js";
import { InMemoryPreferencesRepository } from "./fixtures/inMemoryLocalSettings.js";

const defaults = {
  suiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
  suiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql"
};

describe("runtime local settings service", () => {
  it("returns stored and effective settings without exposing local paths", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(defaults);
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      env: {
        SUI_MCP_GRPC_URL: "https://override.sui.provider:9443"
      }
    });

    await repository.setSuiGrpcUrl("https://example.sui.provider:9000");
    await expect(service.getLocalSettings()).resolves.toEqual({
      suiGrpcUrl: {
        storedValue: "https://example.sui.provider:9000",
        effectiveValue: "https://override.sui.provider:9443",
        source: "environment",
        pendingStoredValue: "https://example.sui.provider:9000",
        appliesAfter: "mcp_server_restart"
      },
      suiGraphqlUrl: {
        storedValue: "https://graphql.mainnet.sui.io/graphql",
        effectiveValue: "https://graphql.mainnet.sui.io/graphql",
        source: "builtin_default"
      }
    });
  });

  it("validates and persists custom Sui gRPC endpoints", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(
      defaults,
      new Date("2026-05-11T00:00:00.000Z")
    );
    const verifyEndpoint = vi.fn(async (_url: string) => {});
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      env: {},
      verifyGrpcEndpoint: verifyEndpoint,
      now: () => new Date("2026-05-11T00:00:01.000Z")
    });

    await expect(service.setSuiGrpcUrl("https://example.sui.provider:9000")).resolves.toEqual({
      status: "saved",
      storedValue: "https://example.sui.provider:9000",
      previousStoredValue: "https://fullnode.mainnet.sui.io:443",
      appliesAfter: "mcp_server_restart"
    });
    expect(verifyEndpoint).toHaveBeenCalledWith("https://example.sui.provider:9000");
    await expect(repository.getSuiGrpcUrl()).resolves.toMatchObject({
      value: "https://example.sui.provider:9000",
      updatedAt: "2026-05-11T00:00:01.000Z"
    });
  });

  it("keeps the boot endpoint as effective until restart when DB changes outside the service", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(defaults);
    await repository.setSuiGrpcUrl("https://boot.sui.provider:9443");
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      env: {},
      bootSuiGrpcUrl: {
        storedValue: "https://boot.sui.provider:9443",
        effectiveValue: "https://boot.sui.provider:9443",
        source: "local_db"
      },
      bootSuiGraphqlUrl: {
        storedValue: "https://graphql.mainnet.sui.io/graphql",
        effectiveValue: "https://graphql.mainnet.sui.io/graphql",
        source: "builtin_default"
      }
    });

    await repository.resetSuiGrpcUrl("https://fullnode.mainnet.sui.io:443");

    await expect(service.getLocalSettings()).resolves.toEqual({
      suiGrpcUrl: {
        storedValue: "https://fullnode.mainnet.sui.io:443",
        effectiveValue: "https://boot.sui.provider:9443",
        source: "local_db",
        pendingStoredValue: "https://fullnode.mainnet.sui.io:443",
        appliesAfter: "mcp_server_restart"
      },
      suiGraphqlUrl: {
        storedValue: "https://graphql.mainnet.sui.io/graphql",
        effectiveValue: "https://graphql.mainnet.sui.io/graphql",
        source: "builtin_default"
      }
    });
  });

  it("does not require restart after DB changes back to the boot endpoint", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(defaults);
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      env: {},
      bootSuiGrpcUrl: {
        storedValue: "https://fullnode.mainnet.sui.io:443",
        effectiveValue: "https://fullnode.mainnet.sui.io:443",
        source: "builtin_default"
      },
      bootSuiGraphqlUrl: {
        storedValue: "https://graphql.mainnet.sui.io/graphql",
        effectiveValue: "https://graphql.mainnet.sui.io/graphql",
        source: "builtin_default"
      }
    });

    await repository.setSuiGrpcUrl("https://other.sui.provider:9443");
    await repository.resetSuiGrpcUrl("https://fullnode.mainnet.sui.io:443");

    await expect(service.getLocalSettings()).resolves.toEqual({
      suiGrpcUrl: {
        storedValue: "https://fullnode.mainnet.sui.io:443",
        effectiveValue: "https://fullnode.mainnet.sui.io:443",
        source: "builtin_default"
      },
      suiGraphqlUrl: {
        storedValue: "https://graphql.mainnet.sui.io/graphql",
        effectiveValue: "https://graphql.mainnet.sui.io/graphql",
        source: "builtin_default"
      }
    });
  });

  it("maps endpoint verification failures to deterministic input errors", async () => {
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: new InMemoryPreferencesRepository(),
      verifyGrpcEndpoint: async () => {
        throw new SuiEndpointError("endpoint_timeout", "timeout", {
          timeoutMs: 42,
          url: "https://example.sui.provider:9000"
        });
      }
    });

    await expect(service.setSuiGrpcUrl("https://example.sui.provider:9000")).rejects.toMatchObject({
      kind: "input_invalid",
      details: { reason: "endpoint_timeout", timeoutMs: 42 }
    } satisfies Partial<LocalSettingsError>);
  });

  it("maps chain identifier mismatches to deterministic input errors", async () => {
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: new InMemoryPreferencesRepository(),
      verifyGrpcEndpoint: async () => {
        throw new SuiEndpointError("chain_identifier_mismatch", "wrong chain", {
          chainIdentifier: "wrong-chain",
          expectedChainIdentifier: "mainnet-chain",
          url: "https://example.sui.provider:9000"
        });
      }
    });

    await expect(service.setSuiGrpcUrl("https://example.sui.provider:9000")).rejects.toMatchObject({
      kind: "input_invalid",
      details: {
        reason: "chain_identifier_mismatch",
        chainIdentifier: "wrong-chain",
        expectedChainIdentifier: "mainnet-chain"
      }
    } satisfies Partial<LocalSettingsError>);
  });

  it("resets the stored endpoint to the default idempotently", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(
      defaults,
      new Date("2026-05-11T00:00:00.000Z")
    );
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      defaultSuiGrpcUrl: "https://fullnode.mainnet.sui.io:443",
      now: () => new Date("2026-05-11T00:00:01.000Z")
    });

    await expect(service.resetSuiGrpcUrl()).resolves.toEqual({
      status: "reset",
      storedValue: "https://fullnode.mainnet.sui.io:443",
      previousStoredValue: "https://fullnode.mainnet.sui.io:443",
      appliesAfter: "mcp_server_restart"
    });
  });

  it("validates and persists custom Sui GraphQL endpoints", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(defaults, new Date("2026-05-11T00:00:00.000Z"));
    const verifyEndpoint = vi.fn(async (_url: string) => {});
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      env: {},
      verifyGraphqlEndpoint: verifyEndpoint,
      now: () => new Date("2026-05-11T00:00:01.000Z")
    });

    await expect(service.setSuiGraphqlUrl("https://example.graphql.provider/graphql")).resolves.toEqual({
      status: "saved",
      storedValue: "https://example.graphql.provider/graphql",
      previousStoredValue: "https://graphql.mainnet.sui.io/graphql",
      appliesAfter: "mcp_server_restart"
    });
    expect(verifyEndpoint).toHaveBeenCalledWith("https://example.graphql.provider/graphql");
    await expect(repository.getSuiGraphqlUrl()).resolves.toMatchObject({
      value: "https://example.graphql.provider/graphql",
      updatedAt: "2026-05-11T00:00:01.000Z"
    });
  });

  it("keeps the boot GraphQL endpoint as effective until restart when DB changes outside the service", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(defaults);
    await repository.setSuiGraphqlUrl("https://boot.graphql.provider/graphql");
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      env: {},
      bootSuiGrpcUrl: {
        storedValue: "https://fullnode.mainnet.sui.io:443",
        effectiveValue: "https://fullnode.mainnet.sui.io:443",
        source: "builtin_default"
      },
      bootSuiGraphqlUrl: {
        storedValue: "https://boot.graphql.provider/graphql",
        effectiveValue: "https://boot.graphql.provider/graphql",
        source: "local_db"
      }
    });

    await repository.resetSuiGraphqlUrl("https://graphql.mainnet.sui.io/graphql");

    await expect(service.getLocalSettings()).resolves.toMatchObject({
      suiGraphqlUrl: {
        storedValue: "https://graphql.mainnet.sui.io/graphql",
        effectiveValue: "https://boot.graphql.provider/graphql",
        source: "local_db",
        pendingStoredValue: "https://graphql.mainnet.sui.io/graphql",
        appliesAfter: "mcp_server_restart"
      }
    });
  });

  it("maps GraphQL endpoint verification failures to deterministic input errors", async () => {
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: new InMemoryPreferencesRepository(),
      verifyGraphqlEndpoint: async () => {
        throw new SuiEndpointError("endpoint_timeout", "timeout", {
          timeoutMs: 42,
          url: "https://example.graphql.provider/graphql"
        });
      }
    });

    await expect(service.setSuiGraphqlUrl("https://example.graphql.provider/graphql")).rejects.toMatchObject({
      kind: "input_invalid",
      details: { reason: "endpoint_timeout", timeoutMs: 42 }
    } satisfies Partial<LocalSettingsError>);
  });

  it("maps GraphQL chain identifier mismatches to deterministic input errors", async () => {
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: new InMemoryPreferencesRepository(),
      verifyGraphqlEndpoint: async () => {
        throw new SuiEndpointError("chain_identifier_mismatch", "wrong chain", {
          chainIdentifier: "wrong-chain",
          expectedChainIdentifier: "mainnet-chain",
          url: "https://example.graphql.provider/graphql"
        });
      }
    });

    await expect(service.setSuiGraphqlUrl("https://example.graphql.provider/graphql")).rejects.toMatchObject({
      kind: "input_invalid",
      details: {
        reason: "chain_identifier_mismatch",
        chainIdentifier: "wrong-chain",
        expectedChainIdentifier: "mainnet-chain"
      }
    } satisfies Partial<LocalSettingsError>);
  });

  it("resets the stored GraphQL endpoint to the default idempotently", async () => {
    const repository = new InMemoryPreferencesRepository();
    await repository.ensureDefaultLocalSettings(defaults, new Date("2026-05-11T00:00:00.000Z"));
    const service = new RuntimeLocalSettingsService({
      preferencesRepository: repository,
      defaultSuiGraphqlUrl: "https://graphql.mainnet.sui.io/graphql",
      now: () => new Date("2026-05-11T00:00:01.000Z")
    });

    await expect(service.resetSuiGraphqlUrl()).resolves.toEqual({
      status: "reset",
      storedValue: "https://graphql.mainnet.sui.io/graphql",
      previousStoredValue: "https://graphql.mainnet.sui.io/graphql",
      appliesAfter: "mcp_server_restart"
    });
  });
});
