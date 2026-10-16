import type { WalletGrant } from "../../src/core/session/chainAccounts.js";

// Synthetic, already-normalized wallet grants. Transport normalization is tested
// separately with raw WalletConnect namespaces, not with this fixture.
export function suiGrants(addresses: readonly string[], methods = ["sui_signTransaction"], events = ["accountsChanged", "chainChanged"]): WalletGrant[] {
  return [{ chainId: "sui:mainnet", accounts: addresses.map((address) => ({ address, methods: [...methods], events: [...events] })) }];
}
