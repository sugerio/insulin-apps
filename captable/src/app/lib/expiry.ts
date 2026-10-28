import type { api } from "#shared";

// Report-only expiry runs. While `settings.expiry.mode` is report_only, processing due items
// records what it would expire as a run instead of expiring it, and an owner or admin confirms the run. Admins and
// editors read the runs (`GET …/expiry-runs`, `GET …/expiry-runs/:runId`).

export const EXPIRY_REASON_LABELS: Record<api.ExpiryProposal["reason"], string> = {
  contractual_deadline: "Exit window ended",
  expiration: "Term ended",
};

export function expiryReasonLabel(reason: string): string {
  return EXPIRY_REASON_LABELS[reason as api.ExpiryProposal["reason"]] ?? reason;
}

export const EXPIRY_RUN_STATE_LABELS: Record<api.ExpiryRunState, string> = {
  pending: "Waiting for an admin",
  confirming: "A confirmation is under way or stopped",
  confirmed: "Confirmed",
  superseded: "Superseded by a newer run",
};

/**
 * Whether a proposal can still be confirmed: something is left to expire. A null `confirmable` means it was exercised,
 * cancelled or extended since the run, and confirming it would be refused (NOT_EXPIRABLE), so it is never sent.
 */
export function isConfirmable(proposal: api.ExpiryProposal): proposal is api.ExpiryProposal & { confirmable: NonNullable<api.ExpiryProposal["confirmable"]> } {
  return proposal.confirmable !== null;
}
