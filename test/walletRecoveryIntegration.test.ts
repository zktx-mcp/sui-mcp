import { decrypt, encrypt } from "@walletconnect/utils";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { walletWorkflowFixture } from "./fixtures/walletWorkflow.js";
import { seedWalletSdk, walletRelay, sdkFixtureTopic } from "./fixtures/walletRelay.js";
import { WalletSdkProcess } from "../src/runtime/walletSdkProcess.js";
import type { WalletCommand } from "../src/runtime/walletSdkIpc.js";
import { acquireDataDirectoryOwner } from "../src/runtime/shared/ownerLease.js";

it("ends a held real SDK disconnect on service loss without replay or a card restart", async () => {
  const relay = await walletRelay(), children: ChildProcess[] = [], commands: WalletCommand["type"][] = [];
  const f = await walletWorkflowFixture({ createRuntime: async (directory) => {
    await seedWalletSdk(directory, "session");
    return new WalletSdkProcess({ dataDirectory: directory, projectId: "0".repeat(32),
      metadata: { name: "Integration fixture", description: "Actual SDK on an isolated relay", url: "https://example.invalid" },
      spawn: () => {
        const child = fork(new URL("./fixtures/walletSdkChild.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, SUI_MCP_TEST_WALLET_RELAY: relay.url } });
        const send = child.send.bind(child);
        child.send = ((message: WalletCommand, callback: (error: Error | null) => void) => {
          commands.push(message.type); return send(message, callback);
        }) as ChildProcess["send"];
        children.push(child); return child;
      } });
  } });
  try {
    // A previously approved, known product connection is the independent DB
    // prerequisite. The seeded SDK session alone cannot create one.
    const observed = f.runtime.snapshot()!.sessions.find((item) => item.topic === sdkFixtureTopic)!;
    if (observed.status !== "present") throw new Error("Seeded SDK session is not usable");
    const connection = f.run(() => f.records.restoreConnection(observed.session, f.now())).connection;
    const disconnect = await f.run(() => f.cards.create("connect", { intent: "manage" }));
    expect((await f.act(disconnect, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
    await vi.waitFor(() => expect(relay.calls.filter((call) => call.method === "irn_unsubscribe")).toHaveLength(1));
    expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(true);
    const controls = await f.run(() => f.cards.create("connect", { intent: "manage" }));
    expect((await f.act(controls, { action: "restart_wallet_service" })).error?.code).toBe("invalid_card_input");
    expect(children).toHaveLength(1);
    f.runtime.fail("wallet_state_unavailable");
    await vi.waitFor(() => expect(children[0]!.signalCode).toBe("SIGKILL"));
    await vi.waitFor(() => expect(f.run(() => f.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    expect((await f.read(disconnect)).snapshot.data).toMatchObject({ connection: { status: "failed", reason: expect.stringContaining("could not be confirmed") } });
    const lease = acquireDataDirectoryOwner(join(f.directory, "walletconnect/sessions.sqlite")); lease.close();
    expect(f.runtime.availability().status).toBe("unavailable");
    await f.read(controls); await f.read(controls);
    expect(children).toHaveLength(1);
    expect(relay.calls.filter((call) => call.method === "irn_unsubscribe")).toHaveLength(1);
    // The ordinary workflow fixture's transport is not used by this real SDK.
    // Count the actual parent-to-child dispatch, not that unused transport spy.
    expect(commands.filter((command) => command === "disconnect")).toHaveLength(1);
    expect(commands.filter((command) => command === "connect")).toHaveLength(0);
    expect(commands.filter((command) => command === "sign")).toHaveLength(0);
    expect(f.submit).not.toHaveBeenCalled();
  } finally { await f.runtime.close(); f.close(); await relay.close(); }
}, 30000);

// The external wallet and chain are fixtures. SDK, IPC, SQLite admission,
// parent cryptographic validation and single-submission authority are real.
it.each([false, true])("validates real SDK signing across IPC (wrong signer=%s)", async (wrongSigner) => {
  const relay = await walletRelay(), commands: WalletCommand["type"][] = [], output: string[] = [];
  const f = await walletWorkflowFixture({ createRuntime: async (directory, { account }) => {
    await seedWalletSdk(directory, "session", account);
    return new WalletSdkProcess({ dataDirectory: directory, projectId: "0".repeat(32),
      metadata: { name: "Signing fixture", description: "Independent wallet key", url: "https://example.invalid" },
      spawn: () => {
        const child = fork(new URL("./fixtures/walletSdkChild.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
          stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, SUI_MCP_TEST_WALLET_RELAY: relay.url } });
        child.stdout!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        child.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        const send = child.send.bind(child);
        child.send = ((message: WalletCommand, callback: (error: Error | null) => void) => {
          commands.push(message.type); return send(message, callback);
        }) as ChildProcess["send"];
        return child;
      } });
  } });
  try {
    const observed = f.runtime.snapshot()!.sessions.find((item) => item.topic === sdkFixtureTopic)!;
    if (observed.status !== "present") throw new Error("Seeded session unavailable");
    const connection = f.run(() => f.records.restoreConnection(observed.session, f.now())).connection;
    await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now(), { id: connection.connectionId }));
    const review = await f.prepare(connection.connectionId);
    const requests: { method: string; transaction: string; address: string }[] = [];
    const signatures: string[] = [];
    relay.respondToPublish(async ({ topic, message }) => {
      if (topic !== sdkFixtureTopic) return undefined;
      const request = JSON.parse(decrypt({ symKey: "cd".repeat(32), encoded: message }));
      if (request.method !== "wc_sessionRequest") return undefined;
      const params = request.params.request;
      requests.push({ method: params.method, transaction: params.params.transaction, address: params.params.address });
      const signed = await (wrongSigner ? Ed25519Keypair.generate() : f.accountKey).signTransaction(Buffer.from(params.params.transaction, "base64"));
      signatures.push(signed.signature);
      return encrypt({ symKey: "cd".repeat(32), message: JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { transactionBytes: signed.bytes, signature: signed.signature } }) });
    });
    expect((await f.act(review.card, { action: "request_signature", connectionId: connection.connectionId,
      account: f.account, reviewRevision: review.session.reviewRevision })).error).toBeUndefined();
    await vi.waitFor(() => {
      expect(relay.responseErrors).toEqual([]);
      expect(f.run(() => f.records.currentRequest(review.session.id)?.requestStatus)).toBe(wrongSigner ? "request_failed" : "completed");
    }, { timeout: 10000 });
    const admitted = f.run(() => f.records.currentRequest(review.session.id))!;
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ method: "sui_signTransaction", address: f.account });
    expect(await Transaction.from(requests[0]!.transaction).getDigest()).toBe(admitted.transactionDigest);
    expect(commands.filter((item) => item === "sign")).toHaveLength(1);
    expect(f.submit).toHaveBeenCalledTimes(wrongSigner ? 0 : 1);
    if (!wrongSigner) {
      expect(Buffer.from(f.submit.mock.calls[0]![0]).toString("base64")).toBe(requests[0]!.transaction);
      expect(f.submit.mock.calls[0]![1]).toBe(signatures[0]);
      expect(admitted.execution).toMatchObject({ status: "success", txDigest: admitted.transactionDigest });
    }
    const result = await f.run(() => f.workflow.readReview(review.session.id, true));
    expect(result?.request).toEqual(admitted); expect(f.submit).toHaveBeenCalledTimes(wrongSigner ? 0 : 1);
    expect(JSON.stringify((await f.read(review.card)).snapshot)).not.toContain(signatures[0]);
    expect(output.join("") + JSON.stringify(f.logger.error.mock.calls)).not.toContain(signatures[0]);
    expect(output.join("")).not.toContain(requests[0]!.transaction);
  } finally { await f.runtime.close(); f.close(); await relay.close(); }
}, 30000);
