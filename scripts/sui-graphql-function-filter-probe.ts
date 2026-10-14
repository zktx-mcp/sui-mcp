import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_SUI_GRAPHQL_ENDPOINT_VERIFY_TIMEOUT_MS,
  DEFAULT_SUI_GRAPHQL_URL,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  SuiEndpointError,
  verifyMainnetGraphqlEndpoint
} from "../src/runtime/suiEndpoint.js";
import {
  graphQlAfterCheckpointForInclusiveLowerBound,
  graphQlBeforeCheckpointForInclusiveUpperBound,
  loadGraphqlServiceLimits,
  queryInspectTransaction,
  queryScanAccountTransactions,
  type GraphqlServiceLimits
} from "../src/runtime/suiTransactionGraphqlQueries.js";
import { transactionFactFromNode } from "../src/runtime/suiTransactionGraphqlMapping.js";
import { TransactionActivitySourceError, type SuiTransactionActivityFact } from "../src/core/activity/transactionActivityTypes.js";
import { parseSuiAddress } from "../src/core/suiAddress.js";

export const FUNCTION_FILTER_PROBE_OUTPUT_PATH = ".WORK/function-filter-source-probe.md";
export const FUNCTION_FILTER_PROBE_SAMPLE_SIZE = 50;
export const FUNCTION_FILTER_PROBE_ROW_LIMIT = 1;
export const FUNCTION_FILTER_PROBE_STALE_AFTER_DAYS = 90;
export const FUNCTION_FILTER_PROBE_SCHEMA_PATH = "node_modules/@mysten/sui/src/graphql/generated/schema.graphql";
export const FUNCTION_FILTER_PROBE_SCHEMA_LINE_RANGES = {
  transactionFilter: "4199-4235",
  transactionKindInput: "4279-4289"
} as const;

const REDACTION_MARKERS = {
  digest: "[REDACTED_SAMPLE_DIGEST]",
  address: "[REDACTED_SAMPLE_ADDRESS]",
  object: "[REDACTED_SAMPLE_OBJECT]",
  function: "[REDACTED_SAMPLE_FUNCTION]"
} as const;

const GRAPHQL_VALIDATION_ERROR_PATTERNS = [
  /Failed to parse\s+"TransactionFilter"/i,
  /At most one of\s+\[[^\]]+\]\s+can be specified/i,
  /Variable\s+"?\$?filter"?\s+got invalid value[\s\S]{0,160}\b(?:TransactionFilter|TransactionKindInput)\b/i,
  /\b(?:TransactionFilter|TransactionKindInput)\b[\s\S]{0,160}\b(?:got invalid value|expected type|unknown enum value)\b/i
] as const;
const NETWORK_ERROR_PATTERN =
  /\b(fetch failed|econn|enotfound|etimedout|timeout|network|tls|socket|connection|reset|unreachable)\b/i;

export type FunctionFilterProbeStatus =
  | "accepted_with_rows"
  | "accepted_empty"
  | "rejected_by_graphql_validation"
  | "inconclusive_network"
  | "inconclusive_mainnet_guard"
  | "inconclusive_missing_sample"
  | "inconclusive_unexpected_shape";

export type GitWorktreeState = "clean" | "dirty" | "unknown";

type ProbeTargetName =
  | "function"
  | "function + sentAddress"
  | "function + affectedAddress"
  | "function + affectedObject"
  | "function + kind: PROGRAMMABLE_TX"
  | "function + kind: SYSTEM_TX"
  | "function + atCheckpoint"
  | "function + sentAddress + atCheckpoint"
  | "function + affectedAddress + atCheckpoint"
  | "function + sentAddress + afterCheckpoint + beforeCheckpoint"
  | "function + affectedAddress + afterCheckpoint + beforeCheckpoint";

type ProbeTarget = {
  name: ProbeTargetName;
  filter?: Record<string, unknown> | undefined;
  filterKeys: string[];
  missingSampleReason?: string | undefined;
};

type ProbeSample = {
  functionTarget: string;
  sender: string;
  checkpoint: string;
  affectedObject?: string | undefined;
  inspectedDigests: number;
};

