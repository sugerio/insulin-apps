import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// The 2025 New York return (rules/us/2025/new-york.yaml) against the Department of Taxation and Finance's own numbers:
// every row of the 2025 New York State and New York City Tax Tables, every cell of the household credit tables and of
// the child and dependent care credit limitation tables, the tax computation worksheets, the credits, and what the New
// York return says it doesn't handle instead of giving a wrong amount.

const rules = rulesFor("us", 2025)!;
const read = <T>(name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, name), "utf8")) as T;

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
  canBeClaimed: false,
  isBlind: false,
  estimatedPayments: "0",
};
/** What a New York resident answers that the federal return doesn't ask. */
const NEW_YORKER = {
  livedInNewYorkAllYear: true,
  nySalesTax: "0",
  nyEstimatedPayments: "0",
  nyPublicRetirement: "0",
  nyOtherAdditions: false,
  nyOtherSubtractions: false,
  nyGovernmentPension: "0",
  ny529: "0",
};

type Kid = { birthDate: string; answers?: Record<string, string | boolean> };

/** A New York resident with one W-2 from a New York employer (box 15 NY). */
function newYorker(options: {
  wages: string;
  locality?: "elsewhere" | "nyc" | "yonkers" | "partYear";
  joint?: boolean;
  married?: boolean;
  hoh?: boolean;
  kids?: Kid[];
  /** Filing separately: the spouse's dependants are on their own return (their wages are 0). */
  spouseKids?: Kid[];
  spouseWages?: string;
  birthDate?: string;
  state?: string;
  spouseState?: string;
  answers?: Record<string, string | boolean>;
  spouseAnswers?: Record<string, string | boolean>;
  box15?: string;
  box17?: string;
  box19?: string;
  box20?: string;
  slips?: EngineInput["slips"];
}): EngineInput {
  const married = options.married || options.joint;
  const kids = options.kids ?? (options.hoh ? [{ birthDate: "2015-01-01" }] : []);
  const kid = (each: Kid, index: number, claimedBy?: string) => ({
    id: `${claimedBy ?? "d"}${index}`,
    name: `Kid ${index + 1}`,
    birthDate: each.birthDate,
    ...(claimedBy ? { claimedBy } : {}),
    answers: {
      relationship: "child",
      monthsWithYou: "12",
      hasSSN: true,
      paidOwnSupport: false,
      filedJointReturn: false,
      citizenOrResident: true,
      fullTimeStudent: false,
      disabled: false,
      ...each.answers,
    },
  });
  return {
    country: "us",
    year: 2025,
    people: [
      { id: "p1", name: "Alex", role: "self", birthDate: options.birthDate ?? "1990-05-05", province: options.state ?? "NY", residentAllYear: true },
      ...(married ? [{ id: "p2", name: "Sam", role: "spouse" as const, birthDate: "1991-06-06", province: options.spouseState ?? options.state ?? "NY", residentAllYear: true }] : []),
    ],
    family: {
      maritalStatus: married ? "married" : "single",
      ...(married ? { filingStatus: options.joint ? "joint" : "separate" } : {}),
      dependants: [...kids.map((each, index) => kid(each, index)), ...(options.spouseKids ?? []).map((each, index) => kid(each, index, "p2"))],
    },
    answers: {
      p1: {
        ...NO,
        ...NEW_YORKER,
        nyLocality: options.locality ?? "elsewhere",
        spouseItemizes: false,
        paidHalfOfHome: true,
        paidForCare: false,
        livedApartLastSixMonths: false,
        ...options.answers,
      },
      ...(married
        ? {
            p2: {
              ...NO,
              ...NEW_YORKER,
              nyLocality: options.locality ?? "elsewhere",
              hasWages: options.spouseWages !== undefined,
              hasInterest: false,
              spouseItemizes: false,
              paidHalfOfHome: true,
              paidForCare: false,
              livedApartLastSixMonths: false,
              ...options.spouseAnswers,
            },
          }
        : {}),
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
          15: options.box15 ?? "NY",
          16: options.wages,
          17: options.box17 ?? "0",
          ...(options.box19 ? { 19: options.box19 } : {}),
          ...(options.box20 ? { 20: options.box20 } : {}),
        },
      },
      ...(options.spouseWages !== undefined
        ? [{ id: "w2", person: "p2", type: "W2", issuer: "Beta", boxes: { 1: options.spouseWages, 2: "0", 5: options.spouseWages, 6: "0", 15: "NY", 16: options.spouseWages, 17: "0" } }]
        : []),
      ...(options.slips ?? []),
    ],
  };
}

