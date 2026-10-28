import "./zod-config.ts";
import { z } from "zod";
import {
  REPORT_FORMATS_BY_KEY,
  type ReportFormat,
  reportFormatSchema,
  type ReportKey,
  reportKeySchema,
} from "./enums.ts";
import {
  epochMsSchema,
  holdingsQueryShape,
  isoDateSchema,
  ledgerSeqSchema,
  queryBooleanSchema,
  sha256HexSchema,
} from "./primitives.ts";

// Reports and exports. Every run writes `export.<reportKey>` (parameters, format, row count)
// before the first byte and counts against the durable export limit, for format=json too. Admins share these exports
// with outside auditors (the export rule); there are no auditor logins.

/**
 * `GET …/reports/:reportKey?asOf=&asKnownAt=&from=&to=&format=&includePii=`. `format` defaults to the report's first
 * format; one it doesn't offer is 400. Console administrators have PII access; holder routes never expose reports.
 */
export const reportQuerySchema = z.object({
  ...holdingsQueryShape,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  format: reportFormatSchema.optional(),
  includePii: queryBooleanSchema.optional(),
});
export type ReportQuery = z.input<typeof reportQuerySchema>;

export function reportFormats(key: ReportKey): readonly ReportFormat[] {
  return REPORT_FORMATS_BY_KEY[key];
}

/** The format a report is produced in: the requested one if the report offers it, else null (a 400). */
export function resolveReportFormat(key: ReportKey, requested: ReportFormat | undefined): ReportFormat | null {
  const formats = reportFormats(key);
  if (requested === undefined) return formats[0] ?? null;
  return formats.includes(requested) ? requested : null;
}

/** Response content types. CSV is streamed; XLSX comes from the Worker's small OOXML writer. */
export const REPORT_CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
} as const satisfies Record<ReportFormat, string>;

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A report as JSON: the same sheets the XLSX has, as columns and rows. Decimals are canonical strings and
 * percentages are exact percentage values (`ratio × 100`, as `n/d`), so JSON and spreadsheet columns use one unit
 * without losing precision to the spreadsheet's six-place display rounding.
 */
export const reportJsonSchema = z.object({
  reportKey: reportKeySchema,
  generatedAt: epochMsSchema,
  asOf: isoDateSchema.nullable(),
  asKnownAt: ledgerSeqSchema.nullable(),
  ledgerSeq: ledgerSeqSchema,
  ledgerHeadHash: sha256HexSchema.nullable(),
  engineVersion: z.string().min(1),
  includePii: z.boolean(),
  sheets: z.array(z.object({ name: z.string().min(1).max(31), columns: z.array(z.string()), rows: z.array(z.array(cellSchema)) })).min(1),
});
export type ReportJson = z.infer<typeof reportJsonSchema>;
