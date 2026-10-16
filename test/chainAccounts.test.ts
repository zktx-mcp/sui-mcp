import { expect, it } from "vitest";
import { normalizeChainAddress, normalizeWalletGrants, walletChainsSchema } from "../src/core/session/chainAccounts.js";

// Synthetic addresses exercise chain identity and encoding, not wallet ownership.
const sui = `0x${"a".repeat(64)}`;
const ethereum = `0x${"B1".repeat(20)}`;
const solana = "11111111111111111111111111111111";

it("validates each supported chain with its own address encoding", () => {
  expect(normalizeChainAddress("sui:mainnet", sui)).toBe(sui);
  expect(normalizeChainAddress("eip155:1", ethereum)).toBe(`0x${"b1".repeat(20)}`);
  expect(normalizeChainAddress("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", solana)).toBe(solana);
  expect(normalizeChainAddress("sui:mainnet", ethereum)).toBeUndefined();
  expect(normalizeChainAddress("eip155:1", sui)).toBeUndefined();
  expect(normalizeChainAddress("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "1111")).toBeUndefined();
  expect(walletChainsSchema.safeParse(["eip155:11155111"]).success).toBe(false);
  expect(walletChainsSchema.safeParse(["sui:mainnet", "sui:mainnet"]).success).toBe(false);
  expect(walletChainsSchema.parse([])).toEqual([]);
});

it("retains per-account namespace authority without borrowing another account's method", () => {
  const other = `0x${"c".repeat(64)}`;
  const grants = normalizeWalletGrants({
    sui: { accounts: [`sui:mainnet:${sui}`], methods: [], events: [] },
    "sui:mainnet": { accounts: [`sui:mainnet:${other}`], methods: ["sui_signTransaction"], events: ["accountsChanged"] },
    eip155: { accounts: [`eip155:1:${ethereum}`], methods: ["eth_signTransaction"], events: [] }
  });
  expect(grants).toEqual([
    { chainId: "sui:mainnet", accounts: [
      { address: sui, methods: [], events: [] },
      { address: other, methods: ["sui_signTransaction"], events: ["accountsChanged"] }
    ] },
    { chainId: "eip155:1", accounts: [{ address: `0x${"b1".repeat(20)}`, displayAddress: ethereum,
      methods: ["eth_signTransaction"], events: [] }] }
  ]);
});

it("treats order and duplicate grants as the same authority", () => {
  const grant = { accounts: [`sui:mainnet:${sui}`], methods: ["b", "a"], events: ["chainChanged"] };
  expect(normalizeWalletGrants({ sui: grant })).toEqual(normalizeWalletGrants({
    "sui:mainnet": { ...grant, accounts: [...grant.accounts, ...grant.accounts], methods: ["a", "b", "a"] }
  }));
});

it("isolates a malformed chain without silently choosing among its remaining addresses", () => {
  expect(normalizeWalletGrants({
    sui: { accounts: [`sui:mainnet:${sui}`, "sui:mainnet:invalid"], methods: ["sui_signTransaction"], events: [] },
    eip155: { accounts: [`eip155:1:${ethereum}`], methods: [], events: [] }
  })).toEqual([
    { chainId: "sui:mainnet", accounts: [], invalidAccounts: true },
    { chainId: "eip155:1", accounts: [{ address: `0x${"b1".repeat(20)}`, displayAddress: ethereum, methods: [], events: [] }] }
  ]);
});
