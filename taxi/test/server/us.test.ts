import { PDFArray, PDFDocument, PDFName, type PDFPage } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Estimate, Person, SlipList, TaxYear, YearList } from "#shared";
import { userAgentFor, type FormSource } from "../../src/app/server/lib/forms.ts";
import type { ReadSlip } from "../../src/app/server/lib/reader.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { startServer, type TestServer } from "../support/server.ts";

// A United States year on the real server: started for the US, federal only (no state), with its own marital
// statuses, and worked out with the US rules.

let server: TestServer;
beforeEach(async () => {
  server = await startServer({ now: () => 1_767_225_600_000 });
});
afterEach(() => server.close());

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

const addPerson = (name: string, relationship: string, birthDate = "1990-03-03") =>
  json<Person>(server.call("POST", "/api/people", { body: { name, relationship, birthDate } }), 201);

describe("a United States year", () => {
  it("starts for the United States and stays one country", async () => {
    const alex = await addPerson("Alex Rivera", "self");
    const year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } }), 201);
    expect(year.country).toBe("us");
    expect(year.issues.map((issue) => issue.code).sort()).toEqual(["no_marital_status", "no_province", "no_residency"]);
    expect(year.issues.find((issue) => issue.code === "no_residency")?.message).toBe("Say whether Alex Rivera was a U.S. citizen or resident alien all year.");
    // Starting it again for the US gives the same year; for Canada, it is refused.
    expect((await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } }))).country).toBe("us");
    const refused = await json<{ error: { message: string } }>(server.call("POST", "/api/years", { body: { year: 2025, country: "ca", people: [alex.id] } }), 409);
    expect(refused.error.message).toBe("The 2025 tax year was started for United States.");
    const list = await json<YearList>(server.call("GET", "/api/years"));
    expect(list.years.map((each) => [each.year, each.country])).toEqual([[2025, "us"]]);
  });

  it("is Canada's when no country is given", async () => {
    const alex = await addPerson("Alex Rivera", "self");
    expect((await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } }), 201)).country).toBe("ca");
  });

  it("records a state, not a province, and no common-law status", async () => {
    const alex = await addPerson("Alex Rivera", "self");
    const sam = await addPerson("Sam Rivera", "spouse");
    const year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id, sam.id] } }), 201);
    let revision = year.revision;
    const save = (maritalStatus: string, province: string | null) =>
      server.call("PUT", "/api/years/2025/personal-info", {
        body: { revision, maritalStatus, adults: [{ personId: alex.id, province, residentAllYear: true }] },
      });
    const withProvince = await json<{ error: { issues: { path: string }[] } }>(save("married", "ON"), 400);
    expect(withProvince.error.issues.map((issue) => issue.path)).toEqual(["adults.0.province"]);
    expect((await save("common_law", null)).status).toBe(400);
    const noState = await json<TaxYear>(save("married", null));
    revision = noState.revision;
    expect(noState.adults[0]).toEqual({ personId: alex.id, province: null, residentAllYear: true, prepared: true });
    expect(noState.issues.filter((issue) => issue.personId === alex.id).map((issue) => [issue.code, issue.message])).toEqual([
      ["no_province", "Choose Alex Rivera's state on December 31."],
    ]);
    // Any state is recorded: one whose return the app doesn't prepare isn't an issue, as the federal return is complete.
    const saved = await json<TaxYear>(save("married", "NY"));
    expect(saved.adults[0]).toEqual({ personId: alex.id, province: "NY", residentAllYear: true, prepared: true });
    // Married, the couple still has to choose to file jointly or separately; Sam's state and residency are still to say.
    expect(saved.issues.map((issue) => [issue.code, issue.personId])).toEqual([
      ["no_filing_status", null],
      ["no_province", sam.id],
      ["no_residency", sam.id],
    ]);
  });

  it("works out the return with the US rules, from a W-2 to the refund, and finishes it", async () => {
    const alex = await addPerson("Alex Rivera", "self", "1991-03-03");
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } }), 201);
    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", {
        body: { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: "FL", residentAllYear: true }] },
      }),
    );
    // A Canadian slip doesn't belong on a US return.
    expect((await server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: alex.id, type: "T4", issuer: "Acme", boxes: { 14: "1" } } })).status).toBe(400);
    year = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", {
        body: { revision: year.revision, personId: alex.id, type: "W2", issuer: "Acme Tools", boxes: { 1: "40000", 2: "3500", 4: "2480", 5: "40000", 6: "580" } },
      }),
      201,
    );
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.country).toBe("us");
    const line = (from: Estimate, id: string) => from.result.people[0]!.lines.find((each) => each.id === id)?.value;
    // $40,000 less $15,750 is $24,250: the Tax Table's $24,250-$24,300 row, $2,675. Until tips, overtime and a car loan
    // are answered, none is assumed: an estimate.
    expect([line(estimate, "F1040.15"), line(estimate, "F1040.16"), line(estimate, "F1040.24")]).toEqual(["24250", "2675", "2675"]);
    expect(estimate.result.people[0]!.estimates.map((item) => item.question)).toEqual(expect.arrayContaining(["hasTipsOrOvertime", "hasCarLoan"]));

    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/answers", {
        body: { revision: year.revision, personId: alex.id, answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" } },
      }),
    );
    const answered = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect([line(answered, "F1040.24"), line(answered, "F1040.34"), line(answered, "F1040.37")]).toEqual(["2675", "825", "0"]);
    year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision } }));
    expect(year.returns[0]!.steps).toMatchObject({ personal: "done", income: "done", deductions: "done", credits: "done", confirm: "done", finish: "done" });
  });
});

