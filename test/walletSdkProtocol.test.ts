import { SERVER_VERSION } from "../src/mcp/serverInfo.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { WalletSdkProcess } from "../src/runtime/walletSdkProcess.js";
import type { WalletCommand, WalletEvent } from "../src/runtime/walletSdkIpc.js";
import { sdkFixtureAccount, sdkFixtureTopic } from "./fixtures/walletRelay.js";

// Synthetic OS/IPC peer only. The supervisor and its pending/run checks are
// real; walletSdkProcess tests separately execute real children and real SDK.
class Peer extends EventEmitter {
  connected = true;
  pid = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  held = false;
  kills = 0;
  sent: WalletCommand[] = [];
  send(message: WalletCommand, callback: (error: Error | null) => void) { this.sent.push(message); callback(null); return true; }
  kill() { this.kills++; if (!this.held) queueMicrotask(() => this.finish()); return true; }
  finish() { if (this.signalCode) return; this.connected = false; this.signalCode = "SIGKILL"; this.emit("exit", null, "SIGKILL"); }
  receive(event: WalletEvent) { this.emit("message", event); }
  snapshot(runId: string, sequence: number, version: number, ready = false, account = sdkFixtureAccount) {
    this.receive({ packageVersion: SERVER_VERSION, runId, type: "snapshot", ready, snapshot: { runId, sequence,
      observedAt: "2030-01-01T00:00:00.000Z", sessions: [{ topic: sdkFixtureTopic, status: "present", version, session: {
        topic: sdkFixtureTopic, accounts: [account], methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: "2099-01-01T00:00:00.000Z"
      } }] } });
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture(failPublication = false) {
  const peers: Peer[] = [];
  const runtime = new WalletSdkProcess({ projectId: "0".repeat(32), dataDirectory: "/unused-ipc-fixture",
    metadata: { name: "Fixture", description: "No SDK or files", url: "https://example.invalid" },
    spawn: () => { const peer = new Peer(); peers.push(peer); return peer as unknown as ChildProcess; } });
  let refuse = failPublication;
  runtime.start((event) => {
    if (event.type === "snapshot" && event.ready) {
      if (refuse) throw new Error("Fixture DB publication failed");
      runtime.publishReady(event.runId);
    }
  });
  peers[0]!.snapshot(runtime.runId, 1, 1, true);
  cleanups.push(async () => { for (const peer of peers) { peer.held = false; peer.finish(); } await runtime.close(); });
  return { runtime, peers, allowPublication() { refuse = false; } };
}

it("keeps pending replies until actual exit, ignores the fenced run, and starts one replacement", async () => {
  const f = fixture(), peer = f.peers[0]!, run = f.runtime.bind();
  peer.held = true;
  const operation = run.disconnect(sdkFixtureTopic, "disconnect-one");
  let ended = false; void operation.catch(() => { ended = true; });
  const rejection = expect(operation).rejects.toThrow("run ended");
  const request = peer.sent[1]!;
  expect(request).toMatchObject({ type: "disconnect", requestId: 1, operationId: "disconnect-one", runId: run.runId });
  f.runtime.fence(run.runId);
  const replacing = f.runtime.replace(run.runId, () => expect(peer.signalCode).toBe("SIGKILL"));
  peer.receive({ packageVersion: SERVER_VERSION, runId: run.runId, type: "disconnected", requestId: 1, operationId: "disconnect-one" });
  await Promise.resolve(); expect(ended).toBe(false); expect(f.peers).toHaveLength(1);
  peer.finish(); await rejection; await replacing;
  expect(f.peers).toHaveLength(2); expect(peer.kills).toBe(1);
  f.peers[1]!.snapshot(f.runtime.runId, 1, 1, true);
  expect(() => run.assertCurrent()).toThrow("run ended"); expect(f.runtime.availability().status).toBe("available");
});

it("does not use a check response superseded by a newer session observation", async () => {
  const f = fixture(), peer = f.peers[0]!, run = f.runtime.bind();
  const pending = run.checkSession(sdkFixtureTopic, "final-check");
  const refused = expect(pending).rejects.toThrow("changed during confirmation");
  peer.snapshot(run.runId, 2, 2, false, `0x${"d".repeat(64)}`);
  peer.receive({ packageVersion: SERVER_VERSION, runId: run.runId, type: "checked", requestId: 1, operationId: "final-check", sequence: 1,
    observation: { topic: sdkFixtureTopic, version: 1, status: "present", session: { topic: sdkFixtureTopic, accounts: [sdkFixtureAccount],
      methods: ["sui_signTransaction"], chain: "sui:mainnet", expiresAt: "2099-01-01T00:00:00.000Z" } } });
  await refused;
  expect(peer.sent.filter((message) => message.type === "sign")).toHaveLength(0);
});

it("rejects inconsistent observation versions while duplicates cannot mutate current state", async () => {
  const f = fixture(), peer = f.peers[0]!, run = f.runtime.runId;
  const before = f.runtime.snapshot();
  peer.snapshot(run, 1, 1, true, `0x${"e".repeat(64)}`);
  expect(f.runtime.snapshot()).toEqual(before); expect(peer.kills).toBe(0);
  peer.snapshot(run, 2, 1, false, `0x${"e".repeat(64)}`);
  expect(f.runtime.availability().status).toBe("unavailable"); expect(peer.kills).toBe(1);
});

it("retries database publication from the same ready observation without another child or init", () => {
  const f = fixture(true);
  expect(f.runtime.availability()).toMatchObject({ status: "initializing", stage: "state_sync" });
  expect(() => f.runtime.bind()).toThrow();
  f.allowPublication(); f.runtime.synchronize();
  expect(f.runtime.availability().status).toBe("available"); expect(f.peers).toHaveLength(1);
  expect(f.peers[0]!.sent.map((message) => message.type)).toEqual(["init"]);
});
