import { rawToDisplay, typeName } from "./format.js";
import { asRecord, asString } from "./parse.js";

export type WalletAssetRow = {
  symbol: string;
  total: string;
  coinType?: string;
};

export function formatWalletAssetRow(entry: unknown): WalletAssetRow | null {
  const row = asRecord(entry);
  if (!row) {
    return null;
  }
  const display = asRecord(row.display);
  const unit = asRecord(row.unit);
  const coinType = asString(row.coinType);
  const symbol =
    asString(display?.symbol) ??
    asString(unit?.symbol) ??
    (coinType !== undefined ? typeName(coinType) : undefined) ??
    "(unknown coin)";
  const decimals = typeof unit?.decimals === "number" ? unit.decimals : undefined;

  // Total prefers the server-formatted display amount; otherwise format the raw
  // balance with verified decimals. Unknown units cannot establish a token amount.
  const displayAmount = asString(display?.amount);
  const rawBalance = asString(row.balance);
  let total: string;
  if (displayAmount !== undefined && decimals !== undefined) {
    total = displayAmount;
  } else if (rawBalance !== undefined) {
    total = (decimals !== undefined ? safeFormat(rawBalance, decimals) : undefined) ?? "Amount unavailable";
  } else {
    total = "Amount unavailable";
  }

  return { symbol, total, ...(coinType ? { coinType } : {}) };
}

// Format a raw integer amount, returning undefined for a non-integer string so a
// malformed on-chain value degrades instead of throwing through the whole render.
function safeFormat(raw: string, decimals: number): string | undefined {
  try {
    return rawToDisplay(raw, decimals);
  } catch {
    return undefined;
  }
}