describe("printing a US return", () => {
  const rules = rulesFor("us", 2025)!;
  /** Blank pages for each IRS form, each with an empty fill-in field as the IRS's have, counting the downloads. */
  function standIn(): FormSource & { fetched: string[] } {
    const fetched: string[] = [];
    return {
      fetched,
      checkHash: false,
      async fetch(url) {
        fetched.push(url);
        const form = [...rules.forms.values()].find((each) => each.url === url)!;
        const pdf = await PDFDocument.create();
        for (let page = 0; page < form.pages; page += 1) pdf.addPage([612, 792]);
        pdf.getForm().createTextField("topmostSubform[0].Page1[0].f1_01[0]").addToPage(pdf.getPage(0), { x: 36, y: 700, width: 200, height: 14 });
        return pdf.save();
      },
    };
  }
  /** Each page's text, with where it is. */
  async function pagesOf(bytes: ArrayBuffer) {
    const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
    const pages = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const items = (await (await doc.getPage(page)).getTextContent()).items.flatMap((item) => ("str" in item && item.str.trim() ? [{ text: item.str, x: item.transform[4] as number, y: item.transform[5] as number }] : []));
      pages.push(items);
    }
    return pages;
  }
  const W2 = (personId: string, issuer: string, wages: string) => ({ personId, type: "W2", issuer, boxes: { 1: wages, 2: "3500", 4: "0", 5: wages, 6: (Number(wages) * 0.0145).toFixed(2) } });
  const ANSWERS = { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" };

  /** A finished US year: Alex alone, or Alex and Sam filing jointly; each with a W-2 and every answer given. */
  async function finished(joint: boolean, state = "FL") {
    const alex = await addPerson("Alex Rivera", "self", "1984-02-02");
    const sam = joint ? await addPerson("Sam Rivera", "spouse", "1986-06-06") : undefined;
    const adults = [alex, ...(sam ? [sam] : [])];
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: adults.map((each) => each.id) } }), 201);
    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", {
        body: {
          revision: year.revision,
          maritalStatus: joint ? "married" : "single",
          ...(joint ? { filingStatus: "joint" } : {}),
          adults: adults.map((each) => ({ personId: each.id, province: state, residentAllYear: true })),
        },
      }),
    );
    for (const [index, each] of adults.entries()) {
      const w2 = W2(each.id, index ? "Initech" : "Acme Tools", index ? "30000" : "40000");
      const boxes = state === "CA" ? { ...w2.boxes, 15: "CA", 16: w2.boxes[1], 17: "1500" } : w2.boxes;
      year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, ...w2, boxes } }), 201);
      const california = state === "CA" ? { livedInCaliforniaAllYear: true, ...(index === 0 ? { caFullYearCoverage: true, caUseTax: "0", caPaidRent: false } : {}), caEstimatedPayments: "0" } : {};
      year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: each.id, answers: { ...ANSWERS, ...california } } }));
    }
    year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision } }));
    expect(year.returns[0]!.steps.finish).toBe("done");
    return { alex, sam };
  }

  it("prints a finished return on Form 1040, downloaded from irs.gov, then the US worksheet; the empty fields are gone", async () => {
    server.close();
    const source = standIn();
    server = await startServer({ now: () => 1_767_225_600_000, forms: source });
    const { alex } = await finished(false);
    const response = await server.call("GET", `/api/years/2025/returns/${alex.id}/forms`);
    expect(response.status, await response.clone().text()).toBe(200);
    const bytes = await response.arrayBuffer();
    expect(source.fetched).toEqual(["https://www.irs.gov/pub/irs-prior/f1040--2025.pdf"]);
    // The stand-in's fill-in field isn't in the printed file: only what Taxi draws.
    const printed = await PDFDocument.load(bytes);
    expect(printed.catalog.has(PDFName.of("AcroForm"))).toBe(false);
    const annotations = (page: PDFPage) => page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size() ?? 0;
    expect(printed.getPages().slice(0, rules.forms.get("F1040")!.pages).map(annotations)).toEqual([0, 0]);

    const pages = await pagesOf(bytes);
    const f1040 = rules.forms.get("F1040")!;
    const place = (key: string) => f1040.fields.find((field) => field.key === key)!;
    const near = (key: string) => pages[place(key).page - 1]!.filter((item) => Math.abs(item.y - place(key).y) < 4).map((item) => item.text);
    // Line 1a: the amount with its cents, ending at the box's right end; the name and the filing status.
    expect(near("1a")).toContain("40,000.00");
    expect(near("firstName")).toEqual(expect.arrayContaining(["Alex", "Rivera"]));
    const single = place("single");
    expect(pages[0]!.some((item) => item.text === "X" && Math.abs(item.y - (single.y - 9 * 0.36)) < 1)).toBe(true);
    // $40,000 less $15,750: the refund is line 34, and all of it is refunded (35a).
    expect(near("35a")).toContain("825.00");
    const worksheet = pages.slice(f1040.pages).flat().map((item) => item.text).join(" ");
    expect(worksheet).toContain("Alex Rivera: 2025 return worksheet");
    expect(worksheet).toContain("Refund (line 34)");
    expect(worksheet).toContain("irs.gov/WhereToFile");
    expect(worksheet).toContain("W-2 from Acme Tools");
  });

  it("prints a California resident's Form 540 after Form 1040, from ftb.ca.gov, in whole dollars, with where to mail it", async () => {
    server.close();
    const source = standIn();
    server = await startServer({ now: () => 1_767_225_600_000, forms: source });
    const { alex } = await finished(false, "CA");
    const response = await server.call("GET", `/api/years/2025/returns/${alex.id}/forms`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(source.fetched).toEqual(["https://www.irs.gov/pub/irs-prior/f1040--2025.pdf", "https://www.ftb.ca.gov/forms/2025/2025-540.pdf"]);
    const pages = await pagesOf(await response.arrayBuffer());
    const f540 = rules.forms.get("F540")!;
    const start = rules.forms.get("F1040")!.pages;
    const place = (key: string) => f540.fields.find((field) => field.key === key)!;
    const near = (key: string) => pages[start + place(key).page - 1]!.filter((item) => Math.abs(item.y - place(key).y) < 4).map((item) => item.text);
    // Whole dollars: FTB prints the cents.
    expect(near("13")).toContain("40,000");
    expect(near("13")).not.toContain("40,000.00");
    expect(near("71")).toContain("1,500");
    const worksheet = pages.slice(start + f540.pages).flat().map((item) => item.text).join(" ");
    expect(worksheet).toContain("California: Refund or no amount due (Form 540, line 115)");
    expect(worksheet).toContain("PO Box 942840");
    // ftb.ca.gov refuses a User-Agent with "https://" in it (canada.ca needs one): it gets the contact without it.
    expect(userAgentFor(f540.url)).toMatch(/Taxi\/\d.*\+taxi\.insulinapps\.com\)$/);
    expect(userAgentFor(rules.forms.get("F1040")!.url)).toContain("+https://");
  });

  it("says a state other than California is filed elsewhere", async () => {
    const { alex } = await finished(false, "NY");
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(year.issues).toEqual([]);
    const estimate = await json<{ result: { people: { lines: { id: string }[] }[] } }>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.result.people[0]!.lines.some((line) => line.id.startsWith("F540"))).toBe(false);
    void alex;
  });

  it("refuses a province on a US year and a state on a Canadian one", async () => {
    const alex = await addPerson("Alex Rivera", "self");
    const year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "ca", people: [alex.id] } }), 201);
    const refused = await json<{ error: { issues: { path: string; message: string }[] } }>(
      server.call("PUT", "/api/years/2025/personal-info", { body: { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: "CA", residentAllYear: true }] } }),
      400,
    );
    expect(refused.error.issues).toEqual([{ path: "adults.0.province", message: "Choose a province or territory" }]);
  });

  it("prints a joint return once, as the person preparing's, with both names; the spouse has none to print", async () => {
    server.close();
    server = await startServer({ now: () => 1_767_225_600_000, forms: standIn() });
    const { alex, sam } = await finished(true);
    const response = await server.call("GET", `/api/years/2025/returns/${alex.id}/forms`);
    expect(response.status).toBe(200);
    const pages = await pagesOf(await response.arrayBuffer());
    const f1040 = rules.forms.get("F1040")!;
    const spouse = f1040.fields.find((field) => field.key === "spouseFirstName")!;
    expect(pages[0]!.filter((item) => Math.abs(item.y - spouse.y) < 4).map((item) => item.text)).toEqual(expect.arrayContaining(["Sam", "Rivera"]));
    expect(pages.slice(f1040.pages).flat().map((item) => item.text).join(" ")).toContain("your names");
    const theirs = await json<{ error: { message: string } }>(server.call("GET", `/api/years/2025/returns/${sam!.id}/forms`), 404);
    expect(theirs.error.message).toBe("This person is on a joint return: print it from the return of the person preparing");
  });
});

