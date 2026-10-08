import {
  SETTINGS_APPLIES_AFTER_RESTART,
  type LocalSettingsService,
  type LocalSettingsView,
  type SuiGraphqlUrlLocalSettingsView,
  type SuiGrpcUrlLocalSettingsView,
  LocalSettingsError,
  type LocalSettingsWriteResponse,
  type LocalSettingRecord,
  type PreferencesRepository
} from "../core/preferences/preferencesStore.js";
import {
  DEFAULT_SUI_GRAPHQL_ENDPOINT_VERIFY_TIMEOUT_MS,
  DEFAULT_SUI_GRAPHQL_URL,
  DEFAULT_SUI_GRPC_ENDPOINT_VERIFY_TIMEOUT_MS,
  DEFAULT_SUI_GRPC_URL,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  SuiEndpointError,
  parseGraphqlUrl,
  parseGrpcUrl,
  verifyMainnetGraphqlEndpoint,
  verifyMainnetGrpcEndpoint
} from "./suiEndpoint.js";
import { resolveSuiGraphqlUrlView, resolveSuiGrpcUrlView } from "./config.js";

export type RuntimeLocalSettingsServiceOptions = {
  preferencesRepository: PreferencesRepository;
  env?: NodeJS.ProcessEnv | undefined;
  defaultSuiGrpcUrl?: string | undefined;
  defaultSuiGraphqlUrl?: string | undefined;
  bootSuiGrpcUrl?: SuiGrpcUrlLocalSettingsView | undefined;
  bootSuiGraphqlUrl?: SuiGraphqlUrlLocalSettingsView | undefined;
  verifyGrpcEndpoint?: ((url: string) => Promise<void>) | undefined;
  verifyGraphqlEndpoint?: ((url: string) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
};

export class RuntimeLocalSettingsService implements LocalSettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultSuiGrpcUrl: string;
  private readonly defaultSuiGraphqlUrl: string;
  private readonly bootSuiGrpcUrl: SuiGrpcUrlLocalSettingsView;
  private readonly bootSuiGraphqlUrl: SuiGraphqlUrlLocalSettingsView;
  private readonly verifyGrpcEndpoint: (url: string) => Promise<void>;
  private readonly verifyGraphqlEndpoint: (url: string) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: RuntimeLocalSettingsServiceOptions) {
    this.env = options.env ?? process.env;
    this.defaultSuiGrpcUrl = parseGrpcUrl(options.defaultSuiGrpcUrl ?? DEFAULT_SUI_GRPC_URL);
    this.defaultSuiGraphqlUrl = parseGraphqlUrl(options.defaultSuiGraphqlUrl ?? DEFAULT_SUI_GRAPHQL_URL);
    this.bootSuiGrpcUrl = normalizeBootSuiGrpcUrlView(
      options.bootSuiGrpcUrl ??
        resolveSuiGrpcUrlView({
          defaultSuiGrpcUrl: this.defaultSuiGrpcUrl,
          envValue: this.env.SUI_GRPC_URL
        })
    );
    this.bootSuiGraphqlUrl = normalizeBootSuiGraphqlUrlView(
      options.bootSuiGraphqlUrl ??
        resolveSuiGraphqlUrlView({
          defaultSuiGraphqlUrl: this.defaultSuiGraphqlUrl,
          envValue: this.env.SUI_GRAPHQL_URL
        })
    );
    this.verifyGrpcEndpoint = options.verifyGrpcEndpoint ?? defaultGrpcEndpointVerifier;
    this.verifyGraphqlEndpoint = options.verifyGraphqlEndpoint ?? defaultGraphqlEndpointVerifier;
    this.now = options.now ?? (() => new Date());
  }

  async getLocalSettings(): Promise<LocalSettingsView> {
    const stored = await this.options.preferencesRepository.getSuiGrpcUrl();
    const storedGraphql = await this.options.preferencesRepository.getSuiGraphqlUrl();
    return this.settingsFromStored(stored?.value, storedGraphql?.value);
  }

  getLocalSettingsSync(read: (key: "suiGrpcUrl" | "suiGraphqlUrl") => LocalSettingRecord | undefined): LocalSettingsView {
    const grpc = read("suiGrpcUrl"), graphql = read("suiGraphqlUrl");
    if (grpc && typeof grpc.value !== "string" || graphql && typeof graphql.value !== "string") throw new LocalSettingsError("internal_error", "Stored endpoints are invalid.");
    return this.settingsFromStored(grpc?.value as string | undefined, graphql?.value as string | undefined);
  }

  private settingsFromStored(stored: string | undefined, storedGraphql: string | undefined): LocalSettingsView {
    const currentStoredView = resolveSuiGrpcUrlView({
      defaultSuiGrpcUrl: this.defaultSuiGrpcUrl,
      storedValue: stored,
      envValue: this.env.SUI_GRPC_URL
    });
    const currentStoredGraphqlView = resolveSuiGraphqlUrlView({
      defaultSuiGraphqlUrl: this.defaultSuiGraphqlUrl,
      storedValue: storedGraphql,
      envValue: this.env.SUI_GRAPHQL_URL
    });
    return {
      suiGrpcUrl: withBootEffectiveEndpoint(currentStoredView, this.bootSuiGrpcUrl),
      suiGraphqlUrl: withBootEffectiveEndpoint(currentStoredGraphqlView, this.bootSuiGraphqlUrl)
    };
  }

  // The same side-effect-free target resolution serves display and final
  // verification. Default URLs belong to this service, never to the View.
  resolveEndpointChange(input: { kind: "set_endpoint" | "restore_endpoint"; endpoint: "grpc" | "graphql"; value?: string }):
    { key: "suiGrpcUrl" | "suiGraphqlUrl"; value: string; status: "saved" | "reset" } {
    const value = input.kind === "restore_endpoint"
      ? input.endpoint === "grpc" ? this.defaultSuiGrpcUrl : this.defaultSuiGraphqlUrl
      : input.endpoint === "grpc" ? parseEndpointForTool(input.value ?? "") : parseGraphqlEndpointForTool(input.value ?? "");
    return { key: input.endpoint === "grpc" ? "suiGrpcUrl" : "suiGraphqlUrl", value,
      status: input.kind === "restore_endpoint" ? "reset" : "saved" };
  }

  // Verification does not store a value or change this parent's effective URL.
  async prepareEndpointChange(input: { kind: "set_endpoint" | "restore_endpoint"; endpoint: "grpc" | "graphql"; value?: string }) {
    const target = this.resolveEndpointChange(input);
    await this.verifyEndpointForTool(target.value, input.endpoint);
    return target;
  }

  async setSuiGrpcUrl(url: string): Promise<LocalSettingsWriteResponse> {
    const normalized = parseEndpointForTool(url);
    await this.verifyEndpointForTool(normalized, "grpc");
    const result = await this.options.preferencesRepository.setSuiGrpcUrl(normalized, this.now());
    return {
      status: "saved",
      storedValue: result.storedValue,
      previousStoredValue: result.previousStoredValue,
      appliesAfter: SETTINGS_APPLIES_AFTER_RESTART
    };
  }

  async setSuiGraphqlUrl(url: string): Promise<LocalSettingsWriteResponse> {
    const normalized = parseGraphqlEndpointForTool(url);
    await this.verifyEndpointForTool(normalized, "graphql");
    const result = await this.options.preferencesRepository.setSuiGraphqlUrl(normalized, this.now());
    return {
      status: "saved",
      storedValue: result.storedValue,
      previousStoredValue: result.previousStoredValue,
      appliesAfter: SETTINGS_APPLIES_AFTER_RESTART
    };
  }

  async resetSuiGrpcUrl(): Promise<LocalSettingsWriteResponse> {
    const result = await this.options.preferencesRepository.resetSuiGrpcUrl(this.defaultSuiGrpcUrl, this.now());
    return {
      status: "reset",
      storedValue: result.storedValue,
      previousStoredValue: result.previousStoredValue,
      appliesAfter: SETTINGS_APPLIES_AFTER_RESTART
    };
  }

  async resetSuiGraphqlUrl(): Promise<LocalSettingsWriteResponse> {
    const result = await this.options.preferencesRepository.resetSuiGraphqlUrl(this.defaultSuiGraphqlUrl, this.now());
    return {
      status: "reset",
      storedValue: result.storedValue,
      previousStoredValue: result.previousStoredValue,
      appliesAfter: SETTINGS_APPLIES_AFTER_RESTART
    };
  }

  private async verifyEndpointForTool(url: string, transport: "grpc" | "graphql"): Promise<void> {
    try {
      await (transport === "grpc" ? this.verifyGrpcEndpoint(url) : this.verifyGraphqlEndpoint(url));
    } catch (error) {
      if (error instanceof LocalSettingsError) {
        throw error;
      }
      if (error instanceof SuiEndpointError) {
        throw endpointErrorForTool(error, transport);
      }
      const label = transport === "grpc" ? "gRPC" : "GraphQL";
      throw new LocalSettingsError("internal_error", `Sui ${label} endpoint verification failed`, {
        message: `Sui ${label} endpoint verification failed`
      });
    }
  }
}

