import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { EngineError } from "../../src/app/shared/engine/errors.ts";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { loadRuleSet } from "../../src/app/shared/engine/rules.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// A small rule set that exercises the evaluator without depending on real tax numbers.
const rules = loadRuleSet(
  compileRules(
    [
      {
        dir: "rules/xx/2025",
        files: [
          { path: "rules/xx/2025/year.yaml", data: { country: "xx", year: 2025, filingUnit: "person", extends: null, result: ["R.total", "R.tax"] } },
          {
            path: "rules/xx/2025/a.yaml",
            data: {
              params: {
                brackets: { label: "Brackets", source: "s", value: [{ upTo: 100, rate: "10%" }, { upTo: 200, rate: "20%" }, { rate: "50%" }] },
              },
              lines: {
                "R.income": { label: "Income", formula: "sum(S.box1)" },
                "R.deduction": { label: "Deduction", formula: "answer.deduction" },
                "R.total": { label: "Total", formula: "max(0, line.R.income - line.R.deduction)" },
                "R.tax": { label: "Tax", formula: "round(bracket(param.brackets, line.R.total), 2)" },
                "R.rate": { label: "Rate", formula: "step(param.brackets, line.R.total)" },
                "R.partner": { label: "Partner's total", formula: "spouse.line.R.total" },
                "R.gated": { label: "Gated", formula: 'if(answer.hasPet and answer.petKind == "dog", answer.petCost, 0)' },
                "R.older": { label: "Older", formula: "if(person.age >= 65, 1, 0)" },
                "R.birthMonth": { label: "Birth month", formula: "person.birthMonth" },
              },
              questions: {
                deduction: { type: "money", ask: "Deduction", default: 0 },
                hasPet: { type: "boolean", ask: "A pet?" },
                petKind: { type: "choice", ask: "Which pet?", options: ["dog", "cat"] },
                petCost: { type: "money", ask: "Pet costs" },
              },
              slips: { S: { title: "Slip", about: "A slip", boxes: { 1: "Income", 2: "Other" }, informational: [] } },
            },
          },
        ],
      },
    ],
    () => "test",
  ),
);

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    year: 2025,
    people: [
      { id: "a", name: "Alex", role: "self", birthDate: "1960-04-02", province: "ON" },
      { id: "b", name: "Sam", role: "spouse", birthDate: "1987-09-15", province: "BC" },
    ],
    household: { maritalStatus: "married", dependants: [] },
    answers: {},
    slips: [
      { id: "s1", person: "a", type: "S", issuer: "One", boxes: { 1: "150.50" } },
      { id: "s2", person: "a", type: "S", issuer: "Two", boxes: { 1: "100", 2: "7" } },
      { id: "s3", person: "b", type: "S", issuer: "Three", boxes: { 1: "80" } },
    ],
    ...overrides,
  };
}

const value = (evaluation: Evaluation, person: string, line: string) => {
  const result = evaluation.line(person, line);
  return [result.value?.toString() ?? null, result.status];
};

