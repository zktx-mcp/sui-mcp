import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { approvedChainResults } from "../../src/core/session/chainAccounts.js";
import type { WalletConnectionRecord, WalletSession } from "../../src/core/session/walletConnection.js";

// Declared synthetic prior product approval for restoration tests. SDK sessions
// alone are deliberately insufficient to create this journal or a default.
export function seedApprovedConnection(databasePath: string, session: WalletSession,
  input: { ownerId: string; runId: string; at: Date; current?: boolean }): WalletConnectionRecord {
  const connection = { connectionId: randomUUID(), status: "connected" as const, revision: 0,
    requestedChains: session.grants.map((grant) => grant.chainId),
    chainResults: approvedChainResults(session.grants.map((grant) => grant.chainId), session.grants), approvedAt: input.at.toISOString(),
    grants: session.grants, lifecycleRevision: 1,
    grantRevisions: { "sui:mainnet": 1, "eip155:1": 1, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 1 },
    createdAt: input.at.toISOString(), updatedAt: input.at.toISOString(), expiresAt: session.expiresAt,
    ...(session.walletName ? { walletName: session.walletName } : {}) };
  const db = new Database(databasePath);
  let epoch = 0;
  try {
    epoch = (db.prepare("SELECT data_epoch FROM settings_control WHERE id=1").get() as { data_epoch: number }).data_epoch;
    db.prepare(`INSERT INTO live_wallet_connections(id,owner_id,run_id,status,revision,topic,connection_json,current_slot,data_epoch)
      VALUES (?,?,?,'connected',0,?,?,?,?)`).run(connection.connectionId,input.ownerId,input.runId,session.topic,JSON.stringify(connection),input.current === false ? null : 1,epoch);
    const account = db.prepare(`INSERT INTO accounts(chain_id,address,first_seen_at,last_used_at,first_source,last_source)
      VALUES (?,?,?,?,'wallet_connection','wallet_connection') ON CONFLICT(chain_id,address) DO NOTHING`);
    for (const result of connection.chainResults) if (result.status === "bound") account.run(result.chainId,result.address,input.at.toISOString(),input.at.toISOString());
  }
  finally { db.close(); }
  return { connection, ownerId: input.ownerId, runId: input.runId, topic: session.topic, sdkPending: false, disconnectPending: false, current: input.current !== false, dataEpoch: epoch, readAddressCleared: false };
}
