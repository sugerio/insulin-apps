import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Dec } from "../../src/app/shared/engine/decimal.ts";
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
  spouseAnswers?: Record<string, string | boolean>;
  interest?: string;
  dependants?: number;
  resident?: boolean;
  spouseResident?: boolean;
  maritalStatus?: string;
  /** Dependent care benefits in box 10 of the W-2. */
  box10?: string;
  /** Social security tips in box 7 of the W-2. */
  box7?: string;
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
      p1: { hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, spouseItemizes: false, hasValidSSN: true, paidHalfOfHome: true, paidForCare: false, ...options.answers },
      ...(options.joint ? { p2: { hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasValidSSN: true, ...options.spouseAnswers } } : {}),
    },
    slips: [
      {
        id: "w",
        person: "p1",
        type: "W2",
        issuer: "Acme",
        boxes: { 1: wages, 2: "0", 5: wages, 6: (Number(wages) * 0.0145).toFixed(2), ...(options.box10 ? { 10: options.box10 } : {}), ...(options.box7 ? { 7: options.box7 } : {}) },
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
    expect([...rules.forms.keys()]).toEqual(["F1040", "S1", "S1A", "S2", "S3", "SC", "SCS", "SE", "SES", "F2441", "SEIC", "S8812", "F8863", "F8995", "F8959", "F8960"]);
  });
});

describe("Schedule 1-A: tips, overtime and car loan interest", () => {
  const line = (input: EngineInput, id: string) => new Evaluation(rules, input).line("p1", id).value?.toString() ?? null;
  const tips = (amount: string, extra: Record<string, string | boolean> = {}) => ({ hasTipsOrOvertime: true, qualifiedTips: amount, qualifiedOvertime: "0", ...extra });
  const car = (interest: string, qualifies = "yes") => ({ hasCarLoan: true, carLoanInterest: interest, carLoanQualifies: qualifies });

  it("deducts qualified tips up to $25,000, after the AGI, starting from box 7 of the W-2", () => {
    const server = oneW2({ wages: "38000", box7: "9000", answers: tips("9000") });
    expect([line(server, "US.boxTips"), line(server, "S1A.13"), line(server, "F1040.13b"), line(server, "F1040.15")]).toEqual(["9000", "9000", "9000", "13250"]);
    // Deducted after AGI: the earned income credit's income isn't changed.
    expect(line(server, "F1040.11a")).toBe("38000");
    expect(line(oneW2({ wages: "60000", answers: tips("30000") }), "S1A.13")).toBe("25000");
    // Without a social security number valid for employment, none.
    expect(line(oneW2({ wages: "38000", answers: tips("9000", { hasValidSSN: false }) }), "S1A.13")).toBe("0");
  });

  it("deducts the overtime premium up to $12,500, or $25,000 for a couple filing jointly together", () => {
    const overtime = (amount: string) => ({ hasTipsOrOvertime: true, qualifiedTips: "0", qualifiedOvertime: amount });
    expect(line(oneW2({ wages: "90000", answers: overtime("15000") }), "S1A.21")).toBe("12500");
    // Jointly the limit is for the couple: $15,000 and $15,000 make $25,000.
    const couple = oneW2({ wages: "120000", joint: true, answers: overtime("15000"), spouseAnswers: overtime("15000") });
    expect([line(couple, "S1A.14c"), line(couple, "S1A.21")]).toEqual(["30000", "25000"]);
  });

  it("cuts tips and overtime by $100 for each whole $1,000 of modified AGI over $150,000", () => {
    const cut = (wages: string) => line(oneW2({ wages, answers: tips("10000") }), "S1A.13");
    expect([cut("150000"), cut("150999.99"), cut("151000"), cut("249000"), cut("260000")]).toEqual(["10000", "10000", "9900", "100", "0"]);
  });

  it("cuts car loan interest by $200 for each $1,000 or part over $100,000, and takes it at most $10,000", () => {
    const deduction = (wages: string, interest = "4000") => line(oneW2({ wages, answers: car(interest) }), "S1A.30");
    expect([deduction("100000"), deduction("100000.01"), deduction("101000"), deduction("101000.01"), deduction("120000")]).toEqual(["4000", "3800", "3800", "3600", "0"]);
    expect(deduction("60000", "12000")).toBe("10000");
    // A car that doesn't qualify: none.
    expect(line(oneW2({ wages: "60000", answers: car("4000", "no") }), "S1A.30")).toBe("0");
  });

  it("gives no tips or overtime deduction to a married person filing separately, but the car loan interest one", () => {
    const separate = oneW2({ wages: "60000", married: true, answers: { ...tips("5000"), ...car("3000") } });
    expect([line(separate, "S1A.13"), line(separate, "S1A.30"), line(separate, "S1A.38")]).toEqual(["0", "3000", "3000"]);
  });

  it("asks the amounts only after the yes, and the car's questions on Deductions", () => {
    const questions = (answers: Record<string, string | boolean>) => new Evaluation(rules, oneW2({ wages: "40000", answers })).result().people[0]!.questions;
    expect(questions({})).toEqual(expect.arrayContaining(["hasTipsOrOvertime", "hasCarLoan"]));
    expect(questions({})).not.toContain("qualifiedTips");
    expect(questions({ hasTipsOrOvertime: true })).toEqual(expect.arrayContaining(["qualifiedTips", "qualifiedOvertime"]));
    // The interest first; whether the car qualifies once there is some.
    expect(questions({ hasCarLoan: true })).toContain("carLoanInterest");
    expect(questions({ hasCarLoan: true })).not.toContain("carLoanQualifies");
    expect(questions({ hasCarLoan: true, carLoanInterest: "900" })).toContain("carLoanQualifies");
    expect(rules.questions.get("hasCarLoan")!.module).toBe("deductions");
  });
});

