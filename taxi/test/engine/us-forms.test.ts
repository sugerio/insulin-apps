import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Dec } from "../../src/app/shared/engine/decimal.ts";
import { Evaluation, type EngineInput } from "../../src/app/shared/engine/evaluate.ts";
import { fillForms, personalFacts, type FilledForm } from "../../src/app/shared/engine/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { formsToAdd } from "../../src/app/shared/print.ts";

// The IRS forms a US return is printed on (rules/us/2025/forms.yaml): which forms each golden case's return gets, every
// row that holds one of the case's expected lines, the rows the forms work out themselves, the names and ticks, and the
// tables of dependants.

const rules = rulesFor("us", 2025)!;
const GOLDEN = resolve(import.meta.dirname, "../golden/us-2025");

interface Golden {
  input: EngineInput & { people: { id: string; role: string }[] };
  expected: Record<string, Record<string, string>>;
}
const golden = (name: string): Golden => JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), "utf8")) as Golden;

/** The case's return (the person preparing's), printed. */
function print(input: Golden["input"]): FilledForm[] {
  const evaluation = new Evaluation(rules, input);
  const self = input.people.find((person) => person.role === "self")!.id;
  const joint = input.family.maritalStatus === "married" && input.family.filingStatus === "joint";
  return fillForms(rules, evaluation, self, personalFacts(evaluation.input, self, { joint }));
}
const formOf = (filled: FilledForm[], id: string) => filled.find((each) => each.form.id === id)!;
/** What a form has at a place: an amount as text, a count's or a name's text, or "X" for a tick; undefined for blank. */
function at(form: FilledForm, key: string): string | undefined {
  const amount = form.amounts.find((each) => each.key === key);
  if (amount) return amount.value.toString();
  const mark = form.marks.find((each) => each.key === key);
  return mark ? (mark.kind === "tick" ? "X" : mark.text) : undefined;
}

