# DeepBookV3

This file is a protocol reference for AI and human readers. It is not a runtime registry, not a supported-protocol list, not a live liquidity source, not a route recommendation source, and not a signing-readiness signal.

Current product support is declared by `read_get_server_status`, `read_list_supported_protocols`, concrete MCP tool schemas, and concrete MCP tool responses. This note only explains DeepBookV3 protocol concepts that those runtime surfaces may reference.

DeepBookV3 is the first protocol domain for Sui MCP.

Protocol concepts referenced by current runtime evidence include:

- Mainnet package and pool metadata through the pinned `@mysten/deepbook-v3` SDK constants.
- Read-only protocol and pool listing.
- Read-only orderbook context through pinned DeepBook SDK simulation reads.
- Read-only raw-quantity and display-amount quotes through pinned DeepBook SDK simulation reads.

DeepBook orderbook, raw-quantity quote, and display-amount quote reads use an internal SDK simulation sender placeholder. They use `client.core.simulateTransaction` and do not require wallet connection because these market reads are not wallet-account reads. These read queries are separate from review-time simulation of the exact transaction material.

Signable swap review for the account-bound DeepBook swap route is part of current runtime support; `read_list_supported_protocols` and the concrete MCP tool responses are the authoritative status. The internal Review card displays account-bound evidence after the backend validates the pinned registry, refreshes the live quote, resolves objects, and simulates the exact stored material with validation checks enabled. `ready_for_wallet_review` describes that evidence, not signing authority.

Out of scope:

- Limit or market order review.

Ordinary MCP tools and review-status reads do not authorize a transaction or return transaction bytes. An explicit Review-card action admits the exact request, the user's wallet signs it through WalletConnect, and the backend verifies the returned bytes and signer before submitting once. Chain outcome comes from independent receipt reads.
