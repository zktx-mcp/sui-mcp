import { seedReadAddressCleared } from "./fixtures/readAccount.js";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { WalletSdkProcess } from "../src/runtime/walletSdkProcess.js";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { walletRelay, seedWalletSdk, sdkFixtureTopic } from "./fixtures/walletRelay.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";

async function sdkFixture() {
  const relay = await walletRelay(), children: ChildProcess[] = [], commands: string[] = [];
  const f = await settingsWorkflowFixture({ createRuntime: async (directory, context) => {
    await seedWalletSdk(directory, "session", context.account);
    return new WalletSdkProcess({ dataDirectory: directory, projectId: "0".repeat(32),
      metadata: { name: "Recovery integration", description: "Local fixture", url: "https://example.invalid" },
      spawn: () => {
        const child = fork(new URL("./fixtures/walletSdkChild.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env, SUI_MCP_TEST_WALLET_RELAY: relay.url } });
        const send = child.send.bind(child);
        child.send = ((message: { type: string }, callback: (error: Error | null) => void) => { commands.push(message.type); return send(message, callback); }) as ChildProcess["send"];
        children.push(child); return child;
      } });
  } });
  const db = new Database(join(f.wallet.directory, "activity.sqlite"));
  return { f, relay, children, commands, db, async close() { await f.wallet.runtime.close(); db.close(); await f.close(); await relay.close(); } };
}

it.each(["selected", "cleared"] as const)("restores a known approved connection through actual SDK replacement while keeping its %s address provenance", async (selection) => {
  const { f, children, commands, close } = await sdkFixture(), w = f.wallet;
  try {
    const observed = w.runtime.snapshot()!.sessions.find((item) => item.topic === sdkFixtureTopic)!;
    if (observed.status !== "present") throw new Error("The actual SDK session prerequisite is absent");
    // Approval is a declared synthetic journal input, not real wallet UI proof.
    const connection = w.run(() => w.seedConnection(observed.session)).connection;
    if (selection === "cleared") {
      await w.run(() => seedReadAddressCleared(w.activity));
      expect(w.run(() => w.activity.getActiveAccountSync())).toBeUndefined();
    }
    const priorRun = w.runtime.runId, restart = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(restart);
    await vi.waitFor(async () => expect((await f.read(restart)).snapshot.data).toMatchObject({ result: { outcome: "completed" } }), { timeout: 10000 });
    expect(children[0]!.signalCode).toBe("SIGKILL"); expect(children).toHaveLength(2); expect(w.runtime.runId).not.toBe(priorRun);
    const context = w.run(() => w.workflow.reconcileConnectionContext());
    expect(context.connection).toMatchObject({ connectionId: connection.connectionId, status: "connected", chainResults: [{ chainId: "sui:mainnet", status: "bound", address: w.account }] });
    expect(context.connectionReconciliationRequired).toBeUndefined();
    expect(context.assetReadAccount).toEqual(selection === "selected" ? { status: "available", account: w.account } : { status: "address_required", reason: "read_address_cleared" });
    if (selection === "selected") expect(w.run(() => w.activity.getActiveAccountSync())).toMatchObject({ address: w.account, connectionId: connection.connectionId });
    else expect(w.run(() => w.activity.getActiveAccountSync())).toBeUndefined();
    expect(commands.filter((command) => command === "connect" || command === "sign" || command === "disconnect")).toEqual([]);
  } finally { await close(); }
}, 25000);

it.each([false, true])("reconciles a real SDK held disconnect through Settings with next-run storage refusal=%s", async (rejectReservation) => {
  const { f, relay, children, commands, db, close } = await sdkFixture();
  const view = (value: { snapshot: { data?: unknown } }) => value.snapshot.data as SettingsView;
  try {
    // Synthetic prior approval is seeded in the product journal as well as the
    // actual SDK store. This proves recovery, not a new wallet's approval UI.
    const observed = f.wallet.runtime.snapshot()!.sessions.find((item) => item.topic === sdkFixtureTopic)!;
    if (observed.status !== "present") throw new Error("Actual SDK session prerequisite is absent");
    const connection = f.wallet.run(() => f.wallet.seedConnection(observed.session)).connection;
    const manage = await f.wallet.createDisconnection();
    await f.wallet.act(manage, { action: "disconnect", connectionId: connection.connectionId });
    await vi.waitFor(() => expect(relay.calls.some((call) => call.method === "irn_unsubscribe")).toBe(true), { timeout: 10000 });
    expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId))).toMatchObject({ sdkPending: true, connection: { status: "connected" } });
    const first = await f.prepare({ kind: "restart_wallet_service" });
    if (rejectReservation) db.exec("CREATE TRIGGER refuse_next_run BEFORE UPDATE ON settings_operations WHEN NEW.phase='starting' BEGIN SELECT RAISE(ABORT,'next run refused'); END");
    await f.confirm(first);
    await vi.waitFor(() => expect(children[0]!.signalCode).toBe("SIGKILL"), { timeout: 10000 });
    if (rejectReservation) {
      await vi.waitFor(async () => expect(view(await f.read(first)).result?.outcome).toBe("failed"));
      expect(children).toHaveLength(1); expect(f.wallet.runtime.availability().status).toBe("unavailable");
      expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId))).toMatchObject({ sdkPending: false, connection: { status: "failed" } });
      db.exec("DROP TRIGGER refuse_next_run");
      const fresh = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(fresh);
      relay.release(); await vi.waitFor(async () => expect(view(await f.read(fresh)).result?.outcome).toBe("completed"), { timeout: 10000 });
      expect(view(await f.read(first)).result?.outcome).toBe("failed");
    } else {
      relay.release(); await vi.waitFor(async () => expect(view(await f.read(first)).result?.outcome).toBe("completed"), { timeout: 10000 });
    }
    expect(children).toHaveLength(2); expect(commands.filter((command) => command === "disconnect")).toHaveLength(1);
    const context = f.wallet.run(() => f.wallet.workflow.reconcileConnectionContext());
    expect(context.assetReadAccount).toEqual({ status: "address_required" });
    expect(context.connection?.status).toBe("failed");
    const present = f.wallet.runtime.snapshot()!.sessions.find((value) => value.topic === sdkFixtureTopic)?.status === "present";
    if (present) {
      const retry = await f.wallet.createDisconnection();
      expect((await f.wallet.act(retry, { action: "disconnect", connectionId: connection.connectionId })).error).toBeUndefined();
      await vi.waitFor(() => expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId)?.connection.status)).toBe("disconnected"), { timeout: 10000 });
    } else expect(context.canDisconnect).toBe(false);
    await vi.waitFor(() => expect(f.wallet.run(() => f.wallet.records.connection(connection.connectionId)?.sdkPending)).toBe(false));
    const empty = await f.wallet.run(() => f.wallet.cards.create("connect", {}));
    expect(empty.snapshot.data).toMatchObject({ allowedActions: ["cancel", "connect"] });
    expect(commands.filter((command) => command === "connect")).toHaveLength(0);
    expect((await f.wallet.act(empty, { action: "connect" })).error).toBeUndefined();
    await vi.waitFor(() => expect(commands.filter((command) => command === "connect")).toHaveLength(1));
    expect(f.wallet.submit).not.toHaveBeenCalled(); expect(f.wallet.sign).not.toHaveBeenCalled();
  } finally { await close(); }
}, 25000);
