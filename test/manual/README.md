# Reproducing the swap and backup checks

The Move checks use Sui CLI 1.71.1 and local Git checkouts of MystenLabs/deepbookv3 and MystenLabs/sui. The runner extracts DeepBook revision `8a46552dfac02f2225965dda243bdea1ddcbec89` and Sui framework revision `1ff1fdcd630b6b9bc3d0e21fddfc70d2770c32c3` into a fresh temporary directory. It supplies a temporary Move cache and client configuration.

```sh
python3 test/manual/runDeepbookMove.py /path/to/deepbookv3 /path/to/sui --bundle /tmp/deepbook-local-bundle.json
```

The first Move case sets the base and triggered gas-dependent taker rates independently. The second funds two accounts, uses a base-denominated fee pool, fixes the principal and output floor, and changes the ask to add one lot. It asserts the actual base output, DEEP paid, and DEEP returned in each state.

The fullnode experiment uses Sui CLI and the Sui node executable from mainnet release 1.71.1. The runner creates a temporary protocol-122 genesis, two or more funded Ed25519 accounts and one local validator. All node listeners use loopback. The combined bundle publishes the unmodified protocol and its own DEEP token. The initial prices, deposits, minimums and order changes are in `deepbookPriceChange.mjs`.

```sh
python3 test/manual/runDeepbookLocalnet.py /path/to/sui-node /tmp/deepbook-local-bundle.json
```

The fixture signs setup and maker orders with the temporary local keys. The reviewed buy uses checked simulations, fixed bytes, the same sender and fully funded gas. In a fee-exempt pool it crosses the minimum order in both directions. In a fee-paying pool it uses a second local token as quote currency, sets a SUI/DEEP reference book, and applies the product's fee cap to the observed base conversion. It compares gas-adjusted output, quote principal and net DEEP spend across a one-lot increase. Each line reports the byte hash and raw results. For an existing disposable chain with those accounts and a loopback-only client configuration, run `node --import tsx test/manual/deepbookPriceChange.mjs /path/to/local-genesis /tmp/deepbook-local-bundle.json`.

To follow swap refunds into the Account card, use the same disposable genesis runner with an installed candidate:

```sh
python3 test/manual/runDeepbookLocalnet.py /path/to/sui-node /tmp/deepbook-local-bundle.json --refund-inventory /path/to/node_modules/@zktx.io/sui-mcp
```

The fixture executes the package's guarded sell with object, address-balance and reservation funding. It compares sender-owned IDs and raw balances with committed effects, opens Account via the installed MCP registration and reads its saved result. It inspects the default fullnode pages and separately requests one real object per page to exercise Account's six-page limit with a small inventory. Two additional buys in a fee-paying pool compare the positive DEEP refund with the original funding object or the new sender-owned coin produced by an address withdrawal.

For the backup check, build the project, then run `node test/manual/backupResponsiveness.mjs` using the standard Node heap. It validates a generated backup and a copy with an invalid first account. It counts SQLite reads during validation, checks source data after each preview, and prints process memory and elapsed time. It uses an in-memory database.
