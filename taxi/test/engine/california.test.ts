import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// The 2025 California return (rules/us/2025/california.yaml) against FTB's own numbers: every row of the 2025
// California Tax Table and of the 2025 California EITC Table, and what the California return says it doesn't handle
// instead of giving a wrong amount.

const rules = rulesFor("us", 2025)!;
const read = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, name), "utf8")) as { rows: number[][] };

const NO = {
  hasTipsOrOvertime: false,
  hasCarLoan: false,
  hasSelfEmployment: false,
  hasStudentLoan: false,
  paidForEducation: false,
  hasDividends: false,
  hasBrokerSales: false,
  hasLossCarryover: false,
  hasIraDistribution: false,
  hasPension: false,
  hasSocialSecurity: false,
  hasOtherIncome: false,
  hasHsa: false,
  hasIraContribution: false,
  hasItemized: false,
  hasValidSSN: true,
  estimatedPayments: "0",
};
/** What a California resident answers that the federal return doesn't ask. */
const CALIFORNIAN = { livedInCaliforniaAllYear: true, caFullYearCoverage: true, caUseTax: "0", caPaidRent: false, caEstimatedPayments: "0" };

/** A California resident with one W-2 from a California employer (box 15 CA, box 16 the wages). */
function californian(options: {
  wages: string;
  joint?: boolean;
  married?: boolean;
  /** Head of household with this many children of 10 (or, with `childBirthDate`, of that age). */
  children?: number;
  childBirthDate?: string;
  hoh?: boolean;
  birthDate?: string;
  state?: string;
  spouseState?: string;
  answers?: Record<string, string | boolean>;
  spouseAnswers?: Record<string, string | boolean>;
  box15?: string;
  box17?: string;
  slips?: EngineInput["slips"];
}): EngineInput {
  const married = options.married || options.joint;
  const children = options.children ?? (options.hoh ? 1 : 0);
  return {
    country: "us",
    year: 2025,
    people: [
      { id: "p1", name: "Alex", role: "self", birthDate: options.birthDate ?? "1990-05-05", province: options.state ?? "CA", residentAllYear: true },
      ...(options.joint ? [{ id: "p2", name: "Sam", role: "spouse" as const, birthDate: "1991-06-06", province: options.spouseState ?? options.state ?? "CA", residentAllYear: true }] : []),
    ],
    family: {
      maritalStatus: married ? "married" : "single",
      ...(married ? { filingStatus: options.joint ? "joint" : "separate" } : {}),
      dependants: Array.from({ length: children }, (_, index) => ({
        id: `d${index}`,
        name: `Kid ${index + 1}`,
        birthDate: options.childBirthDate ?? "2015-01-01",
        answers: { relationship: "child", monthsWithYou: "12", hasSSN: true, paidOwnSupport: false, filedJointReturn: false, citizenOrResident: true },
      })),
    },
    answers: {
      p1: { ...NO, ...CALIFORNIAN, spouseItemizes: false, paidHalfOfHome: true, paidForCare: false, ...options.answers },
      ...(options.joint ? { p2: { ...NO, livedInCaliforniaAllYear: true, ...options.spouseAnswers } } : {}),
    },
    slips: [
      {
        id: "w",
        person: "p1",
        type: "W2",
        issuer: "Acme",
        boxes: {
          1: options.wages,
          2: "0",
          5: options.wages,
          6: (Number(options.wages) * 0.0145).toFixed(2),
          15: options.box15 ?? "CA",
          16: options.wages,
          17: options.box17 ?? "0",
        },
      },
      ...(options.slips ?? []),
    ],
  };
}

const lines = (input: EngineInput, ids: string[]) => {
  const evaluation = new Evaluation(rules, input);
  return ids.map((id) => evaluation.line("p1", id).value?.toString() ?? null);
};

