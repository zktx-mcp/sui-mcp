import { SERVER_VERSION } from "../../src/mcp/serverInfo.js";
import { EventEmitter } from "node:events";
import type { WalletCommand, WalletEvent } from "../../src/runtime/walletSdkIpc.js";

// Synthetic OS/IPC peer only. Product admission, storage and supervisor remain real.
export class WalletSdkPeer extends EventEmitter {
  connected = true; pid = 123; exitCode: number | null = null; signalCode: string | null = null;
  killMode: "exit" | "false" | "throw" | "hold" = "exit";
  kills = 0; commands: WalletCommand[] = [];
  constructor(readonly startup: "ready" | "fail" | "hold") { super(); }
  send(command: WalletCommand, callback: (error: Error | null) => void) {
    this.commands.push(command); callback(null);
    if (command.type !== "init") throw new Error("Unexpected wallet command in the persistence fixture");
    if (this.startup === "hold") return true;
    queueMicrotask(() => this.emit("message", this.startup === "fail"
      ? { packageVersion: SERVER_VERSION, runId: command.runId, type: "failure", reason: "initialization_failed" } satisfies WalletEvent
      : { packageVersion: SERVER_VERSION, runId: command.runId, type: "snapshot", ready: true,
        snapshot: { runId: command.runId, sequence: 1, observedAt: new Date().toISOString(), sessions: [] } } satisfies WalletEvent));
    return true;
  }
  kill() {
    this.kills++;
    if (this.killMode === "throw") throw new Error("Fixture signal failure");
    if (this.killMode === "false") return false;
    if (this.killMode === "exit") queueMicrotask(() => this.finish());
    return true;
  }
  ready() {
    const command = this.commands.find((item) => item.type === "init");
    if (!command) throw new Error("The peer has not been initialized");
    this.emit("message", { packageVersion: SERVER_VERSION, runId: command.runId, type: "snapshot", ready: true,
      snapshot: { runId: command.runId, sequence: 1, observedAt: new Date().toISOString(), sessions: [] } } satisfies WalletEvent);
  }
  finish() { if (this.signalCode) return; this.connected = false; this.signalCode = "SIGKILL"; this.emit("exit", null, "SIGKILL"); }
}
