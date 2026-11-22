import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES_ROOT, readYear } from "../../scripts/rules-source.ts";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import { fillForms, personalFacts } from "../../src/app/shared/engine/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// The provincial and territorial forms for a couple who live in two provinces, and for someone who lived in Canada
// for part of the year.

const rules = rulesFor(2025)!;
const JURISDICTIONS = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
type Answers = Record<string, string | boolean>;
const child = { id: "d1", name: "Jamie", birthDate: "2018-05-05" };

const couple = (provinces: [string, string], answers: [Answers, Answers] = [{}, {}], births = ["1985-04-02", "1987-09-15"]) =>
  new Evaluation(rules, {
    year: 2025,
    people: [
      { id: "p1", name: "Alex", role: "self", birthDate: births[0]!, province: provinces[0] },
      { id: "p2", name: "Sam", role: "spouse", birthDate: births[1]!, province: provinces[1] },
    ],
    family: { maritalStatus: "married", dependants: [child] },
    answers: { p1: answers[0], p2: answers[1] },
    slips: [],
  });
const amount = (evaluation: Evaluation, person: string, line: string) => evaluation.line(person, line).value?.toString() ?? null;

/**
 * The questions each jurisdiction's return reads for the person whose return it is: those its own rule files read
 * (`answer.x` in a line, not `spouse.answer.x`) and the federal rules read, and the question about each kind of slip
 * whose boxes they read.
 */
function questionsOfEachReturn(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const file of readYear(join(RULES_ROOT, "ca/2025")).files) {
    const read = new Set<string>();
    for (const { formula } of Object.values((file.data as { lines?: Record<string, { formula: unknown }> }).lines ?? {})) {
      for (const [, id] of String(formula).matchAll(/(?<![\w.])answer\.(\w+)/g)) read.add(id!);
      for (const [, slip] of String(formula).matchAll(/(?<![\w.])([A-Z][A-Z0-9]*)\.box\w+/g)) {
        for (const question of rules.questions.values()) if (question.slip === slip) read.add(question.id);
      }
    }
    byFile.set(basename(file.path, ".yaml"), read);
  }
  const files = (jurisdiction: string) => (jurisdiction === "QC" ? ["qc", "qc-credits"] : [jurisdiction.toLowerCase()]);
  return new Map(
    JURISDICTIONS.map((jurisdiction) => [jurisdiction, new Set(["federal", ...files(jurisdiction)].flatMap((file) => [...byFile.get(file)!]))]),
  );
}

