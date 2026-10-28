import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { zipSync } from "fflate";
import { canonicalDecimal } from "../../src/app/import/decimal.ts";
import { exactDecimal, parseUploadedReports, readXlsxBytes, rowsToRecords } from "../../src/app/import/index.ts";
import { acmeExportFiles } from "./support/acme.ts";
import { buildWorkbook, table } from "./support/workbook.ts";

describe("Pulley XLSX and report parsing", () => {
  it("reads shared and inline strings, booleans, exact exponents, cell addresses, and 1904 dates", () => {
    const bytes = buildWorkbook([{
      name: "Synthe\ntic",
      rows: [
        [{ shared: "Certificate ID" }, "Notes", { shared: "Issue Date" }, "Price", "Flag", "Long"],
        ["CS_x002D_1", "", { date: "1904-01-02" }, { number: "1.0000000000001E-4" }, true, { number: "1234567890123456" }],
      ],
    }], { date1904: true });
    expect(readXlsxBytes(bytes)).toEqual([{
      name: "Synthe\ntic",
      rows: [
        ["Certificate ID", "Notes", "Issue Date", "Price", "Flag", "Long"],
        ["CS-1", "", "1904-01-02", "0.00010000000000001", "TRUE", "1234567890123456"],
      ],
      warnings: ["F2 has 16 significant digits."],
    }]);
  });

  it("finds a header below title rows and rejects duplicate columns", () => {
    const sheet = { name: "Synthetic", rows: [["Pulley report"], [], ["Id", "Amount"], ["1", "2.00"]], warnings: [] };
    expect(rowsToRecords("synthetic.xlsx", sheet, ["Id", "Amount"])).toEqual([{
      values: { Id: "1", Amount: "2.00" },
      source: { file: "synthetic.xlsx", sheet: "Synthetic", row: 4 },
    }]);
    expect(() => rowsToRecords("synthetic.xlsx", { ...sheet, rows: [["Id", "Id"]] }, ["Id"])).toThrow("duplicate column headers");
  });

  it("recognizes all seven report kinds from sheet names and headers", () => {
    const transaction = {
      name: "holder.xlsx",
      bytes: buildWorkbook([{ name: "Sheet1", rows: table(["Jordan Park", "Event", "Options", "Shares", "Fully Diluted Total"], [{ "Jordan Park": "Jordan Park", Event: "Exercise", Options: "-80", Shares: "100", "Fully Diluted Total": "180" }]) }]),
    };
    const bundle = parseUploadedReports([...acmeExportFiles(), transaction]);
    expect(bundle.reports.map((report) => report.kind)).toEqual([
      "raw-cap-table",
      "detailed-cap-table",
      "stakeholders",
      "vesting-details",
      "exercised-options",
      "iso-nso-details",
      "stakeholder-transactions",
    ]);
    expect(bundle.problems.filter((problem) => problem.severity === "error")).toEqual([]);
    expect(bundle.reports.at(-1)?.sheets.Sheet1?.[0]?.values.Stakeholder).toBe("Jordan Park");
  });

  it("accepts CSV for a single-sheet report", () => {
    const csv = new TextEncoder().encode('Name,Email,Type,Relationship\r\n"Jordan, Jr.",jordan@example.test,INDIVIDUAL,EMPLOYEE\r\n');
    const bundle = parseUploadedReports([{ name: "stakeholders.csv", bytes: csv }]);
    expect(bundle.detectedFiles[0]).toMatchObject({ kind: "stakeholders", format: "csv" });
    expect(bundle.reports[0]?.sheets.Stakeholders?.[0]?.values.Name).toBe("Jordan, Jr.");
  });

  it("reports unknown and duplicate files in plain language", () => {
    const files = acmeExportFiles();
    const bundle = parseUploadedReports([
      ...files,
      { ...files[2]!, name: "stakeholders-copy.xlsx" },
      { name: "notes.xlsx", bytes: buildWorkbook([{ name: "Notes", rows: [["Not a report"]] }]) },
    ]);
    expect(bundle.problems.map((problem) => problem.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("are both Stakeholders reports"),
      expect.stringContaining("does not match any supported Pulley report"),
    ]));
  });

  it("rejects malformed XLSX bytes", () => {
    expect(() => readXlsxBytes(new TextEncoder().encode("not a zip"))).toThrow("not a readable Excel workbook");
  });

  it("reads ISO date cells, reports error cells without making the workbook unreadable, the 1900 boundary and the real warning row", () => {
    expect(readXlsxBytes(buildWorkbook([{ name: "Dates", rows: [["Date"], [{ date: "1900-02-28" }], [{ date: "1900-03-01" }], [{ dateText: "2026-10-27T00:00:00Z" }], [{ number: "0.30000000000000004" }]] }]))[0]).toMatchObject({ rows: [["Date"], ["1900-02-28"], ["1900-03-01"], ["2026-10-27"], ["0.30000000000000004"]], warnings: ["A5 has 17 significant digits."] });
    expect(readXlsxBytes(buildWorkbook([{ name: "Errors", rows: [["Id", "Unused"], ["1", { error: "#VALUE!" }]] }]))).toEqual([{
      name: "Errors", rows: [["Id", "Unused"], ["1", ""]], warnings: [],
      errors: [{ cell: "B2", row: 2, column: "B", value: "#VALUE!" }],
    }]);
  });

  it("refuses an oversized decompressed entry", () => {
    const bytes = zipSync({ "xl/workbook.xml": new Uint8Array(64 * 1024 * 1024 + 1) }, { level: 9, mtime: new Date("1980-01-01T00:00:00Z") });
    expect(() => readXlsxBytes(bytes)).toThrow("larger than 64 MiB");
  }, 20_000);

  it("accepts header case/spacing variants and warns about extra Raw and unknown Detailed sheets", () => {
    const caseVariant = parseUploadedReports([{ name: "exercise.xlsx", bytes: buildWorkbook([{ name: "Exercised Options", rows: [["name", "Option Id", "Exercise  Price", "Exercise Date", "Total Exercised"]] }]) }]);
    expect(caseVariant.detectedFiles[0]?.kind).toBe("exercised-options");
    const files = acmeExportFiles();
    const raw = readXlsxBytes(files[0]!.bytes);
    files[0] = { name: files[0]!.name, bytes: buildWorkbook([...raw.map((sheet) => ({ name: sheet.name, rows: sheet.rows })), { name: "Valuations", rows: [["Id", "Date"], ["V-1", "2026-01-01"]] }]) };
    const withExtra = parseUploadedReports(files);
    expect(withExtra.problems).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining("Valuations") }));
    const detailed = readXlsxBytes(files[1]!.bytes);
    files[1] = { name: files[1]!.name, bytes: buildWorkbook([...detailed.map((sheet) => ({ name: sheet.name, rows: sheet.rows })), { name: "RSUs", rows: [["Unknown", "Columns"], ["x", "y"]] }]) };
    expect(parseUploadedReports(files).problems).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining("RSUs") }));
  });

  it("does not recognize a one-sheet workbook as Detailed merely because one header happens to match", () => {
    const bundle = parseUploadedReports([{ name: "not-detailed.xlsx", bytes: buildWorkbook([{ name: "Summary", rows: [["Authorized", "Issued and Outstanding", "Available Shares", "Fully Diluted"], ["1", "1", "0", "1"]] }]) }]);
    expect(bundle.detectedFiles[0]?.kind).toBeNull();
    expect(bundle.problems).toContainEqual(expect.objectContaining({ code: "FILE_UNKNOWN" }));
  });

  it("reports an Excel error cell at its sheet and row instead of calling the file unreadable", () => {
    const files = acmeExportFiles();
    const sheets = readXlsxBytes(files[0]!.bytes);
    const company = sheets.find((sheet) => sheet.name === "Company")!;
    company.rows[3]!.push(""); company.rows[2]!.push("Unused");
    const rebuilt = sheets.map((sheet) => ({ name: sheet.name, rows: sheet.name === "Company" ? company.rows.map((row, index) => (index === 3 ? [...row.slice(0, -1), { error: "#VALUE!" } as const] : row)) : sheet.rows }));
    files[0] = { ...files[0]!, bytes: buildWorkbook(rebuilt) };
    const bundle = parseUploadedReports(files);
    expect(bundle.problems).toContainEqual(expect.objectContaining({ code: "XLSX_CELL_ERROR", source: expect.objectContaining({ sheet: "Company", row: 4 }) }));
    expect(bundle.problems).not.toContainEqual(expect.objectContaining({ code: "FILE_UNREADABLE" }));
  });

  it("refuses duplicate file names even when their contents differ", () => {
    const files = acmeExportFiles(); files[1] = { ...files[1]!, name: files[0]!.name };
    expect(parseUploadedReports(files).problems).toContainEqual(expect.objectContaining({ code: "FILE_NAME_DUPLICATE" }));
  });

  it("round-trips exact decimal text through 12 fractional digits and exponent notation", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.bigInt({ min: 0n, max: 999_999_999_999n }), (whole, fraction) => {
      const plain = fraction === 0n ? String(whole) : `${whole}.${String(fraction).padStart(12, "0").replace(/0+$/, "")}`;
      const canonical = canonicalDecimal(plain);
      return canonical !== null && canonicalDecimal(exactDecimal(canonical).value) === canonical;
    }), { numRuns: 500 });
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: -12, max: 12 }), (coefficient, exponent) => {
      const canonical = canonicalDecimal(`${coefficient}e${exponent}`);
      return canonical !== null && canonicalDecimal(exactDecimal(canonical).value) === canonical;
    }), { numRuns: 500 });
    expect(canonicalDecimal("1,234.50")).toBe("1234.5");
    expect(canonicalDecimal("1,2,3")).toBeNull();
    expect(canonicalDecimal("1.234,50")).toBeNull();
  });
});