describe("an upload in a United States year", () => {
  it("reads the US forms into the returns of the people named on them; a dependant's 1098-T isn't added", async () => {
    server.close();
    const asked: string[] = [];
    server = await startServer({
      now: () => 1_767_225_600_000,
      reader: () => ({
        read: async (_, context) => {
          asked.push(context.rules.reading.documents);
          const slips: ReadSlip[] = [
            { type: "W2", person: "Alex Rivera", issuer: "Maple Corp", boxes: { 1: "60000.00", 2: "6500.00", a: "123-45-6789" }, unsure: [] },
            { type: "F1098E", person: "Alex Rivera", issuer: "Great Lakes Student Loans", boxes: { 1: "1800.00" }, unsure: [] },
            { type: "F1098T", person: "Riley Rivera", issuer: "Prairie Community College", boxes: { 1: "3800.00" }, unsure: [] },
          ];
          return { kind: "read", taxYear: 2025, model: "test", slips };
        },
      }),
    });
    const alex = await addPerson("Alex Rivera", "self");
    const riley = await addPerson("Riley Rivera", "child", "2006-04-04");
    await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id, riley.id] } }), 201);
    const response = await server.call("POST", "/api/years/2025/documents", {
      raw: new TextEncoder().encode("%PDF-1.4\n% forms\n%%EOF\n") as Uint8Array<ArrayBuffer>,
      headers: { "Content-Type": "application/pdf", "X-File-Name": "forms.pdf", "X-Person-Id": alex.id },
    });
    const body = await json<{ status: string; message: string }>(response);
    expect(asked).toEqual(["United States information returns (Forms W-2, 1099, 1098 and SSA-1099)"]);
    expect(body.status).toBe("read");
    expect(body.message).toBe(
      "W-2 from Maple Corp; 1098-E from Great Lakes Student Loans; 1098-T from Prairie Community College is Riley Rivera's, who has no return here: not added",
    );
    const { slips } = await json<SlipList>(server.call("GET", "/api/years/2025/slips"));
    // Only the boxes of the form's type are kept: box "a" (the employee's SSN) isn't one.
    expect(slips.map((slip) => [slip.type, slip.personId, slip.boxes]).sort(([a], [b]) => String(b).localeCompare(String(a)))).toEqual([
      ["W2", alex.id, { 1: "60000", 2: "6500" }],
      ["F1098E", alex.id, { 1: "1800" }],
    ]);
  });
});