describe("evaluating a household", () => {
  it("sums slip boxes, applies brackets, and marks a default as an estimate", () => {
    const evaluation = new Evaluation(rules, input());
    expect(value(evaluation, "a", "R.income")).toEqual(["250.5", "complete"]);
    expect(value(evaluation, "a", "R.total")).toEqual(["250.5", "estimate"]);
    // 100 × 10% + 100 × 20% + 50.5 × 50%
    expect(value(evaluation, "a", "R.tax")).toEqual(["55.25", "estimate"]);
    const answered = new Evaluation(rules, input({ answers: { a: { deduction: "50.5" } } }));
    expect(value(answered, "a", "R.tax")).toEqual(["30", "complete"]);
  });

  it("reads a chart of rates: the rate of the row the amount falls in, up to and including its top", () => {
    expect(value(new Evaluation(rules, input()), "a", "R.rate")).toEqual(["0.5", "estimate"]);
    expect(value(new Evaluation(rules, input({ answers: { a: { deduction: "150.5" } } })), "a", "R.rate")).toEqual(["0.1", "complete"]);
    expect(value(new Evaluation(rules, input({ answers: { a: { deduction: "150.49" } } })), "a", "R.rate")).toEqual(["0.2", "complete"]);
  });

  it("reads the spouse's return, and is missing without a spouse", () => {
    expect(value(new Evaluation(rules, input()), "a", "R.partner")).toEqual(["80", "estimate"]);
    expect(value(new Evaluation(rules, input()), "b", "R.partner")).toEqual(["250.5", "estimate"]);
    const alone = new Evaluation(rules, input({ people: [input().people[0]!], slips: input().slips.slice(0, 2) }));
    expect(value(alone, "a", "R.partner")).toEqual([null, "missing"]);
  });

  it("asks only what a reached condition needs", () => {
    const noPet = new Evaluation(rules, input({ answers: { a: { hasPet: false } } }));
    expect(value(noPet, "a", "R.gated")).toEqual(["0", "complete"]);
    const dog = new Evaluation(rules, input({ answers: { a: { hasPet: true, petKind: "dog" } } }));
    expect(value(dog, "a", "R.gated")).toEqual([null, "missing"]);
    const cat = new Evaluation(rules, input({ answers: { a: { hasPet: true, petKind: "cat" } } }));
    expect(value(cat, "a", "R.gated")).toEqual(["0", "complete"]);
  });

  it("uses the age on December 31", () => {
    expect(value(new Evaluation(rules, input()), "a", "R.older")).toEqual(["1", "complete"]);
    expect(value(new Evaluation(rules, input()), "b", "R.older")).toEqual(["0", "complete"]);
  });

  it("reads the month of birth", () => {
    expect(value(new Evaluation(rules, input()), "a", "R.birthMonth")).toEqual(["4", "complete"]);
    expect(value(new Evaluation(rules, input()), "b", "R.birthMonth")).toEqual(["9", "complete"]);
  });

  it("summarizes the result lines with what is estimated and what isn't handled", () => {
    const result = new Evaluation(rules, input({ answers: { b: { deduction: "0", oldQuestion: "1" } } })).result();
    expect(result.rulesVersion).toBe("test");
    expect(result.people[0]).toEqual({
      personId: "a",
      lines: [
        { id: "R.total", label: "Total", value: "250.5", status: "estimate" },
        { id: "R.tax", label: "Tax", value: "55.25", status: "estimate" },
      ],
      missing: [],
      estimates: [{ question: "deduction", ask: "Deduction", assumed: "0" }],
      unhandled: ["S from Two: box 2 isn't handled by this app"],
      questions: ["deduction"],
    });
    expect(result.people[1]).toMatchObject({ estimates: [], unhandled: ["The answer to oldQuestion isn't used for 2025"] });
  });

  it("explains a line down to each slip", () => {
    const explanation = new Evaluation(rules, input()).explain("a", "line.R.total");
    expect(explanation).toMatchObject({ ref: "line.R.total", label: "Total", value: "250.5", status: "estimate", formula: "max(0, line.R.income - line.R.deduction)" });
    const [income, deduction] = explanation.inputs;
    expect(income).toMatchObject({ ref: "line.R.income", value: "250.5" });
    expect(income!.inputs[0]).toMatchObject({ ref: "S.box1", label: "S box 1: Income", value: "250.5" });
    expect(income!.inputs[0]!.inputs.map((slip) => [slip.label, slip.value])).toEqual([
      ["S from One", "150.5"],
      ["S from Two", "100"],
    ]);
    expect(deduction).toMatchObject({ ref: "line.R.deduction", inputs: [{ ref: "answer.deduction", label: "Deduction", value: "0", status: "estimate" }] });
    expect(new Evaluation(rules, input()).explain("a", "line.R.partner").inputs[0]).toMatchObject({ ref: "spouse.line.R.total", value: "80" });
  });

  it("refuses input that doesn't fit the rules", () => {
    const refused = (overrides: Partial<EngineInput>) => {
      try {
        new Evaluation(rules, input(overrides));
      } catch (error) {
        if (error instanceof EngineError) return error.message;
        throw error;
      }
      return "accepted";
    };
    expect(refused({ year: 2024 })).toBe("The input is for 2024; the rules are for 2025");
    expect(refused({ slips: [{ id: "x", person: "a", type: "T9", issuer: "?", boxes: {} }] })).toBe("Slip x has an unknown type T9");
    expect(refused({ slips: [{ id: "x", person: "z", type: "S", issuer: "?", boxes: {} }] })).toBe("Slip x belongs to no one in the input");
    expect(refused({ answers: { a: { petKind: "fish" } } })).toBe("The answer to petKind doesn't fit a choice question");
    expect(refused({ answers: { a: { deduction: "lots" } } })).toBe("The answer to deduction doesn't fit a money question");
  });
});

