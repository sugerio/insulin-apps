import { engine } from "#shared";
import type {
  DetectedImportFile,
  ImportProblem,
  PulleyReportKind,
  SourceLocation,
  UploadedImportFile,
} from "./types.ts";
import { readXlsxBytes, type WorkbookSheet } from "./xlsx.ts";

export interface ParsedReportRow {
  values: Record<string, string>;
  source: SourceLocation;
}

export interface ParsedPulleyReport {
  kind: PulleyReportKind;
  file: string;
  sheets: Record<string, ParsedReportRow[]>;
  warnings: string[];
}

export interface ParsedReportBundle {
  reports: ParsedPulleyReport[];
  detectedFiles: DetectedImportFile[];
  problems: ImportProblem[];
  fileSha256: Map<string, string>;
}

interface SheetContract {
  names: string[];
  columns: string[];
}

const RAW_SHEETS: SheetContract[] = [
  { names: ["Company"], columns: ["Name", "FullyDiluted", "Issued", "Outstanding"] },
  { names: ["Securities"], columns: ["Id", "CertificateId", "EquityPlanType", "IssuedAmount", "UnvestedCancelledAmount"] },
  { names: ["Convertibles"], columns: ["Id", "CertificateId", "Principal", "PrincipalOutstanding", "Status"] },
  { names: ["StakeholderCompanies"], columns: ["Id", "Name", "Email", "Relationship", "FullyDiluted"] },
  { names: ["ShareClasses"], columns: ["Id", "Name", "AuthorizedNumberOfShares", "OutstandingAmount"] },
  { names: ["EquityPlan", "Equity Plans"], columns: ["Id", "Name", "AuthorizedAmount", "AvailableAmount", "OutstandingAmount"] },
];

const EXACT_REPORTS: Partial<Record<PulleyReportKind, SheetContract[]>> = {
  stakeholders: [{ names: ["Stakeholders"], columns: ["Name", "Email", "Type", "Relationship"] }],
  "vesting-details": [
    { names: ["Equity Subject to Vesting"], columns: ["Security ID", "Stakeholder", "Grant Date", "Granted", "Fully Diluted"] },
    { names: ["Vest Events"], columns: ["Security ID", "Stakeholder", "Vesting Date", "Quantity Vested", "Forfeited/Canceled Prior to Vesting?"] },
    { names: ["Milestone Vesting Schedule", "Milestones"], columns: ["Security ID", "Stakeholder", "Milestone", "Date", "Quantity", "Status"] },
  ],
  "exercised-options": [{ names: ["Exercised Options"], columns: ["Name", "Option ID", "Exercise Price", "Exercise Date", "Total Exercised"] }],
  "iso-nso-details": [{ names: ["ISO NSO split report", "ISO NSO Details", "ISO-NSO Details"], columns: ["Stakeholder", "Grant ID", "Number of Options", "FMV at Grant", "Grant Date"] }],
  "stakeholder-transactions": [{ names: ["Sheet1", "Stakeholder Transactions"], columns: ["Event", "Options", "Shares", "Fully Diluted Total"] }],
};

export const DETAILED_HEADERS: readonly string[][] = [
  ["Authorized", "Issued and Outstanding", "Available Shares", "Fully Diluted"],
  ["Stakeholder", "Issued and Outstanding", "Fully Diluted"],
  ["Certificate ID", "Stakeholder Name", "Issue Date", "Shares Issued", "Shares Outstanding"],
  ["Certificate ID", "Stakeholder Name", "Grant Date", "Granted", "Outstanding"],
  ["Warrant ID", "Stakeholder", "Outstanding", "Shares Issued", "Exercise Price"],
  ["Convertible ID", "Stakeholder", "Grant Date", "Principal Issued", "Principal Outstanding"],
  ["Stakeholder", "Voting Ownership"],
  ["Stakeholder Name", "Votes", "Voting Ownership Percentage"],
];

const REQUIRED_REPORTS: PulleyReportKind[] = [
  "raw-cap-table",
  "detailed-cap-table",
  "stakeholders",
  "vesting-details",
  "exercised-options",
  "iso-nso-details",
];