describe("a joint return", () => {
  /** Alex and Sam, married, both in a US 2025 year. */
  async function couple() {
    const alex = await addPerson("Alex Rivera", "self", "1984-02-02");
    const sam = await addPerson("Sam Rivera", "spouse", "1986-06-06");
    const year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id, sam.id] } }), 201);
    return { alex, sam, year };
  }
  const personal = (revision: number, filingStatus: string | null, adults: { personId: string }[]) =>
    server.call("PUT", "/api/years/2025/personal-info", {
      body: { revision, maritalStatus: "married", filingStatus, adults: adults.map(({ personId }) => ({ personId, province: "FL", residentAllYear: true })) },
    });

  it("is one return with both spouses on it, and two again when they file separately", async () => {
    const { alex, sam, year } = await couple();
    expect(year.returns.map((each) => each.members)).toEqual([[alex.id], [sam.id]]);
    const joint = await json<TaxYear>(personal(year.revision, "joint", [{ personId: alex.id }, { personId: sam.id }]));
    expect(joint.filingStatus).toBe("joint");
    expect(joint.issues).toEqual([]);
    expect(joint.returns.map((each) => [each.personId, each.members])).toEqual([[alex.id, [alex.id, sam.id]]]);
    const list = await json<YearList>(server.call("GET", "/api/years"));
    expect(list.years[0]!.returns.map((each) => [each.name, each.members])).toEqual([["Alex Rivera", [alex.id, sam.id]]]);
    const separate = await json<TaxYear>(personal(joint.revision, "separate", [{ personId: alex.id }, { personId: sam.id }]));
    expect(separate.returns.map((each) => each.members)).toEqual([[alex.id], [sam.id]]);
  });

  it("is chosen only by a married couple on a US return, and needs the spouse in the year", async () => {
    const { alex, year } = await couple();
    // Without the spouse in the year, a joint return can't be prepared: the year says so.
    let changed = await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: year.revision, people: [alex.id] } }));
    changed = await json<TaxYear>(personal(changed.revision, "joint", [{ personId: alex.id }]));
    expect(changed.issues.map((issue) => [issue.code, issue.message])).toEqual([
      ["no_filing_status", "Sam Rivera isn't in this year: add them to file jointly, or file separately."],
    ]);
    expect(changed.returns.map((each) => each.members)).toEqual([[alex.id]]);
    // A Canadian year has no filing status.
    const other = await startServer({ now: () => 1_767_225_600_000 });
    try {
      const pat = (await (await other.call("POST", "/api/people", { body: { name: "Pat Lee", relationship: "self", birthDate: "1980-01-01" } })).json()) as Person;
      const ca = (await (await other.call("POST", "/api/years", { body: { year: 2025, people: [pat.id] } })).json()) as TaxYear;
      const refused = await other.call("PUT", "/api/years/2025/personal-info", {
        body: { revision: ca.revision, maritalStatus: "single", filingStatus: "joint", adults: [{ personId: pat.id, province: "ON", residentAllYear: true }] },
      });
      expect(refused.status).toBe(400);
    } finally {
      other.close();
    }
  });

  it("works out both spouses' income on one return, and finishes when both are done", async () => {
    const { alex, sam, year } = await couple();
    let current = await json<TaxYear>(personal(year.revision, "joint", [{ personId: alex.id }, { personId: sam.id }]));
    const w2 = (personId: string, issuer: string, wages: string, withheld: string) =>
      json<TaxYear>(
        server.call("POST", "/api/years/2025/slips", {
          body: { revision: current.revision, personId, type: "W2", issuer, boxes: { 1: wages, 2: withheld, 4: "0", 5: wages, 6: (Number(wages) * 0.0145).toFixed(2) } },
        }),
        201,
      );
    current = await w2(alex.id, "Globex", "140000", "24000");
    current = await w2(sam.id, "Initech", "50000", "4200");
    const answers = (personId: string) =>
      server.call("PUT", "/api/years/2025/answers", {
        body: { revision: current.revision, personId, answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" } },
      });
    current = await json<TaxYear>(answers(alex.id));
    // Sam's answers are still missing: the joint return isn't done.
    expect(current.returns[0]!.steps.income).toBe("todo");
    current = await json<TaxYear>(answers(sam.id));
    current = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: current.revision } }));
    expect(current.returns[0]!.steps).toMatchObject({ personal: "done", income: "done", confirm: "done", finish: "done" });
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.family.filingStatus).toBe("joint");
    const [mine, theirs] = estimate.result.people;
    const line = (id: string) => mine!.lines.find((each) => each.id === id)?.value;
    // $190,000 of wages less $31,500: $158,500, on the Tax Computation Worksheet's Section B (22% less $10,172).
    expect([line("F1040.9"), line("F1040.15"), line("F1040.16"), line("F1040.33")]).toEqual(["190000", "158500", "24698", "28200"]);
    expect(theirs!.lines).toEqual([]);
  });
});

