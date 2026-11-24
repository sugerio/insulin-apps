import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { EngineError } from "../../src/app/shared/engine/errors.ts";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { loadRuleSet } from "../../src/app/shared/engine/rules.ts";

// Code boxes: a slip box holding a code from a list (a 1099-R's distribution code, a 1099-B summary's part of Form
// 8949), read only through sumWhere and countWhere.

const year = (lines: Record<string, unknown>, slip: Record<string, unknown> = {}) => [
  {
    dir: "rules/xx/2025",
    files: [
      { path: "rules/xx/2025/year.yaml", data: { country: "xx", year: 2025, filingUnit: "person", extends: null, result: Object.keys(lines) } },
      {
        path: "rules/xx/2025/rules.yaml",
        data: {
          slips: { R: { title: "R slip", about: "A test slip", boxes: { 1: "Gross", 2: "Taxable", 7: "Code" }, codes: { 7: [1, 7, "G"] }, ...slip } },
          lines,
        },
      },
    ],
  },
];
const compile = (lines: Record<string, unknown>, slip?: Record<string, unknown>) => loadRuleSet(compileRules(year(lines, slip), () => "test"));

function input(slips: { boxes: Record<string, string> }[]): EngineInput {
  return {
    year: 2025,
    people: [{ id: "a", name: "Alex", role: "self", birthDate: "1980-01-01", province: null }],
    family: { maritalStatus: "single", dependants: [] },
    answers: { a: {} },
    slips: slips.map((slip, index) => ({ id: `r${index}`, person: "a", type: "R", issuer: `Payer ${index}`, ...slip })),
  };
}

describe("code boxes", () => {
  const rules = compile({
    "X.taxable": { label: "Taxable", formula: 'sumWhere(R.box2, R.box7, "1", "7")' },
    "X.rolled": { label: "Rolled over", formula: 'countWhere(R.box1, R.box7, "G")' },
  });

  it("sums and counts the slips whose code is one of the codes; a slip without the box matches none", () => {
    const evaluation = new Evaluation(rules, input([{ boxes: { 1: "100", 2: "100", 7: "7" } }, { boxes: { 1: "50", 2: "0", 7: "G" } }, { boxes: { 1: "30", 2: "30" } }]));
    expect(evaluation.line("a", "X.taxable").value?.toString()).toBe("100");
    expect(evaluation.line("a", "X.rolled").value?.toString()).toBe("1");
  });

  it("refuses a code the box can't hold, in the rules and in the input", () => {
    expect(() => compile({ "X.bad": { label: "Bad", formula: 'sumWhere(R.box2, R.box7, "Q")' } })).toThrow(/R box 7 holds 1, 7, G, not Q/);
    expect(() => new Evaluation(rules, input([{ boxes: { 1: "1", 7: "Q" } }]))).toThrow(EngineError);
  });

  it("reads a code box only through sumWhere and countWhere, with an amount box of the same slip", () => {
    expect(() => compile({ "X.bad": { label: "Bad", formula: "sum(R.box7)" } })).toThrow(/takes numbers or slip boxes/);
    expect(() => compile({ "X.bad": { label: "Bad", formula: 'sumWhere(R.box7, R.box7, "G")' } })).toThrow(/takes a slip box of amounts/);
    expect(() => compile({ "X.bad": { label: "Bad", formula: 'sumWhere(R.box2, R.box1, "G")' } })).toThrow(/takes a slip box of amounts/);
  });

  it("checks the code list: a box of the slip, codes of 1 to 12 capitals or digits, not also a count", () => {
    const line = { "X.ok": { label: "Ok", formula: "sum(R.box1)" } };
    expect(() => compile(line, { codes: { 9: ["G"] } })).toThrow(/code box 9 isn't one of its boxes/);
    expect(() => compile(line, { codes: { 7: ["gg"] } })).toThrow(/codes of 1 to 12 capital letters or digits/);
    expect(() => compile(line, { codes: { 7: ["G"] }, counts: [7] })).toThrow(/can't also be a count/);
  });
});
