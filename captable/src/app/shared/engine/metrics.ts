import type { IsoDate } from "./dates.ts";
import { contractualDeadline, exercisability, isoDeadline, planTermsOn, repurchaseDeadline } from "./deadlines.ts";
import { Dec } from "./decimal.ts";
import type { PlanReturnRules } from "./plan-rules.ts";
import { positionAt } from "./positions.ts";
import { Rational } from "./rational.ts";
import type { Relationship } from "./schemas.ts";
import type { LedgerState, SecurityState, SecurityStatus } from "./state.ts";
import { ENGINE_VERSION } from "./version.ts";

/**
 * The three cap table metrics and the numbers behind every view (the ledger and product rules):
 *
 * - Issued and outstanding (I&O): legal shares by class (issued − cancelled − repurchased − converted − transferred
 *   out); repurchased (treasury) shares are excluded.
 * - Fully diluted (FD): I&O with each class as converted at its effective ratio + outstanding options and awards,
 *   execution-pending grants included (flagged) + outstanding warrants as exercised (as converted) + the plans' unissued
 *   pools (available to grant). SAFEs and notes, classes excluded from FD, and anything cancelled, expired, forfeited
 *   or retired are left out. This is Pulley's definition: FD = Σ holder FD + Σ plan available (reconciliation M1).
 * - Plan used = equity outstanding (awards + shares issued from awards) + equity retired (under the rules) − explicit
 *   returns; available = pool − used, 0 for a terminated plan (a pour-over moves it to the successor plan).
 */

export interface SecurityNumbers {
  securityId: string;
  family: SecurityState["identity"]["family"];
  subtype: SecurityState["identity"]["subtype"];
  stakeholderId: string;
  displayId: string;
  status: SecurityStatus;
  executionStatus: SecurityState["executionStatus"];
  issueDate: IsoDate | null;
  issued: Dec;
  outstanding: Dec;
  fullyDiluted: Dec;
  vested: Dec;
  unvested: Dec;
  vestedOutstanding: Dec;
  exercised: Dec;
  exercisable: Dec;
  cancelled: Dec;
  repurchased: Dec;
  repurchaseable: Dec;
  forfeited: Dec;
  fullyDilutedPct: Rational;
  outstandingPct: Rational;
  contractualDeadline: IsoDate | null;
  isoDeadline: IsoDate | null;
  deadlineReason: string | null;
  capitalContribution: Dec;
  /** Whether the import source omitted the board approval date. */
  boardApprovalDate: IsoDate | null;
  boardApprovalNotRecordedInPulley: boolean;
  /** Migrated: debt cancelled for the lot, as recorded. */
  debtCancelled: Dec | null;
  /** Migrated legend snapshots. */
  legends: readonly { legendId: string; name: string; text: string }[];
}

export interface ClassMetrics {
  stockClassId: string;
  name: string;
  classType: "COMMON" | "PREFERRED";
  authorized: Dec | null;
  issuedAndOutstanding: Dec;
  /** This class's shares as converted, plus awards and warrants delivering it, plus pools delivering it. */
  fullyDiluted: Dec;
  /** Awards and warrants delivering the class, pools delivering it, and shares reserved for conversion into it. */
  reserved: Dec;
  /** Authorized − outstanding (Pulley's "available"); null when authorized isn't recorded. */
  available: Dec | null;
  /** Authorized − outstanding − reserved ("unreserved"; negative is a warning, the product rules). */
  availableToIssue: Dec | null;
  conversionRatio: Rational;
  votesPerShare: Dec;
  excludedFromFullyDiluted: boolean;
}

