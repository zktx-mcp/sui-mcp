import { fromBase58 } from "@mysten/sui/utils";
import { z } from "zod";
import { parseSuiAddress } from "../suiAddress.js";

// The supported address-management scope. Only Sui has financial actions.
export const WALLET_CHAINS = ["sui:mainnet", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] as const;
export const SUI_MAINNET_WALLET_CHAIN = WALLET_CHAINS[0];
export const walletChainSchema = z.enum(WALLET_CHAINS);
export type WalletChainId = z.infer<typeof walletChainSchema>;
export const walletGrantRevisionsSchema = z.record(walletChainSchema, z.number().int().nonnegative());
export type WalletGrantRevisions = z.infer<typeof walletGrantRevisionsSchema>;
export function initialGrantRevisions(): WalletGrantRevisions {
  return Object.fromEntries(WALLET_CHAINS.map((chain) => [chain, 0])) as WalletGrantRevisions;
}
export const walletChainsSchema = z.array(walletChainSchema).refine((chains) => new Set(chains).size === chains.length,
  "Networks must be distinct");
export function parseWalletChains(value: unknown): WalletChainId[] {
  const selected = new Set(walletChainsSchema.parse(value));
  return WALLET_CHAINS.filter((chain) => selected.has(chain));
}
export const DEFAULT_WALLET_CHAINS: readonly WalletChainId[] = [SUI_MAINNET_WALLET_CHAIN];
export const WALLET_CHAIN_LABELS: Record<WalletChainId, string> = {
  "sui:mainnet": "Sui", "eip155:1": "Ethereum", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana"
};

export function normalizeChainAddress(chainId: WalletChainId, value: string): string | undefined {
  if (chainId === SUI_MAINNET_WALLET_CHAIN) return parseSuiAddress(value);
  // Ethereum address identity is 160 bits. Case is presentation, not identity.
  if (chainId === "eip155:1") return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : undefined;
  // Solana addresses are base58-encoded 32-byte public keys; base58 is case-sensitive.
  try { return fromBase58(value).length === 32 ? value : undefined; } catch { return undefined; }
}

export const chainAccountSchema = z.object({ chainId: walletChainSchema, address: z.string() }).strict()
  .refine((value) => normalizeChainAddress(value.chainId, value.address) === value.address, "Expected a normalized chain address");
export type ChainAccount = z.infer<typeof chainAccountSchema>;
export const walletGrantAccountSchema = z.object({ address: z.string(), displayAddress: z.string().optional(),
  methods: z.array(z.string()), events: z.array(z.string()) }).strict();
export const walletGrantSchema = z.object({ chainId: walletChainSchema, accounts: z.array(walletGrantAccountSchema),
  invalidAccounts: z.literal(true).optional() }).strict().superRefine((grant, context) => {
  if (new Set(grant.accounts.map((a) => a.address)).size !== grant.accounts.length ||
      grant.invalidAccounts && grant.accounts.length || grant.accounts.some((account) =>
        normalizeChainAddress(grant.chainId, account.address) !== account.address ||
        account.displayAddress !== undefined && normalizeChainAddress(grant.chainId, account.displayAddress) !== account.address)) {
    context.addIssue({ code: "custom", message: "Wallet grant accounts must match their chain" });
  }
});
export type WalletGrant = z.infer<typeof walletGrantSchema>;
export const walletGrantsSchema = z.array(walletGrantSchema).refine((grants) =>
  new Set(grants.map((grant) => grant.chainId)).size === grants.length, "Wallet grants must have distinct chains");
export const walletChainResultSchema = z.discriminatedUnion("status", [
  chainAccountSchema.safeExtend({ status: z.literal("bound") }).strict(),
  z.object({ chainId: walletChainSchema, status: z.enum(["not_approved", "multiple_accounts", "invalid_response"]) }).strict()
]);
export const walletChainResultsSchema = z.array(walletChainResultSchema).refine((results) =>
  new Set(results.map((result) => result.chainId)).size === results.length, "One result per requested chain is required");
