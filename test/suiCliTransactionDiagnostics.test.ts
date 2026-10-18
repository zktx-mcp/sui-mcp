import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_SUI_CLI_TERMS,
  SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE,
  analyzeTraceCommand,
  assertAllowedCommand,
  chainIdentifierCommand,
  envsCommand,
  expectedMainnetCliChainIdentifier,
  objectCommand,
  parseSuiCliDiagnosticsArgs,
  replayCommand,
  runSuiCliDiagnostics,
  runSuiCliDiagnosticsFromArgv,
  shouldPrintSuiCliDiagnosticsUsage,
  txBlockCommand,
  versionCommand,
  type SuiCliCommandResult,
  type SuiCliCommandRunner,
  type SuiCliCommandSpec
} from "../scripts/sui-cli-transaction-diagnostics.js";
import {
  containsSensitiveMaterial,
  redactSensitive
} from "../scripts/sui-cli-transaction-diagnostics-redaction.js";

// Synthetic transaction/object digests encode 32 bytes filled with 3, 4 and 5.
const DIGEST = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
const OBJECT_ID = `0x${"1".padStart(64, "0")}`;
const OTHER_OBJECT_ID = `0x${"3".padStart(64, "0")}`;
const NOW = new Date("2026-05-14T01:02:03.004Z");
const MAINNET_CLI_CHAIN_ID = "35834a8a";
const OBJECT_DIGEST = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";
const PREVIOUS_TX = "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY";
const ADDRESS = `0x${"2".padStart(64, "0")}`;
const TEMP_DIR_PREFIX = "sui-mcp-sui-cli-diagnostics-";

// Fixture subset verified against Sui CLI v1.71.1 source `crates/sui/src/client_commands.rs`:
// `SuiClientCommandResult::TransactionBlock` serializes `to_legacy_transaction_block_response`.
function txBlockJson() {
  return {
    digest: DIGEST,
    effects: {
      messageVersion: "v1",
      status: { status: "success" },
      executedEpoch: "55",
      gasUsed: {
        computationCost: "820000",
        storageCost: "8291600",
        storageRebate: "7967916",
        nonRefundableStorageFee: "80484"
      },
      transactionDigest: DIGEST,
      created: [{ owner: { AddressOwner: ADDRESS }, reference: { objectId: OBJECT_ID, version: 2, digest: OBJECT_DIGEST } }],
      mutated: [{ owner: { AddressOwner: ADDRESS }, reference: { objectId: OBJECT_ID, version: 3, digest: OBJECT_DIGEST } }],
      deleted: [{ objectId: OBJECT_ID, version: 1, digest: OBJECT_DIGEST }],
      wrapped: [],
      unwrapped: [],
      unwrappedThenDeleted: [],
      gasObject: { owner: { AddressOwner: ADDRESS }, reference: { objectId: OBJECT_ID, version: 3, digest: OBJECT_DIGEST } },
      dependencies: [PREVIOUS_TX]
    },
    objectChanges: [{ type: "created", objectId: OBJECT_ID }],
    balanceChanges: [{ coinType: "0x2::sui::SUI", amount: "-1", owner: { AddressOwner: ADDRESS } }],
    events: [{ type: "0x2::event::Event" }],
    transaction: {
      data: { messageVersion: "v1" },
      txSignatures: []
    },
    timestampMs: "1757750331854",
    checkpoint: "189431900"
  };
}

function failedTxBlockJson(error: string) {
  const tx = txBlockJson();
  (tx.effects.status as { status: string; error?: string }).status = "failure";
  (tx.effects.status as { status: string; error?: string }).error = error;
  return tx;
}

// Fixture subset verified against Sui CLI v1.71.1 source `crates/sui/src/client_commands.rs`:
// `SuiClientCommandResult::Object` serializes `ObjectOutput`.
function objectJson() {
  return {
    objectId: OBJECT_ID,
    version: "25131978",
    digest: OBJECT_DIGEST,
    objType: "0x2::coin::Coin<0x2::sui::SUI>",
    owner: { AddressOwner: ADDRESS },
    prevTx: PREVIOUS_TX,
    storageRebate: 1535200,
    content: {
      dataType: "moveObject",
      type: "0x2::coin::Coin<0x2::sui::SUI>",
      fields: { balance: "1000" }
    }
  };
}

