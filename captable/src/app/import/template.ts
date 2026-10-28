import { engine } from "#shared";
import { strToU8, zipSync } from "fflate";
import { addDecimals, canonicalDecimal, decimalError, isPositive, subtractDecimals } from "./decimal.ts";
import type { DetectedImportFile, ImportDraft, ImportProblem, SourceLocation, UploadedImportFile } from "./types.ts";
import { readXlsxBytes, type WorkbookSheet } from "./xlsx.ts";

const HEADERS = {
  Company: ["Company name", "As-of date", "Currency"],
  Stakeholders: ["Stakeholder ID", "Name", "Type", "Relationship", "Email", "Termination date", "Termination type"],
  "Share classes": ["Class ID", "Name", "Type", "Authorized shares", "Conversion ratio", "Original issue price"],
  "Equity plans": ["Plan ID", "Name", "Share class ID", "Pool size", "Effective date", "Exercise window after termination (days)"],
  Shares: ["Certificate ID", "Stakeholder ID", "Share class ID", "Plan ID", "Shares", "Issue date", "Price per share"],
  Options: ["Grant ID", "Stakeholder ID", "Plan ID", "Type", "Options granted", "Exercise price", "Grant date", "Expiration date", "Vesting start date", "Vesting months", "Cliff months", "Vest every (months)", "Early exercise", "FMV at grant", "Exercised", "Vested", "Vested outstanding", "Cancelled", "Cancellation date", "Cancellation reason"],
  Warrants: ["Warrant ID", "Stakeholder ID", "Share class ID", "Shares", "Exercise price", "Issue date", "Expiration date"],
  SAFEs: ["SAFE ID", "Stakeholder ID", "Principal", "Issue date", "Valuation cap", "Discount %", "Type"],
} as const;

export function generateCapTableTemplate(): Uint8Array {
  const instructions = [
    ["Cap Table spreadsheet template"],
    ["Enter records in the data sheets. Keep IDs unique and use those IDs to link rows. Dates use YYYY-MM-DD; quantities and prices use exact decimals without formulas."],
    ["Sheet", "Column", "What to enter", "Example"],
    ...instructionRows(),
  ];
  return workbook([
    { name: "Instructions", rows: instructions },
    ...Object.entries(HEADERS).map(([name, headers]) => ({ name, rows: [[...headers]] })),
  ]);
}

