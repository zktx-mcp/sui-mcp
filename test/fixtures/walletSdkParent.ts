import { fork } from "node:child_process";
import { WalletSdkProcess } from "../../src/runtime/walletSdkProcess.js";

const directory = process.env.SUI_MCP_TEST_WALLET_DIRECTORY;
if (!directory || !process.send) throw new Error("Isolated parent fixture requires IPC and a directory");
let childPid: number | undefined;
const runtime = new WalletSdkProcess({ dataDirectory: directory, projectId: "0".repeat(32),
  metadata: { name: "Parent fixture", description: "No wallet network", url: "https://example.invalid" },
  spawn: () => {
    const child = fork(new URL("./walletSdkChild.ts", import.meta.url), [], { execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
    childPid = child.pid; return child;
  }
});
process.once("disconnect", () => { void runtime.close().finally(() => process.exit()); });
runtime.start((event) => {
  if (event.type === "snapshot" && event.ready) {
    runtime.publishReady(event.runId); process.send!({ childPid, runId: event.runId });
  }
});
