import "./setup.ts";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import {
  MULTIPART_RESERVE, addFiles, fileKindLabel, fileWarnings, filesProblem, locationLabel, reconciliationGroups, sentenceCase, splitProblems,
} from "../../src/app/lib/imports.ts";
import { useImportFiles } from "../../src/app/lib/useImportFiles.ts";

// The import wizard's pure parts: which files it takes before anything is sent, how a place in the files is written,
// and the order of the preview's problems and totals.

/** A file of the given size without allocating it: only the name and the size are read before sending. */
function file(name: string, size = 1): File {
  const made = new File(["x"], name);
  Object.defineProperty(made, "size", { value: size });
  return made;
}
const names = (files: readonly File[]) => files.map((item) => item.name);
const MIB = 1024 * 1024;

describe("choosing files", () => {
  it("adds Pulley's exports, a corrected file taking the place of the one it replaces", () => {
    const first = addFiles("pulley", [], [file("raw.xlsx"), file("stakeholders.csv")]);
    expect(names(first.files)).toEqual(["raw.xlsx", "stakeholders.csv"]);
    const corrected = file("raw.xlsx", 2);
    const second = addFiles("pulley", first.files, [file("vesting.xlsx"), corrected]);
    expect(names(second.files)).toEqual(["raw.xlsx", "stakeholders.csv", "vesting.xlsx"]);
    expect(second.files[0]).toBe(corrected);
    expect(second.refused).toEqual([]);
  });

  it("leaves out, by name, what the contract refuses: other types, empty files, and files over the limits", () => {
    const choice = addFiles("pulley", [], [file("consent.pdf"), file("empty.xlsx", 0), file("huge.xlsx", 5 * MIB + 1), file("ok.xlsx")]);
    expect(names(choice.files)).toEqual(["ok.xlsx"]);
    expect(choice.refused).toEqual([
      "consent.pdf: choose the Excel (.xlsx) or CSV file Pulley exported.",
      "empty.xlsx is empty.",
      "huge.xlsx is larger than 5 MiB.",
    ]);
    const full = addFiles("pulley", [file("a.xlsx", 4 * MIB), file("b.xlsx", 4 * MIB)], [file("c.xlsx", 4 * MIB)]);
    expect(names(full.files)).toEqual(["a.xlsx", "b.xlsx"]);
    expect(full.refused).toEqual(["c.xlsx: the files would add up to more than 9.9 MiB."]);
    const many = Array.from({ length: api.IMPORT_LIMITS.files }, (_, index) => file(`report-${index}.xlsx`));
    expect(addFiles("pulley", many, [file("one-more.xlsx")]).refused).toEqual(["one-more.xlsx: at most 25 files can be checked at once."]);
    // A replacement doesn't count twice against the limits.
    expect(addFiles("pulley", many, [file("report-3.xlsx", 2)]).refused).toEqual([]);
  });

  it("keeps room for the upload's own encoding: files may total the request limit less the multipart reserve", () => {
    // The server caps the whole encoded request; the boundaries and part headers around the files count too.
    const each = api.IMPORT_LIMITS.fileBytes;
    const allowed = api.IMPORT_LIMITS.requestBytes - MULTIPART_RESERVE;
    const label = `${(allowed / MIB).toFixed(1)} MiB`;
    expect(MULTIPART_RESERVE).toBe(64 * 1024);
    expect(addFiles("pulley", [file("a.xlsx", each)], [file("b.xlsx", allowed - each)]).refused).toEqual([]);
    expect(addFiles("pulley", [file("a.xlsx", each)], [file("b.xlsx", allowed - each + 1)]).refused).toEqual([
      `b.xlsx: the files would add up to more than ${label}.`,
    ]);
    expect(filesProblem("pulley", [file("a.xlsx", each), file("b.xlsx", allowed - each + 1)])).toBe(`The files add up to more than ${label}.`);
    expect(filesProblem("pulley", [file("a.xlsx", each), file("b.xlsx", allowed - each)])).toBeNull();
  });

  it("takes the spreadsheet as one Excel workbook, a new choice replacing it", () => {
    expect(names(addFiles("template", [], [file("cap-table.xlsx")]).files)).toEqual(["cap-table.xlsx"]);
    expect(names(addFiles("template", [file("old.xlsx")], [file("new.xlsx")]).files)).toEqual(["new.xlsx"]);
    const two = addFiles("template", [file("old.xlsx")], [file("a.xlsx"), file("b.xlsx")]);
    expect(names(two.files)).toEqual(["old.xlsx"]);
    expect(two.refused).toEqual(["Choose one file: the Cap Table spreadsheet is a single workbook."]);
    const csv = addFiles("template", [file("old.xlsx")], [file("cap-table.csv")]);
    expect(names(csv.files)).toEqual(["old.xlsx"]);
    expect(csv.refused).toEqual(["cap-table.csv: choose the spreadsheet as an Excel (.xlsx) file."]);
  });

  it("says what is missing before the files can be checked, as the contract would", () => {
    expect(filesProblem("pulley", [])).toBe("Choose Pulley's exports first.");
    expect(filesProblem("template", [])).toBe("Choose the filled-in spreadsheet first.");
    expect(filesProblem("template", [file("a.xlsx"), file("b.xlsx")])).toBe("Choose one file: the Cap Table spreadsheet is a single workbook.");
    expect(filesProblem("pulley", [file("a.xlsx", 6 * MIB)])).toBe("a.xlsx is larger than 5 MiB.");
    expect(filesProblem("pulley", [file("raw.xlsx"), file("vesting.xlsx")])).toBeNull();
    // Whatever passes here passes the contract's own form check.
    const files = [file("raw.xlsx", 2 * MIB), file("vesting.csv", 3 * MIB)];
    expect(filesProblem("pulley", files)).toBeNull();
    expect(api.importPreviewFormSchema.safeParse({
      source: "pulley", files, timezone: "UTC", jurisdiction: "US-DE", fiscalYearEnd: "12-31",
    }).success).toBe(true);
  });
});

