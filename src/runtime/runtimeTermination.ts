import { SuiEndpointError } from "../core/suiEndpoint.js";
import { ActivityDatabaseFormatError } from "../core/activity/sqliteActivityStoreTypes.js";
import type { Logger } from "./logger.js";

export type RuntimeExitCause = { kind: "client" } | { kind: "signal"; code: 130 | 143 } |
  { kind: "failure"; stage: string; error: unknown };

// Keep arbitrary SDK/server exception text, endpoint values and stacks private.
export function runtimeFailureReason(error: unknown, stage: string): string {
  if (error instanceof ActivityDatabaseFormatError) return ActivityDatabaseFormatError.recoveryMessage;
  if (error instanceof SuiEndpointError) return `Sui mainnet endpoint verification failed (${error.kind}). Check the configured endpoint.`;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "DATA_DIRECTORY_OWNED") return "The private data directory is already owned by another wallet runtime.";
  if (code === "REVIEW_PORT_CONFLICT") return "The review port is held by a foreign or incompatible runtime. Use the same runtime, data directory and port for every client.";
  if (code && /^(SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT|ENOSPC|EADDRINUSE)$/.test(code)) return `Local runtime resource access failed (${code}). Check the data directory and listener configuration.`;
  if (stage === "configuration") return "Invalid runtime configuration. Check mainnet, endpoint settings and SUI_MCP_REVIEW_PORT.";
  if (stage === "control_identity") return "The private runtime control identity could not be loaded. Check data directory ownership and permissions.";
  return "The local runtime could not complete this stage. Check local data permissions and runtime configuration.";
}

// Bootstrap alone decides exit intent. Cleanup-induced onclose notifications
// join the same promise; they cannot replace a fatal or signal exit with EOF.
export class RuntimeTermination {
  private closing: Promise<void> | undefined;
  constructor(private readonly options: {
    close(): Promise<void>; logger: Pick<Logger, "error">; flush(): Promise<void>; exit(code: number): void;
  }) {}
  get requested(): boolean { return this.closing !== undefined; }
  request(cause: RuntimeExitCause): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      let code = cause.kind === "signal" ? cause.code : cause.kind === "failure" ? 1 : 0;
      const report = (message: string, stage: string, error: unknown) => {
        try { this.options.logger.error(message, { stage, reason: runtimeFailureReason(error, stage) }); } catch { /* Preserve failure intent even if stderr is unavailable. */ }
      };
      if (cause.kind === "failure") report("fatal runtime error", cause.stage, cause.error);
      try { await this.options.close(); }
      catch (error) {
        if (cause.kind === "client") code = 1;
        report("runtime shutdown failed", "runtime_close", error);
      }
      try { await this.options.flush(); } catch { if (cause.kind === "client") code = 1; }
      this.options.exit(code);
    });
    return this.closing;
  }
}