export type WalletChainResult = z.infer<typeof walletChainResultSchema>;
export function fixedChainAccount(connection: { chainResults: readonly WalletChainResult[] }, chainId: WalletChainId): string | undefined {
  const result = connection.chainResults.find((item) => item.chainId === chainId);
  return result?.status === "bound" ? result.address : undefined;
}
export function approvedChainResults(chains: readonly WalletChainId[], grants: readonly WalletGrant[]): WalletChainResult[] {
  return WALLET_CHAINS.filter((chain) => chains.includes(chain)).map((chainId) => {
    const grant = grants.find((item) => item.chainId === chainId);
    if (grant?.invalidAccounts) return { chainId, status: "invalid_response" as const };
    if (!grant?.accounts.length) return { chainId, status: "not_approved" as const };
    if (grant.accounts.length !== 1) return { chainId, status: "multiple_accounts" as const };
    return { chainId, status: "bound" as const, address: grant.accounts[0]!.address };
  });
}
export type WalletGrantAccount = z.infer<typeof walletGrantAccountSchema>;

const namespaceSchema = z.object({ accounts: z.array(z.string()), methods: z.array(z.string()), events: z.array(z.string()) });
export function normalizeWalletGrants(namespaces: Record<string, unknown>): WalletGrant[] {
  const chains = new Map<WalletChainId, { invalid: boolean; accounts: Map<string, WalletGrantAccount> }>();
  for (const [namespace, value] of Object.entries(namespaces)) {
    const allowed = WALLET_CHAINS.filter((chain) => namespace === chain || namespace === chain.split(":")[0]);
    if (!allowed.length) continue;
    const parsed = namespaceSchema.safeParse(value);
    const entry = (chain: WalletChainId) => {
      let result = chains.get(chain);
      if (!result) { result = { invalid: false, accounts: new Map() }; chains.set(chain, result); }
      return result;
    };
    if (!parsed.success) { for (const chain of allowed) entry(chain).invalid = true; continue; }
    for (const caipAccount of parsed.data.accounts) {
      const chain = allowed.find((id) => caipAccount.startsWith(`${id}:`));
      if (!chain) {
        if (!/^[^:]+:[^:]+:.+$/.test(caipAccount)) for (const id of allowed) entry(id).invalid = true;
        continue;
      }
      const rawAddress = caipAccount.slice(chain.length + 1), address = normalizeChainAddress(chain, rawAddress);
      const grant = entry(chain);
      if (!address) { grant.invalid = true; continue; }
      const prior = grant.accounts.get(address);
      grant.accounts.set(address, { address,
        ...(rawAddress === address ? prior?.displayAddress ? { displayAddress: prior.displayAddress } : {} : { displayAddress: rawAddress }),
        methods: [...new Set([...(prior?.methods ?? []), ...parsed.data.methods])].sort(),
        events: [...new Set([...(prior?.events ?? []), ...parsed.data.events])].sort() });
    }
  }
  return WALLET_CHAINS.flatMap((chainId) => {
    const grant = chains.get(chainId);
    return grant ? [{ chainId, accounts: grant.invalid ? [] : [...grant.accounts.values()].sort((a, b) => a.address.localeCompare(b.address)),
      ...(grant.invalid ? { invalidAccounts: true as const } : {}) }] : [];
  });
}

export function walletGrantAccount(grants: readonly WalletGrant[], chainId: WalletChainId, address: string): WalletGrantAccount | undefined {
  return grants.find((grant) => grant.chainId === chainId)?.accounts.find((account) => account.address === address);
}

// Compare address/method/event scope without treating display spelling as a grant change.
export function comparableGrantScope(grant: WalletGrant | undefined) {
  return grant && { chainId: grant.chainId, invalidAccounts: grant.invalidAccounts,
    accounts: grant.accounts.map(({ address, methods, events }) => ({ address, methods, events })) };
}
