import { engine } from "#shared";
import { decimalsEqual } from "./decimal.ts";
import { replayPlan } from "./map.ts";
import type { ImportDraft, ImportProblem, ImportReferenceRow, ImportTotalsPreview, ImportWritePlan, ReconciliationLine, SourceLocation } from "./types.ts";

export function reconcilePlan(plan: ImportWritePlan, draft: ImportDraft): { totals: ImportTotalsPreview; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const reconciliation: ReconciliationLine[] = [];
  const blank: ImportTotalsPreview["app"] = { fullyDiluted: null, issuedAndOutstanding: null, byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} };
  try {
    const { state, metrics } = replayPlan(plan);
    const classRows = referenceMap(plan, "stock_class"); const planRows = referenceMap(plan, "stock_plan"); const stakeholderRows = referenceMap(plan, "stakeholder");
    const securityMetrics = new Map(metrics.securities.map((item) => [item.displayId, item]));
    const classMetrics = new Map(metrics.classes.map((item) => [item.stockClassId, item]));
    const planMetrics = new Map(metrics.plans.map((item) => [item.stockPlanId, item]));
    const holderMetrics = new Map(metrics.holders.map((item) => [item.stakeholderId, item]));
    const app: ImportTotalsPreview["app"] = { fullyDiluted: metrics.fullyDiluted.toCanonical(), issuedAndOutstanding: metrics.issuedAndOutstanding.toCanonical(), byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} };
    for (const source of draft.securities) {
      const metric = securityMetrics.get(source.displayId);
      if (metric) app.bySecurity[source.sourceId] = { outstanding: metric.outstanding.toCanonical(), vested: metric.vested.toCanonical(), vestedOutstanding: metric.vestedOutstanding.toCanonical() };
    }
    const totals = draft.totals;
    if (totals?.company) {
      compare(reconciliation, problems, "company", null, draft.companyName ?? "Company", "fully diluted shares", totals.company.fullyDiluted, app.fullyDiluted, totals.company.source);
      const pulleyOutstanding = metrics.issuedAndOutstanding.add(engine.Dec.sum(metrics.plans.map((item) => item.equityOutstanding))).toCanonical();
      compare(reconciliation, problems, "company", null, draft.companyName ?? "Company", "outstanding shares", totals.company.outstanding, pulleyOutstanding, totals.company.source);
      const grossIssued = engine.Dec.sum(metrics.securities.filter((item) => item.family !== "CONVERTIBLE").map((item) => item.issued)).toCanonical();
      compare(reconciliation, problems, "company", null, draft.companyName ?? "Company", "issued shares", totals.company.issued, grossIssued, totals.company.source);
    }
    for (const source of totals?.classes ?? []) { const row = [...classRows.values()].find((item) => item.sourceId === source.sourceId); const metric = row ? classMetrics.get(row.id) : undefined; const actual = metric?.issuedAndOutstanding.toCanonical() ?? null; if (actual !== null) app.byClass[source.sourceId] = actual; compare(reconciliation, problems, "class", source.sourceId, source.name, "outstanding shares", source.outstanding, actual, source.source); }
    for (const source of totals?.plans ?? []) { const row = [...planRows.values()].find((item) => item.sourceId === source.sourceId); const metric = row ? planMetrics.get(row.id) : undefined; if (metric) app.byPlan[source.sourceId] = { outstanding: metric.equityOutstanding.toCanonical(), available: metric.available.toCanonical() }; compare(reconciliation, problems, "plan", source.sourceId, source.name, "outstanding equity", source.outstanding, metric?.equityOutstanding.toCanonical() ?? null, source.source); compare(reconciliation, problems, "plan", source.sourceId, source.name, "available pool", source.available, metric?.available.toCanonical() ?? null, source.source); }
    for (const source of totals?.holders ?? []) { const row = [...stakeholderRows.values()].find((item) => item.sourceId === source.sourceId); const metric = row ? holderMetrics.get(row.id) : undefined; const fd = metric?.fullyDiluted.toCanonical() ?? "0"; const outstanding = row ? engine.Dec.sum(metrics.securities.filter((item) => item.stakeholderId === row.id && item.family !== "CONVERTIBLE").map((item) => item.outstanding)).toCanonical() : "0"; app.byHolder[source.sourceId] = { fullyDiluted: fd, outstanding }; compare(reconciliation, problems, "holder", source.sourceId, source.name, "fully diluted shares", source.fullyDiluted, fd, source.source); if (source.outstanding !== null) compare(reconciliation, problems, "holder", source.sourceId, source.name, "outstanding shares", source.outstanding, outstanding, source.source); }
    const securityTotals = draft.sourceSystem === "template"
      ? draft.securities.filter((item) => item.vested !== null || item.vestedOutstanding !== null).map((item) => ({ sourceId: item.sourceId, name: item.displayId, outstanding: null, vested: item.vested, vestedOutstanding: item.vestedOutstanding, source: item.source }))
      : totals?.securities ?? [];
    for (const source of securityTotals) { const metric = app.bySecurity[source.sourceId]; compare(reconciliation, problems, "security", source.sourceId, source.name, "outstanding", source.outstanding, metric?.outstanding ?? null, source.source); if (source.vested !== null) compare(reconciliation, problems, "security", source.sourceId, source.name, "vested", source.vested, metric?.vested ?? null, source.source); if (source.vestedOutstanding !== null) compare(reconciliation, problems, "security", source.sourceId, source.name, "vested outstanding", source.vestedOutstanding, metric?.vestedOutstanding ?? null, source.source); }
    if (totals?.detailed?.company) {
      compareDetailed(problems, draft.companyName ?? "Company", "fully diluted shares", totals.detailed.company.fullyDiluted, app.fullyDiluted, totals.detailed.company.source);
      compareDetailed(problems, draft.companyName ?? "Company", "issued and outstanding shares", totals.detailed.company.issuedAndOutstanding, app.issuedAndOutstanding, totals.detailed.company.source);
    }
    for (const source of totals?.detailed?.holders ?? []) {
      const row = [...stakeholderRows.values()].find((item) => item.sourceId === source.sourceId); const metric = row ? holderMetrics.get(row.id) : undefined;
      compareDetailed(problems, source.name, "fully diluted shares", source.fullyDiluted, metric?.fullyDiluted.toCanonical() ?? null, source.source);
      compareDetailed(problems, source.name, "issued and outstanding shares", source.issuedAndOutstanding, metric?.stockOutstanding.toCanonical() ?? null, source.source);
    }
    for (const violation of state.violations) {
      const context = violationContext(violation, plan, draft);
      problems.push({ severity: violation.severity, code: "LEDGER_REPLAY_PROBLEM", message: friendlyViolation(violation, context.label), source: context.source });
    }
    return { totals: { uploaded: totals, app, reconciliation }, problems };
  } catch (error) {
    problems.push({ severity: "error", code: "ENGINE_REPLAY_FAILED", message: `The preview could not replay the imported records: ${error instanceof Error ? error.message : String(error)}`, source: null });
    return { totals: { uploaded: draft.totals, app: blank, reconciliation }, problems };
  }
}

