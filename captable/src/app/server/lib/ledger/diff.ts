import { engine } from "#shared";
import type { Change, ChangeEntity, TxDraft } from "./types.ts";

/**
 * What a command changes (`CommandResult.changes` in the API contract), computed by comparing the replayed state without and
 * with its transactions, and the diff hash the person reviews (CL-42): a dry run and the real call compute the same
 * hash unless the ledger moved in between, in which case the real call gets 409 state_changed.
 */

type Snapshot = Record<string, unknown> | null;

function text(value: engine.Dec | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function securitySnapshot(state: engine.LedgerState, security: engine.SecurityState | undefined): Snapshot {
  if (!security || !security.issued) return null;
  const position = engine.positionAt(state, security, state.asOf);
  return {
    displayId: security.identity.displayId,
    status: security.status,
    executionStatus: security.executionStatus,
    outstanding: text(security.outstanding),
    vested: text(position.vested),
    unvested: text(position.unvestedOutstanding),
    exercisable: text(engine.exercisability(state, security).exercisable),
    exercised: text(security.exercised.add(security.released)),
    cancelled: text(security.cancelled),
    termination: security.termination === null ? null : {
      date: security.termination.date,
      type: security.termination.type,
      disabilityAttestation: security.termination.disabilityAttestation,
    },
  };
}

function deadlineSnapshot(state: engine.LedgerState, security: engine.SecurityState | undefined): Snapshot {
  if (!security || !security.issued) return null;
  const contractual = engine.contractualDeadline(security)?.date ?? null;
  const iso = engine.isoDeadline(state, security)?.date ?? null;
  const repurchase = security.identity.family === "STOCK" ? engine.repurchaseDeadline(state, security) : null;
  if (contractual === null && iso === null && repurchase === null) return null;
  return { contractual, iso, repurchase };
}

function stakeholderSnapshot(state: engine.LedgerState, id: string): Snapshot {
  const stakeholder = state.stakeholders.get(id);
  if (!stakeholder) return null;
  const termination = stakeholder.terminations[stakeholder.terminations.length - 1] ?? null;
  return {
    relationship: engine.relationshipAsOf(state, id),
    termination: termination === null ? null : { date: termination.date, type: termination.type, vestingStopDate: termination.vestingStopDate },
    leaves: stakeholder.leaves.map((leave) => ({ startDate: leave.startDate, endDate: leave.endDate, returnGuaranteed: leave.returnGuaranteed })),
  };
}

function planTermsSnapshot(state: engine.LedgerState, planId: string): Snapshot {
  const terms = engine.planTermsOn(state, planId, state.asOf);
  if (!terms) return null;
  return {
    effectiveDate: terms.date,
    returnRules: { ...terms.rules },
    defaultTerminationWindows: terms.defaultTerminationWindows,
    defaultRepurchaseWindow: terms.defaultRepurchaseWindow,
    status: terms.status,
    pourOverPlanId: terms.pourOverPlanId,
  };
}

function same(a: Snapshot, b: Snapshot): boolean {
  return engine.canonicalJson(a) === engine.canonicalJson(b);
}

function push(changes: Change[], entity: ChangeEntity, id: string, before: Snapshot, after: Snapshot): void {
  if (!same(before, after)) changes.push({ entity, id, before, after });
}

/** The changes between two replays of the same org at the same date. `newSecurityIds` get their vesting table. */
export function computeChanges(orgId: string, before: engine.LedgerState, after: engine.LedgerState, newSecurityIds: ReadonlySet<string>): Change[] {
  const changes: Change[] = [];
  for (const [id, security] of after.securities) {
    const prior = before.securities.get(id);
    push(changes, "security", id, securitySnapshot(before, prior), securitySnapshot(after, security));
    push(changes, "deadline", id, deadlineSnapshot(before, prior), deadlineSnapshot(after, security));
    const stopBefore = prior?.vestingStop?.date ?? null;
    const stopAfter = security.vestingStop?.date ?? null;
    if (newSecurityIds.has(id) && security.issued && engine.hasVestingSchedule(security)) {
      const events = engine.securityVestingTimeline(after, security).map((event) => ({
        date: event.date,
        quantity: event.quantity.toString(),
        cumulative: event.cumulative.toString(),
        kind: event.kind,
      }));
      changes.push({ entity: "vesting", id, before: null, after: { events } });
    } else if (stopBefore !== stopAfter || (prior?.accelerations.length ?? 0) !== security.accelerations.length) {
      const view = (s: engine.SecurityState | undefined) =>
        s ? { stopDate: s.vestingStop?.date ?? null, accelerated: engine.Dec.sum(s.accelerations.map((a) => a.quantity)).toString() } : null;
      push(changes, "vesting", id, view(prior), view(security));
    }
  }
  for (const id of after.stakeholders.keys()) push(changes, "stakeholder", id, stakeholderSnapshot(before, id), stakeholderSnapshot(after, id));
  const beforeMetrics = engine.computeMetrics(before);
  const afterMetrics = engine.computeMetrics(after);
  for (const plan of afterMetrics.plans) {
    const prior = beforeMetrics.plans.find((p) => p.stockPlanId === plan.stockPlanId);
    const view = (p: engine.PlanMetrics | undefined) =>
      p ? { poolSize: p.poolSize.toString(), equityOutstanding: p.equityOutstanding.toString(), equityRetired: p.equityRetired.toString(), availableToGrant: p.availableToGrant.toString() } : null;
    push(changes, "pool", plan.stockPlanId, view(prior), view(plan));
    push(changes, "stock_plan", plan.stockPlanId, planTermsSnapshot(before, plan.stockPlanId), planTermsSnapshot(after, plan.stockPlanId));
  }
  for (const stockClass of afterMetrics.classes) {
    const prior = beforeMetrics.classes.find((c) => c.stockClassId === stockClass.stockClassId);
    const view = (c: engine.ClassMetrics | undefined) =>
      c ? { issuedAndOutstanding: c.issuedAndOutstanding.toString(), fullyDiluted: c.fullyDiluted.toString(), authorized: text(c.authorized) } : null;
    push(changes, "stock_class", stockClass.stockClassId, view(prior), view(stockClass));
  }
  push(changes, "capital", orgId, { capitalContribution: beforeMetrics.capitalContribution.toString() }, { capitalContribution: afterMetrics.capitalContribution.toString() });
  return changes;
}

/** Replaces each generated id, at any depth, with its position in the generation order. */
function normalize(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => normalize(item, ids));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalize(item, ids);
    return out;
  }
  return value;
}

