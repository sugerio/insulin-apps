import { describe, expect, it } from "vitest";
import { lineOf, measureIrsForm, nyLineOf, xfaLabels, type IrsField } from "../../scripts/form-irs.ts";

// The layout script's IRS mode (scripts/form-irs.ts): an IRS fill-in form is placed by its fields' boxes and the labels
// its XFA part gives them, not measured from the drawing. The real forms are placed by npm run form-layout; these pin
// how a label names its line, how the XFA part names its fields, and what goes where.

const field = (name: string, label: string, place: Partial<IrsField> = {}): IrsField => ({
  name,
  kind: "text",
  page: 1,
  x: 504,
  y: 330,
  width: 72,
  height: 12,
  right: true,
  comb: false,
  label,
  ...place,
});

describe("an IRS form's layout", () => {
  it("reads the line number a label starts its line with", () => {
    expect(lineOf("1e. Taxable dependent care benefits from Form 2441, line 26.")).toBe("1e");
    expect(lineOf("Income. Attach Form(s) W-2 here. If you did not get a Form W-2, see instructions. 1a. Total amount from Form(s) W-2, box 1.")).toBe("1a");
    // Not the page's number; a line lettered in its label is that part; a line after a heading with a colon.
    expect(lineOf("Page 2. Tax and Credits. 11b. Amount from line 11a (adjusted gross income).")).toBe("11b");
    expect(lineOf("Payments and Refundable Credits. 25. Federal income tax withheld from: a. Form(s) W-2.")).toBe("25a");
    expect(lineOf("Individuals: 13. Modified adjusted gross income (see instructions).")).toBe("13");
    // A table's row isn't a line.
    expect(lineOf("Row: 1. Column: (d) Qualified expenses you incurred and paid in 2025.")).toBeNull();
    expect(lineOf("Your first name and middle initial.")).toBeNull();
  });

  it("names each field of the XFA part by its path below the page, counting the names under each parent", () => {
    const template = `<template><subform name="topmostSubform"><subform name="Page1">
      <field name="f1_01"><assist><speak>Your first name.</speak></assist></field>
      <subform name="Checkbox_ReadOrder"><field name="c1_8"><assist><speak>Single.</speak></assist></field>
        <field name="c1_8"><assist><speak>Married filing jointly.</speak></assist></field></subform>
      <field name="c1_8"><assist><speak>Head of household (H O H).</speak></assist></field>
      <area><field name="f1_47"><para hAlign="right"/><assist><speak>1a. Wages &amp; tips.</speak></assist></field></area>
    </subform></subform></template>`;
    expect(Object.fromEntries(xfaLabels(template))).toEqual({
      "f1_01[0]": { text: "Your first name.", right: false },
      "Checkbox_ReadOrder[0].c1_8[0]": { text: "Single.", right: false },
      "Checkbox_ReadOrder[0].c1_8[1]": { text: "Married filing jointly.", right: false },
      "c1_8[0]": { text: "Head of household (H O H).", right: false },
      "f1_47[0]": { text: "1a. Wages & tips.", right: true },
    });
  });

  it("places an amount by its line number at its box's right end, and each named place by its field", () => {
    const measured = measureIrsForm(
      [
        field("f1_47[0]", "1a. Total amount from Form(s) W-2, box 1."),
        field("f1_14[0]", "Your first name and middle initial.", { x: 36, y: 684, width: 215, height: 14, right: false }),
        field("c1_8[0]", "Head of household (H O H).", { kind: "tick", x: 350, y: 578, width: 8, height: 8, right: false }),
        field("f1_9[0]", "4. Number of qualifying children.", { right: false, x: 410, width: 70 }),
        field("y1[0]", "3. Child 1. Year. Digit 1 of 4.", { right: false, comb: true, x: 100, width: 10 }),
        ...["y2[0]", "y3[0]", "y4[0]"].map((name, index) => field(name, `3. Digit ${index + 2} of 4.`, { right: false, comb: true, x: 118 + index * 18, width: 10 })),
        field("f1_16[0]", "Your social security number.", { right: false, comb: true }),
      ],
      {
        firstName: { field: "f1_14[0]", label: "Your first name" },
        hoh: { field: "c1_8[0]", label: "Head of household" },
        "4": { field: "f1_9[0]", label: "Number of qualifying children", count: true },
        "birthYear@1": { field: "y1[0]", label: "Child 1. Year", cells: ["y2[0]", "y3[0]", "y4[0]"] },
      },
    );
    expect(measured).toEqual({
      rows: { "1a": [1, 575.5, 332.8], "4": [1, 479.5, 332.8] },
      // A count isn't written with cents.
      plain: ["1a"],
      text: { firstName: [1, 38, 687.8, 211] },
      combs: { "birthYear@1": [1, 96, 332.8, 18] },
      ticks: { hoh: [1, 354, 582] },
    });
  });

  it("refuses two amount fields with one line number unless one is named, and a named field that isn't the one meant", () => {
    const twice = [field("f2_17[0]", "26. Estimated tax payments."), field("f2_18[0]", "26. Amount.")];
    expect(() => measureIrsForm(twice)).toThrow("Line 26 has 2 amount fields (f2_17[0], f2_18[0]): name the one meant");
    expect(measureIrsForm(twice, { "26": { field: "f2_17[0]", label: "Estimated tax" } }).rows).toEqual({ "26": [1, 575.5, 332.8] });
    expect(() => measureIrsForm(twice, { "26": { field: "f2_18[0]", label: "Estimated tax" } })).toThrow('26: f2_18[0] is "26. Amount.", not "Estimated tax"');
    expect(() => measureIrsForm(twice, { x: { field: "f9_99[0]", label: "x" } })).toThrow("x: the form has no field f9_99[0]");
  });

  it("finds the line a New York field's name names", () => {
    expect(["Line33", "Line47a", "line16a", "Line 1"].map(nyLineOf)).toEqual(["33", "47a", "16a", "1"]);
    expect(["6 dollars15", "28a dollars", "5 dollars16", "line 3 dollars27", "Worksheet B 5 dollars15"].map(nyLineOf)).toEqual(["6", "28a", "5", "3", "B5"]);
    expect(["Line 9_box", "34Deduction", "TP_first_name", "13 IT201 filers dollars16", "17 federal adjusted gross income dollars15"].map(nyLineOf)).toEqual([null, null, null, null, null]);
  });
});