describe("the 2025 California return", () => {
  it("gives the California Tax Table's tax for every row, at both ends, for each filing status column", () => {
    const table = read("us-2025-ca-tax-table.json");
    const wrong: string[] = [];
    for (const [from, to, single, joint, head] of table.rows as [number, number, number, number, number][]) {
      for (const taxable of [from, to]) {
        const statuses = [
          ["single", {}, 5706, single],
          ["jointly", { joint: true }, 11412, joint],
          ["head of household", { hoh: true }, 11412, head],
        ] as const;
        for (const [name, status, standard, expected] of statuses) {
          const evaluation = new Evaluation(rules, californian({ wages: String(taxable + standard), ...status }));
          if (evaluation.line("p1", "F540.19").value?.toString() !== String(taxable)) wrong.push(`${taxable} ${name}: taxable income ${evaluation.line("p1", "F540.19").value?.toString()}`);
          const tax = evaluation.line("p1", "F540.31").value?.toString();
          if (tax !== String(expected)) wrong.push(`${taxable} ${name}: ${tax}, the table says ${expected}`);
        }
      }
    }
    expect(table.rows).toHaveLength(1001);
    expect(wrong.slice(0, 10)).toEqual([]);
  }, 120_000);

  it("uses the Tax Rate Schedules over $100,000, with FTB's printed bases", () => {
    const tax = (taxable: number, status: { joint?: boolean; hoh?: boolean } = {}) =>
      lines(californian({ wages: String(taxable + (status.joint || status.hoh ? 11412 : 5706)), ...status }), ["F540.31"])[0];
    // Schedule X: $3,201.97 + 9.3% over $72,724; $38,638.27 + 11.3% over $445,771 (FTB's base, a cent over the exact sum).
    expect(tax(100001)).toBe(String(Math.round(3201.97 + 0.093 * (100001 - 72724))));
    expect(tax(500000)).toBe(String(Math.round(38638.27 + 0.113 * (500000 - 445771))));
    // Schedule Y and Z.
    expect(tax(200000, { joint: true })).toBe(String(Math.round(6403.94 + 0.093 * (200000 - 145448))));
    expect(tax(150000, { hoh: true })).toBe(String(Math.round(3616.45 + 0.093 * (150000 - 98990))));
  });

  it("gives the California EITC Table's credit for every row, at both ends, for 0 to 3 qualifying children", () => {
    const table = read("us-2025-ca-eitc-table.json");
    const wrong: string[] = [];
    for (const [from, to, ...credits] of table.rows) {
      for (const earned of [from!, to!]) {
        for (let children = 0; children < 4; children += 1) {
          const [credit] = lines(californian({ wages: String(earned), children, hoh: children > 0 }), ["F3514.20"]);
          if (credit !== String(credits[children])) wrong.push(`${earned} with ${children}: ${credit}, the table says ${credits[children]}`);
        }
      }
    }
    expect(table.rows).toHaveLength(658);
    expect(wrong.slice(0, 10)).toEqual([]);
    // $32,901 of earned income or federal AGI gives none.
    expect(lines(californian({ wages: "32901" }), ["F3514.20"])).toEqual(["0"]);
  }, 120_000);

  it("works out a single renter's return from the W-2, with the exemption, renter's credit and withholding", () => {
    // $60,000: taxable $54,294; the table's row $54,251 to $54,350 is priced at $54,300.
    const input = californian({ wages: "60000", box17: "2500", answers: { caPaidRent: true } });
    expect(lines(input, ["F540.13", "F540.17", "F540.18", "F540.19", "F540.31", "F540.32", "F540.46", "F540.48", "F540.71", "F540.115", "F540.111"])).toEqual([
      "60000", "60000", "5706", "54294", String(Math.round(1022.01 + 0.06 * (54300 - 41452))), "153",
      // California AGI $60,000 is over the renter's credit limit of $53,994.
      "0", String(Math.round(1022.01 + 0.06 * (54300 - 41452)) - 153), "2500",
      String(2500 - (Math.round(1022.01 + 0.06 * (54300 - 41452)) - 153)), "0",
    ]);
    const renter = californian({ wages: "40000", answers: { caPaidRent: true } });
    expect(lines(renter, ["F540.46"])).toEqual(["60"]);
    expect(lines(californian({ wages: "90000", joint: true, answers: { caPaidRent: true } }), ["F540.46"])).toEqual(["120"]);
    // It can't be more than the tax: jointly on $40,000 the tax after exemption credits is $44.
    expect(lines(californian({ wages: "40000", joint: true, answers: { caPaidRent: true } }), ["F540.35", "F540.46"])).toEqual(["44", "44"]);
  });

  it("starts from federal AGI and changes it on Schedule CA: Treasury interest, other states' bonds, social security and the HSA", () => {
    const slips: EngineInput["slips"] = [
      { id: "i", person: "p1", type: "INT", issuer: "Treasury", boxes: { 1: "100", 3: "900", 8: "1000" } },
      { id: "s", person: "p1", type: "SSA", issuer: "Social Security Administration", boxes: { 5: "30000" } },
    ];
    const input = californian({
      wages: "50000",
      birthDate: "1958-02-02",
      slips,
      answers: { hasInterest: true, hasSocialSecurity: true, caBondInterest: "400", hasHsa: true, hsaContributions: "2000", hsaCoverage: "self", hsaAllYear: "yes", hsaNonMedical: "no", hsaEarnings: "150" },
    });
    const [agi, sixB, b2, c2, b13, b27, c27, l14, l16, l17] = lines(input, ["F540.13", "SCA.6B", "SCA.2B", "SCA.2C", "SCA.13B", "SCA.27B", "SCA.27C", "F540.14", "F540.16", "F540.17"]);
    expect([b2, c2, b13]).toEqual(["900", "750", "2000"]);
    expect(b27).toBe(String(900 + Number(sixB) - 2000));
    expect(c27).toBe("750");
    expect(l14).toBe(b27);
    expect(l16).toBe("750");
    expect(l17).toBe(String(Number(agi) - Number(b27) + 750));
    // Only tax-exempt interest asks how much is from California bonds.
    const questions = new Evaluation(rules, californian({ wages: "50000" })).result().people[0]!.questions;
    expect(questions).not.toContain("caBondInterest");
    expect(new Evaluation(rules, input).result().people[0]!.questions).toContain("caBondInterest");
  });

  it("limits the exemption credits by $6 for each $2,500 of federal AGI over $252,203, and itemized deductions by 6%", () => {
    // Single, $300,000 and no dependents: 20 steps of $2,500 ($47,797 over), $120 off the $153: 33.
    expect(lines(californian({ wages: "300000" }), ["CAL.creditSteps", "F540.32"])).toEqual(["20", "33"]);
    // Itemizing $20,000 of property tax and $10,000 of gifts: the smaller of 80% of $30,000 and 6% of $47,797.
    const itemizer = californian({ wages: "300000", answers: { hasItemized: true, itemMedical: "0", itemStateTax: "0", itemRealEstateTax: "20000", itemPersonalPropertyTax: "0", itemMortgageOther: "0", mortgageQualifies: "yes", itemCashGifts: "10000", itemNoncashGifts: "0" } });
    expect(lines(itemizer, ["SCA.28", "SCA.limitation", "SCA.29", "F540.18"])).toEqual(["30000", String(Math.round(0.06 * 47797)), String(30000 - Math.round(0.06 * 47797)), String(30000 - Math.round(0.06 * 47797))]);
  });

  it("drops the state income tax from Schedule A and has no $40,000 limit", () => {
    const input = californian({ wages: "900000", box17: "80000", answers: { hasItemized: true, itemMedical: "0", itemStateTax: "0", itemRealEstateTax: "45000", itemPersonalPropertyTax: "500", itemMortgageOther: "0", mortgageQualifies: "yes", itemCashGifts: "0", itemNoncashGifts: "0" } });
    expect(lines(input, ["SA.7", "SCA.5"])).toEqual(["10000", "45500"]);
  });

  it("adds the Behavioral Health Services Tax of 1% over $1,000,000 of taxable income", () => {
    expect(lines(californian({ wages: String(1_200_000 + 5706) }), ["F540.19", "F540.62"])).toEqual(["1200000", "2000"]);
  });

  it("gives the Young Child Tax Credit for a child under 6, reduced by $21.71 for each $100 over $27,425", () => {
    // $30,000: (30,000 - 27,425) / 100 = 25.75; 25.75 x 21.71 = 559.03; 1,189 - 559.03 = 629.97, so $630.
    const young = californian({ wages: "30000", children: 1, hoh: true, childBirthDate: "2021-03-03" });
    expect(lines(young, ["F3514.28", "F540.76"])).toEqual(["630", "630"]);
    expect(lines(californian({ wages: "20000", children: 1, hoh: true, childBirthDate: "2021-03-03" }), ["F3514.28"])).toEqual(["1189"]);
    // A child of 6 or older doesn't count.
    expect(lines(californian({ wages: "20000", children: 1, hoh: true, childBirthDate: "2019-01-01" }), ["F3514.28"])).toEqual(["0"]);
  });

  it("gives the Foster Youth Tax Credit from 18 to 25 with the California EITC", () => {
    const youth = californian({ wages: "15000", birthDate: "2003-04-04", answers: { fosterYouth: true } });
    expect(lines(youth, ["F3514.39", "F540.77"])).toEqual(["1189", "1189"]);
    expect(lines(californian({ wages: "15000", birthDate: "1995-04-04", answers: { fosterYouth: true } }), ["F3514.39"])).toEqual(["0"]);
  });

  it("works out the child care credit from Form 2441, at California's rate, for care in California", () => {
    const parent = (agi: string, inCalifornia = true) =>
      californian({
        wages: agi,
        children: 1,
        hoh: true,
        answers: { paidForCare: true, householdEmployer: false, priorYearCare: false, caCareInCalifornia: inCalifornia },
      });
    const withCare = (input: EngineInput) => {
      const child = input.family.dependants[0]!;
      child.answers = { ...child.answers, careExpenses: "3000" };
      return input;
    };
    // $35,000: federal decimal .25 (Form 2441, line 8), $750; California .50: $375.
    expect(lines(withCare(parent("35000")), ["F3506.8", "F3506.9", "F3506.12"])).toEqual(["750", "0.5", "375"]);
    // Over $100,000 of federal AGI, none.
    expect(lines(withCare(parent("100001")), ["F3506.12"])).toEqual(["0"]);
    expect(new Evaluation(rules, withCare(parent("35000", false))).line("p1", "F540.64").status).toBe("missing");
  });

  it("works out Schedule P's tentative minimum tax, and the AMT when it is larger than the regular tax", () => {
    // Standard deduction added back: AMTI $5,706 more than taxable income.
    const [taxable, amti, exemption, tmt, amt] = lines(californian({ wages: "200000" }), ["F540.19", "SP.21", "SP.22", "SP.24", "F540.61"]);
    expect(amti).toBe(String(Number(taxable) + 5706));
    expect(exemption).toBe("92749");
    expect(tmt).toBe(String(Math.round((Number(amti) - 92749) * 0.07)));
    expect(amt).toBe("0");
    // Large property taxes, which the AMT adds back, make the AMT larger than the regular tax.
    const property = californian({ wages: "400000", answers: { hasItemized: true, itemMedical: "0", itemStateTax: "0", itemRealEstateTax: "150000", itemPersonalPropertyTax: "0", itemMortgageOther: "0", mortgageQualifies: "yes", itemCashGifts: "0", itemNoncashGifts: "0" } });
    const [regular, tentative, minimum] = lines(property, ["F540.31", "SP.24", "F540.61"]);
    expect(Number(tentative)).toBeGreaterThan(Number(regular));
    expect(minimum).toBe(String(Number(tentative) - Number(regular)));
  });

  it("adds 2.5% of an early distribution", () => {
    const input = californian({
      wages: "50000",
      answers: { hasIraDistribution: true, iraBasis: false, indirectRollover: false, earlyException: false },
      slips: [{ id: "r", person: "p1", type: "RIRA", issuer: "Broker", boxes: { 1: "10000", "2A": "10000", 4: "0", 7: "1", 14: "0", 15: "CA" } }],
    });
    expect(lines(input, ["S2.8", "F540.63"])).toEqual(["1000", "250"]);
  });

  it("is filed only by a California resident, the person preparing's on a joint return", () => {
    const texan = new Evaluation(rules, californian({ wages: "60000", state: "TX" })).result();
    expect(texan.people[0]!.lines.map((line) => line.id).filter((id) => id.startsWith("F540"))).toEqual([]);
    const couple = new Evaluation(rules, californian({ wages: "60000", joint: true })).result();
    expect(couple.people[0]!.lines.map((line) => line.id)).toContain("F540.115");
    expect(couple.people[1]!.lines.map((line) => line.id)).not.toContain("F540.115");
  });

  it("says what it doesn't handle on the California return, and leaves the federal return complete", () => {
    const status = (input: EngineInput) => {
      const evaluation = new Evaluation(rules, input);
      return [evaluation.line("p1", "F1040.24").status, evaluation.line("p1", "F540.64").status, evaluation.result().people[0]!.unhandled.join(" ")];
    };
    const partYear = status(californian({ wages: "60000", answers: { livedInCaliforniaAllYear: false } }));
    // The federal return is worked out (an estimate here, as the fixture leaves some defaults); California's isn't.
    expect(partYear[0]).not.toBe("missing");
    expect(partYear[1]).toBe("missing");
    expect(partYear[2]).toContain("Form 540NR");
    expect(status(californian({ wages: "60000", joint: true, spouseState: "NV" }))[2]).toContain("540NR");
    expect(status(californian({ wages: "60000", box15: "OR", box17: "900" }))[2]).toContain("another state");
    expect(status(californian({ wages: "60000", answers: { caFullYearCoverage: false } }))[2]).toContain("FTB 3853");
  });

  it("says a separate return in a community property state isn't handled, on the federal return too", () => {
    const separate = new Evaluation(rules, californian({ wages: "60000", married: true, answers: { livedApartLastSixMonths: false } }));
    expect(separate.line("p1", "F1040.24").status).toBe("missing");
    expect(separate.result().people[0]!.unhandled.join(" ")).toContain("Form 8958");
    // In a state without community property, filing separately is worked out as before.
    expect(new Evaluation(rules, californian({ wages: "60000", married: true, state: "NY" })).line("p1", "F1040.24").status).not.toBe("missing");
  });
});
