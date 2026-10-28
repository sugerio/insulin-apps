import { engine } from "#shared";
import { addDecimals, canonicalDecimal, decimalsEqual, repurchasePrice, subtractDecimals } from "./decimal.ts";
import type { ParsedPulleyReport, ParsedReportRow } from "./reports.ts";
import type {
  CancellationDraft, EquityPlanDraft, ExerciseDraft, ImportDraft, ImportProblem, IsoNsoSplitDraft,
  SecurityDraft, ShareClassDraft, StakeholderDraft, VestingDraft, VestingEventDraft,
} from "./types.ts";

/** Pulley-specific adapter. Everything after this function consumes the neutral ImportDraft. */
export function buildCanonicalDraft(reports: readonly ParsedPulleyReport[], currency = "USD"): ImportDraft {
  const raw = one(reports, "raw-cap-table");
  const detailed = one(reports, "detailed-cap-table");
  const stakeholderReport = one(reports, "stakeholders");
  const vestingReport = one(reports, "vesting-details");
  const exerciseReport = one(reports, "exercised-options");
  const isoReport = one(reports, "iso-nso-details");
  const adapterProblems: ImportProblem[] = [];
  const assumptions: string[] = [];
  const companyRow = raw?.sheets.Company?.[0] ?? null;
  const statedCurrencies = new Set([
    ...(raw?.sheets.ShareClasses ?? []),
    ...(raw?.sheets.Convertibles ?? []),
  ].map((row) => value(row, "Currency")).filter(Boolean));
  const importCurrency = statedCurrencies.size === 1 ? [...statedCurrencies][0]! : currency;

  const rawStakeholders = raw?.sheets.StakeholderCompanies ?? [];
  const detailStakeholders = stakeholderReport?.sheets.Stakeholders ?? [];
  const detailByRawId = new Map<string, ParsedReportRow>();
  for (const row of detailStakeholders) {
    const rawId = value(row, "External ID", "Id", "Stakeholder ID");
    if (rawId) detailByRawId.set(rawId, row);
  }
  const rawNameCounts = counts(rawStakeholders.map((row) => normalize(value(row, "Name"))));
  const detailNameCounts = counts(detailStakeholders.map((row) => normalize(value(row, "Name"))));
  const detailByUniqueName = new Map(detailStakeholders
    .filter((row) => detailNameCounts.get(normalize(value(row, "Name"))) === 1)
    .map((row) => [normalize(value(row, "Name")), row]));

  const stakeholders: StakeholderDraft[] = rawStakeholders.map((row) => {
    const rawId = value(row, "Id");
    const nameKey = normalize(value(row, "Name"));
    let detail = detailByRawId.get(rawId);
    if (!detail && rawNameCounts.get(nameKey) === 1) detail = detailByUniqueName.get(nameKey);
    if (!detail && rawNameCounts.get(nameKey)! > 1 && detailNameCounts.get(nameKey)! > 0) {
      adapterProblems.push(problem("STAKEHOLDER_NAME_AMBIGUOUS", `More than one stakeholder is named ${value(row, "Name")}. Add External ID values to the Stakeholders report so no email can be assigned to the wrong person.`, row.source));
    }
    const terminationDate = dateOrNull(first(row, detail, "TerminationDate", "Termination Date"));
    const rawTerminationType = first(row, detail, "TerminationType", "Termination Type");
    const parsedTerminationType = terminationType(rawTerminationType);
    if (terminationDate !== null && rawTerminationType === "") assumptions.push(`${first(row, detail, "Name")}: Pulley does not export a termination type, so this import uses voluntary as the conservative unspecified termination type.`);
    return {
      sourceId: sourceId("stakeholder", rawId),
      name: first(row, detail, "Name"),
      email: empty(first(row, detail, "Email")),
      kind: stakeholderKind(first(row, detail, "StakeholderType", "Type")),
      relationship: relationship(first(row, detail, "Relationship")),
      terminationDate,
      terminationType: terminationDate !== null && rawTerminationType === "" ? "voluntary" : parsedTerminationType,
      source: row.source,
    };
  });
  const stakeholderIdByRaw = new Map(rawStakeholders.map((row) => [value(row, "Id"), sourceId("stakeholder", value(row, "Id"))]));

  const shareClasses: ShareClassDraft[] = (raw?.sheets.ShareClasses ?? []).map((row) => ({
    sourceId: sourceId("class", value(row, "Id")),
    name: value(row, "Name"),
    classType: classType(value(row, "ClassType", "Class Type", "Type")),
    authorized: decimal(row, "AuthorizedNumberOfShares"),
    outstanding: decimal(row, "OutstandingAmount"),
    conversionRatio: decimal(row, "ConversionRatio"),
    originalIssuePrice: decimal(row, "PricePerShare", "OriginalIssuePrice"),
    currency: value(row, "Currency") || importCurrency,
    source: row.source,
  }));
  if (shareClasses.length > 0) assumptions.push("Authorized share counts are imported as current totals effective on the earliest dated record; the export does not provide their full amendment history.");
  const classIdByRaw = new Map((raw?.sheets.ShareClasses ?? []).map((row) => [value(row, "Id"), sourceId("class", value(row, "Id"))]));

  const detailEntries = detailed ? Object.entries(detailed.sheets).flatMap(([sheet, rows]) => rows.map((row) => ({ sheet, row }))) : [];
  const detailByDisplay = new Map<string, { sheet: string; row: ParsedReportRow }>();
  for (const entry of detailEntries) {
    const display = value(entry.row, "Certificate ID", "Warrant ID", "Convertible ID");
    if (display && !detailByDisplay.has(display)) detailByDisplay.set(display, entry);
  }

  const rawPlans = raw?.sheets.EquityPlan ?? [];
  const plans: EquityPlanDraft[] = rawPlans.map((row) => ({
    sourceId: sourceId("plan", value(row, "Id")),
    name: value(row, "Name"),
    stockClassSourceId: classIdByRaw.get(value(row, "SecurityClassId", "ShareClassId", "StockClassId")) ?? null,
    poolSize: decimal(row, "AuthorizedAmount"), available: decimal(row, "AvailableAmount"), outstanding: decimal(row, "OutstandingAmount"),
    effectiveDate: dateOrNull(value(row, "EffectiveDate", "Effective Date", "BoardApprovalDate")),
    terminationWindowDays: integerOrNull(value(row, "ExerciseWindowAfterTerminationDays", "Exercise Window After Termination (Days)")), source: row.source,
  }));
  if (plans.length > 0) assumptions.push("Equity plan pool sizes are imported as current totals effective on the plan approval or earliest grant date; the export does not provide every pool amendment.");
  if (plans.length > 0) assumptions.push("Equity plan return-to-pool rules use the engine defaults (RETURN for all five events) because the Pulley export does not state those rules.");
  const planIdByRaw = new Map(rawPlans.map((row) => [value(row, "Id"), sourceId("plan", value(row, "Id"))]));
  const planBySource = new Map(plans.map((plan) => [plan.sourceId, plan]));
  const planByName = new Map(plans.map((plan) => [normalize(plan.name), plan]));

  const subjectRows = vestingReport?.sheets["Equity Subject to Vesting"] ?? [];
  const subjectByDisplay = new Map(subjectRows.map((row) => [value(row, "Security ID"), row]));
  const isoRows = isoReport?.sheets["ISO NSO split report"] ?? [];
  const isoByDisplay = new Map(isoRows.map((row) => [value(row, "Grant ID"), row]));
  const rawSecurities = raw?.sheets.Securities ?? [];
  const securities: SecurityDraft[] = rawSecurities.map((row) => {
    const rawId = value(row, "Id");
    const displayId = value(row, "CertificateId", "Certificate ID", "Id");
    const detail = detailByDisplay.get(displayId);
    const subject = subjectByDisplay.get(displayId);
    const iso = isoByDisplay.get(displayId);
    const kindResult = securityKind(value(row, "EquityPlanType", "SecurityType", "Security Type"));
    const sheetPlan = kindResult.kind === "option" ? planByName.get(normalize(detail?.sheet ?? "")) : undefined;
    const explicitPlan = planIdByRaw.get(value(row, "EquityPlanId", "StockPlanId", "PlanId"));
    const plan = explicitPlan ? planBySource.get(explicitPlan) : sheetPlan;
    const explicitClass = classIdByRaw.get(value(row, "SecurityClassId", "StockClassId", "ShareClassId"));
    const rawOutstanding = decimal(row, "OutstandingAmount", "Outstanding", "Shares Outstanding");
    const detailedOutstanding = decimal(detail?.row, "Outstanding", "Shares Outstanding");
    if (rawOutstanding !== null && detailedOutstanding !== null && !decimalsEqual(rawOutstanding, detailedOutstanding)) adapterProblems.push(problem("REPORT_SECURITY_MISMATCH", `${displayId} has ${rawOutstanding} outstanding in Raw Cap Table but ${detailedOutstanding} in Detailed Cap Table. Re-export both reports for the same date.`, detail!.row.source));
    return {
      sourceId: sourceId("security", rawId), displayId, kind: kindResult.kind, unsupportedType: kindResult.unsupported,
      stakeholderSourceId: stakeholderIdByRaw.get(value(row, "StakeholderId", "StakeholderCompanyId")) ?? sourceId("stakeholder", value(row, "StakeholderId", "StakeholderCompanyId")),
      stockClassSourceId: explicitClass ?? plan?.stockClassSourceId ?? null,
      stockPlanSourceId: explicitPlan ?? sheetPlan?.sourceId ?? null,
      optionType: optionType(first(row, subject, "OptionGrantType", "GrantType", "Grant Type", "OptionType", "Option Type")),
      issueDate: dateOrNull(first(row, detail?.row, subject, "IssueDate", "Issue Date", "GrantDate", "Grant Date")),
      issued: decimal(row, "IssuedAmount", "Granted", "Shares Issued"), outstanding: rawOutstanding,
      exercised: decimal(row, "ExercisedAmount") ?? (kindResult.kind === "stock" ? "0" : null), cancelled: decimal(row, "CancelledAmount"),
      repurchased: decimal(row, "RepurchasedAmount") ?? "0",
      repurchaseDate: dateOrNull(value(row, "RepurchaseDate", "Repurchase Date")),
      repurchaseConsideration: decimal(row, "AmountPaidForRepurchase", "Amount Paid For Repurchase"),
      transferred: decimal(row, "TransferredAmount") ?? "0", unvestedCancelled: decimal(row, "UnvestedCancelledAmount"),
      vested: decimal(row, "VestedAmount") ?? decimal(detail?.row, "Vested"),
      vestedOutstanding: decimal(row, "VestedOutstandingAmount"),
      price: decimal(row, "ExercisePrice", "PricePerShare") ?? decimal(detail?.row, "Exercise Price", "Price Per Share"),
      purchasePrice: kindResult.kind === "warrant" ? decimal(row, "PricePerShare", "PurchasePrice") : null,
      currency: value(row, "Currency") || importCurrency,
      expirationDate: dateOrNull(first(row, subject, "ExpirationDate", "Expiration Date")),
      exerciseDeadline: dateOrNull(first(row, subject, "ExerciseDeadline", "Exercise Deadline")),
      earlyExercise: booleanOrNull(first(row, subject, "HasEarlyExercise", "Early Exercise")),
      fmvAtGrant: decimal(iso, "FMV at Grant"), status: value(row, "Status"),
      safeType: null, valuationCap: null, uncapped: null, discountRate: null, convertedDate: null, source: row.source,
    };
  });

  for (const security of securities) {
    if (security.kind !== "stock" || security.repurchased === null || security.repurchased === "0" || security.repurchaseConsideration === null) continue;
    const resolved = repurchasePrice(security.repurchaseConsideration, security.repurchased, security.price);
    if (resolved && !resolved.fromLotPrice) assumptions.push(`${security.displayId}: the per-share repurchase price is the paid consideration divided by the repurchased shares, ${resolved.price}, rounded to at most 12 fractional digits; the exported total consideration remains exactly ${security.repurchaseConsideration} ${security.currency}.`);
  }

  for (const row of raw?.sheets.Convertibles ?? []) {
    const rawId = value(row, "Id");
    const displayId = value(row, "CertificateId", "Convertible ID", "Id");
    const detail = detailByDisplay.get(displayId)?.row;
    const instrument = value(row, "Type", "InstrumentType", "ConvertibleType");
    const isSafe = /^SAFE(?:_|\s|-|$)/i.test(instrument);
    const rawOutstanding = decimal(row, "PrincipalOutstanding");
    const detailedOutstanding = decimal(detail, "Principal Outstanding");
    if (rawOutstanding !== null && detailedOutstanding !== null && !decimalsEqual(rawOutstanding, detailedOutstanding)) adapterProblems.push(problem("REPORT_SECURITY_MISMATCH", `${displayId} has ${rawOutstanding} outstanding principal in Raw Cap Table but ${detailedOutstanding} in Detailed Cap Table. Re-export both reports for the same date.`, detail!.source));
    securities.push({
      sourceId: sourceId("security", rawId), displayId, kind: isSafe ? "safe" : "unsupported", unsupportedType: isSafe ? null : instrument || "blank convertible type",
      stakeholderSourceId: stakeholderIdByRaw.get(value(row, "StakeholderCompanyId", "StakeholderId")) ?? sourceId("stakeholder", value(row, "StakeholderCompanyId", "StakeholderId")),
      stockClassSourceId: null, stockPlanSourceId: null, optionType: null,
      issueDate: dateOrNull(first(row, detail, "IssueDate", "Issue Date", "Grant Date")), issued: decimal(row, "Principal", "PrincipalIssued"),
      outstanding: rawOutstanding, exercised: "0", cancelled: subtractDecimals(decimal(row, "Principal", "PrincipalIssued") ?? "", rawOutstanding ?? ""), repurchased: "0", repurchaseDate: null, repurchaseConsideration: null, transferred: "0",
      unvestedCancelled: null, vested: null, vestedOutstanding: null, price: null, purchasePrice: null, currency: value(row, "Currency") || importCurrency,
      expirationDate: null, exerciseDeadline: null, earlyExercise: null, fmvAtGrant: null, status: value(row, "Status"),
      safeType: safeType(value(row, "Type", "SAFEType", "SafeType")), valuationCap: decimal(row, "ValuationCap"), uncapped: booleanOrNull(value(row, "Uncapped")), discountRate: decimal(row, "Discount", "DiscountRate"),
      convertedDate: dateOrNull(value(row, "ConvertedDate", "ConvertedAt")), source: row.source,
    });
    if (isSafe && safeType(value(row, "Type", "SAFEType", "SafeType")) === null) assumptions.push(`${displayId}: Pulley identifies this instrument only as a SAFE, so conversion timing remains unspecified.`);
  }

  const securityByDisplay = new Map(securities.map((security) => [security.displayId, security]));
  const resultingStocks = group(securities.filter((security) => security.kind === "stock"), (security) => resultStockKey(security.issueDate ?? "", security.stakeholderSourceId, security.issued ?? "", security.stockPlanSourceId));
  const eventRows = vestingReport?.sheets["Vest Events"] ?? [];
  const eventsByDisplay = group(eventRows, (row) => value(row, "Security ID"));
  const milestoneRows = vestingReport?.sheets["Milestone Vesting Schedule"] ?? [];
  const milestonesByDisplay = group(milestoneRows, (row) => value(row, "Security ID"));
  const vesting: VestingDraft[] = subjectRows.map((row) => {
    const displayId = value(row, "Security ID");
    const security = securityByDisplay.get(displayId);
    const events: VestingEventDraft[] = [];
    const vestEventKeys = new Set<string>();
    for (const event of eventsByDisplay.get(displayId) ?? []) vestEventKeys.add(addEvent(events, event, displayId, "Vesting Date", "Quantity Vested", null));
    for (const event of milestonesByDisplay.get(displayId) ?? []) {
      const status = value(event, "Status");
      if (/pending/i.test(status) && !value(event, "Date")) continue;
      if (vestEventKeys.has(eventKey(event, "Date", "Quantity"))) continue;
      addEvent(events, event, displayId, "Date", "Quantity", status);
    }
    return { securitySourceId: security?.sourceId ?? sourceId("security", displayId), grantDate: dateOrNull(value(row, "Grant Date")), startDate: dateOrNull(value(row, "Vesting Start Date", "Grant Date")), granted: decimal(row, "Granted"), definitionType: "EXPLICIT", schedule: null, events, source: row.source };
  });

  const exerciseRows = exerciseReport?.sheets["Exercised Options"] ?? [];
  const exerciseKeyCounts = counts(exerciseRows.map((row) => {
    const option = securityByDisplay.get(value(row, "Option ID"));
    return resultStockKey(dateText(value(row, "Exercise Date")), option?.stakeholderSourceId ?? "", decimal(row, "Total Exercised") ?? "", option?.stockPlanSourceId ?? null);
  }));
  const exercises: ExerciseDraft[] = exerciseRows.map((row) => {
    const optionDisplay = value(row, "Option ID");
    const option = securityByDisplay.get(optionDisplay);
    const quantity = decimal(row, "Total Exercised");
    const date = dateText(value(row, "Exercise Date"));
    const explicitResult = value(row, "Resulting Certificate ID", "Resulting Security ID", "Certificate ID");
    const candidates = option && quantity !== null ? resultingStocks.get(resultStockKey(date, option.stakeholderSourceId, quantity, option.stockPlanSourceId)) ?? [] : [];
    const candidateKey = resultStockKey(date, option?.stakeholderSourceId ?? "", quantity ?? "", option?.stockPlanSourceId ?? null);
    const result = explicitResult ? securityByDisplay.get(explicitResult) : candidates.length === 1 && exerciseKeyCounts.get(candidateKey) === 1 ? candidates[0] : undefined;
    if (!explicitResult && result) assumptions.push(`${optionDisplay}: inferred that the ${date} exercise produced ${result.displayId} because holder, date, quantity, and plan match exactly.`);
    else if (!explicitResult && option && quantity !== null) assumptions.push(`${optionDisplay}: the ${date} exercise could not be linked to exactly one share certificate, so its current exercised quantity is imported as a disclosed opening balance and share lots are imported separately.`);
    return {
      sourceId: sourceId("exercise", `${optionDisplay}_${date}_${quantity ?? "missing"}_${row.source.row}`), optionSourceId: option?.sourceId ?? sourceId("security", optionDisplay), optionDisplayId: optionDisplay,
      date, quantity, isoQuantity: decimal(row, "ISOs Exercised", "ISO Exercised"), nsoQuantity: decimal(row, "NSOs Exercised", "NSO Exercised"),
      exercisePrice: decimal(row, "Exercise Price"), unvestedOnExercise: decimal(row, "Options Unvested on Exercise Date"),
      resultingSecuritySourceId: result?.sourceId ?? (explicitResult ? sourceId("security", explicitResult) : null), source: row.source,
    };
  });
  const exerciseTotals = new Map<string, string>();
  for (const exercise of exercises) if (exercise.quantity !== null) exerciseTotals.set(exercise.optionSourceId, addDecimals([exerciseTotals.get(exercise.optionSourceId) ?? "0", exercise.quantity]) ?? "0");

  const cancellations: CancellationDraft[] = [];
  for (const security of securities) {
    if (security.kind === "option" && security.exercised === null) {
      security.exercised = exerciseTotals.get(security.sourceId) ?? "0";
      assumptions.push(`${security.displayId}: exercised quantity was derived from the Exercised Options report because Raw Cap Table did not include ExercisedAmount.`);
    }
    if (security.cancelled === null && security.issued !== null && security.outstanding !== null && security.exercised !== null) {
      security.cancelled = subtractDecimals(security.issued, security.outstanding, security.exercised, security.repurchased ?? "0", security.transferred ?? "0");
      assumptions.push(`${security.displayId}: cancelled quantity was derived from issued minus outstanding, exercised, repurchased, and transferred because Raw Cap Table did not include CancelledAmount.`);
    }
    if (security.cancelled && security.cancelled !== "0") {
      const rawRow = rawSecurities.find((row) => sourceId("security", value(row, "Id")) === security.sourceId)
        ?? (raw?.sheets.Convertibles ?? []).find((row) => sourceId("security", value(row, "Id")) === security.sourceId);
      const detail = detailByDisplay.get(security.displayId)?.row;
      const cancellationDate = dateOrNull(first(rawRow, detail, "CancellationDate", "Cancellation Date", "ConvertedDate"));
      const unvested = security.unvestedCancelled !== null && security.unvestedCancelled === security.cancelled;
      cancellations.push({ sourceId: sourceId("cancellation", security.sourceId), securitySourceId: security.sourceId, date: cancellationDate, quantity: security.cancelled, reason: first(rawRow, detail, "CancellationReason", "Cancellation Reason", "Cancel Reason") || statusReason(security.status), vestingPortion: unvested ? "UNVESTED" : null, source: rawRow?.source ?? detail?.source ?? security.source });
      if (security.kind === "safe" && /convert/i.test(security.status)) assumptions.push(`${security.displayId}: Pulley reports this SAFE as converted; its remaining principal is represented by a dated convertible cancellation in the imported ledger.`);
    }
  }

  const isoNsoSplits: IsoNsoSplitDraft[] = isoRows.map((row) => {
    const display = value(row, "Grant ID");
    const security = securityByDisplay.get(display);
    const iso = sumMatching(row, /^ISOs?(?:\s*-|$)/i); const nso = sumMatching(row, /^NSOs?(?:\s*-|$)/i);
    return { securitySourceId: security?.sourceId ?? sourceId("security", display), grantDisplayId: display, total: decimal(row, "Number of Options"), iso, nso, source: row.source };
  });

  const explicitAsOfDate = companyRow ? dateOrNull(value(companyRow, "AsOfDate", "As Of Date", "Export Date", "Date")) : null;
  const nameDates = [...(raw?.file ?? "").matchAll(/(20\d{2}-\d{2}-\d{2})/g)].map((match) => match[1]!);
  const detailedSummary = detailEntries.find(({ row }) => value(row, "Fully Diluted") && value(row, "Issued and Outstanding"))?.row;
  const ownershipById = new Map<string, ParsedReportRow>();
  for (const { row } of detailEntries) { const id = value(row, "Stakeholder External ID"); if (id) ownershipById.set(id, row); }
  const totals = companyRow ? {
    company: { fullyDiluted: decimal(companyRow, "FullyDiluted"), issued: decimal(companyRow, "Issued"), outstanding: decimal(companyRow, "Outstanding"), source: companyRow.source },
    classes: shareClasses.map((item) => ({ sourceId: item.sourceId, name: item.name, outstanding: item.outstanding, authorized: item.authorized, source: item.source })),
    plans: plans.map((item) => ({ sourceId: item.sourceId, name: item.name, poolSize: item.poolSize, available: item.available, outstanding: item.outstanding, source: item.source })),
    holders: rawStakeholders.map((row) => ({ sourceId: stakeholderIdByRaw.get(value(row, "Id"))!, name: value(row, "Name"), fullyDiluted: decimal(row, "FullyDiluted"), outstanding: decimal(row, "OutstandingAmount"), source: row.source })),
    securities: securities.map((security) => ({ sourceId: security.sourceId, name: security.displayId, outstanding: security.outstanding, vested: security.vested, vestedOutstanding: security.vestedOutstanding, source: security.source })),
    detailed: {
      company: detailedSummary ? { fullyDiluted: decimal(detailedSummary, "Fully Diluted"), issuedAndOutstanding: decimal(detailedSummary, "Issued and Outstanding"), source: detailedSummary.source } : null,
      holders: rawStakeholders.flatMap((row) => {
        const detail = ownershipById.get(value(row, "Id"));
        return detail ? [{ sourceId: stakeholderIdByRaw.get(value(row, "Id"))!, name: value(row, "Name"), fullyDiluted: decimal(detail, "Fully Diluted"), issuedAndOutstanding: decimal(detail, "Issued and Outstanding"), source: detail.source }] : [];
      }),
    },
  } : null;

  return { sourceSystem: "pulley", companyName: companyRow ? value(companyRow, "Name") : null, asOfDate: explicitAsOfDate, suggestedAsOfDate: nameDates.sort().at(-1) ?? null, currency: importCurrency, stakeholders, shareClasses, equityPlans: plans, securities, vesting, exercises, cancellations, isoNsoSplits, totals, adapterProblems, assumptions };
}

