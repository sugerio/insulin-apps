import { describe, expect, it } from "vitest";
import { api } from "../../../src/app/shared/index.ts";

const file = (name: string, size = 1) => new File([new Uint8Array(size)], name);
const profile = { timezone: "UTC", jurisdiction: "US-DE", fiscalYearEnd: "12-31" } as const;

describe("company import contract", () => {
  it("names each import source and removes internal entity namespaces from source ids", () => {
    expect(api.importSourceLabel("pulley")).toBe("Imported from Pulley");
    expect(api.importSourceLabel("template")).toBe("Imported from the spreadsheet");
    expect(api.importSourceLabel(null)).toBe("Imported");
    expect(api.importSourceName("pulley")).toBe("Pulley");
    expect(api.importSourceName("template")).toBe("the spreadsheet");
    expect(api.importSourceName(null)).toBe("the import");
    expect(api.displaySourceId("stakeholder_holder_1")).toBe("holder_1");
    expect(api.displaySourceId("security_OPT-1")).toBe("OPT-1");
    expect(api.displaySourceId("external_unchanged")).toBe("external_unchanged");
  });

  it("describes the four owner-only routes and their multipart/idempotency rules", () => {
    expect(api.routes.downloadImportTemplate).toMatchObject({
      method: "GET",
      path: "/api/import/template",
      access: ["admin_rw"],
    });
    expect(api.routes.previewImport).toMatchObject({
      method: "POST",
      path: "/api/import/preview",
      access: ["admin_rw"],
      idempotency: "none",
      body: { kind: "form", maxBytes: 10 * 1024 * 1024 },
    });
    expect(api.routes.commitImport).toMatchObject({
      method: "POST",
      path: "/api/import/runs/:runId/commit",
      access: ["admin_rw"],
      idempotency: "required",
      body: { kind: "form", maxBytes: 10 * 1024 * 1024 },
    });
    expect(api.routes.getImportRun).toMatchObject({
      method: "GET",
      path: "/api/import/runs/:runId",
      access: ["admin_rw"],
    });
  });

  it("checks source-specific file counts, file limits, request limits, and dates", () => {
    expect(api.importPreviewFormSchema.safeParse({ source: "template", files: [file("cap-table.xlsx")], ...profile }).success).toBe(true);
    expect(api.importPreviewFormSchema.safeParse({ source: "template", files: [file("one.xlsx"), file("two.xlsx")], ...profile }).success).toBe(false);
    expect(api.importPreviewFormSchema.safeParse({ source: "pulley", files: [], ...profile }).success).toBe(false);
    expect(api.importPreviewFormSchema.safeParse({ source: "pulley", files: [file("too-large.xlsx", api.IMPORT_LIMITS.fileBytes + 1)], ...profile }).success).toBe(false);
    expect(api.importPreviewFormSchema.safeParse({ source: "pulley", files: [file("one.xlsx", 4 * 1024 * 1024), file("two.xlsx", 4 * 1024 * 1024), file("three.xlsx", 4 * 1024 * 1024)], ...profile }).success).toBe(false);
    expect(api.importCommitFormSchema.safeParse({ files: [file("cap-table.xlsx")], asOfDate: "2026-02-30", ...profile }).success).toBe(false);
  });

  it("keeps the write plan and internal problem codes out of the preview response", () => {
    const result = api.importPreviewResponseSchema.safeParse({
      runId: crypto.randomUUID(),
      preview: {
        detectedFiles: [{ name: "cap-table.xlsx", kind: "template", format: "xlsx", sheets: ["Company"], warnings: [] }],
        currency: "USD",
        problems: [{ severity: "warning", message: "A date was inferred.", file: "cap-table.xlsx", sheet: "Company", row: 2, column: "B" }],
        openingBalances: [],
        assumptions: ["The default plan return rules apply."],
        totals: {
          uploaded: null,
          app: { fullyDiluted: "100", issuedAndOutstanding: "100", byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} },
          reconciliation: [],
        },
        canImport: true,
        suggestedAsOfDate: "2026-10-27",
        counts: { stakeholders: 1, shareClasses: 1, equityPlans: 0, securities: 1, commands: 2, transactions: 2 },
      },
    });
    expect(result.success).toBe(true);
    expect(api.importPreviewResponseSchema.safeParse({
      ...(result.success ? result.data : {}),
      preview: { ...(result.success ? result.data.preview : {}), plan: { commands: [] } },
    }).success).toBe(false);
    expect(api.importProblemSchema.safeParse({
      severity: "error",
      code: "INTERNAL_CODE",
      message: "Fix the spreadsheet.",
      file: null,
      sheet: null,
      row: null,
      column: null,
    }).success).toBe(false);
  });
});
