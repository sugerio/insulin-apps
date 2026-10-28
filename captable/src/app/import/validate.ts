import { engine } from "#shared";
import { addDecimals, canonicalDecimal, decimalError, decimalsEqual, isPositive } from "./decimal.ts";
import type { ParsedPulleyReport } from "./reports.ts";
import type { ImportDraft, ImportProblem, SourceLocation } from "./types.ts";

const NUMERIC_COLUMN = /(?:Amount|Principal|Authorized|Available|Outstanding|Issued|Granted|Quantity|Options|Shares|Price|FMV|Fully\s*Diluted|Total Exercised|ISOs?|NSOs?|Vested|Votes|Ratio|Discount)$|^(?:ISOs?|NSOs?)\b/i;

export function validateDraft(draft: ImportDraft, asOfDate: string | null, today?: string, reports: readonly ParsedPulleyReport[] = []): ImportProblem[] {
  const problems: ImportProblem[] = [...draft.adapterProblems, ...validateInputDecimals(reports)];
  if (!draft.companyName?.trim() && !draft.adapterProblems.some((item) => item.code === "TEMPLATE_COMPANY_MISSING")) problems.push(error("COMPANY_NAME_MISSING", "Company name is required before the cap table can be imported.", draft.totals?.company?.source ?? null));
  if (asOfDate === null || !engine.isIsoDate(asOfDate)) {
    problems.push(error("EXPORT_DATE_MISSING", `Choose the date represented by this ${draft.sourceSystem === "pulley" ? "Pulley export" : "spreadsheet"}.`, draft.totals?.company?.source ?? null));
  } else {
    if (today && engine.isIsoDate(today) && asOfDate > today) problems.push(error("EXPORT_DATE_IN_FUTURE", `The as-of date ${asOfDate} is after today (${today}). Choose the date the data actually represented.`, draft.totals?.company?.source ?? null));
    for (const fact of datedFacts(draft)) if (engine.isIsoDate(fact.date) && fact.date > asOfDate) problems.push(error("DATE_AFTER_EXPORT", `${fact.label} is dated ${fact.date}, after the as-of date ${asOfDate}.`, fact.source));
  }

  duplicates(draft.stakeholders, "sourceId", "stakeholder", problems);
  duplicates(draft.shareClasses, "sourceId", "share class", problems);
  duplicates(draft.equityPlans, "sourceId", "equity plan", problems);
  duplicates(draft.securities, "displayId", "certificate or grant", problems);
  duplicates(draft.exercises, "sourceId", "exercise", problems);
  duplicates(draft.cancellations, "sourceId", "cancellation", problems);
  const stakeholders = new Set(draft.stakeholders.map((row) => row.sourceId));
  const classes = new Set(draft.shareClasses.map((row) => row.sourceId));
  const plans = new Set(draft.equityPlans.map((row) => row.sourceId));
  const securities = new Map(draft.securities.map((row) => [row.sourceId, row]));

  for (const stakeholder of draft.stakeholders) if (stakeholder.terminationDate && stakeholder.terminationType === null) problems.push(error("TERMINATION_TYPE_MISSING", `${stakeholder.name}'s termination date is present, but its termination type is missing. Add voluntary, involuntary, with cause, death, disability, or retirement.`, stakeholder.source));

  for (const stockClass of draft.shareClasses) {
    if (stockClass.classType === null) problems.push(error("CLASS_TYPE_MISSING", `Share class ${stockClass.name || stockClass.sourceId} must say whether it is Common or Preferred.`, stockClass.source));
    requiredDecimal(stockClass.authorized, `Share class ${stockClass.name}`, "authorized shares", stockClass.source, problems, true);
    requiredDecimal(stockClass.outstanding, `Share class ${stockClass.name}`, "outstanding shares", stockClass.source, problems);
    if (stockClass.classType === "PREFERRED") requiredDecimal(stockClass.conversionRatio, `Preferred class ${stockClass.name}`, "conversion ratio", stockClass.source, problems, true);
  }
  for (const plan of draft.equityPlans) {
    if (!plan.stockClassSourceId || !classes.has(plan.stockClassSourceId)) problems.push(error("PLAN_CLASS_MISSING", `Plan ${plan.name || plan.sourceId} does not identify the share class its grants deliver.`, plan.source));
    requiredDecimal(plan.poolSize, `Plan ${plan.name}`, "pool size", plan.source, problems, true);
    if (plan.available !== null) requiredDecimal(plan.available, `Plan ${plan.name}`, "available amount", plan.source, problems);
    if (plan.outstanding !== null) requiredDecimal(plan.outstanding, `Plan ${plan.name}`, "outstanding amount", plan.source, problems);
    if (valid(plan.poolSize) && valid(plan.outstanding) && engine.Dec.parse(plan.outstanding).gt(engine.Dec.parse(plan.poolSize))) problems.push(error("PLAN_OVER_ALLOCATED", `Plan ${plan.name} has ${plan.poolSize} authorized shares but ${plan.outstanding} outstanding.`, plan.source));
  }

  const exerciseTotals = new Map<string, string>();
  for (const exercise of draft.exercises) if (valid(exercise.quantity)) exerciseTotals.set(exercise.optionSourceId, addDecimals([exerciseTotals.get(exercise.optionSourceId) ?? "0", exercise.quantity]) ?? "0");

  for (const security of draft.securities) {
    const label = security.kind === "option" ? `Grant ${security.displayId}` : security.kind === "safe" ? `SAFE ${security.displayId}` : `Certificate ${security.displayId}`;
    if (!stakeholders.has(security.stakeholderSourceId)) problems.push(error("STAKEHOLDER_REFERENCE_MISSING", `${label} refers to a stakeholder that is not in the uploaded stakeholder data.`, security.source));
    if (security.kind !== "safe" && security.kind !== "unsupported" && (!security.stockClassSourceId || !classes.has(security.stockClassSourceId))) problems.push(error("CLASS_REFERENCE_MISSING", `${label} does not refer to a valid share class.`, security.source));
    if (security.kind === "option" && (!security.stockPlanSourceId || !plans.has(security.stockPlanSourceId))) problems.push(error("PLAN_REFERENCE_MISSING", `${label} does not refer to a valid equity plan.`, security.source));
    if (security.kind === "unsupported") problems.push(error("INSTRUMENT_UNSUPPORTED", `${security.displayId || "This row"} has unsupported instrument type ${security.unsupportedType || "(blank)"}. Only shares, options, warrants, and SAFEs can be imported.`, security.source));
    if (security.kind === "option" && security.optionType === null) problems.push(error("OPTION_TYPE_MISSING", `${label} is missing its ISO or NSO type.`, security.source));
    if (security.kind === "option" && security.earlyExercise === null) problems.push(error("EARLY_EXERCISE_MISSING", `${label} must say whether early exercise is allowed.`, security.source));
    if ((security.kind === "option" || security.kind === "warrant") && security.price === null) problems.push(error("EXERCISE_PRICE_MISSING", `${label} is missing its exercise price.`, security.source));
    if (security.kind === "stock" && security.price === null) problems.push(error("SHARE_PRICE_MISSING", `${label} is missing its price per share.`, security.source));
    if (security.kind === "warrant" && security.purchasePrice === null) problems.push(error("WARRANT_PURCHASE_PRICE_MISSING", `${label} is missing its purchase price.`, security.source));
    if (security.issueDate !== null && !engine.isIsoDate(security.issueDate)) problems.push(error("DATE_INVALID", `${label} has an invalid issue or grant date (${security.issueDate}).`, security.source));
    for (const [field, value] of [["issued", security.issued], ["outstanding", security.outstanding], ["exercised", security.exercised], ["cancelled", security.cancelled], ["repurchased", security.repurchased], ["transferred", security.transferred]] as const) {
      requiredDecimal(value, label, field, security.source, problems, field === "issued");
      if (valid(value) && engine.Dec.parse(value).isNegative()) problems.push(error(field === "outstanding" ? "SECURITY_QUANTITY_EXCEEDED" : "SECURITY_QUANTITY_NEGATIVE", field === "outstanding" ? `${label} has more exercised, cancelled, repurchased, or transferred than it was issued for.` : `${label} has a negative ${field} quantity.`, security.source));
    }
    const accounted = valid(security.outstanding) && valid(security.exercised) && valid(security.cancelled) && valid(security.repurchased) && valid(security.transferred) ? addDecimals([security.outstanding, security.exercised, security.cancelled, security.repurchased, security.transferred]) : null;
    if (accounted !== null && valid(security.issued) && !decimalsEqual(accounted, security.issued)) problems.push(error("SECURITY_QUANTITY_MISMATCH", `${label} was issued for ${security.issued}, but outstanding (${security.outstanding}) + exercised (${security.exercised}) + cancelled (${security.cancelled}) + repurchased (${security.repurchased}) + transferred (${security.transferred}) is ${accounted}.`, security.source));
    if (valid(security.repurchased) && security.repurchased !== "0") {
      if (security.kind !== "stock") problems.push(error("REPURCHASE_INSTRUMENT_UNSUPPORTED", `${label} reports repurchased shares, but only stock lots can be repurchased.`, security.source));
      if (!security.repurchaseDate) problems.push(error("REPURCHASE_DATE_MISSING", `${label} reports ${security.repurchased} repurchased shares but no repurchase date. Add the dated repurchase before importing.`, security.source));
      else if (!engine.isIsoDate(security.repurchaseDate)) problems.push(error("DATE_INVALID", `${label} has an invalid repurchase date (${security.repurchaseDate}).`, security.source));
      if (!security.issueDate || !engine.isIsoDate(security.issueDate)) problems.push(error("REPURCHASE_ISSUANCE_DATE_MISSING", `${label} has a repurchase but no reliable issue date to establish the shares first.`, security.source));
      else if (security.repurchaseDate && engine.isIsoDate(security.repurchaseDate) && security.repurchaseDate < security.issueDate) problems.push(error("REPURCHASE_BEFORE_ISSUE", `${label}'s repurchase on ${security.repurchaseDate} is before its issue date ${security.issueDate}.`, security.source));
      if (security.repurchaseConsideration === null) problems.push(error("REPURCHASE_CONSIDERATION_MISSING", `${label} reports repurchased shares but not AmountPaidForRepurchase. Add the amount paid so the repurchase price is not guessed.`, security.source));
      else if (!engine.Dec.isCanonical(security.repurchaseConsideration)) problems.push(error("DECIMAL_INVALID", `${label} has an invalid repurchase consideration.`, security.source));
    }
    if (valid(security.transferred) && security.transferred !== "0") problems.push(error("TRANSFER_DETAILS_MISSING", `${label} reports transferred shares without recipient lots. Upload transfer lineage that identifies each recipient before importing.`, security.source));
    if (draft.sourceSystem === "pulley" && security.kind === "option" && security.exercised !== null) {
      const reported = exerciseTotals.get(security.sourceId) ?? "0";
      if (!decimalsEqual(reported, security.exercised)) problems.push(error("EXERCISED_AMOUNT_MISMATCH", `${label} reports ${security.exercised} exercised in Raw Cap Table, but the Exercised Options rows add up to ${reported}. Re-export both reports for the same date.`, security.source));
    }
    if (security.unvestedCancelled !== null && security.cancelled !== null && engine.Dec.isCanonical(security.unvestedCancelled) && engine.Dec.isCanonical(security.cancelled) && engine.Dec.parse(security.unvestedCancelled).gt(engine.Dec.parse(security.cancelled))) problems.push(error("UNVESTED_CANCELLATION_MISMATCH", `${label} reports more unvested cancellations than total cancellations.`, security.source));
  }

  for (const exercise of draft.exercises) {
    const option = securities.get(exercise.optionSourceId);
    if (!option) { problems.push(error("GRANT_REFERENCE_MISSING", `An exercise refers to grant ${exercise.optionDisplayId}, which is not in the uploaded securities.`, exercise.source)); continue; }
    if (!engine.isIsoDate(exercise.date)) problems.push(error("DATE_INVALID", `Exercise of ${exercise.optionDisplayId} has an invalid date (${exercise.date || "blank"}).`, exercise.source));
    if (!option.issueDate || !engine.isIsoDate(option.issueDate)) problems.push(error("GRANT_DATE_REQUIRED_FOR_EXERCISE", `Grant ${exercise.optionDisplayId} needs a valid grant date before its exercise can be imported.`, exercise.source));
    requiredDecimal(exercise.quantity, `Exercise of ${exercise.optionDisplayId}`, "Total Exercised", exercise.source, problems, true);
    requiredDecimal(exercise.exercisePrice, `Exercise of ${exercise.optionDisplayId}`, "Exercise Price", exercise.source, problems);
    if (option.issueDate && engine.isIsoDate(exercise.date) && engine.isIsoDate(option.issueDate) && exercise.date < option.issueDate) problems.push(error("EXERCISE_BEFORE_GRANT", `Exercise on ${exercise.date} is before grant ${exercise.optionDisplayId} was issued on ${option.issueDate}.`, exercise.source));
    if (exercise.isoQuantity === null || exercise.nsoQuantity === null) problems.push(error("EXERCISE_PORTIONS_MISSING", `Exercise of ${exercise.optionDisplayId} must include both ISO and NSO exercised columns; use zero for the unused portion.`, exercise.source));
    else if (exercise.quantity !== null) { const portions = addDecimals([exercise.isoQuantity, exercise.nsoQuantity]); if (portions !== null && !decimalsEqual(portions, exercise.quantity)) problems.push(error("EXERCISE_PORTIONS_MISMATCH", `Exercise of ${exercise.optionDisplayId} is ${exercise.quantity}, but its ISO and NSO portions add up to ${portions}.`, exercise.source)); }
    if (exercise.unvestedOnExercise !== null && exercise.unvestedOnExercise !== "0" && option.earlyExercise !== true) problems.push(error("EARLY_EXERCISE_NOT_ALLOWED", `Exercise of ${exercise.optionDisplayId} includes ${exercise.unvestedOnExercise} unvested options, but the grant does not allow early exercise.`, exercise.source));
    if (exercise.resultingSecuritySourceId && !securities.has(exercise.resultingSecuritySourceId)) problems.push(error("EXERCISE_RESULT_MISSING", `Exercise of ${exercise.optionDisplayId} names a resulting certificate that is not in the uploaded securities.`, exercise.source));
  }

  for (const cancellation of draft.cancellations) {
    const security = securities.get(cancellation.securitySourceId);
    if (!security) { problems.push(error("SECURITY_REFERENCE_MISSING", "A cancellation refers to a security that is not in the upload.", cancellation.source)); continue; }
    requiredDecimal(cancellation.quantity, `Cancellation of ${security.displayId}`, "quantity", cancellation.source, problems, true);
    if (cancellation.date && !engine.isIsoDate(cancellation.date)) problems.push(error("DATE_INVALID", `Cancellation of ${security.displayId} has an invalid date (${cancellation.date}).`, cancellation.source));
    if (cancellation.date && engine.isIsoDate(cancellation.date) && (!security.issueDate || !engine.isIsoDate(security.issueDate))) problems.push(error("CANCELLATION_ISSUANCE_DATE_MISSING", `${security.displayId} has a dated cancellation but no reliable issue or grant date to establish the security first.`, cancellation.source));
    if (cancellation.date && security.issueDate && engine.isIsoDate(cancellation.date) && engine.isIsoDate(security.issueDate) && cancellation.date < security.issueDate) problems.push(error("CANCELLATION_BEFORE_ISSUE", `Cancellation on ${cancellation.date} is before ${security.displayId} was issued on ${security.issueDate}.`, cancellation.source));
  }

  for (const schedule of draft.vesting) {
    const security = securities.get(schedule.securitySourceId);
    if (!security) { problems.push(error("VESTING_GRANT_MISSING", "Vesting details refer to a grant that is not in the uploaded securities.", schedule.source)); continue; }
    if (schedule.definitionType === "EXPLICIT") {
      if (schedule.events.length === 0) problems.push(error("VESTING_EVENTS_MISSING", `${security.displayId} has no vesting events. Re-export Vesting Details through an end date covering the full schedule.`, schedule.source));
      for (const event of schedule.events) {
        if (!engine.isIsoDate(event.date)) problems.push(error("DATE_INVALID", `A vesting event for ${security.displayId} has an invalid date (${event.date || "blank"}).`, event.source));
        requiredDecimal(event.quantity, `Vesting event for ${security.displayId}`, "quantity", event.source, problems, true);
      }
      const quantities = schedule.events.map((event) => event.quantity).filter((item): item is string => item !== null);
      const sum = quantities.length === schedule.events.length ? addDecimals(quantities) : null;
      if (sum !== null && security.issued !== null && !decimalsEqual(sum, security.issued)) problems.push(error("VESTING_QUANTITY_MISMATCH", `Vesting events for ${security.displayId} add up to ${sum}, but the security was issued for ${security.issued}. Re-export Vesting Details through an end date covering all future events.`, schedule.source));
      if (schedule.granted !== null && security.issued !== null && !decimalsEqual(schedule.granted, security.issued)) problems.push(error("VESTING_GRANTED_MISMATCH", `Vesting Details says ${security.displayId} was granted ${schedule.granted}, but Raw Cap Table says ${security.issued}.`, schedule.source));
    } else {
      if (!schedule.schedule) problems.push(error("VESTING_SCHEDULE_INVALID", `${security.displayId} does not have a usable time-based vesting schedule.`, schedule.source));
      if (!schedule.startDate || !engine.isIsoDate(schedule.startDate)) problems.push(error("VESTING_START_DATE_INVALID", `${security.displayId} needs a valid vesting start date.`, schedule.source));
      if (schedule.granted !== null && security.issued !== null && !decimalsEqual(schedule.granted, security.issued)) problems.push(error("VESTING_GRANTED_MISMATCH", `${security.displayId}'s vesting quantity is ${schedule.granted}, but the grant quantity is ${security.issued}.`, schedule.source));
    }
  }
  for (const split of draft.isoNsoSplits) {
    if (!securities.has(split.securitySourceId)) problems.push(error("ISO_NSO_GRANT_MISSING", `ISO/NSO Details refer to grant ${split.grantDisplayId}, which is not in the uploaded securities.`, split.source));
    if (split.total !== null && split.iso !== null && split.nso !== null) { const sum = addDecimals([split.iso, split.nso]); if (sum !== null && sum !== "0" && !decimalsEqual(sum, split.total)) problems.push(error("ISO_NSO_QUANTITY_MISMATCH", `ISO and NSO quantities for ${split.grantDisplayId} add up to ${sum}, but the report says ${split.total}.`, split.source)); }
  }
  return problems;
}