function addEvent(output: VestingEventDraft[], row: ParsedReportRow, displayId: string, dateColumn: string, quantityColumn: string, status: string | null): string {
  const date = dateText(value(row, dateColumn)); const quantity = decimal(row, quantityColumn); const milestone = empty(value(row, "Milestone"));
  const key = `${date}|${quantity ?? ""}|${milestone ?? ""}`;
  output.push({ sourceId: sourceId("vesting_event", `${displayId}_${key}_${row.source.row}`), date, quantity, cancelled: truthy(value(row, "Forfeited/Canceled Prior to Vesting?")) || /cancel|forfeit|failed/i.test(status ?? ""), milestone, status, source: row.source });
  return key;
}
function eventKey(row: ParsedReportRow, dateColumn: string, quantityColumn: string): string { return `${dateText(value(row, dateColumn))}|${decimal(row, quantityColumn) ?? ""}|${empty(value(row, "Milestone")) ?? ""}` }
function one(reports: readonly ParsedPulleyReport[], kind: ParsedPulleyReport["kind"]): ParsedPulleyReport | undefined { return reports.find((report) => report.kind === kind) }
function value(row: ParsedReportRow | undefined, ...columns: string[]): string { if (!row) return ""; for (const column of columns) { const found = row.values[column]; if (found?.trim()) return found.trim(); } return "" }
function first(...args: Array<ParsedReportRow | string | undefined>): string {
  const columns = args.filter((item): item is string => typeof item === "string");
  const rows = args.filter((item): item is ParsedReportRow => !!item && typeof item === "object" && !Array.isArray(item) && "values" in item);
  for (const row of rows) { const found = value(row, ...columns); if (found) return found; } return "";
}
// TS cannot express a variadic row list followed by variadic columns, so common calls pass the column names directly.
function decimal(row: ParsedReportRow | undefined, ...columns: string[]): string | null {
  const raw = value(row, ...columns);
  return raw ? (engine.Dec.isCanonical(raw) ? raw : canonicalDecimal(raw)) : null;
}
function empty(text: string): string | null { return text === "" ? null : text }
function normalize(text: string): string { return text.toLowerCase().replace(/[^a-z0-9]/g, "") }
function counts(values: string[]): Map<string, number> { const result = new Map<string, number>(); for (const value of values) result.set(value, (result.get(value) ?? 0) + 1); return result }
function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) { const id = key(item); const bucket = result.get(id); if (bucket) bucket.push(item); else result.set(id, [item]); } return result }
function stakeholderKind(raw: string): "individual" | "institution" { return /organization|institution|company|fund|trust|entity/i.test(raw) ? "institution" : "individual" }
function relationship(raw: string): engine.Relationship { const key = raw.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, ""); return ({ founder: "founder", employee: "employee", former_employee: "ex_employee", ex_employee: "ex_employee", officer: "officer", board_member: "board_member", director: "board_member", advisor: "advisor", consultant: "consultant", investor: "investor" } as Record<string, engine.Relationship>)[key] ?? "other" }
function classType(raw: string): ShareClassDraft["classType"] { if (/^COMMON$/i.test(raw)) return "COMMON"; if (/^PREFERRED$/i.test(raw)) return "PREFERRED"; return null }
function securityKind(raw: string): { kind: SecurityDraft["kind"]; unsupported: string | null } { const key = raw.trim().toUpperCase(); if (key === "SHARES") return { kind: "stock", unsupported: null }; if (key === "OPTIONS") return { kind: "option", unsupported: null }; if (key === "WARRANTS") return { kind: "warrant", unsupported: null }; return { kind: "unsupported", unsupported: raw || "blank instrument type" } }
function optionType(raw: string): "ISO" | "NSO" | null { if (/^(NSO|NON.?QUALIFIED)$/i.test(raw)) return "NSO"; if (/^(ISO|INCENTIVE)$/i.test(raw)) return "ISO"; return null }
function safeType(raw: string): "PRE_MONEY" | "POST_MONEY" | null { if (/POST/i.test(raw)) return "POST_MONEY"; if (/PRE/i.test(raw)) return "PRE_MONEY"; return null }
function terminationType(raw: string): engine.TerminationType | null { const key = raw.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, ""); return ({ voluntary: "voluntary", involuntary: "involuntary", with_cause: "with_cause", death: "death", disability: "disability", retirement: "retirement" } as Record<string, engine.TerminationType>)[key] ?? null }
function booleanOrNull(raw: string): boolean | null { if (/^(true|yes|y|1)$/i.test(raw)) return true; if (/^(false|no|n|0)$/i.test(raw)) return false; return null }
function integerOrNull(raw: string): number | null { return /^\d+$/.test(raw.trim()) ? Number(raw) : null }
function truthy(raw: string): boolean { return booleanOrNull(raw) === true }
function dateOrNull(raw: string): string | null { return raw.trim() ? dateText(raw) : null }
function dateText(raw: string): string { const text = raw.trim(); if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) { const [m, d, y] = text.split("/"); return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`; } return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text }
function sourceId(entity: string, raw: string): string { const text = raw.trim(); const safe = text.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, ""); const suffix = !text ? "" : safe && safe.length <= 72 && safe === text ? safe : engine.sha256Hex(raw).slice(0, 20); return `${entity}_${suffix || "missing"}` }
function resultStockKey(date: string, stakeholder: string, quantity: string, plan: string | null): string { return `${date}\u0000${stakeholder}\u0000${quantity}\u0000${plan ?? ""}` }
function sumMatching(row: ParsedReportRow, pattern: RegExp): string | null { const values = Object.entries(row.values).filter(([key]) => pattern.test(key)).map(([, raw]) => canonicalDecimal(raw)).filter((item): item is string => item !== null); return values.length ? addDecimals(values) : null }
function statusReason(status: string): string { if (/repurch/i.test(status)) return "Repurchased in Pulley"; if (/transfer/i.test(status)) return "Transferred in Pulley"; if (/expir/i.test(status)) return "Expired in Pulley"; if (/convert/i.test(status)) return "Converted in Pulley"; return "Cancelled in Pulley" }
function problem(code: string, message: string, source: ParsedReportRow["source"]): ImportProblem { return { severity: "error", code, message, source } }
