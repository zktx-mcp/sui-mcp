import { expect, it } from "vitest";
import { computeSmokeReview, SmokeReviewConfigError } from "../src/runtime/smokeReview.js";
import { walletWorkflowFixture } from "./fixtures/walletWorkflow.js";
import { findForbiddenMcpFields } from "../src/core/action/forbiddenFields.js";

it("runs optional review with actual core/storage while using an explicit temporary read context", async () => {
  const f = await walletWorkflowFixture();
  try {
    await f.run(() => f.activity.setActiveAccount(f.account, "wallet_connection", f.now()));
    const result = await f.run(() => computeSmokeReview({ env: { SUI_MCP_SMOKE_SWAP_PROTOCOL: "deep", SUI_MCP_SMOKE_SWAP_FROM_SYMBOL: "SUI", SUI_MCP_SMOKE_SWAP_TO_SYMBOL: "USDC", SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY: "1" },
      account: f.account, sessions: f.sessions, computation: f.computation, now: f.now() }));
    expect(result).toMatchObject({ status: "ok", reviewStatus: "ready_for_wallet_review", reviewDataEmitted: true, missingStages: [], failedCheckIds: [] });
    expect(findForbiddenMcpFields(result)).toEqual([]);
    expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    expect((await f.run(() => f.sessions.listReviewSessions(f.now)))).toHaveLength(1);
  } finally { f.close(); }
});

it("skips absent optional inputs and rejects partial or unsupported protocol choices before session creation", async () => {
  const f = await walletWorkflowFixture();
  try {
    const run = (env: NodeJS.ProcessEnv) => f.run(() => computeSmokeReview({ env, account: f.account, sessions: f.sessions, computation: f.computation, now: f.now() }));
    expect(await run({})).toMatchObject({ status: "not_run", notRunReason: "missing_env" });
    for (const env of [{ SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY: "1" }, { SUI_MCP_SMOKE_SWAP_PROTOCOL: "unknown", SUI_MCP_SMOKE_SWAP_FROM_SYMBOL: "SUI", SUI_MCP_SMOKE_SWAP_TO_SYMBOL: "USDC", SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY: "1" }]) {
      await expect(run(env)).rejects.toBeInstanceOf(SmokeReviewConfigError);
    }
    expect(await f.run(() => f.sessions.listReviewSessions(f.now))).toEqual([]);
    expect(f.connect).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  } finally { f.close(); }
});
