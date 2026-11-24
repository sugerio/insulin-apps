import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileRules, type SourceYear } from "../../src/app/shared/engine/compile.ts";
import { RuleError } from "../../src/app/shared/engine/errors.ts";
import { loadRuleSet } from "../../src/app/shared/engine/rules.ts";
import { COMPILED_ROOT, compileNamed, ruleSetNames, serialize } from "../../scripts/rules-source.ts";

const hash = (text: string) => `h${text.length}`;

/** A year folder in memory: its year.yaml, then the other files by name. */
function year(value: number, extendsYear: number | null, files: Record<string, unknown>, result?: string[]): SourceYear {
  const dir = `rules/xx/${value}`;
  return {
    dir,
    files: [
      { path: `${dir}/year.yaml`, data: { country: "xx", year: value, filingUnit: "person", extends: extendsYear, ...(result ? { result } : {}) } },
      ...Object.entries(files).map(([name, data]) => ({ path: `${dir}/${name}`, data })),
    ],
  };
}

const base = {
  params: { rate: { label: "Rate", value: "10%", source: "s" } },
  lines: {
    "A.1": { label: "Income", formula: "sum(S.box1)" },
    "A.2": { label: "Tax", formula: "round(line.A.1 * param.rate, 2)" },
  },
  questions: { status: { type: "choice", ask: "Status", options: ["single", "married"] } },
  slips: { S: { title: "Slip", about: "A slip", boxes: { 1: "Income", 2: "Other" } } },
};

function compileError(chain: SourceYear[]): string {
  try {
    compileRules(chain, hash);
  } catch (error) {
    if (error instanceof RuleError) return error.message;
    throw error;
  }
  throw new Error("compiled");
}

