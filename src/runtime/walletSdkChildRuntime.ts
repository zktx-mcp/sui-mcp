import { SERVER_VERSION } from "../mcp/serverInfo.js";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WalletTransport, WalletUnavailableReason } from "../core/session/walletConnection.js";
import { WalletUserRejectedError } from "../core/session/walletConnection.js";
import type { WalletSessionObservation, WalletSessionInspection } from "../core/session/walletRuntime.js";
import { acquireDataDirectoryOwner } from "./shared/ownerLease.js";
import { walletCommandSchema, walletEventSchema, type WalletCommand, type WalletEvent, type WalletInit } from "./walletSdkIpc.js";

// Production and the real-SDK wire fixture run this same process lifecycle.
// The factory is a code dependency, never a serialized command or setting.
export function runWalletSdkChild(createTransport: (input: WalletInit) => Promise<WalletTransport>): void {
  let init: WalletInit | undefined, transport: WalletTransport | undefined;
  let sequence = 0, lastRequest = 0, ready = false, exiting = false;
  let stage: WalletUnavailableReason = "initialization_failed";
  let ownership: ReturnType<typeof acquireDataDirectoryOwner> | undefined;
  const sessions = new Map<string, WalletSessionObservation>();
  const send = (message: WalletEvent) => {
    if (!process.connected || !process.send) { exit(); return; }
    process.send(walletEventSchema.parse(message), (error) => { if (error) exit(); });
  };
  const envelope = () => ({ packageVersion: SERVER_VERSION, runId: init!.runId });
  const exit = () => { if (!exiting) { exiting = true; void ownership; process.exit(0); } };
  const fail = (reason: WalletUnavailableReason) => {
    ready = false;
    if (init && !exiting) send({ ...envelope(), type: "failure", reason });
    // Neither SDK cleanup nor a callback is a prerequisite for process exit.
    if (!exiting) { exiting = true; process.exit(1); }
  };
  process.once("disconnect", exit);
  process.once("SIGTERM", exit); process.once("SIGINT", exit);
  process.on("uncaughtException", () => fail(stage));
  process.on("unhandledRejection", () => fail(stage));
  if (!process.connected) { exit(); return; }
  const inspect = (value: WalletSessionInspection, changedTopic?: string): WalletSessionObservation => {
    const prior = sessions.get(value.topic);
    const priorValue = prior && (prior.status === "present" ? { topic: prior.topic, status: prior.status, session: prior.session } : { topic: prior.topic, status: prior.status });
    const version = (prior?.version ?? 0) + Number(!prior || !isDeepStrictEqual(priorValue, value) || changedTopic === value.topic);
    const next = { ...value, version };
    sessions.set(value.topic, next);
    return next;
  };
  const snapshot = (isReady: boolean, changedTopic?: string, checkTopic?: string) => {
    try {
      if (!ownership || !transport) throw new Error("Wallet storage ownership is unavailable.");
      const values = transport!.inspectAll(), topics = new Set(values.map((item) => item.topic));
      for (const topic of sessions.keys()) if (!topics.has(topic)) values.push({ topic, status: "absent" });
      if (checkTopic && !values.some((item) => item.topic === checkTopic)) values.push(transport!.inspect(checkTopic));
      const value = { runId: init!.runId, sequence: ++sequence, observedAt: new Date().toISOString(),
        sessions: values.map((item) => inspect(item, changedTopic)) };
      send({ ...envelope(), type: "snapshot", snapshot: value, ready: isReady });
      return value;
    } catch {
      fail("wallet_state_unavailable");
      throw new Error("Wallet state inspection failed.");
    }
  };
  const start = async (input: WalletInit) => {
    init = input;
    // The child alone opens the SDK store; OS exit releases this separate lock.
    ownership = acquireDataDirectoryOwner(join(input.dataDirectory, "walletconnect", "sessions.sqlite"));
    send({ ...envelope(), type: "stage", stage: "sdk_start" });
    transport = await createTransport(input);
    stage = "restoration_failed";
    send({ ...envelope(), type: "stage", stage: "session_restore" });
    await transport.restore();
    transport.onSessionChanged((topic, selectionChanged) => {
      try { snapshot(false, selectionChanged ? topic : undefined); } catch { fail("wallet_state_unavailable"); }
    });
    stage = "wallet_state_unavailable";
    snapshot(true); ready = true;
  };
  const command = async (input: Exclude<WalletCommand, WalletInit>) => {
    const reply = { ...envelope(), requestId: input.requestId, operationId: input.operationId };
    try {
      if (!ready || !transport) throw new Error("Wallet service is not ready.");
      switch (input.type) {
        case "connect": {
          const pairing = await transport.connect();
          send({ ...reply, type: "pairing", uri: pairing.uri, expiresAt: pairing.expiresAt });
          const session = await pairing.approval;
          snapshot(false);
          send({ ...reply, type: "connected", session }); return;
        }
        case "disconnect":
          await transport.disconnect(input.topic); snapshot(false);
          send({ ...reply, type: "disconnected" }); return;
        case "check_session": {
          const value = snapshot(false, undefined, input.topic);
          send({ ...reply, type: "checked", sequence: value.sequence, observation: sessions.get(input.topic)! }); return;
        }
        case "sign": {
          snapshot(false, undefined, input.topic);
          const current = sessions.get(input.topic)!;
          if (current.status !== "present" || current.version !== input.sessionVersion ||
              !current.session.accounts.includes(input.account) || !current.session.methods.includes("sui_signTransaction")) {
            send({ ...reply, type: "error", code: "session_changed" }); return;
          }
          const result = await transport.sign(input);
          snapshot(false, undefined, input.topic);
          send({ ...reply, type: "signed", ...result, sessionVersion: sessions.get(input.topic)!.version }); return;
        }
      }
    } catch (error) {
      send({ ...reply, type: "error", code: error instanceof WalletUserRejectedError ? "rejected" : "operation_failed" });
    }
  };
  process.on("message", (raw) => {
    const parsed = walletCommandSchema.safeParse(raw);
    if (!parsed.success) { fail("wallet_state_unavailable"); return; }
    const input = parsed.data;
    if (input.type === "init") {
      if (init) { fail("wallet_state_unavailable"); return; }
      void start(input).catch(() => fail(stage)); return;
    }
    if (!init || input.runId !== init.runId || input.requestId <= lastRequest) return;
    // Reserve before awaiting anything, including a connect approval.
    lastRequest = input.requestId;
    void command(input).catch(() => fail("wallet_state_unavailable"));
  });
}