export function parseTemplateImport(file: UploadedImportFile, fallbackCurrency = "USD"): { draft: ImportDraft; detectedFiles: DetectedImportFile[]; problems: ImportProblem[]; fileSha256: Map<string, string> } {
  const problems: ImportProblem[] = [];
  let sheets: WorkbookSheet[];
  try { sheets = readXlsxBytes(file.bytes); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({ severity: "error", code: "FILE_UNREADABLE", message: `${file.name} could not be read: ${message}`, source: null });
    return { draft: emptyDraft(fallbackCurrency, problems), detectedFiles: [{ name: file.name, kind: null, format: "unknown", sheets: [], warnings: [] }], problems, fileSha256: new Map() };
  }
  const records = new Map<string, Row[]>();
  for (const sheet of sheets) for (const cell of sheet.errors ?? []) problems.push(problem("XLSX_CELL_ERROR", `${sheet.name} row ${cell.row}, column ${cell.column} contains the Excel error ${cell.value}. Replace it with a value or leave it blank.`, { file: file.name, sheet: sheet.name, row: cell.row, column: cell.column }));
  for (const [name, headers] of Object.entries(HEADERS)) {
    const sheet = sheets.find((candidate) => key(candidate.name) === key(name));
    if (!sheet) { problems.push(problem("TEMPLATE_SHEET_MISSING", `The template is missing the ${name} sheet.`, { file: file.name, sheet: name, row: 1 })); records.set(name, []); continue; }
    const actual = sheet.rows[0] ?? [];
    for (const header of headers) if (!actual.some((cell) => key(cell) === key(header))) problems.push(problem("TEMPLATE_COLUMN_MISSING", `${name} is missing the ${header} column.`, { file: file.name, sheet: name, row: 1, column: header }));
    records.set(name, sheet.rows.slice(1).map((row, index) => ({ values: Object.fromEntries(headers.map((header) => [header, row[actual.findIndex((cell) => key(cell) === key(header))] ?? ""])), source: { file: file.name, sheet: name, row: index + 2 } })).filter((row) => Object.values(row.values).some((value) => value.trim())));
  }
  validateTemplateRecords(records, problems);
  const company = records.get("Company")?.[0];
  if (!company) problems.push(problem("TEMPLATE_COMPANY_MISSING", "Enter one row on the Company sheet before previewing this template.", { file: file.name, sheet: "Company", row: 2, column: "Company name" }));
  if (company && ["Shares", "Options", "Warrants", "SAFEs"].every((sheet) => (records.get(sheet)?.length ?? 0) === 0)) problems.push({ severity: "warning", code: "TEMPLATE_NO_SECURITIES", message: "The Company row is present, but the template has no shares, options, warrants, or SAFEs.", source: { file: file.name, sheet: "Company", row: company.source.row, column: "Company name" } });
  const currency = value(company, "Currency") || fallbackCurrency;
  const stakeholders = (records.get("Stakeholders") ?? []).map((row) => ({
    sourceId: sid("stakeholder", value(row, "Stakeholder ID")), name: value(row, "Name"), email: nullable(value(row, "Email")),
    kind: /^Organization$/i.test(value(row, "Type")) ? "institution" as const : "individual" as const,
    relationship: relationship(value(row, "Relationship")), terminationDate: date(value(row, "Termination date")), terminationType: terminationType(value(row, "Termination type")), source: row.source,
  }));
  const classes = (records.get("Share classes") ?? []).map((row) => ({
    sourceId: sid("class", value(row, "Class ID")), name: value(row, "Name"), classType: /^Common$/i.test(value(row, "Type")) ? "COMMON" as const : /^Preferred$/i.test(value(row, "Type")) ? "PREFERRED" as const : null,
    authorized: number(row, "Authorized shares"), outstanding: "0", conversionRatio: number(row, "Conversion ratio") ?? (/^Preferred$/i.test(value(row, "Type")) ? "1" : null), originalIssuePrice: number(row, "Original issue price"), currency, source: row.source,
  }));
  const classIds = new Map((records.get("Share classes") ?? []).map((row) => [value(row, "Class ID"), sid("class", value(row, "Class ID"))]));
  const plans = (records.get("Equity plans") ?? []).map((row) => ({ sourceId: sid("plan", value(row, "Plan ID")), name: value(row, "Name"), stockClassSourceId: classIds.get(value(row, "Share class ID")) ?? sid("class", value(row, "Share class ID")), poolSize: number(row, "Pool size"), available: null, outstanding: null, effectiveDate: date(value(row, "Effective date")), terminationWindowDays: optionalInteger(row, "Exercise window after termination (days)", problems) ?? 90, source: row.source }));
  const stakeholderIds = new Map((records.get("Stakeholders") ?? []).map((row) => [value(row, "Stakeholder ID"), sid("stakeholder", value(row, "Stakeholder ID"))]));
  const planIds = new Map((records.get("Equity plans") ?? []).map((row) => [value(row, "Plan ID"), sid("plan", value(row, "Plan ID"))]));
  const securities: ImportDraft["securities"] = [];
  const vesting: ImportDraft["vesting"] = [];
  const cancellations: ImportDraft["cancellations"] = [];
  for (const row of records.get("Shares") ?? []) securities.push({ sourceId: sid("security", value(row, "Certificate ID")), displayId: value(row, "Certificate ID"), kind: "stock", unsupportedType: null, stakeholderSourceId: stakeholderIds.get(value(row, "Stakeholder ID")) ?? sid("stakeholder", value(row, "Stakeholder ID")), stockClassSourceId: classIds.get(value(row, "Share class ID")) ?? sid("class", value(row, "Share class ID")), stockPlanSourceId: value(row, "Plan ID") ? planIds.get(value(row, "Plan ID")) ?? sid("plan", value(row, "Plan ID")) : null, optionType: null, issueDate: date(value(row, "Issue date")), issued: number(row, "Shares"), outstanding: number(row, "Shares"), exercised: "0", cancelled: "0", repurchased: "0", repurchaseDate: null, repurchaseConsideration: null, transferred: "0", unvestedCancelled: null, vested: null, vestedOutstanding: null, price: number(row, "Price per share"), purchasePrice: null, currency, expirationDate: null, exerciseDeadline: null, earlyExercise: null, fmvAtGrant: null, status: "OUTSTANDING", safeType: null, valuationCap: null, uncapped: null, discountRate: null, convertedDate: null, source: row.source });
  for (const row of records.get("Options") ?? []) {
    const sourceId = sid("security", value(row, "Grant ID")); const granted = number(row, "Options granted"); const exercised = number(row, "Exercised") ?? "0"; const cancelled = number(row, "Cancelled") ?? "0";
    const consumed = addDecimals([exercised, cancelled]);
    const overConsumed = granted !== null && consumed !== null && engine.Dec.parse(consumed).gt(engine.Dec.parse(granted));
    if (overConsumed) problems.push(problem("SECURITY_QUANTITY_EXCEEDED", `Grant ${value(row, "Grant ID")} has ${exercised} exercised and ${cancelled} cancelled, exceeding the ${granted} options granted.`, { ...row.source, column: "Exercised" }));
    const outstanding = granted ? overConsumed ? "0" : subtractDecimals(granted, exercised, cancelled) : null;
    const cancellationKind = value(row, "Cancellation reason");
    securities.push({ sourceId, displayId: value(row, "Grant ID"), kind: "option", unsupportedType: null, stakeholderSourceId: stakeholderIds.get(value(row, "Stakeholder ID")) ?? sid("stakeholder", value(row, "Stakeholder ID")), stockClassSourceId: plans.find((plan) => plan.sourceId === planIds.get(value(row, "Plan ID")))?.stockClassSourceId ?? null, stockPlanSourceId: planIds.get(value(row, "Plan ID")) ?? sid("plan", value(row, "Plan ID")), optionType: /^ISO$/i.test(value(row, "Type")) ? "ISO" : /^NSO$/i.test(value(row, "Type")) ? "NSO" : null, issueDate: date(value(row, "Grant date")), issued: granted, outstanding, exercised, cancelled, repurchased: "0", repurchaseDate: null, repurchaseConsideration: null, transferred: "0", unvestedCancelled: /^Unvested forfeiture$/i.test(cancellationKind) ? cancelled : null, vested: number(row, "Vested"), vestedOutstanding: number(row, "Vested outstanding"), price: number(row, "Exercise price"), purchasePrice: null, currency, expirationDate: date(value(row, "Expiration date")), exerciseDeadline: null, earlyExercise: yesNo(value(row, "Early exercise")), fmvAtGrant: number(row, "FMV at grant"), status: outstanding === "0" ? "CANCELLED" : "OUTSTANDING", safeType: null, valuationCap: null, uncapped: null, discountRate: null, convertedDate: null, source: row.source });
    const totalMonths = integer(row, "Vesting months", problems); const cliffMonths = integer(row, "Cliff months", problems); const everyMonths = integer(row, "Vest every (months)", problems);
    vesting.push({ securitySourceId: sourceId, grantDate: date(value(row, "Grant date")), startDate: date(value(row, "Vesting start date")), granted, definitionType: "SCHEDULE", schedule: totalMonths !== null && cliffMonths !== null && everyMonths !== null ? { totalMonths, cliffMonths, everyMonths } : null, events: [], source: row.source });
    if (cancelled !== "0") {
      const cancellationDate = date(value(row, "Cancellation date"));
      const reason = /^Expired$/i.test(cancellationKind) ? "Expired in cap table template" : /^Unvested forfeiture$/i.test(cancellationKind) ? "Unvested forfeiture in cap table template" : "Other cancellation in cap table template";
      cancellations.push({ sourceId: sid("cancellation", sourceId), securitySourceId: sourceId, date: cancellationDate, quantity: cancelled, reason, vestingPortion: /^Unvested forfeiture$/i.test(cancellationKind) ? "UNVESTED" : null, source: row.source });
      if (!cancellationDate) problems.push(problem("CANCELLATION_DATE_MISSING", `Options row ${row.source.row}, Cancellation date is required when Cancelled is greater than zero.`, { ...row.source, column: "Cancellation date" }));
      if (!cancellationKind) problems.push(problem("CANCELLATION_REASON_MISSING", `Options row ${row.source.row}, Cancellation reason is required when Cancelled is greater than zero.`, { ...row.source, column: "Cancellation reason" }));
    }
  }
  for (const row of records.get("Warrants") ?? []) { const id = value(row, "Warrant ID"); securities.push({ sourceId: sid("security", id), displayId: id, kind: "warrant", unsupportedType: null, stakeholderSourceId: stakeholderIds.get(value(row, "Stakeholder ID")) ?? sid("stakeholder", value(row, "Stakeholder ID")), stockClassSourceId: classIds.get(value(row, "Share class ID")) ?? sid("class", value(row, "Share class ID")), stockPlanSourceId: null, optionType: null, issueDate: date(value(row, "Issue date")), issued: number(row, "Shares"), outstanding: number(row, "Shares"), exercised: "0", cancelled: "0", repurchased: "0", repurchaseDate: null, repurchaseConsideration: null, transferred: "0", unvestedCancelled: null, vested: null, vestedOutstanding: null, price: number(row, "Exercise price"), purchasePrice: "0", currency, expirationDate: date(value(row, "Expiration date")), exerciseDeadline: null, earlyExercise: null, fmvAtGrant: null, status: "OUTSTANDING", safeType: null, valuationCap: null, uncapped: null, discountRate: null, convertedDate: null, source: row.source }); }
  for (const row of records.get("SAFEs") ?? []) { const id = value(row, "SAFE ID"); securities.push({ sourceId: sid("security", id), displayId: id, kind: "safe", unsupportedType: null, stakeholderSourceId: stakeholderIds.get(value(row, "Stakeholder ID")) ?? sid("stakeholder", value(row, "Stakeholder ID")), stockClassSourceId: null, stockPlanSourceId: null, optionType: null, issueDate: date(value(row, "Issue date")), issued: number(row, "Principal"), outstanding: number(row, "Principal"), exercised: "0", cancelled: "0", repurchased: "0", repurchaseDate: null, repurchaseConsideration: null, transferred: "0", unvestedCancelled: null, vested: null, vestedOutstanding: null, price: null, purchasePrice: null, currency, expirationDate: null, exerciseDeadline: null, earlyExercise: null, fmvAtGrant: null, status: "OUTSTANDING", safeType: /^Post-money$/i.test(value(row, "Type")) ? "POST_MONEY" : /^Pre-money$/i.test(value(row, "Type")) ? "PRE_MONEY" : null, valuationCap: number(row, "Valuation cap"), uncapped: null, discountRate: percentRate(value(row, "Discount %")), convertedDate: null, source: row.source }); }

  const assumptions = [
    ...(company && !value(company, "Currency") ? [`The template currency was blank, so ${fallbackCurrency} is used.`] : []),
    ...(records.get("Share classes") ?? []).filter((row) => /^Preferred$/i.test(value(row, "Type")) && !value(row, "Conversion ratio")).map((row) => `${value(row, "Class ID")}: Preferred conversion ratio was blank, so the template default of 1 is used.`),
    ...(records.get("Equity plans") ?? []).filter((row) => !value(row, "Exercise window after termination (days)")).map((row) => `${value(row, "Plan ID")}: the exercise window was blank, so the template's disclosed 90-day exercise window after termination is used for every termination type.`),
    ...(records.get("Equity plans") ?? []).map((row) => `${value(row, "Plan ID")}: return-to-pool rules use the engine defaults (RETURN for all five events).`),
    ...(records.get("Warrants") ?? []).map((row) => `${value(row, "Warrant ID")}: the template does not collect a separate warrant purchase price, so it is recorded as 0 and shown here as an import assumption.`),
  ];
  const draft: ImportDraft = { sourceSystem: "template", companyName: company ? value(company, "Company name") : null, asOfDate: company ? date(value(company, "As-of date")) : null, suggestedAsOfDate: null, currency, stakeholders, shareClasses: classes, equityPlans: plans, securities, vesting, exercises: [], cancellations, isoNsoSplits: [], totals: null, adapterProblems: problems, assumptions };
  return { draft, detectedFiles: [{ name: file.name, kind: problems.some((item) => item.code === "TEMPLATE_SHEET_MISSING") ? null : "template", format: "xlsx", sheets: sheets.map((sheet) => sheet.name), warnings: sheets.flatMap((sheet) => sheet.warnings) }], problems, fileSha256: new Map([[file.name, engine.sha256Hex(file.bytes)]]) };
}

