import { join } from "node:path";
import { acquireDataDirectoryOwner } from "../../src/runtime/shared/ownerLease.js";
import { openWalletConnectStorage } from "../../src/runtime/walletConnectStorage.js";

const directory = process.env.SUI_MCP_TEST_WALLET_DIRECTORY;
if (!directory || !process.send) throw new Error("Isolated storage fixture requires IPC and a directory");
const lease = acquireDataDirectoryOwner(join(directory, "walletconnect/sessions.sqlite"));
const owner = openWalletConnectStorage(directory);
// Repeated atomic writes keep real SQLite I/O active until the test kills this
// process. The data is synthetic keychain input, never product signing state.
for (let sequence = 1; ; sequence++) {
  const marker = sequence.toString(16).padStart(64, "0");
  const values = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i.toString(16).padStart(64, "0"), marker]));
  await owner.storage.setItem("wc@2:core:0.3//keychain", values);
  process.send({ committed: sequence });
  // Keep the lease strongly reachable for the entire writer lifetime.
  void lease;
}
