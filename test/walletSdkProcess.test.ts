import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WalletSdkProcess } from "../src/runtime/walletSdkProcess.js";
import { acquireDataDirectoryOwner } from "../src/runtime/shared/ownerLease.js";
import { openWalletConnectStorage } from "../src/runtime/walletConnectStorage.js";
import { seedWalletSdk, walletRelay, sdkFixtureTopic } from "./fixtures/walletRelay.js";
import { sdkFixtureAccount } from "./fixtures/walletRelay.js";
import { decrypt, encrypt } from "@walletconnect/utils";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(kind?: Parameters<typeof seedWalletSdk>[1]) {
  const directory = mkdtempSync(join(tmpdir(), "say-sdk-child-")), relay = await walletRelay();
  const children: ChildProcess[] = [], output: string[] = [];
  const events: { type?: unknown; keys: string[]; reason?: unknown; stage?: unknown }[] = [];
  if (kind) await seedWalletSdk(directory, kind);
  const runtime = new WalletSdkProcess({ dataDirectory: directory, projectId: "0".repeat(32),
    metadata: { name: "SDK fixture", description: "Isolated relay", url: "https://example.invalid" },
    spawn: () => {
      const child = fork(new URL("./fixtures/walletSdkChild.ts", import.meta.url), [], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, SUI_MCP_TEST_WALLET_RELAY: relay.url, SUI_MCP_TEST_WALLET_SUBSCRIBED_READ: kind && kind !== "session" ? "1" : "0" }
      });
      children.push(child); child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.on("message", (value) => { if (value && typeof value === "object") events.push({ type: "type" in value ? value.type : undefined,
        keys: Object.keys(value), reason: "reason" in value ? value.reason : undefined, stage: "stage" in value ? value.stage : undefined }); });
      return child;
    }
  });
  runtime.start((event) => { if (event.type === "snapshot" && event.ready) runtime.publishReady(event.runId); });
  cleanups.push(async () => { await runtime.close(); await relay.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, relay, runtime, children, output, events };
}

it.each(["inactive_pairing", "expired_pairing", "expired_session", "missing_key_session"] as const)(
  "terminates real SDK %s cleanup and restarts only after actual exit and lease release", async (kind) => {
    const f = await setup(kind);
    await vi.waitFor(() => expect(f.relay.calls.some((call) => call.method === "irn_unsubscribe")).toBe(true), { timeout: 10000 });
    expect(f.runtime.availability().status).toBe("initializing");
    expect(f.children[0]!.exitCode).toBeNull();
    expect(() => acquireDataDirectoryOwner(join(f.directory, "walletconnect/sessions.sqlite"))).toThrow("runtime owner");
    const priorRun = f.runtime.runId;
    f.runtime.fence(priorRun);
    await f.runtime.replace(priorRun, () => {
      expect(f.children[0]!.signalCode).toBe("SIGKILL");
      expect(f.children).toHaveLength(1);
    });
    await vi.waitFor(() => expect(f.runtime.availability().status).toBe("available"), { timeout: 10000 });
    expect(f.children).toHaveLength(2); expect(f.runtime.runId).not.toBe(priorRun);
    // The first unsubscribe removed its persisted subscription before waiting.
    // The same store can finish cleanup without manufacturing that old reply.
    expect(f.runtime.snapshot()?.sessions.some((item) => item.status === "present")).toBe(false);
    expect(f.output.join("")).not.toContain("cd".repeat(32));
  }, 25000);

it("settles an actual SDK disconnect by late response without sending it twice", async () => {
  const f = await setup("session");
  await vi.waitFor(() => expect(f.runtime.availability().status).toBe("available"), { timeout: 10000 });
  const run = f.runtime.bind(); let settled = false;
  const operation = run.disconnect(sdkFixtureTopic, "late-response").then(() => { settled = true; });
  await vi.waitFor(() => expect(f.relay.calls.some((call) => call.method === "irn_unsubscribe")).toBe(true));
  expect(settled).toBe(false); expect(f.runtime.snapshot()?.sessions).toContainEqual(expect.objectContaining({ topic: sdkFixtureTopic, status: "present" }));
  f.relay.release(); await operation;
  expect(f.relay.calls.filter((call) => call.method === "irn_unsubscribe")).toHaveLength(1);
  expect(f.runtime.snapshot()?.sessions).toContainEqual(expect.objectContaining({ topic: sdkFixtureTopic, status: "absent" }));
}, 15000);

it("interrupts an unresponsive real session disconnect at process exit without replay", async () => {
  const f = await setup("session");
  await vi.waitFor(() => expect(f.runtime.availability().status).toBe("available"), { timeout: 10000 });
  const run = f.runtime.bind(), operation = run.disconnect(sdkFixtureTopic, "interrupted-disconnect");
  const rejected = expect(operation).rejects.toThrow("run ended");
  await vi.waitFor(() => expect(f.relay.calls.some((call) => call.method === "irn_unsubscribe")).toBe(true));
  f.runtime.fence(run.runId);
  await f.runtime.replace(run.runId, () => expect(f.children[0]!.signalCode).toBe("SIGKILL"));
  await rejected;
  await vi.waitFor(() => expect(f.runtime.availability().status).toBe("available"), { timeout: 10000 });
  expect(f.relay.calls.filter((call) => call.method === "irn_unsubscribe")).toHaveLength(1);
  expect(f.relay.calls.filter((call) => call.method === "irn_publish")).toHaveLength(1);
}, 25000);

