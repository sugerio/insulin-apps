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
function oneW2(options: {
  taxable?: string;
  wages?: string;
  married?: boolean;
  joint?: boolean;
  /** Head of household: one child of 10 lives with you. */
  hoh?: boolean;
  birthDate?: string;
  answers?: Record<string, string | boolean>;
  interest?: string;
  dependants?: number;
  resident?: boolean;
  spouseResident?: boolean;
  maritalStatus?: string;
  /** Dependent care benefits in box 10 of the W-2. */
  box10?: string;
}): EngineInput {
  const married = options.married || options.joint;
  const wages = options.wages ?? (Number(options.taxable ?? "0") + (options.joint ? 31500 : options.hoh ? 23625 : 15750)).toFixed(2);
  return {
    country: "us",
    year: 2025,
    people: [
      { id: "p1", name: "Alex", role: "self", birthDate: options.birthDate ?? "1990-05-05", province: null, residentAllYear: options.resident ?? true },
      // Filing jointly, the spouse is on the return too, here with no income of their own.
      ...(options.joint ? [{ id: "p2", name: "Sam", role: "spouse" as const, birthDate: "1991-06-06", province: null, residentAllYear: options.spouseResident ?? true }] : []),
    ],
    family: {
      maritalStatus: options.maritalStatus === undefined ? (married ? "married" : "single") : options.maritalStatus,
      ...(married ? { filingStatus: options.joint ? "joint" : "separate" } : {}),
      // Children of 10 who lived with you all year, each with a social security number.
      dependants: Array.from({ length: options.dependants ?? (options.hoh ? 1 : 0) }, (_, index) => ({
        id: `d${index}`,
        name: `Kid ${index + 1}`,
        birthDate: "2015-01-01",
        answers: { relationship: "child", monthsWithYou: "12", hasSSN: true, paidOwnSupport: false, filedJointReturn: false, citizenOrResident: true },
      })),
    },
    answers: {
      p1: { hasTipsOrOvertime: false, spouseItemizes: false, hasValidSSN: true, paidHalfOfHome: true, paidForCare: false, ...options.answers },
      ...(options.joint ? { p2: { hasTipsOrOvertime: false, hasValidSSN: true } } : {}),
    },
    slips: [
      {
        id: "w",
        person: "p1",
        type: "W2",
        issuer: "Acme",
        boxes: { 1: wages, 2: "0", 5: wages, 6: (Number(wages) * 0.0145).toFixed(2), ...(options.box10 ? { 10: options.box10 } : {}) },
      },
      ...(options.interest ? [{ id: "i", person: "p1", type: "INT", issuer: "Bank", boxes: { 1: options.interest } }] : []),
    ],
  };
}