describe("self-employment: Schedules C, SE and 1, and Form 8995", () => {
  const evaluation = (input: EngineInput) => new Evaluation(rules, input);
  const line = (input: EngineInput, id: string) => evaluation(input).line("p1", id).value?.toString() ?? null;
  /** A business with this income (beside a $1 W-2) and expenses; `extra` adds answers. */
  const business = (income: string, extra: Record<string, string | boolean> = {}, wages = "1") => {
    const expenses = ["Advertising", "Car", "ContractLabor", "Insurance", "Professional", "Office", "Rent", "Supplies", "Travel", "Meals", "Utilities", "OtherExpenses"];
    return oneW2({
      wages,
      answers: {
        hasSelfEmployment: true,
        businessIncome: income,
        businessExtras: "none",
        ...Object.fromEntries(expenses.map((name) => [`business${name}`, "0"])),
        ...extra,
      },
    });
  };

  it("works out the profit with half of the meals, and self-employment tax on 92.35% of it", () => {
    const input = business("10000", { businessSupplies: "1000", businessMeals: "500" });
    // $10,000 less $1,000 and half of $500: $8,750; 92.35% is $8,080.63; 15.3% of it, $1,236.34; half deducted.
    expect(["SC.24b", "SC.31", "SE.4a", "SE.10", "SE.11", "SE.12", "SE.13", "S1.15"].map((id) => line(input, id))).toEqual([
      "250",
      "8750",
      "8080.63",
      "1002",
      "234.34",
      "1236.34",
      "618.17",
      "618.17",
    ]);
    // Adjusted gross income: $1 of wages and the profit, less half the tax; the profit is earned income too.
    expect([line(input, "F1040.9"), line(input, "F1040.11a"), line(input, "US.earnedIncome")]).toEqual(["8751", "8132.83", "8132.83"]);
  });

  it("owes no self-employment tax under $400 of net earnings", () => {
    // $433 is $399.88 of net earnings; $434, $400.80.
    expect([line(business("433"), "SE.12"), line(business("434"), "SE.6")]).toEqual(["0", "400.8"]);
  });

  it("takes social security tax only on the room left under $176,100 by the W-2's boxes 3 and 7", () => {
    const capped = business("50000", {}, "170000");
    capped.slips[0]!.boxes = { ...capped.slips[0]!.boxes, 3: "170000" };
    expect([line(capped, "SE.9"), line(capped, "SE.10")]).toEqual(["6100", "756.4"]);
    const over = business("50000", {}, "180000");
    over.slips[0]!.boxes = { ...over.slips[0]!.boxes, 3: "180000" };
    expect([line(over, "SE.9"), line(over, "SE.10")]).toEqual(["0", "0"]);
  });

  it("adds the 1099-NEC amounts to the other income, and their withholding to line 25b", () => {
    const input = business("5000");
    input.slips.push({ id: "n", person: "p1", type: "NEC", issuer: "Acme", boxes: { 1: "12000", 4: "300" } });
    expect([line(input, "SC.1"), line(input, "F1040.25b")]).toEqual(["17000", "300"]);
  });

  it("limits the QBI deduction to 20% of the taxable income before it", () => {
    const input = business("40000");
    const qbi = Dec.from(line(input, "F8995.2")!);
    const before = Dec.from(line(input, "F8995.11")!);
    expect(line(input, "F8995.15")).toBe(Dec.min(qbi.mul(Dec.from("0.2")).roundTo(2, "HALF_UP"), before.mul(Dec.from("0.2")).roundTo(2, "HALF_UP")).toString());
    expect(line(input, "F1040.13a")).toBe(line(input, "F8995.15"));
  });

  it("says what it doesn't handle: a loss, more than one business, depreciation, a home office, inventory, Form 8995-A, a 1099-NEC without a business", () => {
    const unhandled = (input: EngineInput) => evaluation(input).result().people[0]!.unhandled.join(" ");
    expect(unhandled(business("1000", { businessSupplies: "2000" }))).toMatch(/business loss/);
    expect(unhandled(business("1000", { businessExtras: "several" }))).toMatch(/one Schedule C/);
    expect(unhandled(business("1000", { businessExtras: "assets" }))).toMatch(/Form 4562/);
    expect(unhandled(business("1000", { businessExtras: "home" }))).toMatch(/Form 8829/);
    expect(unhandled(business("1000", { businessExtras: "inventory" }))).toMatch(/Part III/);
    expect(unhandled(business("260000"))).toMatch(/Form 8995-A/);
    const stray = oneW2({ wages: "30000" });
    stray.slips.push({ id: "n", person: "p1", type: "NEC", issuer: "Acme", boxes: { 1: "500" } });
    expect(unhandled(stray)).toMatch(/1099-NEC is added/);
  });

  it("asks the expenses only once there is a business", () => {
    const questions = (answers: Record<string, string | boolean>) => evaluation(oneW2({ wages: "40000", answers })).result().people[0]!.questions;
    expect(questions({})).toContain("hasSelfEmployment");
    expect(questions({})).not.toContain("businessIncome");
    expect(questions({ hasSelfEmployment: true })).toEqual(expect.arrayContaining(["businessIncome", "businessSupplies", "businessMeals", "businessExtras"]));
  });
});

