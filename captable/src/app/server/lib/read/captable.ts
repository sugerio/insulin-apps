import { api, engine } from "#shared";
import { dec, decOrNull, echo, ratio, type ReadContext } from "./context.ts";
import { pendingExpiryRuns } from "./expiry-runs.ts";
import { describeAudit, ActorLabels } from "./records.ts";
import { securityList, securityLookups } from "./securities.ts";
import { loadValuations } from "./valuations.ts";

/**
 * The cap table, dashboard and Securities Status queues, all computed from the replayed
 * ledger: the three metrics, plan capacity, holder totals and the queues that need an admin.
 */

async function namesAndRows(ctx: ReadContext) {
  const { results } = await ctx.db.prepare("SELECT id, display_name, relationship, issuer_assigned_id FROM stakeholders WHERE org_id = ?")
    .bind(ctx.org.id).all<{ id: string; display_name: string; relationship: api.Stakeholder["relationship"]; issuer_assigned_id: string | null }>();
  return new Map(results.map((row) => [row.id, row]));
}

async function scheduledStakeholders(ctx: ReadContext): Promise<Set<string>> {
  const { results } = await ctx.db.prepare("SELECT stakeholder_id FROM scheduled_terminations WHERE org_id = ? AND status = 'SCHEDULED'").bind(ctx.org.id).all<{ stakeholder_id: string }>();
  return new Set(results.map((row) => row.stakeholder_id));
}

function classesJson(metrics: engine.CapTableMetrics): api.CapTableResponse["classes"] {
  return metrics.classes.map((stockClass) => ({
    stockClassId: stockClass.stockClassId,
    name: stockClass.name,
    authorized: dec(stockClass.authorized),
    issuedAndOutstanding: dec(stockClass.issuedAndOutstanding),
    fullyDiluted: dec(stockClass.fullyDiluted),
    availableToIssue: dec(stockClass.availableToIssue),
  }));
}

function plansJson(metrics: engine.CapTableMetrics): api.CapTableResponse["plans"] {
  return metrics.plans.map((plan) => ({
    stockPlanId: plan.stockPlanId,
    name: plan.name,
    poolSize: dec(plan.poolSize),
    equityOutstanding: dec(plan.equityOutstanding),
    equityRetired: dec(plan.equityRetired),
    available: dec(plan.availableToGrant),
  }));
}

function decRecord(record: Record<string, engine.Dec>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, dec(value)]));
}

