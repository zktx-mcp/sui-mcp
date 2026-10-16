import { suiGrants } from "./fixtures/walletGrants.js";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { WalletSdkProcess } from "../src/runtime/walletSdkProcess.js";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { WalletSdkPeer } from "./fixtures/walletSdkPeer.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
import { createHash } from "node:crypto";
import { SERVER_VERSION } from "../src/mcp/serverInfo.js";

const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function fixture() {
  const peers: WalletSdkPeer[] = [], starts: ("ready" | "fail" | "hold")[] = [];
  const f = await settingsWorkflowFixture({ createRuntime: (directory) => new WalletSdkProcess({ dataDirectory: directory,
    projectId: "0".repeat(32), metadata: { name: "Settings fixture", description: "Synthetic OS peer", url: "https://example.invalid" },
    spawn: () => { const peer = new WalletSdkPeer(starts.shift() ?? "ready"); peers.push(peer); return peer as unknown as ChildProcess; } }) });
  const db = new Database(join(f.wallet.directory, "activity.sqlite"));
  resources.push(async () => { for (const peer of peers) peer.finish(); await f.wallet.runtime.close(); db.close(); f.close(); });
  return { ...f, peers, starts, db };
}
const data = (value: { snapshot: { data?: unknown } }) => value.snapshot.data as SettingsView;

it("recovers through Settings after actual supervisor exit/reservation, without replay on a duplicate", async () => {
  const f = await fixture(), original = f.wallet.runtime.runId;
  const prepared = await f.prepare({ kind: "restart_wallet_service" });
  await f.confirm(prepared);
  let final = await f.read(prepared);
  await vi.waitFor(async () => { final = await f.read(prepared); expect(data(final).result?.outcome).toBe("completed"); });
  expect(f.peers).toHaveLength(2); expect(f.peers[0]!.signalCode).toBe("SIGKILL");
  expect(data(final).priorRunId).toBe(original); expect(data(final).nextRunId).toBe(f.wallet.runtime.runId);
  expect(f.wallet.runtime.runId).not.toBe(original); expect(f.wallet.runtime.availability().status).toBe("available");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: null, wallet_input_blocked: 0 });
  await f.confirm(prepared); await f.read(prepared);
  expect(f.peers).toHaveLength(2); expect(f.peers[0]!.kills).toBe(1);
});

