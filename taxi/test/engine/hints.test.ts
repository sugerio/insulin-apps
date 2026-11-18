import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { findHints } from "../../src/app/shared/engine/hints.ts";
import { RuleError } from "../../src/app/shared/engine/errors.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// The 2025 hints (rules/ca/2025/hints.yaml). Each saving is checked against a hand calculation on one household, kept
// simple enough to do on paper: Ontario couples with T4 income only (no CPP or EI boxes), incomes where the Ontario
// surtax, tax reduction, LIFT credit and the federal top-up credit are all zero.

const rules = rulesFor(2025)!;

const NONE = {
  rrspDeduction: "0",
  fhsaDeduction: "0",
  medicalExpenses: "0",
  donations: "0",
  unusedTuition: "0",
  tuitionTransfer: "0",
  hasSelfEmployment: false,
  hasRentalIncome: false,
  hasPensionIncome: false,
  hasEiBenefits: false,
  hasForeignIncome: false,
  soldProperty: false,
  hasChildCare: false,
  hasWorkFromHome: false,
  hasMovingExpenses: false,
};

function couple(
  incomes: [number, number],
  answers: [Record<string, string | boolean>, Record<string, string | boolean>] = [{}, {}],
  slips: EngineInput["slips"] = [],
): EngineInput {
  return {
    year: 2025,
    people: [
      { id: "a", name: "Alex", role: "self", birthDate: "1985-01-01", province: "ON" },
      { id: "b", name: "Blair", role: "spouse", birthDate: "1986-01-01", province: "ON" },
    ],
    household: { maritalStatus: "married", dependants: [] },
    answers: { a: { ...NONE, ...answers[0] }, b: { ...NONE, ...answers[1] } },
    slips: [
      { id: "t4a", person: "a", type: "T4", issuer: "Maple Corp", boxes: { 14: String(incomes[0]) } },
      { id: "t4b", person: "b", type: "T4", issuer: "Birch Ltd", boxes: { 14: String(incomes[1]) } },
      // A T5 each, so the reminder about interest without a slip stays out of the way.
      { id: "t5a", person: "a", type: "T5", issuer: "Lakeview Credit Union", boxes: { 13: "1" } },
      { id: "t5b", person: "b", type: "T5", issuer: "Lakeview Credit Union", boxes: { 13: "1" } },
      ...slips,
    ],
  };
}

const ids = (input: EngineInput) => findHints(rules, input).map((hint) => `${hint.personId}:${hint.id}`);

