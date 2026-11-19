import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { Dec } from "../../src/app/shared/engine/decimal.ts";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import { fillForms, formAmount } from "../../src/app/shared/engine/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// The CRA forms a return is printed on (rules/ca/2025/forms.yaml): every amount written on a form for three golden
// households, against their expected lines, and the bracket tables against the tax lines.

const rules = rulesFor(2025)!;
const GOLDEN = resolve(import.meta.dirname, "../golden/ca-2025");

interface Golden {
  input: { people: { id: string }[] };
  expected: Record<string, Record<string, string>>;
}
const golden = (name: string) => JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), "utf8")) as Golden;

describe("2025 forms", () => {
  for (const [name, province] of [
    ["on-couple-kids", "ON428"],
    ["bc-employee", "BC428"],
    ["ab-couple", "AB428"],
    ["pensioner-on", "ON428"],
    ["oas-clawback-bc", "BC428"],
    ["young-family-on", "ON428"],
    ["consultant-ab", "AB428"],
    ["shop-owner-bc", "BC428"],
    ["sales-rep-on", "ON428"],
  ] as const) {
    it(`${name}: the T1 and ${province} hold the household's expected lines`, () => {
      const household = golden(name);
      const evaluation = new Evaluation(rules, household.input);
      for (const [personId, expected] of Object.entries(household.expected)) {
        const filled = fillForms(rules, evaluation, personId);
        expect(filled.map((each) => each.form.id)).toEqual(["T1", province]);
        let checked = 0;
        for (const { form, amounts } of filled) {
          for (const field of form.fields) {
            // A row that holds a line as it is: blank when the expected line is zero, else that amount.
            const line = /^line\.([A-Z0-9]+\.[A-Za-z0-9]+)$/.exec(field.text)?.[1];
            if (!line || !(line in expected) || field.when) continue;
            const written = amounts.find((amount) => amount.key === field.key)?.value.toString() ?? "0";
            expect(written, `${form.id} row ${field.key} (${line})`).toBe(Dec.from(expected[line]!).roundTo(2, "HALF_UP").toString());
            checked += 1;
          }
        }
        expect(checked).toBeGreaterThan(30);
      }
    });
  }

  it("fills the column of the bracket the taxable income falls in, ending at the tax line", () => {
    const household = golden("on-couple-kids");
    const evaluation = new Evaluation(rules, household.input);
    const person = household.input.people[0]!.id;
    const [t1, on428] = fillForms(rules, evaluation, person);
    // $88,926 is in the second federal bracket ($57,375 to $114,750): 31,551 over, at 20.5% = 6,467.96, + 8,319.38.
    expect(t1!.amounts.filter((amount) => amount.key.includes("@")).map((amount) => [amount.key, amount.value.toString()])).toEqual([
      ["70@1", "88926"],
      ["72@1", "31551"],
      ["74@1", "6467.96"],
      ["76@1", "14787.34"],
    ]);
    expect(evaluation.line(person, "T1.40400").value!.toString()).toBe("14787.34");
    expect(on428!.amounts.find((amount) => amount.key === "8@1")!.value.toString()).toBe(evaluation.line(person, "ON428.8").value!.toString());
  });

  it("writes amounts as on a paper form: separators, cents, and a negative one in brackets", () => {
    expect(formAmount(Dec.from("1234567.5"))).toEqual({ dollars: "1,234,567", cents: "50" });
    expect(formAmount(Dec.from("12"))).toEqual({ dollars: "12", cents: "00" });
    expect(formAmount(Dec.from("-3472.91"))).toEqual({ dollars: "(3,472", cents: "91)" });
  });
});

describe("form rules", () => {
  const compile = (form: object, layout: object = {}) =>
    compileRules(
      [
        {
          dir: "rules/xx/2025",
          files: [
            { path: "rules/xx/2025/year.yaml", data: { country: "xx", year: 2025, filingUnit: "person", extends: null, result: ["R.net"] } },
            {
              path: "rules/xx/2025/rules.yaml",
              data: {
                params: { brackets: { label: "B", source: "S", value: [{ upTo: 100, rate: "10%", base: 0 }, { rate: "20%", base: 10 }] } },
                lines: { "R.net": { label: "Net", formula: "answer.amount" } },
                questions: { amount: { type: "money", ask: "Amount", default: 0 } },
                forms: { F1: { title: "F", url: "https://example.com/f.pdf", applies: "true", ...form } },
                formLayout: {
                  F1: { sha256: "a".repeat(64), pages: 1, rows: { "1": [1, 552, 700], "2": [1, 552, 680], "3": [1, 552, 660], "4": [1, 552, 640] }, columns: { "2": [300, 552] }, printed: ["3"], ...layout },
                },
              },
            },
          ],
        },
      ],
      () => "test",
    );

  it("places each row where the layout measured it", () => {
    expect(compile({ fields: { "1": "line.R.net" } }).forms.F1!.fields).toEqual([{ key: "1", page: 1, x: 552, y: 700, value: "line.R.net" }]);
  });

  it("refuses a row the form doesn't have, one with a printed amount, a wrong table, and a formula that isn't a number", () => {
    expect(() => compile({ fields: { "9": "line.R.net" } })).toThrow(/no row 9/);
    expect(() => compile({ fields: { "3": "line.R.net" } })).toThrow(/already has an amount printed/);
    expect(() => compile({ fields: { "1": "answer.amount > 0" } })).toThrow(/must be a number/);
    expect(() =>
      compile({ fields: {}, tables: [{ brackets: "brackets", amount: "line.R.net", parts: [{ columns: "1", amount: "1", over: "2", times: "3", tax: "4" }] }] }),
    ).toThrow(/no preprinted columns/);
    expect(() => compile({ fields: {} }, { pages: 1, rows: {}, sha256: "b".repeat(64) })).not.toThrow();
  });
});