export interface PlanMetrics {
  stockPlanId: string;
  name: string;
  stockClassId: string;
  poolSize: Dec;
  awardsOutstanding: Dec;
  sharesOutstanding: Dec;
  equityOutstanding: Dec;
  equityRetired: Dec;
  returned: Dec;
  grantedGross: Dec;
  /** Pool − equity outstanding − equity retired (negative means over-granted, I6). */
  available: Dec;
  /** What can still be granted: 0 for a terminated plan; a pour-over adds the terminated plan's remainder. */
  availableToGrant: Dec;
  status: "active" | "terminated";
  pourOverPlanId: string | null;
  rules: PlanReturnRules | null;
}

export interface HolderMetrics {
  stakeholderId: string;
  relationship: Relationship;
  byClass: Record<string, Dec>;
  /** I&O: the holder's outstanding stock (legal shares). */
  stockOutstanding: Dec;
  planAwards: Record<string, Dec>;
  awardsOutsidePlans: Dec;
  warrants: Dec;
  convertiblesOutstanding: Dec;
  fullyDiluted: Dec;
  issuedAndOutstandingPct: Rational;
  fullyDilutedPct: Rational;
  capitalContribution: Dec;
  vestedOptions: Dec;
  unvestedOptions: Dec;
  executionPending: Dec;
}

export interface CapTableMetrics {
  orgId: string;
  asOf: IsoDate;
  asKnownAt: number | null;
  ledgerSeq: number;
  engineVersion: string;
  issuedAndOutstanding: Dec;
  fullyDiluted: Dec;
  /** The part of FD that is execution pending (flagged everywhere, the product rules). */
  executionPendingAwards: Dec;
  executionPendingCount: number;
  optionsOutstanding: Dec;
  warrantsOutstanding: Dec;
  /** Σ available to grant: the FD "Available pool" row. */
  planAvailable: Dec;
  capitalContribution: Dec;
  stakeholdersWithSecurities: number;
  classes: ClassMetrics[];
  plans: PlanMetrics[];
  holders: HolderMetrics[];
  securities: SecurityNumbers[];
  availablePool: { fullyDiluted: Dec; fullyDilutedPct: Rational };
  openingBalances: { securityId: string; date: IsoDate }[];
}

function ratioOf(numerator: Dec, denominator: Dec): Rational {
  return denominator.isZero() ? Rational.ZERO : Rational.fromDec(numerator).div(Rational.fromDec(denominator));
}

/** The canonical record of a known identity merge. Chains are followed defensively for historical ledgers. */
export function resolveStakeholderId(state: LedgerState, stakeholderId: string): string {
  let current = stakeholderId;
  const seen = new Set<string>();
  while (state.stakeholderAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = state.stakeholderAliases.get(current)!;
  }
  return current;
}

/** The relationship on the state's date: a termination's before/after, else the current reference value. */
export function relationshipAsOf(state: LedgerState, stakeholderId: string): Relationship {
  const stakeholder = state.stakeholders.get(resolveStakeholderId(state, stakeholderId));
  if (!stakeholder) return "other";
  const applied = stakeholder.terminations[stakeholder.terminations.length - 1];
  if (applied) return applied.relationshipAfter;
  const later = [...stakeholder.laterTerminations].sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  return later ? later.relationshipBefore : stakeholder.ref.relationship;
}

/** The class an award, warrant or share delivers (identity, else its plan's class). */
export function deliveredClassId(state: LedgerState, security: SecurityState): string | null {
  if (security.identity.stockClassId !== null) return security.identity.stockClassId;
  if (security.identity.stockPlanId !== null) return state.plans.get(security.identity.stockPlanId)?.ref.stockClassId ?? null;
  return null;
}

/** A lot's fully diluted shares: as converted for stock, as exercised for awards and warrants; 0 for convertibles. */
export function securityFullyDiluted(state: LedgerState, security: SecurityState): Dec {
  if (!security.issued || security.retracted || security.identity.family === "CONVERTIBLE") return Dec.ZERO;
  const outstanding = security.outstanding.clampZero();
  if (outstanding.isZero()) return Dec.ZERO;
  const classId = deliveredClassId(state, security);
  const stockClass = classId !== null ? state.classes.get(classId) : undefined;
  if (stockClass?.terms.excludeFromFullyDiluted) return Dec.ZERO;
  const ratio = stockClass?.conversionRatio ?? Rational.ONE;
  return ratio.eq(Rational.ONE) ? outstanding : Rational.fromDec(outstanding).mul(ratio).floorToUnit(state.shareUnit);
}