describe("dependants on a US return", () => {
  const childAnswers = { relationship: "child", monthsWithYou: "12", hasSSN: true, paidOwnSupport: false, filedJointReturn: false, citizenOrResident: true };

  /** Alex, single, with a child of 8 in a US 2025 year, the facts saved; `spouse` adds Sam, married. */
  async function family(spouse = false) {
    const alex = await addPerson("Alex Rivera", "self", "1985-02-02");
    const sam = spouse ? await addPerson("Sam Rivera", "spouse", "1986-06-06") : undefined;
    const ava = await addPerson("Ava Rivera", "child", "2017-05-05");
    const people = [alex, ...(sam ? [sam] : []), ava];
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: people.map((each) => each.id) } }), 201);
    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", {
        body: {
          revision: year.revision,
          maritalStatus: sam ? "married" : "single",
          ...(sam ? { filingStatus: "separate" } : {}),
          adults: [alex, ...(sam ? [sam] : [])].map((each) => ({ personId: each.id, province: "FL", residentAllYear: true })),
        },
      }),
    );
    return { alex, sam, ava, year };
  }
  const save = (revision: number, personId: string, answers: Record<string, unknown>) =>
    server.call("PUT", "/api/years/2025/answers", { body: { revision, personId, answers } });

  it("keeps answers about a dependant apart from an adult's", async () => {
    const { alex, ava, year } = await family();
    const adultQuestion = await json<{ error: { issues: { path: string; message: string }[] } }>(save(year.revision, ava.id, { isBlind: false }), 400);
    expect(adultQuestion.error.issues).toEqual([{ path: "answers.isBlind", message: "Not a question about a dependant" }]);
    const dependantQuestion = await json<{ error: { issues: { path: string; message: string }[] } }>(save(year.revision, alex.id, { relationship: "child" }), 400);
    expect(dependantQuestion.error.issues).toEqual([{ path: "answers.relationship", message: "A question about a dependant" }]);
    await json<TaxYear>(save(year.revision, ava.id, childAnswers));
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.family.dependants[0]!.answers).toMatchObject({ relationship: "child", monthsWithYou: "12" });
  });

  it("makes a single parent head of household with the child tax credit, once the child's questions are answered", async () => {
    const { alex, ava, year } = await family();
    let current = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", {
        body: { revision: year.revision, personId: alex.id, type: "W2", issuer: "City Clinic", boxes: { 1: "58000", 2: "1500", 4: "3596", 5: "58000", 6: "841" } },
      }),
      201,
    );
    current = await json<TaxYear>(save(current.revision, alex.id, { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0", paidHalfOfHome: true, hasValidSSN: true, paidForCare: false }));
    // The child's questions are still to answer: Personal info isn't done.
    expect(current.returns[0]!.steps.personal).toBe("todo");
    current = await json<TaxYear>(save(current.revision, ava.id, childAnswers));
    expect(current.returns[0]!.steps.personal).toBe("done");
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    const line = (id: string) => estimate.result.people[0]!.lines.find((each) => each.id === id)?.value;
    // $58,000 less $23,625: $34,375, the Tax Table's head of household row ($3,785); one child tax credit of $2,200.
    expect([line("F1040.15"), line("F1040.16"), line("F1040.19"), line("F1040.24")]).toEqual(["34375", "3785", "2200", "1585"]);
  });

  it("puts a dependant on the spouse's return when a couple filing separately says so", async () => {
    const { sam, ava, year } = await family(true);
    const current = await json<TaxYear>(save(year.revision, ava.id, { ...childAnswers, claimedBy: "spouse" }));
    let estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.family.dependants[0]!.claimedBy).toBe(sam!.id);
    await json<TaxYear>(save(current.revision, ava.id, { claimedBy: "self" }));
    estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.family.dependants[0]!.claimedBy).toBeUndefined();
  });
});

