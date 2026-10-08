import type Database from "better-sqlite3";
import {
  PreferencesStoreError,
  assertLocalSettingKey,
  type LocalSettingKey,
  type LocalSettingRecord,
  type LocalSettingWriteResult,
  type PreferencesRepository,
  type SuiGraphqlUrlSettingRecord,
  type SuiGrpcUrlSettingRecord
} from "./preferencesStore.js";
import { parseGraphqlUrl, parseGrpcUrl } from "../suiEndpoint.js";

type SqliteDatabase = Database.Database;
type LocalSettingRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

export class SqlitePreferencesRepository implements PreferencesRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async ensureDefaultLocalSettings(defaults: { suiGrpcUrl: string; suiGraphqlUrl: string }, now = new Date()): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO local_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`
    );
    insert.run("suiGrpcUrl", encodeSettingValue("suiGrpcUrl", defaults.suiGrpcUrl), now.toISOString());
    insert.run("suiGraphqlUrl", encodeSettingValue("suiGraphqlUrl", defaults.suiGraphqlUrl), now.toISOString());
  }

  async getSuiGrpcUrl(): Promise<SuiGrpcUrlSettingRecord | undefined> {
    const record = await this.getLocalSetting("suiGrpcUrl");
    return record
      ? {
          key: "suiGrpcUrl",
          value: asSuiGrpcUrlValue(record.value),
          updatedAt: record.updatedAt
        }
      : undefined;
  }

  async getSuiGraphqlUrl(): Promise<SuiGraphqlUrlSettingRecord | undefined> {
    const record = await this.getLocalSetting("suiGraphqlUrl");
    return record
      ? {
          key: "suiGraphqlUrl",
          value: asSuiGraphqlUrlValue(record.value),
          updatedAt: record.updatedAt
        }
      : undefined;
  }

  async setSuiGrpcUrl(url: string, now = new Date()): Promise<LocalSettingWriteResult> {
    const previous = await this.getSuiGrpcUrl();
    const record = await this.setLocalSetting("suiGrpcUrl", url, now);
    return {
      storedValue: asSuiGrpcUrlValue(record.value),
      previousStoredValue: previous?.value,
      updatedAt: record.updatedAt
    };
  }

  async setSuiGraphqlUrl(url: string, now = new Date()): Promise<LocalSettingWriteResult> {
    const previous = await this.getSuiGraphqlUrl();
    const record = await this.setLocalSetting("suiGraphqlUrl", url, now);
    return {
      storedValue: asSuiGraphqlUrlValue(record.value),
      previousStoredValue: previous?.value,
      updatedAt: record.updatedAt
    };
  }

  async resetSuiGrpcUrl(defaultUrl: string, now = new Date()): Promise<LocalSettingWriteResult> {
    return this.setSuiGrpcUrl(defaultUrl, now);
  }

  async resetSuiGraphqlUrl(defaultUrl: string, now = new Date()): Promise<LocalSettingWriteResult> {
    return this.setSuiGraphqlUrl(defaultUrl, now);
  }

  async getLocalSetting(key: string): Promise<LocalSettingRecord | undefined> { return this.getLocalSettingSync(key); }

  getLocalSettingSync(key: string): LocalSettingRecord | undefined {
    const settingKey = assertLocalSettingKey(key);
    const row = this.db
      .prepare(
        `SELECT key, value_json, updated_at
         FROM local_settings
         WHERE key = ?`
      )
      .get(settingKey) as LocalSettingRow | undefined;
    return row ? rowToLocalSetting(row) : undefined;
  }

  async setLocalSetting(key: string, value: unknown, now = new Date()): Promise<LocalSettingRecord> { return this.setLocalSettingSync(key, value, now); }

  setLocalSettingSync(key: string, value: unknown, now = new Date()): LocalSettingRecord {
    const settingKey = assertLocalSettingKey(key);
    this.db
      .prepare(
        `INSERT INTO local_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(settingKey, encodeSettingValue(settingKey, value), now.toISOString());
    const record = this.getLocalSettingSync(settingKey);
    if (!record) {
      throw new PreferencesStoreError("not_recorded", "Local setting was not recorded", { key: settingKey });
    }
    return record;
  }
}

function rowToLocalSetting(row: LocalSettingRow): LocalSettingRecord {
  const key = assertLocalSettingKey(row.key);
  return {
    key,
    value: decodeSettingValue(key, row.value_json),
    updatedAt: row.updated_at
  };
}

function encodeSettingValue(key: LocalSettingKey, value: unknown): string {
  if (key === "suiGrpcUrl") {
    if (typeof value !== "string") {
      throw new PreferencesStoreError("invalid_value", "suiGrpcUrl setting value must be a string", { key });
    }
    return JSON.stringify(parseGrpcUrl(value));
  }
  if (key === "suiGraphqlUrl") {
    if (typeof value !== "string") {
      throw new PreferencesStoreError("invalid_value", "suiGraphqlUrl setting value must be a string", { key });
    }
    return JSON.stringify(parseGraphqlUrl(value));
  }
  throw new PreferencesStoreError("unknown_key", "Unknown local setting key", { key });
}

function decodeSettingValue(key: LocalSettingKey, valueJson: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    throw new PreferencesStoreError("malformed_json", "Malformed local setting JSON", { key });
  }
  if (key === "suiGrpcUrl") {
    return asSuiGrpcUrlValue(parsed);
  }
  if (key === "suiGraphqlUrl") {
    return asSuiGraphqlUrlValue(parsed);
  }
  throw new PreferencesStoreError("unknown_key", "Unknown local setting key", { key });
}

function asSuiGraphqlUrlValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new PreferencesStoreError("invalid_value", "suiGraphqlUrl setting value must be a string", {
      key: "suiGraphqlUrl"
    });
  }
  return parseGraphqlUrl(value);
}

function asSuiGrpcUrlValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new PreferencesStoreError("invalid_value", "suiGrpcUrl setting value must be a string", { key: "suiGrpcUrl" });
  }
  return parseGrpcUrl(value);
}