describe("the preview's words and order", () => {
  it("writes a place in the files as file › sheet › row › column, leaving out what isn't known", () => {
    expect(locationLabel({ file: "Raw.xlsx", sheet: "Securities", row: 14, column: "IssuedAmount" })).toBe("Raw.xlsx › Securities › row 14 › column IssuedAmount");
    expect(locationLabel({ file: "Raw.xlsx", sheet: "Company", row: null, column: null })).toBe("Raw.xlsx › Company");
    expect(locationLabel({ file: null, sheet: null, row: null, column: null })).toBeNull();
  });

  it("puts blocking problems before warnings, each in file order with the upload-wide ones first", () => {
    const problem = (severity: "error" | "warning", message: string, file: string | null, sheet: string | null = null, row: number | null = null, column: string | null = null) =>
      ({ severity, message, file, sheet, row, column });
    const { errors, warnings } = splitProblems([
      problem("warning", "w1", "b.xlsx", "Sheet1", 3),
      problem("error", "e-row10", "a.xlsx", "Securities", 10),
      problem("error", "e-row2-AA", "a.xlsx", "Securities", 2, "AA"),
      problem("error", "e-general", null),
      problem("error", "e-row2-B", "a.xlsx", "Securities", 2, "B"),
      problem("error", "e-company", "a.xlsx", "Company", 4),
    ]);
    expect(errors.map((item) => item.message)).toEqual(["e-general", "e-company", "e-row2-B", "e-row2-AA", "e-row10"]);
    expect(warnings.map((item) => item.message)).toEqual(["w1"]);
  });

  it("groups the side-by-side totals company → classes → plans → holders → securities, counting what differs", () => {
    const line = (scope: "company" | "class" | "plan" | "holder" | "security", name: string, matches: boolean) =>
      ({ scope, sourceId: null, name, metric: "outstanding shares", uploaded: "10", app: matches ? "10" : "9", matches, file: null, sheet: null, row: null, column: null });
    const groups = reconciliationGroups([line("holder", "Freya", true), line("class", "Common", false), line("company", "Acme", true), line("holder", "Daniel", false)]);
    expect(groups.map((group) => [group.title, group.lines.map((item) => item.name), group.mismatches])).toEqual([
      ["Company", ["Acme"], 0],
      ["Share classes", ["Common"], 1],
      ["Holders", ["Freya", "Daniel"], 1],
    ]);
  });

  it("adds the warnings only a file carries (the spreadsheet's precision warnings), placed in that file, each once", () => {
    const preview = {
      detectedFiles: [
        // The spreadsheet names the cell only; Pulley's reports name the sheet first, and the problems carry those already.
        { name: "acme-cap-table.xlsx", kind: "template" as const, format: "xlsx" as const, sheets: ["Shares"], warnings: ["B14 has 17 significant digits.", "B14 has 17 significant digits.", "Options: F3 has 16 significant digits."] },
        { name: "Raw.xlsx", kind: "raw-cap-table" as const, format: "xlsx" as const, sheets: ["Securities"], warnings: ["Securities: C9 has 16 significant digits.", "Detailed: ignored because this sheet type is not supported."] },
      ],
      problems: [
        { severity: "warning" as const, message: "Securities: C9 has 16 significant digits.", file: "Raw.xlsx", sheet: "Securities", row: 9, column: "C" },
        { severity: "warning" as const, message: "Detailed: ignored because this sheet type is not supported.", file: "Raw.xlsx", sheet: "Detailed", row: 1, column: null },
      ],
    };
    expect(fileWarnings(preview)).toEqual([
      { severity: "warning", message: "B14 has 17 significant digits.", file: "acme-cap-table.xlsx", sheet: null, row: 14, column: "B" },
      { severity: "warning", message: "Options: F3 has 16 significant digits.", file: "acme-cap-table.xlsx", sheet: "Options", row: 3, column: "F" },
    ]);
    // A warning the problems list for the whole upload (no file) is the same warning.
    expect(fileWarnings({ ...preview, problems: [{ ...preview.problems[0]!, message: "B14 has 17 significant digits.", file: null }] }).map((item) => item.message)).toEqual([
      "Options: F3 has 16 significant digits.", "Securities: C9 has 16 significant digits.", "Detailed: ignored because this sheet type is not supported.",
    ]);
    expect(fileWarnings({ detectedFiles: [{ ...preview.detectedFiles[1]!, warnings: ["Sheet1: a blank row was skipped."] }], problems: [] })).toEqual([
      { severity: "warning", message: "Sheet1: a blank row was skipped.", file: "Raw.xlsx", sheet: "Sheet1", row: null, column: null },
    ]);
  });

  it("names each recognized report, and says when a file wasn't recognized", () => {
    expect(fileKindLabel("raw-cap-table")).toBe("Raw Cap Table");
    expect(fileKindLabel("iso-nso-details")).toBe("ISO/NSO Details");
    expect(fileKindLabel("template")).toBe("Cap Table spreadsheet");
    expect(fileKindLabel(null)).toBe("Not recognized");
    expect(sentenceCase("fully diluted shares")).toBe("Fully diluted shares");
  });
});

