import type { ToolErrorKind } from "../action/types.js";
import type { WalletChainId } from "../session/chainAccounts.js";

export const LOCAL_SETTING_KEYS = ["suiGrpcUrl", "suiGraphqlUrl", "walletConnectionChains"] as const;
export type LocalSettingKey = (typeof LOCAL_SETTING_KEYS)[number];
export const SETTINGS_APPLIES_AFTER_RESTART = "mcp_server_restart";

export type LocalSettingRecord = {
  key: LocalSettingKey;
  value: unknown;
  updatedAt: string;
};

export type SuiGrpcUrlSettingRecord = {
  key: "suiGrpcUrl";
  value: string;
  updatedAt: string;
};

export type SuiGraphqlUrlSettingRecord = {
  key: "suiGraphqlUrl";
  value: string;
  updatedAt: string;
};

export type LocalSettingWriteResult = {
  storedValue: string;
  previousStoredValue?: string | undefined;
  updatedAt: string;
};

export type LocalSettingsSource = "environment" | "local_db" | "builtin_default";

export type SuiGrpcUrlLocalSettingsView = {
  storedValue: string;
  effectiveValue: string;
  source: LocalSettingsSource;
  pendingStoredValue?: string | undefined;
  appliesAfter?: typeof SETTINGS_APPLIES_AFTER_RESTART | undefined;
};

export type SuiGraphqlUrlLocalSettingsView = {
  storedValue: string;
  effectiveValue: string;
  source: LocalSettingsSource;
  pendingStoredValue?: string | undefined;
  appliesAfter?: typeof SETTINGS_APPLIES_AFTER_RESTART | undefined;
};

export type LocalSettingsView = {
  suiGrpcUrl: SuiGrpcUrlLocalSettingsView;
  suiGraphqlUrl: SuiGraphqlUrlLocalSettingsView;
  walletConnectionChains: WalletChainId[];
};

export type LocalSettingsWriteResponse = {
  status: "saved" | "reset";
  storedValue: string;
  previousStoredValue?: string | undefined;
  appliesAfter: typeof SETTINGS_APPLIES_AFTER_RESTART;
};

export type PreferencesStoreErrorKind = "unknown_key" | "malformed_json" | "invalid_value" | "not_recorded";

export interface PreferencesRepository {
  ensureDefaultLocalSettings(defaults: { suiGrpcUrl: string; suiGraphqlUrl: string }, now?: Date): Promise<void>;
  getSuiGrpcUrl(): Promise<SuiGrpcUrlSettingRecord | undefined>;
  getSuiGraphqlUrl(): Promise<SuiGraphqlUrlSettingRecord | undefined>;
  setSuiGrpcUrl(url: string, now?: Date): Promise<LocalSettingWriteResult>;
  setSuiGraphqlUrl(url: string, now?: Date): Promise<LocalSettingWriteResult>;
  resetSuiGrpcUrl(defaultUrl: string, now?: Date): Promise<LocalSettingWriteResult>;
  resetSuiGraphqlUrl(defaultUrl: string, now?: Date): Promise<LocalSettingWriteResult>;
  getLocalSetting(key: string): Promise<LocalSettingRecord | undefined>;
  setLocalSetting(key: string, value: unknown, now?: Date): Promise<LocalSettingRecord>;
}

export interface LocalSettingsService {
  getLocalSettings(): Promise<LocalSettingsView>;
  setSuiGrpcUrl(url: string): Promise<LocalSettingsWriteResponse>;
  setSuiGraphqlUrl(url: string): Promise<LocalSettingsWriteResponse>;
  resetSuiGrpcUrl(): Promise<LocalSettingsWriteResponse>;
  resetSuiGraphqlUrl(): Promise<LocalSettingsWriteResponse>;
}

export class PreferencesStoreError extends Error {
  constructor(
    readonly kind: PreferencesStoreErrorKind,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export class LocalSettingsError extends Error {
  constructor(
    readonly kind: Extract<ToolErrorKind, "input_invalid" | "internal_error">,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export function assertLocalSettingKey(key: string): LocalSettingKey {
  if (key === "suiGrpcUrl" || key === "suiGraphqlUrl" || key === "walletConnectionChains") {
    return key;
  }
  throw new PreferencesStoreError("unknown_key", "Unknown local setting key", { key });
}