const value = (input: EngineInput, id: string, person = "p1") => new Evaluation(rules, input).line(person, id).value?.toString() ?? null;
const values = (input: EngineInput, ids: string[]) => {
  const evaluation = new Evaluation(rules, input);
  return Object.fromEntries(ids.map((id) => [id, evaluation.line("p1", id).value?.toString() ?? null]));
};

// The tax rate schedules and worksheets as the Instructions print them (pages 33 to 40), to check the rules against.
type Schedule = [over: number, base: number, rate: number][];
const NYS_SCHEDULES: Record<"single" | "joint" | "head", Schedule> = {
  joint: [[0, 0, 0.04], [17150, 686, 0.045], [23600, 976, 0.0525], [27900, 1202, 0.055], [161550, 8553, 0.06], [323200, 18252, 0.0685], [2155350, 143754, 0.0965], [5000000, 418263, 0.103], [25000000, 2478263, 0.109]],
  single: [[0, 0, 0.04], [8500, 340, 0.045], [11700, 484, 0.0525], [13900, 600, 0.055], [80650, 4271, 0.06], [215400, 12356, 0.0685], [1077550, 71413, 0.0965], [5000000, 449929, 0.103], [25000000, 2509929, 0.109]],
  head: [[0, 0, 0.04], [12800, 512, 0.045], [17650, 730, 0.0525], [20900, 901, 0.055], [107650, 5672, 0.06], [269300, 15371, 0.0685], [1616450, 107651, 0.0965], [5000000, 434163, 0.103], [25000000, 2494163, 0.109]],
};
const scheduled = (schedule: Schedule, amount: number) => {
  const [over, base, rate] = [...schedule].reverse().find(([from]) => amount > from) ?? schedule[0]!;
  return base + rate * (amount - over);
};
// Each worksheet: [the most taxable income it is for, the excess is over, recapture base, incremental benefit]; the
// first is the flat-rate worksheet.
const WORKSHEETS: Record<"single" | "joint" | "head", { flat: number; rows: [number, number, number, number][] }> = {
  joint: { flat: 0.055, rows: [[161550, 107650, 0, 0], [323200, 161550, 333, 807], [2155350, 323200, 1140, 2747], [5000000, 2155350, 3887, 60350], [Infinity, 5000000, 64237, 32500]] },
  single: { flat: 0.06, rows: [[215400, 107650, 0, 0], [1077550, 215400, 568, 1831], [5000000, 1077550, 2399, 30172], [Infinity, 5000000, 32571, 32500]] },
  head: { flat: 0.06, rows: [[269300, 107650, 0, 0], [1616450, 269300, 787, 2289], [5000000, 1616450, 3076, 45261], [Infinity, 5000000, 48337, 32500]] },
};
const round4 = (amount: number) => Math.round(amount * 10000) / 10000;
const worksheetTax = (status: "single" | "joint" | "head", agi: number, taxable: number) => {
  if (agi > 25_000_000) return Math.round(taxable * 0.109);
  const tax = scheduled(NYS_SCHEDULES[status], taxable);
  const { flat, rows } = WORKSHEETS[status];
  const [, over, base, benefit] = rows.find(([upTo]) => taxable <= upTo)!;
  const share = round4(Math.min(agi - over, 50000) / 50000);
  return Math.round(over === 107650 ? tax + (taxable * flat - tax) * share : tax + base + benefit * share);
};

