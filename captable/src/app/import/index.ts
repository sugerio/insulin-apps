import { engine } from "#shared";
import { buildCanonicalDraft } from "./draft.ts";
import { mapDraftToLedger } from "./map.ts";
import { reconcilePlan } from "./reconcile.ts";
import { parseUploadedReports, type ParsedPulleyReport } from "./reports.ts";
import { parseTemplateImport } from "./template.ts";
import { importWritePlanSchema } from "./types.ts";
import type { DetectedImportFile, ImportDraft, ImportPreview, ImportPreviewOptions, ImportProblem, ImportTotalsPreview, UploadedImportFile } from "./types.ts";
import { validateDraft } from "./validate.ts";

export type * from "./types.ts";
export { readXlsxBytes, exactDecimal, type WorkbookSheet } from "./xlsx.ts";
export { parseReportWorkbook, parseUploadedReports, rowsToRecords, type ParsedPulleyReport, type ParsedReportRow } from "./reports.ts";
export { generateCapTableTemplate, parseTemplateImport } from "./template.ts";
export { replayPlan, toEngineVestingDefinition } from "./map.ts";

/** Pure entry point from Pulley report bytes to a fully replayed, ready-to-write import plan. */
export function buildImportPreview(files: readonly UploadedImportFile[], options: ImportPreviewOptions = {}): ImportPreview {
  const parsed = parseUploadedReports(files);
  const draft = buildCanonicalDraft(parsed.reports, options.currency ?? options.fallbackCurrency ?? "USD");
  return previewDraft(draft, parsed.detectedFiles, parsed.problems, parsed.fileSha256, options, parsed.reports);
}

/** Pure entry point for the app's own Cap Table spreadsheet template. */
export function buildTemplateImportPreview(file: UploadedImportFile, options: ImportPreviewOptions = {}): ImportPreview {
  const parsed = parseTemplateImport(file, options.currency ?? options.fallbackCurrency ?? "USD");
  return previewDraft(parsed.draft, parsed.detectedFiles, parsed.problems, parsed.fileSha256, options, []);
}

function previewDraft(
  draft: ImportDraft,
  detectedFiles: DetectedImportFile[],
  baseProblems: ImportProblem[],
  fileSha256: ReadonlyMap<string, string>,
  options: ImportPreviewOptions,
  reports: readonly ParsedPulleyReport[],
): ImportPreview {
  const currency = options.currency ?? draft.currency;
  const asOfDate = options.asOfDate ?? draft.asOfDate;
  draft.asOfDate = asOfDate ?? null;
  const shareUnit = options.shareUnit ?? "1";
  const problems: ImportProblem[] = [...baseProblems, ...validateDraft(draft, asOfDate, options.today, reports)];
  if (!engine.Dec.isCanonical(shareUnit) || shareUnit === "0") problems.push({ severity: "error", code: "SHARE_UNIT_INVALID", message: "The share unit must be a positive exact decimal.", source: null });
  if (!/^[A-Z]{3}$/.test(currency)) problems.push({ severity: "error", code: "CURRENCY_INVALID", message: "The import currency must be a three-letter code such as USD.", source: null });

  let plan: ImportPreview["plan"] = null;
  let openingBalances: ImportPreview["openingBalances"] = [];
  let totals = emptyTotals(draft);
  if (!problems.some((problem) => problem.severity === "error") && asOfDate && engine.isIsoDate(asOfDate) && engine.Dec.isCanonical(shareUnit) && shareUnit !== "0" && /^[A-Z]{3}$/.test(currency)) {
    try {
      const mapped = mapDraftToLedger(draft, { asOfDate, orgId: options.orgId ?? deterministicOrgId(draft.companyName ?? "imported-company"), shareUnit, currency, fileSha256 });
      problems.push(...mapped.problems); openingBalances = mapped.openingBalances;
      const reconciled = reconcilePlan(mapped.plan, draft); problems.push(...reconciled.problems); totals = reconciled.totals;
      importWritePlanSchema.parse(mapped.plan); plan = mapped.plan;
    } catch (error) {
      problems.push({ severity: "error", code: "IMPORT_MAPPING_FAILED", message: `The upload could not be mapped to the ledger: ${error instanceof Error ? error.message : String(error)}`, source: null });
    }
  }
  const uniqueProblems = deduplicateProblems(problems);
  const canImport = !uniqueProblems.some((problem) => problem.severity === "error") && plan !== null;
  return { detectedFiles, draft, problems: uniqueProblems, openingBalances, totals, plan: canImport ? plan : null, canImport };
}

function emptyTotals(draft: ImportDraft): ImportTotalsPreview { return { uploaded: draft.totals, app: { fullyDiluted: null, issuedAndOutstanding: null, byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} }, reconciliation: [] } }
function deterministicOrgId(label: string): string { const hex = engine.sha256Hex(`spreadsheet-import:org:${label}`); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
function deduplicateProblems(problems: readonly ImportProblem[]): ImportProblem[] { const seen = new Set<string>(); return problems.filter((problem) => { const key = `${problem.severity}|${problem.code}|${problem.message}|${problem.source?.file ?? ""}|${problem.source?.sheet ?? ""}|${problem.source?.row ?? ""}|${problem.source?.column ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
