#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadBootConfig } from "./config.js";
import { createRuntimeApplication } from "./application.js";
import { createStderrLogger, flushStderr } from "./logger.js";
import { startOrDeferReviewServer, type ReviewServerLifecycle } from "./reviewServerAcquire.js";
import { loadControlIdentity } from "./shared/control.js";
import { probeAuthenticatedServer } from "./shared/authenticatedFetch.js";
import { startSharedServer } from "./shared/server.js";
import { startSharedStdio } from "./shared/stdio.js";
import { RuntimeTermination } from "./runtimeTermination.js";
import { WALLETCONNECT_PROJECT_ID } from "./walletConnectConfig.js";

async function main(): Promise<void> {
  const logger = createStderrLogger("runtime");
  let shared: ReviewServerLifecycle | undefined;
  let bridge: Awaited<ReturnType<typeof startSharedStdio>> | undefined;
  let ready!: () => void, failed!: (reason: unknown) => void;
  const backendReady = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  void backendReady.catch(() => {});
  const termination = new RuntimeTermination({ logger, flush: flushStderr, exit: (code) => process.exit(code),
    close: async () => {
      failed(new Error("Runtime closed before startup completed."));
      const results = await Promise.allSettled([bridge?.close(), shared?.close()]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  });
  let stage = "configuration";
  const stdio = new StdioServerTransport();
  const closeForClient = () => { void termination.request({ kind: "client" }); };
  process.stdin.once("end", closeForClient);
  process.stdin.once("close", closeForClient);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void termination.request({ kind: "signal", code: signal === "SIGINT" ? 130 : 143 }); });
  }
  try {
    const bootConfig = loadBootConfig();
    stage = "control_identity";
    const controlReady = loadControlIdentity(bootConfig.activityDatabasePath, {
      network: bootConfig.network, chainIdentifier: bootConfig.expectedChainIdentifier,
      walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
      grpcOverride: process.env.SUI_GRPC_URL ?? null, graphqlOverride: process.env.SUI_GRAPHQL_URL ?? null
    });
    void controlReady.catch(() => {});
    // The SDK owns stdin from the start, including fragmented initialization
    // and EOF while backend startup is pending. No second reader buffers bytes.
    stage = "stdio_start";
    bridge = await startSharedStdio({ stdio, port: bootConfig.reviewPort, control: controlReady, ready: backendReady,
      onError: (error) => logger.error("MCP transport failed", { error: error.message }) });
    const protocolClosed = stdio.onclose;
    stdio.onclose = () => { protocolClosed?.(); closeForClient(); };
    if (termination.requested) { await bridge.close(); return; }
    stage = "control_identity";
    const control = await controlReady;
    if (termination.requested) return;
    stage = "shared_server_start";
    shared = await startOrDeferReviewServer((port) => startSharedServer({
      port, control,
      createApplication: (instanceId) => createRuntimeApplication(bootConfig, logger, instanceId),
      onError: (error) => logger.error("shared server request failed", { error: error instanceof Error ? error.message : "unknown error" })
    }), bootConfig.reviewPort, {
      probeIdentity: async (port) => {
        try { return await probeAuthenticatedServer(port, control); } catch { return null; }
      },
      delay: (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); }),
      currentPid: process.pid, serviceName: "sui-mcp", logger,
      onFailure: (error) => { void termination.request({ kind: "failure", stage: "owner_acquisition", error }); }
    });
    if (termination.requested) { await shared.close(); return; }
    ready();
  } catch (error) {
    failed(error);
    await termination.request({ kind: "failure", stage, error });
  }
}
void main();