const STANDARD = { single: 8000, joint: 16050, head: 11200 } as const;
const status = (name: "single" | "joint" | "head") => (name === "joint" ? { joint: true } : name === "head" ? { hoh: true } : {});
/** Wages that give this taxable income: the standard deduction, and the head of household's dependent exemption. */
const wagesFor = (name: "single" | "joint" | "head", taxable: number) => String(taxable + STANDARD[name] + (name === "head" ? 1000 : 0));

describe("the 2025 New York return", () => {
  it("gives the New York State Tax Table's tax for every row, at both ends, for each filing status column", () => {
    const table = read<{ nys: number[][] }>("us-2025-ny-tax-table.json");
    const wrong: string[] = [];
    for (const [from, to, single, joint, head] of table.nys as [number, number, number, number, number][]) {
      for (const taxable of [from, to - 1]) {
        for (const [name, expected] of [["single", single], ["joint", joint], ["head", head]] as const) {
          const evaluation = new Evaluation(rules, newYorker({ wages: wagesFor(name, taxable), ...status(name) }));
          const got = evaluation.line("p1", "IT201.38").value?.toString();
          if (got !== String(taxable)) wrong.push(`${taxable} ${name}: taxable income ${got}`);
          const tax = evaluation.line("p1", "IT201.39").value?.toString();
          if (tax !== String(expected)) wrong.push(`${taxable} ${name}: ${tax}, the table says ${expected}`);
        }
      }
    }
    expect(table.nys).toHaveLength(1302);
    expect(wrong.slice(0, 10)).toEqual([]);
  }, 300_000);

  it("gives the New York City Tax Table's tax for every row, at both ends, for each filing status column", () => {
    const table = read<{ nyc: number[][] }>("us-2025-ny-tax-table.json");
    const wrong: string[] = [];
    for (const [from, to, single, joint, head] of table.nyc as [number, number, number, number, number][]) {
      for (const taxable of [from, to - 1]) {
        for (const [name, expected] of [["single", single], ["joint", joint], ["head", head]] as const) {
          const tax = value(newYorker({ wages: wagesFor(name, taxable), locality: "nyc", ...status(name) }), "IT201.47a");
          if (tax !== String(expected)) wrong.push(`${taxable} ${name}: ${tax}, the table says ${expected}`);
        }
      }
    }
    expect(table.nyc).toHaveLength(1302);
    expect(wrong.slice(0, 10)).toEqual([]);
  }, 300_000);

  it("uses the tax rate schedules from $65,000 of taxable income, and the tax computation worksheets over $107,650 of New York AGI", () => {
    const tax = (name: "single" | "joint" | "head", taxable: number) => value(newYorker({ wages: wagesFor(name, taxable), ...status(name) }), "IT201.39");
    // New York AGI of $107,650 or less: the schedule, with its printed bases.
    expect(tax("single", 70000)).toBe(String(Math.round(scheduled(NYS_SCHEDULES.single, 70000))));
    expect(tax("joint", 80000)).toBe(String(Math.round(scheduled(NYS_SCHEDULES.joint, 80000))));
    // Over $107,650: each worksheet, from the flat rate phasing in to the recapture of the higher brackets.
    for (const [name, taxable] of [
      ["single", 110000],
      ["single", 160000],
      ["single", 250000],
      ["single", 1200000],
      ["joint", 100000],
      ["joint", 150000],
      ["joint", 200000],
      ["joint", 350000],
      ["joint", 2300000],
      ["head", 120000],
      ["head", 300000],
      ["head", 6000000],
    ] as const) {
      const agi = taxable + STANDARD[name] + (name === "head" ? 1000 : 0);
      expect(`${name} ${taxable}: ${tax(name, taxable)}`).toBe(`${name} ${taxable}: ${worksheetTax(name, agi, taxable)}`);
    }
    // Over $25,000,000 of New York AGI: 10.9% of all of it.
    expect(tax("single", 26000000)).toBe(String(Math.round(26000000 * 0.109)));
  });

  it("gives the New York City tax rate schedule from $65,000 of New York City taxable income", () => {
    const tax = (name: "single" | "joint" | "head", taxable: number) =>
      value(newYorker({ wages: wagesFor(name, taxable), locality: "nyc", ...status(name) }), "IT201.47a");
    expect(tax("single", 65000)).toBe(String(Math.round(1813 + 0.03876 * (65000 - 50000))));
    expect(tax("joint", 150000)).toBe(String(Math.round(3264 + 0.03876 * (150000 - 90000))));
    expect(tax("head", 70000)).toBe(String(Math.round(2176 + 0.03876 * (70000 - 60000))));
  });

  it("gives every cell of the household credit tables (1 to 6)", () => {
    // The tables as printed: rows by federal AGI, columns by people (1 to 7, then the "over 7" amount for each more).
    const nysTable2: [number, number[]][] = [
      [5000, [90, 105, 120, 135, 150, 165, 180, 15]],
      [6000, [75, 90, 105, 120, 135, 150, 165, 15]],
      [7000, [65, 80, 95, 110, 125, 140, 155, 15]],
      [20000, [60, 75, 90, 105, 120, 135, 150, 15]],
      [22000, [60, 70, 80, 90, 100, 110, 120, 10]],
      [25000, [50, 60, 70, 80, 90, 100, 110, 10]],
      [28000, [40, 45, 50, 55, 60, 65, 70, 5]],
      [32000, [20, 25, 30, 35, 40, 45, 50, 5]],
    ];
    const nysTable3: [number, number[]][] = [
      [5000, [45, 53, 60, 68, 75, 83, 90, 8]],
      [6000, [38, 45, 53, 60, 68, 75, 83, 8]],
      [7000, [33, 40, 48, 55, 63, 70, 78, 8]],
      [20000, [30, 38, 45, 53, 60, 68, 75, 8]],
      [22000, [30, 35, 40, 45, 50, 55, 60, 5]],
      [25000, [25, 30, 35, 40, 45, 50, 55, 5]],
      [28000, [20, 23, 25, 28, 30, 33, 35, 3]],
      [32000, [10, 13, 15, 18, 20, 23, 25, 3]],
    ];
    const nycTable5: [number, number[]][] = [
      [15000, [30, 60, 90, 120, 150, 180, 210, 30]],
      [17500, [25, 50, 75, 100, 125, 150, 175, 25]],
      [20000, [15, 30, 45, 60, 75, 90, 105, 15]],
      [22500, [10, 20, 30, 40, 50, 60, 70, 10]],
    ];
    const nycTable6: [number, number[]][] = [
      [15000, [15, 30, 45, 60, 75, 90, 105, 15]],
      [17500, [13, 25, 38, 50, 63, 75, 88, 13]],
      [20000, [8, 15, 23, 30, 38, 45, 53, 8]],
      [22500, [5, 10, 15, 20, 25, 30, 35, 5]],
    ];
    const cell = (columns: number[], people: number) => (people <= 7 ? columns[people - 1]! : columns[6]! + columns[7]! * (people - 7));
    const kids = (count: number) => Array.from({ length: count }, () => ({ birthDate: "2015-01-01" }));
    const wrong: string[] = [];
    // Table 2 and 5, filing jointly: 2 to 9 people.
    for (const [agi, columns] of nysTable2) {
      for (let people = 2; people <= 9; people++) {
        const got = value(newYorker({ wages: String(agi), joint: true, kids: kids(people - 2) }), "IT201.40");
        if (got !== String(cell(columns, people))) wrong.push(`table 2, ${agi}, ${people}: ${got}`);
      }
    }
    for (const [agi, columns] of nycTable5) {
      for (let people = 2; people <= 9; people++) {
        const got = value(newYorker({ wages: String(agi), joint: true, locality: "nyc", kids: kids(people - 2) }), "IT201.48");
        if (got !== String(cell(columns, people))) wrong.push(`table 5, ${agi}, ${people}: ${got}`);
      }
    }
    // Table 3 and 6, filing separately: both spouses' federal AGI (the spouse's is 0) and both returns' dependents.
    for (const [agi, columns] of nysTable3) {
      for (let people = 2; people <= 9; people++) {
        const got = value(newYorker({ wages: String(agi), married: true, kids: kids(people - 2) }), "IT201.40");
        if (got !== String(cell(columns, people))) wrong.push(`table 3, ${agi}, ${people}: ${got}`);
      }
    }
    for (const [agi, columns] of nycTable6) {
      for (let people = 2; people <= 9; people++) {
        const got = value(newYorker({ wages: String(agi), married: true, locality: "nyc", kids: kids(people - 2) }), "IT201.48");
        if (got !== String(cell(columns, people))) wrong.push(`table 6, ${agi}, ${people}: ${got}`);
      }
    }
    // Tables 1 and 4, Single.
    for (const [agi, credit] of [[5000, 75], [6000, 60], [7000, 50], [20000, 45], [25000, 40], [28000, 20], [28001, 0]]) {
      const got = value(newYorker({ wages: String(agi) }), "IT201.40");
      if (got !== String(credit)) wrong.push(`table 1, ${agi}: ${got}`);
    }
    for (const [agi, credit] of [[10000, 15], [12500, 10], [12501, 0]]) {
      const got = value(newYorker({ wages: String(agi), locality: "nyc" }), "IT201.48");
      if (got !== String(credit)) wrong.push(`table 4, ${agi}: ${got}`);
    }
    expect(wrong).toEqual([]);
    // No household credit for someone another taxpayer can claim.
    expect(value(newYorker({ wages: "6000", answers: { canBeClaimed: true } }), "IT201.40")).toBe("0");
  }, 120_000);

  it("gives every row of the child and dependent care credit limitation tables", () => {
    const table = read<{ nys: [number, number | null, string][]; nyc: [number, number | null, string][] }>("us-2025-ny-care-table.json");
    const wrong: string[] = [];
    for (const [, to, decimal] of table.nys) {
      const agi = to ?? 200000;
      const got = value(newYorker({ wages: String(agi) }), "IT216.13");
      if (Number(got) !== Number(decimal)) wrong.push(`New York State, ${agi}: ${got}, the table says ${decimal}`);
    }
    for (const [, to, decimal] of table.nyc) {
      const agi = to ?? 40000;
      const got = value(newYorker({ wages: String(agi), locality: "nyc" }), "NYS.nycCareDecimal");
      if (Number(got) !== Number(decimal)) wrong.push(`New York City, ${agi}: ${got}, the table says ${decimal}`);
    }
    expect([table.nys.length, table.nyc.length]).toEqual([154, 27]);
    expect(wrong).toEqual([]);
  }, 60_000);

  it("works out the Empire State child credit, the earned income credits and the New York City credits", () => {
    // Married filing jointly, children of 2 and 10, federal AGI $120,000: $1,000 + $330, less 1.65% of $10,000.
    expect(value(newYorker({ wages: "120000", joint: true, kids: [{ birthDate: "2023-03-03" }, { birthDate: "2015-01-01" }] }), "IT201.63")).toBe("1165");
    // Head of household in New York City with a child of 3 and $15,000 of wages.
    const low = values(newYorker({ wages: "15000", hoh: true, locality: "nyc", kids: [{ birthDate: "2022-03-03" }] }), [
      "F1040.27a",
      "IT201.33",
      "IT201.39",
      "IT201.40",
      "IT215.12",
      "IT201.65",
      "IT201.70",
      "IT201.63",
      "IT201.54",
      "IT201.70a",
    ]);
    const federalEic = Number(low["F1040.27a"]);
    expect(federalEic).toBeGreaterThan(0);
    expect(low["IT215.12"]).toBe(String(Math.round(federalEic * 0.3)));
    expect(low["IT201.65"]).toBe(String(Number(low["IT215.12"]) - Math.min(Number(low["IT201.39"]), Number(low["IT201.40"]))));
    // New York AGI of $15,000: the New York City rate is .25 less .00002 for each dollar over $14,999.
    expect(low["IT201.70"]).toBe(String(Math.round(federalEic * (0.25 - round4((15000 - 14999) * 0.00002)))));
    expect(low["IT201.63"]).toBe("1000");
    // Federal AGI under the IT-270 threshold for one dependent ($31,503): the New York City tax left after the
    // refundable care credit and the New York City EIC, all of it.
    expect(low["IT201.70a"]).toBe(String(Math.max(0, Number(low["IT201.54"]) - Number(low["IT201.70"]))));
  });

  it("works out the Yonkers surcharge, the MCTMT and the New York City school tax credits", () => {
    const yonkers = values(newYorker({ wages: "80000", locality: "yonkers" }), ["IT201.46", "IT201.55"]);
    expect(yonkers["IT201.55"]).toBe(String(Math.round(Number(yonkers["IT201.46"]) * 0.1675)));
    const expenses = ["Advertising", "Car", "ContractLabor", "Insurance", "Professional", "Office", "Rent", "Supplies", "Travel", "Meals", "Utilities", "OtherExpenses"];
    const selfEmployed = (zone: string) =>
      newYorker({
        wages: "1",
        locality: "nyc",
        answers: {
          hasSelfEmployment: true,
          businessIncome: "120000",
          businessExtras: "none",
          ...Object.fromEntries(expenses.map((name) => [`business${name}`, "0"])),
          nyBusinessZone: zone,
        },
      });
    const zone1 = values(selfEmployed("zone1"), ["SE.6", "IT201.54a", "IT201.54c", "IT201.54e"]);
    expect(zone1["IT201.54a"]).toBe(String(Math.round(Number(zone1["SE.6"]))));
    expect(zone1["IT201.54c"]).toBe(String(Math.round(Number(zone1["IT201.54a"]) * 0.006)));
    const zone2 = values(selfEmployed("zone2"), ["IT201.54b", "IT201.54d"]);
    expect(zone2["IT201.54d"]).toBe(String(Math.round(Number(zone2["IT201.54b"]) * 0.0034)));
    expect(values(selfEmployed("outside"), ["IT201.54e"])["IT201.54e"]).toBe("0");
    // School tax credits: $125 filing jointly, and 0.171% then 0.228% of New York City taxable income.
    const school = values(newYorker({ wages: "60000", joint: true, locality: "nyc" }), ["IT201.47", "IT201.69", "IT201.69a"]);
    expect(school["IT201.69"]).toBe("125");
    expect(school["IT201.69a"]).toBe(String(Math.round(37 + 0.00228 * (Number(school["IT201.47"]) - 21600))));
  });

  it("adds and subtracts New York's modifications", () => {
    // A retiree over 59½ with $30,000 of IRA distributions, $5,000 of it a federal pension: line 26, and $20,000 more
    // excluded on line 29; social security subtracted (line 27).
    const retiree = values(
      newYorker({
        wages: "10000",
        birthDate: "1955-02-02",
        answers: { hasIraDistribution: true, hasSocialSecurity: true, nyGovernmentPension: "5000", iraBasis: false, indirectRollover: false },
        slips: [
          { id: "r", person: "p1", type: "RIRA", issuer: "IRA Co", boxes: { 1: "30000", "2A": "30000", 4: "0", 7: "7" } },
          { id: "s", person: "p1", type: "SSA", issuer: "Social Security Administration", boxes: { 3: "24000", 5: "24000" } },
        ],
      }),
      ["IT201.9", "IT201.15", "IT201.26", "IT201.27", "IT201.29", "IT201.32", "IT201.33", "IT201.19"],
    );
    expect(retiree["IT201.26"]).toBe("5000");
    expect(retiree["IT201.29"]).toBe("20000");
    expect(retiree["IT201.27"]).toBe(retiree["IT201.15"]);
    expect(retiree["IT201.33"]).toBe(String(Number(retiree["IT201.19"]) - Number(retiree["IT201.32"])));
    // Interest on U.S. obligations subtracted; tax-exempt interest from other states' bonds added.
    const interest = values(
      newYorker({
        wages: "50000",
        answers: { hasInterest: true, nyBondInterest: "300" },
        slips: [{ id: "i", person: "p1", type: "INT", issuer: "Bank", boxes: { 1: "1000", 3: "400", 8: "500" } }],
      }),
      ["IT201.20", "IT201.28"],
    );
    expect(interest).toEqual({ "IT201.20": "200", "IT201.28": "400" });
  });

  it("works out Form IT-196 and takes the larger of it and the standard deduction", () => {
    const itemizer = values(
      newYorker({
        wages: "150000",
        answers: {
          hasItemized: true,
          itemMedical: "20000",
          itemStateTax: "9000",
          itemRealEstateTax: "45000",
          itemPersonalPropertyTax: "0",
          itemMortgageOther: "0",
          itemCashGifts: "2000",
          itemNoncashGifts: "0",
        },
      }),
      ["IT196.4", "IT196.9", "IT196.41", "IT196.45", "IT196.46", "IT196.49", "IT201.34", "NYS.itemizes", "IT201.33"],
    );
    // Medical over 10% of federal AGI; no $40,000 limit on taxes; the income taxes taken back out.
    expect(itemizer["IT196.4"]).toBe("5000");
    expect(itemizer["IT196.9"]).toBe("54000");
    expect(itemizer["IT196.41"]).toBe("9000");
    expect(itemizer["IT196.45"]).toBe(String(5000 + 54000 - 9000 + 2000));
    // New York AGI of $150,000, single: 25% of line 45 phased in over $50,000 above $100,000.
    expect(itemizer["IT196.46"]).toBe(String(Math.round(round4(50000 / 50000) * Math.round(52000 * 0.25))));
    expect(itemizer["NYS.itemizes"]).toBe("1");
  });

  it("gives the college tuition credit", () => {
    const student = (tuition: string) =>
      newYorker({
        wages: "70000",
        hoh: true,
        kids: [{ birthDate: "2006-01-01", answers: { fullTimeStudent: true, studentExpenses: "12000", studentCredit: "aotc", nyStudentTuition: tuition } }],
        answers: { paidForEducation: true, educationExpenses: "0" },
      });
    expect(value(student("8000"), "IT201.68")).toBe("320");
    expect(value(student("3000"), "IT201.68")).toBe("200");
    expect(value(student("150"), "IT201.68")).toBe("150");
    expect(value(student("14000"), "IT201.68")).toBe("400");
  });

  it("says what it doesn't handle on the New York return, and leaves the federal return complete", () => {
    const check = (input: EngineInput) => {
      const evaluation = new Evaluation(rules, input);
      return [evaluation.line("p1", "F1040.24").status, evaluation.line("p1", "IT201.62").status, evaluation.result().people[0]!.unhandled.join(" ")];
    };
    const partYear = check(newYorker({ wages: "60000", answers: { livedInNewYorkAllYear: false } }));
    expect(partYear[0]).not.toBe("missing");
    expect(partYear[1]).toBe("missing");
    expect(partYear[2]).toContain("Form IT-203");
    expect(check(newYorker({ wages: "60000", joint: true, spouseState: "NJ" }))[2]).toContain("IT-203");
    expect(check(newYorker({ wages: "60000", locality: "partYear" }))[2]).toContain("IT-360.1");
    expect(check(newYorker({ wages: "60000", joint: true, locality: "nyc", spouseAnswers: { nyLocality: "elsewhere" } }))[2]).toContain("different places");
    expect(check(newYorker({ wages: "60000", box15: "NJ", box17: "900" }))[2]).toContain("IT-112-R");
    expect(check(newYorker({ wages: "60000", box19: "300" }))[2]).toContain("box 20");
    expect(check(newYorker({ wages: "60000", box19: "300", box20: "YONKERS" }))[2]).toContain("Y-203");
    expect(check(newYorker({ wages: "60000", answers: { nyOtherAdditions: true } }))[2]).toContain("IT-225");
    expect(check(newYorker({ wages: "12000", answers: { nyRealPropertyCredit: true } }))[2]).toContain("IT-214");
    // New York City and Yonkers withholding count when the locality is named.
    expect(value(newYorker({ wages: "60000", locality: "nyc", box19: "1200", box20: "NYC" }), "IT201.73")).toBe("1200");
  });
});
