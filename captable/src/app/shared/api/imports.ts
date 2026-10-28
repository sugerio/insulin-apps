import "./zod-config.ts";
import { z } from "zod";
import { decimalSchema, epochMsSchema, isoDateSchema, monthDaySchema, sha256HexSchema, timezoneSchema, uuidSchema } from "./primitives.ts";

export const IMPORT_SOURCES = ["pulley", "template"] as const;
export const importSourceSchema = z.enum(IMPORT_SOURCES);
export type ImportSource = z.infer<typeof importSourceSchema>;

/** User-facing provenance for a committed company import; null covers companies created without an import. */
export function importSourceLabel(source: ImportSource | null | undefined): string {
  if (source === "pulley") return "Imported from Pulley";
  if (source === "template") return "Imported from the spreadsheet";
  return "Imported";
}

/** The source name used inside a longer sentence. */
export function importSourceName(source: ImportSource | null | undefined): string {
  if (source === "pulley") return "Pulley";
  if (source === "template") return "the spreadsheet";
  return "the import";
}

/** Source ids are namespaced internally so entities cannot collide; screens and exports show the original id. */
export function displaySourceId(sourceId: string): string {
  return sourceId.replace(/^(?:stakeholder|class|plan|security|exercise|cancellation|vesting_event)_/, "");
}

export const IMPORT_RUN_STATUSES = ["previewed", "committed", "failed"] as const;
export const importRunStatusSchema = z.enum(IMPORT_RUN_STATUSES);
export type ImportRunStatus = z.infer<typeof importRunStatusSchema>;

export const IMPORT_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  requestBytes: 10 * 1024 * 1024,
  files: 25,
} as const;

const importFileSchema = z
  .custom<File>((value) => typeof File !== "undefined" && value instanceof File, "Choose a file")
  .refine((file) => file.name.length > 0 && file.name.length <= 255, "File names must be 1–255 characters")
  .refine((file) => file.size <= IMPORT_LIMITS.fileBytes, "Each file must be 5 MiB or smaller");

const importCompanyProfileShape = {
  timezone: timezoneSchema,
  jurisdiction: z.string().min(2).max(6),
  fiscalYearEnd: monthDaySchema,
} as const;

function filesFitRequest(files: readonly File[]): boolean {
  return files.reduce((total, file) => total + file.size, 0) <= IMPORT_LIMITS.requestBytes;
}

/** Parsed fields from `POST /api/import/preview`'s multipart body. */
export const importPreviewFormSchema = z
  .strictObject({
    source: importSourceSchema,
    files: z.array(importFileSchema).min(1).max(IMPORT_LIMITS.files),
    asOfDate: isoDateSchema.optional(),
    ...importCompanyProfileShape,
  })
  .superRefine((form, ctx) => {
    if (form.source === "template" && form.files.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "Choose exactly one Cap Table spreadsheet" });
    }
    if (!filesFitRequest(form.files)) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "The uploaded files must total 10 MiB or less" });
    }
  });
export type ImportPreviewForm = z.infer<typeof importPreviewFormSchema>;

/** Parsed fields from `POST /api/import/runs/:runId/commit`'s multipart body. */
export const importCommitFormSchema = z
  .strictObject({
    files: z.array(importFileSchema).min(1).max(IMPORT_LIMITS.files),
    asOfDate: isoDateSchema,
    ...importCompanyProfileShape,
  })
  .refine((form) => filesFitRequest(form.files), {
    path: ["files"],
    message: "The uploaded files must total 10 MiB or less",
  });
export type ImportCommitForm = z.infer<typeof importCommitFormSchema>;