function compare(lines: ReconciliationLine[], problems: ImportProblem[], scope: ReconciliationLine["scope"], sourceId: string | null, name: string, metric: string, uploaded: string | null, app: string | null, source: SourceLocation): void {
  if (uploaded === null) return;
  const matches = app !== null && decimalsEqual(uploaded, app); lines.push({ scope, sourceId, name, metric, uploaded, app, matches, source });
  if (!matches) problems.push({ severity: "error", code: "TOTAL_MISMATCH", message: `The spreadsheet reports ${uploaded} ${metric} for ${name}, but this preview produces ${app ?? "no matching total"}. Review this source value and the mapped transactions shown in the preview.`, source });
}
function compareDetailed(problems: ImportProblem[], name: string, metric: string, uploaded: string | null, app: string | null, source: SourceLocation): void { if (uploaded !== null && (app === null || !decimalsEqual(uploaded, app))) problems.push({ severity: "warning", code: "REPORT_TOTAL_MISMATCH", message: `The Detailed Cap Table reports ${uploaded} ${metric} for ${name}, but this preview produces ${app ?? "no matching total"}. Re-export the Detailed report for the same snapshot.`, source }); }
function referenceMap<E extends ImportReferenceRow["entity"]>(plan: ImportWritePlan, entity: E): Map<string, Extract<ImportReferenceRow, { entity: E }>> {
  return new Map(plan.referenceRows
    .filter((row): row is Extract<ImportReferenceRow, { entity: E }> => row.entity === entity)
    .map((row) => [String((row as { id?: string | null }).id ?? row.sourceId ?? ""), row]));
}
function violationContext(violation: engine.Violation, plan: ImportWritePlan, draft: ImportDraft): { source: SourceLocation | null; label: string } {
  const planned = violation.securityId ? plan.commands.flatMap((command) => command.securities).find((security) => security.id === violation.securityId) : undefined;
  const security = planned ? draft.securities.find((item) => item.sourceId === planned.sourceId) : undefined;
  if (security) return { source: security.source, label: security.displayId };
  if (violation.transactionId) { const tx = plan.commands.flatMap((command) => command.transactions).find((item) => item.id === violation.transactionId); const item = tx ? draft.securities.find((candidate) => tx.sourceRef.startsWith(candidate.sourceId)) : undefined; if (item) return { source: item.source, label: item.displayId }; }
  return { source: null, label: "the imported cap table" };
}
function friendlyViolation(violation: engine.Violation, label: string): string {
  if (violation.code === "ISO_FMV_REQUIRED") return `Grant ${label} needs FMV at grant before its ISO treatment can be verified.`;
  if (violation.code === "ISO_LOTS_UNVERIFIED") return `Grant ${label} needs complete ISO and NSO details before its tax lots can be verified.`;
  if (violation.code === "EXERCISE_EXCEEDS_VESTED") return `Exercise of ${label} exceeds the options vested on that date.`;
  if (violation.code === "PLAN_TERMS_MISSING") return `The equity plan for ${label} is missing its return rules.`;
  return `${label}: ${violation.message}.`;
}
