import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// The 2025 US federal rules against the IRS's own numbers: every row of the 2025 Tax Table, and what the return says
// it doesn't handle instead of giving a wrong amount.

const rules = rulesFor("us", 2025)!;
const table = JSON.parse(readFileSync(resolve(import.meta.dirname, "us-2025-tax-table.json"), "utf8")) as { rows: number[][] };

/** One adult with one W-2; `taxable` is reached through wages less the $15,750 standard deduction. */
function oneW2(options: { taxable?: string; wages?: string; married?: boolean; birthDate?: string; answers?: Record<string, string | boolean>; interest?: string; dependants?: number; resident?: boolean; maritalStatus?: string }): EngineInput {
  const wages = options.wages ?? (Number(options.taxable ?? "0") + 15750).toFixed(2);
  return {
    country: "us",
    year: 2025,
    people: [{ id: "p1", name: "Alex", role: "self", birthDate: options.birthDate ?? "1990-05-05", province: null, residentAllYear: options.resident ?? true }],
    family: {
      maritalStatus: options.maritalStatus === undefined ? (options.married ? "married" : "single") : options.maritalStatus,
      dependants: Array.from({ length: options.dependants ?? 0 }, (_, index) => ({ id: `d${index}`, name: "Kid", birthDate: "2015-01-01" })),
    },
    answers: { p1: { hasTipsOrOvertime: false, spouseItemizes: false, ...options.answers } },
    slips: [
      { id: "w", person: "p1", type: "W2", issuer: "Acme", boxes: { 1: wages, 2: "0", 5: wages, 6: (Number(wages) * 0.0145).toFixed(2) } },
      ...(options.interest ? [{ id: "i", person: "p1", type: "INT", issuer: "Bank", boxes: { 1: options.interest } }] : []),
    ],
  };
}

describe("the 2025 US rules", () => {
  it("give the Tax Table's tax for every row, at both ends, single and married filing separately", () => {
    const wrong: string[] = [];
    for (const [from, to, single, , separate] of table.rows as [number, number, number, number, number, number][]) {
      for (const taxable of [String(from), (to - 0.01).toFixed(2)]) {
        for (const [married, expected] of [[false, single], [true, separate]] as const) {
          const evaluation = new Evaluation(rules, oneW2({ taxable, married }));
          expect(evaluation.line("p1", "F1040.15").value?.toString()).toBe(String(Number(taxable)));
          const tax = evaluation.line("p1", "F1040.16").value?.toString();
          if (tax !== String(expected)) wrong.push(`${taxable} ${married ? "separately" : "single"}: ${tax}, the table says ${expected}`);
        }
      }
    }
    expect(table.rows).toHaveLength(2062);
    expect(wrong).toEqual([]);
  });

  it("use the Tax Computation Worksheet from $100,000, to the cent", () => {
    const tax = (taxable: string, married = false) => new Evaluation(rules, oneW2({ taxable, married })).line("p1", "F1040.16").value?.toString();
    // Section A: 22% less $5,086.00 at $100,000; 35% less $30,452.75 over $250,525; 37% less $42,979.75 over $626,350.
    expect(tax("100000")).toBe("16914");
    expect(tax("300000.55")).toBe("74547.44");
    expect(tax("700000")).toBe("216020.25");
    // Section C: married filing separately reaches 37% (less $37,968.75) over $375,800.
    expect(tax("400000", true)).toBe("110031.25");
  });

  it("refuse to evaluate a US input with Canada's rules", () => {
    expect(() => new Evaluation(rulesFor("ca", 2025)!, oneW2({ taxable: "1000" }))).toThrow(/the rules are for ca/);
  });

  it("say what they don't handle instead of giving a total tax", () => {
    const notHandled = (input: EngineInput) => {
      const result = new Evaluation(rules, input).result().people[0]!;
      return { total: result.lines.find((line) => line.id === "F1040.24")?.value ?? null, unhandled: result.unhandled };
    };
    const cases: [string, EngineInput, RegExp][] = [
      ["a dual-status alien", oneW2({ taxable: "30000", resident: false }), /Form 1040-NR/],
      ["dependants", oneW2({ taxable: "30000", dependants: 1 }), /Dependants/],
      ["a spouse who died in 2025", oneW2({ taxable: "30000", maritalStatus: "widowed", answers: { spouseDiedIn2025: true } }), /file jointly for 2025/],
      ["tips or overtime", oneW2({ taxable: "30000", answers: { hasTipsOrOvertime: true } }), /tips and overtime/],
      ["a child's interest over $2,700", oneW2({ wages: "1000", birthDate: "2010-01-01", interest: "3000", answers: { canBeClaimed: true } }), /Form 8615/],
      ["a low income that may get the earned income credit", oneW2({ wages: "15000" }), /earned income credit/],
      ["a spouse who itemizes", oneW2({ taxable: "30000", married: true, answers: { spouseItemizes: true } }), /itemize/],
    ];
    for (const [what, input, message] of cases) {
      const { total, unhandled } = notHandled(input);
      expect(total, what).toBeNull();
      expect(unhandled.join(" "), what).toMatch(message);
    }
    // Widowed before 2025, the earned income credit's age and income limits, and a claimed dependent's small interest: handled.
    expect(notHandled(oneW2({ taxable: "30000", maritalStatus: "widowed", answers: { spouseDiedIn2025: false } })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "15000", birthDate: "2002-01-01" })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "25000" })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "1000", birthDate: "2010-01-01", interest: "2700", answers: { canBeClaimed: true } })).total).not.toBeNull();
  });

  it("ask nothing about a spouse before the marital status is known", () => {
    const questions = new Evaluation(rules, oneW2({ taxable: "30000", maritalStatus: null as unknown as string })).result().people[0]!.questions;
    expect(questions).not.toContain("spouseItemizes");
    expect(questions).not.toContain("spouseDiedIn2025");
    // Known, a separate return asks whether the spouse itemizes, and a widow whether the spouse died in 2025.
    expect(new Evaluation(rules, oneW2({ taxable: "30000", married: true })).result().people[0]!.questions).toContain("spouseItemizes");
    expect(new Evaluation(rules, oneW2({ taxable: "30000", maritalStatus: "widowed" })).result().people[0]!.questions).toContain("spouseDiedIn2025");
  });

  it("show one federal refund or amount owed", () => {
    expect(rules.balances).toEqual([{ name: "Federal", refund: "F1040.34", owing: "F1040.37" }]);
    expect(rules.forms.size).toBe(0);
  });
});