it("blocks wallet input after restart admission storage failure but performs no kill or spawn", async () => {
  const f = await fixture(), prepared = await f.prepare({ kind: "restart_wallet_service" });
  f.db.exec("CREATE TRIGGER reject_admission BEFORE UPDATE ON settings_operations WHEN NEW.phase='stopping' BEGIN SELECT RAISE(ABORT,'settings admission refused'); END");
  await expect(f.confirm(prepared)).rejects.toThrow("settings admission refused");
  expect(f.peers).toHaveLength(1); expect(f.peers[0]!.kills).toBe(0);
  expect(f.wallet.runtime.availability().status).toBe("unavailable");
  expect(f.wallet.run(() => f.wallet.cardRecords.get(prepared.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
  expect(() => f.wallet.runtime.bind()).toThrow();
});

it("rejects a changed recovery impact without changing service availability", async () => {
  const f = await fixture();
  const connection = f.wallet.run(() => f.wallet.seedConnection({ topic: "recorded-target", grants: suiGrants([f.wallet.account], ["sui_signTransaction"]), expiresAt: new Date(f.wallet.now().getTime() + 60000).toISOString() })).connection;
  const prepared = await f.prepare({ kind: "restart_wallet_service" });
  f.wallet.run(() => f.wallet.records.updateConnection(connection.connectionId, {}, f.wallet.now()));
  expect((await f.confirm(prepared)).error?.code).toBe("card_conflict");
  expect(f.wallet.runtime.availability().status).toBe("available"); expect(f.peers[0]!.kills).toBe(0); expect(f.peers).toHaveLength(1);
});

it("atomically supersedes only a pending startup and transfers the final-operation block", async () => {
  const f = await fixture(); f.starts.push("hold");
  const first = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(first);
  await vi.waitFor(async () => expect(data(await f.read(first)).phase).toBe("starting"));
  const heldRun = f.wallet.runtime.runId;
  const second = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(second);
  await vi.waitFor(async () => expect(data(await f.read(second)).result?.outcome).toBe("completed"));
  const prior = await f.read(first), next = await f.read(second);
  expect(prior.snapshot).toMatchObject({ state: "closed", reason: "cancelled" });
  expect(data(prior)).toMatchObject({ result: { outcome: "superseded" }, supersededByOperationId: data(next).operationId });
  expect(data(next)).toMatchObject({ priorRunId: heldRun, supersedesOperationId: data(prior).operationId });
  expect(f.peers).toHaveLength(3); expect(f.peers[1]!.signalCode).toBe("SIGKILL");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: null, wallet_input_blocked: 0 });
  await f.confirm(first); expect(f.peers).toHaveLength(3);
});

it("retains a known startup failure and its first observation until its result can be stored", async () => {
  const f = await fixture(); f.starts.push("fail");
  const first = await f.prepare({ kind: "restart_wallet_service" });
  f.db.exec("CREATE TRIGGER reject_failure BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'failure record refused'); END");
  await f.confirm(first);
  await vi.waitFor(() => expect(f.wallet.runtime.availability().status).toBe("unavailable"));
  await expect(f.read(first)).rejects.toThrow("failure record refused");
  expect(f.peers).toHaveLength(2);
  f.db.exec("DROP TRIGGER reject_failure");
  const failed = await f.read(first);
  expect(data(failed).result).toMatchObject({ outcome: "failed" });
  const recordedAt = data(failed).result!.recordedAt;
  f.wallet.advance(1000); expect(data(await f.read(first)).result!.recordedAt).toBe(recordedAt);
  const next = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(next);
  await vi.waitFor(async () => expect(data(await f.read(next)).result?.outcome).toBe("completed"));
  expect(data(await f.read(first)).result?.outcome).toBe("failed");
});

it.each(["false", "throw"] as const)("records a Settings stop failure when kill returns %s and requires a fresh explicit attempt", async (mode) => {
  const f = await fixture(); f.peers[0]!.killMode = mode;
  const first = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(first);
  await vi.waitFor(async () => expect(data(await f.read(first)).result?.outcome).toBe("failed"));
  expect(f.peers).toHaveLength(1); expect(f.peers[0]!.signalCode).toBeNull(); expect(f.peers[0]!.kills).toBe(1);
  expect(f.wallet.runtime.availability().status).toBe("unavailable");
  await f.confirm(first); await f.read(first); expect(f.peers[0]!.kills).toBe(1);
  f.peers[0]!.killMode = "exit";
  const fresh = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(fresh);
  await vi.waitFor(async () => expect(data(await f.read(fresh)).result?.outcome).toBe("completed"));
  expect(f.peers).toHaveLength(2); expect(f.peers[0]!.signalCode).toBe("SIGKILL");
  expect(data(await f.read(first)).result?.outcome).toBe("failed");
});

it.each([false, true])("does not spawn after rejected next-run reservation, including failure-result refusal=%s", async (refuseResult) => {
  const f = await fixture(), first = await f.prepare({ kind: "restart_wallet_service" });
  f.db.exec("CREATE TRIGGER reject_next_run BEFORE UPDATE ON settings_operations WHEN NEW.phase='starting' BEGIN SELECT RAISE(ABORT,'next run refused'); END");
  if (refuseResult) f.db.exec("CREATE TRIGGER reject_reservation_failure BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'reservation failure result refused'); END");
  const firstObservedAt = f.wallet.now().toISOString();
  await f.confirm(first);
  if (refuseResult) {
    await vi.waitFor(() => expect(f.wallet.runtime.availability().status).toBe("unavailable"));
    await expect(f.read(first)).rejects.toThrow("reservation failure result refused");
    expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: data(first).operationId,
      wallet_block_operation_id: data(first).operationId, wallet_input_blocked: 1 });
    expect(f.peers).toHaveLength(1); expect(f.peers[0]!.signalCode).toBe("SIGKILL");
    f.wallet.advance(1000); f.db.exec("DROP TRIGGER reject_reservation_failure");
  }
  await vi.waitFor(async () => expect(data(await f.read(first)).result?.outcome).toBe("failed"));
  expect(data(await f.read(first)).result!.recordedAt).toBe(firstObservedAt);
  expect(f.peers).toHaveLength(1); expect(f.peers[0]!.signalCode).toBe("SIGKILL");
  expect(f.wallet.runtime.availability().status).toBe("unavailable");
  await f.confirm(first); await f.read(first); expect(f.peers).toHaveLength(1);
  f.db.exec("DROP TRIGGER reject_next_run");
  const fresh = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(fresh);
  await vi.waitFor(async () => expect(data(await f.read(fresh)).result?.outcome).toBe("completed"));
  expect(f.peers).toHaveLength(2);
});

