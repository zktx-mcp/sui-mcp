import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeCoinType, type WalletBalanceWithUnit } from "./coinMetadata.js";
import {
  MAX_WALLET_BALANCE_SCAN_PAGES,
  ReadServiceCacheError,
  type IntentEvidenceBlockedReason,
  type SuiReadCoreClient,
  type AccountInventorySummary,
  type AccountNft,
  type AccountObjectGroup,
  type WalletBalanceInput
} from "./readServiceTypes.js";

// Account inventory object scan: pages of listOwnedObjects to walk (50 objects per
// page) and the max NFTs to surface. A coin-heavy account may truncate before all
// objects are seen; the snapshot flags that rather than paging unbounded.
const ACCOUNT_OBJECT_SCAN_PAGES = 6;
const ACCOUNT_DISPLAY_LIMIT = 60;

export class AccountInventoryReader {
  constructor(private readonly client: SuiReadCoreClient,
    private readonly withUnit: (balance: SuiClientTypes.Balance) => Promise<WalletBalanceWithUnit>,
    private readonly fetchedAt: () => string) {}

  async summarizeAccountInventory(input: WalletBalanceInput): Promise<AccountInventorySummary> {
    const [walletSummary, identity, owned] = await Promise.all([
      this.scanBalancePages(input.account, input.cursor ?? undefined, true),
      this.#resolveAccountName(input.account),
      this.#scanOwnedObjects(input.account)
    ]);
    return {
      status: "ok",
      account: input.account,
      fetchedAt: this.fetchedAt(),
      ...identity,
      balancePages: walletSummary.pages, observedBalanceTypes: walletSummary.observedTypes, conflictingBalanceTypes: walletSummary.conflicts,
      // Drop coins whose total balance is zero — an emptied coin object or
      // accumulator residue is not a holding worth listing on the account page.
      balances: walletSummary.balances.filter((balance) => {
        try {
          return BigInt(balance.balance) !== 0n;
        } catch {
          return true;
        }
      }),
      ...(walletSummary.blockedReason ? { balancesIncompleteReason: walletSummary.blockedReason } : {}),
      ...(owned.reason ? { objectScanReason: owned.reason } : {}),
      objectScanStatus: owned.status, displayObjectCount: owned.displayCount, renderableDisplayCount: owned.renderableCount,
      displayObjectsTruncated: owned.renderableCount > owned.nfts.length, nfts: owned.nfts,
      objectGroups: owned.objectGroups,
      scannedObjects: owned.scanned,
      objectsTruncated: owned.truncated
    };
  }

