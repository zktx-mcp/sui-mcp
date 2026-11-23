import { verifyMainnetGraphqlEndpoint, verifyMainnetGrpcEndpoint } from "../src/runtime/suiEndpoint.js";
import { SuiEndpointError } from "../src/core/suiEndpoint.js";
import { describe, expect, it, vi } from "vitest";
import {
  startOrDeferReviewServer,
  type ReviewServerIdentity,
  type StartedReviewServerLike
} from "../src/runtime/reviewServerAcquire.js";

const SERVICE = "sui-mcp";
const noopLogger = { info() {}, warn() {} };
const noDelay = async () => {};

function startedServer(port = 8765): StartedReviewServerLike & { closed: boolean } {
  const server = {
    host: "127.0.0.1" as const,
    port,
    closed: false,
    close: async () => {
      server.closed = true;
    }
  };
  return server;
}

function addrInUse(): Error {
  return Object.assign(new Error("listen EADDRINUSE 127.0.0.1:8765"), { code: "EADDRINUSE" });
}

function ownIdentity(pid: number): ReviewServerIdentity {
  return { service: SERVICE, role: "review-server", pid };
}

function baseDeps(overrides: Partial<Parameters<typeof startOrDeferReviewServer>[2]> = {}) {
  return {
    probeIdentity: vi.fn(async () => null as ReviewServerIdentity | null),
    delay: noDelay,
    currentPid: 999,
    serviceName: SERVICE,
    logger: noopLogger,
    ...overrides
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("startOrDeferReviewServer", () => {
  it("binds and owns the origin when the port is free", async () => {
    const start = vi.fn(async (port: number) => startedServer(port));
    const deps = baseDeps();

    const lifecycle = await startOrDeferReviewServer(start, 8765, deps);

    expect(lifecycle.deferred).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(deps.probeIdentity).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("defers to a healthy peer that owns the port without signalling it", async () => {
    const start = vi.fn(async () => {
      throw addrInUse();
    });
    let releaseDelay: (() => void) | undefined;
    const deps = baseDeps({
      probeIdentity: vi.fn(async () => ownIdentity(4242)),
      // Hold the watch loop at its first delay so it does not retry during the test.
      delay: () => new Promise<void>((resolve) => {
        releaseDelay = resolve;
      })
    });

    const lifecycle = await startOrDeferReviewServer(start, 8765, deps);

    expect(lifecycle.deferred).toBe(true);
    expect(deps.probeIdentity).toHaveBeenCalledWith(8765);
    expect(start).toHaveBeenCalledTimes(1); // only the initial bind attempt; no aggressive retry/signal

    await lifecycle.close();
    releaseDelay?.(); // let the parked watch loop observe `stopped` and exit cleanly
  });

  it("takes the origin over when the previous owner exits (failover)", async () => {
    const acquiredServer = startedServer(8765);
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw addrInUse(); // initial bind: a peer owns the port -> defer
      }
      return acquiredServer; // owner exited -> the watch loop binds
    });
    const deps = baseDeps({ probeIdentity: vi.fn(async () => ownIdentity(4242)) });

    const lifecycle = await startOrDeferReviewServer(start, 8765, deps);
    expect(lifecycle.deferred).toBe(true);

    await flush(); // let the watch loop run one iteration and acquire the freed port

    await lifecycle.close();
    expect(start.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(acquiredServer.closed).toBe(true); // close() closes the acquired server
  });

  it.each(["endpoint_timeout", "chain_identifier_mismatch"] as const)("handles %s during owner takeover", async kind => {
    const acquired = startedServer(), failure = vi.fn();
    const start = vi.fn<() => Promise<typeof acquired>>().mockRejectedValueOnce(addrInUse())
      .mockRejectedValueOnce(new SuiEndpointError(kind, kind)).mockResolvedValue(acquired);
    const lifecycle = await startOrDeferReviewServer(start, 8765, baseDeps({ probeIdentity: async () => ownIdentity(42), onFailure: failure }));
    await flush();
    expect(start).toHaveBeenCalledTimes(kind === "endpoint_timeout" ? 3 : 2);
    expect(failure).toHaveBeenCalledTimes(kind === "endpoint_timeout" ? 0 : 1);
    await lifecycle.close();
    expect(acquired.closed).toBe(kind === "endpoint_timeout");
  });

  it.each(["graphql", "grpc"] as const)("stops takeover after the installed %s transport reports denied access", async transport => {
    const failure = vi.fn(), denied = vi.fn(async () => new Response("Access denied", { status: 403 }));
    vi.stubGlobal("fetch", denied);
    try {
      const start = vi.fn(async () => {
        if (start.mock.calls.length === 1) throw addrInUse();
        if (transport === "graphql") await verifyMainnetGraphqlEndpoint({ url: "https://example.invalid/graphql" });
        else await verifyMainnetGrpcEndpoint({ url: "https://example.invalid:443" });
        return startedServer();
      });
      const lifecycle = await startOrDeferReviewServer(start, 8765, baseDeps({ probeIdentity: async () => ownIdentity(42), onFailure: failure,
        delay: async () => new Promise(resolve => setTimeout(resolve, 1)) }));
      try {
        await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: "endpoint_access_denied" })));
        expect(start).toHaveBeenCalledTimes(2);
        expect(denied).toHaveBeenCalledOnce();
      } finally { await lifecycle.close(); }
    } finally { vi.unstubAllGlobals(); }
  });

  it("errors when the port is held by a foreign process", async () => {
    const start = vi.fn(async () => {
      throw addrInUse();
    });
    const deps = baseDeps({
      probeIdentity: vi.fn(async () => ({ service: "some-other-app", role: "x", pid: 1 }))
    });

    await expect(startOrDeferReviewServer(start, 8765, deps)).rejects.toThrow(
      /not a separate sui-mcp review server/
    );
  });

  it("errors when the holder does not answer the identity probe", async () => {
    const start = vi.fn(async () => {
      throw addrInUse();
    });
    const deps = baseDeps({ probeIdentity: vi.fn(async () => null) });

    await expect(startOrDeferReviewServer(start, 8765, deps)).rejects.toThrow(
      /not a separate sui-mcp review server/
    );
  });

  it("does not defer to its own process", async () => {
    const start = vi.fn(async () => {
      throw addrInUse();
    });
    const deps = baseDeps({
      currentPid: 777,
      probeIdentity: vi.fn(async () => ownIdentity(777))
    });

    await expect(startOrDeferReviewServer(start, 8765, deps)).rejects.toThrow(
      /not a separate sui-mcp review server/
    );
  });

  it("rethrows non-EADDRINUSE bind errors without probing", async () => {
    const start = vi.fn(async () => {
      throw new Error("verify mainnet endpoint failed");
    });
    const deps = baseDeps();

    await expect(startOrDeferReviewServer(start, 8765, deps)).rejects.toThrow(
      /verify mainnet endpoint failed/
    );
    expect(deps.probeIdentity).not.toHaveBeenCalled();
  });
});