describe("the 2025 rules", () => {
  const alone = (slips: EngineInput["slips"], province = "ON", answers: Record<string, string> = {}) =>
    new Evaluation(rulesFor(2025)!, {
      year: 2025,
      people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province }],
      household: { maritalStatus: "single", dependants: [] },
      answers: { p1: answers },
      slips,
    });
  const t4 = (boxes: Record<string, string>, id = "s1") => ({ id, person: "p1", type: "T4", issuer: "Maple Corp", boxes });

  it("explain basic federal tax with each number's source", () => {
    const evaluation = alone([t4({ 14: "60000", 16: "3361.75", 18: "984", 22: "9000", 40: "100" })]);
    const explanation = evaluation.explain("p1", "line.T1.42900");
    expect(explanation).toMatchObject({ label: "Basic federal tax", value: "5641.47", status: "estimate" });
    expect(explanation.inputs.map((input) => input.ref)).toEqual(["line.T1.40400", "line.T1.35000", "line.T1.40425"]);
    const federalTax = explanation.inputs[0]!;
    expect(federalTax.inputs.map((input) => input.ref)).toEqual(["param.taxBrackets", "line.T1.26000"]);
    expect(federalTax.inputs[0]!.source).toMatch(/14\.5% applies for the year/);
    const result = evaluation.result().people[0]!;
    expect(result.estimates.map((estimate) => estimate.question)).toEqual(expect.arrayContaining(["donations", "fhsaDeduction", "hasSelfEmployment", "rrspDeduction"]));
    expect(result.questions).toContain("hasChildCare");
    expect(result.unhandled).toEqual(["T4 from Maple Corp: box 40 isn't handled by this app"]);
  });

  it("say which household fact is missing", () => {
    const evaluation = new Evaluation(rulesFor(2025)!, {
      year: 2025,
      people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: null }],
      household: { maritalStatus: null, dependants: [] },
      answers: {},
      slips: [],
    });
    expect(evaluation.line("p1", "T1.42000").status).toBe("missing");
    // In no particular order: which fact a formula reads first is the rules' business.
    expect([...evaluation.result().people[0]!.missing].sort((a, b) => a.question.localeCompare(b.question))).toEqual([
      { question: "household.maritalStatus", ask: "Marital status on December 31" },
      { question: "person.province", ask: "Province on December 31" },
    ]);
  });

  it("say what they can't compute instead of guessing", () => {
    // A resident of Quebec whose T4 shows CPP (not QPP) contributions works them out on Form RC381.
    const rc381 =
      "Your T4 slips show CPP contributions (box 16 or 16A). A resident of Quebec with CPP contributions works them out on Form RC381, which this app doesn't handle yet";
    const quebec = alone([t4({ 14: "60000", 16: "3361.75", 22: "9000" })], "QC");
    expect(quebec.line("p1", "T1.30800")).toEqual({ value: null, status: "missing" });
    expect(quebec.line("p1", "T1.48400").status).toBe("missing");
    // Quebec's tax is on the TP-1, not on line 42800.
    expect(quebec.line("p1", "T1.42800").value?.toString()).toBe("0");
    expect(quebec.result().people[0]!.unhandled).toContain(rc381);
    expect(quebec.explain("p1", "line.CPP.deducted").notes).toEqual([rc381]);
    // And outside Quebec, a T4 with QPP contributions.
    expect(alone([t4({ 14: "60000", 17: "3616" })]).line("p1", "T1.30800").status).toBe("missing");

    // A Quebec resident's T4 without the RL-1 its employer issues with it: the federal return is worked out (Quebec has
    // no Form 428), and the Quebec return (TP-1) says what it needs instead of leaving the employment income out.
    const withoutRl1 = alone([t4({ 14: "60000", 22: "9000" })], "QC");
    expect(withoutRl1.line("p1", "T1.42800").value?.toString()).toBe("0");
    expect(withoutRl1.line("p1", "T1.42000").status).toBe("estimate");
    expect(withoutRl1.line("p1", "TP1.199")).toEqual({ value: null, status: "missing" });
    expect(withoutRl1.line("p1", "TP1.478").status).toBe("missing");
    const needsRl1 = expect.stringMatching(/issues an RL-1 with each T4: upload it/);
    expect(withoutRl1.result().people[0]!.unhandled).toContainEqual(needsRl1);
    expect(withoutRl1.explain("p1", "line.QC.scope").notes).toEqual([needsRl1]);
    // A return outside Quebec never reads the TP-1: its Quebec lines are 0, and it asks for no RL slip.
    const ontario = alone([t4({ 14: "60000", 22: "9000" })]);
    expect(ontario.linesOf("p1").filter((id) => id.startsWith("TP1.") || id.startsWith("QC"))).toEqual([]);
    expect(ontario.result().people[0]!.lines.map((line) => line.id)).not.toContain("TP1.478");
    expect(ontario.result().people[0]!.questions).toContain("hasEmploymentIncome");
    expect(ontario.result().people[0]!.questions).not.toContain("hasRl1");
    expect(withoutRl1.result().people[0]!.questions).toEqual(expect.arrayContaining(["hasEmploymentIncome", "hasRl1", "hasRl31", "qcGroupDrugPlan"]));

    // Box 26 on one slip and not the other: Schedule 8 takes box 14 for the blank one, which a sum of slips can't do.
    const oneBlank = alone([t4({ 14: "60000", 16: "3361.75", 26: "60000" }), t4({ 14: "30000", 16: "1576.75" }, "s2")]);
    expect(oneBlank.line("p1", "T1.44800").status).toBe("missing");
    expect(oneBlank.result().people[0]!.unhandled).toContainEqual(expect.stringMatching(/Enter box 26 on each slip/));
  });

  it("refund the CPP and EI two employers deducted over the year's maximum", () => {
    // Each employer deducted on its own earnings: 5.95% over $3,500 twice, and no second additional contributions.
    const twoJobs = alone([
      t4({ 14: "60000", 16: "3361.75", 18: "984", 22: "9000" }),
      t4({ 14: "30000", 16: "1576.75", 18: "492", 22: "4000" }, "s2"),
    ]);
    const line = (id: string) => twoJobs.line("p1", id).value!.toString();
    // Schedule 8, Part 3: required 3,356.10 + 678 + 396 on $90,000; deducted 4,938.50.
    expect([line("T1.30800"), line("T1.22215"), line("T1.44800")]).toEqual(["3356.1", "1074", "508.4"]);
    // Form T2204: 1,476 deducted, $1,077.48 required.
    expect([line("T1.31200"), line("T1.45000")]).toEqual(["1077.48", "398.52"]);
  });

  it("phase out the basic personal amount between the 26% and 33% brackets", () => {
    const at = (income: string) =>
      new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "ON" }],
        household: { maritalStatus: "single", dependants: [] },
        answers: { p1: { rrspDeduction: "0" } },
        slips: [{ id: "s1", person: "p1", type: "T4", issuer: "Maple Corp", boxes: { 14: income } }],
      }).line("p1", "T1.30000").value!.toString();
    // (16129 − 14538) × (215648 − 177882) / (253414 − 177882) = 795.5: halfway down.
    expect([at("177882"), at("215648"), at("253414"), at("300000")]).toEqual(["16129", "15333.5", "14538", "14538"]);
  });
});
