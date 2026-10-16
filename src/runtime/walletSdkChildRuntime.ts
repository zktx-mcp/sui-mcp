import { SERVER_VERSION } from "../mcp/serverInfo.js";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WalletTransport, WalletUnavailableReason } from "../core/session/walletConnection.js";
import { WalletUserRejectedError } from "../core/session/walletConnection.js";
import type { WalletSessionObservation, WalletSessionInspection } from "../core/session/walletRuntime.js";
import { acquireDataDirectoryOwner } from "./shared/ownerLease.js";
import { walletCommandSchema, walletEventSchema, type WalletCommand, type WalletEvent, type WalletInit } from "./walletSdkIpc.js";
import { WALLET_CHAINS, comparableGrantScope, initialGrantRevisions, walletGrantAccount, type WalletChainId } from "../core/session/chainAccounts.js";

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
  const inspect = (value: WalletSessionInspection, change?: { topic: string; chains: readonly WalletChainId[] }): WalletSessionObservation => {
    const prior = sessions.get(value.topic);
    const lifecycleChanged = !prior || prior.status !== value.status;
    const lifecycleRevision = (prior?.lifecycleRevision ?? 0) + Number(lifecycleChanged);
    const grantRevisions = { ...(prior?.grantRevisions ?? initialGrantRevisions()) };
    for (const chain of WALLET_CHAINS) {
      const before = prior?.status === "present" ? prior.session.grants.find((grant) => grant.chainId === chain) : undefined;
      const after = value.status === "present" ? value.session.grants.find((grant) => grant.chainId === chain) : undefined;
      if (lifecycleChanged || !isDeepStrictEqual(comparableGrantScope(before), comparableGrantScope(after)) ||
          change?.topic === value.topic && change.chains.includes(chain)) grantRevisions[chain]++;
    }
    const next = { ...value, lifecycleRevision, grantRevisions };
    sessions.set(value.topic, next);
    return next;
  };
  const snapshot = (isReady: boolean, change?: { topic: string; chains: readonly WalletChainId[] }, checkTopic?: string) => {
    try {
      if (!ownership || !transport) throw new Error("Wallet storage ownership is unavailable.");
      const values = transport!.inspectAll(), topics = new Set(values.map((item) => item.topic));
      for (const topic of sessions.keys()) if (!topics.has(topic)) values.push({ topic, status: "absent" });
      if (checkTopic && !values.some((item) => item.topic === checkTopic)) values.push(transport!.inspect(checkTopic));
      const value = { runId: init!.runId, sequence: ++sequence, observedAt: new Date().toISOString(),
        sessions: values.map((item) => inspect(item, change)) };
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
    transport.onSessionChanged((topic, chains) => {
      try { snapshot(false, chains ? { topic, chains } : undefined); } catch { fail("wallet_state_unavailable"); }
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
          const pairing = await transport.connect(input.chains);
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
          if (current.status !== "present" || current.lifecycleRevision !== input.lifecycleRevision ||
              current.grantRevisions[input.chainId] !== input.grantRevision ||
              !walletGrantAccount(current.session.grants, input.chainId, input.account)?.methods.includes("sui_signTransaction")) {
            send({ ...reply, type: "error", code: "session_changed" }); return;
          }
          const result = await transport.sign(input);
          snapshot(false, undefined, input.topic);
          const after = sessions.get(input.topic)!;
          if (after.status !== "present" || after.lifecycleRevision !== input.lifecycleRevision ||
              after.grantRevisions[input.chainId] !== input.grantRevision) {
            send({ ...reply, type: "error", code: "session_changed" }); return;
          }
          send({ ...reply, type: "signed", ...result, chainId: input.chainId,
            lifecycleRevision: after.lifecycleRevision, grantRevision: after.grantRevisions[input.chainId] }); return;
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