function normalizeBootSuiGrpcUrlView(view: SuiGrpcUrlLocalSettingsView): SuiGrpcUrlLocalSettingsView {
  return {
    ...view,
    storedValue: parseGrpcUrl(view.storedValue),
    effectiveValue: parseGrpcUrl(view.effectiveValue)
  };
}

function normalizeBootSuiGraphqlUrlView(view: SuiGraphqlUrlLocalSettingsView): SuiGraphqlUrlLocalSettingsView {
  return {
    ...view,
    storedValue: parseGraphqlUrl(view.storedValue),
    effectiveValue: parseGraphqlUrl(view.effectiveValue)
  };
}

function withBootEffectiveEndpoint(
  storedView: SuiGrpcUrlLocalSettingsView,
  bootView: SuiGrpcUrlLocalSettingsView
): SuiGrpcUrlLocalSettingsView;
function withBootEffectiveEndpoint(
  storedView: SuiGraphqlUrlLocalSettingsView,
  bootView: SuiGraphqlUrlLocalSettingsView
): SuiGraphqlUrlLocalSettingsView;
function withBootEffectiveEndpoint(
  storedView: SuiGrpcUrlLocalSettingsView | SuiGraphqlUrlLocalSettingsView,
  bootView: SuiGrpcUrlLocalSettingsView | SuiGraphqlUrlLocalSettingsView
): SuiGrpcUrlLocalSettingsView | SuiGraphqlUrlLocalSettingsView {
  if (storedView.effectiveValue === bootView.effectiveValue) {
    return storedView;
  }
  return {
    storedValue: storedView.storedValue,
    effectiveValue: bootView.effectiveValue,
    source: bootView.source,
    pendingStoredValue: storedView.storedValue === bootView.effectiveValue ? undefined : storedView.storedValue,
    appliesAfter: SETTINGS_APPLIES_AFTER_RESTART
  };
}