type ProbeTargetResult = {
  target: ProbeTargetName;
  filterKeys: string[];
  status: FunctionFilterProbeStatus;
  rowCount: 0 | 1;
  rowLimit: 1;
  note?: string | undefined;
};

type ProbeMetadata = {
  generatedAt: string;
  endpointHost: string;
  chainIdentifier?: string | undefined;
  gitCommit: string;
  gitWorktreeState: GitWorktreeState;
  nodeVersion: string;
  suiSdkVersion: string;
  schemaPath: string;
  schemaSha256: string;
  scriptSha256: string;
  schemaLineRanges: typeof FUNCTION_FILTER_PROBE_SCHEMA_LINE_RANGES;
  sampleSize: number;
  rowLimit: 1;
};

type ProbeReport = {
  status: "completed" | "not_run";
  notRunReason?: FunctionFilterProbeStatus | undefined;
  notRunMessage?: string | undefined;
  metadata: ProbeMetadata;
  sample?: {
    digest: typeof REDACTION_MARKERS.digest;
    sender: typeof REDACTION_MARKERS.address;
    function: typeof REDACTION_MARKERS.function;
    affectedObject: typeof REDACTION_MARKERS.object | "unavailable";
    checkpointAvailable: boolean;
    inspectedDigests: number;
  } | undefined;
  results: ProbeTargetResult[];
};

type CliOptions = {
  endpoint: string;
  sampleSize: number;
  timeoutMs: number;
};

export function redactProbeSampleText(source: string): string {
  return source
    .replace(/\b0x[a-fA-F0-9]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/g, REDACTION_MARKERS.function)
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, REDACTION_MARKERS.address)
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,64}\b/g, REDACTION_MARKERS.digest);
}

export function sanitizeProbeErrorMessage(message: string): string {
  const redacted = redactProbeSampleText(message).replace(/\s+/g, " ").trim();
  return redacted.length <= 160 ? redacted : `${redacted.slice(0, 157)}...`;
}

export function classifyFunctionFilterProbeError(error: unknown): { status: FunctionFilterProbeStatus; note: string } {
  if (error instanceof SuiEndpointError) {
    if (error.kind === "chain_identifier_mismatch") {
      return { status: "inconclusive_mainnet_guard", note: sanitizeProbeErrorMessage(error.message) };
    }
    return { status: "inconclusive_network", note: sanitizeProbeErrorMessage(error.message) };
  }
  if (error instanceof TransactionActivitySourceError) {
    const detailMessage = typeof error.details.message === "string" ? error.details.message : error.message;
    if (NETWORK_ERROR_PATTERN.test(detailMessage)) {
      return { status: "inconclusive_network", note: sanitizeProbeErrorMessage(detailMessage) };
    }
    if (isGraphqlValidationOrFilterRejection(detailMessage)) {
      return { status: "rejected_by_graphql_validation", note: sanitizeProbeErrorMessage(detailMessage) };
    }
    return { status: "inconclusive_unexpected_shape", note: sanitizeProbeErrorMessage(detailMessage) };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_ERROR_PATTERN.test(message)) {
    return { status: "inconclusive_network", note: sanitizeProbeErrorMessage(message) };
  }
  return { status: "inconclusive_unexpected_shape", note: sanitizeProbeErrorMessage(message) };
}