function planMetrics(state: LedgerState): PlanMetrics[] {
  const rows: PlanMetrics[] = [];
  for (const plan of state.plans.values()) {
    let awards = Dec.ZERO;
    let shares = Dec.ZERO;
    for (const security of state.securities.values()) {
      if (security.identity.stockPlanId !== plan.ref.id || !security.issued || security.retracted) continue;
      if (security.identity.family === "EQUITY_COMPENSATION") awards = awards.add(security.outstanding);
      else if (security.identity.family === "STOCK") shares = shares.add(security.outstanding);
    }
    const terms = planTermsOn(state, plan.ref.id, state.asOf);
    const equityOutstanding = awards.add(shares);
    const equityRetired = plan.retired.sub(plan.explicitReturns);
    const available = plan.poolSize.sub(equityOutstanding).sub(equityRetired);
    const status = terms?.status ?? "active";
    rows.push({
      stockPlanId: plan.ref.id,
      name: plan.ref.name,
      stockClassId: plan.ref.stockClassId,
      poolSize: plan.poolSize,
      awardsOutstanding: awards,
      sharesOutstanding: shares,
      equityOutstanding,
      equityRetired,
      returned: plan.returned,
      grantedGross: plan.grantedGross,
      available,
      availableToGrant: status === "terminated" ? Dec.ZERO : available,
      status,
      pourOverPlanId: terms?.pourOverPlanId ?? null,
      rules: terms?.rules ?? null,
    });
  }
  // A terminated plan's remaining shares pour over into its successor (the ledger rules).
  for (const row of rows) {
    if (row.status !== "terminated" || row.pourOverPlanId === null || !row.available.isPositive()) continue;
    const target = rows.find((r) => r.stockPlanId === row.pourOverPlanId);
    if (target && target.status === "active") target.availableToGrant = target.availableToGrant.add(row.available);
  }
  return rows;
}

export function securityNumbers(state: LedgerState, security: SecurityState, totals?: { fullyDiluted: Dec; issuedAndOutstanding: Dec }): SecurityNumbers {
  const position = positionAt(state, security, state.asOf);
  const fullyDiluted = securityFullyDiluted(state, security);
  const contractual = contractualDeadline(security);
  const iso = isoDeadline(state, security);
  const repurchaseBy = repurchaseDeadline(state, security);
  const repurchaseOpen = security.termination !== null && (repurchaseBy === null || state.asOf <= repurchaseBy);
  const isStock = security.identity.family === "STOCK";
  return {
    securityId: security.identity.id,
    family: security.identity.family,
    subtype: security.identity.subtype,
    stakeholderId: security.identity.stakeholderId,
    displayId: security.identity.displayId,
    status: security.status,
    executionStatus: security.executionStatus,
    issueDate: security.issueDate,
    issued: security.retracted ? Dec.ZERO : security.issuedQuantity,
    outstanding: security.outstanding,
    fullyDiluted,
    vested: position.vested,
    unvested: position.unvestedOutstanding,
    vestedOutstanding: position.vestedOutstanding,
    exercised: security.exercised.add(security.released),
    exercisable: exercisability(state, security).exercisable,
    cancelled: security.cancelled,
    repurchased: security.repurchased,
    repurchaseable: isStock && repurchaseOpen ? position.unvestedOutstanding : Dec.ZERO,
    forfeited: security.forfeited,
    fullyDilutedPct: totals ? ratioOf(fullyDiluted, totals.fullyDiluted) : Rational.ZERO,
    outstandingPct: totals && isStock ? ratioOf(security.outstanding, totals.issuedAndOutstanding) : Rational.ZERO,
    contractualDeadline: contractual?.date ?? null,
    isoDeadline: iso?.date ?? null,
    deadlineReason: contractual?.reason ?? null,
    capitalContribution: security.retracted ? Dec.ZERO : security.capitalContribution,
    boardApprovalDate: security.boardApprovalDate,
    boardApprovalNotRecordedInPulley: security.boardApprovalNotRecordedInPulley,
    debtCancelled: security.debtCancelled,
    legends: security.legends,
  };
}

