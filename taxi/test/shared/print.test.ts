import { describe, expect, it } from "vitest";
import { printBlockers, type Slip } from "#shared";
import type { PersonResult } from "../../src/app/shared/engine/evaluate.ts";

// What keeps a return from its forms, its own and, for a couple, what is left on the other return it reads.

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

describe("printBlockers", () => {
  it("is empty for a finished return", () => {
    expect(printBlockers(result("a"), [slip("a", "confirmed"), slip("b", "unconfirmed")])).toEqual([]);
  });

  it("lists slips to confirm and questions left, with where to answer them", () => {
    const own = result("a", { estimates: [{ question: "hasWorkFromHome", ask: "Working from home", assumed: false }] });
    expect(printBlockers(own, [slip("a", "unconfirmed")])).toEqual([
      { text: "1 slip is not confirmed yet.", confirm: true },
      { text: "Not answered yet: Working from home.", question: "hasWorkFromHome", unanswered: true },
    ]);
  });

  it("names what is left on the spouse's return when this one reads it", () => {
    const waiting = result("a", { lines: [{ id: "T1.48400", label: "Refund", value: "100", status: "estimate" }] });
    const spouse = { name: "Sam", result: result("b", { estimates: [{ question: "hasMovingExpenses", ask: "Moving expenses", assumed: false }] }) };
    expect(printBlockers(waiting, [], spouse)).toEqual([{ text: "Sam's return: not answered yet: Moving expenses.", question: "hasMovingExpenses", unanswered: true, personId: "b" }]);
    // A finished return isn't held by what is left on the other.
    expect(printBlockers(result("a"), [], spouse)).toEqual([]);
  });
});