function isGraphqlValidationOrFilterRejection(message: string): boolean {
  return GRAPHQL_VALIDATION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function classifyFunctionFilterProbeRows(nodes: unknown): Pick<ProbeTargetResult, "status" | "rowCount"> {
  if (!Array.isArray(nodes)) {
    return { status: "inconclusive_unexpected_shape", rowCount: 0 };
  }
  const rowCount = Math.min(nodes.length, FUNCTION_FILTER_PROBE_ROW_LIMIT) as 0 | 1;
  return {
    status: rowCount > 0 ? "accepted_with_rows" : "accepted_empty",
    rowCount
  };
}

export function buildFunctionFilterProbeTargets(sample: ProbeSample): ProbeTarget[] {
  const checkpoint = checkpointNumber(sample.checkpoint);
  const afterCheckpoint = graphQlAfterCheckpointForInclusiveLowerBound(sample.checkpoint);
  const beforeCheckpoint = graphQlBeforeCheckpointForInclusiveUpperBound(sample.checkpoint);
  const checkpointWindow = afterCheckpoint === undefined || beforeCheckpoint === undefined
    ? undefined
    : { afterCheckpoint, beforeCheckpoint };
  return [
    target("function", { function: sample.functionTarget }),
    target("function + sentAddress", { function: sample.functionTarget, sentAddress: sample.sender }),
    target("function + affectedAddress", { function: sample.functionTarget, affectedAddress: sample.sender }),
    sample.affectedObject
      ? target("function + affectedObject", { function: sample.functionTarget, affectedObject: sample.affectedObject })
      : missingTarget("function + affectedObject", ["function", "affectedObject"], "sample transaction had no objectChanges address"),
    target("function + kind: PROGRAMMABLE_TX", { function: sample.functionTarget, kind: "PROGRAMMABLE_TX" }),
    target("function + kind: SYSTEM_TX", { function: sample.functionTarget, kind: "SYSTEM_TX" }),
    target("function + atCheckpoint", { function: sample.functionTarget, atCheckpoint: checkpoint }),
    target("function + sentAddress + atCheckpoint", {
      function: sample.functionTarget,
      sentAddress: sample.sender,
      atCheckpoint: checkpoint
    }),
    target("function + affectedAddress + atCheckpoint", {
      function: sample.functionTarget,
      affectedAddress: sample.sender,
      atCheckpoint: checkpoint
    }),
    checkpointWindow
      ? target("function + sentAddress + afterCheckpoint + beforeCheckpoint", {
        function: sample.functionTarget,
        sentAddress: sample.sender,
        ...checkpointWindow
      })
      : missingTarget(
        "function + sentAddress + afterCheckpoint + beforeCheckpoint",
        ["function", "sentAddress", "afterCheckpoint", "beforeCheckpoint"],
        "sample checkpoint could not form an exclusive GraphQL checkpoint window"
      ),
    checkpointWindow
      ? target("function + affectedAddress + afterCheckpoint + beforeCheckpoint", {
        function: sample.functionTarget,
        affectedAddress: sample.sender,
        ...checkpointWindow
      })
      : missingTarget(
        "function + affectedAddress + afterCheckpoint + beforeCheckpoint",
        ["function", "affectedAddress", "afterCheckpoint", "beforeCheckpoint"],
        "sample checkpoint could not form an exclusive GraphQL checkpoint window"
      )
  ];
}

function target(name: ProbeTargetName, filter: Record<string, unknown>): ProbeTarget {
  return { name, filter, filterKeys: Object.keys(filter).sort() };
}

function missingTarget(name: ProbeTargetName, filterKeys: string[], missingSampleReason: string): ProbeTarget {
  return { name, filterKeys, missingSampleReason };
}

async function runProbe(options: CliOptions): Promise<ProbeReport> {
  const metadata = await probeMetadata(options);
  let verified;
  try {
    verified = await verifyMainnetGraphqlEndpoint({
      url: options.endpoint,
      expectedChainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
      timeoutMs: options.timeoutMs
    });
  } catch (error) {
    const classified = classifyFunctionFilterProbeError(error);
    return {
      status: "not_run",
      notRunReason: classified.status,
      notRunMessage: classified.note,
      metadata,
      results: []
    };
  }

  const metadataWithChain: ProbeMetadata = {
    ...metadata,
    chainIdentifier: verified.chainIdentifier
  };
  let limits: GraphqlServiceLimits;
  try {
    limits = await loadGraphqlServiceLimits(verified.client);
  } catch (error) {
    const classified = classifyFunctionFilterProbeError(error);
    return {
      status: "not_run",
      notRunReason: classified.status,
      notRunMessage: classified.note,
      metadata: metadataWithChain,
      results: []
    };
  }
  let sample: ProbeSample | undefined;
  try {
    sample = await findProbeSample(verified.client, limits, options.sampleSize);
  } catch (error) {
    const classified = classifyFunctionFilterProbeError(error);
    return {
      status: "not_run",
      notRunReason: classified.status,
      notRunMessage: classified.note,
      metadata: metadataWithChain,
      results: []
    };
  }
  if (!sample) {
    return {
      status: "completed",
      metadata: metadataWithChain,
      results: [{
        target: "function",
        filterKeys: ["function"],
        status: "inconclusive_missing_sample",
        rowCount: 0,
        rowLimit: FUNCTION_FILTER_PROBE_ROW_LIMIT,
        note: `no recent transaction among ${options.sampleSize} digests had a MoveCall function, sender, and checkpoint`
      }]
    };
  }

  const results: ProbeTargetResult[] = [];
  for (const probeTarget of buildFunctionFilterProbeTargets(sample)) {
    if (!probeTarget.filter) {
      results.push({
        target: probeTarget.name,
        filterKeys: probeTarget.filterKeys,
        status: "inconclusive_missing_sample",
        rowCount: 0,
        rowLimit: FUNCTION_FILTER_PROBE_ROW_LIMIT,
        note: probeTarget.missingSampleReason
      });
      continue;
    }
    results.push(await runProbeTarget(verified.client, limits, probeTarget));
  }

  return {
    status: "completed",
    metadata: metadataWithChain,
    sample: {
      digest: REDACTION_MARKERS.digest,
      sender: REDACTION_MARKERS.address,
      function: REDACTION_MARKERS.function,
      affectedObject: sample.affectedObject ? REDACTION_MARKERS.object : "unavailable",
      checkpointAvailable: true,
      inspectedDigests: sample.inspectedDigests
    },
    results
  };
}

async function runProbeTarget(
  client: Awaited<ReturnType<typeof verifyMainnetGraphqlEndpoint>>["client"],
  limits: GraphqlServiceLimits,
  probeTarget: ProbeTarget
): Promise<ProbeTargetResult> {
  if (!probeTarget.filter) {
    return {
      target: probeTarget.name,
      filterKeys: probeTarget.filterKeys,
      status: "inconclusive_missing_sample",
      rowCount: 0,
      rowLimit: FUNCTION_FILTER_PROBE_ROW_LIMIT,
      note: probeTarget.missingSampleReason
    };
  }
  try {
    const result = await queryScanAccountTransactions(client, {
      last: FUNCTION_FILTER_PROBE_ROW_LIMIT,
      filter: probeTarget.filter,
      limits
    });
    const classified = classifyFunctionFilterProbeRows(result.transactions?.nodes);
    return {
      target: probeTarget.name,
      filterKeys: probeTarget.filterKeys,
      ...classified,
      rowLimit: FUNCTION_FILTER_PROBE_ROW_LIMIT
    };
  } catch (error) {
    const classified = classifyFunctionFilterProbeError(error);
    return {
      target: probeTarget.name,
      filterKeys: probeTarget.filterKeys,
      status: classified.status,
      rowCount: 0,
      rowLimit: FUNCTION_FILTER_PROBE_ROW_LIMIT,
      note: classified.note
    };
  }
}

async function findProbeSample(
  client: Awaited<ReturnType<typeof verifyMainnetGraphqlEndpoint>>["client"],
  limits: GraphqlServiceLimits,
  sampleSize: number
): Promise<ProbeSample | undefined> {
  const latestDigests = await latestTransactionDigests(client, sampleSize);
  let inspectedDigests = 0;
  let successfulInspectResponses = 0;
  let firstInspectFailure: unknown | undefined;
  for (const digest of latestDigests) {
    inspectedDigests += 1;
    let fact: SuiTransactionActivityFact;
    try {
      const result = await queryInspectTransaction(client, { digest, limits });
      successfulInspectResponses += 1;
      if (!result.transaction) {
        continue;
      }
      fact = transactionFactFromNode(result.transaction);
    } catch (error) {
      firstInspectFailure ??= error;
      continue;
    }
    const moveCall = fact.details?.moveCalls[0];
    if (!moveCall?.target || !fact.sender || !fact.checkpoint) {
      continue;
    }
    const affectedObject = fact.details?.objectChanges
      .map((change) => change.objectId)
      .find((objectId) => safeSuiAddress(objectId));
    return {
      functionTarget: moveCall.target,
      sender: fact.sender,
      checkpoint: fact.checkpoint,
      ...(affectedObject ? { affectedObject } : {}),
      inspectedDigests
    };
  }
  if (successfulInspectResponses === 0 && firstInspectFailure) {
    throw firstInspectFailure;
  }
  return undefined;
}

async function latestTransactionDigests(
  client: Awaited<ReturnType<typeof verifyMainnetGraphqlEndpoint>>["client"],
  sampleSize: number
): Promise<string[]> {
  const result = await client.query<{
    transactions?: {
      nodes?: Array<{ digest?: unknown }> | null;
    } | null;
  }>({
    query: `
      query SuiMcpFunctionFilterProbeLatestTransactions($last: Int!) {
        transactions(last: $last) {
          nodes { digest }
        }
      }
    `,
    variables: { last: sampleSize }
  });
  if (result.errors && result.errors.length > 0) {
    const message = result.errors.map((error) => error.message).join("; ");
    throw new TransactionActivitySourceError("provider_error", "Latest transaction sample query returned errors", {
      message
    });
  }
  const nodes = result.data?.transactions?.nodes;
  if (!Array.isArray(nodes)) {
    throw new TransactionActivitySourceError("provider_error", "Latest transaction sample query returned invalid shape");
  }
  return nodes.flatMap((node) => typeof node.digest === "string" && node.digest.length > 0 ? [node.digest] : []);
}

function checkpointNumber(value: string): number {
  const checkpoint = Number(value);
  if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) {
    throw new Error("Sample transaction checkpoint is not a safe GraphQL UInt53 value");
  }
  return checkpoint;
}