describe("the 2025 US rules", () => {
  it("give the Tax Table's tax for every row, at both ends, single, jointly, separately and head of household", () => {
    const wrong: string[] = [];
    for (const [from, to, single, joint, separate, head] of table.rows as [number, number, number, number, number, number][]) {
      for (const taxable of [String(from), (to - 0.01).toFixed(2)]) {
        const statuses = [
          ["single", {}, single],
          ["jointly", { joint: true }, joint],
          ["separately", { married: true }, separate],
          ["head of household", { hoh: true }, head],
        ] as const;
        for (const [name, status, expected] of statuses) {
          const evaluation = new Evaluation(rules, oneW2({ taxable, ...status }));
          expect(evaluation.line("p1", "F1040.15").value?.toString()).toBe(String(Number(taxable)));
          const tax = evaluation.line("p1", "F1040.16").value?.toString();
          if (tax !== String(expected)) wrong.push(`${taxable} ${name}: ${tax}, the table says ${expected}`);
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
    // Section B: married filing jointly, 22% less $10,172.00 at $100,000 and 37% less $75,937.50 over $751,600.
    const joint = (taxable: string) => new Evaluation(rules, oneW2({ taxable, joint: true })).line("p1", "F1040.16").value?.toString();
    expect(joint("100000")).toBe("11828");
    expect(joint("800000")).toBe("220062.5");
    // Section D: head of household, 22% less $6,825.00 at $100,000 and 37% less $44,718.00 over $626,350.
    const head = (taxable: string) => new Evaluation(rules, oneW2({ taxable, hoh: true })).line("p1", "F1040.16").value?.toString();
    expect(head("100000")).toBe("15175");
    expect(head("700000")).toBe("214282");
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
      ["a spouse who died in 2025", oneW2({ taxable: "30000", maritalStatus: "widowed", answers: { spouseDiedIn2025: true } }), /file jointly for 2025/],
      ["tips or overtime", oneW2({ taxable: "30000", answers: { hasTipsOrOvertime: true } }), /tips and overtime/],
      ["a child's interest over $2,700", oneW2({ wages: "1000", birthDate: "2010-01-01", interest: "3000", answers: { canBeClaimed: true } }), /Form 8615/],
      ["a spouse who itemizes", oneW2({ taxable: "30000", married: true, answers: { spouseItemizes: true } }), /itemize/],
    ];
    for (const [what, input, message] of cases) {
      const { total, unhandled } = notHandled(input);
      expect(total, what).toBeNull();
      expect(unhandled.join(" "), what).toMatch(message);
    }
    // Widowed before 2025, the earned income credit's age and income limits, and a claimed dependent's small interest: handled.
    expect(notHandled(oneW2({ taxable: "30000", maritalStatus: "widowed", answers: { spouseDiedIn2025: false, spouseDiedIn2023Or2024: false } })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "15000", birthDate: "2002-01-01" })).total).not.toBeNull();
    // The earned income credit and Part II-B of Schedule 8812 are worked out.
    expect(notHandled(oneW2({ wages: "15000" })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "30000", dependants: 3 })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "25000" })).total).not.toBeNull();
    expect(notHandled(oneW2({ wages: "1000", birthDate: "2010-01-01", interest: "2700", answers: { canBeClaimed: true } })).total).not.toBeNull();
  });

  describe("Form 2441, child and dependent care", () => {
    const care = { paidForCare: true, householdEmployer: false, priorYearCare: false };
    /** A head of household with children of 10 (each with `expenses` of care), or a couple filing jointly. */
    const withCare = (options: Parameters<typeof oneW2>[0] & { expenses?: string }) => {
      const input = oneW2({ hoh: !options.joint, ...options, answers: { ...care, ...(options.joint ? { spouseNeedsCare: false, studentOrDisabledMonths: "0" } : {}), ...options.answers } });
      for (const dependant of input.family.dependants) dependant.answers = { ...dependant.answers, careExpenses: options.expenses ?? "3000" };
      if (options.joint) input.answers.p2 = { ...input.answers.p2, studentOrDisabledMonths: "0" };
      return input;
    };
    const line = (input: EngineInput, id: string) => new Evaluation(rules, input).line("p1", id).value?.toString() ?? null;

    it("take the rate of line 8 for AGI at both ends of every band", () => {
      // Form 2441, line 8: AGI "over" the first amount "but not over" the second.
      const bands: [number, number, string][] = [[0, 15000, "0.35"]];
      for (let from = 15000, rate = 34; from < 43000; from += 2000, rate -= 1) bands.push([from, from + 2000, `0.${rate}`]);
      const wrong: string[] = [];
      for (const [over, notOver, rate] of bands) {
        for (const agi of [over === 0 ? "1" : (over + 0.01).toFixed(2), String(notOver)]) {
          const got = line(withCare({ wages: agi }), "F2441.8");
          if (Number(got) !== Number(rate)) wrong.push(`${agi}: ${got}, the form says ${rate}`);
        }
      }
      for (const agi of ["43000.01", "250000"]) if (Number(line(withCare({ wages: agi }), "F2441.8")) !== 0.2) wrong.push(`${agi}: not .20`);
      expect(bands).toHaveLength(15);
      expect(wrong).toEqual([]);
    });

    it("take the credit before the child tax credit, so the rest of that can be refunded", () => {
      const without = withCare({ wages: "40000", answers: { paidForCare: false } });
      const withIt = withCare({ wages: "40000", expenses: "4000" });
      expect(line(withIt, "S3.2")).toBe("660");
      expect(Number(line(withIt, "F1040.19"))).toBe(Number(line(without, "F1040.19")) - 660);
      expect(Number(line(withIt, "F1040.28"))).toBe(Number(line(without, "F1040.28")) + 660);
    });

    it("tax the dependent care benefits that care expenses don't use, as wages on line 1e", () => {
      const input = withCare({ wages: "40000", box10: "5000", expenses: "3000", answers: { careBenefitsCarriedOver: "0", careBenefitsForfeited: "0" } });
      expect(line(input, "F1040.1e")).toBe("2000");
      expect(line(input, "F1040.1z")).toBe("42000");
      expect(line(input, "S3.2")).toBe("0");
    });

    it("give the credit filing separately only to someone treated as unmarried, and exclude $2,500 of benefits", () => {
      const separate = (livedApart: boolean) => {
        const input = withCare({ wages: "30000", married: true, box10: "5000", expenses: "4000", answers: { livedApartLastSixMonths: livedApart, careBenefitsCarriedOver: "0", careBenefitsForfeited: "0" } });
        input.people.push({ id: "p2", name: "Sam", role: "spouse", birthDate: "1991-06-06", province: null, residentAllYear: true });
        input.answers.p2 = { hasTipsOrOvertime: false, spouseItemizes: false };
        input.slips.push({ id: "s", person: "p2", type: "W2", issuer: "Initech", boxes: { 1: "20000", 2: "0", 5: "20000", 6: "290" } });
        return input;
      };
      expect(line(separate(true), "F2441.21")).toBe("5000");
      expect(line(separate(true), "F2441.19")).toBe("30000");
      // Living together: the spouse's earned income on line 19, $2,500 excluded, $2,500 taxed, no credit.
      expect(line(separate(false), "F2441.19")).toBe("20000");
      expect(line(separate(false), "F2441.25")).toBe("2500");
      expect(line(separate(false), "F1040.1e")).toBe("2500");
      expect(line(separate(false), "S3.2")).toBe("0");
    });

    it("count a spouse with no wages who was a student as earning $250 a month, or $500 with two people in care", () => {
      const student = (children: number) => {
        const input = withCare({ wages: "60000", joint: true, dependants: children });
        input.answers.p2 = { ...input.answers.p2, studentOrDisabledMonths: "9" };
        return line(input, "F2441.5");
      };
      expect(student(1)).toBe("2250");
      expect(student(2)).toBe("4500");
    });

    it("ask about care only when someone lived with you, and about each person only what decides", () => {
      const asked = (input: EngineInput) => new Evaluation(rules, input).result();
      expect(asked(oneW2({ taxable: "30000" })).people[0]!.questions).not.toContain("paidForCare");
      expect(asked(oneW2({ taxable: "30000", box10: "1000" })).people[0]!.questions).toContain("paidForCare");
      expect(asked(oneW2({ taxable: "30000", hoh: true })).people[0]!.questions).toContain("paidForCare");
      // Not paid for care: nothing more is asked.
      const none = asked(oneW2({ taxable: "30000", hoh: true }));
      expect(none.people[0]!.questions).not.toContain("householdEmployer");
      expect(none.dependants[0]!.questions).not.toContain("careExpenses");
      // Paid: the care for a child of 10, and whether a 30-year-old who lives with you can care for themselves.
      const input = withCare({ wages: "50000" });
      expect(asked(input).people[0]!.questions).toEqual(expect.arrayContaining(["householdEmployer", "priorYearCare"]));
      input.family.dependants.push({
        id: "d9",
        name: "Ana",
        birthDate: "1995-01-01",
        answers: { relationship: "sibling", monthsWithYou: "12", paidOwnSupport: false, filedJointReturn: false, citizenOrResident: true, grossIncome: "9000", supportedByYou: true, disabled: false },
      });
      const paid = asked(input);
      expect(paid.people[0]!.questions).not.toContain("careBenefitsCarriedOver");
      expect(paid.dependants[0]!.questions).toContain("careExpenses");
      expect(paid.dependants[0]!.questions).not.toContain("cantCareForSelf");
      expect(paid.dependants[1]!.missing.map((item) => item.question)).toEqual(["cantCareForSelf"]);
      // Filing jointly, whether each spouse was a student.
      const joint = asked(withCare({ wages: "50000", joint: true, dependants: 1 }));
      expect(joint.people[1]!.questions).toContain("studentOrDisabledMonths");
    });

    it("say what they don't handle instead of giving a total tax", () => {
      const total = (input: EngineInput) => {
        const result = new Evaluation(rules, input).result().people[0]!;
        return { total: result.lines.find((each) => each.id === "F1040.24")?.value ?? null, unhandled: result.unhandled.join(" ") };
      };
      const studentWithWages = withCare({ wages: "60000", joint: true, dependants: 1 });
      studentWithWages.answers.p1 = { ...studentWithWages.answers.p1, studentOrDisabledMonths: "3" };
      const bothStudents = withCare({ wages: "0", joint: true, dependants: 1 });
      bothStudents.answers.p1 = { ...bothStudents.answers.p1, studentOrDisabledMonths: "3" };
      bothStudents.answers.p2 = { ...bothStudents.answers.p2, studentOrDisabledMonths: "3" };
      bothStudents.slips = [];
      const cases: [string, EngineInput, RegExp][] = [
        ["a household employee", withCare({ wages: "50000", answers: { householdEmployer: true } }), /Schedule H/],
        ["2024 care paid in 2025", withCare({ wages: "50000", answers: { priorYearCare: true } }), /line 9b/],
        ["benefits over $5,000", oneW2({ taxable: "30000", box10: "6000" }), /over \$5,000 in box 10/],
        ["care for a spouse", withCare({ wages: "50000", joint: true, dependants: 1, answers: { spouseNeedsCare: true } }), /Care for your spouse/],
        ["a student with wages", studentWithWages, /month by month/],
        ["both spouses students", bothStudents, /only one of you/],
      ];
      for (const [what, input, message] of cases) {
        const { total: value, unhandled } = total(input);
        expect(value, what).toBeNull();
        expect(unhandled, what).toMatch(message);
      }
    });
  });

  it("ask nothing about a spouse before the marital status is known", () => {
    const questions = new Evaluation(rules, oneW2({ taxable: "30000", maritalStatus: null as unknown as string })).result().people[0]!.questions;
    expect(questions).not.toContain("spouseItemizes");
    expect(questions).not.toContain("spouseDiedIn2025");
    // Known, a separate return asks whether the spouse itemizes, and a widow whether the spouse died in 2025.
    expect(new Evaluation(rules, oneW2({ taxable: "30000", married: true })).result().people[0]!.questions).toContain("spouseItemizes");
    expect(new Evaluation(rules, oneW2({ taxable: "30000", maritalStatus: "widowed" })).result().people[0]!.questions).toContain("spouseDiedIn2025");
  });

  it("put a joint return on the person preparing's: the spouse has no result of their own, and their questions are asked", () => {
    const result = new Evaluation(rules, oneW2({ taxable: "30000", joint: true })).result();
    const [alex, sam] = result.people;
    expect(alex!.lines.map((line) => line.id)).toContain("F1040.24");
    expect(sam!.lines).toEqual([]);
    expect(sam!.questions).toEqual(expect.arrayContaining(["isBlind", "canBeClaimed", "hasTipsOrOvertime"]));
    // Separately, each spouse has a return of their own.
    const separate = new Evaluation(rules, { ...oneW2({ taxable: "30000", joint: true }), family: { maritalStatus: "married", filingStatus: "separate", dependants: [] } }).result();
    expect(separate.people[1]!.lines.map((line) => line.id)).toContain("F1040.24");
  });

  it("say a spouse who wasn't a resident all year can't be on a joint return here", () => {
    const result = new Evaluation(rules, oneW2({ taxable: "30000", joint: true, spouseResident: false })).result().people[0]!;
    expect(result.lines.find((line) => line.id === "F1040.24")?.value).toBeNull();
    expect(result.unhandled.join(" ")).toMatch(/Your spouse wasn't a U.S. citizen or resident alien all year/);
  });

  it("wait for a married couple's filing status before working out the return", () => {
    const input = oneW2({ taxable: "30000", joint: true });
    const undecided = new Evaluation(rules, { ...input, family: { maritalStatus: "married", dependants: [] } }).result().people[0]!;
    expect(undecided.lines.find((line) => line.id === "F1040.15")?.value).toBeNull();
    expect(undecided.questions).not.toContain("spouseItemizes");
  });

  it("ask about each dependant only what decides whether they qualify", () => {
    const withChild = (birthDate: string, answers: Record<string, string | boolean>) => {
      const input = oneW2({ taxable: "40000", hoh: true });
      input.family.dependants[0] = { ...input.family.dependants[0]!, birthDate, answers };
      return new Evaluation(rules, input).result().dependants[0]!;
    };
    const base = { relationship: "child", monthsWithYou: "12", hasSSN: true, paidOwnSupport: false, filedJointReturn: false, citizenOrResident: true };
    // A child of 10: no question about school or disability.
    const young = withChild("2015-01-01", base);
    expect(young.questions).toEqual(expect.arrayContaining(["relationship", "monthsWithYou", "hasSSN"]));
    expect(young.questions).not.toContain("fullTimeStudent");
    expect(young.questions).not.toContain("disabled");
    expect(young.missing).toEqual([]);
    // At 20, being a full-time student decides; until it is answered, it is missing.
    const student = withChild("2005-01-01", base);
    expect(student.missing.map((item) => item.question)).toEqual(["fullTimeStudent"]);
    // A parent: their income and who supported them decide.
    const parent = withChild("1950-01-01", { relationship: "parent", monthsWithYou: "0", paidOwnSupport: false, filedJointReturn: false, citizenOrResident: true });
    // Not related as a child can be, so the age test (and disability) is never asked.
    expect(parent.missing.map((item) => item.question).sort()).toEqual(["grossIncome", "supportedByYou"]);
  });

  it("name each dependant in the explanation of a credit", () => {
    const evaluation = new Evaluation(rules, oneW2({ taxable: "40000", dependants: 2, answers: { paidHalfOfHome: true } }));
    expect(evaluation.line("p1", "S8812.4").value?.toString()).toBe("2");
    const why = evaluation.explain("p1", "line.S8812.4");
    const names = JSON.stringify(why);
    expect(names).toContain("Kid 1: A qualifying child for the child tax credit");
    expect(names).toContain("Kid 2: A qualifying child for the child tax credit");
  });

  it("give the EIC Table's credit for every row, at both ends, with 0 to 3 children, single and jointly", () => {
    const eic = JSON.parse(readFileSync(resolve(import.meta.dirname, "us-2025-eic-table.json"), "utf8")) as { rows: number[][]; footnotes: [number, number, boolean, number][] };
    /** Earned income (and AGI) of `amount`, with `children` qualifying children, filing single (or head of household) or jointly. */
    const credit = (amount: string, children: number, joint: boolean) => {
      const input = oneW2({ wages: amount, joint, dependants: children, birthDate: "1990-05-05" });
      return new Evaluation(rules, input).line("p1", "F1040.27a").value?.toString();
    };
    const wrong: string[] = [];
    for (const [from, to, ...credits] of eic.rows as number[][]) {
      for (const amount of [String(from), (to! - 0.01).toFixed(2)]) {
        for (let column = 0; column < 8; column += 1) {
          const children = column % 4;
          const joint = column >= 4;
          const got = credit(amount, children, joint);
          if (got !== String(credits[column])) wrong.push(`${amount} with ${children} ${joint ? "jointly" : "single"}: ${got}, the table says ${credits[column]}`);
        }
      }
    }
    expect(eic.rows).toHaveLength(1366);
    expect(wrong.slice(0, 10)).toEqual([]);
    // The last row of a column, narrower than $50, from the table's footnotes.
    for (const [amount, children, joint, expected] of eic.footnotes) expect(credit(String(amount), children, joint), `${amount} ${children} ${joint}`).toBe(String(expected));
    // The table's own example: single, one child, $2,455: $842.
    expect(credit("2455", 1, false)).toBe("842");
  });

  it("show one federal refund or amount owed, and print on the IRS forms in their attachment order", () => {
    expect(rules.balances).toEqual([{ name: "Federal", refund: "F1040.34", owing: "F1040.37" }]);
    expect([...rules.forms.keys()]).toEqual(["F1040", "S1A", "S2", "S3", "F2441", "SEIC", "S8812", "F8959", "F8960"]);
  });
});