  async #resolveAccountName(account: string): Promise<{ name: string | null; nameStatus: "found" | "absent" | "unavailable" }> {
    const resolve = this.client.core.defaultNameServiceName;
    if (!resolve) return { name: null, nameStatus: "unavailable" };
    try {
      const { data } = await resolve.call(this.client.core, { address: account });
      return data.name ? { name: data.name, nameStatus: "found" } : { name: null, nameStatus: "absent" };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      return { name: null, nameStatus: code === 5 || code === "NOT_FOUND" ? "absent" : "unavailable" };
    }
  }

  // Enumerate owned objects (capped) and split them: Coin objects belong to the
  // balance view, objects carrying a Display name/image are NFTs, and the rest are
  // grouped by Move type. listOwnedObjects returns all three intermixed, so a
  // coin-heavy account may truncate before reaching every NFT.
  async #scanOwnedObjects(
    account: string
  ): Promise<{ nfts: AccountNft[]; objectGroups: AccountObjectGroup[]; scanned: number; truncated: boolean; displayCount: number; renderableCount: number; status: "complete" | "partial" | "unavailable"; reason?: AccountInventorySummary["objectScanReason"] }> {
    const nfts: AccountNft[] = [];
    const groups = new Map<string, number>();
    const core = this.client.core;
    const listOwnedObjects = core.listOwnedObjects;
    if (!listOwnedObjects) {
      return { nfts, objectGroups: [], scanned: 0, truncated: true, status: "unavailable", reason: "source_unavailable", displayCount: 0, renderableCount: 0 };
    }
    let cursor: string | undefined;
    const seenObjects = new Set<string>(), seenCursors = new Set<string>();
    let displayCount = 0, renderableCount = 0;
    let scanned = 0;
    let reason: AccountInventorySummary["objectScanReason"];
    for (let page = 0; page < ACCOUNT_OBJECT_SCAN_PAGES; page += 1) {
      let response;
      try {
        response = await listOwnedObjects.call(core, { owner: account, include: { display: true }, ...(cursor ? { cursor } : {}) });
      } catch {
        reason = "source_unavailable";
        break;
      }
      for (const object of response.objects ?? []) {
        if (seenObjects.has(object.objectId)) continue;
        seenObjects.add(object.objectId);
        scanned++;
        const type = object.type ?? "";
        if (/^0x0*2::coin::Coin</.test(type)) continue;
        const output = object.display?.output;
        const name = typeof output?.name === "string" ? output.name : undefined;
        const imageUrl = typeof output?.image_url === "string" ? output.image_url : undefined;
        if (output != null) {
          displayCount++;
          if (name || imageUrl) {
            renderableCount++;
            if (nfts.length < ACCOUNT_DISPLAY_LIMIT) nfts.push({ objectId: object.objectId, type, name, imageUrl });
          }
        } else {
          groups.set(type, (groups.get(type) ?? 0) + 1);
        }
      }
      if (!response.hasNextPage) {
        break;
      }
      cursor = response.cursor ?? undefined;
      if (!cursor || seenCursors.has(cursor)) { reason = "cursor_did_not_advance"; break; }
      seenCursors.add(cursor);
      if (page === ACCOUNT_OBJECT_SCAN_PAGES - 1) {
        reason = "page_limit";
      }
    }
    const objectGroups = [...groups.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
    const truncated = reason !== undefined;
    return { nfts, objectGroups, scanned, truncated, displayCount, renderableCount, reason, status: truncated ? (scanned ? "partial" : "unavailable") : "complete" };
  }

  async scanBalancePages(account: string, startCursor?: string, keepAvailableBalances = false) {
    const balances = new Map<string, SuiClientTypes.Balance>(), conflicting = new Set<string>(), requested = new Set<string>();
    let cursor = startCursor, pages = 0, blockedReason: IntentEvidenceBlockedReason | undefined;
    let reachedLastPage = false;
    while (pages < MAX_WALLET_BALANCE_SCAN_PAGES) {
      let page;
      try { page = await this.client.core.listBalances({ owner: account, ...(cursor ? { cursor } : {}) }); }
      catch (error) {
        if (!keepAvailableBalances && error instanceof ReadServiceCacheError) throw error;
        blockedReason = "wallet_balance_source_unavailable";
        break;
      }
      pages++;
      for (const balance of page.balances) {
        let type;
        try { type = normalizeCoinType(balance.coinType); }
        catch (error) {
          if (!keepAvailableBalances) throw error;
          blockedReason = "wallet_balance_source_unavailable";
          continue;
        }
        if (conflicting.has(type)) continue;
        const prior = balances.get(type);
        if (prior && (prior.balance !== balance.balance || prior.coinBalance !== balance.coinBalance || prior.addressBalance !== balance.addressBalance)) {
          conflicting.add(type);
          balances.delete(type);
        } else if (!prior) balances.set(type, balance);
      }
      if (!page.hasNextPage) {
        reachedLastPage = true;
        break;
      }
      if (cursor) requested.add(cursor);
      if (!page.cursor || requested.has(page.cursor)) { blockedReason = "wallet_balance_pagination_did_not_advance"; break; }
      cursor = page.cursor;
      if (pages === MAX_WALLET_BALANCE_SCAN_PAGES) blockedReason = "wallet_balance_page_limit_exceeded";
    }
    const values = [...balances.values()];
    let resolved: WalletBalanceWithUnit[];
    if (keepAvailableBalances) {
      const results = await Promise.allSettled(values.map(balance => this.withUnit(balance)));
      resolved = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (resolved.length !== values.length) blockedReason = "wallet_balance_source_unavailable";
    } else {
      resolved = await Promise.all(values.map(balance => this.withUnit(balance)));
    }
    return { balances: resolved, pages, observedBalances: balances, conflictingTypes: conflicting,
      enumerationComplete: startCursor === undefined && reachedLastPage && blockedReason === undefined,
      observedTypes: balances.size + conflicting.size, conflicts: conflicting.size,
      blockedReason: conflicting.size ? "wallet_balance_conflict" as const : blockedReason };

  }
}
