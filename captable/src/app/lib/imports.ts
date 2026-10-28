import { api } from "#shared";

// The company import (first-run setup and Import for an empty company): which files the wizard takes before anything
// is sent, how a problem's place in the files is written, and the order the preview lists things in. The server checks
// everything again; these checks only spare an admin an upload the contract refuses anyway. Files stay in the page's
// memory (React state) from the moment they are chosen until the import is done: nothing is written to browser storage.

export type ImportSource = api.ImportSource;
type ReportKind = NonNullable<api.ImportDetectedFile["kind"]>;

/** What each source is called in the wizard's copy. */
export const SOURCE_TITLES: Record<ImportSource, string> = { pulley: "Pulley", template: "Cap Table spreadsheet" };

/** Pulley's standard reports, in the order they are exported; the importer reads all of them but the last, which adds detail. */
export const PULLEY_REPORTS: readonly { kind: ReportKind; label: string; optional?: true }[] = [
  { kind: "raw-cap-table", label: "Raw Cap Table" },
  { kind: "detailed-cap-table", label: "Detailed Cap Table" },
  { kind: "stakeholders", label: "Stakeholders" },
  { kind: "vesting-details", label: "Vesting Details" },
  { kind: "exercised-options", label: "Exercised Options" },
  { kind: "iso-nso-details", label: "ISO/NSO Details" },
  { kind: "stakeholder-transactions", label: "Stakeholder Transactions", optional: true },
];

const KIND_LABELS: Record<ReportKind, string> = {
  ...(Object.fromEntries(PULLEY_REPORTS.map((report) => [report.kind, report.label])) as Record<Exclude<ReportKind, "template">, string>),
  template: "Cap Table spreadsheet",
};

/** The report a file was recognized as ("Raw Cap Table"), or that it wasn't. */
export function fileKindLabel(kind: api.ImportDetectedFile["kind"]): string {
  return kind === null ? "Not recognized" : KIND_LABELS[kind];
}

const MIB = 1024 * 1024;
export const FILE_LIMIT_LABEL = `${api.IMPORT_LIMITS.fileBytes / MIB} MiB`;

/**
 * Room kept for the multipart encoding around the files. The server caps the whole encoded request at 10 MiB
 * (`requestBytes`), not the files' bytes, and the encoding adds a boundary and part headers to every field and file.
 * The largest form the wizard sends is 25 files whose names run to the contract's 255 characters (at most 3 bytes each
 * in UTF-8, or as an escape) plus the source and as-of date fields: about 1.5 KiB per part with a 70-character
 * boundary, under 40 KiB in all.
 */
export const MULTIPART_RESERVE = 64 * 1024;
/** What the chosen files may add up to, so the encoded request stays within the server's limit. */
export const FILES_TOTAL_BYTES = api.IMPORT_LIMITS.requestBytes - MULTIPART_RESERVE;
export const FILES_TOTAL_LABEL = `${(FILES_TOTAL_BYTES / MIB).toFixed(1)} MiB`;

/** The file types each source reads: Pulley's reports come as Excel or CSV, the spreadsheet only as Excel. */
export function acceptedExtensions(source: ImportSource): readonly string[] {
  return source === "pulley" ? [".xlsx", ".csv"] : [".xlsx"];
}