describe("2025 hints", () => {
  it("pools both spouses' donations on one return: $20.60 by hand", () => {
    // $150 each, $60,000 each. Apart: 2 × $150 at 14.5% federal (21.75) and 5.05% Ontario (7.575 → 7.58) = 58.66.
    // Together: $200 at 14.5% (29.00) and 5.05% (10.10), $100 at 29% (29.00) and 11.16% (11.16) = 79.26. Saves 20.60.
    const input = couple([60000, 60000], [{ donations: "150" }, { donations: "150" }]);
    const hints = findHints(rules, input);
    const pool = hints.filter((hint) => hint.id === "poolDonations");
    expect(pool).toHaveLength(1); // the same either way: offered once, on the first return
    expect(pool[0]).toMatchObject({
      personId: "a",
      kind: "saving",
      effect: "20.6",
      amount: { label: "Your spouse's or partner's donations", value: "150" },
      change: [
        { personId: "a", question: "claimSpouseDonations", value: true },
        { personId: "b", question: "claimSpouseDonations", value: false },
      ],
    });
  });

  it("offers nothing once the donations are pooled, and the pooled return claims both", () => {
    const input = couple([60000, 60000], [{ donations: "150", claimSpouseDonations: true }, { donations: "150" }]);
    expect(ids(input)).not.toContain("a:poolDonations");
    expect(ids(input)).not.toContain("b:poolDonations"); // moving them back would cost
  });

  it("moves medical expenses to the lower income: $117.30 by hand", () => {
    // $3,000 on Alex ($70,000): threshold $2,100 federal and Ontario, so $900 counts. On Blair ($50,000): threshold
    // $1,500, so $1,500 counts. $600 more at 14.5% (87.00) and 5.05% (30.30) = 117.30.
    const input = couple([70000, 50000], [{ medicalExpenses: "3000" }, {}]);
    const medical = findHints(rules, input).filter((hint) => hint.id === "medicalOnOneReturn");
    expect(medical).toEqual([expect.objectContaining({ personId: "b", effect: "117.3", amount: { label: "Your spouse's or partner's medical expenses", value: "3000" } })]);
  });

  it("transfers tuition the student can't use: $725.00 by hand", () => {
    // Alex earns $10,000, under the basic personal amount, so none of the $8,000 of tuition is used; $5,000 can move.
    // Blair claims it at 14.5% = 725.00 (Ontario has no tuition credit).
    const input = couple([10000, 60000], [{}, {}], [{ id: "t2202", person: "a", type: "T2202", issuer: "Lakeshore College", boxes: { 26: "8000" } }]);
    const tuition = findHints(rules, input).filter((hint) => hint.id === "tuitionTransfer");
    expect(tuition).toEqual([
      expect.objectContaining({ personId: "a", effect: "725", change: [{ personId: "a", question: "tuitionTransfer", value: "5000" }], amount: { label: "Tuition you can transfer", value: "5000" } }),
    ]);
  });

  it("explains claiming the RRSP deduction later in the lowest bracket, without a saving to accept", () => {
    // $52,000 each: $49,000 or $52,000 of taxable income is in the lowest federal and Ontario brackets either way, the
    // Ontario health premium is $600 either way, and the family's income is past the LIFT credit. So not deducting the
    // $3,000 costs it at 14.5% (435.00) and 5.05% (151.50).
    const input = couple([52000, 52000], [{ rrspDeduction: "3000" }, {}]);
    const rrsp = findHints(rules, input).find((hint) => hint.id === "rrspNowOrLater")!;
    expect(rrsp).toMatchObject({ personId: "a", kind: "info", effect: "-586.5", effectLabel: "Deducting it this year saves" });
    expect(ids(couple([80000, 40000], [{ rrspDeduction: "3000" }, {}]))).not.toContain("a:rrspNowOrLater");
  });

  it("warns about RRSP contributions over the limit plus $2,000", () => {
    const notice = { id: "noa", person: "a", type: "NOA", issuer: "Canada Revenue Agency", boxes: { 1: "5000", 2: "0", 3: "0" } };
    const over = couple([60000, 60000], [{}, {}], [notice, { id: "r", person: "a", type: "RRSP", issuer: "Northwind Bank", boxes: { 1: "6000", 2: "2500" } }]);
    expect(findHints(rules, over).find((hint) => hint.id === "rrspOverContribution")).toMatchObject({ kind: "warning", amount: { value: "1500" } });
    const within = couple([60000, 60000], [{}, {}], [notice, { id: "r", person: "a", type: "RRSP", issuer: "Northwind Bank", boxes: { 1: "7000" } }]);
    expect(ids(within)).not.toContain("a:rrspOverContribution");
  });

  it("reminds about interest without a T5 only to a return with no interest on one", () => {
    const input = couple([60000, 60000]);
    input.slips = input.slips.filter((slip) => slip.id !== "t5b");
    expect(ids(input).filter((id) => id.endsWith(":interestWithoutSlip"))).toEqual(["b:interestWithoutSlip"]);
  });

  it("offers no allocation to a single person", () => {
    const input = couple([60000, 60000], [{ donations: "150", medicalExpenses: "3000" }, {}]);
    const single: EngineInput = { ...input, people: [input.people[0]!], household: { maritalStatus: "single", dependants: [] }, answers: { a: input.answers.a! }, slips: input.slips.filter((slip) => slip.person === "a") };
    expect(ids(single).filter((id) => /pool|medical|tuition/i.test(id))).toEqual([]);
  });

  it("leaves the allocation decisions out of a return's estimates", () => {
    const result = new Evaluation(rules, couple([60000, 60000], [{ donations: "150" }, { donations: "150" }])).result();
    for (const person of result.people) {
      expect(person.estimates.map((each) => each.question)).not.toContain("claimSpouseDonations");
      expect(person.lines.every((line) => line.status === "complete")).toBe(true);
    }
  });
});

describe("hint rules", () => {
  const year = (hints: unknown, extra: Record<string, unknown> = {}) => [
    {
      dir: "rules/xx/2025",
      files: [
        { path: "rules/xx/2025/year.yaml", data: { country: "xx", year: 2025, filingUnit: "person", extends: null, result: ["R.net"], outcome: "R.net", ...extra } },
        {
          path: "rules/xx/2025/rules.yaml",
          data: {
            lines: { "R.net": { label: "Net", formula: "answer.amount" } },
            questions: { amount: { type: "money", ask: "Amount", default: 0 }, flag: { type: "boolean", ask: "Flag", default: false, decision: true } },
            hints,
          },
        },
      ],
    },
  ];
  const compile = (hints: unknown, extra?: Record<string, unknown>) => compileRules(year(hints, extra), () => "test");
  const base = { kind: "saving", title: "T", text: "T", when: "line.R.net > 0", change: { "answer.amount": "1" } };

  it("compiles a hint and checks its formulas", () => {
    expect(compile({ ok: base }).hints.ok).toBeDefined();
    expect(() => compile({ bad: { ...base, when: "line.R.net" } })).toThrow(/when must be a yes\/no value/);
    expect(() => compile({ bad: { ...base, change: { "answer.flag": "1" } } })).toThrow(/The change to flag must be a yes\/no value/);
    expect(() => compile({ bad: { ...base, change: { "answer.nope": "1" } } })).toThrow(/No question nope/);
    expect(() => compile({ bad: { ...base, change: { "line.R.net": "1" } } })).toThrow(/write answer/);
    expect(() => compile({ bad: { ...base, change: {} } })).toThrow(/A saving hint changes at least one answer/);
    expect(() => compile({ bad: { ...base, kind: "info" } })).toThrow(/effectLabel/);
    expect(() => compile({ bad: { ...base, amount: "1" } })).toThrow(/amount and amountLabel together/);
    expect(() => compile({ ok: base }, { outcome: undefined })).toThrow(RuleError);
  });
});