describe("the earned income credit", () => {
  it("is worked out for a low income, once the filer's SSN is answered", async () => {
    const rae = await addPerson("Rae Lopez", "self", "1995-04-04");
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [rae.id] } }), 201);
    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", { body: { revision: year.revision, maritalStatus: "single", adults: [{ personId: rae.id, province: "FL", residentAllYear: true }] } }),
    );
    year = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", {
        body: { revision: year.revision, personId: rae.id, type: "W2", issuer: "Corner Market", boxes: { 1: "9000", 2: "0", 4: "558", 5: "9000", 6: "130.50" } },
      }),
      201,
    );
    const answers = { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" };
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: rae.id, answers } }));
    let estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    // The credit needs a valid SSN: asked before the credit is worked out.
    expect(estimate.result.people[0]!.missing.map((item) => item.question)).toEqual(["hasValidSSN"]);
    await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: rae.id, answers: { hasValidSSN: true } } }));
    estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    const line = (id: string) => estimate.result.people[0]!.lines.find((each) => each.id === id)?.value;
    // $9,000 of earned income without a qualifying child: the largest credit, $649.
    expect([line("F1040.27a"), line("F1040.34")]).toEqual(["649", "649"]);
  });

  it("asks a couple filing separately whether they lived apart, only with a qualifying child", async () => {
    const max = await addPerson("Max Ford", "self", "1992-10-10");
    const liv = await addPerson("Liv Ford", "spouse", "1993-11-11");
    const kit = await addPerson("Kit Ford", "child", "2021-06-06");
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [max.id, liv.id, kit.id] } }), 201);
    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", {
        body: { revision: year.revision, maritalStatus: "married", filingStatus: "separate", adults: [max, liv].map((each) => ({ personId: each.id, province: "FL", residentAllYear: true })) },
      }),
    );
    year = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", {
        body: { revision: year.revision, personId: max.id, type: "W2", issuer: "Garage", boxes: { 1: "20000", 2: "400", 4: "1240", 5: "20000", 6: "290" } },
      }),
      201,
    );
    const questions = async () => (await json<Estimate>(server.call("GET", "/api/years/2025/estimate"))).result.people[0]!.questions;
    expect(await questions()).not.toContain("livedApartLastSixMonths");
    await json<TaxYear>(
      server.call("PUT", "/api/years/2025/answers", {
        body: { revision: year.revision, personId: kit.id, answers: { relationship: "child", monthsWithYou: "12", hasSSN: true, filedJointReturn: false } },
      }),
    );
    expect(await questions()).toContain("livedApartLastSixMonths");
  });
});

