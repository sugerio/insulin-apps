import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formsToAdd, printBlockers, type Issue, type PrintYear, type Slip } from "#shared";
import { Evaluation, type EngineInput, type PersonResult } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// What keeps a return from its forms, its own and, for a couple, what is left on the other return it reads.

const rules = rulesFor("ca", 2025)!;
const result = (personId: string, overrides: Partial<PersonResult> = {}): PersonResult => ({
  personId,
  lines: [{ id: "T1.48400", label: "Refund", value: "100", status: "complete" }],
  missing: [],
  estimates: [],
  unhandled: [],
  questions: [],
  ...overrides,
});
const slip = (personId: string, status: Slip["status"]): Slip => ({
  id: crypto.randomUUID(),
  personId,
  type: "T4",
  issuer: "Maple Corp",
  boxes: { 14: "60000" },
  status,
  source: "manual",
  documentId: null,
  unsure: [],
  confirmedAt: null,
  updatedAt: 0,
});
const year = (slips: Slip[], overrides: Partial<PrintYear> = {}): PrintYear => ({ rules, issues: [], answers: {}, slips, ...overrides });
const issue = (code: Issue["code"], kind: Issue["kind"], personId: string | null, message: string): Issue => ({ code, kind, personId, message });

describe("printBlockers", () => {
  it("is empty for a finished return", () => {
    expect(printBlockers(year([slip("a", "confirmed")]), result("a"))).toEqual([]);
  });

  it("lists slips to confirm and questions left, with where to answer them", () => {
    const own = result("a", { estimates: [{ question: "hasWorkFromHome", ask: "Working from home", assumed: false }] });
    expect(printBlockers(year([slip("a", "unconfirmed")]), own)).toEqual([
      { text: "1 slip is not confirmed yet.", confirm: true },
      { text: "Not answered yet: Working from home.", question: "hasWorkFromHome", unanswered: true },
    ]);
  });

  it("lists this return's issues and the year's shared ones, not the other adult's", () => {
    const issues = [
      issue("no_residency", "blocking", "a", "Say whether Alex lived in Canada all year."),
      issue("no_province", "blocking", "b", "Choose Sam's province on December 31."),
      issue("marital_status_mismatch", "blocking", "b", "Sam is your spouse or partner in the Profile: choose married or living common-law."),
    ];
    expect(printBlockers(year([], { issues }), result("a"))).toEqual([
      { text: "Say whether Alex lived in Canada all year.", issue: "no_residency" },
      { text: "Sam is your spouse or partner in the Profile: choose married or living common-law.", issue: "marital_status_mismatch" },
    ]);
  });

  it("waits for a slip said to exist that isn't there", () => {
    const answers = { a: { hasEmploymentIncome: true, hasInvestmentIncome: true } };
    // A question counts once the return asks it: it reads the T4 and T5 here.
    const reads = result("a", { questions: ["hasEmploymentIncome", "hasInvestmentIncome"] });
    expect(printBlockers(year([], { answers }), reads)).toEqual([
      { text: "Waiting for a slip: the T4 (Employment income).", question: "hasEmploymentIncome" },
      { text: "Waiting for a slip: the T5 (Interest or dividends).", question: "hasInvestmentIncome" },
    ]);
    // The T4 is there, in this return.
    expect(printBlockers(year([slip("a", "confirmed")], { answers: { a: { hasEmploymentIncome: true } } }), reads)).toEqual([]);
  });

  it("names what is left on the spouse's return when this one reads it", () => {
    const waiting = result("a", { lines: [{ id: "T1.48400", label: "Refund", value: "100", status: "estimate" }] });
    const spouse = { name: "Sam", result: result("b", { estimates: [{ question: "hasMovingExpenses", ask: "Moving expenses", assumed: false }] }) };
    expect(printBlockers(year([]), waiting, spouse)).toEqual([{ text: "Sam's return: not answered yet: Moving expenses.", question: "hasMovingExpenses", unanswered: true, personId: "b" }]);
    // A finished return isn't held by the other's questions left.
    expect(printBlockers(year([]), result("a"), spouse)).toEqual([]);
  });

  it("waits for the spouse's own issues, under their name, and lists a shared one once", () => {
    const issues = [
      issue("no_province", "blocking", "b", "Choose Sam's province on December 31."),
      issue("marital_status_mismatch", "blocking", "b", "Sam is your spouse or partner in the Profile: choose married or living common-law."),
    ];
    expect(printBlockers(year([], { issues }), result("a"), { name: "Sam", result: result("b") })).toEqual([
      { text: "Sam is your spouse or partner in the Profile: choose married or living common-law.", issue: "marital_status_mismatch" },
      { text: "Sam's return: Choose Sam's province on December 31.", issue: "no_province", personId: "b" },
    ]);
  });

  it("waits for the spouse's slips and what the app doesn't handle on their return, whatever this one reads", () => {
    const spouse = { name: "Sam", result: result("b", { questions: ["hasInvestmentIncome"], unhandled: ["T4 from Birch Ltd: box 40 isn't handled by this app"] }) };
    const answers = { b: { hasInvestmentIncome: true } };
    expect(printBlockers(year([slip("a", "confirmed"), slip("b", "unconfirmed")], { answers }), result("a"), spouse)).toEqual([
      { text: "Sam's return: 1 slip is not confirmed yet.", confirm: true, personId: "b" },
      { text: "Sam's return: waiting for a slip: the T5 (Interest or dividends).", question: "hasInvestmentIncome", personId: "b" },
      { text: "Sam's return: T4 from Birch Ltd: box 40 isn't handled by this app", personId: "b" },
    ]);
  });
});