export async function capTable(ctx: ReadContext, state: engine.LedgerState, tab: "ownership" | "shares" | "options" | "safes" | "warrants"): Promise<api.CapTableResponse> {
  const metrics = engine.computeMetrics(state);
  const response: api.CapTableResponse = {
    ...echo(ctx, state),
    metrics: {
      issuedAndOutstanding: dec(metrics.issuedAndOutstanding),
      fullyDiluted: dec(metrics.fullyDiluted),
      executionPendingAwards: dec(metrics.executionPendingAwards),
      planAvailable: dec(metrics.planAvailable),
      capitalContribution: dec(metrics.capitalContribution),
    },
    classes: classesJson(metrics),
    plans: plansJson(metrics),
    availablePool: { fullyDiluted: dec(metrics.availablePool.fullyDiluted), fullyDilutedPct: ratio(metrics.availablePool.fullyDilutedPct) },
    totals: { issuedAndOutstanding: dec(metrics.issuedAndOutstanding), fullyDiluted: dec(metrics.fullyDiluted) },
    openingBalances: metrics.openingBalances,
  };
  if (tab === "ownership") {
    const rows = await namesAndRows(ctx);
    const scheduled = await scheduledStakeholders(ctx);
    response.ownership = metrics.holders.map((holder) => {
      const row = rows.get(holder.stakeholderId);
      const terminated = (state.stakeholders.get(holder.stakeholderId)?.terminations.length ?? 0) > 0;
      return {
        stakeholderId: holder.stakeholderId,
        name: row?.display_name ?? "",
        relationship: holder.relationship,
        issuerAssignedId: row?.issuer_assigned_id ?? null,
        status: terminated ? "terminated" : scheduled.has(holder.stakeholderId) ? "terminating" : "active",
        byClass: decRecord(holder.byClass),
        issuedAndOutstanding: dec(holder.stockOutstanding),
        issuedAndOutstandingPct: ratio(holder.issuedAndOutstandingPct),
        planAwards: decRecord(holder.planAwards),
        awardsOutsidePlans: dec(holder.awardsOutsidePlans),
        warrants: dec(holder.warrants),
        fullyDiluted: dec(holder.fullyDiluted),
        fullyDilutedPct: ratio(holder.fullyDilutedPct),
      };
    });
  } else if (tab === "safes") {
    const identities = new Map(ctx.ledger.reference.securities.map((s) => [s.id, s]));
    const lookups = await securityLookups(ctx, state);
    response.safes = [...state.securities.values()]
      .filter((security) => security.issued && security.identity.family === "CONVERTIBLE")
      .map((security) => {
        const terms = (lookups.txById.get(security.issuance!.transactionId)?.payload ?? {}) as { x_safe_terms?: { valuation_cap?: { amount: string } | null; conversion_timing?: string | null; discount_rate?: string | null } };
        const safe = terms.x_safe_terms;
        return {
          securityId: security.identity.id,
          displayId: security.identity.displayId,
          stakeholderId: security.identity.stakeholderId,
          principal: dec(security.issuedQuantity),
          issueDate: security.issueDate!,
          valuationCap: safe?.valuation_cap ? safe.valuation_cap.amount : null,
          conversionTiming: safe?.conversion_timing ?? null,
          discountRate: safe?.discount_rate ?? null,
          status: security.status,
          convertedInto: security.resultingSecurityIds.map((id) => ({ securityId: id, displayId: identities.get(id)?.displayId ?? id })),
        };
      });
  } else {
    const family = tab === "shares" ? "STOCK" : tab === "options" ? "EQUITY_COMPENSATION" : "WARRANT";
    response.rows = securityList(ctx, state, await securityLookups(ctx, state), family);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Securities Status (the API contract; the product rules)

const MISSING: Record<string, "company_signatory" | "holder" | "both"> = {
  pending_company: "company_signatory",
  pending_holder: "holder",
  pending_both: "both",
};

export async function securitiesStatus(ctx: ReadContext, state: engine.LedgerState): Promise<api.SecuritiesStatus> {
  const { results: signatureRows } = await ctx.db.prepare("SELECT id, security_id FROM signature_requests WHERE org_id = ? AND status = 'PENDING' AND security_id IS NOT NULL")
    .bind(ctx.org.id).all<{ id: string; security_id: string }>();
  const { results: scheduledRows } = await ctx.db.prepare(
    "SELECT id, stakeholder_id, termination_date, termination_type, vesting_stop_date, version FROM scheduled_terminations WHERE org_id = ? AND status = 'SCHEDULED' ORDER BY termination_date, id",
  ).bind(ctx.org.id).all<{ id: string; stakeholder_id: string; termination_date: string; termination_type: engine.TerminationType; vesting_stop_date: string; version: number }>();
  const pendingSignatures = new Map<string, string[]>();
  for (const row of signatureRows) pendingSignatures.set(row.security_id, [...(pendingSignatures.get(row.security_id) ?? []), row.id]);
  const executionPending: api.SecuritiesStatus["executionPending"] = [];
  const unvestedShares: api.SecuritiesStatus["unvestedSharesFromTerminated"] = [];
  const optionsFromTerminated: api.SecuritiesStatus["optionsFromTerminated"] = [];
  const expiring: api.SecuritiesStatus["expiringWithin90Days"] = [];
  const horizon = engine.addDays(ctx.today, 90);
  for (const security of state.securities.values()) {
    if (!security.issued || !security.outstanding.isPositive()) continue;
    const id = security.identity.id;
    const missing = MISSING[security.executionStatus];
    if (missing) {
      executionPending.push({
        securityId: id,
        displayId: security.identity.displayId,
        stakeholderId: security.identity.stakeholderId,
        issueDate: security.issueDate!,
        missing,
        signatureRequestIds: pendingSignatures.get(id) ?? [],
      });
    }
    const family = security.identity.family;
    if (security.termination !== null && family === "STOCK" && engine.hasVestingSchedule(security)) {
      const position = engine.positionAt(state, security, state.asOf);
      if (position.unvestedOutstanding.isPositive()) {
        const deadline = engine.repurchaseDeadline(state, security);
        const status = deadline === null ? "not_recorded" : ctx.today > deadline ? "lapsed" : engine.daysBetween(ctx.today, deadline) <= 30 ? "closing_soon" : "open";
        unvestedShares.push({
          securityId: id,
          stakeholderId: security.identity.stakeholderId,
          unvested: dec(position.unvestedOutstanding),
          repurchasePrice: decOrNull(security.repurchaseRight?.pricePerShare ?? null),
          lastRepurchaseDate: deadline,
          status,
        });
      }
    }
    if (security.termination !== null && family === "EQUITY_COMPENSATION") {
      const contractual = engine.contractualDeadline(security);
      const position = engine.positionAt(state, security, state.asOf);
      if (contractual !== null && position.vestedOutstanding.isPositive()) {
        const iso = engine.isoDeadline(state, security);
        optionsFromTerminated.push({
          securityId: id,
          stakeholderId: security.identity.stakeholderId,
          vestedUnexercised: dec(position.vestedOutstanding),
          contractualDeadline: contractual.date,
          contractualDaysLeft: engine.daysBetween(ctx.today, contractual.date),
          isoDeadline: iso?.date ?? null,
          isoDaysLeft: iso?.date ? engine.daysBetween(ctx.today, iso.date) : null,
        });
      }
    }
    if ((family === "EQUITY_COMPENSATION" || family === "WARRANT") && security.expirationDate !== null && security.expirationDate >= ctx.today && security.expirationDate <= horizon) {
      expiring.push({ securityId: id, displayId: security.identity.displayId, expirationDate: security.expirationDate });
    }
  }
  const scheduledTerminations = scheduledRows.map((row) => {
    const effects = engine.terminationPreview(state, row.stakeholder_id, { terminationDate: row.termination_date, terminationType: row.termination_type, vestingStopDate: row.vesting_stop_date });
    return {
      id: row.id,
      stakeholderId: row.stakeholder_id,
      terminationDate: row.termination_date,
      type: row.termination_type,
      securitiesAffected: effects.length,
      unvestedToCancel: dec(engine.Dec.sum(effects.map((effect) => effect.cancel))),
      version: row.version,
    };
  });
  const status: api.SecuritiesStatus = {
    executionPending,
    scheduledTerminations,
    unvestedSharesFromTerminated: unvestedShares,
    optionsFromTerminated: optionsFromTerminated.sort((a, b) => (a.contractualDeadline < b.contractualDeadline ? -1 : 1)),
    expiringWithin90Days: expiring.sort((a, b) => (a.expirationDate < b.expirationDate ? -1 : 1)),
  };
  return status;
}

// ---------------------------------------------------------------------------
// Dashboard (the API contract; the product rules)

export async function dashboard(ctx: ReadContext, state: engine.LedgerState): Promise<api.DashboardResponse> {
  const metrics = engine.computeMetrics(state);
  const status = await securitiesStatus(ctx, state);
  const rows = await namesAndRows(ctx);
  const byRelationship = new Map<string, engine.Dec>();
  for (const holder of metrics.holders) byRelationship.set(holder.relationship, (byRelationship.get(holder.relationship) ?? engine.Dec.ZERO).add(holder.fullyDiluted));
  const fd = metrics.fullyDiluted;
  const share = (value: engine.Dec) => (fd.isZero() ? "0" : ratio(engine.Rational.fromDec(value).div(engine.Rational.fromDec(fd))));
  const ownership = [...byRelationship.entries()]
    .filter(([, value]) => value.isPositive())
    .sort((a, b) => b[1].cmp(a[1]))
    .map(([relationship, value]) => ({ relationship, fullyDiluted: dec(value), pct: share(value) }));
  if (metrics.planAvailable.isPositive()) ownership.push({ relationship: "available", fullyDiluted: dec(metrics.planAvailable), pct: share(metrics.planAvailable) });
  const valuations = await loadValuations(ctx.db, ctx.org.id);
  const inEffect = engine.valuationInEffect(valuations, ctx.today);
  const valuationStatus = inEffect ? engine.valuationStatus(inEffect, valuations, ctx.today) : null;
  const expiryRunsPending = await pendingExpiryRuns(ctx);
  const isoSoon = status.optionsFromTerminated.filter((row) => row.isoDaysLeft !== null && row.isoDaysLeft >= 0 && row.isoDaysLeft <= 30);
  const repurchaseSoon = status.unvestedSharesFromTerminated.filter((row) => row.status === "closing_soon");
  const earliest = (dates: (string | null)[]) => dates.filter((d): d is string => d !== null).sort()[0] ?? null;
  const needsAttention: api.DashboardResponse["needsAttention"] = [
    { kind: "EXECUTION_PENDING", count: status.executionPending.length, dueDate: null, href: "/securities-status#exec" },
    { kind: "SCHEDULED_TERMINATION", count: status.scheduledTerminations.length, dueDate: earliest(status.scheduledTerminations.map((r) => r.terminationDate)), href: "/securities-status#sched" },
    { kind: "ISO_DEADLINE_SOON", count: isoSoon.length, dueDate: earliest(isoSoon.map((r) => r.isoDeadline)), href: "/securities-status#term" },
    { kind: "REPURCHASE_WINDOW_CLOSING", count: repurchaseSoon.length, dueDate: earliest(repurchaseSoon.map((r) => r.lastRepurchaseDate)), href: "/securities-status#rep" },
    {
      kind: "VALUATION_STATUS",
      count: valuationStatus === null || valuationStatus !== "presumptively_valid" ? 1 : 0,
      dueDate: inEffect?.expirationDate ?? null,
      href: "/compliance/409a",
    },
    // Only while a report-only run awaits an administrator: the runs pending confirmation, on their page.
    ...(expiryRunsPending > 0 ? [{ kind: "EXPIRY_RUN_TO_CONFIRM" as const, count: expiryRunsPending, dueDate: null, href: api.EXPIRY_RUNS_HREF }] : []),
  ];
  const labels = new ActorLabels(ctx);
  const { results: audit } = await ctx.db.prepare(
    "SELECT id, occurred_at, actor_kind, actor_user_id, action, details FROM audit_events WHERE org_id = ? AND result = 'success' ORDER BY id DESC LIMIT 8",
  ).bind(ctx.org.id).all<{ id: number; occurred_at: number; actor_kind: string; actor_user_id: string | null; action: string; details: string | null }>();
  const recentActivity = [];
  for (const row of audit) {
    const actor = row.actor_kind === "system" ? "System maintenance" : row.actor_kind === "import"
      ? api.importSourceLabel(ctx.org.import_source)
      : ((await labels.user(row.actor_user_id)) ?? "Unknown");
    recentActivity.push({ id: row.id, occurredAt: row.occurred_at, description: describeAudit(row), actor });
  }
  const answer: api.DashboardResponse = {
    asOf: state.asOf,
    company: {
      totalCapitalContribution: dec(metrics.capitalContribution),
      fullyDilutedShares: dec(metrics.fullyDiluted),
      stakeholdersWithSecurities: metrics.stakeholdersWithSecurities,
    },
    employeeEquity: metrics.plans.map((plan) => ({
      stockPlanId: plan.stockPlanId,
      name: plan.name,
      granted: dec(plan.equityOutstanding),
      available: dec(plan.availableToGrant),
      usedPct: plan.poolSize.isZero() ? "0" : ratio(engine.Rational.fromDec(plan.equityOutstanding.clampZero()).div(engine.Rational.fromDec(plan.poolSize))),
    })),
    ownershipByRelationship: ownership,
    topStakeholders: metrics.holders.filter((holder) => holder.fullyDiluted.isPositive()).slice(0, 10).map((holder) => ({
      stakeholderId: holder.stakeholderId,
      name: rows.get(holder.stakeholderId)?.display_name ?? "",
      fullyDiluted: dec(holder.fullyDiluted),
      pct: ratio(holder.fullyDilutedPct),
    })),
    needsAttention,
    inProgress: {
      executionPending: status.executionPending.length,
      unvestedSharesFromTerminated: status.unvestedSharesFromTerminated.length,
      optionsFromTerminated: status.optionsFromTerminated.length,
      scheduledTerminations: status.scheduledTerminations.length,
    },
    recentActivity,
  };
  return answer;
}