export function parseUploadedReports(files: readonly UploadedImportFile[]): ParsedReportBundle {
  const reports: ParsedPulleyReport[] = [];
  const detectedFiles: DetectedImportFile[] = [];
  const problems: ImportProblem[] = [];
  const fileSha256 = new Map<string, string>();
  const firstByKind = new Map<PulleyReportKind, string>();
  const firstByHash = new Map<string, string>();
  const fileNames = new Set<string>();

  for (const file of files) {
    if (fileNames.has(file.name)) {
      problems.push(problem("error", "FILE_NAME_DUPLICATE", `Two uploaded files are both named ${file.name}. Rename one so source locations remain unambiguous.`, null));
      continue;
    }
    fileNames.add(file.name);
    const sha256 = engine.sha256Hex(file.bytes);
    fileSha256.set(file.name, sha256);
    let workbook: WorkbookSheet[];
    let format: DetectedImportFile["format"];
    try {
      if (looksLikeCsv(file)) {
        workbook = [{ name: "CSV", rows: parseCsv(new TextDecoder().decode(file.bytes)), warnings: [] }];
        format = "csv";
      } else {
        workbook = readXlsxBytes(file.bytes);
        format = "xlsx";
      }
    } catch (error) {
      detectedFiles.push({ name: file.name, kind: null, format: "unknown", sheets: [], warnings: [] });
      problems.push(problem("error", "FILE_UNREADABLE", `${file.name} could not be read: ${messageOf(error)}`, null));
      continue;
    }
    for (const sheet of workbook) for (const cell of sheet.errors ?? []) problems.push(problem("error", "XLSX_CELL_ERROR", `${sheet.name} row ${cell.row}, column ${cell.column} contains the Excel error ${cell.value}. Replace it with a value or leave it blank.`, { file: file.name, sheet: sheet.name, row: cell.row, column: cell.column }));

    const matches = reportMatches(workbook, format === "csv");
    if (matches.length === 0) {
      detectedFiles.push({ name: file.name, kind: null, format, sheets: workbook.map((sheet) => sheet.name), warnings: [] });
      problems.push(problem(
        "error",
        "FILE_UNKNOWN",
        `${file.name} does not match any supported Pulley report. Export a standard report without renaming its columns.`,
        { file: file.name, sheet: workbook[0]?.name ?? "", row: 1 },
      ));
      continue;
    }
    if (matches.length > 1) {
      detectedFiles.push({ name: file.name, kind: null, format, sheets: workbook.map((sheet) => sheet.name), warnings: [] });
      problems.push(problem("error", "FILE_AMBIGUOUS", `${file.name} matches more than one Pulley report layout.`, { file: file.name, sheet: workbook[0]?.name ?? "", row: 1 }));
      continue;
    }

    const kind = matches[0]!;
    const duplicate = kind !== "stakeholder-transactions" ? firstByKind.get(kind) : firstByHash.get(sha256);
    if (duplicate) {
      detectedFiles.push({ name: file.name, kind, format, sheets: workbook.map((sheet) => sheet.name), warnings: [] });
      problems.push(problem("error", "FILE_DUPLICATE", `${file.name} and ${duplicate} are both ${reportLabel(kind)} reports. Keep only one.`, { file: file.name, sheet: workbook[0]?.name ?? "", row: 1 }));
      continue;
    }

    try {
      const report = parseReportWorkbook(file.name, workbook, kind, format === "csv");
      firstByKind.set(kind, file.name);
      firstByHash.set(sha256, file.name);
      reports.push(report);
      detectedFiles.push({ name: file.name, kind, format, sheets: Object.keys(report.sheets), warnings: report.warnings });
      problems.push(...report.warnings.map((warning) => precisionWarning(file.name, warning)));
    } catch (error) {
      detectedFiles.push({ name: file.name, kind, format, sheets: workbook.map((sheet) => sheet.name), warnings: [] });
      problems.push(problem("error", "REPORT_INVALID", `${file.name} looks like ${reportLabel(kind)}, but ${messageOf(error)}`, { file: file.name, sheet: workbook[0]?.name ?? "", row: 1 }));
    }
  }

  for (const kind of REQUIRED_REPORTS) {
    if (!reports.some((report) => report.kind === kind)) {
      problems.push(problem("error", "REPORT_MISSING", `Add Pulley's ${reportLabel(kind)} report.`, null));
    }
  }
  return { reports, detectedFiles, problems, fileSha256 };
}

