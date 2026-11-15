import { describe, expect, it } from "vitest";
import { csvTextField } from "../../src/app/shared/csv.ts";

describe("csvTextField", () => {
  it("quotes every field and doubles its quotes", () => {
    expect(["", "Acme Robotics", "comma, quote \" and\nnewline", "Acme;=cmd", "Crème"].map(csvTextField)).toEqual([
      "\"\"", "\"Acme Robotics\"", "\"comma, quote \"\" and\nnewline\"", "\"Acme;=cmd\"", "\"Crème\"",
    ]);
  });

  it("neutralizes what a spreadsheet would run as a formula", () => {
    expect(["=1+1", "+cmd", "-12", "@SUM(A1)", "\t=cmd", "\rcmd", " =cmd", "=HYPERLINK(\"bad\")"].map(csvTextField)).toEqual([
      "\"'=1+1\"", "\"'+cmd\"", "\"'-12\"", "\"'@SUM(A1)\"", "\"'\t=cmd\"", "\"'\rcmd\"", "\"' =cmd\"", "\"'=HYPERLINK(\"\"bad\"\")\"",
    ]);
  });
});
