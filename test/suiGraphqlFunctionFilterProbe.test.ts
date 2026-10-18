import { describe, expect, it } from "vitest";
import {
  buildFunctionFilterProbeTargets,
  classifyFunctionFilterProbeError,
  classifyFunctionFilterProbeRows,
  gitStatusOutputToWorktreeState,
  redactProbeSampleText,
  sanitizeProbeErrorMessage
} from "../scripts/sui-graphql-function-filter-probe.js";
import { TransactionActivitySourceError } from "../src/core/activity/transactionActivityTypes.js";

const sender = `0x${"a".repeat(64)}`;
const objectId = `0x${"b".repeat(64)}`;
const target = `0x${"c".repeat(64)}::pool::swap_exact_quantity`;

describe("Sui GraphQL function filter probe helpers", () => {
  it("builds the function filter probe matrix with kind and checkpoint axes", () => {
    const targets = buildFunctionFilterProbeTargets({
      functionTarget: target,
      sender,
      checkpoint: "42",
      affectedObject: objectId,
      inspectedDigests: 3
    });

    expect(targets.map((probeTarget) => probeTarget.name)).toEqual([
      "function",
      "function + sentAddress",
      "function + affectedAddress",
      "function + affectedObject",
      "function + kind: PROGRAMMABLE_TX",
      "function + kind: SYSTEM_TX",
      "function + atCheckpoint",
      "function + sentAddress + atCheckpoint",
      "function + affectedAddress + atCheckpoint",
      "function + sentAddress + afterCheckpoint + beforeCheckpoint",
      "function + affectedAddress + afterCheckpoint + beforeCheckpoint"
    ]);
    expect(targets).toContainEqual(expect.objectContaining({
      name: "function + kind: SYSTEM_TX",
      filter: { function: target, kind: "SYSTEM_TX" }
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      name: "function + sentAddress + afterCheckpoint + beforeCheckpoint",
      filter: { function: target, sentAddress: sender, afterCheckpoint: 41, beforeCheckpoint: 43 }
    }));
  });

  it("marks affectedObject probes as missing-sample instead of unsupported", () => {
    const targets = buildFunctionFilterProbeTargets({
      functionTarget: target,
      sender,
      checkpoint: "42",
      inspectedDigests: 3
    });

    const affectedObjectTarget = targets.find((probeTarget) => probeTarget.name === "function + affectedObject");
    expect(affectedObjectTarget).toMatchObject({
      filterKeys: ["function", "affectedObject"],
      missingSampleReason: "sample transaction had no objectChanges address"
    });
    expect(affectedObjectTarget).not.toHaveProperty("filter");
  });

  it("caps accepted row counts at one for combination acceptance probes", () => {
    expect(classifyFunctionFilterProbeRows([])).toEqual({
      status: "accepted_empty",
      rowCount: 0
    });
    expect(classifyFunctionFilterProbeRows([{}, {}])).toEqual({
      status: "accepted_with_rows",
      rowCount: 1
    });
    expect(classifyFunctionFilterProbeRows(undefined)).toEqual({
      status: "inconclusive_unexpected_shape",
      rowCount: 0
    });
  });

  it("separates concrete GraphQL validation rejection from network and unexpected errors", () => {
    expect(
      classifyFunctionFilterProbeError(new TransactionActivitySourceError(
        "provider_error",
        "Sui GraphQL query returned errors",
        { message: "Variable $filter got invalid value for TransactionFilter.function" }
      ))
    ).toMatchObject({
      status: "rejected_by_graphql_validation"
    });
    expect(
      classifyFunctionFilterProbeError(new TransactionActivitySourceError(
        "provider_error",
        "Sui GraphQL query returned errors",
        { message: "Failed to parse \"TransactionFilter\": At most one of [affectedAddress, affectedObject, function, kind] can be specified" }
      ))
    ).toMatchObject({
      status: "rejected_by_graphql_validation"
    });
    expect(
      classifyFunctionFilterProbeError(new TransactionActivitySourceError(
        "provider_error",
        "Sui GraphQL query failed",
        { message: "fetch failed: ECONNRESET" }
      ))
    ).toMatchObject({
      status: "inconclusive_network"
    });
    expect(classifyFunctionFilterProbeError(new Error("provider returned a strange payload"))).toMatchObject({
      status: "inconclusive_unexpected_shape"
    });
    expect(classifyFunctionFilterProbeError(new Error("provider returned an unknown field argument in a runtime response"))).toMatchObject({
      status: "inconclusive_unexpected_shape"
    });
  });

  it("redacts sampled identifiers and caps error messages", () => {
    const raw = `${target} touched ${sender} and digest CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8`;
    const redacted = redactProbeSampleText(raw);

    expect(redacted).toContain("[REDACTED_SAMPLE_FUNCTION]");
    expect(redacted).toContain("[REDACTED_SAMPLE_ADDRESS]");
    expect(redacted).toContain("[REDACTED_SAMPLE_DIGEST]");
    expect(redacted).not.toContain(target);
    expect(redacted).not.toContain(sender);
    expect(sanitizeProbeErrorMessage(`${raw} ${"x".repeat(200)}`).length).toBeLessThanOrEqual(160);
  });

  it("classifies git porcelain output for reproducibility metadata", () => {
    expect(gitStatusOutputToWorktreeState(0, "")).toBe("clean");
    expect(gitStatusOutputToWorktreeState(0, " M docs/UTILITY_INDEX.md\n")).toBe("dirty");
    expect(gitStatusOutputToWorktreeState(0, "?? scripts/sui-graphql-function-filter-probe.ts\n")).toBe("dirty");
    expect(gitStatusOutputToWorktreeState(1, "")).toBe("unknown");
    expect(gitStatusOutputToWorktreeState(null, "")).toBe("unknown");
  });
});