export function parseReportWorkbook(
  file: string,
  workbook: WorkbookSheet[],
  kind: PulleyReportKind,
  csv = false,
): ParsedPulleyReport {
  if (kind === "raw-cap-table") return parseExact(file, kind, workbook, RAW_SHEETS, csv);
  if (kind === "detailed-cap-table") return parseDetailed(file, workbook);
  const contracts = EXACT_REPORTS[kind];
  if (!contracts) throw new Error(`the ${kind} layout is not supported.`);
  return parseExact(file, kind, workbook, contracts, csv);
}

function reportMatches(workbook: WorkbookSheet[], csv: boolean): PulleyReportKind[] {
  const matches: PulleyReportKind[] = [];
  if (!csv && contractsMatch(workbook, RAW_SHEETS)) matches.push("raw-cap-table");
  if (detailedMatches(workbook)) matches.push("detailed-cap-table");
  for (const kind of Object.keys(EXACT_REPORTS) as PulleyReportKind[]) {
    const contracts = EXACT_REPORTS[kind]!;
    if ((!csv || contracts.length === 1) && contractsMatch(workbook, contracts, csv)) matches.push(kind);
  }
  return matches;
}

function contractsMatch(workbook: WorkbookSheet[], contracts: SheetContract[], csv = false): boolean {
  if (csv) return contracts.length === 1 && findHeaderIndex(workbook[0]!, contracts[0]!.columns) >= 0;
  return contracts.every((contract) => {
    const sheet = workbook.find((candidate) => contract.names.some((name) => canonicalName(name) === canonicalName(candidate.name)));
    return sheet !== undefined && findHeaderIndex(sheet, contract.columns) >= 0;
  });
}

function detailedMatches(workbook: WorkbookSheet[]): boolean {
  const nonempty = workbook.filter((sheet) => sheet.rows.some((row) => row.some((cell) => cell.trim() !== "")));
  const matching = nonempty.filter((sheet) => DETAILED_HEADERS.some((headers) => findHeaderIndex(sheet, headers) >= 0));
  const hasSummary = matching.some((sheet) => findHeaderIndex(sheet, DETAILED_HEADERS[0]!) >= 0);
  return hasSummary && matching.length >= 2;
}

function parseExact(
  file: string,
  kind: PulleyReportKind,
  workbook: WorkbookSheet[],
  contracts: SheetContract[],
  csv: boolean,
): ParsedPulleyReport {
  const sheets: Record<string, ParsedReportRow[]> = {};
  const warnings: string[] = [];
  const used = new Set<WorkbookSheet>();
  for (const contract of contracts) {
    const sheet = csv
      ? workbook[0]
      : workbook.find((candidate) => contract.names.some((name) => canonicalName(name) === canonicalName(candidate.name)));
    if (!sheet) throw new Error(`it is missing the ${contract.names[0]} sheet.`);
    if (used.has(sheet)) throw new Error(`it contains the ${sheet.name} sheet more than once.`);
    used.add(sheet);
    const outputName = contract.names[0]!;
    sheets[outputName] = rowsToRecords(file, sheet, contract.columns, kind === "stakeholder-transactions");
    warnings.push(...sheet.warnings.map((warning) => `${sheet.name}: ${warning}`));
  }
  for (const sheet of workbook) {
    if (!used.has(sheet) && sheet.rows.some((row) => row.some((cell) => cell.trim() !== ""))) {
      if (kind === "raw-cap-table") warnings.push(`${sheet.name}: ignored an unrecognized extra sheet.`);
      else throw new Error(`it contains an unrecognized sheet named ${sheet.name}.`);
    }
  }
  return { kind, file, sheets, warnings };
}