function safeSuiAddress(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return parseSuiAddress(value);
  } catch {
    return undefined;
  }
}

async function probeMetadata(options: CliOptions): Promise<ProbeMetadata> {
  const schemaPath = resolve(FUNCTION_FILTER_PROBE_SCHEMA_PATH);
  const scriptPath = fileURLToPath(import.meta.url);
  const [schemaSource, packageJson, scriptSource] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(resolve("package.json"), "utf8"),
    readFile(scriptPath, "utf8")
  ]);
  const parsedPackage = JSON.parse(packageJson) as {
    dependencies?: Record<string, string> | undefined;
  };
  return {
    generatedAt: new Date().toISOString(),
    endpointHost: new URL(options.endpoint).host,
    gitCommit: gitCommit(),
    gitWorktreeState: gitWorktreeState(),
    nodeVersion: process.version,
    suiSdkVersion: parsedPackage.dependencies?.["@mysten/sui"] ?? "unknown",
    schemaPath: FUNCTION_FILTER_PROBE_SCHEMA_PATH,
    schemaSha256: createHash("sha256").update(schemaSource).digest("hex"),
    scriptSha256: createHash("sha256").update(scriptSource).digest("hex"),
    schemaLineRanges: FUNCTION_FILTER_PROBE_SCHEMA_LINE_RANGES,
    sampleSize: options.sampleSize,
    rowLimit: FUNCTION_FILTER_PROBE_ROW_LIMIT
  };
}

