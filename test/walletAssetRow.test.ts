import { describe, expect, it } from "vitest";
import { formatWalletAssetRow } from "../review-app/src/walletAssetRow.js";

describe("wallet asset row formatting", () => {
  it("reads the real summarizeWalletAssets entry shape (display amount + symbol)", () => {
    const entry = {
      balance: "1180514208",
      coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      unit: { status: "available", decimals: 9, symbol: "SUI", name: "Sui" },
      display: { amount: "1.180514208", symbol: "SUI", source: "raw_balance_with_verified_decimals" }
    };
    // The display quantity is grounded in verified decimals.
    expect(formatWalletAssetRow(entry)).toEqual({
      coinType: entry.coinType,
      symbol: "SUI",
      total: "1.180514208"
    });
  });

  it("shows the total without storage-format breakdowns", () => {
    const entry = {
      balance: "1426505546346",
      coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      coinBalance: "1426505546346",
      addressBalance: "0",
      unit: { status: "available", decimals: 9, symbol: "SUI" },
      display: { amount: "1426.505546346", symbol: "SUI" }
    };
    expect(formatWalletAssetRow(entry)).toEqual({
      coinType: entry.coinType,
      symbol: "SUI",
      total: "1426.505546346"
    });
  });

  it("formats the total of object and address balances using verified decimals", () => {
    const entry = {
      balance: "3000000",
      coinType: "0xb::usdc::USDC",
      coinBalance: "1000000",
      addressBalance: "2000000",
      unit: { status: "available", decimals: 6, symbol: "USDC" }
    };
    // No display block: the total is computed from the raw balance with the decimals.
    expect(formatWalletAssetRow(entry)).toEqual({
      coinType: entry.coinType,
      symbol: "USDC",
      total: "3"
    });
  });

  it("reports the token amount as unavailable when decimals are unverified", () => {
    const entry = {
      balance: "4344929000",
      coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
      coinBalance: "4344929000",
      addressBalance: "0",
      unit: { status: "unavailable", reason: "coin_metadata_unavailable" }
    };
    // Raw 4344929000 does not establish a display quantity without decimals.
    expect(formatWalletAssetRow(entry)).toEqual({
      coinType: entry.coinType,
      symbol: "WAL",
      total: "Amount unavailable"
    });
  });

  it("prefers the unit symbol when there is no display block", () => {
    const entry = { balance: "5", coinType: "0xabc::foo::FOO", unit: { status: "available", symbol: "FOOBAR" } };
    expect(formatWalletAssetRow(entry)).toEqual({
      coinType: entry.coinType,
      symbol: "FOOBAR",
      total: "Amount unavailable"
    });
  });

  it("reports amount unavailable when neither a display amount nor a raw balance is present", () => {
    expect(formatWalletAssetRow({ coinType: "0xabc::foo::FOO" })).toEqual({
      coinType: "0xabc::foo::FOO",
      symbol: "FOO",
      total: "Amount unavailable"
    });
  });

  it("uses a generic label when even the coin type is missing", () => {
    expect(formatWalletAssetRow({ balance: "9" })).toEqual({
      symbol: "(unknown coin)",
      total: "Amount unavailable"
    });
  });

  it("returns null for non-object entries", () => {
    expect(formatWalletAssetRow(null)).toBeNull();
    expect(formatWalletAssetRow("SUI")).toBeNull();
    expect(formatWalletAssetRow(42)).toBeNull();
  });
});
