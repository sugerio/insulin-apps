import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { EngineError } from "../../src/app/shared/engine/errors.ts";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { loadRuleSet } from "../../src/app/shared/engine/rules.ts";
import { PROVINCES } from "../../src/app/shared/people.ts";
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
                "R.slips": { label: "Slips with box 1", formula: "count(S.box1)" },
                "R.slipsWithAmount": { label: "Slips with an amount in box 1", formula: "countNonZero(S.box1)" },
                "R.allSlips": { label: "Slips", formula: "S.slips" },
                "R.issuers": { label: "Issuers with an amount in box 1", formula: "countIssuers(S.box1)" },
                "R.deduction": { label: "Deduction", formula: "answer.deduction" },
                "R.total": { label: "Total", formula: "max(0, line.R.income - line.R.deduction)" },
                "R.tax": { label: "Tax", formula: "round(bracket(param.brackets, line.R.total), 2)" },
                "R.rate": { label: "Rate", formula: "step(param.brackets, line.R.total)" },
                "R.partner": { label: "Partner's total", formula: "spouse.line.R.total" },
                "R.gated": { label: "Gated", formula: 'if(answer.hasPet and answer.petKind == "dog", answer.petCost, 0)' },
                "R.older": { label: "Older", formula: "if(person.age >= 65, 1, 0)" },
                "R.birthMonth": { label: "Birth month", formula: "person.birthMonth" },
                "R.kids": { label: "Children under 18", formula: "family.childrenUnder18" },
                "R.youngMonths": { label: "Fewest months under 6", formula: "min(family.childMonthsUnder6)" },
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
    family: { maritalStatus: "married", dependants: [] },
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