describe("the files the wizard holds", () => {
  const kinds = (detected: ReadonlyMap<File, unknown>) => [...detected.keys()].map((item) => item.name);
  const detectedFile = (name: string, kind: api.ImportDetectedFile["kind"]) => ({ name, kind, format: "xlsx" as const, sheets: [], warnings: [] });

  it("forgets what a file was recognized as once it is replaced or removed, and holds nothing once cleared", () => {
    const { result } = renderHook(() => useImportFiles());
    const raw = file("raw.xlsx");
    const vesting = file("vesting.xlsx");
    act(() => result.current.add("pulley", [raw, vesting]));
    act(() => result.current.remember([raw, vesting], [detectedFile("raw.xlsx", "raw-cap-table"), detectedFile("vesting.xlsx", "vesting-details")]));
    expect(result.current.detected.get(raw)).toBe("raw-cap-table");
    // A corrected export replaces the old file: the old file and what it was recognized as are both let go.
    const corrected = file("raw.xlsx", 2);
    act(() => result.current.add("pulley", [corrected]));
    expect(result.current.files).toEqual([corrected, vesting]);
    expect(kinds(result.current.detected)).toEqual(["vesting.xlsx"]);
    act(() => result.current.remove(vesting));
    expect(result.current.detected.size).toBe(0);
    act(() => result.current.add("pulley", [new File(["%PDF"], "consent.pdf")]));
    expect(result.current.refused).toHaveLength(1);
    act(() => result.current.clear());
    expect(result.current.files).toEqual([]);
    expect(result.current.refused).toEqual([]);
    expect(result.current.detected.size).toBe(0);
  });
});