describe("2025 US forms", () => {
  // Each case's forms, in the order the IRS asks them attached. A schedule is printed only when it has something.
  for (const [name, forms] of [
    ["actc-part-ii-b", "F1040,S8812"],
    ["care-benefits-and-credit", "F1040,S3,F2441,S8812"],
    ["care-benefits-taxable", "F1040,F2441,SEIC,S8812"],
    ["care-joint-two-children", "F1040,S3,F2441,S8812"],
    ["care-one-child", "F1040,S3,F2441,SEIC,S8812"],
    ["care-parent-who-cant-care", "F1040,S3,F2441"],
    ["care-separate-living-apart", "F1040,S3,F2441,SEIC,S8812"],
    ["care-student-spouse", "F1040,S3,F2441,SEIC,S8812"],
    ["children-without-the-ctc", "F1040,S8812"],
    ["dependent-student", "F1040"],
    ["eic-joint-agi-above-earned", "F1040,SEIC,S8812"],
    ["eic-no-child-phase-out", "F1040"],
    ["eic-no-child", "F1040"],
    ["eic-one-child-phase-in", "F1040,SEIC,S8812"],
    ["eic-separate-living-apart", "F1040,SEIC,S8812"],
    ["eic-two-children-phase-out", "F1040,SEIC,S8812"],
    ["filer-without-ssn", "F1040,S8812"],
    ["hoh-two-children", "F1040,S8812"],
    ["joint-high-earners", "F1040,S2,S3,F8959,F8960"],
    ["joint-phase-out", "F1040,S2,S8812,F8959"],
    ["joint-same-couple", "F1040"],
    ["joint-seniors", "F1040,S1A"],
    ["joint-two-children-and-a-teen", "F1040,S8812"],
    ["married-filing-separately", "F1040,S2,F8959"],
    ["parent-as-dependent", "F1040,S8812"],
    ["qualifying-surviving-spouse", "F1040,S8812"],
    ["relative-over-the-income-limit", "F1040"],
    ["senior-blind", "F1040,S1A"],
    ["senior-phase-out", "F1040,S1A"],
    ["single-high-earner", "F1040,S2,S3,F8959,F8960"],
    ["single-wages-interest", "F1040"],
    ["tips-server", "F1040,S1A"],
    ["tips-without-ssn", "F1040"],
    ["tips-overtime-joint-phase-out", "F1040,S1A,S2,F8959"],
    ["overtime-and-car-loan-separate", "F1040,S1A"],
    ["car-loan-single", "F1040,S1A"],
  ] as const) {
    it(`${name}: its forms hold the case's expected lines`, () => {
      const example = golden(name);
      const evaluation = new Evaluation(rules, example.input);
      const self = example.input.people.find((person) => person.role === "self")!.id;
      const expected = example.expected[self]!;
      const filled = print(example.input);
      expect(filled.map((each) => each.form.id).join(","), name).toBe(forms);
      let checked = 0;
      for (const { form, amounts } of filled) {
        for (const field of form.fields) {
          // A row that holds a line as it is: blank when the line is zero (unless the form asks for 0.00) or the row's
          // condition is no, else that amount.
          if (field.kind !== "amount") continue;
          const line = /^line\.([A-Z0-9]+\.[A-Za-z0-9_]+)$/.exec(field.text)?.[1];
          if (!line || !(line in expected)) continue;
          const shown = !field.when || evaluation.evaluate(self, field.when.formula).value === true;
          const value = Dec.from(expected[line]!).roundTo(2, "HALF_UP");
          const written = amounts.find((amount) => amount.key === field.key)?.value.toString();
          expect(written ?? "0", `${form.id} row ${field.key} (${line})`).toBe(shown && (!value.isZero() || field.zero) ? value.toString() : "0");
          if (!shown || (value.isZero() && !field.zero)) expect(written, `${form.id} row ${field.key} is blank`).toBeUndefined();
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(15);
    });
  }

  it("fills Form 1040's names, filing status and table of dependants, ticking the child tax credit for each child", () => {
    const f1040 = formOf(print(golden("hoh-two-children").input), "F1040");
    expect(["firstName", "lastName", "hoh", "single", "spouseFirstName"].map((key) => at(f1040, key))).toEqual(["Morgan", "Diaz", "X", undefined, undefined]);
    expect(["firstName@1", "lastName@1", "relationship@1", "livedWithYou@1", "childTaxCredit@1", "otherDependents@1"].map((key) => at(f1040, key))).toEqual([
      "Ava",
      "Diaz",
      "Child",
      "X",
      "X",
      undefined,
    ]);
    expect(at(f1040, "firstName@2")).toBe("Ben");
    expect(at(f1040, "firstName@3")).toBeUndefined();
    expect(at(f1040, "more")).toBeUndefined();
    expect(f1040.left).toEqual([]);
  });

  it("ticks the credit for other dependents for a parent, and leaves a relationship the answer doesn't name blank", () => {
    const f1040 = formOf(print(golden("parent-as-dependent").input), "F1040");
    expect(["firstName@1", "relationship@1", "childTaxCredit@1", "otherDependents@1"].map((key) => at(f1040, key))).toEqual(["Hana", undefined, undefined, "X"]);
  });

  it("ticks the credit for other dependents for each child when the filer has no valid social security number", () => {
    const f1040 = formOf(print(golden("filer-without-ssn").input), "F1040");
    expect([at(f1040, "childTaxCredit@1"), at(f1040, "otherDependents@1")]).toEqual([undefined, "X"]);
  });

  it("lists four dependents on Form 1040, ticks its 'more than four' box and names the others", () => {
    const base = golden("hoh-two-children").input;
    const child = base.family.dependants[0]!;
    const more = ["Cal", "Dee", "Eve"].map((first, index) => ({ ...child, id: `extra${index}`, name: `${first} Diaz`, birthDate: `201${index}-05-05` }));
    const filled = print({ ...base, family: { ...base.family, dependants: [...base.family.dependants, ...more] } });
    const f1040 = formOf(filled, "F1040");
    expect(["firstName@1", "firstName@2", "firstName@3", "firstName@4"].map((key) => at(f1040, key))).toEqual(["Ava", "Ben", "Cal", "Dee"]);
    expect(at(f1040, "more")).toBe("X");
    expect(f1040.left).toEqual(["Eve Diaz"]);
  });

  it("names both spouses on a joint return, and ticks each one's boxes for age", () => {
    const filled = print(golden("joint-seniors").input);
    const f1040 = formOf(filled, "F1040");
    // Lee answered that they are blind; Kim isn't.
    expect(["joint", "spouseFirstName", "spouseLastName", "youSenior", "spouseSenior", "youBlind", "spouseBlind"].map((key) => at(f1040, key))).toEqual([
      "X",
      "Kim",
      "Park",
      "X",
      "X",
      "X",
      undefined,
    ]);
    const s1a = formOf(filled, "S1A");
    expect(at(s1a, "names")).toBe("Lee Park and Kim Park");
    // Part V: both spouses 65 or older, with a modified AGI under $150,000.
    expect(["31", "32", "33", "34", "35", "36a", "36b", "37", "38"].map((key) => at(s1a, key))).toEqual([
      "45000",
      "150000",
      undefined,
      undefined,
      "6000",
      "6000",
      "6000",
      "12000",
      "12000",
    ]);
  });

  it("fills Schedule 1-A's tips, overtime and car loan parts, each only when it has something", () => {
    const s1a = formOf(print(golden("tips-overtime-joint-phase-out").input), "S1A");
    // $320,500 of modified AGI: $20,500 over $300,000, so 20 whole thousands and $2,000 off each deduction.
    expect(["4c", "7", "9", "10", "11", "12", "13", "14c", "15", "19", "20", "21"].map((key) => at(s1a, key))).toEqual([
      "28000",
      "25000",
      "300000",
      "20500",
      "20",
      "2000",
      "23000",
      "30000",
      "25000",
      "20",
      "2000",
      "23000",
    ]);
    // Lu's car doesn't qualify: Part IV is blank; so is Part V, with no one 65 or older.
    expect(["22b", "23", "25", "30", "31", "32", "38"].map((key) => at(s1a, key))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, "46000"]);
    const car = formOf(print(golden("overtime-and-car-loan-separate").input), "S1A");
    // Filing separately: no overtime; the car loan interest cut by $200 for each $1,000 or part over $100,000.
    expect(["14c", "21", "22a", "24", "26", "27", "28", "29", "30", "38"].map((key) => at(car, key))).toEqual([
      undefined,
      undefined,
      "4000",
      "4000",
      "100000",
      "4500",
      "5",
      "1000",
      "3000",
      "3000",
    ]);
  });

  it("works out Schedule 1-A's reduction for a modified AGI over $75,000", () => {
    const example = golden("senior-phase-out");
    const s1a = formOf(print(example.input), "S1A");
    const magi = Dec.from(at(s1a, "31")!);
    const over = magi.sub(Dec.from("75000"));
    expect([at(s1a, "33"), at(s1a, "34")]).toEqual([over.toString(), over.mul(Dec.from("0.06")).roundTo(2, "HALF_UP").toString()]);
    expect(at(s1a, "35")).toBe(Dec.from("6000").sub(Dec.from(at(s1a, "34")!)).toString());
  });

  it("writes the spouse's whole name for married filing separately, and the zeros the form asks for", () => {
    const f1040 = formOf(print(golden("married-filing-separately").input), "F1040");
    expect(["separate", "separateSpouseName", "spouseFirstName"].map((key) => at(f1040, key))).toEqual(["X", "Ana Ortiz", undefined]);
    const zero = formOf(print(golden("eic-no-child").input), "F1040");
    // A low income: no tax, so lines 22 and 24 are 0.00 ("enter -0-"), and the amount owed is blank.
    expect([at(zero, "22"), at(zero, "24"), at(zero, "37")]).toEqual(["0", "0", undefined]);
  });

  it("fills Form 2441's qualifying persons, the rate's digits and the deemed income box", () => {
    const f2441 = formOf(print(golden("care-student-spouse").input), "F2441");
    expect(["firstName@1", "lastName@1", "expenses@1", "disabled@1", "firstName@2"].map((key) => at(f2441, key))).toEqual(["Kip", "Webb", "4000", undefined, undefined]);
    expect(["deemedIncome", "livedApart", "8", "names"].map((key) => at(f2441, key))).toEqual(["X", undefined, "20", "Dan Webb and Mae Webb"]);
    // A parent who can't care for themselves is a qualifying person, though not a dependent on Form 1040.
    const parent = print(golden("care-parent-who-cant-care").input);
    expect([at(formOf(parent, "F2441"), "firstName@1"), at(formOf(parent, "F2441"), "disabled@1")]).toEqual(["Grace", "X"]);
    expect(at(formOf(parent, "F1040"), "firstName@1")).toBeUndefined();
    // Filing separately while living apart: box A.
    expect(at(formOf(print(golden("care-separate-living-apart").input), "F2441"), "livedApart")).toBe("X");
  });

  it("fills Part III of Form 2441 only with benefits, with lines 22 and 24 at zero", () => {
    const f2441 = formOf(print(golden("care-benefits-taxable").input), "F2441");
    expect(["line22No", "22", "24", "13", "14"].map((key) => at(f2441, key))).toEqual(["X", "0", "0", "200", "500"]);
    const credit = formOf(print(golden("care-one-child").input), "F2441");
    expect(["12", "18", "21", "22", "line22No"].map((key) => at(credit, key))).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("fills Schedule EIC for each qualifying child: the year of birth in its boxes, the relationship and the months", () => {
    const seic = formOf(print(golden("eic-two-children-phase-out").input), "SEIC");
    expect(["name@1", "birthYear@1", "relationship@1", "months@1", "name@2", "birthYear@2", "studentYes@1", "studentNo@1"].map((key) => at(seic, key))).toEqual([
      "Ray Shaw",
      "2014",
      "Child",
      "12",
      "Zoe Shaw",
      "2018",
      undefined,
      undefined,
    ]);
    expect(seic.marks.find((each) => each.key === "birthYear@1")).toMatchObject({ kind: "text", cell: expect.any(Number) });
  });

  it("answers Schedule EIC's lines 4a and 4b for a child of 19 or more: a student under 24, or else disabled", () => {
    const base = golden("eic-one-child-phase-in").input;
    const child = base.family.dependants[0]!;
    const aged = (birthDate: string, answers: Record<string, string | boolean>) =>
      formOf(print({ ...base, family: { ...base.family, dependants: [{ ...child, birthDate, answers: { ...child.answers, ...answers } }] } }), "SEIC");
    const keys = ["studentYes@1", "studentNo@1", "disabledYes@1"];
    // 20 and a full-time student: 4a Yes.
    expect(keys.map((key) => at(aged("2005-06-01", { fullTimeStudent: true }), key))).toEqual(["X", undefined, undefined]);
    // 30 and disabled: 4a No, 4b Yes.
    expect(keys.map((key) => at(aged("1995-06-01", { fullTimeStudent: false, disabled: true }), key))).toEqual([undefined, "X", "X"]);
    // Under 19: lines 4a and 4b are skipped.
    expect(keys.map((key) => at(aged(child.birthDate, {}), key))).toEqual([undefined, undefined, undefined]);
  });

  it("works out Schedule 8812's rows: the threshold, the reduction and Part II-B", () => {
    const phaseOut = formOf(print(golden("joint-phase-out").input), "S8812");
    expect(["9", "line12Yes"].map((key) => at(phaseOut, key))).toEqual(["400000", "X"]);
    const example = golden("actc-part-ii-b").input;
    const partIIB = formOf(print(example), "S8812");
    const line = (id: string) => new Evaluation(rules, example).line("p1", id).value!.toString();
    expect(["4", "16bChildren", "line20Yes", "21", "23", "25", "26", "27"].map((key) => at(partIIB, key))).toEqual([
      "3",
      "3",
      "X",
      ...["S8812.21", "S8812.21", "S8812.25", "S8812.26", "S8812.27"].map(line),
    ]);
    expect(line("S8812.27")).toBe(Dec.from(golden("actc-part-ii-b").expected.p1!["F1040.28"]!).toString());
  });

  it("works out Forms 8959 and 8960 and Schedule 2", () => {
    const filled = print(golden("single-high-earner").input);
    const f8959 = formOf(filled, "F8959");
    const wages = Dec.from(at(f8959, "1")!);
    expect([at(f8959, "4"), at(f8959, "6"), at(f8959, "20")]).toEqual([wages.toString(), wages.sub(Dec.from("200000")).toString(), wages.toString()]);
    const f8960 = formOf(filled, "F8960");
    const over = Dec.from(at(f8960, "13")!).sub(Dec.from(at(f8960, "14")!));
    expect(at(f8960, "15")).toBe(over.toString());
    expect(at(f8960, "16")).toBe(Dec.min(over, Dec.from(at(f8960, "12")!)).toString());
    expect(at(formOf(filled, "S2"), "21")).toBe(Dec.from(at(f8959, "7")!).add(Dec.from(at(f8960, "17")!)).toString());
  });

  it("names Schedule B to fill in yourself when the taxable interest is more than $1,500", () => {
    const example = golden("single-high-earner");
    const evaluation = new Evaluation(rules, example.input);
    const interest = evaluation.line("p1", "F1040.2b").value!;
    expect(formsToAdd(rules, evaluation, "p1").map(({ form }) => form)).toEqual(
      interest.gt(Dec.from("1500")) ? ["Schedule B (Form 1040), Interest and Ordinary Dividends"] : [],
    );
    const small = golden("single-wages-interest");
    expect(formsToAdd(rules, new Evaluation(rules, small.input), "p1")).toEqual([]);
  });
});