describe("a US form with a code box", () => {
  it("keeps a code the box can hold, and refuses another, or an amount, there", async () => {
    const alex = await addPerson("Alex Rivera", "self");
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } }), 201);
    const add = (boxes: Record<string, string>) => server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: alex.id, type: "B", issuer: "Broker", boxes } });
    const refused = await json<{ error: { issues: { path: string; message: string }[] } }>(add({ CAT: "Z", "1D": "100", "1E": "50" }), 400);
    expect(refused.error.issues).toEqual([{ path: "boxes.CAT", message: "One of A, B, D, E" }]);
    const amount = await json<{ error: { issues: { path: string; message: string }[] } }>(add({ CAT: "A", "1D": "D" }), 400);
    expect(amount.error.issues).toEqual([{ path: "boxes.1D", message: "Enter an amount like 1234.56" }]);
    year = await json<TaxYear>(add({ CAT: "A", "1D": "100.50", "1E": "50" }), 201);
    const { slips } = await json<SlipList>(server.call("GET", "/api/years/2025/slips"));
    expect(slips[0]!.boxes).toEqual({ CAT: "A", "1D": "100.5", "1E": "50" });
  });
});

describe("hints on a US year", () => {
  it("tells a couple filing separately what filing jointly saves, as the year filed jointly works out", async () => {
    const alex = await addPerson("Alex Rivera", "self", "1985-02-02");
    const sam = await addPerson("Sam Rivera", "spouse", "1986-06-06");
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id, sam.id] } }), 201);
    const facts = (filingStatus: "joint" | "separate") => ({
      revision: year.revision,
      maritalStatus: "married",
      filingStatus,
      adults: [alex, sam].map((each) => ({ personId: each.id, province: "FL", residentAllYear: true })),
    });
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/personal-info", { body: facts("separate") }));
    const none = { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0", spouseItemizes: false };
    for (const [person, wages, withheld] of [[alex, "140000", "24000"], [sam, "20000", "1500"]] as const) {
      year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: person.id, type: "W2", issuer: "Acme", boxes: { 1: wages, 2: withheld } } }), 201);
      year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: person.id, answers: none } }));
    }
    const net = async () => {
      const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
      return estimate.result.people.reduce((total, person) => {
        const value = (id: string) => Number(person.lines.find((line) => line.id === id)?.value ?? 0);
        return total + value("F1040.34") - value("F1040.37");
      }, 0);
    };
    const separately = await net();
    const { hints } = await json<{ hints: { id: string; personId: string; kind: string; effect: string | null; state: string }[] }>(server.call("GET", "/api/years/2025/hints"));
    const joint = hints.filter((hint) => hint.id === "fileJointly");
    expect(joint).toHaveLength(1);
    expect(joint[0]).toMatchObject({ personId: alex.id, kind: "info", state: "open" });
    // It is only something to know: the filing status is changed on Personal info.
    const refused = await json<{ error: { message: string } }>(server.call("POST", "/api/years/2025/hints/fileJointly", { body: { revision: year.revision, personId: alex.id, decision: "accept" } }), 400);
    expect(refused.error.message).toBe("Only a saving can be accepted");
    // Filed jointly for real, the two of them get what the hint said.
    year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    await json<TaxYear>(server.call("PUT", "/api/years/2025/personal-info", { body: facts("joint") }));
    expect((await net()) - separately).toBe(Number(joint[0]!.effect));
  });
});
