import { resolveActivityDatabasePath } from "../core/activity/sqliteActivityStore.js";
import {
  DEFAULT_SUI_GRAPHQL_URL,
  DEFAULT_SUI_GRPC_URL,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  parseGraphqlUrl,
  parseGrpcUrl
} from "./suiEndpoint.js";
import type {
  SuiGraphqlUrlLocalSettingsView,
  SuiGrpcUrlLocalSettingsView
} from "../core/preferences/preferencesStore.js";
import { SETTINGS_APPLIES_AFTER_RESTART } from "../core/preferences/preferencesStore.js";

export type BootConfig = {
  network: "mainnet";
  expectedChainIdentifier: string;
  reviewHost: "127.0.0.1";
  reviewPort: number;
  activityDatabasePath: string;
};

export type RuntimeConfig = BootConfig & {
  grpcUrl: string;
  graphqlUrl: string;
  suiGrpcUrl: SuiGrpcUrlLocalSettingsView;
  suiGraphqlUrl: SuiGraphqlUrlLocalSettingsView;
};

export function loadBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig {
  const network = env.SUI_MCP_NETWORK ?? "mainnet";
  if (network !== "mainnet") {
    throw new Error("Sui MCP product runtime only supports mainnet");
  }

  return {
    network: "mainnet",
    expectedChainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
    reviewHost: "127.0.0.1",
    reviewPort: parseReviewPort(env.SUI_MCP_REVIEW_PORT),
    activityDatabasePath: resolveActivityDatabasePath(env)
  };
}

export type ComposeRuntimeConfigInput = {
  bootConfig: BootConfig;
  env?: NodeJS.ProcessEnv | undefined;
  storedSuiGrpcUrl?: string | undefined;
  storedSuiGraphqlUrl?: string | undefined;
  defaultSuiGrpcUrl?: string | undefined;
  defaultSuiGraphqlUrl?: string | undefined;
};

// Existing shared-backend port: clients using the same data directory must
// agree on this port and configuration. It is not browser-wallet authority.

export const DEFAULT_REVIEW_PORT = 8765;

function parseReviewPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_REVIEW_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SUI_MCP_REVIEW_PORT must be an integer between 1 and 65535, got: ${value}`);
  }
  return port;
}

export function composeRuntimeConfig(input: ComposeRuntimeConfigInput): RuntimeConfig {
  const env = input.env ?? process.env;
  const defaultSuiGrpcUrl = parseGrpcUrl(input.defaultSuiGrpcUrl ?? DEFAULT_SUI_GRPC_URL);
  const defaultSuiGraphqlUrl = parseGraphqlUrl(input.defaultSuiGraphqlUrl ?? DEFAULT_SUI_GRAPHQL_URL);
  const storedValue = parseGrpcUrl(input.storedSuiGrpcUrl ?? defaultSuiGrpcUrl);
  const storedGraphqlValue = parseGraphqlUrl(input.storedSuiGraphqlUrl ?? defaultSuiGraphqlUrl);
  const envValue = env.SUI_MCP_GRPC_URL === undefined ? undefined : parseGrpcUrl(env.SUI_MCP_GRPC_URL);
  const envGraphqlValue = env.SUI_MCP_GRAPHQL_URL === undefined ? undefined : parseGraphqlUrl(env.SUI_MCP_GRAPHQL_URL);
  const suiGrpcUrl = resolveSuiGrpcUrlView({
    defaultSuiGrpcUrl,
    storedValue,
    envValue
  });
  const suiGraphqlUrl = resolveSuiGraphqlUrlView({
    defaultSuiGraphqlUrl,
    storedValue: storedGraphqlValue,
    envValue: envGraphqlValue
  });

  return {
    ...input.bootConfig,
    grpcUrl: suiGrpcUrl.effectiveValue,
    graphqlUrl: suiGraphqlUrl.effectiveValue,
    suiGrpcUrl,
    suiGraphqlUrl
  };
}

export function resolveSuiGrpcUrlView(input: {
  defaultSuiGrpcUrl?: string | undefined;
  storedValue?: string | undefined;
  envValue?: string | undefined;
}): SuiGrpcUrlLocalSettingsView {
  const defaultSuiGrpcUrl = parseGrpcUrl(input.defaultSuiGrpcUrl ?? DEFAULT_SUI_GRPC_URL);
  const storedValue = parseGrpcUrl(input.storedValue ?? defaultSuiGrpcUrl);
  if (input.envValue !== undefined) {
    const effectiveValue = parseGrpcUrl(input.envValue);
    return {
      storedValue,
      effectiveValue,
      source: "environment",
      pendingStoredValue: effectiveValue === storedValue ? undefined : storedValue,
      appliesAfter: effectiveValue === storedValue ? undefined : SETTINGS_APPLIES_AFTER_RESTART
    };
  }

  return {
    storedValue,
    effectiveValue: storedValue,
    source: storedValue === defaultSuiGrpcUrl ? "builtin_default" : "local_db"
  };
}

export function resolveSuiGraphqlUrlView(input: {
  defaultSuiGraphqlUrl?: string | undefined;
  storedValue?: string | undefined;
  envValue?: string | undefined;
}): SuiGraphqlUrlLocalSettingsView {
  const defaultSuiGraphqlUrl = parseGraphqlUrl(input.defaultSuiGraphqlUrl ?? DEFAULT_SUI_GRAPHQL_URL);
  const storedValue = parseGraphqlUrl(input.storedValue ?? defaultSuiGraphqlUrl);
  if (input.envValue !== undefined) {
    const effectiveValue = parseGraphqlUrl(input.envValue);
    return {
      storedValue,
      effectiveValue,
      source: "environment",
      pendingStoredValue: effectiveValue === storedValue ? undefined : storedValue,
      appliesAfter: effectiveValue === storedValue ? undefined : SETTINGS_APPLIES_AFTER_RESTART
    };
  }

  return {
    storedValue,
    effectiveValue: storedValue,
    source: storedValue === defaultSuiGraphqlUrl ? "builtin_default" : "local_db"
  };
}

export { DEFAULT_SUI_GRAPHQL_URL, DEFAULT_SUI_GRPC_URL, SUI_MAINNET_CHAIN_IDENTIFIER };