interface Row { values: Record<string, string>; source: SourceLocation }
function validateTemplateRecords(records: ReadonlyMap<string, Row[]>, problems: ImportProblem[]): void {
  const required: Record<string, string[]> = {
    Company: ["Company name", "As-of date"],
    Stakeholders: ["Stakeholder ID", "Name", "Type", "Relationship"],
    "Share classes": ["Class ID", "Name", "Type", "Authorized shares"],
    "Equity plans": ["Plan ID", "Name", "Share class ID", "Pool size", "Effective date"],
    Shares: ["Certificate ID", "Stakeholder ID", "Share class ID", "Shares", "Issue date", "Price per share"],
    Options: ["Grant ID", "Stakeholder ID", "Plan ID", "Type", "Options granted", "Exercise price", "Grant date", "Expiration date", "Vesting start date", "Vesting months", "Cliff months", "Vest every (months)", "Early exercise", "Exercised"],
    Warrants: ["Warrant ID", "Stakeholder ID", "Share class ID", "Shares", "Exercise price", "Issue date", "Expiration date"],
    SAFEs: ["SAFE ID", "Stakeholder ID", "Principal", "Issue date", "Type"],
  };
  for (const [sheet, columns] of Object.entries(required)) for (const row of records.get(sheet) ?? []) for (const column of columns) {
    if (!value(row, column)) problems.push(problem("TEMPLATE_VALUE_MISSING", `${sheet} row ${row.source.row}, ${column} is required.`, { ...row.source, column }));
  }
  if ((records.get("Company")?.length ?? 0) > 1) {
    const row = records.get("Company")![1]!;
    problems.push(problem("TEMPLATE_COMPANY_MULTIPLE", `Company row ${row.source.row} is extra; enter exactly one company row.`, { ...row.source, column: "Company name" }));
  }

  const numeric: Array<[string, string, boolean, boolean]> = [
    ["Share classes", "Authorized shares", false, true], ["Share classes", "Conversion ratio", true, true], ["Share classes", "Original issue price", true, false],
    ["Equity plans", "Pool size", false, true], ["Equity plans", "Exercise window after termination (days)", true, false], ["Shares", "Shares", false, true], ["Shares", "Price per share", false, false],
    ["Options", "Options granted", false, true], ["Options", "Exercise price", false, false], ["Options", "FMV at grant", true, false], ["Options", "Exercised", false, false], ["Options", "Vested", true, false], ["Options", "Vested outstanding", true, false], ["Options", "Cancelled", true, false],
    ["Warrants", "Shares", false, true], ["Warrants", "Exercise price", false, false], ["SAFEs", "Principal", false, true], ["SAFEs", "Valuation cap", true, true], ["SAFEs", "Discount %", true, false],
  ];
  for (const [sheet, column, optional, positive] of numeric) for (const row of records.get(sheet) ?? []) {
    const raw = value(row, column);
    if (optional && !raw) continue;
    const issue = decimalError(raw);
    if (issue === "missing") continue;
    if (issue === "precision") problems.push(problem("TEMPLATE_NUMBER_PRECISION", `${sheet} row ${row.source.row}, ${column} has too many decimal places or digits.`, { ...row.source, column }));
    else if (issue === "invalid") problems.push(problem("TEMPLATE_NUMBER_INVALID", `${sheet} row ${row.source.row}, ${column} must be an exact decimal number.`, { ...row.source, column }));
    else {
      const parsed = canonicalDecimal(raw)!;
      if ((positive && !isPositive(parsed)) || (!positive && engine.Dec.parse(parsed).isNegative())) problems.push(problem("TEMPLATE_NUMBER_RANGE", `${sheet} row ${row.source.row}, ${column} must be ${positive ? "greater than zero" : "zero or greater"}.`, { ...row.source, column }));
    }
  }

  const dates: Array<[string, string, boolean]> = [
    ["Company", "As-of date", false], ["Stakeholders", "Termination date", true], ["Equity plans", "Effective date", false],
    ["Shares", "Issue date", false], ["Options", "Grant date", false], ["Options", "Expiration date", false], ["Options", "Vesting start date", false], ["Options", "Cancellation date", true],
    ["Warrants", "Issue date", false], ["Warrants", "Expiration date", false], ["SAFEs", "Issue date", false],
  ];
  for (const [sheet, column, optional] of dates) for (const row of records.get(sheet) ?? []) {
    const raw = value(row, column);
    if ((optional && !raw) || !raw) continue;
    const parsed = date(raw);
    if (!parsed || !engine.isIsoDate(parsed)) problems.push(problem("TEMPLATE_DATE_INVALID", `${sheet} row ${row.source.row}, ${column} must be a real date in YYYY-MM-DD format.`, { ...row.source, column }));
  }

  for (const row of records.get("Stakeholders") ?? []) {
    allowed(row, "Type", /^(Individual|Organization)$/i, "Individual or Organization", problems);
    allowed(row, "Relationship", /^(Founder|Employee|Investor|Advisor|Consultant|Board member|Other)$/i, "one of the relationships listed in Instructions", problems);
    allowed(row, "Termination type", /^(Voluntary|Involuntary|With cause|Death|Disability|Retirement)$/i, "Voluntary, Involuntary, With cause, Death, Disability, or Retirement", problems);
    if (value(row, "Termination date") && !value(row, "Termination type")) problems.push(problem("TERMINATION_TYPE_MISSING", `Stakeholders row ${row.source.row}, Termination type is required when Termination date is present.`, { ...row.source, column: "Termination type" }));
  }
  for (const row of records.get("Share classes") ?? []) allowed(row, "Type", /^(Common|Preferred)$/i, "Common or Preferred", problems);
  for (const row of records.get("Options") ?? []) {
    allowed(row, "Type", /^(ISO|NSO)$/i, "ISO or NSO", problems);
    allowed(row, "Early exercise", /^(Yes|No)$/i, "Yes or No", problems);
    allowed(row, "Cancellation reason", /^(Unvested forfeiture|Expired|Other)$/i, "Unvested forfeiture, Expired, or Other", problems);
    const every = Number(value(row, "Vest every (months)"));
    const total = Number(value(row, "Vesting months"));
    const cliff = Number(value(row, "Cliff months"));
    if (Number.isInteger(every) && ![1, 3, 12].includes(every)) problems.push(problem("TEMPLATE_VESTING_FREQUENCY_UNSUPPORTED", `Options row ${row.source.row}, Vest every (months) must be 1, 3, or 12.`, { ...row.source, column: "Vest every (months)" }));
    if (Number.isInteger(total) && (total <= 0 || total > 240)) problems.push(problem("TEMPLATE_VESTING_RANGE", `Options row ${row.source.row}, Vesting months must be from 1 through 240.`, { ...row.source, column: "Vesting months" }));
    if (Number.isInteger(cliff) && Number.isInteger(total) && cliff > total) problems.push(problem("TEMPLATE_VESTING_RANGE", `Options row ${row.source.row}, Cliff months cannot exceed Vesting months.`, { ...row.source, column: "Cliff months" }));
    if ([1, 3, 12].includes(every) && Number.isInteger(total) && total % every !== 0) problems.push(problem("TEMPLATE_VESTING_RANGE", `Options row ${row.source.row}, Vesting months must be a whole number of vesting periods.`, { ...row.source, column: "Vesting months" }));
    if ([1, 3, 12].includes(every) && Number.isInteger(cliff) && cliff % every !== 0) problems.push(problem("TEMPLATE_VESTING_RANGE", `Options row ${row.source.row}, Cliff months must be a whole number of vesting periods.`, { ...row.source, column: "Cliff months" }));
    if (engine.isIsoDate(value(row, "Grant date")) && engine.isIsoDate(value(row, "Expiration date")) && value(row, "Expiration date") < value(row, "Grant date")) problems.push(problem("TEMPLATE_DATE_ORDER", `Options row ${row.source.row}, Expiration date cannot be before Grant date.`, { ...row.source, column: "Expiration date" }));
  }
  for (const row of records.get("SAFEs") ?? []) allowed(row, "Type", /^(Post-money|Pre-money)$/i, "Post-money or Pre-money", problems);
  for (const row of records.get("Company") ?? []) if (value(row, "Currency") && !/^[A-Z]{3}$/.test(value(row, "Currency"))) problems.push(problem("TEMPLATE_VALUE_UNSUPPORTED", `Company row ${row.source.row}, Currency must be a three-letter code such as USD.`, { ...row.source, column: "Currency" }));

  for (const [sheet, column] of [["Stakeholders", "Stakeholder ID"], ["Share classes", "Class ID"], ["Equity plans", "Plan ID"], ["Shares", "Certificate ID"], ["Options", "Grant ID"], ["Warrants", "Warrant ID"], ["SAFEs", "SAFE ID"]] as const) {
    const seen = new Set<string>();
    for (const row of records.get(sheet) ?? []) { const id = value(row, column); if (id && seen.has(id)) problems.push(problem("TEMPLATE_ID_DUPLICATE", `${sheet} row ${row.source.row}, ${column} ${id} is duplicated.`, { ...row.source, column })); seen.add(id); }
  }
  const securityIds = new Map<string, SourceLocation>();
  for (const [sheet, column] of [["Shares", "Certificate ID"], ["Options", "Grant ID"], ["Warrants", "Warrant ID"], ["SAFEs", "SAFE ID"]] as const) for (const row of records.get(sheet) ?? []) {
    const id = value(row, column); const first = securityIds.get(id);
    if (id && first) problems.push(problem("TEMPLATE_ID_DUPLICATE", `${sheet} row ${row.source.row}, ${column} ${id} is already used by another security row.`, { ...row.source, column }));
    else if (id) securityIds.set(id, row.source);
  }
  const stakeholderIds = new Set((records.get("Stakeholders") ?? []).map((row) => value(row, "Stakeholder ID")));
  const classIds = new Set((records.get("Share classes") ?? []).map((row) => value(row, "Class ID")));
  const planIds = new Set((records.get("Equity plans") ?? []).map((row) => value(row, "Plan ID")));
  checkReferences(records.get("Equity plans") ?? [], "Share class ID", classIds, problems);
  for (const sheet of ["Shares", "Options", "Warrants", "SAFEs"]) checkReferences(records.get(sheet) ?? [], "Stakeholder ID", stakeholderIds, problems);
  checkReferences(records.get("Shares") ?? [], "Share class ID", classIds, problems);
  checkReferences(records.get("Shares") ?? [], "Plan ID", planIds, problems, true);
  checkReferences(records.get("Warrants") ?? [], "Share class ID", classIds, problems);
  checkReferences(records.get("Options") ?? [], "Plan ID", planIds, problems);
  const exercisedByPlan = sumBy(records.get("Options") ?? [], "Plan ID", "Exercised");
  const sharesByPlan = sumBy(records.get("Shares") ?? [], "Plan ID", "Shares");
  for (const [planId, exercised] of exercisedByPlan) {
    const shares = sharesByPlan.get(planId) ?? "0";
    if (!engine.Dec.parse(exercised).eq(engine.Dec.parse(shares))) {
      const row = (records.get("Options") ?? []).find((item) => value(item, "Plan ID") === planId)!;
      problems.push(problem("TEMPLATE_EXERCISE_SHARES_MISMATCH", `Plan ${planId} has ${exercised} exercised options but ${shares} shares linked to that plan. Add Plan ID to the resulting share rows so these totals match.`, { ...row.source, column: "Exercised" }));
    }
  }
}
function allowed(row: Row, column: string, pattern: RegExp, expectation: string, problems: ImportProblem[]): void { const raw = value(row, column); if (raw && !pattern.test(raw)) problems.push(problem("TEMPLATE_VALUE_UNSUPPORTED", `${row.source.sheet} row ${row.source.row}, ${column} must be ${expectation}.`, { ...row.source, column })); }
function checkReferences(rows: readonly Row[], column: string, ids: ReadonlySet<string>, problems: ImportProblem[], optional = false): void { for (const row of rows) { const id = value(row, column); if (optional && !id) continue; if (id && !ids.has(id)) problems.push(problem("TEMPLATE_REFERENCE_MISSING", `${row.source.sheet} row ${row.source.row}, ${column} ${id} does not match an ID in the referenced sheet.`, { ...row.source, column })); } }
function sumBy(rows: readonly Row[], keyColumn: string, amountColumn: string): Map<string, string> { const sums = new Map<string, string>(); for (const row of rows) { const key = value(row, keyColumn); const amount = number(row, amountColumn); if (!key || amount === null || amount === "0") continue; sums.set(key, engine.Dec.parse(sums.get(key) ?? "0").add(engine.Dec.parse(amount)).toCanonical()); } return sums }
function emptyDraft(currency: string, adapterProblems: ImportProblem[]): ImportDraft { return { sourceSystem: "template", companyName: null, asOfDate: null, suggestedAsOfDate: null, currency, stakeholders: [], shareClasses: [], equityPlans: [], securities: [], vesting: [], exercises: [], cancellations: [], isoNsoSplits: [], totals: null, adapterProblems, assumptions: [] } }
function value(row: Row | undefined, column: string): string { return row?.values[column]?.trim() ?? "" }
function number(row: Row, column: string): string | null { return canonicalDecimal(value(row, column)) }
function date(raw: string): string | null { return raw ? (/^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw) : null }
function nullable(raw: string): string | null { return raw || null }
function key(raw: string): string { return raw.toLowerCase().replace(/[^a-z0-9]/g, "") }
function sid(entity: string, raw: string): string { const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, ""); const suffix = safe && safe.length <= 72 && safe === raw ? safe : engine.sha256Hex(raw).slice(0, 20); return `${entity}_${suffix || "missing"}` }
function yesNo(raw: string): boolean | null { if (/^Yes$/i.test(raw)) return true; if (/^No$/i.test(raw)) return false; return null }
function relationship(raw: string): engine.Relationship { return ({ founder: "founder", employee: "employee", investor: "investor", advisor: "advisor", consultant: "consultant", "board member": "board_member", other: "other" } as Record<string, engine.Relationship>)[raw.toLowerCase()] ?? "other" }
function terminationType(raw: string): engine.TerminationType | null { return ({ voluntary: "voluntary", involuntary: "involuntary", "with cause": "with_cause", death: "death", disability: "disability", retirement: "retirement" } as Record<string, engine.TerminationType>)[raw.toLowerCase()] ?? null }
function integer(row: Row, column: string, problems: ImportProblem[]): number | null { const raw = value(row, column); if (!/^\d+$/.test(raw)) { problems.push(problem("TEMPLATE_INTEGER_INVALID", `Options row ${row.source.row}, ${column} must be a whole number.`, { ...row.source, column })); return null; } return Number(raw) }
function optionalInteger(row: Row, column: string, problems: ImportProblem[]): number | null { const raw = value(row, column); if (!raw) return null; if (!/^\d+$/.test(raw) || Number(raw) > 1200) { problems.push(problem("TEMPLATE_INTEGER_INVALID", `${row.source.sheet} row ${row.source.row}, ${column} must be a whole number from 0 through 1200.`, { ...row.source, column })); return null; } return Number(raw) }
function percentRate(raw: string): string | null { const value = canonicalDecimal(raw); if (value === null) return null; const negative = value.startsWith("-"); const digits = (negative ? value.slice(1) : value).replace(".", ""); const fraction = value.includes(".") ? value.length - value.indexOf(".") - 1 : 0; const padded = digits.padStart(fraction + 3, "0"); const point = padded.length - fraction - 2; const result = `${padded.slice(0, point)}.${padded.slice(point)}`.replace(/^0+(?=\d)/, "").replace(/\.?0+$/, "") || "0"; return negative && result !== "0" ? `-${result}` : result }
function problem(code: string, message: string, source: SourceLocation): ImportProblem { return { severity: "error", code, message, source } }

