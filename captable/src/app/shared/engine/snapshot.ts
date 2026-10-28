import { canonicalJson } from "./canonical.ts";
import type { CapTableMetrics } from "./metrics.ts";
import { computeMetrics } from "./metrics.ts";
import { sha256Hex } from "./sha256.ts";
import type { LedgerState } from "./state.ts";

/**
 * A canonical summary of a replayed state and its hash. It covers the engine version, dates, every lot's numbers and
 * status, and every class, plan and holder total.
 */
export function stateSummary(state: LedgerState, metrics: CapTableMetrics = computeMetrics(state)): Record<string, unknown> {
  const sorted = <T>(items: T[], key: (item: T) => string) => [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    engineVersion: metrics.engineVersion,
    orgId: metrics.orgId,
    asOf: metrics.asOf,
    asKnownAt: metrics.asKnownAt,
    ledgerSeq: metrics.ledgerSeq,
    totals: {
      issuedAndOutstanding: metrics.issuedAndOutstanding,
      fullyDiluted: metrics.fullyDiluted,
      executionPendingAwards: metrics.executionPendingAwards,
      planAvailable: metrics.planAvailable,
      capitalContribution: metrics.capitalContribution,
    },
    securities: sorted(metrics.securities, (s) => s.securityId).map((s) => ({
      id: s.securityId,
      status: s.status,
      executionStatus: s.executionStatus,
      issued: s.issued,
      outstanding: s.outstanding,
      fullyDiluted: s.fullyDiluted,
      vested: s.vested,
      unvested: s.unvested,
      exercised: s.exercised,
      exercisable: s.exercisable,
      cancelled: s.cancelled,
      repurchased: s.repurchased,
      forfeited: s.forfeited,
      contractualDeadline: s.contractualDeadline,
      isoDeadline: s.isoDeadline,
    })),
    classes: sorted(metrics.classes, (c) => c.stockClassId).map((c) => ({
      id: c.stockClassId,
      authorized: c.authorized,
      issuedAndOutstanding: c.issuedAndOutstanding,
      conversionRatio: c.conversionRatio,
    })),
    plans: sorted(metrics.plans, (p) => p.stockPlanId).map((p) => ({
      id: p.stockPlanId,
      poolSize: p.poolSize,
      equityOutstanding: p.equityOutstanding,
      equityRetired: p.equityRetired,
      availableToGrant: p.availableToGrant,
    })),
    holders: sorted(metrics.holders, (h) => h.stakeholderId).map((h) => ({ id: h.stakeholderId, stock: h.stockOutstanding, fullyDiluted: h.fullyDiluted })),
    // Conditional so ledgers without the extension retain their byte-identical historical replay summaries.
    ...(state.stakeholderAliases.size > 0 ? {
      stakeholderAliases: [...state.stakeholderAliases.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([merged, survivor]) => ({ merged, survivor })),
    } : {}),
    violations: state.violations.map((v) => `${v.severity}:${v.code}:${v.transactionId ?? ""}:${v.securityId ?? ""}`).sort(),
  };
}

/** SHA-256 of the canonical state summary. */
export function replayHash(state: LedgerState): string {
  return sha256Hex(canonicalJson(stateSummary(state)));
}
