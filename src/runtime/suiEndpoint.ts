import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import {
  SUI_MAINNET_CHAIN_IDENTIFIER,
  MAX_SUI_GRAPHQL_URL_LENGTH,
  MAX_SUI_GRPC_URL_LENGTH,
  SuiEndpointError,
  withRpcDeadline, isEndpointAccessDenied,
  parseGraphqlUrl,
  parseGrpcUrl
} from "../core/suiEndpoint.js";
export { MAX_SUI_GRAPHQL_URL_LENGTH, MAX_SUI_GRPC_URL_LENGTH, SuiEndpointError, parseGraphqlUrl, parseGrpcUrl };
export type { SuiEndpointErrorKind } from "../core/suiEndpoint.js";

export { SUI_MAINNET_CHAIN_IDENTIFIER };
export const DEFAULT_SUI_GRPC_URL = "https://fullnode.mainnet.sui.io:443";
export const DEFAULT_SUI_GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";
export const DEFAULT_SUI_GRPC_ENDPOINT_VERIFY_TIMEOUT_MS = 10_000;
export const DEFAULT_SUI_GRAPHQL_ENDPOINT_VERIFY_TIMEOUT_MS = 10_000;

export type VerifyMainnetGrpcEndpointInput = {
  url: string;
  expectedChainIdentifier?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type VerifiedMainnetGrpcEndpoint = {
  client: SuiGrpcClient;
  chainIdentifier: string;
};

export type VerifyMainnetGraphqlEndpointInput = {
  url: string;
  expectedChainIdentifier?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
};

export type VerifiedMainnetGraphqlEndpoint = {
  client: SuiGraphQLClient;
  chainIdentifier: string;
};

export async function verifyMainnetGrpcEndpoint(
  input: VerifyMainnetGrpcEndpointInput
): Promise<VerifiedMainnetGrpcEndpoint> {
  const url = parseGrpcUrl(input.url);
  const expectedChainIdentifier = input.expectedChainIdentifier ?? SUI_MAINNET_CHAIN_IDENTIFIER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_SUI_GRPC_ENDPOINT_VERIFY_TIMEOUT_MS;
  const client = new SuiGrpcClient({
    baseUrl: url,
    network: "mainnet"
  });

  try {
    const chainIdentifier = await withRpcDeadline(timeoutMs, async signal => {
      const response = await client.ledgerService.getServiceInfo({}, { abort: signal, timeout: timeoutMs }).response;
      return response.chainId;
    }, input.signal);

    if (chainIdentifier !== expectedChainIdentifier) {
      throw new SuiEndpointError(
        "chain_identifier_mismatch",
        `Sui chain identifier mismatch: expected mainnet, got ${chainIdentifier}`,
        { expectedChainIdentifier, chainIdentifier, url }
      );
    }

    return { client, chainIdentifier };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "TimeoutError" ||
        typeof error === "object" && error !== null && "code" in error && error.code === "DEADLINE_EXCEEDED") {
      throw new SuiEndpointError("endpoint_timeout", "Sui endpoint verification timed out.", { timeoutMs, url });
    }
    if (isEndpointAccessDenied(error)) {
      throw new SuiEndpointError("endpoint_access_denied", "The configured Sui endpoint denied access.", { url });
    }
    if (typeof error === "object" && error !== null && "code" in error &&
        ["INVALID_ARGUMENT", "UNIMPLEMENTED", "NOT_FOUND", 3, 5, 12].includes(error.code as string | number)) {
      throw new SuiEndpointError("endpoint_invalid_response", "The configured endpoint does not support the Sui chain identity request.", { url });
    }
    if (error instanceof SuiEndpointError) {
      throw error;
    }
    throw new SuiEndpointError(
      "endpoint_unreachable",
      "Could not verify Sui mainnet gRPC endpoint",
      {
        error: error instanceof Error ? error.message : String(error),
        url
      }
    );

  }
}

export async function verifyMainnetGraphqlEndpoint(
  input: VerifyMainnetGraphqlEndpointInput
): Promise<VerifiedMainnetGraphqlEndpoint> {
  const url = parseGraphqlUrl(input.url);
  const expectedChainIdentifier = input.expectedChainIdentifier ?? SUI_MAINNET_CHAIN_IDENTIFIER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_SUI_GRAPHQL_ENDPOINT_VERIFY_TIMEOUT_MS;
  const client = new SuiGraphQLClient({
    url,
    network: "mainnet",
    fetch: async (...args) => {
      const response = await (input.fetch ?? fetch)(...args);
      if (response.status === 401 || response.status === 403) throw new SuiEndpointError("endpoint_access_denied",
        "The configured GraphQL endpoint denied access.", { url });
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status))
        throw new SuiEndpointError("endpoint_invalid_response", "The configured GraphQL endpoint rejected the request.", { url });
      return response;
    }
  });

  try {
    const result = await withRpcDeadline(timeoutMs, signal => client.query<{ chainIdentifier: string }>({
      query: "query SuiMcpChainIdentifier { chainIdentifier }", variables: {}, signal
    }), input.signal);
    // A GraphQL server may report a failed execution in an HTTP 200 response.
    // Only a definitive rejection of this fixed query identifies an incompatible endpoint.
    if (result.errors?.length) {
      const codes = result.errors.map(error => {
        const ext = "extensions" in error ? error.extensions : undefined;
        return ext && typeof ext === "object" && "code" in ext ? ext.code : undefined;
      });
      if (codes.some(code => code === "FORBIDDEN" || code === "UNAUTHENTICATED")) {
        throw new SuiEndpointError("endpoint_access_denied", "The configured GraphQL endpoint denied access.", { url });
      }
      if (codes.every(code => code === "GRAPHQL_VALIDATION_FAILED" || code === "GRAPHQL_PARSE_FAILED")) {
        throw new SuiEndpointError("endpoint_invalid_response", "The configured endpoint rejected the Sui chain identity query.", { url });
      }
      throw new SuiEndpointError("endpoint_unreachable", "The GraphQL service could not complete the Sui chain identity check.", { url });
    }
    const chainIdentifier = result.data?.chainIdentifier;
    if (!chainIdentifier) throw new SuiEndpointError("endpoint_invalid_response", "Sui GraphQL endpoint did not return chainIdentifier", { url });

    if (chainIdentifier !== expectedChainIdentifier) {
      throw new SuiEndpointError(
        "chain_identifier_mismatch",
        `Sui chain identifier mismatch: expected mainnet, got ${chainIdentifier}`,
        { expectedChainIdentifier, chainIdentifier, url }
      );
    }

    return { client, chainIdentifier };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "TimeoutError" ||
        typeof error === "object" && error !== null && "code" in error && error.code === "DEADLINE_EXCEEDED") {
      throw new SuiEndpointError("endpoint_timeout", "Sui endpoint verification timed out.", { timeoutMs, url });
    }
    if (error instanceof SuiEndpointError) {
      throw error;
    }
    throw new SuiEndpointError(
      "endpoint_unreachable",
      "Could not verify Sui mainnet GraphQL endpoint",
      {
        error: error instanceof Error ? error.message : String(error),
        url
      }
    );

  }
}
