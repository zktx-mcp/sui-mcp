import type { InternalSessionStatus } from "../action/types.js";

const allowed: Record<InternalSessionStatus, readonly InternalSessionStatus[]> = {
  proposed: ["awaiting_wallet", "expired"],
  awaiting_wallet: ["wallet_connected", "expired"],
  wallet_connected: ["ready_for_wallet_review", "refresh_required", "blocked", "expired"],
  ready_for_wallet_review: ["refresh_required", "blocked", "expired"],
  refresh_required: ["ready_for_wallet_review", "blocked", "expired"],
  blocked: ["ready_for_wallet_review", "refresh_required", "expired"],
  expired: []
};

export function canTransitionReview(from: InternalSessionStatus, to: InternalSessionStatus): boolean {
  return from === to || allowed[from].includes(to);
}

// Binding a proposed session crosses awaiting_wallet inside a single write.
export function reviewStatusAfterBinding(status: InternalSessionStatus): InternalSessionStatus | undefined {
  if (status === "expired") return undefined;
  return status === "proposed" || status === "awaiting_wallet" ? "wallet_connected" : status;
}

export function interruptedReviewStatus(status: InternalSessionStatus, hasState: boolean): InternalSessionStatus {
  return hasState && status !== "expired" ? "refresh_required" : status;
}