export const importDetectedFileSchema = z.strictObject({
  name: z.string().min(1).max(255),
  kind: z.enum([
    "raw-cap-table",
    "detailed-cap-table",
    "stakeholders",
    "vesting-details",
    "exercised-options",
    "iso-nso-details",
    "stakeholder-transactions",
    "template",
  ]).nullable(),
  format: z.enum(["xlsx", "csv", "unknown"]),
  sheets: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ImportDetectedFile = z.infer<typeof importDetectedFileSchema>;

const nullableLocationShape = {
  file: z.string().nullable(),
  sheet: z.string().nullable(),
  row: z.number().int().positive().nullable(),
  column: z.string().nullable(),
};

export const importProblemSchema = z.strictObject({
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  ...nullableLocationShape,
});
export type ImportProblem = z.infer<typeof importProblemSchema>;

export const importOpeningBalanceSchema = z.strictObject({
  displayId: z.string().min(1),
  date: isoDateSchema,
  reason: z.string().min(1),
  ...nullableLocationShape,
});
export type ImportOpeningBalance = z.infer<typeof importOpeningBalanceSchema>;

const nullableDecimal = decimalSchema.nullable();
const uploadedTotalsSchema = z.strictObject({
  company: z.strictObject({
    fullyDiluted: nullableDecimal,
    issued: nullableDecimal,
    outstanding: nullableDecimal,
  }).nullable(),
  classes: z.array(z.strictObject({
    sourceId: z.string(),
    name: z.string(),
    outstanding: nullableDecimal,
    authorized: nullableDecimal,
  })),
  plans: z.array(z.strictObject({
    sourceId: z.string(),
    name: z.string(),
    poolSize: nullableDecimal,
    available: nullableDecimal,
    outstanding: nullableDecimal,
  })),
  holders: z.array(z.strictObject({
    sourceId: z.string(),
    name: z.string(),
    fullyDiluted: nullableDecimal,
    outstanding: nullableDecimal,
  })),
  securities: z.array(z.strictObject({
    sourceId: z.string(),
    name: z.string(),
    outstanding: nullableDecimal,
    vested: nullableDecimal,
    vestedOutstanding: nullableDecimal,
  })),
  detailed: z.strictObject({
    company: z.strictObject({
      fullyDiluted: nullableDecimal,
      issuedAndOutstanding: nullableDecimal,
    }).nullable(),
    holders: z.array(z.strictObject({
      sourceId: z.string(),
      name: z.string(),
      fullyDiluted: nullableDecimal,
      issuedAndOutstanding: nullableDecimal,
    })),
  }).nullable(),
});

const appTotalsSchema = z.strictObject({
  fullyDiluted: nullableDecimal,
  issuedAndOutstanding: nullableDecimal,
  byClass: z.record(z.string(), decimalSchema),
  byPlan: z.record(z.string(), z.strictObject({ outstanding: decimalSchema, available: decimalSchema })),
  byHolder: z.record(z.string(), z.strictObject({ fullyDiluted: decimalSchema, outstanding: decimalSchema })),
  bySecurity: z.record(z.string(), z.strictObject({
    outstanding: decimalSchema,
    vested: decimalSchema,
    vestedOutstanding: decimalSchema,
  })),
});

export const importReconciliationLineSchema = z.strictObject({
  scope: z.enum(["company", "class", "plan", "holder", "security"]),
  sourceId: z.string().nullable(),
  name: z.string(),
  metric: z.string(),
  uploaded: decimalSchema,
  app: nullableDecimal,
  matches: z.boolean(),
  ...nullableLocationShape,
});

export const importTotalsSchema = z.strictObject({
  uploaded: uploadedTotalsSchema.nullable(),
  app: appTotalsSchema,
  reconciliation: z.array(importReconciliationLineSchema),
});
export type ImportTotals = z.infer<typeof importTotalsSchema>;

export const importCountsSchema = z.strictObject({
  stakeholders: z.number().int().nonnegative(),
  shareClasses: z.number().int().nonnegative(),
  equityPlans: z.number().int().nonnegative(),
  securities: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  transactions: z.number().int().nonnegative(),
});
export type ImportCounts = z.infer<typeof importCountsSchema>;

export const importPreviewSchema = z.strictObject({
  detectedFiles: z.array(importDetectedFileSchema),
  currency: z.string().regex(/^[A-Z]{3}$/),
  problems: z.array(importProblemSchema),
  openingBalances: z.array(importOpeningBalanceSchema),
  assumptions: z.array(z.string()),
  totals: importTotalsSchema,
  canImport: z.boolean(),
  suggestedAsOfDate: isoDateSchema.nullable(),
  counts: importCountsSchema,
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importPreviewResponseSchema = z.strictObject({
  runId: uuidSchema,
  preview: importPreviewSchema,
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

export const importCommitResponseSchema = z.strictObject({
  orgId: uuidSchema,
  counts: importCountsSchema,
});
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;

export const importRunSchema = z.strictObject({
  runId: uuidSchema,
  source: importSourceSchema,
  status: importRunStatusSchema,
  asOfDate: isoDateSchema.nullable(),
  fileHashes: z.array(sha256HexSchema),
  counts: importCountsSchema,
  orgId: uuidSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type ImportRun = z.infer<typeof importRunSchema>;