function parseDetailed(file: string, workbook: WorkbookSheet[]): ParsedPulleyReport {
  const sheets: Record<string, ParsedReportRow[]> = {};
  const warnings: string[] = [];
  for (const sheet of workbook) {
    if (!sheet.rows.some((row) => row.some((cell) => cell.trim() !== ""))) {
      sheets[sheet.name] = [];
      continue;
    }
    const headers = DETAILED_HEADERS.find((candidate) => findHeaderIndex(sheet, candidate) >= 0);
    if (!headers) {
      warnings.push(`${sheet.name}: ignored because this Detailed Cap Table sheet type is not supported.`);
      sheets[sheet.name] = [];
      continue;
    }
    sheets[sheet.name] = rowsToRecords(file, sheet, headers);
    warnings.push(...sheet.warnings.map((warning) => `${sheet.name}: ${warning}`));
  }
  return { kind: "detailed-cap-table", file, sheets, warnings };
}

export function rowsToRecords(
  file: string,
  sheet: WorkbookSheet,
  requiredColumns: readonly string[],
  stakeholderTransactions = false,
): ParsedReportRow[] {
  const headerIndex = findHeaderIndex(sheet, requiredColumns);
  if (headerIndex < 0) throw new Error(`${sheet.name} has no header row containing ${requiredColumns.join(", ")}.`);
  const headers = (sheet.rows[headerIndex] ?? []).map((header) => {
    const required = requiredColumns.find((column) => canonicalName(column) === canonicalName(header));
    return required ?? header.trim();
  });
  const named = headers.filter(Boolean);
  if (new Set(named).size !== named.length) throw new Error(`${sheet.name} has duplicate column headers.`);
  for (const column of requiredColumns) if (!headers.includes(column)) throw new Error(`${sheet.name} is missing the ${column} column.`);
  if (stakeholderTransactions) {
    const first = headers.findIndex(Boolean);
    if (first >= 0 && headers[first] !== "Event") headers[first] = "Stakeholder";
  }
  const records: ParsedReportRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex]!;
    if (!row.some((cell) => cell.trim() !== "")) continue;
    const values: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      const value = row[index];
      if (header && value !== undefined && value !== "") values[header] = value;
    }
    records.push({ values, source: { file, sheet: sheet.name, row: rowIndex + 1 } });
  }
  return records;
}

function findHeaderIndex(sheet: WorkbookSheet, requiredColumns: readonly string[]): number {
  return sheet.rows.findIndex((row) => {
    const cells = row.map((cell) => canonicalName(cell));
    return requiredColumns.every((column) => cells.includes(canonicalName(column)));
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("The CSV file ends inside a quoted value.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function looksLikeCsv(file: UploadedImportFile): boolean {
  if (/\.csv$/i.test(file.name)) return true;
  const prefix = new TextDecoder().decode(file.bytes.slice(0, 256));
  return !prefix.startsWith("PK") && prefix.includes(",");
}

function canonicalName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function precisionWarning(file: string, warning: string): ImportProblem {
  const match = /^([^:]+):\s+([A-Z]+)(\d+)\s+(.+)$/.exec(warning);
  return problem("warning", "XLSX_PRECISION_WARNING", warning, match
    ? { file, sheet: match[1]!, row: Number(match[3]), column: match[2] }
    : { file, sheet: warning.split(":")[0] ?? "", row: 1 });
}

function reportLabel(kind: PulleyReportKind): string {
  return {
    "raw-cap-table": "Raw Cap Table",
    "detailed-cap-table": "Detailed Cap Table",
    stakeholders: "Stakeholders",
    "vesting-details": "Vesting Details",
    "exercised-options": "Exercised Options",
    "iso-nso-details": "ISO/NSO Details",
    "stakeholder-transactions": "Stakeholder Transactions",
  }[kind];
}

function problem(
  severity: ImportProblem["severity"],
  code: string,
  message: string,
  source: SourceLocation | null,
): ImportProblem {
  return { severity, code, message, source };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