function totalBytes(files: readonly File[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

/** Why one chosen file can't be sent at all, or null. */
function fileRefusal(source: ImportSource, file: File): string | null {
  const name = file.name.toLowerCase();
  if (!acceptedExtensions(source).some((extension) => name.endsWith(extension))) {
    return source === "pulley" ? `${file.name}: choose the Excel (.xlsx) or CSV file Pulley exported.` : `${file.name}: choose the spreadsheet as an Excel (.xlsx) file.`;
  }
  if (file.name.length > 255) return `${file.name.slice(0, 40)}…: the file name is longer than 255 characters. Rename the file.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > api.IMPORT_LIMITS.fileBytes) return `${file.name} is larger than ${FILE_LIMIT_LABEL}.`;
  return null;
}

export interface FileChoice {
  files: File[];
  /** One sentence per file that was left out, naming it and why. */
  refused: string[];
}

/**
 * Adds files the admin chose or dropped. A file named like one already listed replaces it (a corrected export); the
 * spreadsheet is one file, so a new one replaces the old. What would break the contract's limits is left out, by name.
 */
export function addFiles(source: ImportSource, current: readonly File[], chosen: readonly File[]): FileChoice {
  const refused: string[] = [];
  if (source === "template" && chosen.length > 1) {
    return { files: [...current], refused: ["Choose one file: the Cap Table spreadsheet is a single workbook."] };
  }
  let files = source === "template" ? [] : [...current];
  for (const file of chosen) {
    const refusal = fileRefusal(source, file);
    if (refusal) {
      refused.push(refusal);
      continue;
    }
    const replaces = files.findIndex((existing) => existing.name === file.name);
    const others = files.filter((_, index) => index !== replaces);
    if (others.length >= api.IMPORT_LIMITS.files) {
      refused.push(`${file.name}: at most ${api.IMPORT_LIMITS.files} files can be checked at once.`);
      continue;
    }
    if (totalBytes(others) + file.size > FILES_TOTAL_BYTES) {
      refused.push(`${file.name}: the files would add up to more than ${FILES_TOTAL_LABEL}.`);
      continue;
    }
    // A corrected file takes the place of the one it replaces.
    files = replaces >= 0 ? files.map((existing, index) => (index === replaces ? file : existing)) : [...files, file];
  }
  return { files: source === "template" && files.length === 0 ? [...current] : files, refused };
}

/** Why the chosen files can't be checked yet, or null when they can. */
export function filesProblem(source: ImportSource, files: readonly File[]): string | null {
  if (files.length === 0) return source === "pulley" ? "Choose Pulley's exports first." : "Choose the filled-in spreadsheet first.";
  if (source === "template" && files.length !== 1) return "Choose one file: the Cap Table spreadsheet is a single workbook.";
  if (files.length > api.IMPORT_LIMITS.files) return `Choose at most ${api.IMPORT_LIMITS.files} files.`;
  if (totalBytes(files) > FILES_TOTAL_BYTES) return `The files add up to more than ${FILES_TOTAL_LABEL}.`;
  return files.map((file) => fileRefusal(source, file)).find((refusal) => refusal !== null) ?? null;
}

interface Place {
  file: string | null;
  sheet: string | null;
  row: number | null;
  column: string | null;
}

/** Where in the files something is: "Raw Cap Table.xlsx › Securities › row 14 › column IssuedAmount"; null for nowhere in particular. */
export function locationLabel(place: Place): string | null {
  const parts = [place.file, place.sheet, place.row === null ? null : `row ${place.row}`, place.column ? `column ${place.column}` : null];
  const present = parts.filter((part): part is string => part !== null && part !== "");
  return present.length ? present.join(" › ") : null;
}

const byText = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b, undefined, { numeric: true }));
// Excel column letters sort by length first (Z before AA); a column named by its header sorts as text.
const byColumn = (a: string | null, b: string | null) =>
  a !== null && b !== null && /^[A-Z]+$/.test(a) && /^[A-Z]+$/.test(b) ? a.length - b.length || a.localeCompare(b) : byText(a, b);

/** File order: what concerns the upload as a whole first, then by file, sheet, row and column, so fixes go top to bottom. */
export function byPlace(a: Place, b: Place): number {
  return byText(a.file, b.file) || byText(a.sheet, b.sheet) || (a.row ?? 0) - (b.row ?? 0) || byColumn(a.column, b.column);
}

// A file's warning names its place in the text: Pulley's reports as "Securities: C9 has 16 significant digits.", the
// spreadsheet with the cell only ("B14 has 17 significant digits.", its sheet isn't kept), others with a sheet alone.
const SHEET_AND_CELL = /^([^:]+):\s+([A-Z]{1,3})(\d+)\s/;
const CELL = /^([A-Z]{1,3})(\d+)\s/;
const SHEET = /^([^:]+):\s/;

function warningPlace(file: string, warning: string): Place {
  const both = SHEET_AND_CELL.exec(warning);
  if (both) return { file, sheet: both[1]!, row: Number(both[3]), column: both[2]! };
  const cell = CELL.exec(warning);
  if (cell) return { file, sheet: null, row: Number(cell[2]), column: cell[1]! };
  return { file, sheet: SHEET.exec(warning)?.[1] ?? null, row: null, column: null };
}

/**
 * The warnings a file carries that the problems don't already list, as warnings placed in that file. Pulley's report
 * warnings are in both; the spreadsheet's precision warnings (a number past Excel's 15 significant digits) are on the
 * file only, and would otherwise go unseen.
 */
export function fileWarnings(preview: Pick<api.ImportPreview, "detectedFiles" | "problems">): api.ImportProblem[] {
  const listed = new Set(preview.problems.filter((problem) => problem.severity === "warning").map((problem) => `${problem.file ?? ""}\u0000${problem.message}`));
  const seen = new Set<string>();
  return preview.detectedFiles.flatMap((file) => file.warnings.flatMap((warning) => {
    const key = `${file.name}\u0000${warning}`;
    if (listed.has(key) || listed.has(`\u0000${warning}`) || seen.has(key)) return [];
    seen.add(key);
    return [{ severity: "warning" as const, message: warning, ...warningPlace(file.name, warning) }];
  }));
}

/** Whether a warning is about a number Excel may have rounded. */
export function isPrecisionWarning(message: string): boolean {
  return /\bhas \d+ significant digits\.$/.test(message);
}

/** The preview's problems split by what they do to the import: errors block it, warnings don't. Each list in file order. */
export function splitProblems(problems: readonly api.ImportProblem[]): { errors: api.ImportProblem[]; warnings: api.ImportProblem[] } {
  const sorted = [...problems].sort(byPlace);
  return { errors: sorted.filter((problem) => problem.severity === "error"), warnings: sorted.filter((problem) => problem.severity === "warning") };
}

type Line = api.ImportTotals["reconciliation"][number];

export const SCOPE_TITLES: Record<Line["scope"], string> = {
  company: "Company",
  class: "Share classes",
  plan: "Equity plans",
  holder: "Holders",
  security: "Securities",
};

export interface LineGroup {
  scope: Line["scope"];
  title: string;
  lines: Line[];
  mismatches: number;
}

/** The side-by-side totals, grouped company → classes → plans → holders → securities; empty groups are left out. */
export function reconciliationGroups(lines: readonly Line[]): LineGroup[] {
  return (Object.keys(SCOPE_TITLES) as Line["scope"][]).flatMap((scope) => {
    const inScope = lines.filter((line) => line.scope === scope);
    return inScope.length ? [{ scope, title: SCOPE_TITLES[scope], lines: inScope, mismatches: inScope.filter((line) => !line.matches).length }] : [];
  });
}

/** "fully diluted shares" → "Fully diluted shares". */
export function sentenceCase(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** What an import adds, as label and count, in the order the preview and the result list them. */
export function countRows(counts: api.ImportCounts): [label: string, count: number][] {
  return [
    ["Stakeholders", counts.stakeholders],
    ["Share classes", counts.shareClasses],
    ["Equity plans", counts.equityPlans],
    ["Securities", counts.securities],
    ["Ledger transactions", counts.transactions],
  ];
}
