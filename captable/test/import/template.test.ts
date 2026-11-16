import { describe, expect, it } from "vitest";
import { buildTemplateImportPreview, generateCapTableTemplate, parseTemplateImport, readXlsxBytes, replayPlan } from "../../src/app/import/index.ts";
import { buildWorkbook, table, type WorkbookCell } from "./support/workbook.ts";

describe("Cap Table spreadsheet template", () => {
  it("generates a text-built blank workbook that recognizes through the template adapter", () => {
    const bytes = generateCapTableTemplate();
    const parsed = parseTemplateImport({ name: "Cap Table spreadsheet template.xlsx", bytes });
    expect(parsed.detectedFiles[0]).toMatchObject({ kind: "template", format: "xlsx" });
    expect(parsed.detectedFiles[0]!.sheets).toEqual(["Instructions", "Company", "Stakeholders", "Share classes", "Equity plans", "Shares", "Options", "Warrants", "SAFEs"]);
    expect(parsed.problems).toEqual([expect.objectContaining({ code: "TEMPLATE_COMPANY_MISSING", source: expect.objectContaining({ sheet: "Company" }) })]);
    const instructions = readXlsxBytes(bytes).find((sheet) => sheet.name === "Instructions")!;
    expect(instructions.rows.length).toBeGreaterThan(50);
    expect(instructions.rows.slice(3).every((row) => row[2]?.length)).toBe(true);
  });

  it("imports a filled template with native schedule vesting and computed totals", () => {
    const preview = buildTemplateImportPreview(filledTemplate());
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    expect(preview.canImport).toBe(true); expect(preview.plan?.sourceSystem).toBe("template"); expect(preview.totals.uploaded).toBeNull();
    expect(preview.totals.app).toMatchObject({ fullyDiluted: "2010", issuedAndOutstanding: "1000" });
    const { metrics } = replayPlan(preview.plan!);
    expect(metrics.securities.find((item) => item.displayId === "OPT-1")?.vested.toCanonical()).toBe("50");
    expect(preview.draft.assumptions).toEqual(expect.arrayContaining([expect.stringContaining("purchase price"), expect.stringContaining("90-day exercise window"), expect.stringContaining("USD")]));
  });

  it("registers each regular schedule once as a template that every grant on it uses", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      const first = data.Options[0]!;
      data.Options.push({ ...first, "Grant ID": "OPT-2" }, { ...first, "Grant ID": "OPT-3", "Vest every (months)": "3", "Cliff months": "0" });
      data["Equity plans"][0]!["Pool size"] = { number: "1000" };
    }));
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    const terms = preview.plan!.referenceRows.filter((row) => row.entity === "vesting_terms");
    expect(terms.map((row) => ({ name: row.name, isTemplate: row.isTemplate }))).toEqual([
      { name: "48 months, annually, 12-month cliff", isTemplate: true },
      { name: "48 months, quarterly, no cliff", isTemplate: true },
    ]);
    const issuances = preview.plan!.commands.flatMap((command) => command.transactions).filter((tx) => tx.type === "TX_EQUITY_COMPENSATION_ISSUANCE");
    const used = Object.fromEntries(issuances.map((tx) => [tx.payload.custom_id, tx.payload.vesting_terms_id]));
    expect(used).toEqual({ "OPT-1": terms[0]!.id, "OPT-2": terms[0]!.id, "OPT-3": terms[1]!.id });
    // 11 whole quarters of 16 by the as-of date, with no cliff.
    expect(replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "OPT-3")?.vested.toCanonical()).toBe("68");
  });

  it("records a lot's vesting and its repurchase right, with or without a deadline", () => {
    const lot = (id: string, right: Record<string, WorkbookCell>) => ({
      "Certificate ID": id, "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "", Shares: { number: "480" }, "Issue date": { date: "2025-01-15" }, "Price per share": { number: "0.01" },
      "Vesting start date": { date: "2025-01-15" }, "Vesting months": "48", "Cliff months": "12", "Vest every (months)": "1", ...right,
    });
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Shares.push(
        lot("RS-1", { "Repurchase price per share": { number: "0.01" }, "No repurchase deadline": "Yes" }),
        lot("RS-2", { "Repurchase price per share": { number: "0.01" }, "Repurchase window (days)": "90", "No repurchase deadline": "No" }),
        lot("RS-3", {}),
      );
      data["Share classes"][0]!["Authorized shares"] = { number: "10000" };
    }, SHARE_COLUMNS));
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    const payload = (id: string) => preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_STOCK_ISSUANCE" && tx.payload.custom_id === id)!.payload;
    expect(payload("RS-1").x_repurchase_right).toEqual({ price_per_share: { amount: "0.01", currency: "USD" }, window: null, x_no_deadline: true });
    expect(payload("RS-2").x_repurchase_right).toEqual({ price_per_share: { amount: "0.01", currency: "USD" }, window: { period: 90, period_type: "DAYS" } });
    // A lot that vests with no repurchase terms takes its plan's default window, as before; a lot that doesn't vest has neither.
    expect(payload("RS-3").x_repurchase_right).toBeUndefined();
    expect(payload("CS-1").vesting_terms_id).toBeUndefined();
    const { state, metrics } = replayPlan(preview.plan!);
    expect(payload("RS-1").vesting_terms_id).toBe(payload("RS-3").vesting_terms_id);
    expect(metrics.securities.find((item) => item.displayId === "RS-1")?.vested.toCanonical()).toBe("210");
    const right = (id: string) => [...state.securities.values()].find((security) => security.identity.displayId === id)?.repurchaseRight;
    expect(right("RS-1")).toMatchObject({ window: null, noDeadline: true });
    expect(right("RS-2")).toMatchObject({ window: { period: 90, period_type: "DAYS" }, noDeadline: false });
  });

  it("reads No in No repurchase deadline on a lot that doesn't vest as no repurchase term", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Shares[0]!["No repurchase deadline"] = "No";
    }, SHARE_COLUMNS));
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    const issuance = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_STOCK_ISSUANCE" && tx.payload.custom_id === "CS-1")!;
    expect(issuance.payload.x_repurchase_right).toBeUndefined();
  });

  it("names the cell for a lot's incomplete vesting or repurchase terms it can't use", () => {
    const base = { "Certificate ID": "RS-1", "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "", Shares: { number: "480" }, "Issue date": { date: "2025-01-15" }, "Price per share": { number: "0.01" } };
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Shares.push(
        { ...base, "Certificate ID": "RS-1", "Vesting start date": { date: "2025-01-15" }, "Vesting months": "48" },
        { ...base, "Certificate ID": "RS-2", "Repurchase price per share": { number: "0.01" } },
        { ...base, "Certificate ID": "RS-3", "Vesting start date": { date: "2025-01-15" }, "Vesting months": "48", "Cliff months": "12", "Vest every (months)": "2", "Repurchase window (days)": "90", "No repurchase deadline": "Yes" },
        { ...base, "Certificate ID": "RS-4", "Vesting start date": { date: "2025-01-15" }, "Vesting months": "48", "Cliff months": "12", "Vest every (months)": "1", "No repurchase deadline": "Maybe" },
      );
    }, SHARE_COLUMNS));
    const at = (code: string) => preview.problems.filter((item) => item.code === code).map((item) => `${item.source?.row} ${item.source?.column}`);
    expect(at("TEMPLATE_VALUE_MISSING")).toEqual(["3 Cliff months", "3 Vest every (months)"]);
    expect(at("TEMPLATE_REPURCHASE_WITHOUT_VESTING")).toEqual(["4 Repurchase price per share"]);
    expect(at("TEMPLATE_REPURCHASE_CONFLICT")).toEqual(["5 Repurchase window (days)"]);
    expect(at("TEMPLATE_VESTING_FREQUENCY_UNSUPPORTED")).toEqual(["5 Vest every (months)"]);
    expect(at("TEMPLATE_VALUE_UNSUPPORTED")).toEqual(["6 No repurchase deadline"]);
    expect(preview.problems.find((item) => item.code === "TEMPLATE_REPURCHASE_WITHOUT_VESTING")?.message).toBe("Shares row 4, a repurchase right covers unvested shares: enter the lot's vesting columns too.");
    expect(preview.canImport).toBe(false);
  });

  it("refuses a whole number too long to be exact rather than import the lot without its vesting", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Shares.push({
        "Certificate ID": "RS-1", "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "", Shares: { number: "480" }, "Issue date": { date: "2025-01-15" }, "Price per share": { number: "0.01" },
        "Vesting start date": { date: "2025-01-15" }, "Vesting months": "48", "Cliff months": "12", "Vest every (months)": "9".repeat(400), "No repurchase deadline": "Yes",
      });
    }, SHARE_COLUMNS));
    expect(preview.problems.filter((item) => item.code === "TEMPLATE_INTEGER_INVALID").map((item) => `${item.source?.row} ${item.source?.column}`)).toEqual(["3 Vest every (months)"]);
    expect(preview.canImport).toBe(false);
  });

  it("names sheet, row, and column for bad template values and blocks missing references", () => {
    const bad = buildTemplateImportPreview(filledTemplate((data) => {
      data.Stakeholders[0]!.Relationship = "Customer";
      data.Options[0]!["Plan ID"] = "missing-plan";
      data.Options[0]!["Vesting months"] = "-";
    }));
    expect(bad.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEMPLATE_VALUE_UNSUPPORTED", source: expect.objectContaining({ sheet: "Stakeholders", row: 2, column: "Relationship" }) }),
      expect.objectContaining({ code: "TEMPLATE_INTEGER_INVALID", source: expect.objectContaining({ sheet: "Options", row: 2, column: "Vesting months" }) }),
      expect.objectContaining({ code: "PLAN_REFERENCE_MISSING" }),
    ]));
    expect(bad.canImport).toBe(false);
  });

  it("requires a cancellation date when the template has a cancelled option quantity", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => { data.Options[0]!.Cancelled = "10"; }));
    expect(preview.problems).toContainEqual(expect.objectContaining({ code: "CANCELLATION_DATE_MISSING", source: expect.objectContaining({ sheet: "Options", row: 2, column: "Cancellation date" }) }));
  });

  it("keeps a template cancellation as a dated transaction when current exercised options require an opening balance", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Options[0]!.Exercised = "10"; data.Options[0]!.Cancelled = "10"; data.Options[0]!["Cancellation date"] = { date: "2026-06-01" }; data.Options[0]!["Cancellation reason"] = "Unvested forfeiture";
      data.Shares.push({ "Certificate ID": "CS-EX", "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "plan_2024", Shares: { number: "10" }, "Issue date": { date: "2026-03-01" }, "Price per share": { number: "0.25" } });
    }));
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    const transactions = preview.plan!.commands.flatMap((command) => command.transactions);
    expect(transactions.find((tx) => tx.type === "TX_EQUITY_COMPENSATION_CANCELLATION")).toMatchObject({ effectiveDate: "2026-06-01", payload: { quantity: "10", x_vesting_portion: "UNVESTED" } });
    expect(replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "OPT-1")?.outstanding.toCanonical()).toBe("80");
  });

  it("preserves and reconciles vesting for exercised grants with and without cancellation", () => {
    for (const cancelled of [false, true]) {
      const preview = buildTemplateImportPreview(filledTemplate((data) => {
        Object.assign(data.Options[0]!, {
          "Options granted": { number: "4800" }, "Grant date": { date: "2024-03-01" }, "Expiration date": { date: "2034-03-01" },
          "Vesting start date": { date: "2024-01-15" }, "Vesting months": "48", "Cliff months": "12", "Vest every (months)": "1",
          Exercised: "100", Cancelled: cancelled ? "100" : "0", "Cancellation date": cancelled ? { date: "2026-01-15" } : "",
          "Cancellation reason": cancelled ? "Unvested forfeiture" : "", Vested: "3300", "Vested outstanding": "3200",
        });
        data.Shares.push({ "Certificate ID": "CS-EX", "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "plan_2024", Shares: { number: "100" }, "Issue date": { date: "2025-06-01" }, "Price per share": { number: "0.25" } });
        data["Equity plans"][0]!["Pool size"] = { number: "10000" };
      }));
      expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
      const metrics = replayPlan(preview.plan!).metrics;
      const grant = metrics.securities.find((item) => item.displayId === "OPT-1")!;
      expect({ vested: grant.vested.toCanonical(), vestedOutstanding: grant.vestedOutstanding.toCanonical() }).toEqual({ vested: "3300", vestedOutstanding: "3200" });
      expect(metrics.plans[0]).toMatchObject({ equityOutstanding: expect.objectContaining({}), available: expect.objectContaining({}) });
      expect({ equityOutstanding: metrics.plans[0]!.equityOutstanding.toCanonical(), available: metrics.plans[0]!.available.toCanonical() }).toEqual({ equityOutstanding: cancelled ? "4700" : "4800", available: cancelled ? "5300" : "5200" });
    }
  });

  it("blocks a stated vested figure that disagrees with the engine", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => { data.Options[0]!.Vested = "49"; data.Options[0]!["Vested outstanding"] = "49"; }));
    expect(preview.problems).toContainEqual(expect.objectContaining({ code: "TOTAL_MISMATCH", message: expect.stringContaining("vested") }));
    expect(preview.canImport).toBe(false);
  });

  it("ties exercise shares to their plan and rejects a missing plan link", () => {
    const linked = buildTemplateImportPreview(filledTemplate((data) => {
      data.Options[0]!.Exercised = "10";
      data.Shares.push({ "Certificate ID": "CS-EX", "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "plan_2024", Shares: "10", "Issue date": { date: "2026-03-01" }, "Price per share": "0.25" });
    }));
    expect(linked.problems.filter((item) => item.severity === "error")).toEqual([]);
    expect(replayPlan(linked.plan!).metrics.plans[0]!.equityOutstanding.toCanonical()).toBe("100");
    const missing = buildTemplateImportPreview(filledTemplate((data) => { data.Options[0]!.Exercised = "10"; }));
    expect(missing.problems).toContainEqual(expect.objectContaining({ code: "TEMPLATE_EXERCISE_SHARES_MISMATCH" }));
  });

  it("allows an expired vested cancellation and applies the disclosed default termination window", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Stakeholders[0]!["Termination date"] = { date: "2025-01-01" }; data.Stakeholders[0]!["Termination type"] = "Voluntary";
      Object.assign(data.Options[0]!, { "Grant date": { date: "2020-01-01" }, "Vesting start date": { date: "2020-01-01" }, "Expiration date": { date: "2030-01-01" }, "Options granted": "4800", Cancelled: "1000", "Cancellation date": { date: "2025-04-01" }, "Cancellation reason": "Expired" });
      data["Equity plans"][0]!["Effective date"] = { date: "2019-12-01" };
      data["Equity plans"][0]!["Pool size"] = "10000";
    }));
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    expect(preview.problems.map((item) => item.message).join(" ")).not.toContain("ledger consistency problem");
    const grant = replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "OPT-1")!;
    expect({ cancelled: grant.cancelled.toCanonical(), vestedOutstanding: grant.vestedOutstanding.toCanonical(), deadline: grant.contractualDeadline }).toEqual({ cancelled: "1000", vestedOutstanding: "3800", deadline: "2025-04-01" });
  });

  it("supports monthly, quarterly, and cliff-equals-term schedules on the cliff boundary", () => {
    for (const schedule of [
      { every: "1", cliff: "12", asOf: "2025-01-15", vested: "25" },
      { every: "3", cliff: "12", asOf: "2025-01-15", vested: "25" },
      { every: "12", cliff: "48", asOf: "2028-01-15", vested: "100" },
    ]) {
      const preview = buildTemplateImportPreview(filledTemplate((data) => {
        data.Options[0]!["Vest every (months)"] = schedule.every; data.Options[0]!["Cliff months"] = schedule.cliff; data.Company[0]!["As-of date"] = { date: schedule.asOf };
      }), { today: "2028-01-15" });
      expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
      expect(replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "OPT-1")!.vested.toCanonical()).toBe(schedule.vested);
    }
  });

  it("reports blank and company-only templates clearly", () => {
    const blank = buildTemplateImportPreview({ name: "blank.xlsx", bytes: generateCapTableTemplate() });
    expect(blank.problems).toContainEqual(expect.objectContaining({ code: "TEMPLATE_COMPANY_MISSING", source: expect.objectContaining({ sheet: "Company" }) }));
    const companyOnly = buildTemplateImportPreview(filledTemplate((data) => {
      data.Stakeholders = []; data["Share classes"] = []; data["Equity plans"] = []; data.Shares = []; data.Options = []; data.Warrants = []; data.SAFEs = [];
    }));
    expect(companyOnly.problems).toContainEqual(expect.objectContaining({ severity: "warning", code: "TEMPLATE_NO_SECURITIES" }));
  });

  it("uses user-facing IDs and quantity messages for cross-sheet duplicates and over-exercise", () => {
    const duplicate = buildTemplateImportPreview(filledTemplate((data) => { data.Shares[0]!["Certificate ID"] = "OPT-1"; }));
    expect(duplicate.problems).toContainEqual(expect.objectContaining({ code: "TEMPLATE_ID_DUPLICATE", message: expect.stringContaining("OPT-1") }));
    expect(duplicate.problems.map((item) => item.message).join(" ")).not.toContain("security_OPT-1");
    const over = buildTemplateImportPreview(filledTemplate((data) => { data.Options[0]!.Exercised = "101"; }));
    expect(over.problems).toContainEqual(expect.objectContaining({ code: "SECURITY_QUANTITY_EXCEEDED", message: expect.stringContaining("exercised") }));
    expect(over.problems.map((item) => item.message).join(" ")).not.toContain("missing required outstanding");
  });

  it("accepts Excel-typed dates and numeric IDs", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Stakeholders[0]!["Stakeholder ID"] = { number: "1" };
      data["Share classes"][0]!["Class ID"] = { number: "2" };
      data["Equity plans"][0]!["Plan ID"] = { number: "3" }; data["Equity plans"][0]!["Share class ID"] = { number: "2" };
      data.Shares[0]!["Stakeholder ID"] = { number: "1" }; data.Shares[0]!["Share class ID"] = { number: "2" };
      data.Options[0]!["Stakeholder ID"] = { number: "1" }; data.Options[0]!["Plan ID"] = { number: "3" };
      data.Warrants[0]!["Stakeholder ID"] = { number: "1" }; data.Warrants[0]!["Share class ID"] = { number: "2" };
      data.SAFEs[0]!["Stakeholder ID"] = { number: "1" };
    }));
    expect(preview.problems.filter((item) => item.severity === "error")).toEqual([]);
    expect(preview.canImport).toBe(true);
  });

  it("keeps original issue price and uses source-neutral template wording", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => { data["Share classes"].push({ "Class ID": "seed", Name: "Series Seed", Type: "Preferred", "Authorized shares": "5000", "Conversion ratio": "", "Original issue price": "1.5" }); }));
    expect(preview.plan!.referenceRows.find((row) => row.entity === "stock_class")).toHaveProperty("originalIssuePrice.amount", "0.01");
    expect(preview.plan!.referenceRows.find((row) => row.entity === "stock_class" && row.name === "Series Seed")).toHaveProperty("originalIssuePrice.amount", "1.5");
    expect(preview.draft.assumptions).toContainEqual(expect.stringContaining("Preferred conversion ratio was blank"));
    expect(preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT" && tx.sourceRef.includes("class_seed"))?.payload).toHaveProperty("new_ratio_conversion_mechanism.ratio.numerator", "1");
    expect(JSON.stringify(preview.plan)).not.toContain("Pulley");
  });

  it("reports duplicates, invalid dates, exact-number precision, unsupported values, and vesting frequency at their cells", () => {
    const preview = buildTemplateImportPreview(filledTemplate((data) => {
      data.Stakeholders.push({ ...data.Stakeholders[0]! });
      data.Shares[0]!["Issue date"] = "2026-02-30";
      data.Warrants[0]!.Shares = "0.1234567890123";
      data.SAFEs[0]!.Type = "KISS";
      data.Options[0]!["Vest every (months)"] = "2";
      data.Options[0]!["Early exercise"] = "Sometimes";
    }));
    expect(preview.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEMPLATE_ID_DUPLICATE", source: expect.objectContaining({ sheet: "Stakeholders", row: 3, column: "Stakeholder ID" }) }),
      expect.objectContaining({ code: "TEMPLATE_DATE_INVALID", source: expect.objectContaining({ sheet: "Shares", row: 2, column: "Issue date" }) }),
      expect.objectContaining({ code: "TEMPLATE_NUMBER_PRECISION", source: expect.objectContaining({ sheet: "Warrants", row: 2, column: "Shares" }) }),
      expect.objectContaining({ code: "TEMPLATE_VALUE_UNSUPPORTED", source: expect.objectContaining({ sheet: "SAFEs", row: 2, column: "Type" }) }),
      expect.objectContaining({ code: "TEMPLATE_VESTING_FREQUENCY_UNSUPPORTED", source: expect.objectContaining({ sheet: "Options", row: 2, column: "Vest every (months)" }) }),
      expect.objectContaining({ code: "TEMPLATE_VALUE_UNSUPPORTED", source: expect.objectContaining({ sheet: "Options", row: 2, column: "Early exercise" }) }),
    ]));
  });
});

