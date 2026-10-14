# DeepBook Margin

This file is a protocol reference for AI and human readers. It is not a runtime registry, not a supported-protocol list, not a live liquidity source, not a route recommendation source, and not a signing-readiness signal.

Current product support is declared by `read_get_server_status`, `read_list_supported_protocols`, concrete MCP tool schemas, and concrete MCP tool responses. This note does not expose margin support by itself.

DeepBook Margin is treated as mainnet protocol notes for Sui MCP.

This note covers these protocol topics only:

- Protocol notes only.
- No MCP read tools expose margin pool, collateral, borrow, liquidation, or interest data in this release.
- No signable margin action.

Signable margin review requires a separate adapter and explicit deterministic checks for liquidation and borrow risk.