describe("formsToAdd", () => {
  const golden = (name: string): EngineInput => JSON.parse(readFileSync(resolve(import.meta.dirname, `../golden/ca-2025/${name}.json`), "utf8")).input;
  const named = (input: EngineInput, personId = "p1") => formsToAdd(rules, new Evaluation(rules, input), personId).map(({ form }) => form.split(",")[0]);

  it.each([
    ["single-employee-on", []],
    ["single-employee-qc", ["Schedule D"]],
    ["single-parent-low-income-qc", ["Schedule 6 (5005-S6)", "Schedule D"]],
    ["low-income-worker-ab", ["Schedule 6 (5009-S6)"]],
    ["mb-senior-renter", ["Schedule MB428-A (5007-A)"]],
    ["on-caregiver-family", ["Schedule ON(S11) (5006-S11)"]],
    ["bc-student-couple", ["Schedule BC(S11) (5010-S11)"]],
    ["sk-couple-kids", ["Schedule SK(S11) (5008-S11)"]],
  ])("names on %s's return the forms it needs that aren't printed", (name, forms) => {
    expect(named(golden(name))).toEqual(forms);
  });

  it("names Nunavut's own Schedule 6 when the return gets the Canada workers benefit", () => {
    const input = golden("low-income-worker-ab");
    expect(named({ ...input, people: input.people.map((person) => ({ ...person, province: "NU" })) })).toEqual(["Schedule 6 (5014-S6)"]);
  });

  it("names the province's own Schedule 6 for advance payments on an RC210 slip, even with no benefit", () => {
    // $59,435 of net income gets no Canada workers benefit; Step 4 still reports the $400 paid in advance.
    const input = golden("single-employee-on");
    const advanced = (province: string): EngineInput => ({
      ...input,
      people: input.people.map((person) => ({ ...person, province })),
      slips: [...input.slips, { id: "rc", person: "p1", type: "RC210", issuer: "Canada Revenue Agency", boxes: { 10: "400" } }],
    });
    const evaluation = new Evaluation(rules, advanced("AB"));
    expect(evaluation.line("p1", "T1.45300").value?.toString()).toBe("0");
    expect(named(advanced("AB"))).toEqual(["Schedule 6 (5009-S6)"]);
    expect(named(advanced("NU"))).toEqual(["Schedule 6 (5014-S6)"]);
    expect(named(input)).toEqual([]);
  });
});