async function defaultGrpcEndpointVerifier(url: string): Promise<void> {
  await verifyMainnetGrpcEndpoint({
    url,
    expectedChainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
    timeoutMs: DEFAULT_SUI_GRPC_ENDPOINT_VERIFY_TIMEOUT_MS
  });
}

async function defaultGraphqlEndpointVerifier(url: string): Promise<void> {
  await verifyMainnetGraphqlEndpoint({
    url,
    expectedChainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
    timeoutMs: DEFAULT_SUI_GRAPHQL_ENDPOINT_VERIFY_TIMEOUT_MS
  });
}

function parseEndpointForTool(url: string): string {
  try {
    return parseGrpcUrl(url);
  } catch (error) {
    if (error instanceof SuiEndpointError) {
      throw endpointErrorForTool(error, "grpc");
    }
    throw error;
  }
}

function parseGraphqlEndpointForTool(url: string): string {
  try {
    return parseGraphqlUrl(url);
  } catch (error) {
    if (error instanceof SuiEndpointError) {
      throw endpointErrorForTool(error, "graphql");
    }
    throw error;
  }
}

function endpointErrorForTool(error: SuiEndpointError, transport: "grpc" | "graphql"): LocalSettingsError {
  const label = transport === "grpc" ? "gRPC" : "GraphQL";
  if (error.kind === "chain_identifier_mismatch") {
    return new LocalSettingsError("input_invalid", `Sui ${label} endpoint did not report the mainnet chain identifier`, {
      reason: error.kind,
      ...endpointErrorDetailsForTool(error, ["chainIdentifier", "expectedChainIdentifier"])
    });
  }
  if (error.kind === "endpoint_timeout" || error.kind === "endpoint_unreachable") {
    return new LocalSettingsError("input_invalid", `Sui ${label} endpoint could not be verified`, {
      reason: error.kind,
      ...endpointErrorDetailsForTool(error, error.kind === "endpoint_timeout" ? ["timeoutMs"] : [])
    });
  }
  return new LocalSettingsError("input_invalid", error.message, {
    reason: error.kind
  });
}

function endpointErrorDetailsForTool(error: SuiEndpointError, allowedKeys: string[]): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const value = error.details[key];
    if (value !== undefined) {
      details[key] = value;
    }
  }
  return details;
}