interface Data {
  Company: Array<Record<string, WorkbookCell>>;
  Stakeholders: Array<Record<string, WorkbookCell>>;
  "Share classes": Array<Record<string, WorkbookCell>>;
  "Equity plans": Array<Record<string, WorkbookCell>>;
  Shares: Array<Record<string, WorkbookCell>>;
  Options: Array<Record<string, WorkbookCell>>;
  Warrants: Array<Record<string, WorkbookCell>>;
  SAFEs: Array<Record<string, WorkbookCell>>;
}
/** The Shares sheet with a lot's vesting and repurchase-right columns, added after the template first shipped. */
const SHARE_COLUMNS = ["Certificate ID", "Stakeholder ID", "Share class ID", "Plan ID", "Shares", "Issue date", "Price per share", "Vesting start date", "Vesting months", "Cliff months", "Vest every (months)", "Repurchase price per share", "Repurchase window (days)", "No repurchase deadline"];
function filledTemplate(change?: (data: Data) => void, shareColumns?: string[]) {
  const data: Data = {
    Company: [{ "Company name": "Acme Robotics, Inc.", "As-of date": { date: "2026-10-27" }, Currency: "" }],
    Stakeholders: [{ "Stakeholder ID": "holder_1", Name: "Jordan Park", Type: "Individual", Relationship: "Employee", Email: "jordan@example.test", "Termination date": "", "Termination type": "" }],
    "Share classes": [{ "Class ID": "common", Name: "Common Stock", Type: "Common", "Authorized shares": { number: "10000" }, "Conversion ratio": "", "Original issue price": { number: "0.01" } }],
    "Equity plans": [{ "Plan ID": "plan_2024", Name: "2024 Equity Plan", "Share class ID": "common", "Pool size": { number: "1000" }, "Effective date": { date: "2024-01-01" }, "Exercise window after termination (days)": "" }],
    Shares: [{ "Certificate ID": "CS-1", "Stakeholder ID": "holder_1", "Share class ID": "common", "Plan ID": "", Shares: { number: "1000" }, "Issue date": { date: "2024-01-02" }, "Price per share": { number: "0.01" } }],
    Options: [{ "Grant ID": "OPT-1", "Stakeholder ID": "holder_1", "Plan ID": "plan_2024", Type: "ISO", "Options granted": { number: "100" }, "Exercise price": { number: "0.25" }, "Grant date": { date: "2024-01-15" }, "Expiration date": { date: "2034-01-15" }, "Vesting start date": { date: "2024-01-15" }, "Vesting months": "48", "Cliff months": "12", "Vest every (months)": "12", "Early exercise": "No", "FMV at grant": { number: "0.25" }, Exercised: "0", Vested: "", "Vested outstanding": "", Cancelled: "0", "Cancellation date": "", "Cancellation reason": "" }],
    Warrants: [{ "Warrant ID": "WAR-1", "Stakeholder ID": "holder_1", "Share class ID": "common", Shares: { number: "10" }, "Exercise price": { number: "1.25" }, "Issue date": { date: "2024-03-01" }, "Expiration date": { date: "2031-03-01" } }],
    SAFEs: [{ "SAFE ID": "SAFE-1", "Stakeholder ID": "holder_1", Principal: { number: "500000" }, "Issue date": { date: "2024-04-01" }, "Valuation cap": { number: "10000000" }, "Discount %": { number: "20" }, Type: "Post-money" }],
  };
  change?.(data);
  const headers: Record<string, string[]> = {
    Company: ["Company name", "As-of date", "Currency"], Stakeholders: ["Stakeholder ID", "Name", "Type", "Relationship", "Email", "Termination date", "Termination type"],
    "Share classes": ["Class ID", "Name", "Type", "Authorized shares", "Conversion ratio", "Original issue price"], "Equity plans": ["Plan ID", "Name", "Share class ID", "Pool size", "Effective date", "Exercise window after termination (days)"],
    Shares: shareColumns ?? ["Certificate ID", "Stakeholder ID", "Share class ID", "Plan ID", "Shares", "Issue date", "Price per share"], Options: ["Grant ID", "Stakeholder ID", "Plan ID", "Type", "Options granted", "Exercise price", "Grant date", "Expiration date", "Vesting start date", "Vesting months", "Cliff months", "Vest every (months)", "Early exercise", "FMV at grant", "Exercised", "Vested", "Vested outstanding", "Cancelled", "Cancellation date", "Cancellation reason"],
    Warrants: ["Warrant ID", "Stakeholder ID", "Share class ID", "Shares", "Exercise price", "Issue date", "Expiration date"], SAFEs: ["SAFE ID", "Stakeholder ID", "Principal", "Issue date", "Valuation cap", "Discount %", "Type"],
  };
  return { name: "Acme Cap Table.xlsx", bytes: buildWorkbook([{ name: "Instructions", rows: [["Instructions"]] }, ...Object.entries(headers).map(([name, columns]) => ({ name, rows: table(columns, data[name as keyof Data] ?? []) }))]) };
}