function datedFacts(draft: ImportDraft): Array<{ date: string; label: string; source: SourceLocation }> {
  return [
    ...draft.securities.flatMap((item) => [item.issueDate ? { date: item.issueDate, label: `${item.displayId}'s issue date`, source: item.source } : null, item.convertedDate ? { date: item.convertedDate, label: `${item.displayId}'s conversion`, source: item.source } : null, item.repurchaseDate ? { date: item.repurchaseDate, label: `${item.displayId}'s repurchase`, source: item.source } : null]).filter(nonNull),
    ...draft.exercises.map((item) => ({ date: item.date, label: `Exercise of ${item.optionDisplayId}`, source: item.source })),
    ...draft.cancellations.flatMap((item) => item.date ? [{ date: item.date, label: "A cancellation", source: item.source }] : []),
    ...draft.stakeholders.flatMap((item) => item.terminationDate ? [{ date: item.terminationDate, label: `${item.name}'s termination`, source: item.source }] : []),
  ];
}
function nonNull<T>(value: T | null): value is T { return value !== null }
function validateInputDecimals(reports: readonly ParsedPulleyReport[]): ImportProblem[] {
  const problems: ImportProblem[] = [];
  for (const report of reports) {
    if (report.kind === "stakeholder-transactions") continue;
    for (const [sheet, rows] of Object.entries(report.sheets)) {
      // Vest-event quantities are parsed into the draft and validated there. Avoid a
      // second 96,000-cell pass for large Pulley exports.
      if (sheet === "Vest Events") continue;
      for (const row of rows) for (const [column, raw] of Object.entries(row.values)) {
        if (!NUMERIC_COLUMN.test(column) || raw.trim() === "" || /%$/.test(raw.trim())) continue;
        const issue = decimalError(raw);
        if (issue === "precision") problems.push(error("DECIMAL_OVER_PRECISE", `${column} value ${raw} has more than 12 decimal places or is too long.`, { ...row.source, column }));
        else if (issue === "invalid" || canonicalDecimal(raw) === null) problems.push(error("DECIMAL_INVALID", `${column} contains ${raw}, which is not a valid exact decimal.`, { ...row.source, column }));
      }
    }
  }
  return problems;
}
function requiredDecimal(value: string | null, label: string, field: string, source: SourceLocation, problems: ImportProblem[], positive = false): void { if (value === null) problems.push(error("NUMBER_MISSING", `${label} is missing required ${field}.`, source)); else if (!engine.Dec.isCanonical(value)) problems.push(error("DECIMAL_INVALID", `${label} has invalid ${field}.`, source)); else if (positive && !isPositive(value)) problems.push(error("QUANTITY_NOT_POSITIVE", `${label} must have positive ${field}.`, source)); }
function duplicates<T extends { source: SourceLocation }>(rows: readonly T[], key: keyof T, noun: string, problems: ImportProblem[]): void { const seen = new Set<string>(); for (const row of rows) { const id = String(row[key] ?? ""); if (seen.has(id)) problems.push(error("DUPLICATE_ID", `${noun[0]!.toUpperCase()}${noun.slice(1)} ${id || "(blank)"} appears more than once.`, row.source)); seen.add(id); } }
function valid(value: string | null): value is string { return value !== null && engine.Dec.isCanonical(value) }
function error(code: string, message: string, source: SourceLocation | null): ImportProblem { return { severity: "error", code, message, source } }