it("keeps a known-ready startup unavailable while its result cannot commit, then publishes the same observation once", async () => {
  const f = await fixture(), first = await f.prepare({ kind: "restart_wallet_service" });
  f.db.exec("CREATE TRIGGER reject_ready BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' AND json_extract(NEW.result_json,'$.outcome')='completed' BEGIN SELECT RAISE(ABORT,'ready result refused'); END");
  await f.confirm(first);
  await vi.waitFor(() => expect(f.wallet.runtime.availability()).toMatchObject({ status: "initializing", stage: "state_sync" }));
  const observationTime = f.wallet.now().toISOString(), run = f.wallet.runtime.runId;
  expect(f.wallet.run(() => f.records.get(data(first).operationId)?.phase)).toBe("starting");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ wallet_input_blocked: 1, active_operation_id: data(first).operationId });
  await expect(f.read(first)).rejects.toThrow("result could not be saved");
  const second = await f.create();
  await expect(f.act(second, { action: "settings_select", draft: { kind: "restart_wallet_service" } })).rejects.toThrow("result could not be saved");
  expect(f.wallet.run(() => f.wallet.cardRecords.get(second.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  expect(f.peers).toHaveLength(2); expect(f.peers[1]!.kills).toBe(0);
  f.wallet.advance(1000); f.db.exec("DROP TRIGGER reject_ready");
  const finished = await f.read(first);
  expect(data(finished).result).toMatchObject({ outcome: "completed", recordedAt: observationTime });
  expect(f.wallet.runtime.availability()).toMatchObject({ status: "available", walletRunId: run });
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ wallet_input_blocked: 0, active_operation_id: null });
  await f.read(first); expect(f.peers).toHaveLength(2);
});

it("reads a recorded selected connection without falsely diagnosing unrecorded presence before ready publication", async () => {
  const f = await fixture(), w = f.wallet;
  const session = { topic: "known-ready-topic", grants: suiGrants([w.account], ["sui_signTransaction"]), expiresAt: new Date(w.now().getTime() + 60000).toISOString(), walletName: "Known synthetic wallet" };
  const snapshot = (runId: string, sequence: number) => ({ runId, sequence, observedAt: w.now().toISOString(),
    sessions: [{ topic: session.topic, lifecycleRevision: 1, grantRevisions: { "sui:mainnet": 1, "eip155:1": 1, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 1 }, status: "present" as const, session }] });
  f.peers[0]!.emit("message", { packageVersion: SERVER_VERSION, runId: w.runtime.runId, type: "snapshot", ready: false, snapshot: snapshot(w.runtime.runId, 2) });
  // Declared prior journal approval/selection, not a real wallet UI approval.
  const connection = w.run(() => w.seedConnection(session)).connection;
  expect(w.run(() => w.workflow.currentConnectionContext().assetReadAccount)).toEqual({ status: "available", account: w.account });
  f.starts.push("hold");
  const first = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(first);
  await vi.waitFor(() => expect(w.run(() => f.records.get(data(first).operationId)?.phase)).toBe("starting"));
  f.db.exec("CREATE TRIGGER refuse_known_ready BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'known ready refused'); END");
  f.peers[1]!.emit("message", { packageVersion: SERVER_VERSION, runId: w.runtime.runId, type: "snapshot", ready: true, snapshot: snapshot(w.runtime.runId, 1) });
  expect(w.runtime.availability()).toMatchObject({ status: "initializing", stage: "state_sync" });
  const before = w.run(() => ({ control: f.records.control(), record: w.records.connection(connection.connectionId) }));
  const diagnostic = await f.create();
  expect(data(diagnostic).facts).toMatchObject({ walletAvailability: { status: "initializing", stage: "state_sync" }, assetReadAccount: { status: "address_required" } });
  expect(data(diagnostic).facts?.connectionReconciliationRequired).toBeUndefined();
  expect(w.run(() => ({ control: f.records.control(), record: w.records.connection(connection.connectionId) }))).toEqual(before);
  await expect(f.read(first)).rejects.toThrow("result could not be saved");
  expect(f.peers).toHaveLength(2); expect(f.peers[1]!.kills).toBe(0);
  f.db.exec("DROP TRIGGER refuse_known_ready");
  expect(data(await f.read(first)).result?.outcome).toBe("completed");
  expect(w.run(() => w.workflow.currentConnectionContext().assetReadAccount)).toEqual({ status: "available", account: w.account });
  expect(w.run(() => w.activity.getActiveAccountSync()?.connectionId)).toBe(connection.connectionId);
  expect(f.peers).toHaveLength(2); expect(f.peers[1]!.kills).toBe(0);
});

