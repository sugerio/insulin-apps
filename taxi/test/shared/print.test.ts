import { describe, expect, it } from "vitest";
import { printBlockers, type Issue, type PrintYear, type Slip } from "#shared";
import type { PersonResult } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// What keeps a return from its forms, its own and, for a couple, what is left on the other return it reads.

const rules = rulesFor(2025)!;
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
