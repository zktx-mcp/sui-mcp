import type Database from "better-sqlite3";
import type { ZodType } from "zod";
import type { AdapterLifecycleValidator } from "../action/adapterLifecycleValidation.js";

export class ActivityStoreError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class ActivityDatabaseFormatError extends ActivityStoreError {
  static readonly recoveryMessage =
    "Local database format does not match this runtime. Data migration is not supported. " +
    "The existing database was not modified or deleted. Stop Sui MCP in every app, then follow " +
    "docs/MCP_SETUP.md#database-format-mismatch. Keep the old data and use a new empty SUI_MCP_DATA_DIR, " +
    "or explicitly choose to delete the old local data and settings before restarting.";

  constructor() {
    super(ActivityDatabaseFormatError.recoveryMessage);
  }
}

export type SqliteActivityStoreOptions = {
  databasePath: string;
  validateAdapterLifecycle: AdapterLifecycleValidator;
  guardDatabase?: ((database: SqliteDatabase) => SqliteDatabase) | undefined;
};

export type SqliteDatabase = Database.Database;
export type EvidenceSchema = ZodType<unknown>;