function instructionRows(): string[][] {
  const examples: Record<string, string[]> = { Company: ["Acme Robotics, Inc.", "2026-10-27", "USD"], Stakeholders: ["holder_1", "Jordan Park", "Individual", "Employee", "jordan@example.test", "2026-09-30", "Voluntary"], "Share classes": ["common", "Common Stock", "Common", "10000000", "", "0.001"], "Equity plans": ["plan_2024", "2024 Equity Plan", "common", "1000000", "2024-01-15", "90"], Shares: ["CS-1", "holder_1", "common", "", "100000", "2024-01-15", "0.001"], Options: ["OPT-1", "holder_1", "plan_2024", "ISO", "48000", "0.25", "2024-02-01", "2034-02-01", "2024-02-01", "48", "12", "1", "No", "0.25", "0", "", "", "0", "", ""], Warrants: ["WAR-1", "holder_1", "common", "10000", "1.25", "2024-03-01", "2031-03-01"], SAFEs: ["SAFE-1", "holder_1", "500000", "2024-04-01", "10000000", "20", "Post-money"] };
  return Object.entries(HEADERS).flatMap(([sheet, headers]) => headers.map((column, index) => [sheet, column, instruction(sheet, column), examples[sheet]![index] ?? ""]));
}

function instruction(sheet: string, column: string): string {
  const descriptions: Record<string, string> = {
    "Company.Company name": "The company's legal or operating name.", "Company.As-of date": "The date all balances in this workbook represent, in YYYY-MM-DD format.", "Company.Currency": "A three-letter currency code; leave blank to use USD.",
    "Stakeholders.Stakeholder ID": "A unique ID used by every security row for this holder.", "Stakeholders.Name": "The person's or organization's display name.", "Stakeholders.Type": "Individual or Organization.", "Stakeholders.Relationship": "Founder, Employee, Investor, Advisor, Consultant, Board member, or Other.", "Stakeholders.Email": "Optional contact email address.", "Stakeholders.Termination date": "Optional service termination date in YYYY-MM-DD format.", "Stakeholders.Termination type": "Required with a termination date: Voluntary, Involuntary, With cause, Death, Disability, or Retirement.",
    "Share classes.Class ID": "A unique ID used by plans, shares, and warrants.", "Share classes.Name": "The class name shown on the cap table.", "Share classes.Type": "Common or Preferred.", "Share classes.Authorized shares": "The current authorized share count.", "Share classes.Conversion ratio": "Preferred-to-common conversion ratio; blank Preferred ratios use 1.", "Share classes.Original issue price": "Optional original issue price per share.",
    "Equity plans.Plan ID": "A unique ID used by option grants.", "Equity plans.Name": "The equity plan's display name.", "Equity plans.Share class ID": "The Class ID delivered when an award is exercised.", "Equity plans.Pool size": "The plan's current reserved share pool.", "Equity plans.Effective date": "The plan's approval or effective date in YYYY-MM-DD format.", "Equity plans.Exercise window after termination (days)": "Whole days allowed to exercise after termination; blank uses the disclosed template default of 90 days.",
    "Shares.Certificate ID": "A unique certificate or lot number.", "Shares.Stakeholder ID": "The owner, matching Stakeholders.Stakeholder ID.", "Shares.Share class ID": "The issued class, matching Share classes.Class ID.", "Shares.Plan ID": "For shares from exercised options, the plan that issued the grant; otherwise blank.", "Shares.Shares": "The exact number of shares issued.", "Shares.Issue date": "The issuance date in YYYY-MM-DD format.", "Shares.Price per share": "The exact purchase price for each share.",
    "Options.Grant ID": "A unique option grant number.", "Options.Stakeholder ID": "The grantee, matching Stakeholders.Stakeholder ID.", "Options.Plan ID": "The issuing plan, matching Equity plans.Plan ID.", "Options.Type": "ISO or NSO; do not guess when unknown.", "Options.Options granted": "The total options originally granted.", "Options.Exercise price": "The exact exercise price per option.", "Options.Grant date": "The grant date in YYYY-MM-DD format.", "Options.Expiration date": "The contractual expiration date in YYYY-MM-DD format.", "Options.Vesting start date": "The first date used to calculate time-based vesting.", "Options.Vesting months": "Total vesting term as a whole number of months.", "Options.Cliff months": "Whole months before the first vest; use 0 for no cliff.", "Options.Vest every (months)": "Vesting frequency: 1 monthly, 3 quarterly, or 12 annually.", "Options.Early exercise": "Yes only if the agreement allows exercise before vesting; otherwise No.", "Options.FMV at grant": "Optional fair market value per share on the grant date.", "Options.Exercised": "Options already exercised as of the workbook date; use 0 when none.", "Options.Vested": "Optional vested quantity as of the workbook date; preview reconciles it to the schedule.", "Options.Vested outstanding": "Optional vested and unexercised quantity as of the workbook date; preview reconciles it.", "Options.Cancelled": "Optional cancelled option quantity; use 0 or blank when none.", "Options.Cancellation date": "Required YYYY-MM-DD date when Cancelled is greater than zero.", "Options.Cancellation reason": "Required with a cancellation: Unvested forfeiture, Expired, or Other. Expired consumes vested options first; Other lets the engine split the quantity from the schedule.",
    "Warrants.Warrant ID": "A unique warrant number.", "Warrants.Stakeholder ID": "The holder, matching Stakeholders.Stakeholder ID.", "Warrants.Share class ID": "The class purchasable on exercise.", "Warrants.Shares": "The exact number of shares covered.", "Warrants.Exercise price": "The exact exercise price per share.", "Warrants.Issue date": "The warrant issuance date in YYYY-MM-DD format.", "Warrants.Expiration date": "The warrant expiration date in YYYY-MM-DD format.",
    "SAFEs.SAFE ID": "A unique SAFE identifier.", "SAFEs.Stakeholder ID": "The investor, matching Stakeholders.Stakeholder ID.", "SAFEs.Principal": "The original invested principal.", "SAFEs.Issue date": "The SAFE issue date in YYYY-MM-DD format.", "SAFEs.Valuation cap": "Optional valuation cap amount.", "SAFEs.Discount %": "Optional discount as a percentage, such as 20 for 20%.", "SAFEs.Type": "Post-money or Pre-money.",
  };
  return descriptions[`${sheet}.${column}`] ?? `Enter ${column} for this ${sheet} row.`;
}

function workbook(sheets: Array<{ name: string; rows: string[][] }>): Uint8Array {
  const files: Record<string, Uint8Array> = { "[Content_Types].xml": xml(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`), "_rels/.rels": xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'), "xl/workbook.xml": xml(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`), "xl/_rels/workbook.xml.rels": xml(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`) };
  sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = xml(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => `<c r="${column(c + 1)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(cell)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`); });
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}
function column(index: number): string { let result = ""; for (let current = index; current > 0; current = Math.floor((current - 1) / 26)) result = String.fromCharCode(65 + ((current - 1) % 26)) + result; return result }
function escape(raw: string): string { return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;") }
function xml(raw: string): Uint8Array { return strToU8(raw) }
