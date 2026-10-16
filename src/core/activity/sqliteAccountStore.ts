import { normalizeChainAddress, fixedChainAccount, type WalletChainId } from "../session/chainAccounts.js";
import { walletConnectionSchema } from "../session/walletConnection.js";
import type { AccountRecord, AccountSource, ActiveAccountRecord } from "./activityStore.js";
import { ActivityStoreError, type SqliteDatabase } from "./sqliteActivityStoreTypes.js";

type AccountRow = { id: number; chain_id: WalletChainId; address: string; first_seen_at: string;
  last_used_at: string; first_source: AccountSource; last_source: AccountSource };
// Account history and a read-only projection of the current connection.
export class SqliteAccountStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(chainId: WalletChainId, address: string): AccountRecord | undefined {
    const normalized = normalizeChainAddress(chainId, address);
    if (!normalized) throw new ActivityStoreError("Invalid chain account address");
    const row = this.db.prepare("SELECT * FROM accounts WHERE chain_id=? AND address=?").get(chainId, normalized) as AccountRow | undefined;
    return row && this.account(row);
  }

  upsert(chainId: WalletChainId, address: string, source: AccountSource, timestamp: string): AccountRecord {
    const normalized = normalizeChainAddress(chainId, address);
    if (!normalized) throw new ActivityStoreError("Invalid chain account address");
    this.db.prepare(`INSERT INTO accounts (chain_id,address,first_seen_at,last_used_at,first_source,last_source)
      VALUES (?,?,?,?,?,?) ON CONFLICT(chain_id,address) DO UPDATE SET last_used_at=excluded.last_used_at,last_source=excluded.last_source`)
      .run(chainId, normalized, timestamp, timestamp, source, source);
    return this.get(chainId, normalized)!;
  }

  currentReadAccount(chainId: WalletChainId): ActiveAccountRecord | undefined {
    const row = this.db.prepare(`SELECT connection_json FROM live_wallet_connections
      WHERE current_slot=1 AND read_address_cleared=0 AND data_epoch=(SELECT data_epoch FROM settings_control WHERE id=1)`)
      .get() as { connection_json: string } | undefined;
    if (!row) return undefined;
    const connection = walletConnectionSchema.parse(JSON.parse(row.connection_json));
    const address = fixedChainAccount(connection, chainId);
    if (!address) return undefined;
    const account = this.get(chainId, address);
    if (!account) return undefined;
    return { accountId: account.id, chainId, address, revision: connection.revision, source: "wallet_connection",
      setAt: connection.approvedAt!, connectionId: connection.connectionId,
      ...(connection.walletName ? { walletName: connection.walletName } : {}) };
  }

  private account(row: AccountRow): AccountRecord {
    return { id: row.id, chainId: row.chain_id, address: row.address, firstSeenAt: row.first_seen_at,
      lastUsedAt: row.last_used_at, firstSource: row.first_source, lastSource: row.last_source };
  }
}
