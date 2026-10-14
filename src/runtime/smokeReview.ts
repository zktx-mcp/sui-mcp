import { INTENT_PLAN_FACTORIES, resolveIntentPlanFactory, swapIntentInputSchema } from "../adapters/intentPlanFactories.js";
import { computeReviewStateWithPrivateArtifacts, type ReviewComputationDeps } from "../core/review/reviewComputation.js";
import type { SessionStore } from "../core/session/sessionStore.js";

export class SmokeReviewConfigError extends Error {}
const requiredSwapInputs = ["SUI_MCP_SMOKE_SWAP_PROTOCOL", "SUI_MCP_SMOKE_SWAP_FROM_SYMBOL", "SUI_MCP_SMOKE_SWAP_TO_SYMBOL", "SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY"] as const;

/** Optional read-only review computation. This never establishes a wallet
 * connection; the caller owns the explicit temporary read-account fixture. */
export async function computeSmokeReview(options: {
  env: NodeJS.ProcessEnv; account: string; sessions: SessionStore; computation: ReviewComputationDeps; now?: Date;
}): Promise<Record<string, unknown>> {
  const { env, sessions, computation, account } = options;
  const rawSlippage = env.SUI_MCP_SMOKE_SWAP_MAX_SLIPPAGE_BPS;
  if (rawSlippage !== undefined && (!Number.isInteger(Number(rawSlippage)) || Number(rawSlippage) < 1)) {
    throw new SmokeReviewConfigError("SUI_MCP_SMOKE_SWAP_MAX_SLIPPAGE_BPS must be a positive integer.");
  }
  const missing = requiredSwapInputs.filter((name) => env[name] === undefined);
  if (missing.length === requiredSwapInputs.length) return { status: "not_run", notRunReason: "missing_env", requiredEnv: [...requiredSwapInputs] };
  if (missing.length) throw new SmokeReviewConfigError(`Partial account-bound swap smoke configuration; missing: ${missing.join(", ")}`);
  // Preserve the utility's existing 50 bps CLI default; it is not a product
  // recommendation or a silently selected protocol/settlement asset.
  const parsed = swapIntentInputSchema.safeParse({ type: "swap", protocol: env.SUI_MCP_SMOKE_SWAP_PROTOCOL,
    from: { symbol: env.SUI_MCP_SMOKE_SWAP_FROM_SYMBOL, amount: env.SUI_MCP_SMOKE_SWAP_AMOUNT_DISPLAY },
    to: { symbol: env.SUI_MCP_SMOKE_SWAP_TO_SYMBOL }, maxSlippageBps: Number(env.SUI_MCP_SMOKE_SWAP_MAX_SLIPPAGE_BPS ?? "50") });
  if (!parsed.success) throw new SmokeReviewConfigError("The optional swap smoke inputs are invalid.");
  const { protocol, ...intent } = parsed.data;
  const resolution = resolveIntentPlanFactory(INTENT_PLAN_FACTORIES, "swap", protocol);
  if (resolution.status !== "resolved") throw new SmokeReviewConfigError("SUI_MCP_SMOKE_SWAP_PROTOCOL must select a supported swap adapter.");
  const now = options.now ?? new Date(), plan = resolution.factory.createPlan(intent, now);
  const created = await sessions.createReviewSession([plan], now);
  await sessions.recordWalletConnected(created.session.id, account, now);
  const computed = await computeReviewStateWithPrivateArtifacts({ reviewSessionId: created.session.id, plan, account, now }, computation);
  await sessions.recordReviewStateWithArtifacts(created.session.id, computed.state, computed.privateArtifacts, now);
  return { status: "ok", reviewStatus: computed.state.status, blockedReason: computed.state.blockedReason,
    completedStageCount: computed.state.adapterLifecycle?.completedStages.length ?? 0,
    missingStages: computed.state.adapterLifecycle?.missingStages ?? [],
    reviewDataEmitted: computed.state.transactionReviewData !== undefined,
    failedCheckIds: computed.state.checks.filter((check) => check.status === "fail").map((check) => check.id) };
}