describe("a couple living in two provinces", () => {
  it("ask each spouse only what their own province's return and the federal return read", () => {
    const own = questionsOfEachReturn();
    const everyYes = Object.fromEntries(
      [...rules.questions.values()].map((question) => [question.id, question.type === "boolean" ? true : question.type === "choice" ? question.options![0]! : "100"]),
    );
    // Nothing answered; every yes/no question answered yes and every amount 100; and nothing answered at 67, when
    // each spouse has an age amount to transfer.
    const cases: { answers: Answers; births?: string[] }[] = [{ answers: {} }, { answers: everyYes }, { answers: {}, births: ["1958-04-02", "1958-09-15"] }];
    const foreign = new Map<string, Set<string>>();
    for (const { answers, births } of cases) {
      for (const first of JURISDICTIONS) {
        for (const second of JURISDICTIONS) {
          if (first === second) continue;
          const result = couple([first, second], [answers, answers], births).result();
          result.people.forEach((person, index) => {
            const [province, other] = index === 0 ? [first, second] : [second, first];
            const key = `${province} return, spouse in ${other}`;
            for (const question of person.questions) if (!own.get(province)!.has(question)) foreign.set(key, (foreign.get(key) ?? new Set()).add(question));
          });
        }
      }
    }
    const pairs = [...foreign].map(([pair, questions]) => `${pair}: ${[...questions].join(", ")}`).sort();
    expect({ count: pairs.length, pairs }).toEqual({ count: 0, pairs: [] });
  });

  it("share a credit's limit only with a spouse who claims the same province's credit", () => {
    // Quebec's credit for children's activities reads the same question as Saskatchewan's active families benefit.
    const saskQuebec = couple(["SK", "QC"], [{ childActivityFees: "300" }, { childActivityFees: "200" }]);
    expect(amount(saskQuebec, "p1", "SK479.7")).toBe("300");
    const bothSask = couple(["SK", "SK"], [{ childActivityFees: "300" }, { childActivityFees: "200" }]);
    expect(bothSask.line("p1", "SK479.7")).toEqual({ value: null, status: "missing" });

    // Manitoba's children's arts amount reads the same question as Yukon's: each claims up to $500 for the child.
    const yukonManitoba = couple(["YT", "MB"], [{ childArtsFees: "500" }, { childArtsFees: "500" }]);
    expect([amount(yukonManitoba, "p1", "YT428.22"), amount(yukonManitoba, "p2", "MB428.26")]).toEqual(["500", "500"]);
    // Both in Yukon, they share the $500.
    const bothYukon = couple(["YT", "YT"], [{ childArtsFees: "500" }, { childArtsFees: "500" }]);
    expect([amount(bothYukon, "p1", "YT428.22"), amount(bothYukon, "p2", "YT428.22")]).toEqual(["250", "250"]);

    // Ontario's and Saskatchewan's fertility treatment credits: each spouse claims their own province's.
    const ontarioSask = couple(["ON", "SK"], [{ fertilityExpenses: "4000", medicalExpenses: "4000" }, { fertilityExpenses: "3000" }]);
    expect([amount(ontarioSask, "p1", "ON479.1"), amount(ontarioSask, "p2", "SK479.9")]).toEqual(["1000", "1500"]);
  });

  it("claim a spouse's donations on the TP-1 from their federal receipts when they live outside Quebec", () => {
    const quebecClaims = couple(["QC", "ON"], [{ donations: "300", claimSpouseDonations: true }, { donations: "500", claimSpouseDonations: false }]);
    expect(amount(quebecClaims, "p1", "TP1.393")).toBe("800");
    // The spouse in Ontario has no Quebec slips to be asked about.
    for (const question of ["hasRl1", "hasRl2", "hasRl8"]) expect(quebecClaims.result().people[1]!.questions).not.toContain(question);
    // When the spouse in Ontario claims both on their federal return, the TP-1 still claims its own donations: they
    // have no TP-1 to claim them on.
    const ontarioClaims = couple(["QC", "ON"], [{ donations: "300", claimSpouseDonations: false }, { donations: "500", claimSpouseDonations: true }]);
    expect(amount(ontarioClaims, "p1", "TP1.393")).toBe("300");
  });
});