describe("education: Form 8863 and the student loan interest deduction", () => {
  const evaluation = (input: EngineInput) => new Evaluation(rules, input);
  const line = (input: EngineInput, id: string) => evaluation(input).line("p1", id).value?.toString() ?? null;
  const lines = (input: EngineInput, ids: string[]) => ids.map((id) => line(input, id));
  const course = (expenses: string, credit: "aotc" | "llc", extra: Record<string, string | boolean> = {}) => ({
    paidForEducation: true,
    educationExpenses: expenses,
    educationCredit: credit,
    ...extra,
  });
  const loan = (interest: string) => ({ hasStudentLoan: true, studentLoanInterest: interest });

  it("takes the American opportunity credit on all of the first $2,000 and 25% of the next $2,000, 40% of it refundable", () => {
    expect(lines(oneW2({ wages: "50000", answers: course("3000", "aotc") }), ["F8863.1", "F8863.7", "F8863.8", "F8863.9", "S3.3", "F1040.29"])).toEqual([
      "2250",
      "2250",
      "900",
      "1350",
      "1350",
      "900",
    ]);
    expect(line(oneW2({ wages: "50000", answers: course("9000", "aotc") }), "F8863.1")).toBe("2500");
  });

  it("takes the lifetime learning credit on 20% of up to $10,000 for the return", () => {
    expect(lines(oneW2({ wages: "50000", answers: course("12000", "llc") }), ["F8863.10", "F8863.11", "F8863.18", "F8863.19", "F8863.8"])).toEqual(["12000", "10000", "2000", "2000", "0"]);
  });

  it("cuts both credits from $80,000 of modified AGI ($160,000 jointly) to $90,000, by a decimal rounded to three places", () => {
    const share = (wages: string, joint = false) => line(oneW2({ wages, joint, answers: course("4000", "aotc") }), "F8863.6");
    expect([share("80000"), share("81234"), share("85000"), share("89999.99"), share("90000"), share("170000", true)]).toEqual(["1", "0.877", "0.5", "0", "0", "0.5"]);
    expect(line(oneW2({ wages: "85000", answers: course("10000", "llc") }), "F8863.18")).toBe("1000");
  });

  it("gives no credit and no student loan deduction filing separately, or to someone who can be claimed as a dependent", () => {
    const answers = { ...course("4000", "aotc"), ...loan("1000") };
    const separate = oneW2({ wages: "50000", married: true, answers });
    const claimed = oneW2({ wages: "50000", answers: { ...answers, canBeClaimed: true } });
    for (const input of [separate, claimed]) expect(lines(input, ["F8863.1", "F8863.19", "F1040.29", "S1.21"])).toEqual(["0", "0", "0", "0"]);
    // Nothing about education is asked of them.
    expect(evaluation(oneW2({ wages: "50000", answers: { canBeClaimed: true } })).result().people[0]!.questions).not.toContain("paidForEducation");
  });

  it("makes none of the credit refundable for someone under 24, not filing jointly, with a parent alive, as Form 8863 line 7 says", () => {
    const young = (birthDate: string, extra: Record<string, boolean>) => oneW2({ wages: "25000", birthDate, answers: course("3000", "aotc", extra) });
    expect(line(young("2005-01-01", { parentAlive: true, fullTimeStudentSelf: true, earnedUnderHalfSupport: true }), "F8863.8")).toBe("0");
    // Earning half of their support or more, not a full-time student, or no parent alive: 40% is refundable.
    expect(line(young("2005-01-01", { parentAlive: true, fullTimeStudentSelf: true, earnedUnderHalfSupport: false }), "F8863.8")).toBe("900");
    expect(line(young("2005-01-01", { parentAlive: true, fullTimeStudentSelf: false }), "F8863.8")).toBe("900");
    expect(line(young("2005-01-01", { parentAlive: false }), "F8863.8")).toBe("900");
    // Under 18, a parent alive is enough; at 18, the support test too; from 24, none of it is asked.
    expect(line(young("2008-01-01", { parentAlive: true }), "F8863.8")).toBe("0");
    expect(line(young("2007-01-01", { parentAlive: true, earnedUnderHalfSupport: true }), "F8863.8")).toBe("0");
    const questions = (birthDate: string, extra: Record<string, boolean> = {}) => evaluation(young(birthDate, extra)).result().people[0]!.questions;
    expect(questions("2005-01-01")).toContain("parentAlive");
    expect(questions("2005-01-01", { parentAlive: true })).toContain("fullTimeStudentSelf");
    expect(questions("2001-01-01")).not.toContain("parentAlive");
  });

  it("takes the education credits after the care credit and before the child tax credit", () => {
    // Head of household with a child of 10 and $25,000 of taxable income: more tax than the credit.
    const input = oneW2({ taxable: "25000", hoh: true, answers: course("4000", "aotc") });
    const [tax, education, limit] = lines(input, ["F1040.18", "S3.3", "S8812.13"]);
    expect(education).toBe("1500");
    expect(limit).toBe(Dec.from(tax!).sub(Dec.from("1500")).toString());
  });

  it("deducts up to $2,500 of student loan interest, cut from $85,000 of modified AGI ($170,000 jointly) to $100,000", () => {
    const deduction = (wages: string, interest = "3000") => line(oneW2({ wages, answers: loan(interest) }), "S1.21");
    expect([deduction("50000", "1200"), deduction("50000"), deduction("85000"), deduction("92000"), deduction("100000")]).toEqual(["1200", "2500", "2500", "1332.5", "0"]);
    // An adjustment: it lowers the AGI.
    expect(lines(oneW2({ wages: "50000", answers: loan("1200") }), ["F1040.10", "S1.26", "F1040.11a"])).toEqual(["1200", "1200", "48800"]);
    // Jointly, $2,500 for the couple, cut by $10,000 over $170,000 in $30,000: 0.333.
    const couple = oneW2({ wages: "180000", joint: true, answers: loan("1500"), spouseAnswers: loan("1500") });
    expect(lines(couple, ["SLW.1", "SLW.7", "S1.21"])).toEqual(["2500", "0.333", "1667.5"]);
  });

  it("asks the expenses only after the yes, the credit once there are some, and a dependant's from 14 on their card", () => {
    const questions = (answers: Record<string, string | boolean>) => evaluation(oneW2({ wages: "40000", answers })).result().people[0]!.questions;
    expect(questions({})).toEqual(expect.arrayContaining(["paidForEducation", "hasStudentLoan"]));
    expect(questions({})).not.toContain("educationExpenses");
    expect(questions({ paidForEducation: true })).toContain("educationExpenses");
    expect(questions({ paidForEducation: true })).not.toContain("educationCredit");
    expect(questions({ paidForEducation: true, educationExpenses: "500" })).toContain("educationCredit");
    expect(questions({ hasStudentLoan: true })).toContain("studentLoanInterest");
    expect([rules.questions.get("paidForEducation")!.module, rules.questions.get("hasStudentLoan")!.module]).toEqual(["about", "deductions"]);
    // A child of 10 isn't asked; a child of 19 is.
    const family = oneW2({ wages: "40000", hoh: true, answers: { paidForEducation: true, educationExpenses: "0" } });
    const dependantQuestions = (input: EngineInput) => evaluation(input).result().dependants[0]!.questions;
    expect(dependantQuestions(family)).not.toContain("studentExpenses");
    family.family.dependants[0]!.birthDate = "2006-01-01";
    family.family.dependants[0]!.answers = { ...family.family.dependants[0]!.answers, fullTimeStudent: true };
    expect(dependantQuestions(family)).toContain("studentExpenses");
  });
});
