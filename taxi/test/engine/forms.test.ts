import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileRules } from "../../src/app/shared/engine/compile.ts";
import { Dec } from "../../src/app/shared/engine/decimal.ts";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import { fillForms, formAmount, personalFacts, splitName } from "../../src/app/shared/engine/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { PROVINCE_NAMES, type Province } from "../../src/app/shared/people.ts";

// The CRA forms a return is printed on (rules/ca/2025/forms.yaml): which forms each golden case's returns get,
// every amount written on them against the case's expected lines, the bracket tables against the tax lines, and
// the other kinds of field (Step 1's name and dates, ticks, counts).

const rules = rulesFor(2025)!;
const GOLDEN = resolve(import.meta.dirname, "../golden/ca-2025");

interface Golden {
  input: { people: { id: string }[] };
  expected: Record<string, Record<string, string>>;
}
const golden = (name: string) => JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), "utf8")) as Golden;

/** Every row of the profile's forms that holds one of its expected lines as it is: blank when zero, else that amount. */
function checkForms(name: string, forms: readonly string[]) {
  const example = golden(name);
  const evaluation = new Evaluation(rules, example.input);
  for (const [personId, expected] of Object.entries(example.expected)) {
    const filled = fillForms(rules, evaluation, personId, personalFacts(evaluation.input, personId));
    expect(filled.map((each) => each.form.id)).toEqual(forms);
    let checked = 0;
    for (const { form, amounts } of filled) {
      for (const field of form.fields) {
        if (field.kind !== "amount") continue;
        const line = /^line\.([A-Z0-9]+\.[A-Za-z0-9_]+)$/.exec(field.text)?.[1];
        if (!line || !(line in expected) || field.when) continue;
        const written = amounts.find((amount) => amount.key === field.key)?.value.toString() ?? "0";
        expect(written, `${form.id} row ${field.key} (${line})`).toBe(Dec.from(expected[line]!).roundTo(2, "HALF_UP").toString());
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  }
}

describe("2025 forms", () => {
  // Each case's forms, per person, in the order they print: the T1, the schedules and forms the return uses, then
  // the provincial ones. A schedule is printed only when its key line isn't zero.
  for (const [name, ...people] of [
    ["on-couple-kids", "T1,S2,S5,ON428", "T1,S11,ON428"],
    ["bc-employee", "T1,S9,BC428,BC479"],
    ["ab-couple", "T1,S5,AB428", "T1,AB428"],
    ["pensioner-on", "T1,ON428"],
    ["oas-clawback-bc", "T1,S3,BC428"],
    ["capital-gains-on", "T1,S3,ON428"],
    ["caregiver-family-bc", "T1,S2,S5,S12,BC428,BCS2,BC479", "T1,BC428"],
    ["young-family-on", "T1,T776,T777,T2209,T2036,ON428,ON479", "T1,T778,ON428,ON479"],
    ["consultant-ab", "T1,S8,T2125,T1M,T2209,T2036,AB428"],
    ["shop-owner-bc", "T1,S3,S8,T2125,T2209,T2036,BC428"],
    ["sales-rep-on", "T1,S8,T2125,ON428"],
    ["low-income-worker-ab", "T1,S5,S6,S11,AB428"],
    ["cross-province-couple", "T1,S2,ON428,ONS2", "T1,BC428"],
    ["ab-senior-couple", "T1,S2,S5,AB428,ABS2", "T1,AB428"],
    ["mb-high-earner-couple", "T1,S2,S5,S9,T2209,T2036,MB428,MBS2", "T1,S11,MB428,MBS11"],
    ["mb-single-parent-student", "T1,S5,S6,S11,MB428,MBS11,MB479"],
    ["sk-senior-couple", "T1,S2,S9,SK428,SKS2", "T1,SK428"],
    ["nb-senior-couple", "T1,S2,S5,S9,T2036,NB428,NBS2,NBS12", "T1,NB428,NBS12"],
    ["nb-young-couple", "T1,S2,S5,S6,NB428,NBS2", "T1,S11,NB428,NBS11"],
    ["nb-single-parent", "T1,S5,S6,S9,S11,T778,NB428,NBS11"],
    ["nl-senior-couple", "T1,S2,S5,S9,T2209,T2036,NL428,NLS2", "T1,NL428"],
    ["nl-single-parent", "T1,S5,S6,S11,NL428,NLS11"],
    ["ns-senior-couple", "T1,S2,S5,S9,T2209,T2036,NS428,NSS2", "T1,NS428"],
    ["ns-young-family", "T1,S2,S5,S11,NS428,NSS2,NSS11,NS479", "T1,S11,NS428,NSS11"],
    ["pe-senior-couple", "T1,S2,S5,S9,S11,T2209,T2036,PE428,PES2,PES11", "T1,S11,PE428,PES11"],
    ["pe-single-parent", "T1,S5,S6,S9,PE428"],
    ["yt-senior-couple", "T1,S2,S5,S9,YT428,YTS2", "T1,YT428"],
    ["yt-single-parent", "T1,S5,S6,S9,S11,YT428,YTS11,YT479"],
    ["nt-senior-couple", "T1,S2,S5,S9,NT428,NTS2,NT479", "T1,S2,NT428,NTS2,NT479"],
    ["nt-student-couple", "T1,S2,S5,T2209,T2036,NT428,NTS2,NT479", "T1,S11,NT428,NTS11,NT479"],
    ["nu-young-family", "T1,S2,S5,T2209,T2036,NU428,NUS2,NU479", "T1,S11,NU428,NUS11,NU479"],
    ["nu-single-parent", "T1,S5,S9,S11,NU428,NUS11,NU479"],
    // A resident of Quebec: the T1 for residents of Quebec and its federal forms, then the TP-1 and its schedules.
    ["couple-kids-qc", "T1QC,T777,TP1,QCK,QCU", "T1QC,T778,TP1,QCC,QCK,QCU"],
    ["high-income-couple-qc", "T1QC,S9,TP1,QCK,QCU", "T1QC,S3,S11,TP1,QCG,QCK,QCT,QCU"],
    ["one-earner-couple-student-qc", "T1QC,S2,S5,TP1,QCU", "T1QC,TP1"],
    ["self-employed-qc", "T1QC,T2125,TP1,QCF,QCK,QCL,QCR,QCU"],
    ["senior-couple-qc", "T1QC,TP1,QCB,QCF,QCJ,QCK,QCQ", "T1QC,TP1,QCF,QCK"],
    ["single-employee-qc", "T1QC,S9,TP1,QCU"],
    ["single-parent-low-income-qc", "T1QC,S5,S6,T778,TP1,QCB,QCC,QCP,QCU"],
  ] as const) {
    it(`${name}: its forms hold the case's expected lines`, () => {
      const example = golden(name);
      const evaluation = new Evaluation(rules, example.input);
      example.input.people.forEach((person, index) => {
        const personId = person.id;
        const expected = example.expected[personId]!;
        const filled = fillForms(rules, evaluation, personId, personalFacts(evaluation.input, personId));
        expect(filled.map((each) => each.form.id).join(","), name).toBe(people[index]);
        let checked = 0;
        let quebec = 0;
        for (const { form, amounts } of filled) {
          for (const field of form.fields) {
            // A row that holds a line as it is: blank when the expected line is zero (or the row's condition is no),
            // else that amount.
            if (field.kind !== "amount") continue;
            const line = /^line\.([A-Z0-9]+\.[A-Za-z0-9_]+)$/.exec(field.text)?.[1];
            if (!line || !(line in expected)) continue;
            const shown = !field.when || evaluation.evaluate(personId, field.when.formula).value === true;
            const value = Dec.from(expected[line]!).roundTo(2, "HALF_UP").toString();
            const written = amounts.find((amount) => amount.key === field.key)?.value.toString() ?? "0";
            expect(written, `${form.id} row ${field.key} (${line})`).toBe(shown ? value : "0");
            checked += 1;
            if (form.url.includes("revenuquebec.ca")) quebec += 1;
          }
        }
        expect(checked).toBeGreaterThan(30);
        if (name.endsWith("-qc")) expect(quebec, "rows of the TP-1 and its schedules").toBeGreaterThan(5);
      });
    });
  }

  it("numbers the T1 for residents of Quebec's rows as 5005-R prints them", () => {
    const example = golden("qc-fed-ei-ppip-overpayment");
    const evaluation = new Evaluation(rules, example.input);
    const [t1qc] = fillForms(rules, evaluation, "p1", personalFacts(evaluation.input, "p1"));
    const row = (key: string) => t1qc!.amounts.find((amount) => amount.key === key)?.value.toString();
    // PPIP premiums paid (31205), the refundable Quebec abatement (44000), EI and net EI overpayment (45000, 45100).
    expect([row("91"), row("156"), row("157"), row("159"), row("171")]).toEqual(["484.12", "2575.56", "580.33", "580.33", "18655.89"]);
    // $108,926 is in the second federal bracket: the table is one row lower than on 5006-R.
    expect(t1qc!.amounts.filter((amount) => amount.key.includes("@")).map((amount) => [amount.key, amount.value.toString()])).toEqual([
      ["71@1", "108926"],
      ["73@1", "51551"],
      ["75@1", "10567.96"],
      ["77@1", "18887.34"],
    ]);
  });

  it("fills the TP-1's information about you and your spouse, and keys a decimal line by its number", () => {
    const gerard = marksOf("senior-couple-qc", 0, "TP1");
    expect(gerard.marks).toEqual({
      lastName: "Bouchard",
      firstName: "Gérard",
      birthDate: "19510211",
      spouseYes: "X",
      foreignPropertyNo: "X",
      spouseLastName: "Bouchard",
      spouseFirstName: "Lise",
      spouseBirthDate: "19540730",
    });
    // Line 51: the spouse's net income, from line 275 of their TP-1.
    expect(gerard.amounts["51"]).toBe("33600");
    // Line 377.1 (TP1.377_1) and line 432, carried to page 5 (p5:432).
    expect([gerard.amounts["377.1"], gerard.amounts["p5:432"]]).toEqual(["3848.58", "1695.42"]);
    const single = marksOf("single-employee-qc", 0, "TP1");
    expect(single.marks).toMatchObject({ spouseNo: "X" });
    expect(Object.keys(single.marks).filter((key) => key.startsWith("spouse") && key !== "spouseNo")).toEqual([]);
    expect(single.amounts["51"]).toBeUndefined();
    // The exemption code instead of Schedule K, as a whole number.
    expect(single.marks["449"]).toBe("14");
    // Nobody outside Quebec gets a Revenu Québec form.
    expect(marksOf("on-couple-kids", 0, "TP1")).toEqual({ marks: {}, amounts: {} });
  });

  it("fills the column of the bracket the taxable income falls in, ending at the tax line", () => {
    const example = golden("on-couple-kids");
    const evaluation = new Evaluation(rules, example.input);
    const person = example.input.people[0]!.id;
    const filled = fillForms(rules, evaluation, person, personalFacts(evaluation.input, person));
    const [t1, on428] = ["T1", "ON428"].map((id) => filled.find((each) => each.form.id === id));
    // $88,926 is in the second federal bracket ($57,375 to $114,750): 31,551 over, at 20.5% = 6,467.96, + 8,319.38.
    expect(t1!.amounts.filter((amount) => amount.key.includes("@")).map((amount) => [amount.key, amount.value.toString()])).toEqual([
      ["70@1", "88926"],
      ["72@1", "31551"],
      ["74@1", "6467.96"],
      ["76@1", "14787.34"],
    ]);
    expect(evaluation.line(person, "T1.40400").value!.toString()).toBe("14787.34");
    expect(on428!.amounts.find((amount) => amount.key === "8@1")!.value.toString()).toBe(evaluation.line(person, "ON428.8").value!.toString());
  });

  const marksOf = (name: string | Golden["input"], index: number, form: string) => {
    const input = typeof name === "string" ? golden(name).input : name;
    const evaluation = new Evaluation(rules, input);
    const personId = input.people[index]!.id;
    const facts = personalFacts(evaluation.input, personId, { provinceName: (code) => PROVINCE_NAMES[code as Province] });
    const filled = fillForms(rules, evaluation, personId, facts).find((each) => each.form.id === form);
    return {
      marks: Object.fromEntries((filled?.marks ?? []).map((mark) => [mark.key, mark.kind === "tick" ? "X" : mark.text])),
      amounts: Object.fromEntries((filled?.amounts ?? []).map((amount) => [amount.key, amount.value.toString()])),
    };
  };

  it("fills Step 1 of the T1: the name split at its last space, the birth date in its boxes, the ticks, the spouse", () => {
    const alex = marksOf("on-couple-kids", 0, "T1");
    expect(alex.marks).toEqual({
      firstName: "Alex",
      lastName: "Martin",
      birthDate: "19840615",
      married: "X",
      province: "Ontario",
      spouseFirstName: "Sam",
      foreignPropertyNo: "X",
    });
    // Sam's net income, read from Sam's return.
    expect(alex.amounts.spouseNetIncome).toBe("8945");
    expect(marksOf("nb-single-parent", 0, "T1").marks).toMatchObject({ single: "X", province: "New Brunswick" });
    expect(marksOf("nb-single-parent", 0, "T1").amounts.spouseNetIncome).toBeUndefined();
  });

  it("writes the spouse's net income even when it is zero, and ticks only what the person answered", () => {
    const input = structuredClone(golden("single-employee-on").input) as Golden["input"] & {
      family: { maritalStatus: string };
      answers: Record<string, Record<string, string | boolean>>;
    };
    const personId = input.people[0]!.id;
    input.family.maritalStatus = "common_law";
    input.answers[personId] = { ...input.answers[personId], spouseNetIncome: "0" };
    delete input.answers[personId]!.hasForeignProperty;
    const t1 = marksOf(input, 0, "T1");
    expect(t1.amounts.spouseNetIncome).toBe("0");
    expect(t1.marks.commonLaw).toBe("X");
    // Their spouse isn't in the profile, so their first name stays blank; foreign property wasn't answered.
    expect(t1.marks.spouseFirstName).toBeUndefined();
    expect(t1.marks.foreignPropertyNo).toBeUndefined();
  });

  it("fills a schedule of each kind: amounts and counts (Schedule 11, T778) and ticks (Schedule 3)", () => {
    // Robin's tuition: 4 months part time (T2202 box 24), and one child aged 7 to 16 for child care.
    expect(marksOf("nb-single-parent", 0, "S11").marks).toEqual({ "32010": "4" });
    expect(marksOf("nb-single-parent", 0, "T778").marks).toEqual({ "3@1": "1" });
    const s11 = marksOf("student-on", 0, "S11");
    expect(s11.marks).toEqual({ "32020": "8" });
    expect(s11.amounts["1"]).toBe("9800");
    // A home sold, designated a principal residence for every year: Schedule 3 is ticked, with no gain.
    const input = structuredClone(golden("single-employee-on").input) as Golden["input"] & { answers: Record<string, Record<string, string | boolean>> };
    const personId = input.people[0]!.id;
    input.answers[personId] = {
      ...input.answers[personId],
      soldProperty: true,
      propertyUse: "principal_residence",
      propertyProceeds: "500000",
      propertyCost: "300000",
      propertyOutlays: "20000",
    };
    expect(marksOf(input, 0, "S3").marks).toEqual({ flippedNo: "X", principalResidenceAllYears: "X" });
    expect(marksOf(input, 0, "T2091").amounts).toEqual({ "9954": "500000" });
  });

  it("splits a name at its last space, and names the province as the caller says", () => {
    expect(splitName("  Mary Ann   Lee ")).toEqual({ first: "Mary Ann", last: "Lee" });
    expect(splitName("Cher")).toEqual({ first: "Cher", last: "" });
    const input = golden("bc-employee").input as unknown as Parameters<typeof personalFacts>[0];
    const facts = personalFacts(input, input.people[0]!.id, { spouseName: "Jordan Lee", provinceName: (code) => PROVINCE_NAMES[code as Province] });
    expect(facts.province).toBe("British Columbia");
    expect(facts.spouseFirstName).toBe("Jordan");
    // Without a namer, the engine (which knows no country) writes the code.
    expect(personalFacts(input, input.people[0]!.id).province).toBe("BC");
  });

  it("writes amounts as on a paper form: separators, cents, and a negative one in brackets", () => {
    expect(formAmount(Dec.from("1234567.5"))).toEqual({ dollars: "1,234,567", cents: "50" });
    expect(formAmount(Dec.from("12"))).toEqual({ dollars: "12", cents: "00" });
    expect(formAmount(Dec.from("-3472.91"))).toEqual({ dollars: "(3,472", cents: "91)" });
    // Revenu Québec's forms ask for a minus sign; their French versions separate the thousands with a space.
    expect(formAmount(Dec.from("-3572.36"), "minus")).toEqual({ dollars: "-3,572", cents: "36" });
    expect(formAmount(Dec.from("-1234567.5"), "minus", "fr")).toEqual({ dollars: "-1 234 567", cents: "50" });
  });

  it("prints Revenu Québec's forms on their French versions in French, with the same rows, and the CRA's in English", () => {
    const example = golden("senior-couple-qc");
    const evaluation = new Evaluation(rules, example.input);
    const facts = personalFacts(evaluation.input, "p1");
    const english = fillForms(rules, evaluation, "p1", facts);
    const french = fillForms(rules, evaluation, "p1", facts, "fr");
    expect(french.map((each) => each.form.id)).toEqual(english.map((each) => each.form.id));
    for (const [index, filled] of french.entries()) {
      const spec = rules.forms.get(filled.form.id)!;
      expect(filled.language).toBe(spec.french ? "fr" : "en");
      expect(filled.form.url).toBe(spec.french?.url ?? spec.url);
      // The same rows and marks, each at the version's own place.
      expect(filled.amounts.map((amount) => [amount.key, amount.value.toString()])).toEqual(english[index]!.amounts.map((amount) => [amount.key, amount.value.toString()]));
      expect(filled.marks.map((mark) => mark.key)).toEqual(english[index]!.marks.map((mark) => mark.key));
    }
    expect(french.find((each) => each.form.id === "TP1")!.form.title).toBe("TP-1 Déclaration de revenus (Revenu Québec)");
    // Every Revenu Québec form has a French version; no CRA form has one.
    for (const form of rules.forms.values()) expect(form.french !== undefined, form.id).toBe(form.url.includes("revenuquebec.ca"));
  });
});

describe("form rules", () => {
  const compile = (form: object, layout: object = {}, layouts: object = {}) =>
    compileRules(
      [
        {
          dir: "rules/xx/2025",
          files: [
            { path: "rules/xx/2025/year.yaml", data: { country: "xx", year: 2025, filingUnit: "person", extends: null, result: ["R.net"] } },
            {
              path: "rules/xx/2025/rules.yaml",
              data: {
                params: { brackets: { label: "B", source: "S", value: [{ upTo: 100, rate: "10%", base: 0 }, { rate: "20%", base: 10 }] } },
                lines: { "R.net": { label: "Net", formula: "answer.amount" } },
                questions: { amount: { type: "money", ask: "Amount", default: 0 }, moved: { type: "boolean", ask: "Moved", default: false } },
                forms: { F1: { title: "F", url: "https://example.com/f.pdf", applies: "true", ...form } },
                formLayout: {
                  F1: {
                    sha256: "a".repeat(64),
                    pages: 1,
                    rows: { "1": [1, 552, 700], "2": [1, 552, 680], "3": [1, 552, 660], "4": [1, 552, 640], "5": [1, 405, 620] },
                    columns: { "2": [300, 552] },
                    printed: ["3"],
                    plain: ["5", "2@1"],
                    text: { name: [1, 32, 591, 128] },
                    combs: { born: [1, 333, 531, 12] },
                    ticks: { yes: [1, 479, 600] },
                    ...layout,
                  },
                  ...layouts,
                },
              },
            },
          ],
        },
      ],
      () => "test",
    );

  it("places a form's French version by its own layout, and refuses one with no layout", () => {
    const french = { title: "F (fr)", url: "https://example.com/f-fr.pdf" };
    const layout = { sha256: "b".repeat(64), pages: 2, rows: { "1": [2, 540, 300] }, text: { name: [1, 40, 590, 120] } };
    const compiled = compile({ french, fields: { "1": "line.R.net", name: { text: "firstName" } } }, {}, { "F1-fr": layout }).forms.F1!;
    expect(compiled.french).toEqual({ ...french, sha256: "b".repeat(64), pages: 2, places: [{ page: 2, x: 540, y: 300 }, { page: 1, x: 40, y: 590, width: 120 }], tables: [] });
    expect(() => compile({ french, fields: { "1": "line.R.net" } })).toThrow(/French version: form-layout.yaml has no layout/);
    expect(() => compile({ french, fields: { "2@1": "line.R.net" } }, {}, { "F1-fr": layout })).toThrow(/French version: The form has no row 2/);
  });

  it("places each row where the layout measured it", () => {
    expect(compile({ fields: { "1": "line.R.net" } }).forms.F1!.fields).toEqual([{ key: "1", kind: "amount", page: 1, x: 552, y: 700, value: "line.R.net" }]);
  });

  it("places each kind of field in its kind of place: a row's other box, a plain box, a count, a tick, text and a date", () => {
    const fields = compile({
      fields: {
        "2@1": "line.R.net",
        "2@2": { value: "line.R.net", zero: true },
        "5": { count: "answer.amount" },
        yes: { tick: "answer.moved" },
        name: { text: "firstName" },
        born: { text: "birthDate", when: "answer.moved" },
      },
    }).forms.F1!.fields;
    // Rows numbered like integers come first (JavaScript's key order); the order doesn't matter on paper.
    expect(fields).toEqual([
      { key: "5", kind: "count", page: 1, x: 405, y: 620, value: "answer.amount" },
      { key: "2@1", kind: "amount", page: 1, x: 300, y: 680, value: "line.R.net", plain: true },
      { key: "2@2", kind: "amount", page: 1, x: 552, y: 680, value: "line.R.net", zero: true },
      { key: "yes", kind: "tick", page: 1, x: 479, y: 600, value: "answer.moved" },
      { key: "name", kind: "text", page: 1, x: 32, y: 591, value: "firstName", width: 128 },
      { key: "born", kind: "text", page: 1, x: 333, y: 531, value: "birthDate", cell: 12, when: "answer.moved" },
    ]);
  });

  it("refuses a field in a place the form doesn't have, a tick that isn't yes/no, a count that isn't a number, and an unknown fact", () => {
    expect(() => compile({ fields: { "2@3": "line.R.net" } })).toThrow(/has 2 boxes, not 3/);
    expect(() => compile({ fields: { "1@1": "line.R.net" } })).toThrow(/has only one box/);
    expect(() => compile({ fields: { no: { tick: "answer.moved" } } })).toThrow(/no tick box no/);
    expect(() => compile({ fields: { yes: { tick: "answer.amount" } } })).toThrow(/A tick must be a yes\/no value/);
    expect(() => compile({ fields: { "5": { count: "answer.moved" } } })).toThrow(/A count on a form must be a number/);
    expect(() => compile({ fields: { name: { text: "sin" } } })).toThrow();
    expect(() => compile({ fields: { surname: { text: "lastName" } } })).toThrow(/no text box or date boxes surname/);
  });

  it("refuses a row the form doesn't have, one with a printed amount, a wrong table, and a formula that isn't a number", () => {
    expect(() => compile({ fields: { "9": "line.R.net" } })).toThrow(/no row 9/);
    expect(() => compile({ fields: { "3": "line.R.net" } })).toThrow(/already has an amount printed/);
    expect(() => compile({ fields: { "1": "answer.amount > 0" } })).toThrow(/must be a number/);
    expect(() =>
      compile({ fields: {}, tables: [{ brackets: "brackets", amount: "line.R.net", parts: [{ columns: "1", amount: "1", over: "2", times: "3", tax: "4" }] }] }),
    ).toThrow(/no preprinted columns/);
    expect(() => compile({ fields: {} }, { pages: 1, rows: {}, sha256: "b".repeat(64) })).not.toThrow();
  });
});