describe("compiling rule files", () => {
  it("keeps the committed JSON in step with the YAML (run npm run rules)", () => {
    for (const name of ruleSetNames()) {
      expect(serialize(compileNamed(name)), name).toBe(readFileSync(join(COMPILED_ROOT, `${name}.json`), "utf8"));
    }
  });

  it("merges a year onto the one it extends: replaced, removed and new entries", () => {
    const compiled = compileRules(
      [
        year(2025, null, { "a.yaml": base }, ["A.2"]),
        year(2026, 2025, {
          "a.yaml": {
            params: { rate: { label: "Rate", value: 12, source: "2026" } },
            lines: { "A.3": { label: "Other", formula: "sum(S.box2)" } },
          },
          "b.yaml": { questions: { status: null } },
        }),
      ],
      hash,
    );
    expect(compiled.year).toBe(2026);
    expect(compiled.result).toEqual(["A.2"]);
    expect(compiled.params.rate).toEqual({ label: "Rate", value: "12", source: "2026" });
    expect(Object.keys(compiled.lines)).toEqual(["A.1", "A.2", "A.3"]);
    expect(compiled.questions).toEqual({});
    expect(loadRuleSet(compiled).lines.get("A.2")!.text).toBe("round(line.A.1 * param.rate, 2)");
  });

  it("names the file, the entry and the column of an unknown name", () => {
    const lines = { ...base.lines, "A.2": { label: "Tax", formula: "line.A.1 * param.nope" } };
    expect(compileError([year(2025, null, { "a.yaml": { ...base, lines } })])).toBe("rules/xx/2025/a.yaml, lines.A.2, column 12: No param param.nope");
  });

  it("refuses a line that depends on itself, and says through what", () => {
    const lines = { "A.1": { label: "One", formula: "line.A.2" }, "A.2": { label: "Two", formula: "line.A.1 + 1" } };
    expect(compileError([year(2025, null, { "a.yaml": { ...base, lines } })])).toMatch(/lines\.A\.1: The line depends on itself: A\.1 → A\.2 → A\.1$/);
  });

  it("keeps a line for each dependant and an adult's return apart", () => {
    const withLines = (lines: Record<string, unknown>, questions: Record<string, unknown> = {}) => [
      year(2025, null, {
        "a.yaml": {
          ...base,
          lines: { ...base.lines, ...lines },
          questions: { ...base.questions, kidAge: { type: "count", ask: "Age", module: "about", dependant: true }, ...questions },
        },
      }),
    ];
    const each = (formula: string) => ({ label: "Each", formula, each: "dependant" });
    // A dependant's line reads the dependant; a return reads the dependants' line as a list.
    expect(() => compileRules(withLines({ "D.kid": each("if(dependant.age < 17, 1, 0)"), "A.3": { label: "Kids", formula: "sum(dependants.D.kid)" } }), hash)).not.toThrow();
    expect(compileError(withLines({ "A.3": { label: "X", formula: "dependant.age" } }))).toContain("only a line with each: dependant reads dependant.<…>");
    expect(compileError(withLines({ "D.kid": each("answer.status") }))).toContain("a line for each dependant reads dependant.<…>");
    expect(compileError(withLines({ "D.kid": each("1"), "A.3": { label: "X", formula: "line.D.kid" } }))).toContain("read a dependant's line through dependants.D.kid");
    expect(compileError(withLines({ "D.kid": each("line.A.1") }))).toContain("a dependant's line reads only lines worked out for each dependant");
    expect(compileError(withLines({ "A.3": { label: "X", formula: "sum(dependants.A.1)" } }))).toContain("A.1 isn't worked out for each dependant");
    expect(compileError(withLines({ "A.3": { label: "X", formula: "answer.kidAge" } }))).toContain("kidAge is asked about each dependant");
    expect(compileError(withLines({ "D.kid": each('if(dependant.answer.status == "single", 1, 0)') }))).toContain("status is asked about an adult");
  });

  it("refuses values of the wrong kind", () => {
    const withLine = (formula: string) => [year(2025, null, { "a.yaml": { ...base, lines: { ...base.lines, "A.3": { label: "X", formula } } } })];
    expect(compileError(withLine("S.box1 + 1"))).toContain('"+" works on numbers; use sum() for slip boxes');
    expect(compileError(withLine('if(answer.status == "widowed", 1, 0)'))).toContain('"widowed" isn\'t an option of status: single, married');
    expect(compileError(withLine("answer.status"))).toContain("A line must be a number");
    expect(compileError(withLine("bracket(param.rate, 1)"))).toContain("bracket takes a bracket table and an amount");
    expect(compileError(withLine("S.box9"))).toContain("S.box9: S has boxes 1, 2");
    expect(compileError(withLine("median(1)"))).toContain("No function median");
    expect(compileError(withLine("countNonZero(1)"))).toContain("countNonZero takes slip boxes");
    expect(compileError(withLine("countNonZero(S.box1, S.box2)"))).toContain("countNonZero takes 1 values");
    expect(compileError(withLine("countNonZero(S.slips)"))).toContain("countNonZero takes slip boxes");
    expect(compileError(withLine("countIssuers(S.slips)"))).toContain("countIssuers takes slip boxes");
    expect(compileError(withLine("countIssuers(family.childMonthsUnder6)"))).toContain("countIssuers takes slip boxes");
    expect(compileError(withLine("S.slip"))).toContain("S.slip: S has boxes 1, 2 (and S.slips counts them)");
    expect(compileError(withLine("spouse.param.rate"))).toContain("params are the same for both spouses");
    expect(compileError(withLine("unsupported(1)"))).toContain("unsupported takes the reason, as text in quotes");
  });

  it("checks a group's parts: a yes/no parent without a slip, in the same module, and labels for its options", () => {
    const withQuestions = (questions: object) => [year(2025, null, { "a.yaml": { ...base, questions: { ...base.questions, ...questions } } })];
    const group = { hasBusiness: { type: "boolean", module: "income", ask: "Business", default: false } };
    expect(() => compileRules(withQuestions({ ...group, share: { type: "percent", module: "income", parent: "hasBusiness", ask: "Share" } }), hash)).not.toThrow();
    expect(compileError(withQuestions({ ...group, share: { type: "percent", module: "deductions", parent: "hasBusiness", ask: "Share" } }))).toContain("in the same module");
    expect(compileError(withQuestions({ ...group, flag: { type: "boolean", module: "income", parent: "hasBusiness", ask: "Flag" } }))).toContain("an amount, a percent, a count or a choice");
    expect(compileError(withQuestions({ share: { type: "money", module: "income", parent: "status", ask: "Share" } }))).toContain("parent must be a yes/no question");
    expect(compileError(withQuestions({ kind: { type: "choice", ask: "Kind", options: ["a"], optionLabels: { b: "B" } } }))).toContain("optionLabels name the options");
    expect(compileError(withQuestions({ amount: { type: "money", ask: "Amount", note: "File a form" } }))).toContain("Only a yes/no question has a note");
    // A part asked only for some options of a choice: the choice is a part of the same group, and the options its own.
    const kind = { type: "choice", module: "income", parent: "hasBusiness", ask: "Kind", options: ["shop", "farm"] };
    const acres = (askedWhen: object) => ({ ...group, kind, acres: { type: "count", module: "income", parent: "hasBusiness", ask: "Acres", askedWhen } });
    expect(() => compileRules(withQuestions(acres({ question: "kind", options: ["farm"] })), hash)).not.toThrow();
    expect(compileError(withQuestions(acres({ question: "kind", options: ["ranch"] })))).toContain("ranch isn't an option of kind");
    expect(compileError(withQuestions(acres({ question: "hasBusiness", options: ["farm"] })))).toContain("askedWhen names a choice of the same group");
  });

  it("keeps a count's max, only on a count and not below its default", () => {
    const withQuestions = (questions: object) => [year(2025, null, { "a.yaml": { ...base, questions: { ...base.questions, ...questions } } })];
    const group = { rented: { type: "boolean", module: "credits", ask: "Rented", default: false } };
    const months = (fields: object) => ({ ...group, months: { type: "count", module: "credits", parent: "rented", ask: "Months", ...fields } });
    expect(loadRuleSet(compileRules(withQuestions(months({ max: 12, default: "12" })), hash)).questions.get("months")!.max).toBe(12);
    expect(compileError(withQuestions(months({ max: 12, default: "13" })))).toContain("The default is more than the max, 12");
    expect(compileError(withQuestions(months({ max: 0 })))).toContain("max");
    expect(compileError(withQuestions({ amount: { type: "money", ask: "Amount", max: 12 } }))).toContain("Only a count has a max");
  });

  it("checks a bracket base printed on a form against the brackets below it", () => {
    const brackets = (base2: number) => ({
      label: "Brackets",
      source: "s",
      value: [{ upTo: 100, rate: "10%", base: 0 }, { upTo: 200, rate: "20%", base: base2 }, { rate: "30%", base: 30 }],
    });
    const withBrackets = (base2: number) => [year(2025, null, { "a.yaml": { ...base, params: { ...base.params, brackets: brackets(base2) } } })];
    expect(compileRules(withBrackets(10), hash).params.brackets!.value).toHaveLength(3);
    expect(compileError(withBrackets(11))).toBe("rules/xx/2025/a.yaml, params.brackets: The base of bracket 2 is 11; the brackets below it give 10");
  });

  it("refuses an entry defined twice in a year, a removal of nothing, and a param without its source", () => {
    expect(compileError([year(2025, null, { "a.yaml": base, "b.yaml": { params: { rate: { label: "Rate", value: 1, source: "s" } } } })])).toBe(
      "rules/xx/2025/b.yaml, params.rate: Also in rules/xx/2025/a.yaml; a year defines each entry once",
    );
    expect(compileError([year(2025, null, { "a.yaml": { ...base, lines: { ...base.lines, "A.9": null } } })])).toContain("Removes an entry that no earlier year has");
    expect(compileError([year(2025, null, { "a.yaml": { params: { rate: { label: "Rate", value: 1 } } } })])).toContain("params.rate.source");
  });

  it("checks the year chain", () => {
    expect(compileError([year(2025, 2024, { "a.yaml": base })])).toContain("The first year extends nothing (extends: null)");
    expect(compileError([year(2025, null, { "a.yaml": base }), year(2026, 2024, {})])).toContain("extends must be 2025");
  });
});