it("rejects supersede before the old child exits without transferring the stopping operation's block", async () => {
  const f = await fixture(); f.peers[0]!.killMode = "hold";
  const first = await f.prepare({ kind: "restart_wallet_service" });
  const preparedBeforeStop = await f.prepare({ kind: "restart_wallet_service" });
  await f.confirm(first);
  expect(data(await f.read(first)).phase).toBe("stopping");
  expect((await f.confirm(preparedBeforeStop)).error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.wallet.cardRecords.get(preparedBeforeStop.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  const second = await f.create();
  const selected = { ...await f.act(second, { action: "settings_select", draft: { kind: "restart_wallet_service" } }), permission: second.permission };
  const refused = await f.act(selected, { action: "settings_prepare", operationId: data(selected).operationId });
  expect(refused.error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: data(first).operationId,
    wallet_input_blocked: 1, wallet_block_operation_id: data(first).operationId });
  expect(f.peers).toHaveLength(1); expect(f.peers[0]!.kills).toBe(1);
  f.peers[0]!.finish();
  await vi.waitFor(async () => expect(data(await f.read(first)).result?.outcome).toBe("completed"));
  expect(f.peers).toHaveLength(2);
});

it("admits only one of two confirmations superseding the same starting run and ignores the retired peer's ready callback", async () => {
  const f = await fixture(); f.starts.push("hold");
  const first = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(first);
  await vi.waitFor(async () => expect(data(await f.read(first)).phase).toBe("starting"));
  const second = await f.prepare({ kind: "restart_wallet_service" }), rival = await f.prepare({ kind: "restart_wallet_service" });
  const results = await Promise.all([f.confirm(second), f.confirm(rival)]);
  expect(results.filter((result) => result.error?.code === "card_conflict")).toHaveLength(1);
  await vi.waitFor(async () => expect(data(await f.read(second)).result?.outcome).toBe("completed"));
  const result = data(await f.read(second)).result;
  const current = structuredClone({ availability: f.wallet.runtime.availability(), snapshot: f.wallet.runtime.snapshot(),
    control: f.wallet.run(() => f.records.control()) });
  expect(current.availability.status).toBe("available");
  const old = f.peers[1]!.commands.find((command) => command.type === "init")!;
  const events = [
    { packageVersion: SERVER_VERSION, runId: old.runId, type: "snapshot", ready: true,
      snapshot: { runId: old.runId, sequence: 1, observedAt: f.wallet.now().toISOString(), sessions: [] } },
    { packageVersion: SERVER_VERSION, runId: old.runId, type: "stage", stage: "sdk_start" },
    { packageVersion: SERVER_VERSION, runId: old.runId, type: "failure", reason: "initialization_failed" }
  ];
  for (const event of events) {
    f.peers[1]!.emit("message", event);
    expect(f.wallet.runtime.availability()).toEqual(current.availability);
    expect(f.wallet.runtime.snapshot()).toEqual(current.snapshot);
    expect(f.wallet.run(() => f.records.control())).toEqual(current.control);
  }
  expect(data(await f.read(first)).result?.outcome).toBe("superseded");
  expect(data(await f.read(second)).result).toEqual(result);
  expect(f.peers).toHaveLength(3); expect(f.wallet.run(() => f.records.control().active_operation_id)).toBeNull();
});

it.each(["ready", "failed"] as const)("rejects a previously prepared supersede confirmation after a known %s result, even without an intervening read", async (outcome) => {
  const f = await fixture(); f.starts.push("hold");
  const first = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(first);
  await vi.waitFor(async () => expect(data(await f.read(first)).phase).toBe("starting"));
  const second = await f.prepare({ kind: "restart_wallet_service" });
  expect(data(second).preparation).toMatchObject({ supersedesOperationId: data(first).operationId, walletRunId: f.wallet.runtime.runId });
  const currentRun = f.wallet.runtime.runId, observedAt = f.wallet.now().toISOString();
  f.db.exec("CREATE TRIGGER reject_known_result BEFORE UPDATE ON settings_operations WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'known result refused'); END");
  if (outcome === "ready") f.peers[1]!.ready();
  else f.peers[1]!.emit("message", { packageVersion: SERVER_VERSION, runId: currentRun, type: "failure", reason: "initialization_failed" });
  // Observed failure itself terminates the failed child. The confirmation must
  // cause no additional termination or replacement, rather than erase that fact.
  const killsAfterEvent = f.peers[1]!.kills;
  expect(killsAfterEvent).toBe(outcome === "ready" ? 0 : 1);
  expect(f.wallet.runtime.availability().status).toBe(outcome === "ready" ? "initializing" : "unavailable");
  // The old prepared input is sent directly: neither read nor re-prepare can
  // settle the known result before the confirmation boundary is exercised.
  await expect(f.confirm(second)).rejects.toThrow(/known result refused|result could not be saved/);
  expect(f.peers).toHaveLength(2); expect(f.peers[1]!.kills).toBe(killsAfterEvent);
  expect(f.wallet.run(() => f.records.control())).toMatchObject({ wallet_input_blocked: 1,
    active_operation_id: data(first).operationId, wallet_block_operation_id: data(first).operationId });
  expect(f.wallet.run(() => f.wallet.cardRecords.get(second.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  f.wallet.advance(1000); f.db.exec("DROP TRIGGER reject_known_result");
  const refused = await f.confirm(second);
  expect(refused.error?.code).toBe("card_conflict");
  const original = data(await f.read(first));
  expect(original.result).toMatchObject({ outcome: outcome === "ready" ? "completed" : "failed", recordedAt: observedAt });
  expect(original.supersededByOperationId).toBeUndefined();
  expect(f.peers).toHaveLength(2); expect(f.peers[1]!.kills).toBe(killsAfterEvent);
  const fresh = await f.prepare({ kind: "restart_wallet_service" }); await f.confirm(fresh);
  await vi.waitFor(async () => expect(data(await f.read(fresh)).result?.outcome).toBe("completed"));
  expect(data(await f.read(first)).result).toEqual(original.result);
});

it.each(["reset", "import"] as const)("preserves pending recovery failure when scoped %s is refused and discards old callbacks only after lawful replacement", async (kind) => {
  const f = await fixture();
  let replacement: Awaited<ReturnType<typeof f.create>>;
  if (kind === "reset") replacement = await f.prepare({ kind: "reset_local_data" });
  else {
    const raw = Buffer.from(JSON.stringify(await f.wallet.run(() => f.localData.exportLocalData(f.wallet.now()))));
    replacement = await f.create(); const permission = replacement.permission;
    const call = async (input: Record<string, unknown>) => { replacement = { ...await f.act(replacement, input), permission }; expect(replacement.error).toBeUndefined(); };
    await call({ action: "settings_select", draft: { kind: "import_local_data" } }); const operationId = data(replacement).operationId;
    await call({ action: "settings_begin_upload", operationId, name: "backup.json", totalSize: raw.length, sha256: createHash("sha256").update(raw).digest("hex") });
    const fileId = data(replacement).file!.fileId;
    await call({ action: "settings_upload_chunk", operationId, fileId, offset: 0, chunkBase64: raw.toString("base64") });
    await call({ action: "settings_seal_upload", operationId, fileId }); await call({ action: "settings_prepare", operationId });
  }
  const first = await f.prepare({ kind: "restart_wallet_service" }), firstId = data(first).operationId, failureTime = f.wallet.now().toISOString();
  f.starts.push("fail");
  f.db.exec(`CREATE TRIGGER refuse_known_failure BEFORE UPDATE ON settings_operations WHEN NEW.operation_id='${firstId}' AND NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'known failure still unwritable'); END`);
  await f.confirm(first); await vi.waitFor(() => expect(f.wallet.runtime.availability().status).toBe("unavailable"));
  const control = f.wallet.run(() => f.records.control());
  expect(control.active_operation_id).toBe(firstId); expect(control.data_epoch).toBe(0);
  expect((await f.confirm(replacement)).error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => f.records.control())).toEqual(control);
  await expect(f.read(first)).rejects.toThrow("known failure still unwritable");
  expect(f.wallet.run(() => f.wallet.cardRecords.get(replacement.snapshot.cardId)?.acceptedInput)).toBeUndefined();
  f.wallet.advance(1000); f.db.exec("DROP TRIGGER refuse_known_failure");
  expect(data(await f.read(first)).result).toMatchObject({ outcome: "failed", recordedAt: failureTime });
  expect(data(await f.confirm(replacement)).result?.outcome).toBe("completed");
  const current = f.wallet.run(() => f.records.control()); expect(current).toMatchObject({ data_epoch: 1, active_operation_id: null, wallet_input_blocked: 0 });
  f.peers[1]!.ready();
  expect(f.wallet.run(() => f.records.control())).toEqual(current); expect(f.peers).toHaveLength(2);
  await expect(f.read(first)).rejects.toThrow("access is unavailable");
  expect(f.wallet.submit).not.toHaveBeenCalled();
});