export function computeMetrics(state: LedgerState): CapTableMetrics {
  const plans = planMetrics(state);
  const holders = new Map<string, HolderMetrics>();
  const holder = (id: string): HolderMetrics => {
    let row = holders.get(id);
    if (!row) {
      row = {
        stakeholderId: id,
        relationship: relationshipAsOf(state, id),
        byClass: {},
        stockOutstanding: Dec.ZERO,
        planAwards: {},
        awardsOutsidePlans: Dec.ZERO,
        warrants: Dec.ZERO,
        convertiblesOutstanding: Dec.ZERO,
        fullyDiluted: Dec.ZERO,
        issuedAndOutstandingPct: Rational.ZERO,
        fullyDilutedPct: Rational.ZERO,
        capitalContribution: Dec.ZERO,
        vestedOptions: Dec.ZERO,
        unvestedOptions: Dec.ZERO,
        executionPending: Dec.ZERO,
      };
      holders.set(id, row);
    }
    return row;
  };
  let issuedAndOutstanding = Dec.ZERO;
  let executionPending = Dec.ZERO;
  let executionPendingCount = 0;
  let options = Dec.ZERO;
  let warrants = Dec.ZERO;
  let capital = Dec.ZERO;
  const classOutstanding = new Map<string, Dec>();
  const classDelivered = new Map<string, Dec>();
  for (const security of state.securities.values()) {
    if (!security.issued || security.retracted) continue;
    const row = holder(security.identity.stakeholderId);
    row.capitalContribution = row.capitalContribution.add(security.capitalContribution);
    capital = capital.add(security.capitalContribution);
    const outstanding = security.outstanding.clampZero();
    const fd = securityFullyDiluted(state, security);
    row.fullyDiluted = row.fullyDiluted.add(fd);
    const classId = deliveredClassId(state, security);
    switch (security.identity.family) {
      case "STOCK":
        issuedAndOutstanding = issuedAndOutstanding.add(outstanding);
        row.stockOutstanding = row.stockOutstanding.add(outstanding);
        if (classId !== null) {
          row.byClass[classId] = (row.byClass[classId] ?? Dec.ZERO).add(outstanding);
          classOutstanding.set(classId, (classOutstanding.get(classId) ?? Dec.ZERO).add(outstanding));
        }
        break;
      case "EQUITY_COMPENSATION": {
        options = options.add(outstanding);
        const planId = security.identity.stockPlanId;
        if (planId !== null) row.planAwards[planId] = (row.planAwards[planId] ?? Dec.ZERO).add(outstanding);
        else row.awardsOutsidePlans = row.awardsOutsidePlans.add(outstanding);
        if (outstanding.isPositive()) {
          const position = positionAt(state, security, state.asOf);
          row.vestedOptions = row.vestedOptions.add(position.vestedOutstanding);
          row.unvestedOptions = row.unvestedOptions.add(position.unvestedOutstanding);
          if (security.executionStatus.startsWith("pending")) {
            executionPending = executionPending.add(outstanding);
            executionPendingCount += 1;
            row.executionPending = row.executionPending.add(outstanding);
          }
        }
        if (classId !== null) classDelivered.set(classId, (classDelivered.get(classId) ?? Dec.ZERO).add(outstanding));
        break;
      }
      case "WARRANT":
        warrants = warrants.add(outstanding);
        row.warrants = row.warrants.add(outstanding);
        if (classId !== null) classDelivered.set(classId, (classDelivered.get(classId) ?? Dec.ZERO).add(outstanding));
        break;
      case "CONVERTIBLE":
        row.convertiblesOutstanding = row.convertiblesOutstanding.add(outstanding);
        break;
    }
  }
  const planAvailable = Dec.sum(plans.map((p) => p.availableToGrant.clampZero()));
  const holderRows = [...holders.values()];
  const fullyDiluted = Dec.sum(holderRows.map((h) => h.fullyDiluted)).add(planAvailable);
  for (const row of holderRows) {
    row.issuedAndOutstandingPct = ratioOf(row.stockOutstanding, issuedAndOutstanding);
    row.fullyDilutedPct = ratioOf(row.fullyDiluted, fullyDiluted);
  }
  holderRows.sort((a, b) => b.fullyDiluted.cmp(a.fullyDiluted) || (a.stakeholderId < b.stakeholderId ? -1 : 1));

  const classes: ClassMetrics[] = [];
  for (const stockClass of state.classes.values()) {
    const id = stockClass.ref.id;
    const outstanding = classOutstanding.get(id) ?? Dec.ZERO;
    const pools = Dec.sum(plans.filter((p) => p.stockClassId === id).map((p) => p.availableToGrant.clampZero()));
    let conversionReserve = Dec.ZERO;
    for (const other of state.classes.values()) {
      if (other.ref.id === id || other.convertsToClassId !== id) continue;
      conversionReserve = conversionReserve.add(Rational.fromDec(classOutstanding.get(other.ref.id) ?? Dec.ZERO).mul(other.conversionRatio).floorToUnit(state.shareUnit));
    }
    const delivered = classDelivered.get(id) ?? Dec.ZERO;
    const reserved = delivered.add(pools).add(conversionReserve);
    const authorized = stockClass.authorized;
    classes.push({
      stockClassId: id,
      name: stockClass.ref.name,
      classType: stockClass.ref.classType,
      authorized,
      issuedAndOutstanding: outstanding,
      fullyDiluted: stockClass.terms.excludeFromFullyDiluted ? Dec.ZERO : outstanding.add(delivered).add(pools),
      reserved,
      available: authorized === null ? null : authorized.sub(outstanding),
      availableToIssue: authorized === null ? null : authorized.sub(outstanding).sub(reserved),
      conversionRatio: stockClass.conversionRatio,
      votesPerShare: stockClass.terms.votesPerShare,
      excludedFromFullyDiluted: stockClass.terms.excludeFromFullyDiluted,
    });
  }

  const totals = { fullyDiluted, issuedAndOutstanding };
  const securities = [...state.securities.values()].filter((s) => s.issued).map((s) => securityNumbers(state, s, totals));
  const stakeholdersWithSecurities = holderRows.filter((h) => h.fullyDiluted.isPositive() || h.convertiblesOutstanding.isPositive()).length;
  return {
    orgId: state.orgId,
    asOf: state.asOf,
    asKnownAt: state.asKnownAt,
    ledgerSeq: state.ledgerSeq,
    engineVersion: ENGINE_VERSION,
    issuedAndOutstanding,
    fullyDiluted,
    executionPendingAwards: executionPending,
    executionPendingCount,
    optionsOutstanding: options,
    warrantsOutstanding: warrants,
    planAvailable,
    capitalContribution: capital,
    stakeholdersWithSecurities,
    classes,
    plans,
    holders: holderRows,
    securities,
    availablePool: { fullyDiluted: planAvailable, fullyDilutedPct: ratioOf(planAvailable, fullyDiluted) },
    openingBalances: [...state.pendingOpeningBalances.entries()].map(([securityId, date]) => ({ securityId, date })),
  };
}
