import { SuiEndpointError } from "../core/suiEndpoint.js";
import type { Logger } from "./logger.js";

// One stdio process owns the shared loopback server. Peers authenticate the
// listener and use its APIs; only a successful bind permits opening SQLite.
export type StartedReviewServerLike = {
  host: "127.0.0.1";
  port: number;
  close(): Promise<void>;
};

export type ReviewServerIdentity = {
  service: string;
  role: string;
  pid: number;
  version?: string;
};

export type ReviewServerLifecycle = {
  // true when a healthy peer owns the port and this instance is deferring to it.
  deferred: boolean;
  // Stop serving (owner) or stop watching for takeover (deferring), closing the
  // server if a deferring instance acquired the port in the meantime.
  close(): Promise<void>;
};

export type StartOrDeferReviewServerDeps = {
  // Identify the current port holder over loopback. Returns null for a foreign
  // process or no answer, in which case we never defer to it.
  probeIdentity: (port: number) => Promise<ReviewServerIdentity | null>;
  delay: (ms: number) => Promise<void>;
  currentPid: number;
  serviceName: string;
  logger: Pick<Logger, "info" | "warn">;
  onFailure?: ((error: Error) => void) | undefined;
  // How often a deferring instance retries binding to detect that the owner exited.
  reacquireIntervalMs?: number;
};

const DEFAULT_REACQUIRE_INTERVAL_MS = 3000;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { code?: string }).code
    : undefined;
}

// Bind the port: returns the server on success, undefined when the port is already
// in use, and rethrows any other (non-EADDRINUSE) startup error.
async function tryStart<T extends StartedReviewServerLike>(
  start: (port: number) => Promise<T>,
  port: number
): Promise<T | undefined> {
  try {
    return await start(port);
  } catch (error) {
    if (errorCode(error) === "EADDRINUSE") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Bind the review server to its fixed port, or defer to a healthy peer already
 * serving it.
 *
 * - Port free → bind and own the single review origin.
 * - Port held by a separate healthy instance of our review server → defer (run no
 *   local server; the peer serves the shared database for every client) and watch for
 *   the owner to exit, then take the origin over. No peer process is signalled.
 * - Port held by anything else (foreign, no identity answer, or our own pid) → clear
 *   error; the origin is never silently reassigned.
 */
export async function startOrDeferReviewServer<T extends StartedReviewServerLike>(
  start: (port: number) => Promise<T>,
  port: number,
  deps: StartOrDeferReviewServerDeps
): Promise<ReviewServerLifecycle> {
  const owned = await tryStart(start, port);
  if (owned) {
    deps.logger.info("review server bound; owning the review origin", { port });
    return { deferred: false, close: () => owned.close() };
  }

  const holder = await deps.probeIdentity(port);
  if (!holder || holder.service !== deps.serviceName || holder.pid === deps.currentPid) {
    throw Object.assign(new Error(
      `Review server port ${port} is already in use by a process that is not a separate ${deps.serviceName} review server. ` +
        `Use the same current runtime and data directory for every client, or choose a different SUI_MCP_REVIEW_PORT. The listener is not replaced automatically.`
    ), { code: "REVIEW_PORT_CONFLICT" });
  }

  deps.logger.info("review port owned by a healthy peer; deferring and watching for takeover", {
    port,
    ownerPid: holder.pid,
    ...(holder.version ? { ownerVersion: holder.version } : {})
  });

  const reacquireIntervalMs = deps.reacquireIntervalMs ?? DEFAULT_REACQUIRE_INTERVAL_MS;
  let stopped = false;
  let acquired: T | undefined;
  const watch = (async () => {
    while (!stopped && !acquired) {
      await deps.delay(reacquireIntervalMs);
      if (stopped || acquired) {
        break;
      }
      let next: T | undefined;
      try { next = await tryStart(start, port); }
      catch (error) {
        // An authenticated prior owner may have closed its port while its SDK
        // still owns private storage. Reuse the existing takeover observation.
        if (typeof error === "object" && error !== null && "code" in error && error.code === "DATA_DIRECTORY_OWNED") continue;
        if (error instanceof SuiEndpointError && (error.kind === "endpoint_unreachable" || error.kind === "endpoint_timeout")) {
          deps.logger.warn("Deferred owner acquisition will retry the unavailable Sui endpoint", { port, reason: error.kind });
          continue;
        }
        throw error;
      }
      if (!next) {
        continue; // a peer still owns the port; keep deferring
      }
      if (stopped) {
        await next.close();
        break;
      }
      acquired = next;
      deps.logger.info("acquired review port after the previous owner exited", { port });
    }
  })();
  watch.catch((error: unknown) => {
    if (!stopped) deps.onFailure?.(error instanceof Error ? error : new Error("Shared server acquisition failed."));
  });

  return {
    deferred: true,
    close: async () => {
      // Stop watching; the loop's stopped-check closes any bind that lands in-flight,
      // so we never await the (possibly mid-delay) watch loop here.
      stopped = true;
      if (acquired) {
        await acquired.close();
      }
    }
  };
}