describe("evaluating a year", () => {
  it("sums slip boxes, applies brackets, and marks a default as an estimate", () => {
    const evaluation = new Evaluation(rules, input());
    expect(value(evaluation, "a", "R.income")).toEqual(["250.5", "complete"]);
    expect(value(evaluation, "a", "R.total")).toEqual(["250.5", "estimate"]);
    // 100 × 10% + 100 × 20% + 50.5 × 50%
    expect(value(evaluation, "a", "R.tax")).toEqual(["55.25", "estimate"]);
    const answered = new Evaluation(rules, input({ answers: { a: { deduction: "50.5" } } }));
    expect(value(answered, "a", "R.tax")).toEqual(["30", "complete"]);
  });

  it("counts a person's slips, those that show a box, and those whose box holds an amount other than 0", () => {
    // A box left blank on the paper slip is entered as 0: count() counts it, countNonZero() doesn't.
    const blank = { id: "s4", person: "a", type: "S", issuer: "Four", boxes: { 1: "0.00", 2: "3" } };
    const noBox = { id: "s5", person: "a", type: "S", issuer: "Five", boxes: { 2: "3" } };
    const evaluation = new Evaluation(rules, input({ slips: [...input().slips, blank, noBox] }));
    expect(value(evaluation, "a", "R.allSlips")).toEqual(["4", "complete"]);
    expect(value(evaluation, "a", "R.slips")).toEqual(["3", "complete"]);
    expect(value(evaluation, "a", "R.slipsWithAmount")).toEqual(["2", "complete"]);
    expect(value(evaluation, "b", "R.slipsWithAmount")).toEqual(["1", "complete"]);
    expect(value(new Evaluation(rules, input({ slips: [] })), "a", "R.allSlips")).toEqual(["0", "complete"]);
  });

  it("counts the issuers of the slips whose box holds an amount, each once, whatever their case or spaces", () => {
    // One and Two have box 1; a second slip from " one " is One again, and Four's box 1 holds 0.
    const again = { id: "s4", person: "a", type: "S", issuer: " one ", boxes: { 1: "5" } };
    const blank = { id: "s5", person: "a", type: "S", issuer: "Four", boxes: { 1: "0" } };
    const evaluation = new Evaluation(rules, input({ slips: [...input().slips, again, blank] }));
    expect(value(evaluation, "a", "R.issuers")).toEqual(["2", "complete"]);
    expect(value(evaluation, "b", "R.issuers")).toEqual(["1", "complete"]);
    // Explained down to each slip, as sum() is.
    const [box] = evaluation.explain("a", "line.R.issuers").inputs;
    expect([box!.label, box!.inputs.map((each) => each.label)]).toEqual(["S box 1: Income", ["S from One", "S from Two", "S from  one ", "S from Four"]]);
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

  it("counts a dependant only from the year they are born", () => {
    const children = (birthDate: string) =>
      new Evaluation(rules, input({ family: { maritalStatus: "married", dependants: [{ id: "d1", name: "Jamie", birthDate }] } })).explain(
        "a",
        "family.childrenUnder18",
      ).value;
    expect(children("2025-12-31")).toBe("1");
    expect(children("2026-01-15")).toBe("0");
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
      family: { maritalStatus: "single", dependants: [] },
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

  it("count only the dependants born by the end of the year", () => {
    // A child born in early 2026 can be added to the profile while the 2025 return is prepared; for 2025 they don't exist yet.
    const evaluation = new Evaluation(
      rules,
      input({
        family: {
          maritalStatus: "married",
          dependants: [
            { id: "c1", name: "Robin", birthDate: "2021-06-01" },
            { id: "c2", name: "Kai", birthDate: "2025-03-15" },
            { id: "c3", name: "Noa", birthDate: "2026-02-10" },
          ],
        },
      }),
    );
    expect(value(evaluation, "a", "R.kids")).toEqual(["2", "complete"]);
    // An unborn child's 0 months would also pull min() down in the young-children credits.
    expect(value(evaluation, "a", "R.youngMonths")).toEqual(["9", "complete"]);
  });

  it("say which family fact is missing", () => {
    const evaluation = new Evaluation(rulesFor(2025)!, {
      year: 2025,
      people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: null }],
      family: { maritalStatus: null, dependants: [] },
      answers: {},
      slips: [],
    });
    expect(evaluation.line("p1", "T1.42000").status).toBe("missing");
    // In no particular order: which fact a formula reads first is the rules' business.
    expect([...evaluation.result().people[0]!.missing].sort((a, b) => a.question.localeCompare(b.question))).toEqual([
      { question: "family.maritalStatus", ask: "Marital status on December 31" },
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
        family: { maritalStatus: "single", dependants: [] },
        answers: { p1: { rrspDeduction: "0" } },
        slips: [{ id: "s1", person: "p1", type: "T4", issuer: "Maple Corp", boxes: { 14: income } }],
      }).line("p1", "T1.30000").value!.toString();
    // (16129 − 14538) × (215648 − 177882) / (253414 − 177882) = 795.5: halfway down.
    expect([at("177882"), at("215648"), at("253414"), at("300000")]).toEqual(["16129", "15333.5", "14538", "14538"]);
  });

  it("count a sale's proceeds (T5008 box 21) less its cost (box 20)", () => {
    const evaluation = alone([{ id: "s1", person: "p1", type: "T5008", issuer: "Pine Securities", boxes: { 20: "10000", 21: "15000" } }]);
    expect(value(evaluation, "p1", "S3.13200")).toEqual(["5000", "complete"]);
    expect(evaluation.line("p1", "T1.12700").value?.toString()).toBe("2500");
  });

  it("say so when a T5008 has no cost, instead of counting all the proceeds as gain", () => {
    const evaluation = alone([{ id: "s1", person: "p1", type: "T5008", issuer: "Pine Securities", boxes: { 21: "15000" } }]);
    expect(value(evaluation, "p1", "S3.13200")).toEqual([null, "missing"]);
    expect(evaluation.result().people[0]!.unhandled).toEqual([expect.stringMatching(/T5008.*cost.*box 20.*Confirm/)]);
  });

  it("deduct an OAS overpayment recovered (T4A(OAS) box 20) on line 23200", () => {
    const pensioner = JSON.parse(readFileSync(resolve(import.meta.dirname, "../golden/ca-2025/pensioner-on.json"), "utf8")).input as EngineInput;
    const recovered = { ...pensioner, slips: pensioner.slips.map((slip) => (slip.type === "T4AOAS" ? { ...slip, boxes: { ...slip.boxes, 20: "1000" } } : slip)) };
    expect(value(new Evaluation(rulesFor(2025)!, pensioner), "p1", "T1.23600")).toEqual(["58300", "complete"]);
    expect(value(new Evaluation(rulesFor(2025)!, recovered), "p1", "T1.23200")).toEqual(["1000", "complete"]);
    expect(value(new Evaluation(rulesFor(2025)!, recovered), "p1", "T1.23600")).toEqual(["57300", "complete"]);
  });

  it("keep an OAS overpayment recovered out of the foreign income the foreign tax credits are on", () => {
    const pensioner = JSON.parse(readFileSync(resolve(import.meta.dirname, "../golden/ca-2025/pensioner-on.json"), "utf8")).input as EngineInput;
    const foreign = { hasForeignIncome: true, foreignInvestmentIncome: "1000", foreignInvestmentTax: "150", foreignEmploymentIncome: "0", foreignEmploymentTax: "0" };
    const withBoxes = (boxes: Record<string, Record<string, string>>) =>
      new Evaluation(rulesFor(2025)!, {
        ...pensioner,
        answers: { p1: { ...pensioner.answers.p1, ...foreign } },
        slips: pensioner.slips.map((slip) => ({ ...slip, boxes: { ...slip.boxes, ...boxes[slip.type] } })),
      });
    // The credits are shared out by net income, so compare with the same net income reached without the overpayment:
    // $2,000 recovered, or $2,000 less from the RRIF.
    const recovered = withBoxes({ T4AOAS: { 20: "2000" } });
    const lessIncome = withBoxes({ T4RIF: { 16: "4000" } });
    expect(value(recovered, "p1", "T1.23600")).toEqual(value(lessIncome, "p1", "T1.23600"));
    expect(value(recovered, "p1", "FTC.netForeign")).toEqual(["1000", "complete"]);
    for (const line of ["T1.40500", "ON428.82"]) {
      expect(value(recovered, "p1", line), line).toEqual(value(lessIncome, "p1", line));
      expect(recovered.line("p1", line).value!.isPositive(), line).toBe(true);
    }
  });

  it("reduce the eligible dependant amounts by the dependant's net income", () => {
    const singleParent = (province: string, answers: Record<string, string>) =>
      new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province }],
        family: { maritalStatus: "single", dependants: [{ id: "d1", name: "Jamie", birthDate: "2017-04-04" }] },
        answers: { p1: answers },
        slips: [t4({ 14: "50000", 22: "7000" })],
      });
    const earned = { dependantNetIncome: "10000" };
    // 16,129 − 10,000; the basic personal amount itself is an estimate until the income questions are answered.
    expect(value(singleParent("ON", earned), "p1", "T1.30400")).toEqual(["6129", "estimate"]);
    expect(value(singleParent("ON", earned), "p1", "ON428.16")).toEqual(["1905", "complete"]);
    expect(value(singleParent("BC", earned), "p1", "BC428.23")).toEqual(["2181", "complete"]);
    expect(value(singleParent("AB", earned), "p1", "AB428.23")).toEqual(["12323", "complete"]);
    // No income: the provincial maximum where there is one.
    expect(value(singleParent("ON", { dependantNetIncome: "0" }), "p1", "ON428.16")).toEqual(["10823", "complete"]);

    const unanswered = singleParent("ON", {});
    expect(value(unanswered, "p1", "T1.30400")).toEqual([null, "missing"]);
    expect(unanswered.result().people[0]!.missing.map((each) => each.question)).toContain("dependantNetIncome");
    // Asked only when the amount applies: not of a couple's return.
    const couple = new Evaluation(rulesFor(2025)!, {
      year: 2025,
      people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "ON" }],
      family: { maritalStatus: "married", dependants: [{ id: "d1", name: "Jamie", birthDate: "2017-04-04" }] },
      answers: { p1: { spouseNetIncome: "0" } },
      slips: [t4({ 14: "50000", 22: "7000" })],
    });
    expect(couple.result().people[0]!.questions).not.toContain("dependantNetIncome");
  });

  it("reduce every other province's and territory's eligible dependant amount by the dependant's net income", () => {
    const singleParent = (province: string, dependantNetIncome: string) =>
      new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province }],
        family: { maritalStatus: "single", dependants: [{ id: "d1", name: "Jamie", birthDate: "2017-04-04" }] },
        answers: { p1: { dependantNetIncome } },
        slips: [t4({ 14: "50000", 22: "7000" })],
      });
    // The line, then the amount with no income (the base, or the maximum where there is one), then with $5,000 (the base
    // less it).
    const amounts: Record<string, [string, string, string]> = {
      MB: ["MB428.16", "9134", "4134"],
      SK: ["SK428.16", "19491", "16440"],
      NB: ["NB428.16", "10499", "6550"],
      NL: ["NL428.23", "9043", "4948"],
      NS: ["NS428.16", "11744", "7618"],
      PE: ["PE428.16", "12443", "8687"],
      NT: ["NT428.16", "17842", "12842"],
      NU: ["NU428.16", "19274", "14274"],
    };
    for (const [province, [line, none, earned]] of Object.entries(amounts)) {
      expect(value(singleParent(province, "0"), "p1", line), province).toEqual([none, "complete"]);
      expect(value(singleParent(province, "5000"), "p1", line), province).toEqual([earned, "complete"]);
    }
    // Never below zero.
    expect(value(singleParent("NT", "20000"), "p1", "NT428.16")).toEqual(["0", "complete"]);
    // Nova Scotia takes off whichever is more, $874 or the dependant's net income (NS428 line 15).
    expect(value(singleParent("NS", "500"), "p1", "NS428.16")).toEqual(["11744", "complete"]);
    expect(value(singleParent("NS", "1000"), "p1", "NS428.16")).toEqual(["11618", "complete"]);
    // Yukon's is line 30400 of the return: the basic personal amount, 16,129, less it.
    expect(value(singleParent("YT", "5000"), "p1", "YT428.12")).toEqual(["11129", "estimate"]);
  });

  it("keep T5 and T4A boxes they don't handle on the slip, and say so", () => {
    const rules2025 = rulesFor(2025)!;
    expect(rules2025.slips.get("T5")!.boxes).toMatchObject({
      14: "Other income from Canadian sources",
      15: "Foreign income",
      16: "Foreign tax paid",
      17: "Royalties from Canadian sources",
    });
    expect(rules2025.slips.get("T4A")!.boxes["048"]).toBe("Fees for services");
    const evaluation = alone([{ id: "s1", person: "p1", type: "T5", issuer: "Northwind Bank", boxes: { 13: "200", 15: "400" } }]);
    expect(evaluation.result().people[0]!.unhandled).toEqual(["T5 from Northwind Bank: box 15 isn't handled by this app"]);
  });

  it("don't report a box they don't handle when it holds zero, as a blank box is entered", () => {
    const unhandled = (box15: string) =>
      alone([{ id: "s1", person: "p1", type: "T5", issuer: "Northwind Bank", boxes: { 13: "200", 15: box15 } }]).result().people[0]!.unhandled;
    expect(unhandled("0")).toEqual([]);
    expect(unhandled("0.00")).toEqual([]);
    expect(unhandled("500")).toEqual(["T5 from Northwind Bank: box 15 isn't handled by this app"]);
  });

  // A spouse's formula reads the other return (`spouse.`), and whatever it reads there is asked on that return. Read
  // the wrong way, a province's own question is asked of a spouse who lives elsewhere, and that return can't be
  // finished until it is answered: Quebec's RL questions on an Ontario return once a Quebec spouse pooled the
  // donations, or Saskatchewan's home renovation question on a Quebec return.
  it("ask a province's own questions only on a return in that province, whatever the spouse's province", () => {
    const couple = JSON.parse(readFileSync(resolve(import.meta.dirname, "../golden/ca-2025/ab-couple.json"), "utf8")).input as EngineInput;
    const ca2025 = rulesFor(2025)!;
    const quebecSlipQuestions = [...ca2025.questions.values()].filter((question) => question.slip?.startsWith("RL")).map((question) => question.id);
    expect(quebecSlipQuestions).toEqual(expect.arrayContaining(["hasRl1", "hasRl2", "hasRl8"]));
    const asked: string[] = [];
    for (const first of PROVINCES) {
      for (const second of PROVINCES) {
        // Both directions of pooling the donations on one return.
        for (const firstClaims of [true, false]) {
          const input = structuredClone(couple);
          input.people[0]!.province = first;
          input.people[1]!.province = second;
          for (const answers of Object.values(input.answers)) Object.assign(answers, { donations: "500", homeRenovationExpenses: "4000" });
          input.answers.p1!.claimSpouseDonations = firstClaims;
          input.answers.p2!.claimSpouseDonations = !firstClaims;
          for (const person of new Evaluation(ca2025, input).result().people) {
            const province = input.people.find((each) => each.id === person.personId)!.province;
            for (const question of person.questions) {
              if ((province !== "QC" && quebecSlipQuestions.includes(question)) || (province !== "SK" && question === "homeRenovationExpenses")) {
                asked.push(`${question} on the ${province} return (the couple: ${first} and ${second})`);
              }
            }
          }
        }
      }
    }
    expect(asked).toEqual([]);
  });

  describe("for a part-year resident", () => {
    // Alex moved to Ontario for the last `days` days of 2025 and earned $100,000 here, after $60,000 abroad (none of it
    // from Canada: the 90% rule isn't met).
    const arrived = (days: string, family: EngineInput["family"], answers: Record<string, string | boolean>, spouse?: EngineInput["people"][number]) =>
      new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "ON", residentAllYear: false }, ...(spouse ? [spouse] : [])],
        family,
        answers: { p1: { daysResident: days, nonResidentIncome: "60000", nonResidentCanadianIncome: "0", ...answers } },
        slips: [t4({ 14: "100000", 22: "20000" })],
      });
    const line = (evaluation: Evaluation, id: string, person = "p1") => evaluation.line(person, id).value?.toString();

    it("prorate the spouse and eligible dependant amounts before taking off the other person's net income", () => {
      // canada.ca, Completing your return for newcomers, Example 3: 100/365 × $16,129 = $4,418.90, less the spouse's
      // $800 on those days. Their return isn't prepared here: $20,800 for the year, and $800 on Alex's days, are asked.
      const couple = arrived("100", { maritalStatus: "married", dependants: [] }, { spouseNetIncome: "20800", spouseIncomeWhileResident: "800" });
      expect([line(couple, "T1.30000"), line(couple, "T1.30300")]).toEqual(["4418.9", "3618.9"]);
      expect([line(couple, "HH.spouseNetIncome"), line(couple, "HH.spouseWorldIncome"), line(couple, "HH.spouseIncomeForCredits")]).toEqual(["20800", "20800", "800"]);
      expect(line(couple, "S5.3")).toBe("4418.9");
      const parent = arrived("100", { maritalStatus: "single", dependants: [{ id: "d1", name: "Jamie", birthDate: "2017-04-04" }] }, { dependantNetIncome: "800" });
      expect(line(parent, "T1.30400")).toBe("3618.9");
      // With an infirm spouse, the $2,687 is prorated too ($736.16), and so are the caregiver amount's $28,798 and
      // $8,601: min(2,356.44, 7,889.86 − 5,000) less the spouse amount of 155.06.
      const infirm = arrived("100", { maritalStatus: "married", dependants: [] }, { spouseNetIncome: "25000", spouseIncomeWhileResident: "5000", spouseInfirm: true });
      expect([line(infirm, "S5.3"), line(infirm, "T1.30300"), line(infirm, "T1.30425")]).toEqual(["5155.06", "155.06", "2201.38"]);
      // Lived here all year: the full amount less their $20,800 for the year, which leaves nothing.
      const resident = new Evaluation(rulesFor(2025)!, { ...couple.input, people: [{ ...couple.input.people[0]!, residentAllYear: true }] });
      expect([line(resident, "T1.30000"), line(resident, "T1.30300")]).toEqual(["16129", "0"]);
    });

    it("prorate the age amount's $9,028 and its $45,522 base, not the net income", () => {
      // canada.ca, Example 2: arrived March 31 (276 days), aged 70, $35,000 of net income: 276/365 of $9,028, less 15%
      // of the income over 276/365 of $45,522.
      const senior = new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1955-02-02", province: "ON", residentAllYear: false }],
        family: { maritalStatus: "single", dependants: [] },
        answers: { p1: { daysResident: "276", nonResidentIncome: "20000", nonResidentCanadianIncome: "0" } },
        slips: [{ id: "s1", person: "p1", type: "T4A", issuer: "Maple Pension Plan", boxes: { "016": "35000" } }],
      });
      expect([line(senior, "T1.23600"), line(senior, "T1.30100")]).toEqual(["35000", "6739.97"]);
    });

    it("don't meet the 90% rule with no world income for the rest of the year", () => {
      const emigrant = JSON.parse(readFileSync(resolve(import.meta.dirname, "../golden/ca-2025/emigrant-bc.json"), "utf8")).input as EngineInput;
      const withIncome = (world: string, canadian: string) =>
        new Evaluation(rulesFor(2025)!, { ...emigrant, answers: { p1: { ...emigrant.answers.p1, nonResidentIncome: world, nonResidentCanadianIncome: canadian } } });
      // RC4018, Appendix K: none at all isn't 90% from Canada, so the amounts are prorated by the 273 days.
      expect([line(withIncome("0", "0"), "RES.full"), line(withIncome("0", "0"), "T1.30000")]).toEqual(["0", "12063.61"]);
      expect([line(withIncome("4000", "3600"), "RES.full"), line(withIncome("4000", "3600"), "T1.30000")]).toEqual(["1", "16129"]);
      expect(line(withIncome("4000", "3500"), "RES.full")).toBe("0");
    });

    it("prorate the amounts transferred from a spouse and from a child", () => {
      // Here for 183 days; the spouse, 67 and resident all year, had no income.
      const spouse = { id: "p2", name: "Robin", role: "spouse", birthDate: "1958-05-01", province: "ON", residentAllYear: true } as const;
      const couple = arrived("183", { maritalStatus: "married", dependants: [] }, { childTuitionTransfer: "5000" }, spouse);
      // Their unused age amount, $9,028, is the whole Schedule 2; line 32600 gets 183/365 of it.
      expect([line(couple, "S2.13"), line(couple, "T1.32600")]).toEqual(["9028", "4526.37"]);
      expect(line(couple, "T1.32400")).toBe("2506.85");
    });

    it("take off a part-year spouse's net income for the days you lived in Canada", () => {
      // Robin's days in Canada (all year without them), income while not resident (`canadian` of it from Canada, so on
      // their T4 too) and T4. Alex earned $100,000 in Ontario, there all year unless `days` says otherwise.
      type Robin = { days?: string; abroad?: string; canadian?: string; t4: string };
      const couple = (robin: Robin, alex: { days?: string; answers?: Record<string, string | boolean> } = {}) =>
        new Evaluation(rulesFor(2025)!, {
          year: 2025,
          people: [
            { id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "ON", residentAllYear: alex.days === undefined },
            { id: "p2", name: "Robin", role: "spouse", birthDate: "1987-09-15", province: "ON", residentAllYear: robin.days === undefined },
          ],
          family: { maritalStatus: "married", dependants: [] },
          answers: {
            p1: { ...(alex.days === undefined ? {} : { daysResident: alex.days, nonResidentIncome: "30000", nonResidentCanadianIncome: "0" }), ...alex.answers },
            p2: robin.days === undefined ? {} : { daysResident: robin.days, nonResidentIncome: robin.abroad ?? "0", nonResidentCanadianIncome: robin.canadian ?? "0" },
          },
          slips: [t4({ 14: "100000", 22: "20000" }), { id: "s2", person: "p2", type: "T4", issuer: "Birch Books", boxes: { 14: robin.t4 } }],
        });
      const asked = (evaluation: Evaluation) =>
        evaluation.result().people[0]!.questions.filter((id) => id === "spouseSameDays" || id === "spouseIncomeWhileResident");

      // Alex lived in Ontario all year, so Robin's net world income for 2025 comes off (canada.ca, Completing your return
      // for newcomers). Arrived September 1 after $40,000 abroad: no spouse amount, federal or Ontario's.
      const resident = couple({ days: "122", abroad: "40000", t4: "0" });
      expect([line(resident, "T1.30300"), line(resident, "ON428.13")]).toEqual(["0", "0"]);
      expect(asked(resident)).toEqual([]);
      // Arrived October 1, with an $8,000 T4: $6,000 of it earned in Canada before, which isn't counted twice.
      const commuter = couple({ days: "92", abroad: "6000", canadian: "6000", t4: "8000" });
      expect([line(commuter, "HH.spouseWorldIncome"), line(commuter, "T1.30300")]).toEqual(["8000", "8129"]);

      // Both moved: same days or not is asked. Example 3, arrived together for the last 100 days, Robin with $800 here
      // after $20,000 abroad: the $800 of those days (the T1 still shows the $20,800 of the year).
      const together = (robin: Robin, answers: Record<string, string | boolean>) => couple(robin, { days: "100", answers });
      const example3 = together({ days: "100", abroad: "20000", t4: "800" }, { spouseSameDays: true });
      expect([line(example3, "HH.spouseIncomeForCredits"), line(example3, "T1.30300"), line(example3, "HH.spouseWorldIncome")]).toEqual(["800", "3618.9", "20800"]);
      // On the same days, their Canadian income from before arriving isn't in yours: $8,000 less $6,000.
      expect(line(together({ days: "92", abroad: "6000", canadian: "6000", t4: "8000" }, { spouseSameDays: true }), "HH.spouseIncomeForCredits")).toBe("2000");
      // Alex left after 100 days, January 1 to April 10, and Robin arrived for the last 100: as many days, but other
      // days. Robin's $20,000 abroad was earned while Alex lived here, so there is no spouse amount.
      const opposite = together({ days: "100", abroad: "20000", t4: "800" }, { spouseSameDays: false });
      expect(line(opposite, "T1.30300")).toBeUndefined();
      expect(asked(opposite)).toEqual(["spouseSameDays", "spouseIncomeWhileResident"]);
      const answered = together({ days: "100", abroad: "20000", t4: "800" }, { spouseSameDays: false, spouseIncomeWhileResident: "20000" });
      expect([line(answered, "T1.30300"), line(answered, "ON428.13")]).toEqual(["0", "0"]);
      // Alex moved and Robin lived here all year: only the income on Alex's days is asked.
      const stayed = couple({ t4: "30000" }, { days: "100", answers: { spouseIncomeWhileResident: "2000" } });
      expect([line(stayed, "T1.30300"), asked(stayed)]).toEqual(["2418.9", ["spouseIncomeWhileResident"]]);
    });
  });

  describe("for the Canada workers benefit", () => {
    const worker = (province: string, income: string, options: { dependant?: boolean; disability?: boolean } = {}) =>
      new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province }],
        family: { maritalStatus: "single", dependants: options.dependant ? [{ id: "d1", name: "Jamie", birthDate: "2017-04-04" }] : [] },
        answers: { p1: { hasDisability: options.disability ?? false, dependantNetIncome: "0" } },
        slips: [t4({ 14: income })],
      });
    const cwb = (evaluation: Evaluation) => ["CWB.basic", "CWB.disability"].map((id) => evaluation.line("p1", id).value?.toString());

    it("use Alberta's and Nunavut's own amounts and rates", () => {
      // 5009-S6: (5,000 − 2,760) × 21%; with the disability tax credit, (5,000 − 910) × 26%, up to $843.
      expect(cwb(worker("AB", "5000"))).toEqual(["470.4", "0"]);
      expect(cwb(worker("AB", "5000", { disability: true }))).toEqual(["470.4", "843"]);
      // With a dependant: (20,000 − 2,760) × 21%, up to $2,619.
      expect(cwb(worker("AB", "20000", { dependant: true }))).toEqual(["2619", "0"]);
      // 5014-S6: nothing up to $6,000 of working income; then 14%, up to $1,621 single and $2,435 with a dependant,
      // less 4% (single) or 8% of adjusted family net income over $26,832 or $36,927.
      expect(cwb(worker("NU", "5000"))).toEqual(["0", "0"]);
      expect(cwb(worker("NU", "30000", { dependant: true }))).toEqual(["2435", "0"]);
      expect(worker("NU", "40000").line("p1", "T1.23600").value?.toString()).toBe("40000");
      expect(cwb(worker("NU", "40000"))).toEqual(["1094.28", "0"]);
      expect(cwb(worker("NU", "45000", { dependant: true }))).toEqual(["1789.16", "0"]);
      // Its disability supplement: 26% over $4,800, up to $936, less 12% of the income over $67,357.
      expect(cwb(worker("NU", "70000", { disability: true }))).toEqual(["0", "618.84"]);
      // Elsewhere, 5000-S6: (5,000 − 3,000) × 27%.
      expect(cwb(worker("ON", "5000"))).toEqual(["540", "0"]);
    });

    it("count a spouse who wasn't resident all year as no eligible spouse", () => {
      const couple = new Evaluation(rulesFor(2025)!, {
        year: 2025,
        people: [
          { id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "ON" },
          { id: "p2", name: "Robin", role: "spouse", birthDate: "1987-09-15", province: "ON", residentAllYear: false },
        ],
        family: { maritalStatus: "married", dependants: [] },
        answers: { p1: {}, p2: { daysResident: "180", nonResidentIncome: "10000", nonResidentCanadianIncome: "0" } },
        slips: [t4({ 14: "20000" })],
      });
      // Income Tax Act 122.7(1): an eligible spouse was resident in Canada throughout the year. Alex claims as a single
      // person: (20,000 − 3,000) × 27%, up to $1,633, and no family amounts.
      expect(couple.line("p1", "CWB.spouse").value?.toString()).toBe("0");
      expect(cwb(couple)).toEqual(["1633", "0"]);
      expect(couple.line("p2", "CWB.eligible").value?.toString()).toBe("0");
    });

    it("ask for the spouse's return when both of you might be eligible for the disability tax credit", () => {
      const couple = (province: string, income: string, spouseNetIncome: string, hasDisability: boolean) =>
        new Evaluation(rulesFor(2025)!, {
          year: 2025,
          people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province }],
          family: { maritalStatus: "married", dependants: [] },
          answers: { p1: { hasDisability, spouseNetIncome } },
          slips: [t4({ 14: income })],
        });
      // Alex, with the credit, earned $30,000 and the spouse $45,000: their family net income is at least 75,000 − 16,386
      // = 58,614, under 5009-S6's $61,472 for two spouses with the credit, so the supplement depends on the spouse's return.
      const alberta = couple("AB", "30000", "45000", true);
      expect(alberta.line("p1", "T1.45300")).toEqual({ value: null, status: "missing" });
      expect(alberta.result().people[0]!.unhandled).toContainEqual(expect.stringMatching(/prepare their return here too/));
      // Nunavut's limit is $82,965 (at least 95,000 − 16,386 = 78,614), 5000-S6's $60,629.
      expect(couple("NU", "45000", "50000", true).line("p1", "T1.45300").value).toBeNull();
      expect(couple("ON", "30000", "45000", true).line("p1", "T1.45300").value).toBeNull();
      // Without the credit only the basic CWB's limit counts, $50,232 in Alberta: nothing to get, whatever the spouse's return.
      expect(couple("AB", "30000", "45000", false).line("p1", "T1.45300").value?.toString()).toBe("0");
    });
  });

  describe("on the Quebec return", () => {
    const employee = JSON.parse(readFileSync(resolve(import.meta.dirname, "../golden/ca-2025/single-employee-qc.json"), "utf8")).input as EngineInput;
    const withSlips = (...slips: [string, Record<string, string>][]) =>
      new Evaluation(rulesFor(2025)!, {
        ...employee,
        slips: [...employee.slips, ...slips.map(([type, boxes], index) => ({ id: `x${index}`, person: "p1", type, issuer: "Rivière Payer", boxes }))],
      });

    it("ask for the RL slip issued with each T-slip, instead of leaving its income out", () => {
      // Each T-slip the federal return reads, the RL slip the TP-1 reads instead, and what the return asks for without it.
      const pairs: [[string, Record<string, string>], [string, Record<string, string>], RegExp][] = [
        [["T5", { 13: "450", 24: "1000", 25: "1380", 26: "207.27" }], ["RL3", { A1: "1000", B: "1380", C: "169.33", D: "450" }], /T5 slips \(box 13\) is more than box D of your RL-3/],
        [["T5", { 10: "200", 11: "230", 12: "20.77" }], ["RL3", { A2: "200", B: "230", C: "16.27" }], /T5 slips \(boxes 11 and 25\) are more than box B of your RL-3/],
        [["T5", { 18: "640" }], ["RL3", { I: "640" }], /T5 slips \(box 18\) are more than box I of your RL-3/],
        [["T3", { 21: "2000", 26: "300" }], ["RL16", { A: "2000", G: "300" }], /T3 slips \(box 21\) are more than box A of your RL-16/],
        [["T3", { 26: "300" }], ["RL16", { G: "300" }], /T3 slips \(box 26\) is more than box G of your RL-16/],
        [["T3", { 49: "500", 50: "690", 51: "103.64" }], ["RL16", { C1: "500", I: "690", J: "80.78" }], /T3 slips \(boxes 32 and 50\) are more than box I of your RL-16/],
        [["T3", { 25: "400" }], ["RL16", { F: "400" }], /T3 slips \(box 25\) is more than boxes E and F of your RL-16/],
        [["T4A", { "016": "20000", "022": "3000" }], ["RL2", { A: "20000", J: "3000" }], /more pension, annuity, RRSP and RRIF payments .* than boxes A, B and C of your RL-2/],
        // A pension plan's lump sum: box C of the RL-2.
        [["T4A", { "018": "5000" }], ["RL2", { C: "5000" }], /than boxes A, B and C of your RL-2/],
        [["T4RSP", { 22: "3000", 30: "300" }], ["RL2", { C: "3000", J: "450" }], /than boxes A, B and C of your RL-2/],
        [["T4RIF", { 16: "5000" }], ["RL2", { B: "5000" }], /than boxes A, B and C of your RL-2/],
        // Tuition at a university outside Quebec, which issues no RL-8: the Quebec tuition credit can't be worked out.
        [["T2202", { 25: "8", 26: "6000" }], ["RL8", { B: "6000" }], /RL-8 with each T2202: upload it.*school outside Quebec/],
      ];
      for (const [slip, rl, asks] of pairs) {
        const without = withSlips(slip);
        expect(without.line("p1", "TP1.478"), slip[0]).toEqual({ value: null, status: "missing" });
        expect(without.result().people[0]!.unhandled, slip[0]).toContainEqual(expect.stringMatching(asks));
        expect(withSlips(slip, rl).line("p1", "TP1.478").status, slip[0]).toBe("complete");
      }
      // A slip with no RL slip of its own: the TP-1 reads the T-slip (CPP from Service Canada, OAS, EI).
      const federalOnly = withSlips(["T4AP", { 14: "6000", 20: "6000" }], ["T4AOAS", { 18: "8000", 19: "8000" }], ["T4E", { 14: "1500", 15: "1500" }]);
      expect(federalOnly.line("p1", "TP1.478").status).toBe("complete");
      expect(value(federalOnly, "p1", "TP1.119")).toEqual(["6000", "complete"]);
      // Social assistance: the T5007 when no RL-5 came (guide, line 147), but not some slips one way and some the other.
      expect(value(withSlips(["T5007", { 11: "1200" }]), "p1", "TP1.147")).toEqual(["1200", "complete"]);
      expect(value(withSlips(["T5007", { 11: "1200" }], ["RL5", { A: "1100" }]), "p1", "TP1.147")).toEqual(["1100", "complete"]);
      const mixed = withSlips(["T5007", { 11: "1200" }], ["T5007", { 11: "800" }], ["RL5", { A: "1200" }]);
      expect(mixed.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(mixed.result().people[0]!.unhandled).toContainEqual(expect.stringMatching(/T5007 slips \(box 11\) is more than boxes A and B of your RL-5/));
    });

    it("compare a T-slip's amounts with its RL slip's, not how many boxes each has", () => {
      const scope = (evaluation: Evaluation) => evaluation.explain("p1", "line.QC.scope").notes ?? [];
      // A box AI couldn't read, entered as 0: nothing for the RL-3 to carry.
      const blankBox = withSlips(["T5", { 11: "0", 13: "450" }], ["RL3", { D: "450" }]);
      expect(scope(blankBox)).toEqual([]);
      expect(value(blankBox, "p1", "TP1.130")).toEqual(["450", "complete"]);
      // Two T5s from one bank, on one RL-3.
      const twoSlips = withSlips(["T5", { 13: "120" }], ["T5", { 13: "80" }], ["RL3", { D: "200" }]);
      expect(value(twoSlips, "p1", "TP1.130")).toEqual(["200", "complete"]);
      expect(twoSlips.line("p1", "TP1.478").status).toBe("complete");
      // ... but one of two T5s without its RL-3 still holds the return.
      expect(withSlips(["T5", { 13: "120" }], ["T5", { 13: "80" }], ["RL3", { D: "120" }]).line("p1", "TP1.478").status).toBe("missing");
      // Box B grosses up both kinds of dividend at once: a cent under the T5's boxes 11 and 25 is rounding.
      const rounded = withSlips(["T5", { 10: "333.33", 11: "383.33", 24: "333.33", 25: "460" }], ["RL3", { A1: "333.33", A2: "333.33", B: "843.32" }]);
      expect(scope(rounded)).toEqual([]);
      // A CEGEP's RL-8 can show no tuition (box B) beside the T2202's: the Quebec amount is the RL-8's.
      const cegep = withSlips(["T2202", { 25: "8", 26: "350" }], ["RL8", { A: "3000" }]);
      expect(cegep.line("p1", "TP1.478").status).toBe("complete");
      expect(value(cegep, "p1", "QCT.41")).toEqual(["0", "complete"]);
      // A second T4 with box 14 entered as 0 and no RL-1 adds no employment income to carry.
      expect(scope(withSlips(["T4", { 14: "0", 22: "0" }]))).toEqual([]);
      // An RRSP refund goes on the RL-2 in a box this app doesn't read: not handled, even with the RL-2 there.
      const refund = withSlips(["T4RSP", { 20: "2000", 30: "200" }], ["RL2", { J: "300" }]);
      expect(refund.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(refund)).toEqual([expect.stringMatching(/boxes 18, 20, 26, 28 and 34 of the T4RSP.*aren't handled/)]);
      expect(scope(refund)[0]).not.toMatch(/upload/);
    });

    it("count the T4s and T2202s that hold an amount against their RL slips, where Quebec's amount differs by law", () => {
      const scope = (evaluation: Evaluation) => evaluation.explain("p1", "line.QC.scope").notes ?? [];
      // The Quebec job's RL-1 shows $2,000 more than its T4 (group insurance is taxable in Quebec): that alone is fine.
      const quebecJob = employee.slips.map((slip) => (slip.type === "RL1" ? { ...slip, boxes: { ...slip.boxes, A: "64000" } } : slip));
      const evaluate = (slips: EngineInput["slips"], answers: Record<string, string> = {}) =>
        new Evaluation(rulesFor(2025)!, { ...employee, slips, answers: { ...employee.answers, p1: { ...employee.answers.p1, ...answers } } });
      // Where box 14 is more than box A less box J, the benefits Quebec doesn't tax are asked; none here.
      const none = { qcExemptBenefits: "0" };
      expect(scope(evaluate(quebecJob))).toEqual([]);
      // A $1,500 T4 from an Ottawa job has no RL-1: the amounts (63,500 against 64,000) would hide it, the slips don't.
      const ottawa = { id: "x0", person: "p1", type: "T4", issuer: "Rideau Outfitters", boxes: { 14: "1500", 22: "150", 24: "1500", 26: "1500", 56: "1500" } };
      const twoJobs = evaluate([...quebecJob, ottawa]);
      expect(twoJobs.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(twoJobs)).toEqual([expect.stringMatching(/More employers gave you a T4 .* issues an RL-1 with each T4: upload it/)]);
      // One employer's two T4s (two EI categories) under the one RL-1 that covers both: one employer, one RL-1.
      const slip = (id: string, type: string, issuer: string, boxes: Record<string, string>) => ({ id, person: "p1", type, issuer, boxes });
      const t4 = (id: string, issuer: string, income: string, qpp: string, ei: string, ppip: string) =>
        slip(id, "T4", issuer, { 14: income, 17: qpp, 18: ei, 22: "0", 24: income, 26: income, 55: ppip, 56: income });
      const rl1 = employee.slips.find((each) => each.type === "RL1")!;
      const twoCategories = evaluate([
        t4("e1", "Érable Conseil inc.", "20000", "1056", "262", "98.80"),
        t4("e2", " érable conseil inc. ", "42000", "2688", "550.20", "207.48"),
        rl1,
      ]);
      expect(scope(twoCategories)).toEqual([]);
      expect(twoCategories.line("p1", "TP1.478").status).toBe("complete");
      // One employer's RL-1 for each payroll account, and only the $20,000 one uploaded: $42,000 would be left out.
      // Box 14 short: the message sends back to the Income question first. Box A above box 14 on fewer RL-1s: its own.
      const needsRl1 = [expect.stringMatching(/First check “Benefits on your T4 slips that Quebec doesn't tax” on the Income step/)];
      const sameShortPay = [expect.stringMatching(/one RL-1 covers several T4s from one employer only when it carries the same pay/)];
      const twoAccounts = evaluate([
        t4("e1", "Érable Conseil inc.", "20000", "1056", "262", "98.80"),
        t4("e2", "Érable Conseil inc.", "42000", "2688", "550.20", "207.48"),
        slip("e3", "RL1", "Érable Conseil inc.", { A: "20000", B_A: "1056", G: "20000", H: "98.80", I: "20000" }),
      ], none);
      expect(twoAccounts.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(twoAccounts)).toEqual(needsRl1);
      // Moved by the employer from Montréal to Ottawa: a T4 for each province, and an RL-1 for the Quebec part only.
      const moved = evaluate([
        t4("e1", "Érable Conseil inc.", "30000", "1696", "393", "148.20"),
        slip("e2", "T4", "Érable Conseil inc.", { 14: "20000", 16: "0", 22: "0", 24: "20000", 26: "20000", 56: "20000" }),
        slip("e3", "RL1", "Érable Conseil inc.", { A: "30500", B_A: "1696", G: "30000", H: "148.20", I: "30000" }),
      ], none);
      expect(scope(moved)).toEqual(needsRl1);
      // An Ottawa employer's RL-1 for its Quebec-taxable health plan benefit alone (boxes A and J), beside its T4 for the
      // job in Ontario: one employer on each side, but box A covers $2,000 of the $62,000. The benefits Quebec doesn't
      // tax are asked, and $1,800 of them doesn't explain $62,000.
      const ontarioJob = [t4("e1", "Rideau Outfitters", "62000", "0", "1020.80", "0"), slip("e2", "RL1", "Rideau Outfitters", { A: "2000", J: "2000" })];
      expect(evaluate(ontarioJob).result().people[0]!.missing.map((each) => each.question)).toContain("qcExemptBenefits");
      const benefitOnly = evaluate(ontarioJob, { qcExemptBenefits: "1800" });
      expect(benefitOnly.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(benefitOnly)).toEqual([expect.stringMatching(/don't cover the employment income .* an RL-1 for a health plan benefit only/)]);
      // The private health plan benefit (box J) is inside box A but never in box 14: a Quebec employee's RL-1 shows it
      // on top of the T4's pay ...
      const healthPlan = slip("e9", "RL1", "Érable Conseil inc.", { A: "62000", B_A: "3584", G: "60000", H: "296.40", I: "60000", J: "2000" });
      const quebecEmployee = evaluate([t4("e1", "Érable Conseil inc.", "60000", "3584", "786", "296.40"), healthPlan]);
      expect(scope(quebecEmployee)).toEqual([]);
      expect(quebecEmployee.line("p1", "TP1.478").status).toBe("complete");
      // ... so it can't hide the RL-1 of the employer's second payroll account, left out: $61,000 of pay against $60,000.
      const secondAccount = evaluate([
        t4("e1", "Érable Conseil inc.", "60000", "3584", "786", "296.40"),
        t4("e2", "Érable Conseil inc.", "1000", "0", "13.10", "4.94"),
        healthPlan,
      ], none);
      expect(secondAccount.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(secondAccount)).toEqual(needsRl1);
      // Tips the restaurant allocated (box T) are in box A but not in box 14, and box T isn't read: they could hide the
      // second payroll account's RL-1, left out ($41,000 of pay against $42,000), but more T4s than RL-1s need the same pay.
      const tips = slip("e8", "RL1", "Bistro Fleuve inc.", { A: "42000", B_A: "2464", G: "42000", H: "207.48", I: "42000" });
      const restaurant = evaluate([
        t4("e1", "Bistro Fleuve inc.", "40000", "2336", "524", "197.60"),
        t4("e2", "Bistro Fleuve inc.", "1000", "0", "13.10", "4.94"),
        tips,
      ]);
      expect(restaurant.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(restaurant)).toEqual(sameShortPay);
      // One RL-1 for two T4s (two EI categories) with the health plan benefit beside the pay: $64,000 less $2,000.
      const consolidatedWithJ = evaluate([
        t4("e1", "Érable Conseil inc.", "20000", "1056", "262", "98.80"),
        t4("e2", "Érable Conseil inc.", "42000", "2688", "550.20", "207.48"),
        slip("e3", "RL1", "Érable Conseil inc.", { A: "64000", B_A: "3744", G: "62000", H: "306.28", I: "62000", J: "2000" }),
      ]);
      expect(scope(consolidatedWithJ)).toEqual([]);
      expect(consolidatedWithJ.line("p1", "TP1.478").status).toBe("complete");
      // The same with $2,000 of allocated tips instead: the price of closing the gap above, and the safer failure.
      const consolidatedWithTips = evaluate([
        t4("e1", "Bistro Fleuve inc.", "20000", "1056", "262", "98.80"),
        t4("e2", "Bistro Fleuve inc.", "42000", "2688", "550.20", "207.48"),
        slip("e3", "RL1", "Bistro Fleuve inc.", { A: "64000", B_A: "3744", G: "64000", H: "306.28", I: "64000" }),
      ]);
      expect(scope(consolidatedWithTips)).toEqual([expect.stringMatching(/one RL-1 covers several T4s from one employer only when it carries the same pay/)]);
      // Two employers, each with its T4 and its RL-1; and a T4 whose box 14 holds 0, with no RL-1, adds no employer.
      const second = [t4("e3", "Bois Franc ltée", "8000", "288", "104.80", "39.52"), slip("e4", "RL1", "Bois Franc ltée", { A: "8000", B_A: "288", G: "8000", H: "39.52", I: "8000" })];
      expect(scope(evaluate([...employee.slips, ...second]))).toEqual([]);
      expect(scope(evaluate([...employee.slips, t4("e5", "Rideau Outfitters", "0", "0", "0", "0")]))).toEqual([]);
      // A Quebec university's T2202 and RL-8, and an Ontario university's T2202, which comes with no RL-8.
      const quebecSchool = [slip("u1", "T2202", "Université du Fleuve", { 25: "8", 26: "3000" }), slip("u2", "RL8", "Université du Fleuve", { A: "2400", B: "3000" })];
      const twoSchools = evaluate([...employee.slips, ...quebecSchool, slip("u3", "T2202", "Rideau University", { 24: "4", 26: "6000" })]);
      expect(twoSchools.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(twoSchools)).toEqual([expect.stringMatching(/More schools gave you a T2202 with tuition \(box 26\) than gave you an RL-8/)]);
      // One school's two T2202s (two programs) under its one RL-8 for the year, whose Quebec tuition can be lower.
      expect(scope(evaluate([...employee.slips, ...quebecSchool, slip("u4", "T2202", "Université du Fleuve", { 24: "4", 26: "900" })]))).toEqual([]);
      // $350 and $200 of tuition on two T2202s, $500 on the RL-8 (medical-service fees aren't Quebec tuition).
      const lowerQuebec = evaluate([
        ...employee.slips,
        slip("u5", "T2202", "Cégep du Fleuve", { 24: "4", 26: "350" }),
        slip("u6", "T2202", "Cégep du Fleuve", { 24: "4", 26: "200" }),
        slip("u7", "RL8", "Cégep du Fleuve", { B: "500" }),
      ]);
      expect(scope(lowerQuebec)).toEqual([]);
      expect(lowerQuebec.line("p1", "TP1.478").status).toBe("complete");
      expect(value(lowerQuebec, "p1", "QCT.41")).toEqual(["500", "complete"]);
      // A box entered as 0 isn't an amount the RL slip must carry: an RL-5 for a childcare allowance alone leaves the
      // T5007's social assistance on line 147, and an RL-2 without QPP leaves the T4A(P)'s CPP on line 119.
      const allowance = withSlips(["T5007", { 11: "1200" }], ["RL5", { A: "0", J: "500" }]);
      expect(value(allowance, "p1", "TP1.147")).toEqual(["1200", "complete"]);
      expect(scope(allowance)).toEqual([]);
      const cpp = withSlips(["T4A", { "016": "20000" }], ["RL2", { A: "20000", C_QPP: "0" }], ["T4AP", { 14: "6000", 20: "6000" }]);
      expect(value(cpp, "p1", "TP1.119")).toEqual(["6000", "complete"]);
    });

    it("ask for the benefits Quebec doesn't tax when the T4s show more than the RL-1s, and take them off box 14", () => {
      const scope = (evaluation: Evaluation) => evaluation.explain("p1", "line.QC.scope").notes ?? [];
      const evaluate = (slips: EngineInput["slips"], answers: Record<string, string> = {}) =>
        new Evaluation(rulesFor(2025)!, { ...employee, slips, answers: { ...employee.answers, p1: { ...employee.answers.p1, ...answers } } });
      const slip = (id: string, type: string, boxes: Record<string, string>) => ({ id, person: "p1", type, issuer: "Érable Conseil inc.", boxes });
      const t4 = (id: string, income: string, qpp: string, ei: string, ppip: string) =>
        slip(id, "T4", { 14: income, 17: qpp, 18: ei, 22: "0", 24: income, 26: income, 55: ppip, 56: income });
      const none = { qcExemptBenefits: "0" };
      // $62,000 of salary and $1,800 of transit passes the employer paid: taxed federally (box 14), not in Quebec (box A).
      const rl1 = slip("e2", "RL1", { A: "62000", B_A: "3744", G: "62000", H: "306.28", I: "62000" });
      const transit = [t4("e1", "63800", "3744", "812.20", "306.28"), rl1];
      const unanswered = evaluate(transit);
      expect(unanswered.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(unanswered.result().people[0]!.missing).toContainEqual({ question: "qcExemptBenefits", ask: "Benefits on your T4 slips that Quebec doesn't tax" });
      expect(scope(unanswered)).toEqual([]);
      const passes = evaluate(transit, { qcExemptBenefits: "1800" });
      expect(scope(passes)).toEqual([]);
      expect(passes.line("p1", "TP1.478").status).toBe("complete");
      expect(value(passes, "p1", "TP1.101")).toEqual(["62000", "complete"]);
      // It must be the difference exactly: none, less, more, or more than box 14 send back to the Income step.
      const checkIncome = [expect.stringMatching(/First check “Benefits on your T4 slips that Quebec doesn't tax” on the Income step: .* enter exactly the difference/)];
      for (const entered of ["0", "1000", "2000", "70000"]) {
        const wrong = evaluate(transit, { qcExemptBenefits: entered });
        expect(wrong.line("p1", "TP1.478"), entered).toEqual({ value: null, status: "missing" });
        expect(scope(wrong), entered).toEqual(checkIncome);
      }
      // An answer left from an earlier gap: the T4 was amended to $62,000, then the employer's second payroll account's
      // $1,500 T4 came without its RL-1. $1,800 doesn't explain the new $1,500.
      const dormant = evaluate([t4("e1", "62000", "3744", "812.20", "306.28"), t4("e8", "1500", "0", "19.65", "7.41"), rl1], { qcExemptBenefits: "1800" });
      expect(dormant.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(dormant)).toEqual(checkIncome);
      // Equipment reimbursed for working from home is taxed in Quebec too (in box A), so the help doesn't name it: an
      // employer's $63,000 T4 and RL-1 that both hold $1,000 of it, beside a second payroll account's $1,000 T4 with no
      // RL-1, stay refused when the help is followed.
      const equipment = evaluate([t4("e1", "63000", "3744", "812.20", "306.28"), t4("e9", "1000", "0", "13.10", "4.94"), slip("e2", "RL1", { A: "63000", G: "63000" })], none);
      expect(equipment.line("p1", "TP1.478")).toEqual({ value: null, status: "missing" });
      expect(scope(equipment)).toEqual(checkIncome);
      // One RL-1 for two T4s (two EI categories), the passes on one of them: the same pay once they're taken off.
      const consolidated = evaluate([t4("e3", "21800", "1056", "285.58", "107.69"), t4("e4", "42000", "2688", "550.20", "207.48"), rl1], { qcExemptBenefits: "1800" });
      expect(scope(consolidated)).toEqual([]);
      expect(consolidated.line("p1", "TP1.478").status).toBe("complete");
      // Slips that agree never ask it, nor do slips refused before the amounts matter (box A above box 14 on one RL-1 for
      // two T4s, as with allocated tips).
      expect(new Evaluation(rulesFor(2025)!, employee).result().people[0]!.questions).not.toContain("qcExemptBenefits");
      const tips = evaluate([t4("e5", "40000", "2336", "524", "197.60"), t4("e6", "1000", "0", "13.10", "4.94"), slip("e7", "RL1", { A: "42000", G: "42000" })]);
      expect(tips.result().people[0]!.questions).not.toContain("qcExemptBenefits");
      expect(scope(tips)).toEqual([expect.stringMatching(/If every RL-1 is here, .*allocated tips in box T.*which this app doesn't handle yet/)]);
    });

    it("deduct the social benefits repayment on line 250, and its EI part from the health services fund income", () => {
      const laidOff = withSlips(["T4E", { 7: "30", 14: "30000", 15: "30000" }]);
      // Federal line 23500: 30% of net income over $82,125 ($90,815), less than 30% of the benefits.
      expect(value(laidOff, "p1", "T1.23500")).toEqual(["2607", "complete"]);
      expect(value(laidOff, "p1", "TP1.250")).toEqual(["2607", "complete"]);
      // 62,000 + 30,000, less 1,420 for workers, 585 of QPP and the repayment.
      expect(value(laidOff, "p1", "TP1.275")).toEqual(["87388", "complete"]);
      // Schedule F, line 44: the $30,000 of EI less the $2,607 repaid, over $18,130, at 1%.
      expect(value(laidOff, "p1", "QCF.70")).toEqual(["27393", "complete"]);
      expect(value(laidOff, "p1", "TP1.446")).toEqual(["92.63", "complete"]);
    });

    it("refuse a slip box whose amount belongs on a TP-1 line they don't handle, instead of leaving it out", () => {
      const withT4 = (boxes: Record<string, string>) =>
        new Evaluation(rulesFor(2025)!, {
          ...employee,
          slips: employee.slips.map((slip) => (slip.type === "T4" ? { ...slip, boxes: { ...slip.boxes, ...boxes } } : slip)),
        });
      const cases: [string, Evaluation, RegExp][] = [
        ["scholarships", withSlips(["T4A", { 105: "4000" }]), /Scholarships and bursaries \(box 105 of the T4A\).*line 154, point 1.*line 295/],
        ["other income", withSlips(["T4A", { "028": "900" }]), /Other income on a T4A \(box 028\).*line 154, point 3/],
        ["RDSP income", withSlips(["T4A", { 131: "2500" }]), /RDSP \(box 131 of the T4A\).*line 278/],
        ["an FHSA withdrawal", withSlips(["T4FHSA", { 22: "5000", 30: "500" }]), /Taxable FHSA amounts.*line 154, point 19/],
        ["workers' compensation", withSlips(["T5007", { 10: "7000" }]), /Workers' compensation \(box 10 of the T5007\).*line 148.*line 295/],
        ["security options", withT4({ 39: "1500" }), /security option deduction \(boxes 39 and 41 of the T4\).*line 297, point 2/],
        ["the Canadian Forces deduction", withT4({ 43: "2000" }), /Canadian Forces personnel and police deduction.*line 297, point 23/],
      ];
      for (const [label, evaluation, says] of cases) {
        expect(evaluation.line("p1", "TP1.478"), label).toEqual({ value: null, status: "missing" });
        expect(evaluation.result().people[0]!.unhandled, label).toContainEqual(expect.stringMatching(says));
      }
      // Contributions to an FHSA alone are deducted as on the federal return (line 215).
      expect(withSlips(["T4FHSA", { 18: "8000" }]).line("p1", "TP1.478").status).toBe("complete");
    });

    it("deduct EI benefits repaid (T4E box 30) on line 246, as the federal return does on line 23200", () => {
      const repaid = withSlips(["T4E", { 14: "30000", 15: "30000", 30: "1000" }]);
      expect(value(repaid, "p1", "T1.23200")).toEqual(["1000", "complete"]);
      expect(value(repaid, "p1", "TP1.246")).toEqual(["1000", "complete"]);
      // 62,000 + 30,000, less 1,420 for workers, 585 of QPP and the $1,000 repaid.
      expect(value(repaid, "p1", "TP1.275")).toEqual(["88995", "complete"]);
      // Schedule F, line 41: the $30,000 of EI less the $1,000 repaid, over $18,130, at 1%.
      expect(value(repaid, "p1", "TP1.446")).toEqual(["108.7", "complete"]);
    });
  });
});