function gitCommit(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export function gitStatusOutputToWorktreeState(status: number | null, stdout: string): GitWorktreeState {
  if (status !== 0) {
    return "unknown";
  }
  return stdout.trim().length > 0 ? "dirty" : "clean";
}

function gitWorktreeState(): GitWorktreeState {
  const result = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false
  });
  return gitStatusOutputToWorktreeState(result.status, result.stdout);
}

function renderReport(report: ProbeReport): string {
  const rows = report.results.map((result) => [
    result.target,
    result.filterKeys.join(", "),
    result.status,
    String(result.rowCount),
    result.note ?? ""
  ]);
  return `${[
    "# Function Filter Source Probe",
    "",
    "This ignored note records read-only source-shape evidence for future Phase 4D function diagnostics. It is not product functionality, not a complete-history claim, not a protocol support list, not a route/P&L source, not transaction-building input, and not signing readiness.",
    "",
    "## Metadata",
    "",
    `- Status: ${report.status}`,
    ...(report.notRunReason ? [`- Not-run reason: ${report.notRunReason}`] : []),
    ...(report.notRunMessage ? [`- Not-run message: ${report.notRunMessage}`] : []),
    `- Generated at: ${report.metadata.generatedAt}`,
    `- Endpoint host: ${report.metadata.endpointHost}`,
    `- Chain identifier: ${report.metadata.chainIdentifier ?? "unverified"}`,
    `- Git commit: ${report.metadata.gitCommit}`,
    `- Git worktree state: ${report.metadata.gitWorktreeState}`,
    `- Node version: ${report.metadata.nodeVersion}`,
    `- @mysten/sui version: ${report.metadata.suiSdkVersion}`,
    `- Schema path: ${report.metadata.schemaPath}`,
    `- Schema sha256: ${report.metadata.schemaSha256}`,
    `- Probe script sha256: ${report.metadata.scriptSha256}`,
    `- TransactionFilter lines: ${report.metadata.schemaLineRanges.transactionFilter}`,
    `- TransactionKindInput lines: ${report.metadata.schemaLineRanges.transactionKindInput}`,
    `- Sample size: ${report.metadata.sampleSize}`,
    `- Row limit per probe: ${report.metadata.rowLimit}`,
    `- Evidence expires for implementation planning after: ${FUNCTION_FILTER_PROBE_STALE_AFTER_DAYS} days or any SDK/schema/endpoint/provider behavior change`,
    "",
    "## Sample",
    "",
    report.sample
      ? `- Sample digest: ${report.sample.digest}\n- Sample sender: ${report.sample.sender}\n- Sample function: ${report.sample.function}\n- Sample affected object: ${report.sample.affectedObject}\n- Checkpoint available: ${report.sample.checkpointAvailable}\n- Inspected digests before sample: ${report.sample.inspectedDigests}`
      : "- No sample values recorded.",
    "",
    "## Result Matrix",
    "",
    "| Target | Filter keys | Status | Row count | Note |",
    "| --- | --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`) : ["| none | none | not_run | 0 | no probe target executed |"]),
    "",
    "## Classification Policy",
    "",
    "- `accepted_with_rows`: valid GraphQL data shape and one returned row.",
    "- `accepted_empty`: valid GraphQL data shape and zero returned rows.",
    "- `rejected_by_graphql_validation`: GraphQL validation or filter-combination rejection.",
    "- `inconclusive_network`: timeout, non-200 response, connection failure, or provider reachability failure.",
    "- `inconclusive_mainnet_guard`: endpoint did not verify as Sui mainnet.",
    "- `inconclusive_missing_sample`: required sample value was unavailable.",
    "- `inconclusive_unexpected_shape`: provider response shape was not usable as evidence.",
    "",
    "Network and provider failures are inconclusive. They must not be treated as unsupported filter combinations."
  ].join("\n")}\n`;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseCliOptions(argv: string[]): CliOptions {
  let endpoint = process.env.SUI_MCP_GRAPHQL_URL ?? DEFAULT_SUI_GRAPHQL_URL;
  let sampleSize = FUNCTION_FILTER_PROBE_SAMPLE_SIZE;
  let timeoutMs = DEFAULT_SUI_GRAPHQL_ENDPOINT_VERIFY_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--endpoint") {
      endpoint = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--sample-size") {
      sampleSize = parsePositiveInteger(requiredValue(argv, index, arg), "sample-size");
      if (sampleSize > FUNCTION_FILTER_PROBE_SAMPLE_SIZE) {
        throw new Error(`--sample-size must be ${FUNCTION_FILTER_PROBE_SAMPLE_SIZE} or fewer`);
      }
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredValue(argv, index, arg), "timeout-ms");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { endpoint, sampleSize, timeoutMs };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${field} must be a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage: npm exec -- tsx scripts/sui-graphql-function-filter-probe.ts [--endpoint <url>] [--sample-size <1-50>] [--timeout-ms <ms>]\n\n`);
  process.stdout.write("Runs a read-only Sui mainnet GraphQL TransactionFilter function-combination source probe and writes .WORK/function-filter-source-probe.md.\n");
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const report = await runProbe(options);
  const outputPath = resolve(FUNCTION_FILTER_PROBE_OUTPUT_PATH);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderReport(report), "utf8");
  process.stderr.write(`Wrote ${FUNCTION_FILTER_PROBE_OUTPUT_PATH}\n`);
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false;
}

if (isCliEntrypoint()) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