/** The org-wide totals a change moves: every command moves them. */
const AGGREGATES: ReadonlySet<ChangeEntity> = new Set(["pool", "stock_class", "capital"]);

/** after − before per decimal field; a field that isn't a decimal on both sides keeps its before and after. */
function aggregateDelta(before: Snapshot, after: Snapshot): unknown {
  if (before === null || after === null) return { before, after };
  const delta: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    delta[key] = typeof from === "string" && typeof to === "string" ? engine.Dec.from(to).sub(engine.Dec.from(from)).toString() : { before: from, after: to };
  }
  return delta;
}

function normalizedParts(changes: readonly Change[], drafts: readonly TxDraft[], generatedIds: readonly string[], reviewedInputs: readonly unknown[] = []): { transactions: unknown[]; changes: Change[]; reviewedInputs: unknown[] } {
  const ids = new Map(generatedIds.map((id, index) => [id, `$new:${index}`]));
  return {
    transactions: drafts.map((draft) => normalize({ type: draft.type, effectiveDate: draft.effectiveDate, payload: draft.payload }, ids)),
    changes: changes
      .map((change) => normalize(change, ids) as Change)
      .sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    reviewedInputs: reviewedInputs.map((input) => normalize(input, ids)),
  };
}

/**
 * SHA-256 of the canonical changes and transactions without generated ids and seqs (the API contract): the ids a call
 * generates (the command, new lots, vesting rows, transactions) become `$new:<n>` in generation order, which is
 * deterministic for the same request against the same ledger. Every change enters whole, with its before and after,
 * so the real call commits exactly the diff that was reviewed (409 `state_changed` otherwise).
 */
export function diffSha256(changes: readonly Change[], drafts: readonly TxDraft[], generatedIds: readonly string[], reviewedInputs: readonly unknown[] = []): string {
  return engine.sha256Hex(engine.canonicalJson(normalizedParts(changes, drafts, generatedIds, reviewedInputs)));
}

/**
 * SHA-256 of what the command itself does (the API contract): its transactions, its changes to the securities, deadlines,
 * vesting and stakeholders it touches (before and after), and the org-wide totals (a plan's pool, a class's totals,
 * the capital contribution) as deltas. Another command in between moves those totals' absolute values but not this
 * command's effect, so a bulk flow re-runs each later dry run and asks again only when this hash changed. It never
 * replaces `diffSha256`: the real call still sends the new exact diff hash.
 */
export function effectSha256(changes: readonly Change[], drafts: readonly TxDraft[], generatedIds: readonly string[], reviewedInputs: readonly unknown[] = []): string {
  const parts = normalizedParts(changes, drafts, generatedIds, reviewedInputs);
  return engine.sha256Hex(engine.canonicalJson({
    transactions: parts.transactions,
    changes: parts.changes.map((change) => (AGGREGATES.has(change.entity) ? { entity: change.entity, id: change.id, delta: aggregateDelta(change.before, change.after) } : change)),
    reviewedInputs: parts.reviewedInputs,
  }));
}
