import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear, YearList } from "#shared";
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
    expect(year.issues.map((issue) => issue.code).sort()).toEqual(["no_marital_status", "no_residency"]);
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

  it("records no province, and no common-law status", async () => {
    const alex = await addPerson("Alex Rivera", "self");
    const sam = await addPerson("Sam Rivera", "spouse");
    const year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id, sam.id] } }), 201);
    const save = (maritalStatus: string, province: string | null) =>
      server.call("PUT", "/api/years/2025/personal-info", {
        body: { revision: year.revision, maritalStatus, adults: [{ personId: alex.id, province, residentAllYear: true }] },
      });
    const withProvince = await json<{ error: { issues: { path: string }[] } }>(save("married", "ON"), 400);
    expect(withProvince.error.issues.map((issue) => issue.path)).toEqual(["adults.0.province"]);
    expect((await save("common_law", null)).status).toBe(400);
    const saved = await json<TaxYear>(save("married", null));
    expect(saved.adults[0]).toEqual({ personId: alex.id, province: null, residentAllYear: true, prepared: true });
    // Married, the couple still has to choose to file jointly or separately.
    expect(saved.issues.map((issue) => issue.code)).toEqual(["no_filing_status", "no_residency"]);
  });

  it("works out the return with the US rules, from a W-2 to the refund, and finishes it", async () => {
    const alex = await addPerson("Alex Rivera", "self", "1991-03-03");
    let year = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } }), 201);
    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", {
        body: { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: null, residentAllYear: true }] },
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
    // $40,000 less $15,750 is $24,250: the Tax Table's $24,250-$24,300 row, $2,675. The total waits for the answer
    // about tips and overtime pay, which the 2025 return can deduct.
    expect([line(estimate, "F1040.15"), line(estimate, "F1040.16"), line(estimate, "F1040.24")]).toEqual(["24250", "2675", null]);

    year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/answers", {
        body: { revision: year.revision, personId: alex.id, answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" } },
      }),
    );
    const answered = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect([line(answered, "F1040.24"), line(answered, "F1040.34"), line(answered, "F1040.37")]).toEqual(["2675", "825", "0"]);
    year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision } }));
    expect(year.returns[0]!.steps).toMatchObject({ personal: "done", income: "done", deductions: "done", credits: "done", confirm: "done", finish: "done" });
    // There are no official forms to print it on yet.
    const forms = await json<{ error: { message: string } }>(server.call("GET", `/api/years/2025/returns/${alex.id}/forms`), 404);
    expect(forms.error.message).toBe("Printing this return on the official forms isn't available yet");
  });
});

describe("an upload in a United States year", () => {
  it("keeps the file unread, and says to enter the forms by hand", async () => {
    server.close();
    // A reader that would read anything: a US year doesn't ask it.
    server = await startServer({ now: () => 1_767_225_600_000, reader: () => ({ read: async () => ({ kind: "read", taxYear: 2025, slips: [], model: "test" }) }) });
    const alex = await addPerson("Alex Rivera", "self");
    await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } }), 201);
    const response = await server.call("POST", "/api/years/2025/documents", {
      raw: new TextEncoder().encode("%PDF-1.4\n% W-2\n%%EOF\n") as Uint8Array<ArrayBuffer>,
      headers: { "Content-Type": "application/pdf", "X-File-Name": "w2.pdf", "X-Person-Id": alex.id },
    });
    const body = await response.text();
    expect(response.status, body).toBeLessThan(300);
    expect(body).toContain("Reading U.S. forms isn't available yet");
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
      body: { revision, maritalStatus: "married", filingStatus, adults: adults.map(({ personId }) => ({ personId, province: null, residentAllYear: true })) },
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
        body: { revision: current.revision, personId, answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" } },
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