describe("Sui CLI transaction diagnostics utility", () => {
  it("derives the CLI-format mainnet chain identifier from the base58 SDK constant", () => {
    expect(expectedMainnetCliChainIdentifier()).toBe(MAINNET_CLI_CHAIN_ID);
  });

  it("documents the complete manual flag inventory in the help text", () => {
    for (const flag of [
      "--digest",
      "--object",
      "--trace",
      "--gas-profile",
      "--trace-file",
      "--output-dir",
      "--mainnet",
      "--client-env",
      "--read-timeout-ms",
      "--replay-timeout-ms",
      "--analyze-timeout-ms",
      "--help",
      "-h"
    ]) {
      expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toContain(flag);
    }
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/not onchain transaction submission\/execution/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/local replay is debug evidence only/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/not signing readiness/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/CLI env aliases must not\s+contain redaction markers/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/Artifact paths.*must\s+not contain Sui private key material/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/--client-env aliases must not contain word forms of private key, mnemonic, signature/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/signed transaction, or transaction bytes using "-", "_", a space, or no separator/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/aliases also must not contain suiprivkey-style markers/i);
    expect(SUI_CLI_TRANSACTION_DIAGNOSTICS_USAGE).toMatch(/--output-dir and --trace-file paths must not contain suiprivkey-style markers/i);
    expect(shouldPrintSuiCliDiagnosticsUsage(["--help"])).toBe(true);
    expect(shouldPrintSuiCliDiagnosticsUsage(["--digest", DIGEST, "--help"])).toBe(true);
    expect(shouldPrintSuiCliDiagnosticsUsage(["--digest", DIGEST])).toBe(false);
  });

  it("uses the same sensitive pattern for output redaction and alias rejection", () => {
    const redactionCases = [
      ["private-key", "[REDACTED_SENSITIVE_TERM]"],
      ["private_key", "[REDACTED_SENSITIVE_TERM]"],
      ["private key", "[REDACTED_SENSITIVE_TERM]"],
      ["privatekey", "[REDACTED_SENSITIVE_TERM]"],
      ["mnemonic", "[REDACTED_SENSITIVE_TERM]"],
      ["signature", "[REDACTED_SENSITIVE_TERM]"],
      ["signed transaction", "[REDACTED_SENSITIVE_TERM]"],
      ["signed_transaction", "[REDACTED_SENSITIVE_TERM]"],
      ["signed-transaction", "[REDACTED_SENSITIVE_TERM]"],
      ["signedtransaction", "[REDACTED_SENSITIVE_TERM]"],
      ["transaction bytes", "[REDACTED_SENSITIVE_TERM]"],
      ["transaction_bytes", "[REDACTED_SENSITIVE_TERM]"],
      ["transaction-bytes", "[REDACTED_SENSITIVE_TERM]"],
      ["transactionbytes", "[REDACTED_SENSITIVE_TERM]"],
      ["suiprivkey1qqqq", "[REDACTED_PRIVATE_KEY]"]
    ] as const;
    for (const [value, expected] of redactionCases) {
      expect(redactSensitive(value)).toBe(expected);
      expect(containsSensitiveMaterial(value)).toBe(true);
    }
    expect(redactSensitive("safe-alias")).toBe("safe-alias");
    expect(containsSensitiveMaterial("safe-alias")).toBe(false);

    for (const value of [
      "private-key",
      "private_key",
      "privatekey",
      "mnemonic",
      "signature",
      "signed_transaction",
      "signed-transaction",
      "signedtransaction",
      "transaction_bytes",
      "transaction-bytes",
      "transactionbytes",
      "suiprivkey1qqqq"
    ]) {
      const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--client-env", value], { now: NOW });
      expect(result.exitCode).toBe(1);
      expect(result.output.error?.kind).toBe("input_invalid");
      expect(JSON.stringify(result.output).toLowerCase()).not.toContain(value.toLowerCase());
    }
  });

  it("runs the minimal digest diagnostics through allowlisted shell-free command specs", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.chain_identifier",
      "sui.client.tx_block"
    ]);
    expect(calls.every((call) => call.shell === false && call.command === "sui")).toBe(true);
    expect(result.output.purpose).toBe("sui_cli_transaction_debug_evidence");
    expect(result.output.authority).toBe("debug_only_not_signing_readiness");
    expect(result.output.suiCli.version).toBe("sui 1.71.1-homebrew");
    expect(result.output.suiCli.activeEnv).toBe("mainnet");
    expect(result.output.suiCli.chainIdentifier).toBe(MAINNET_CLI_CHAIN_ID);
    expect(result.output.input.timeouts).toEqual({
      readMs: 15000,
      replayMs: 120000,
      analyzeMs: 60000
    });
    expect(result.output.commands.map((command) => command.timeoutMs)).toEqual([15000, 15000, 15000, 15000]);
    expect(result.output.txBlockSummary).toEqual({
      source: "sui_cli_transaction_block_response",
      sourceCheckedVersion: "1.71.1",
      sourceVersionMatchesInstalledCli: true,
      topLevelKeys: ["balanceChanges", "checkpoint", "digest", "effects", "events", "objectChanges", "timestampMs", "transaction"],
      effectsAvailable: true,
      digest: DIGEST,
      status: "success",
      checkpoint: "189431900",
      timestampMs: "1757750331854",
      gas: {
        computationCostRaw: "820000",
        storageCostRaw: "8291600",
        storageRebateRaw: "7967916",
        nonRefundableStorageFeeRaw: "80484",
        netGasCostRaw: "1143684"
      },
      counts: {
        objectChanges: 1,
        balanceChanges: 1,
        events: 1,
        dependencies: 1,
        created: 1,
        mutated: 1,
        deleted: 1,
        wrapped: 0,
        unwrapped: 0,
        unwrappedThenDeleted: 0
      }
    });
    expect(result.output.commands[0]).not.toHaveProperty("stdoutSnippet");
  });

  it("keeps the minimal success output shape stable", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.output).toEqual({
      generatedAt: "2026-05-14T01:02:03.004Z",
      purpose: "sui_cli_transaction_debug_evidence",
      authority: "debug_only_not_signing_readiness",
      suiCli: {
        declaredNetwork: "mainnet",
        expectedBase58ChainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
        expectedCliChainIdentifier: MAINNET_CLI_CHAIN_ID,
        sourceCheckedVersion: "1.71.1",
        version: "sui 1.71.1-homebrew",
        activeEnv: "mainnet",
        chainIdentifier: MAINNET_CLI_CHAIN_ID
      },
      input: {
        digest: DIGEST,
        objectIds: [],
        trace: false,
        gasProfile: false,
        outputDir: resolve(process.cwd(), ".WORK", "sui-cli-diagnostics", "2026-05-14T01-02-03-004Z"),
        timeouts: {
          readMs: 15000,
          replayMs: 120000,
          analyzeMs: 60000
        }
      },
      commands: [
        { name: "sui.version", args: ["--version"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
        { name: "sui.client.active_env", args: ["client", "active-env", "--json"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
        { name: "sui.client.chain_identifier", args: ["client", "chain-identifier", "--json"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
        { name: "sui.client.tx_block", args: ["client", "tx-block", "--json", DIGEST], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false }
      ],
      limitations: [],
      limitationDetails: [],
      txBlockSummary: {
        source: "sui_cli_transaction_block_response",
        sourceCheckedVersion: "1.71.1",
        sourceVersionMatchesInstalledCli: true,
        topLevelKeys: ["balanceChanges", "checkpoint", "digest", "effects", "events", "objectChanges", "timestampMs", "transaction"],
        effectsAvailable: true,
        digest: DIGEST,
        status: "success",
        checkpoint: "189431900",
        timestampMs: "1757750331854",
        gas: {
          computationCostRaw: "820000",
          storageCostRaw: "8291600",
          storageRebateRaw: "7967916",
          nonRefundableStorageFeeRaw: "80484",
          netGasCostRaw: "1143684"
        },
        counts: {
          objectChanges: 1,
          balanceChanges: 1,
          events: 1,
          dependencies: 1,
          created: 1,
          mutated: 1,
          deleted: 1,
          wrapped: 0,
          unwrapped: 0,
          unwrappedThenDeleted: 0
        }
      }
    });
  });

  it("validates digest, object ids, object cap, output directory, trace flags, and timeouts", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const invalidCases: string[][] = [
        ["--digest", "not-a-digest"],
        ["--digest", DIGEST, "--object", "0x2"],
        ["--digest", DIGEST, ...Array.from({ length: 21 }, () => ["--object", OBJECT_ID]).flat()],
        ["--digest", DIGEST, "--mainnet", "--client-env", "custom"],
        ["--digest", DIGEST, "--client-env", "https://fullnode.mainnet.sui.io:443"],
        ["--digest", DIGEST, "--client-env", "."],
        ["--digest", DIGEST, "--client-env", ".."],
        ["--digest", DIGEST, "--client-env", "private-key"],
        ["--digest", DIGEST, "--output-dir", "/not-under-work-or-temp"],
        ["--digest", DIGEST, "--output-dir", resolve(tmpdir())],
        ["--digest", DIGEST, "--read-timeout-ms", "99"],
        ["--digest", DIGEST, "--replay-timeout-ms", "300001"],
        ["--digest", DIGEST, "--analyze-timeout-ms", "300001"],
        ["--digest", DIGEST, "--trace-file", resolve(tempDir, "trace.json")],
        ["--digest", DIGEST, "--gas-profile"],
        ["--digest", DIGEST, "--trace", "--trace-file", resolve(tempDir, "trace.json"), "--gas-profile"]
      ];

      for (const argv of invalidCases) {
        expect(() => parseSuiCliDiagnosticsArgs(argv, { now: NOW })).toThrow();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects artifact output directories with symlink components", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const outsideDir = mkdtempSync(resolve(tmpdir(), "sui-cli-diagnostics-outside-"));
    const symlinkDir = resolve(tempDir, "linked");
    try {
      symlinkSync(outsideDir, symlinkDir, "dir");
      expect(() => parseSuiCliDiagnosticsArgs([
        "--digest",
        DIGEST,
        "--output-dir",
        resolve(symlinkDir, "artifacts")
      ], { now: NOW })).toThrow(/symlink/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects artifact output directories that are existing files", () => {
    const checkoutDir = mkdtempSync(resolve(tmpdir(), "sui-cli-diagnostics-checkout-"));
    const outputDir = resolve(checkoutDir, ".WORK", "sui-cli-diagnostics", "existing-file");
    try {
      mkdirSync(resolve(checkoutDir, ".WORK", "sui-cli-diagnostics"), { recursive: true });
      writeFileSync(outputDir, "not a directory");
      expect(() => parseSuiCliDiagnosticsArgs([
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        outputDir
      ], { cwd: checkoutDir, now: NOW })).toThrow(/non-directory/);
      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        outputDir
      ], { cwd: checkoutDir, now: NOW });
      expect(result.exitCode).toBe(1);
      expect(result.output.error?.kind).toBe("input_invalid");
      expect(result.output.commands).toEqual([]);
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("applies the same path validators in the internal allowlist guard", () => {
    const checkoutDir = mkdtempSync(resolve(tmpdir(), "sui-cli-diagnostics-checkout-"));
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const outsideDir = mkdtempSync(resolve(tmpdir(), "sui-cli-diagnostics-outside-"));
    try {
      mkdirSync(resolve(checkoutDir, ".WORK", "sui-cli-diagnostics"), { recursive: true });
      const symlinkDir = resolve(checkoutDir, ".WORK", "sui-cli-diagnostics", "linked");
      symlinkSync(outsideDir, symlinkDir, "dir");
      expect(() => assertAllowedCommand(
        replayCommand(DIGEST, resolve(symlinkDir, "artifacts"), 100),
        checkoutDir
      )).toThrow();
      expect(() => assertAllowedCommand(
        analyzeTraceCommand(resolve(tempDir, "missing.json.zst"), tempDir, 100),
        checkoutDir
      )).toThrow();
      const relativeTraceFile = resolve(checkoutDir, "trace.json.zst");
      writeFileSync(relativeTraceFile, "{}");
      expect(() => assertAllowedCommand(
        analyzeTraceCommand("trace.json.zst", ".WORK/sui-cli-diagnostics/relative", 100),
        checkoutDir
      )).not.toThrow();
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("stops before transaction commands when the CLI chain identifier is not mainnet", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify("4c78adac"))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "chain_mismatch" });
    expect(result.output.limitations).toContain("chain_mismatch");
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.chain_identifier"
    ]);
  });

  it("rejects malformed chain identifier output before echoing it", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify("suiprivkey1qqqq"))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "unrecognized_json_shape" });
    expect(result.output.suiCli.chainIdentifier).toBeUndefined();
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.chain_identifier"
    ]);
    expect(JSON.stringify(result.output)).not.toMatch(/suiprivkey/i);
  });

  it("keeps the chain mismatch output shape stable", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify("4c78adac"))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.output).toEqual({
      generatedAt: "2026-05-14T01:02:03.004Z",
      purpose: "sui_cli_transaction_debug_evidence",
      authority: "debug_only_not_signing_readiness",
      suiCli: {
        declaredNetwork: "mainnet",
        expectedBase58ChainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
        expectedCliChainIdentifier: MAINNET_CLI_CHAIN_ID,
        sourceCheckedVersion: "1.71.1",
        version: "sui 1.71.1-homebrew",
        activeEnv: "testnet",
        chainIdentifier: "4c78adac"
      },
      input: {
        digest: DIGEST,
        objectIds: [],
        trace: false,
        gasProfile: false,
        outputDir: resolve(process.cwd(), ".WORK", "sui-cli-diagnostics", "2026-05-14T01-02-03-004Z"),
        timeouts: {
          readMs: 15000,
          replayMs: 120000,
          analyzeMs: 60000
        }
      },
      commands: [
        { name: "sui.version", args: ["--version"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
        { name: "sui.client.active_env", args: ["client", "active-env", "--json"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
        { name: "sui.client.chain_identifier", args: ["client", "chain-identifier", "--json"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false }
      ],
      limitations: ["chain_mismatch"],
      limitationDetails: [{ kind: "chain_mismatch" }],
      error: {
        kind: "chain_mismatch",
        message: "Sui CLI chain identifier does not match mainnet."
      }
    });
  });

  it("rejects tx-block output when the response digest does not match the requested digest", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify({
          ...txBlockJson(),
          digest: PREVIOUS_TX
        }))
      ]);

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--object",
        OBJECT_ID,
        "--trace",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(1);
      expect(result.output.error).toMatchObject({ kind: "tx_block_digest_mismatch" });
      expect(result.output.txBlockSummary).toBeUndefined();
      expect(result.output.objectSummaries).toBeUndefined();
      expect(result.output.replay).toBeUndefined();
      expect(calls.map((call) => call.name)).toEqual([
        "sui.version",
        "sui.client.active_env",
        "sui.client.chain_identifier",
        "sui.client.tx_block"
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects tx-block output without a valid response digest", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify({
        ...txBlockJson(),
        digest: "not-a-digest"
      }))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "unrecognized_json_shape" });
    expect(result.output.txBlockSummary).toBeUndefined();
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.chain_identifier",
      "sui.client.tx_block"
    ]);
  });

  it("redacts invalid user input from structured error messages", () => {
    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", "suiprivkey1qqqq"], { now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "input_invalid" });
    expect(result.output.input).toMatchObject({
      digest: DIGEST,
      objectIds: [],
      outputDir: null
    });
    expect(result.output.input).not.toHaveProperty("mainnet");
    expect(JSON.stringify(result.output)).not.toContain("suiprivkey");
  });

  it("keeps later flags visible when a preceding value option is missing", () => {
    const result = runSuiCliDiagnosticsFromArgv(["--digest", "--object", OBJECT_ID], { now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error?.message).toMatch(/Missing value for --digest; got option --object instead/);
    expect(result.output.input.digest).toBeUndefined();
    expect(result.output.input.objectIds).toEqual([OBJECT_ID]);
  });

  it("bounds inspected object-id entries in parse-failure summaries", () => {
    const result = runSuiCliDiagnosticsFromArgv([
      "--digest",
      "not-a-digest",
      ...Array.from({ length: 25 }, () => ["--object", "not-an-object"]).flat(),
      "--object",
      OBJECT_ID
    ], { now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error?.kind).toBe("input_invalid");
    expect(result.output.input.objectIds).toEqual([]);
  });

  it("summarizes safe output directory and timeout inputs when digest validation fails", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), `${TEMP_DIR_PREFIX}private-key-`));
    try {
      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        "not-a-digest",
        "--output-dir",
        tempDir,
        "--read-timeout-ms",
        "5000",
        "--replay-timeout-ms",
        "6000",
        "--analyze-timeout-ms",
        "7000"
      ], { now: NOW });

      expect(result.exitCode).toBe(1);
      expect(result.output.error).toMatchObject({ kind: "input_invalid" });
      expect(result.output.input.digest).toBeUndefined();
      expect(result.output.input.outputDir).not.toBe(tempDir);
      expect(result.output.input.outputDir).toContain("[REDACTED_SENSITIVE_TERM]");
      expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
      expect(result.output.input.timeouts).toEqual({
        readMs: 5000,
        replayMs: 6000,
        analyzeMs: 7000
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks invalid client-env attempts in parse-failure JSON", () => {
    const result = runSuiCliDiagnosticsFromArgv([
      "--digest",
      DIGEST,
      "--client-env",
      "https://fullnode.mainnet.sui.io:443"
    ], { now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "input_invalid" });
    expect(result.output.input.clientEnv).toBe("[UNAVAILABLE_INVALID_ALIAS]");
  });

  it("does not echo trace-file paths in parse-failure JSON", () => {
    const result = runSuiCliDiagnosticsFromArgv([
      "--digest",
      DIGEST,
      "--trace",
      "--gas-profile",
      "--trace-file",
      "/tmp/manual-trace.json.zst"
    ], { now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error?.message).toMatch(/--trace and --trace-file are mutually exclusive/);
    expect(result.output.input.trace).toBe(true);
    expect(result.output.input.gasProfile).toBe(true);
    expect(result.output.input).not.toHaveProperty("traceFile");
    expect(JSON.stringify(result.output)).not.toMatch(/manual-trace/i);
  });

  it("marks unsafe output directories in parse-failure JSON", () => {
    const result = runSuiCliDiagnosticsFromArgv([
      "--digest",
      "not-a-digest",
      "--output-dir",
      "/not-under-work-or-temp"
    ], { now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "input_invalid" });
    expect(result.output.input.outputDir).toBe("[UNAVAILABLE_UNSAFE_PATH]");
  });

  it("redacts bare and uppercase private-key markers from CLI-derived fields", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("SUIPrivKey")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(failedTxBlockJson(`SUIPrivKey private-key ${"x".repeat(600)}`)))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });
    const json = JSON.stringify(result.output);

    expect(result.exitCode).toBe(0);
    expect(result.output.suiCli.activeEnv).toBe("[REDACTED_PRIVATE_KEY]");
    expect(result.output.txBlockSummary?.executionError).not.toMatch(/suiprivkey/i);
    expect(result.output.txBlockSummary?.executionError).not.toMatch(/private-key/i);
    expect(result.output.txBlockSummary?.executionError?.length).toBeLessThanOrEqual(500);
    expect(result.output.txBlockSummary?.executionErrorTruncated).toBe(true);
    expect(json).not.toMatch(/suiprivkey/i);
    expect(json).not.toMatch(/private-key/i);
  });

  it("keeps internal errors distinct from input validation failures", () => {
    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], {
      runner: () => {
        throw new Error("runner exploded");
      },
      now: NOW
    });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "internal_error" });
    expect(result.output.error?.message).toBe("Error: runner exploded");
    expect(result.output.limitations).toEqual(["internal_error"]);
    expect(result.output.input.digest).toBe(DIGEST);
    expect(result.output.input.outputDir).toBe(resolve(process.cwd(), ".WORK", "sui-cli-diagnostics", "2026-05-14T01-02-03-004Z"));
  });

  it("preserves command history when an unexpected runner error occurs after parsing", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID))
    ]);
    const throwingRunner: SuiCliCommandRunner = (spec) => {
      if (spec.name === "sui.client.tx_block") {
        throw new Error("runner exploded during tx-block");
      }
      return runner(spec);
    };

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner: throwingRunner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "internal_error" });
    expect(result.output.error?.message).toBe("Error: runner exploded during tx-block");
    expect(result.output.commands.map((command) => command.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.chain_identifier"
    ]);
  });

  it("validates direct diagnostics input before command construction", () => {
    const input = parseSuiCliDiagnosticsArgs(["--digest", DIGEST], { now: NOW });
    const result = runSuiCliDiagnostics(
      { ...input, readTimeoutMs: 99 },
      {
        cwd: process.cwd(),
        now: NOW,
        runner: () => {
          throw new Error("runner should not execute");
        }
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toEqual({
      kind: "input_invalid",
      message: "DiagnosticsInputError: --read-timeout-ms must be between 100 and 300000."
    });
    expect(result.output.limitations).toEqual(["input_invalid"]);
    expect(result.output.commands).toEqual([]);
  });

  it("validates direct diagnostics artifact paths before filesystem side effects", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "not-diagnostics-"));
    const outputDir = resolve(tempDir, "outside-policy");
    const input = parseSuiCliDiagnosticsArgs(["--digest", DIGEST, "--trace"], { now: NOW });
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);
    try {
      const result = runSuiCliDiagnostics(
        { ...input, outputDir },
        {
          cwd: process.cwd(),
          now: NOW,
          runner
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.output.error?.kind).toBe("input_invalid");
      expect(result.output.commands).toEqual([]);
      expect(calls).toEqual([]);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("safe-echoes invalid direct client env aliases before command construction", () => {
    const input = parseSuiCliDiagnosticsArgs(["--digest", DIGEST], { now: NOW });
    const result = runSuiCliDiagnostics(
      { ...input, clientEnv: "https://attacker" },
      {
        cwd: process.cwd(),
        now: NOW,
        runner: () => {
          throw new Error("runner should not execute");
        }
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output.error?.kind).toBe("input_invalid");
    expect(result.output.input.clientEnv).toBe("[UNAVAILABLE_INVALID_ALIAS]");
    expect(result.output.commands).toEqual([]);
  });

  it("rejects mutually exclusive direct mainnet and client env input before command construction", () => {
    const input = parseSuiCliDiagnosticsArgs(["--digest", DIGEST], { now: NOW });
    const result = runSuiCliDiagnostics(
      { ...input, mainnet: true, clientEnv: "custom" },
      {
        cwd: process.cwd(),
        now: NOW,
        runner: () => {
          throw new Error("runner should not execute");
        }
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({
      kind: "input_invalid",
      message: "DiagnosticsInputError: --mainnet and --client-env are mutually exclusive."
    });
    expect(result.output.input.mainnet).toBe(true);
    expect(result.output.input.clientEnv).toBe("custom");
    expect(result.output.commands).toEqual([]);
  });

  it("rejects sensitive direct client env aliases without raw marker echo", () => {
    const input = parseSuiCliDiagnosticsArgs(["--digest", DIGEST], { now: NOW });
    const result = runSuiCliDiagnostics(
      { ...input, clientEnv: "private-key" },
      {
        cwd: process.cwd(),
        now: NOW,
        runner: () => {
          throw new Error("runner should not execute");
        }
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output.error?.kind).toBe("input_invalid");
    expect(result.output.input.clientEnv).toBe("[REDACTED_SENSITIVE_TERM]");
    expect(result.output.commands).toEqual([]);
    expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
  });

  it("safe-echoes invalid direct diagnostics input without raw digest or oversized object lists", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const result = runSuiCliDiagnostics(
        {
          digest: "suiprivkey1qqqq",
          objectIds: [
            ...Array.from({ length: 25 }, () => OBJECT_ID),
            "suiprivkey1qqqq"
          ],
          mainnet: false,
          trace: false,
          gasProfile: false,
          outputDir: tempDir,
          readTimeoutMs: 15000,
          replayTimeoutMs: 120000,
          analyzeTimeoutMs: 60000
        },
        {
          cwd: process.cwd(),
          now: NOW,
          runner: () => {
            throw new Error("runner should not execute");
          }
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.output.error?.kind).toBe("input_invalid");
      expect(result.output.input.digest).toBeUndefined();
      expect(result.output.input.objectIds).toHaveLength(20);
      expect(result.output.input).not.toHaveProperty("mainnet");
      expect(result.output.commands).toEqual([]);
      expect(JSON.stringify(result.output)).not.toMatch(/suiprivkey/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds inspected object-id entries in direct-input failure summaries", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const result = runSuiCliDiagnostics(
        {
          digest: "not-a-digest",
          objectIds: [
            ...Array.from({ length: 25 }, () => "not-an-object"),
            OBJECT_ID
          ],
          mainnet: false,
          trace: false,
          gasProfile: false,
          outputDir: tempDir,
          readTimeoutMs: 15000,
          replayTimeoutMs: 120000,
          analyzeTimeoutMs: 60000
        },
        {
          cwd: process.cwd(),
          now: NOW,
          runner: () => {
            throw new Error("runner should not execute");
          }
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.output.error?.kind).toBe("input_invalid");
      expect(result.output.input.objectIds).toEqual([]);
      expect(result.output.commands).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports when the installed Sui CLI version differs from the source-checked parser version", () => {
    const { runner } = runnerWith([
      ok("sui 1.72.0-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.suiCli.sourceCheckedVersion).toBe("1.71.1");
    expect(result.output.limitations).toContain("sui_cli_version_mismatch");
    expect(result.output.txBlockSummary).toMatchObject({
      source: "sui_cli_transaction_block_response",
      sourceCheckedVersion: "1.71.1",
      sourceVersionMatchesInstalledCli: false
    });
  });

  it("does not accept substring false positives for the source-checked CLI version", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.10-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.limitations).toContain("sui_cli_version_mismatch");
    expect(result.output.txBlockSummary?.sourceVersionMatchesInstalledCli).toBe(false);
  });

  it("uses an explicit existing CLI env alias without mutating Sui client config", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--client-env", "custom"], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.input.clientEnv).toBe("custom");
    expect(result.output.suiCli.selectedEnv).toBe("custom");
    expect(calls[2]?.args).toEqual(["client", "--client.env", "custom", "chain-identifier", "--json"]);
    expect(calls[3]?.args).toEqual(["client", "--client.env", "custom", "tx-block", "--json", DIGEST]);
  });

  it("records command-level limitation provenance without duplicating the public limitation token", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      failed("active env failed"),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson())),
      failed("object failed")
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", OBJECT_ID], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.limitations.filter((limitation) => limitation === "command_failure")).toHaveLength(1);
    expect(result.output.limitationDetails).toEqual(expect.arrayContaining([
      { kind: "command_failure", source: "sui.client.active_env" },
      { kind: "command_failure", source: "sui.client.object" }
    ]));
  });

  it("rejects sensitive user-supplied command args before command construction", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--client-env", "private-key"], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(result.output.error?.kind).toBe("input_invalid");
    expect(result.output.error?.message).toMatch(/diagnostics redaction set/);
    expect(result.output.error?.message).toMatch(/--help/);
    expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
  });

  it("redacts generic sensitive artifact path markers without blocking replay", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), `${TEMP_DIR_PREFIX}private-key-`));
    try {
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(calls.at(-1)?.args).toContain(tempDir);
      expect(result.output.input.outputDir).toContain("[REDACTED_SENSITIVE_TERM]");
      expect(result.output.commands.at(-1)?.args).toEqual(expect.arrayContaining([
        expect.stringContaining("[REDACTED_SENSITIVE_TERM]")
      ]));
      expect(result.output.commands.at(-1)?.argsRedacted).toBe(true);
      expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects Sui private key material in artifact paths before command construction", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), `${TEMP_DIR_PREFIX}suiprivkey`));
    try {
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);
      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });
      expect(result.exitCode).toBe(1);
      expect(calls).toEqual([]);
      expect(result.output.error?.kind).toBe("input_invalid");
      expect(JSON.stringify(result.output)).not.toMatch(/suiprivkey/i);
      const traceFile = resolve(tempDir, "trace.json.zst");
      writeFileSync(traceFile, "{}");
      const traceFileResult = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--gas-profile",
        "--trace-file",
        traceFile
      ], { runner, now: NOW });
      expect(traceFileResult.exitCode).toBe(1);
      expect(traceFileResult.output.error?.kind).toBe("input_invalid");
      expect(JSON.stringify(traceFileResult.output)).not.toMatch(/suiprivkey/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("can select a mainnet env alias without mutating Sui client config", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify([
        [
          { alias: "custom", rpc: "https://fullnode.mainnet.sui.io:443", ws: null, basic_auth: null, chain_id: MAINNET_CLI_CHAIN_ID.toUpperCase() },
          { alias: "testnet", rpc: "https://fullnode.testnet.sui.io:443", ws: null, basic_auth: null, chain_id: "4c78adac" }
        ],
        "testnet"
      ])),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--mainnet"], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.input.mainnet).toBe(true);
    expect(result.output.suiCli.selectedEnv).toBe("custom");
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.envs",
      "sui.client.chain_identifier",
      "sui.client.tx_block"
    ]);
    expect(calls[3]?.args).toEqual(["client", "--client.env", "custom", "chain-identifier", "--json"]);
    expect(calls[4]?.args).toEqual(["client", "--client.env", "custom", "tx-block", "--json", DIGEST]);
  });

  it("forwards the selected mainnet env alias to replay", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("testnet")),
        ok(JSON.stringify([
          [
            { alias: "custom", chain_id: MAINNET_CLI_CHAIN_ID },
            { alias: "testnet", chain_id: "4c78adac" }
          ],
          "testnet"
        ])),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--mainnet",
        "--trace",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(calls.at(-1)?.args).toEqual([
        "replay",
        "--client.env",
        "custom",
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        tempDir,
        "--show-effects",
        "true"
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not guess when multiple CLI env aliases point at mainnet", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify([
        [
          { alias: "custom", chain_id: MAINNET_CLI_CHAIN_ID },
          { alias: "mainnet-alt", chain_id: MAINNET_CLI_CHAIN_ID }
        ],
        "testnet"
      ]))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--mainnet"], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "mainnet_env_ambiguous" });
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.envs"
    ]);
  });

  it("does not guess when no CLI env alias points at mainnet", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify([
        [
          { alias: "testnet", chain_id: "4c78adac" },
          { alias: "devnet", chain_id: "130ce7e2" }
        ],
        "testnet"
      ]))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--mainnet"], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "mainnet_env_not_found" });
    expect(result.output.error?.message).toMatch(/No Sui CLI environment alias points at the expected mainnet chain id/);
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.envs"
    ]);
  });

  it("rejects invalid auto-selected mainnet env aliases before command construction", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify([
        [
          { alias: "https://fullnode.mainnet.sui.io:443", chain_id: MAINNET_CLI_CHAIN_ID }
        ],
        "testnet"
      ]))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--mainnet"], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "mainnet_env_alias_unsafe" });
    expect(result.output.error?.message).toMatch(/blocked by diagnostics alias policy/);
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.envs"
    ]);
  });

  it("rejects redaction-marked auto-selected mainnet env aliases before command construction", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("testnet")),
      ok(JSON.stringify([
        [
          { alias: "private-key", chain_id: MAINNET_CLI_CHAIN_ID }
        ],
        "testnet"
      ]))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--mainnet"], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "mainnet_env_alias_unsafe" });
    expect(result.output.error?.message).toMatch(/blocked by diagnostics alias policy/);
    expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.envs"
    ]);
  });

  it("inspects bounded object ids with object-specific validation and summaries", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson())),
      ok(JSON.stringify(objectJson()))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", OBJECT_ID], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(calls.at(-1)?.args).toEqual(["client", "object", "--json", OBJECT_ID]);
    expect(result.output.objectSummaries).toEqual([
      {
        source: "sui_cli_object_output",
        sourceCheckedVersion: "1.71.1",
        sourceVersionMatchesInstalledCli: true,
        requestedObjectId: OBJECT_ID,
        objectId: OBJECT_ID,
        version: "25131978",
        digest: OBJECT_DIGEST,
        objectType: "0x2::coin::Coin<0x2::sui::SUI>",
        ownerKind: "AddressOwner",
        previousTransaction: PREVIOUS_TX,
        storageRebateRaw: "1535200",
        contentShape: {
          topLevelKeys: ["dataType", "fields", "type"],
          topLevelFieldTypes: {
            dataType: "string",
            fields: "object",
            type: "string"
          }
        }
      }
    ]);
  });

  it("rejects object output when the response object id does not match the requested object id", () => {
    const { runner, calls } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson())),
      ok(JSON.stringify({
        ...objectJson(),
        objectId: OTHER_OBJECT_ID
      }))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", OBJECT_ID], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "object_id_mismatch" });
    expect(result.output.objectSummaries).toBeUndefined();
    expect(calls.map((call) => call.name)).toEqual([
      "sui.version",
      "sui.client.active_env",
      "sui.client.chain_identifier",
      "sui.client.tx_block",
      "sui.client.object"
    ]);
  });

  it("rejects object output without a valid response object id", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson())),
      ok(JSON.stringify({
        ...objectJson(),
        objectId: "not-an-object"
      }))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", OBJECT_ID], { runner, now: NOW });

    expect(result.exitCode).toBe(1);
    expect(result.output.error).toMatchObject({ kind: "unrecognized_json_shape" });
    expect(result.output.objectSummaries).toBeUndefined();
  });

  it("summarizes string object owner variants from Sui CLI object output", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(txBlockJson())),
      ok(JSON.stringify({
        ...objectJson(),
        owner: "Immutable"
      }))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", OBJECT_ID], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.objectSummaries?.[0]?.ownerKind).toBe("Immutable");
  });

  it("redacts sensitive CLI-derived shape keys from summaries", () => {
    const tx = {
      ...txBlockJson(),
      "private-key": "marker"
    };
    const object = {
      ...objectJson(),
      objType: "0x2::private_key::Coin",
      owner: "signed_transaction",
      prevTx: "transaction bytes",
      content: {
        ...objectJson().content,
        "private-key": 1,
        signed_transaction: "marker"
      }
    };
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(tx)),
      ok(JSON.stringify(object))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--object", OBJECT_ID], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.txBlockSummary?.topLevelKeys).toContain("[REDACTED_SENSITIVE_TERM]");
    expect(result.output.objectSummaries?.[0]?.contentShape?.topLevelKeys).toEqual(expect.arrayContaining([
      "[REDACTED_SENSITIVE_TERM]#1",
      "[REDACTED_SENSITIVE_TERM]#2"
    ]));
    expect(result.output.objectSummaries?.[0]?.contentShape?.topLevelFieldTypes).toMatchObject({
      "[REDACTED_SENSITIVE_TERM]#1": "number",
      "[REDACTED_SENSITIVE_TERM]#2": "string"
    });
    expect(result.output.objectSummaries?.[0]).toMatchObject({
      objectType: "0x2::[REDACTED_SENSITIVE_TERM]::Coin",
      ownerKind: "[REDACTED_SENSITIVE_TERM]",
      previousTransaction: "[REDACTED_SENSITIVE_TERM]"
    });
    expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
    expect(JSON.stringify(result.output)).not.toMatch(/private_key/i);
    expect(JSON.stringify(result.output)).not.toMatch(/signed_transaction/i);
    expect(JSON.stringify(result.output)).not.toMatch(/transaction bytes/i);
  });

  it("does not invent top-level or effects-derived counts when CLI tx-block output omits those fields", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify({
        digest: DIGEST
      }))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.limitations).toContain("effects_missing");
    expect(result.output.limitations).toContain("tx_block_count_field_missing");
    expect(result.output.limitationDetails).toEqual(expect.arrayContaining([
      { kind: "tx_block_count_field_missing", source: "txBlockSummary.counts.objectChanges" },
      { kind: "tx_block_count_field_missing", source: "txBlockSummary.counts.balanceChanges" },
      { kind: "tx_block_count_field_missing", source: "txBlockSummary.counts.events" }
    ]));
    expect(result.output.txBlockSummary).toMatchObject({
      effectsAvailable: false,
      countFieldsUnavailable: ["objectChanges", "balanceChanges", "events"],
      counts: {}
    });
    expect(result.output.txBlockSummary?.counts).not.toHaveProperty("objectChanges");
    expect(result.output.txBlockSummary?.counts).not.toHaveProperty("balanceChanges");
    expect(result.output.txBlockSummary?.counts).not.toHaveProperty("events");
    expect(result.output.txBlockSummary?.counts).not.toHaveProperty("dependencies");
  });

  it("reports zero top-level counts only when CLI tx-block output includes empty arrays", () => {
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify({
        digest: DIGEST,
        objectChanges: [],
        balanceChanges: [],
        events: []
      }))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.limitations).toContain("effects_missing");
    expect(result.output.limitations).not.toContain("tx_block_count_field_missing");
    expect(result.output.txBlockSummary).toMatchObject({
      effectsAvailable: false,
      counts: {
        objectChanges: 0,
        balanceChanges: 0,
        events: 0
      }
    });
    expect(result.output.txBlockSummary).not.toHaveProperty("countFieldsUnavailable");
    expect(result.output.txBlockSummary?.counts).not.toHaveProperty("dependencies");
  });

  it("reports unrecognized CLI execution status values", () => {
    const tx = txBlockJson();
    (tx.effects.status as { status: string }).status = "aborted";
    const { runner } = runnerWith([
      ok("sui 1.71.1-homebrew\n"),
      ok(JSON.stringify("mainnet")),
      ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
      ok(JSON.stringify(tx))
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.output.txBlockSummary).toMatchObject({
      status: "unknown",
      unrecognizedExecutionStatus: "aborted"
    });
    expect(result.output.limitations).toContain("unrecognized_execution_status");
  });

  it("builds the correct analyze-trace gas-profile command ordering for an explicit trace file", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const externalTraceDir = mkdtempSync(resolve(tmpdir(), "external-sui-trace-"));
    const traceFile = resolve(externalTraceDir, "trace.json.zst");
    try {
      writeFileSync(traceFile, "trace", "utf8");
      const calls: SuiCliCommandSpec[] = [];
      const responses = [
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("")
      ];
      const runner: SuiCliCommandRunner = (spec) => {
        calls.push(spec);
        if (spec.name === "sui.analyze_trace.gas_profile") {
          writeFileSync(resolve(tempDir, "gas_profile_trace.json"), "{}", "utf8");
        }
        const next = responses.shift();
        if (next === undefined) {
          throw new Error(`Unexpected command: ${spec.name}`);
        }
        return next;
      };

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--gas-profile",
        "--trace-file",
        traceFile,
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(calls.at(-1)).toMatchObject({
        name: "sui.analyze_trace.gas_profile",
        args: ["analyze-trace", "--path", traceFile, "--output-dir", tempDir, "gas-profile"],
        shell: false
      });
      expect(result.output.gasProfile).toEqual({
        outputDir: tempDir,
        profileFiles: [resolve(tempDir, "gas_profile_trace.json")]
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(externalTraceDir, { recursive: true, force: true });
    }
  });

  it("rejects an existing trace file that does not use the source-checked trace extension", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "external-sui-trace-"));
    const traceFile = resolve(tempDir, "trace.json");
    try {
      writeFileSync(traceFile, "trace", "utf8");
      expect(() => parseSuiCliDiagnosticsArgs([
        "--digest",
        DIGEST,
        "--gas-profile",
        "--trace-file",
        traceFile
      ], { now: NOW })).toThrow(/\.json\.zst/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the Sui source gas-profile name for dotted trace filenames", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const externalTraceDir = mkdtempSync(resolve(tmpdir(), "external-sui-trace-"));
    const traceFile = resolve(externalTraceDir, "custom.trace.json.zst");
    const profileFile = resolve(tempDir, "gas_profile_custom.json");
    try {
      writeFileSync(traceFile, "trace", "utf8");
      const responses = [
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("")
      ];
      const runner: SuiCliCommandRunner = (spec) => {
        if (spec.name === "sui.analyze_trace.gas_profile") {
          writeFileSync(profileFile, "{}", "utf8");
        }
        const next = responses.shift();
        if (next === undefined) {
          throw new Error(`Unexpected command: ${spec.name}`);
        }
        return next;
      };

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--gas-profile",
        "--trace-file",
        traceFile,
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(result.output.gasProfile?.profileFiles).toEqual([profileFile]);
      expect(result.output.limitations).not.toContain("gas_profile_layout_drift");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(externalTraceDir, { recursive: true, force: true });
    }
  });

  it("runs replay before gas profile and resolves a single trace artifact", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), `${TEMP_DIR_PREFIX}trace-`));
    const replayDir = resolve(tempDir, DIGEST);
    const traceFile = resolve(replayDir, "trace.json.zst");
    try {
      mkdirSync(replayDir, { recursive: true });
      mkdirSync(resolve(tempDir, "other"), { recursive: true });
      writeFileSync(resolve(tempDir, "other", "trace.json.zst"), "unrelated trace", "utf8");
      writeFileSync(resolve(tempDir, "effects.json"), "not a trace", "utf8");
      const calls: SuiCliCommandSpec[] = [];
      const responses = [
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed"),
        ok("profiled")
      ];
      const runner: SuiCliCommandRunner = (spec) => {
        calls.push(spec);
        if (spec.name === "sui.replay.trace") {
          writeFileSync(traceFile, "trace", "utf8");
        }
        const next = responses.shift();
        if (next === undefined) {
          throw new Error(`Unexpected command: ${spec.name}`);
        }
        return next;
      };

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--gas-profile",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(calls.at(-2)?.args).toEqual([
        "replay",
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        tempDir,
        "--show-effects",
        "true"
      ]);
      expect(calls.at(-1)?.args).toEqual(["analyze-trace", "--path", traceFile, "--output-dir", tempDir, "gas-profile"]);
      expect(result.output.replay).toEqual({ outputDir: tempDir, transactionOutputDir: replayDir, traceFiles: [traceFile] });
      expect(result.output.limitations).toContain("gas_profile_file_not_resolved");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allowlists default replay output directories relative to the supplied checkout cwd", () => {
    const checkoutDir = mkdtempSync(resolve(tmpdir(), "sui-mcp-checkout-"));
    try {
      const { runner } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);

      const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--trace"], { cwd: checkoutDir, runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(result.output.input.outputDir).toBe(resolve(
        checkoutDir,
        ".WORK",
        "sui-cli-diagnostics",
        "2026-05-14T01-02-03-004Z"
      ));
      expect(result.output.commands.at(-1)?.args).toEqual([
        "replay",
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        result.output.input.outputDir,
        "--show-effects",
        "true"
      ]);
      expect(result.output.replay?.transactionOutputDir).toBe(resolve(result.output.input.outputDir as string, DIGEST));
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("does not reject default artifact paths when the checkout path only matches generic redaction terms", () => {
    const checkoutDir = mkdtempSync(resolve(tmpdir(), "private-key-checkout-"));
    try {
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);

      const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST, "--trace"], { cwd: checkoutDir, runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(calls.at(-1)?.name).toBe("sui.replay.trace");
      expect(calls.at(-1)?.args).toContain(resolve(
        checkoutDir,
        ".WORK",
        "sui-cli-diagnostics",
        "2026-05-14T01-02-03-004Z"
      ));
      expect(result.output.input.outputDir).toContain("[REDACTED_SENSITIVE_TERM]");
      expect(JSON.stringify(result.output)).not.toMatch(/private-key/i);
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("keeps the replay and gas profile output shape stable", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const replayDir = resolve(tempDir, DIGEST);
    const traceFile = resolve(replayDir, "trace.json.zst");
    const profileFile = resolve(tempDir, "gas_profile_trace.json");
    try {
      mkdirSync(replayDir, { recursive: true });
      const responses = [
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed"),
        ok("profiled")
      ];
      const runner: SuiCliCommandRunner = (spec) => {
        if (spec.name === "sui.replay.trace") {
          writeFileSync(traceFile, "trace", "utf8");
        }
        if (spec.name === "sui.analyze_trace.gas_profile") {
          writeFileSync(profileFile, "{}", "utf8");
        }
        const next = responses.shift();
        if (next === undefined) {
          throw new Error(`Unexpected command: ${spec.name}`);
        }
        return next;
      };

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--gas-profile",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.output).toMatchObject({
        generatedAt: "2026-05-14T01:02:03.004Z",
        purpose: "sui_cli_transaction_debug_evidence",
        authority: "debug_only_not_signing_readiness",
        input: {
          digest: DIGEST,
          objectIds: [],
          trace: true,
          gasProfile: true,
          outputDir: tempDir,
          timeouts: {
            readMs: 15000,
            replayMs: 120000,
            analyzeMs: 60000
          }
        },
        commands: [
          { name: "sui.version", args: ["--version"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
          { name: "sui.client.active_env", args: ["client", "active-env", "--json"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
          { name: "sui.client.chain_identifier", args: ["client", "chain-identifier", "--json"], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
          { name: "sui.client.tx_block", args: ["client", "tx-block", "--json", DIGEST], exitCode: 0, durationMs: 1, timeoutMs: 15000, timeout: false, argsRedacted: false },
          { name: "sui.replay.trace", args: ["replay", "--digest", DIGEST, "--trace", "--output-dir", tempDir, "--show-effects", "true"], exitCode: 0, durationMs: 1, timeoutMs: 120000, timeout: false, argsRedacted: false },
          { name: "sui.analyze_trace.gas_profile", args: ["analyze-trace", "--path", traceFile, "--output-dir", tempDir, "gas-profile"], exitCode: 0, durationMs: 1, timeoutMs: 60000, timeout: false, argsRedacted: false }
        ],
        limitations: [],
        limitationDetails: [],
        replay: {
          outputDir: tempDir,
          transactionOutputDir: replayDir,
          traceFiles: [traceFile]
        },
        gasProfile: {
          outputDir: tempDir,
          profileFiles: [profileFile]
        }
      });
      expect(result.output.txBlockSummary).toMatchObject({
        source: "sui_cli_transaction_block_response",
        sourceCheckedVersion: "1.71.1",
        sourceVersionMatchesInstalledCli: true,
        effectsAvailable: true,
        digest: DIGEST,
        status: "success"
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports replay layout drift when a newer CLI writes a different trace filename under the digest directory", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const replayDir = resolve(tempDir, DIGEST);
    const driftTraceFile = resolve(replayDir, "move-trace.json.zst");
    try {
      mkdirSync(replayDir, { recursive: true });
      const { runner } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);
      const runnerWithArtifact: SuiCliCommandRunner = (spec) => {
        const result = runner(spec);
        if (spec.name === "sui.replay.trace") {
          writeFileSync(driftTraceFile, "trace", "utf8");
        }
        return result;
      };

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--output-dir",
        tempDir
      ], { runner: runnerWithArtifact, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(result.output.replay).toEqual({ outputDir: tempDir, transactionOutputDir: replayDir, traceFiles: [driftTraceFile] });
      expect(result.output.limitations).toContain("replay_layout_drift");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not report unrelated nested gas profile files as current gas-profile output", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    const traceFile = resolve(tempDir, "trace.json.zst");
    const unrelatedDir = resolve(tempDir, "nested");
    try {
      mkdirSync(unrelatedDir, { recursive: true });
      writeFileSync(traceFile, "trace", "utf8");
      const calls: SuiCliCommandSpec[] = [];
      const responses = [
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("profiled")
      ];
      const runner: SuiCliCommandRunner = (spec) => {
        calls.push(spec);
        if (spec.name === "sui.analyze_trace.gas_profile") {
          writeFileSync(resolve(unrelatedDir, "gas_profile_trace.json"), "{}", "utf8");
        }
        const next = responses.shift();
        if (next === undefined) {
          throw new Error(`Unexpected command: ${spec.name}`);
        }
        return next;
      };

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--gas-profile",
        "--trace-file",
        traceFile,
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(calls.at(-1)?.name).toBe("sui.analyze_trace.gas_profile");
      expect(result.output.gasProfile).toEqual({ outputDir: tempDir, profileFiles: [] });
      expect(result.output.limitations).toContain("gas_profile_file_not_resolved");
      expect(result.output.limitations).not.toContain("gas_profile_layout_drift");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips gas profile when replay does not produce the expected current trace artifact", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      mkdirSync(resolve(tempDir, DIGEST), { recursive: true });
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--gas-profile",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(result.output.limitations).toEqual(expect.arrayContaining(["trace_file_not_resolved", "skipped_gas_profile"]));
      expect(calls.map((call) => call.name)).not.toContain("sui.analyze_trace.gas_profile");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not reuse a preexisting replay trace for gas profiling", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const replayDir = resolve(tempDir, DIGEST);
      mkdirSync(replayDir, { recursive: true });
      writeFileSync(resolve(replayDir, "trace.json.zst"), "old trace", "utf8");
      const { runner, calls } = runnerWith([
        ok("sui 1.71.1-homebrew\n"),
        ok(JSON.stringify("mainnet")),
        ok(JSON.stringify(MAINNET_CLI_CHAIN_ID)),
        ok(JSON.stringify(txBlockJson())),
        ok("replayed")
      ]);

      const result = runSuiCliDiagnosticsFromArgv([
        "--digest",
        DIGEST,
        "--trace",
        "--gas-profile",
        "--output-dir",
        tempDir
      ], { runner, now: NOW });

      expect(result.exitCode).toBe(0);
      expect(result.output.replay).toEqual({ outputDir: tempDir, transactionOutputDir: replayDir, traceFiles: [] });
      expect(result.output.limitations).toEqual(expect.arrayContaining([
        "trace_file_preexisting",
        "trace_file_not_resolved",
        "skipped_gas_profile"
      ]));
      expect(calls.map((call) => call.name)).not.toContain("sui.analyze_trace.gas_profile");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive terms from command failure snippets", () => {
    const { runner } = runnerWith([
      failed("private-key SUIPrivKey suiprivkey transaction bytes signature\n{\"err\":\"signed transaction invalid\"}")
    ]);

    const result = runSuiCliDiagnosticsFromArgv(["--digest", DIGEST], { runner, now: NOW });
    const json = JSON.stringify(result.output);

    expect(result.exitCode).toBe(1);
    expect(json).not.toContain("suiprivkey");
    expect(json).not.toContain("SUIPrivKey");
    expect(json).not.toMatch(/private key/i);
    expect(json).not.toMatch(/private-key/i);
    expect(json).not.toMatch(/transaction bytes/i);
    expect(json).not.toMatch(/signature/i);
    expect(json).not.toMatch(/signed transaction/i);
  });

  it("never constructs forbidden command paths in exported command builders", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const traceFile = resolve(tempDir, "trace.json.zst");
      writeFileSync(traceFile, "{}");
      const specs = [
        versionCommand(100),
        envsCommand(100),
        chainIdentifierCommand(100),
        txBlockCommand(DIGEST, 100),
        objectCommand(OBJECT_ID, 100),
        replayCommand(DIGEST, tempDir, 100),
        replayCommand(DIGEST, tempDir, 100, "custom"),
        analyzeTraceCommand(traceFile, tempDir, 100)
      ];

      for (const spec of specs) {
        expect(() => assertAllowedCommand(spec)).not.toThrow();
        expect(spec.shell).toBe(false);
        expect(spec.command).toBe("sui");
        const text = spec.args.join(" ").toLowerCase();
        for (const forbidden of FORBIDDEN_SUI_CLI_TERMS) {
          expect(text).not.toContain(forbidden.toLowerCase());
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects non-allowlisted Sui CLI command shapes even when called through the internal guard", () => {
    const forbiddenSpecs: SuiCliCommandSpec[] = [
      { name: "sui.version", command: "sui", args: ["--version"], shell: false, timeoutMs: 99 },
      { name: "sui.keytool", command: "sui", args: ["keytool", "export", ADDRESS], shell: false, timeoutMs: 100 },
      { name: "sui.client.call", command: "sui", args: ["client", "call", "--package", OBJECT_ID], shell: false, timeoutMs: 100 },
      { name: "sui.client.tx_block", command: "sui", args: ["client", "tx-block", "--json", DIGEST, "--yes"], shell: false, timeoutMs: 100 },
      { name: "sui.client.tx_block", command: "sui", args: ["client", "--client.env", "bad/env", "tx-block", "--json", DIGEST], shell: false, timeoutMs: 100 },
      { name: "sui.client.object", command: "sui", args: ["client", "object", "--json", "0x2"], shell: false, timeoutMs: 100 },
      { name: "sui.replay.trace", command: "sui", args: ["replay", "--digest", DIGEST, "--trace", "--output-dir", "/tmp/not-diagnostics", "--show-effects", "true"], shell: false, timeoutMs: 100 },
      { name: "sui.analyze_trace.gas_profile", command: "sui", args: ["analyze-trace", "--path", "/tmp/trace.txt", "--output-dir", "/tmp/not-diagnostics", "gas-profile"], shell: false, timeoutMs: 100 }
    ];

    for (const spec of forbiddenSpecs) {
      expect(() => assertAllowedCommand(spec)).toThrow();
    }
    expect(() => assertAllowedCommand({
      name: "sui.client.tx_block",
      command: "sui",
      args: ["client", "tx-block", "--json", DIGEST, "--yes"],
      shell: false,
      timeoutMs: 100
    })).toThrow("Sui CLI command is not allowlisted: sui.client.tx_block");
  });
});

function runnerWith(responses: SuiCliCommandResult[]): { runner: SuiCliCommandRunner; calls: SuiCliCommandSpec[] } {
  const calls: SuiCliCommandSpec[] = [];
  return {
    calls,
    runner: (spec) => {
      calls.push(spec);
      const next = responses.shift();
      if (next === undefined) {
        throw new Error(`Unexpected command: ${spec.name}`);
      }
      return next;
    }
  };
}

function ok(stdout: string): SuiCliCommandResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

function failed(stderr: string): SuiCliCommandResult {
  return { exitCode: 1, stdout: "", stderr, durationMs: 1 };
}