describe("someone who lived in Canada for part of the year", () => {
  // 90% of the income while not resident wasn't from Canada, so the personal amounts are prorated by the days in Canada.
  const partYear = (days: string) => ({ daysResident: days, nonResidentIncome: "20000", nonResidentCanadianIncome: "0" });
  const alone = (province: string, answers: Answers) =>
    new Evaluation(rules, {
      year: 2025,
      people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province, residentAllYear: false }],
      family: { maritalStatus: "married", dependants: [] },
      answers: { p1: answers },
      slips: [],
    });

  it("prorate the provincial spouse amount's base and maximum, then subtract the spouse's net income", () => {
    // 100 days: Ontario's base $11,905 → 3,261.64 and maximum $10,823 → 2,965.21; less $800.
    expect(amount(alone("ON", { ...partYear("100"), spouseNetIncome: "800" }), "p1", "ON428.13")).toBe("2461.64");
    // British Columbia's base $12,181 → 3,337.26 and maximum $11,073 → 3,033.70; less $800.
    expect(amount(alone("BC", { ...partYear("100"), spouseNetIncome: "800" }), "p1", "BC428.20")).toBe("2537.26");
    // Nova Scotia's base $12,618 → 3,456.99, less whichever is more, $874 prorated (239.45) or the net income.
    const novaScotia = (spouseNetIncome: string) => alone("NS", { ...partYear("100"), spouseNetIncome });
    expect(amount(novaScotia("500"), "p1", "NS428.13")).toBe("2956.99");
    expect(amount(novaScotia("100"), "p1", "NS428.13")).toBe("3217.53");
    const row12 = fillForms(rules, novaScotia("100"), "p1", personalFacts(novaScotia("100").input, "p1"))
      .find((each) => each.form.id === "NS428")!
      .amounts.find((each) => each.key === "12")!;
    expect(row12.value.toString()).toBe("239.45");
    // A full year is as before: the maximum.
    const fullYear = new Evaluation(rules, {
      year: 2025,
      people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "ON" }],
      family: { maritalStatus: "married", dependants: [] },
      answers: { p1: { spouseNetIncome: "800" } },
      slips: [],
    });
    expect(amount(fullYear, "p1", "ON428.13")).toBe("10823");
  });

  it("prorate the provincial age amount's maximum and income threshold, then reduce it by 15% of the income over it", () => {
    // 276 days, as in the CRA's example for line 30100, at 70, with a pension as the only income.
    const senior = (province: string, pension: string) =>
      new Evaluation(rules, {
        year: 2025,
        people: [{ id: "p1", name: "Alex", role: "self", birthDate: "1955-04-02", province, residentAllYear: false }],
        family: { maritalStatus: "single", dependants: [] },
        answers: { p1: partYear("276") },
        slips: [{ id: "s1", person: "p1", type: "T4AP", issuer: "Service Canada", boxes: { 20: pension } }],
      });
    // Ontario: $6,223 → 4,705.61, less 15% of $40,000 over $46,330 → 35,033.10.
    expect(amount(senior("ON", "40000"), "p1", "ON428.10")).toBe("3960.57");
    // Manitoba's threshold is much lower: $3,728 → 2,818.98, less 15% of $25,000 over $27,749 → 20,982.81.
    expect(amount(senior("MB", "25000"), "p1", "MB428.10")).toBe("2216.4");
  });

  it("prorate a provincial caregiver amount's base and maximum, then subtract the dependant's net income", () => {
    const caregiver = (province: string) =>
      alone(province, {
        ...partYear("219"),
        spouseNetIncome: "0",
        hasInfirmDependant: true,
        infirmDependants: "1",
        infirmDependantIncome: "15000",
        infirmDependantHome: "with_you",
      });
    // 219 days is 60%: Ontario's $26,562 → 15,937.20 less $15,000, under the maximum $6,008 → 3,604.80.
    expect(amount(caregiver("ON"), "p1", "ON428.17")).toBe("937.2");
    // New Brunswick chooses between its two amounts once both are prorated: the caregiver amount, $25,781 → 15,468.60
    // less $15,000, over the infirm dependant amount, $14,124 → 8,474.40 less $15,000, which is nothing.
    expect([amount(caregiver("NB"), "p1", "NB428.29"), amount(caregiver("NB"), "p1", "NB428.17")]).toEqual(["468.6", "0"]);
  });

  it("prorate the British Columbia caregiver amount once, less the spouse amount claimed", () => {
    // 219 days is 60% of the year: line 3 of the worksheet is $5,659 → 3,395.40 at most, from $24,810 → 14,886 less
    // $9,000; the spouse amount, $12,181 → 7,308.60 less $9,000, is nothing.
    const infirmSpouse = alone("BC", { ...partYear("219"), spouseNetIncome: "9000", spouseInfirm: true });
    expect([amount(infirmSpouse, "p1", "BC428.20"), amount(infirmSpouse, "p1", "BC428.24")]).toEqual(["0", "3395.4"]);
  });

  it("prorate the provincial amounts transferred to them, while the schedule shows the whole transfer", () => {
    // 183 days in Canada; a spouse of 67 who lived here all year with no income transfers their British Columbia age
    // amount, $5,799.
    const evaluation = new Evaluation(rules, {
      year: 2025,
      people: [
        { id: "p1", name: "Alex", role: "self", birthDate: "1985-04-02", province: "BC", residentAllYear: false },
        { id: "p2", name: "Sam", role: "spouse", birthDate: "1958-09-15", province: "BC" },
      ],
      family: { maritalStatus: "married", dependants: [] },
      answers: { p1: { ...partYear("183"), childTuitionTransfer: "2000", childProvincialTuitionTransfer: "2000" }, p2: {} },
      slips: [],
    });
    expect(amount(evaluation, "p1", "BCS2.12")).toBe("5799");
    // 5,799 × 183 / 365 and 2,000 × 183 / 365.
    expect([amount(evaluation, "p1", "BC428.44"), amount(evaluation, "p1", "BC428.43")]).toEqual(["2907.44", "1002.74"]);
  });
});