it("ends the SDK child and releases its lease when its actual parent is killed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "say-sdk-parent-")), relay = await walletRelay();
  const parent = fork(new URL("./fixtures/walletSdkParent.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, SUI_MCP_TEST_WALLET_DIRECTORY: directory, SUI_MCP_TEST_WALLET_RELAY: relay.url } });
  const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
  try {
    const report = await new Promise<{ childPid: number }>((resolve) => parent.once("message", (message) => resolve(message as { childPid: number })));
    expect(Number.isSafeInteger(report.childPid)).toBe(true);
    expect(() => acquireDataDirectoryOwner(join(directory, "walletconnect/sessions.sqlite"))).toThrow("runtime owner");
    parent.kill("SIGKILL"); await exited;
    await vi.waitFor(() => {
      expect(() => process.kill(report.childPid, 0)).toThrow();
      const lease = acquireDataDirectoryOwner(join(directory, "walletconnect/sessions.sqlite")); lease.close();
    }, { timeout: 10000 });
  } finally {
    if (parent.connected) parent.disconnect();
    if (parent.exitCode === null && parent.signalCode === null) { parent.kill("SIGKILL"); await exited; }
    await relay.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it("opens a whole committed SDK storage value after killing its writer during repeated native writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "say-sdk-write-crash-"));
  const writer = fork(new URL("./fixtures/walletStorageWriter.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, SUI_MCP_TEST_WALLET_DIRECTORY: directory } });
  const exited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
  try {
    const report = await new Promise<{ committed: number }>((resolve) => writer.once("message", (message) => resolve(message as { committed: number })));
    writer.kill("SIGKILL"); await exited;
    const lease = acquireDataDirectoryOwner(join(directory, "walletconnect/sessions.sqlite"));
    const owner = openWalletConnectStorage(directory);
    try {
      const value = await owner.storage.getItem<Record<string, string>>("wc@2:core:0.3//keychain");
      expect(Object.keys(value!)).toHaveLength(1000);
      expect(new Set(Object.values(value!)).size).toBe(1);
      expect(Number.parseInt(Object.values(value!)[0]!, 16)).toBeGreaterThanOrEqual(report.committed);
    } finally { owner.closeBeforeSdkUse(); lease.close(); }
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) { writer.kill("SIGKILL"); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("returns the real SDK pairing once and interrupts its pending approval only at actual child exit", async () => {
  const f = await setup();
  await vi.waitFor(() => expect(f.runtime.availability().status).toBe("available"), { timeout: 10000 });
  let pairing;
  try { pairing = await f.runtime.bind().connect("new-connection"); }
  catch (error) { throw new Error(JSON.stringify({ availability: f.runtime.availability(), exit: f.children[0]!.exitCode,
    signal: f.children[0]!.signalCode, methods: f.relay.calls.map((call) => call.method), events: f.events }), { cause: error }); }
  expect(pairing.uri).toMatch(/^wc:[a-f0-9]+@2\?/); expect(Date.parse(pairing.expiresAt)).toBeGreaterThan(Date.now());
  const ended = expect(pairing.approval).rejects.toThrow("run ended");
  await f.runtime.close(); await ended;
  expect(f.children[0]!.signalCode).toBe("SIGKILL");
  expect(f.output.join("")).not.toContain(pairing.uri);
}, 15000);

it("carries the exact sign-only request and wallet response through the real SDK and private IPC", async () => {
  const f = await setup("session"), messages: Record<string, any>[] = [];
  f.relay.respondToPublish(({ topic, message }) => {
    if (topic !== sdkFixtureTopic) return undefined;
    const request = JSON.parse(decrypt({ symKey: "cd".repeat(32), encoded: message })) as Record<string, any>;
    messages.push(request);
    if (request.method !== "wc_sessionRequest") return undefined;
    // The wallet is the external test double. The SDK wire encryption and
    // request/response processing are real; this is not signature verification.
    return encrypt({ symKey: "cd".repeat(32), message: JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: { transactionBytes: "AQID", signature: "fixture-wallet-signature" } }) });
  });
  await vi.waitFor(() => expect(f.runtime.availability().status).toBe("available"), { timeout: 10000 });
  const run = f.runtime.bind(), session = await run.checkSession(sdkFixtureTopic, "signature-one");
  const result = await run.sign({ topic: sdkFixtureTopic, account: sdkFixtureAccount, transactionBytesBase64: "AQID", sessionVersion: session.version }, "signature-one");
  expect(messages.filter((message) => message.method === "wc_sessionRequest")).toHaveLength(1);
  expect(messages.find((message) => message.method === "wc_sessionRequest")?.params).toMatchObject({ chainId: "sui:mainnet",
    request: { method: "sui_signTransaction", params: { transaction: "AQID", address: sdkFixtureAccount } } });
  expect(result).toEqual({ transactionBytes: "AQID", signature: "fixture-wallet-signature", sessionVersion: session.version });
  expect(f.output.join("")).not.toMatch(/AQID|fixture-wallet-signature/);
}, 15000);
