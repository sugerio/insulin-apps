import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { fillForms, personalFacts } from "../../src/app/shared/engine/forms.ts";
import { loadRuleSet } from "../../src/app/shared/engine/rules.ts";

// A form's table of slips (New York's Form IT-2 and IT-1099-R): each of the return's slips of a type in a column of the
// form, the spouse's after the person's on a joint return, with the boxes the form asks for.

const LAYOUT = {
  sha256: "a".repeat(64),
  pages: 1,
  rows: { "gross@1": [1, 300, 700], "gross@2": [1, 300, 600], "ours@1": [1, 400, 700], "ours@2": [1, 400, 600] },
  plain: [],
  text: { "payer@1": [1, 40, 700, 100], "payer@2": [1, 40, 600, 100], "state@1": [1, 200, 700, 30], "state@2": [1, 200, 600, 30] },
};

const year = (slips: object) => [
  {
    dir: "rules/xx/2025",
    files: [
      { path: "rules/xx/2025/year.yaml", data: { country: "xx", year: 2025, filingUnit: "person", extends: null, result: ["X.joint"] } },
      {
        path: "rules/xx/2025/rules.yaml",
        data: {
          slips: {
            R: { title: "R slip", about: "A test slip", boxes: { 1: "Gross", 2: "State tax", 7: "Code", 15: "State" }, codes: { 7: [1, 7, "G"], 15: ["NY", "NJ"] } },
            S: { title: "S slip", about: "Another test slip", boxes: { 1: "Gross", 2: "State tax", 15: "State" }, codes: { 15: ["NY", "NJ"] } },
          },
          lines: { "X.joint": { label: "Joint", formula: 'if(family.filingStatus == "joint", 1, 0)' } },
          forms: { F1: { title: "F", url: "https://example.com/f.pdf", applies: "true", fields: {}, slips } },
          formLayout: { F1: LAYOUT },
        },
      },
    ],
  },
];
const compile = (slips: object) => loadRuleSet(compileRules(year(slips), () => "test"));

function input(joint: boolean, slips: { person: string; type?: string; issuer: string; boxes: Record<string, string> }[]): EngineInput {
  return {
    year: 2025,
    people: [
      { id: "a", name: "Alex Ray", role: "self", birthDate: "1980-01-01", province: null },
      ...(joint ? [{ id: "b", name: "Sam Ray", role: "spouse" as const, birthDate: "1981-01-01", province: null }] : []),
    ],
    family: { maritalStatus: joint ? "married" : "single", ...(joint ? { filingStatus: "joint" as const } : {}), dependants: [] },
    answers: { a: {}, ...(joint ? { b: {} } : {}) },
    slips: slips.map((slip, index) => ({ id: `s${index}`, type: "R", ...slip })),
  };
}

const TABLE = {
  type: ["R", "S"],
  which: { box: "15", is: ["NY"] },
  spouse: "line.X.joint == 1",
  columns: 2,
  fields: {
    payer: { issuer: true },
    gross: { box: "1" },
    state: { box: "15" },
    ours: { box: "2", if: { box: "15", is: ["NY"] } },
  },
};

describe("a table of slips", () => {
  it("places each field once per column, an amount on a row and a code or the issuer in a text box", () => {
    const table = compile(TABLE).forms.get("F1")!.slips!;
    expect([table.types, table.which, table.columns, table.spouseText]).toEqual([["R", "S"], { box: "15", is: ["NY"], not: false }, 2, "line.X.joint == 1"]);
    expect(table.fields.filter((field) => field.column === 2).map(({ key, kind }) => [key, kind])).toEqual([
      ["payer@2", "text"],
      ["gross@2", "amount"],
      ["state@2", "text"],
      ["ours@2", "amount"],
    ]);
  });

  it("fills a column for each of the return's slips the table takes, the spouse's after the person's, and names the others", () => {
    const rules = compile(TABLE);
    const evaluation = new Evaluation(
      rules,
      input(true, [
        { person: "b", issuer: "Spouse Payer", boxes: { 1: "300", 2: "30", 15: "NY" } },
        { person: "a", issuer: "Jersey Payer", boxes: { 1: "900", 2: "90", 15: "NJ" } },
        { person: "a", type: "S", issuer: "First Payer", boxes: { 1: "100", 15: "NY" } },
        { person: "a", issuer: "Second Payer", boxes: { 1: "200", 2: "20", 15: "NY" } },
      ]),
    );
    const [form] = fillForms(rules, evaluation, "a", personalFacts(evaluation.input, "a"));
    const text = (key: string) => form!.marks.flatMap((mark) => (mark.key === key && mark.kind === "text" ? [mark.text] : []))[0];
    const amount = (key: string) => form!.amounts.find((each) => each.key === key)?.value.toString();
    // The New Jersey slip isn't one the table takes; the person's two come first, so the spouse's has no room.
    expect([text("payer@1"), amount("gross@1"), amount("ours@1")]).toEqual(["First Payer", "100", undefined]);
    expect([text("payer@2"), amount("gross@2"), amount("ours@2")]).toEqual(["Second Payer", "200", "20"]);
    expect(text("state@2")).toBe("NY");
    expect(form!.slipsLeft).toEqual(["R from Spouse Payer"]);
    // Filing separately, the spouse's slips aren't on the person's form.
    const single = new Evaluation(rules, input(false, [{ person: "a", issuer: "Only Payer", boxes: { 1: "100", 2: "10", 15: "NY" } }]));
    expect(fillForms(rules, single, "a", personalFacts(single.input, "a"))[0]!.slipsLeft).toEqual([]);
  });

  it("refuses a box the slip hasn't, an amount in a text box, a code on an amount row, the issuer as an amount and a code the box can't hold", () => {
    const withField = (field: object, extra: object = {}) => compile({ ...TABLE, ...extra, fields: { gross: field } });
    expect(() => withField({ box: "9" })).toThrow(/R has no box 9/);
    expect(() => compile({ ...TABLE, fields: { payer: { box: "1" } } })).toThrow(/holds an amount: write it in an amount row/);
    expect(() => withField({ box: "15" })).toThrow(/holds a code: write it in a text box/);
    expect(() => withField({ issuer: true })).toThrow(/The issuer's name goes in a text box/);
    expect(() => withField({ box: "1", if: { box: "15", is: ["CA"] } })).toThrow(/Box 15 of R has no code CA/);
    expect(() => withField({ box: "1" }, { which: { box: "1", is: ["NY"] } })).toThrow(/Box 1 of R doesn't hold a code/);
    expect(() => withField({ box: "1" }, { type: "T" })).toThrow(/No slip type T/);
  });
});
