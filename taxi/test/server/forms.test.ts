import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { officialForms, type FormSource } from "../../src/app/server/lib/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { VIEWER, startServer, type TestServer } from "../support/server.ts";

// Printing a return on the CRA's forms (and Revenu Québec's, for a resident of Quebec). The PDFs aren't in the
// repository, so these tests print on blank stand-in pages of the same size and count, and read the amounts back from
// where they were written.

const rules = rulesFor(2025)!;
let server: TestServer;
afterEach(() => server.close());

/** Blank pages for each form, counting the downloads. */
function standIn(): FormSource & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    checkHash: false,
    async fetch(url) {
      fetched.push(url);
      const form = versionAt(url);
      const pdf = await PDFDocument.create();
      // Revenu Québec's pages are a little smaller than the CRA's.
      const size: [number, number] = url.includes("revenuquebec.ca") ? [603, 774] : [612, 792];
      for (let page = 0; page < form.pages; page += 1) pdf.addPage(size);
      return pdf.save();
    },
  };
}

/** The form, in English or in French, published at a url. */
function versionAt(url: string) {
  const form = [...rules.forms.values()].find((each) => each.url === url || each.french?.url === url)!;
  return form.french?.url === url ? { ...form, ...form.french } : form;
}

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

const T4: { type: string; issuer: string; boxes: Record<string, string> } = { type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } };

/** Alex, single in Ontario (or the province given), with a T4 (or the slip given): the year at its revision, Alex's slips not yet confirmed. */
async function alexWithT4({ residentAllYear = true as boolean | null, slip = T4, province = "ON" } = {}): Promise<{ alex: Person; revision: number }> {
  const alex = await json<Person>(server.call("POST", "/api/people", { body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } }), 201);
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } }), 201);
  let year = await json<TaxYear>(
    server.call("PUT", "/api/years/2025/personal-info", { body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province, residentAllYear }] } }),
  );
  year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: alex.id, ...slip } }), 201);
  return { alex, revision: year.revision };
}

/** Answers every question the return still assumes (and any answers given), and confirms the slips. */
async function finish(alex: Person, revision: number, answers: Record<string, string | boolean> = {}): Promise<TaxYear> {
  const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
  const assumed = Object.fromEntries(estimate.result.people.find((person) => person.personId === alex.id)!.estimates.map((item) => [item.question, item.assumed]));
  let year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision, personId: alex.id, answers: { ...assumed, ...answers } } }));
  year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision, personId: alex.id } }));
  return year;
}

/** Alex and Sam, married in Ontario, each with a T4, Sam's questions answered and Sam's slip not confirmed. */
async function couple(samResidentAllYear: boolean | null = true): Promise<{ alex: Person; sam: Person; revision: number }> {
  const alex = await json<Person>(server.call("POST", "/api/people", { body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } }), 201);
  const sam = await json<Person>(server.call("POST", "/api/people", { body: { name: "Sam Martin", relationship: "spouse", birthDate: "1987-09-15" } }), 201);
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, sam.id] } }), 201);
  const adults = [
    { personId: alex.id, province: "ON", residentAllYear: true },
    { personId: sam.id, province: "ON", residentAllYear: samResidentAllYear },
  ];
  let year = await json<TaxYear>(server.call("PUT", "/api/years/2025/personal-info", { body: { revision: 1, maritalStatus: "married", adults } }));
  year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: alex.id, ...T4 } }), 201);
  year = await json<TaxYear>(
    server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T4", issuer: "Birch Ltd", boxes: { 14: "30000", 22: "4000" } } }),
    201,
  );
  const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
  const assumed = Object.fromEntries(estimate.result.people.find((person) => person.personId === sam.id)!.estimates.map((item) => [item.question, item.assumed]));
  year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: sam.id, answers: assumed } }));
  return { alex, sam, revision: year.revision };
}

/** Each page's text, with where it starts. */
async function pagesOf(bytes: ArrayBuffer) {
  const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const items = (await (await doc.getPage(page)).getTextContent()).items.flatMap((item) => ("str" in item && item.str.trim() ? [{ text: item.str, x: item.transform[4] as number, y: item.transform[5] as number }] : []));
    pages.push(items);
  }
  return pages;
}

const download = (personId: string, as?: typeof VIEWER, query = "") => server.call("GET", `/api/years/2025/returns/${personId}/forms${query}`, as ? { as } : {});

/** Camille, single in Quebec, with a T4 and an RL-1 for the same pay: the return is finished. */
async function camilleInQuebec(): Promise<Person> {
  const camille = await json<Person>(server.call("POST", "/api/people", { body: { name: "Camille Roy", relationship: "self", birthDate: "1991-03-14" } }), 201);
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [camille.id] } }), 201);
  let year = await json<TaxYear>(
    server.call("PUT", "/api/years/2025/personal-info", { body: { revision: 1, maritalStatus: "single", adults: [{ personId: camille.id, province: "QC", residentAllYear: true }] } }),
  );
  year = await json<TaxYear>(
    server.call("POST", "/api/years/2025/slips", {
      body: { revision: year.revision, personId: camille.id, type: "T4", issuer: "Érable Conseil inc.", boxes: { 14: "62000", 17: "3744", 22: "7400", 26: "62000", 55: "306.28", 56: "62000" } },
    }),
    201,
  );
  year = await json<TaxYear>(
    server.call("POST", "/api/years/2025/slips", {
      body: { revision: year.revision, personId: camille.id, type: "RL1", issuer: "Érable Conseil inc.", boxes: { A: "62000", B_A: "3744", E: "6900", G: "62000", H: "306.28", I: "62000" } },
    }),
    201,
  );
  await finish(camille, year.revision);
  return camille;
}

describe("printing a return", () => {
  it("refuses a return that isn't finished, saying what is left", async () => {
    const source = standIn();
    server = await startServer({ forms: source });
    const { alex } = await alexWithT4();
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 409);
    expect(refused.error.message).toMatch(/1 slip is not confirmed yet/);
    expect(source.fetched).toEqual([]);
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(year.returns[0]!.steps.finish).toBe("todo");
  });

  it("lists a saving on the worksheet while it holds, and not once its answers were changed", async () => {
    server = await startServer({ forms: standIn() });
    const add = (name: string, relationship: string, birthDate: string) => json<Person>(server.call("POST", "/api/people", { body: { name, relationship, birthDate } }), 201);
    const alex = await add("Alex Martin", "self", "1985-04-02");
    const sam = await add("Sam Martin", "spouse", "1987-09-15");
    await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, sam.id] } }), 201);
    const adults = [alex, sam].map((person) => ({ personId: person.id, province: "ON", residentAllYear: true }));
    let year = await json<TaxYear>(server.call("PUT", "/api/years/2025/personal-info", { body: { revision: 1, maritalStatus: "married", adults } }));
    for (const person of [alex, sam]) {
      const body = { revision: year.revision, personId: person.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } };
      year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body }), 201);
      year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: person.id, answers: { donations: "150" } } }));
    }
    year = await json<TaxYear>(server.call("POST", "/api/years/2025/hints/poolDonations", { body: { revision: year.revision, personId: alex.id, decision: "accept" } }));
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    for (const person of estimate.result.people) {
      const answers = Object.fromEntries(person.estimates.map((item) => [item.question, item.assumed]));
      year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: person.personId, answers } }));
      year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision, personId: person.personId } }));
    }
    const worksheet = async () => (await pagesOf(await (await download(alex.id)).arrayBuffer())).flat().map((item) => item.text);
    const title = rules.hints.get("poolDonations")!.title;
    expect(await worksheet()).toEqual(expect.arrayContaining(["Hints applied", title]));
    // The donations moved back by hand: the saving no longer holds, so the worksheet doesn't claim it.
    for (const person of [alex, sam]) {
      year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: person.id, answers: { claimSpouseDonations: false } } }));
    }
    const after = await worksheet();
    expect(after).not.toContain("Hints applied");
    expect(after).not.toContain(title);
  });

  it("prints a finished return on the T1 and ON428, then its worksheet; the forms are downloaded once", async () => {
    const source = standIn();
    server = await startServer({ forms: source });
    const { alex, revision } = await alexWithT4();
    const year = await finish(alex, revision);
    expect(year.returns[0]!.steps.finish).toBe("done");

    const response = await download(alex.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(`inline; filename*=UTF-8''${encodeURIComponent("Taxi 2025 return - Alex Martin.pdf")}`);
    const saved = await server.call("GET", `/api/years/2025/returns/${alex.id}/forms?download=1`);
    expect(saved.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    const pages = await pagesOf(await response.arrayBuffer());
    const t1 = rules.forms.get("T1")!;
    expect(pages.length).toBeGreaterThan(t1.pages + rules.forms.get("ON428")!.pages);

    // Line 10100 (row 1, page 3): $60,000.00, dollars left of the cents line, cents right of it.
    const row1 = t1.fields.find((field) => field.key === "1")!;
    const written = pages[row1.page - 1]!.filter((item) => Math.abs(item.y - row1.y) < 0.5);
    expect(written.map((item) => item.text)).toEqual(["60,000", "00"]);
    expect(written[0]!.x).toBeLessThan(row1.x);
    expect(written[1]!.x).toBeGreaterThan(row1.x);
    // ON428 starts after the T1's pages; its row 1 is the taxable income.
    const on1 = rules.forms.get("ON428")!.fields.find((field) => field.key === "1")!;
    expect(pages[t1.pages + on1.page - 1]!.some((item) => item.text === "60,000" && Math.abs(item.y - on1.y) < 0.5)).toBe(true);

    // Step 1: the name split into first and last, the birth date one digit per box, the marital status ticked, the
    // province; never a SIN or an address (the app has none).
    const place = (key: string) => t1.fields.find((field) => field.key === key)!;
    const at = (key: string) =>
      pages[place(key).page - 1]!.filter((item) => Math.abs(item.y - place(key).y) < 4 && item.x >= place(key).x - 6 && item.x < place(key).x + 130).map((item) => item.text);
    expect(at("firstName")).toEqual(["Alex"]);
    expect(at("lastName")).toEqual(["Martin"]);
    expect(at("province")).toEqual(["Ontario"]);
    expect(at("birthDate")).toEqual([..."19850402"]);
    const single = place("single");
    expect(pages[0]!.some((item) => item.text === "X" && Math.abs(item.x + 3 - single.x) < 1 && Math.abs(item.y - single.y) < 4)).toBe(true);
    expect(pages[0]!.some((item) => item.text === "X" && Math.abs(item.y - place("married").y) < 4)).toBe(false);
    expect(pages[0]!.map((item) => item.text)).toEqual(expect.arrayContaining(["Alex", "Martin", "Ontario"]));

    const worksheet = pages.slice(t1.pages + 4).flat().map((item) => item.text);
    expect(worksheet).toContain("Alex Martin: 2025 return worksheet");
    expect(worksheet).toContain("How each line is worked out");
    expect(worksheet).toContain("T4 from Maple Corp");
    // Only the lines this return reads: Ontario's, not another province's.
    expect(worksheet.some((text) => text.startsWith("ON428.8 "))).toBe(true);
    expect(worksheet.some((text) => /^(BC428|AB428)\./.test(text))).toBe(false);

    // A viewer can print it too; the forms kept from the first download are used again.
    expect((await download(alex.id, VIEWER)).status).toBe(200);
    expect(source.fetched).toEqual([t1.url, rules.forms.get("ON428")!.url]);
  });

  it("names the spouse in Step 1 from the profile when their return isn't prepared here, with a net income of zero", async () => {
    server = await startServer({ forms: standIn() });
    const alex = await json<Person>(server.call("POST", "/api/people", { body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } }), 201);
    await json<Person>(server.call("POST", "/api/people", { body: { name: "Jordan Lee Park", relationship: "spouse", birthDate: "1986-01-09" } }), 201);
    await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } }), 201);
    let year = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/personal-info", { body: { revision: 1, maritalStatus: "married", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] } }),
    );
    year = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } } }),
      201,
    );
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: alex.id, answers: { spouseNetIncome: "0" } } }));
    await finish(alex, year.revision);

    const pages = await pagesOf(await (await download(alex.id)).arrayBuffer());
    const t1 = rules.forms.get("T1")!;
    const field = (key: string) => t1.fields.find((each) => each.key === key)!;
    const near = (key: string) => pages[field(key).page - 1]!.filter((item) => Math.abs(item.y - field(key).y) < 4 && Math.abs(item.x - field(key).x) < 60).map((item) => item.text);
    expect(near("spouseFirstName")).toEqual(["Jordan Lee"]);
    // The CRA asks for the spouse's net income even when it is zero.
    expect(near("spouseNetIncome")).toEqual(["0", "00"]);
    expect(pages[0]!.some((item) => item.text === "X" && Math.abs(item.y - field("married").y) < 4)).toBe(true);
  });

  it("prints a Quebec resident's two returns: the T1 for residents of Quebec, then Revenu Québec's TP-1, then the worksheet", async () => {
    const source = standIn();
    server = await startServer({ forms: source });
    const camille = await camilleInQuebec();

    const pages = await pagesOf(await (await download(camille.id)).arrayBuffer());
    // The federal forms first, then the TP-1 and its schedules (no group drug plan was said, so Schedule K's premium).
    const printed = source.fetched.map((url) => [...rules.forms.values()].find((form) => form.url === url)!);
    expect(printed.map((form) => form.id)).toEqual(["T1QC", "TP1", "QCK", "QCU"]);
    const tp1 = rules.forms.get("TP1")!;
    const offset = rules.forms.get("T1QC")!.pages;
    // Line 101 (page 2 of the TP-1): the RL-1's box A, $62,000.00, on each side of the cents line.
    const line101 = tp1.fields.find((field) => field.key === "101")!;
    const written = pages[offset + line101.page - 1]!.filter((item) => Math.abs(item.y - line101.y) < 0.5);
    expect(written.map((item) => item.text)).toEqual(["62,000", "00"]);
    expect(written[0]!.x).toBeLessThan(line101.x);
    expect(written[1]!.x).toBeGreaterThan(line101.x);
    // Page 1: the name in its two boxes and no spouse; never a SIN or an address.
    const place = (key: string) => tp1.fields.find((field) => field.key === key)!;
    const at = (key: string) => pages[offset + place(key).page - 1]!.filter((item) => Math.abs(item.y - place(key).y) < 4 && Math.abs(item.x - place(key).x) < 20).map((item) => item.text);
    expect(at("lastName")).toEqual(["Roy"]);
    expect(at("firstName")).toEqual(["Camille"]);
    expect(at("spouseNo")).toEqual(["X"]);

    const worksheet = pages.slice(printed.reduce((sum, form) => sum + form.pages, 0)).flat().map((item) => item.text);
    expect(worksheet).toContain("Camille Roy: 2025 return worksheet");
    expect(worksheet.some((text) => text.startsWith("Quebec refund (TP-1 line 478)") || text.startsWith("Quebec balance due (TP-1 line 479)"))).toBe(true);
    expect(worksheet.join(" ")).toMatch(/Mail the two returns in two parts, each signed/);
  });

  it("prints Revenu Québec's forms in French when asked, the CRA's in English, and refuses another language", async () => {
    const source = standIn();
    server = await startServer({ forms: source });
    const camille = await camilleInQuebec();

    const pages = await pagesOf(await (await download(camille.id, undefined, "?language=fr")).arrayBuffer());
    const printed = source.fetched.map(versionAt);
    expect(printed.map((form) => form.id)).toEqual(["T1QC", "TP1", "QCK", "QCU"]);
    expect(source.fetched[0]).toBe(rules.forms.get("T1QC")!.url);
    expect(source.fetched.slice(1)).toEqual(["TP1", "QCK", "QCU"].map((id) => rules.forms.get(id)!.french!.url));
    // Line 101 on the French TP-1, at that version's place, written the French way.
    const tp1 = { ...rules.forms.get("TP1")!, ...rules.forms.get("TP1")!.french! };
    const line101 = tp1.fields.find((field) => field.key === "101")!;
    const offset = rules.forms.get("T1QC")!.pages;
    expect(pages[offset + line101.page - 1]!.filter((item) => Math.abs(item.y - line101.y) < 0.5).map((item) => item.text)).toEqual(["62 000", "00"]);
    expect(pages.slice(printed.reduce((sum, form) => sum + form.pages, 0)).flat().map((item) => item.text).join(" ")).toMatch(/TP-1 Déclaration de revenus/);

    const refused = await json<{ error: { code: string } }>(download(camille.id, undefined, "?language=de"), 400);
    expect(refused.error.code).toBe("validation_failed");
  });

  it("refuses a form that isn't the one the layout was measured on", async () => {
    server = await startServer({ forms: { ...standIn(), checkHash: true } });
    const { alex, revision } = await alexWithT4();
    await finish(alex, revision);
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 503);
    expect(refused.error).toMatchObject({ code: "unavailable", message: expect.stringMatching(/The CRA has changed T1 Income Tax and Benefit Return/) });
  });

  it.each([
    [null, /Say whether Alex Martin lived in Canada all year\./],
  ])("refuses a return whose 'lived in Canada all year' is %s, though every slip is confirmed", async (residentAllYear, reason) => {
    const source = standIn();
    server = await startServer({ forms: source });
    const { alex, revision } = await alexWithT4({ residentAllYear });
    const year = await finish(alex, revision);
    expect(year.returns[0]!.steps.finish).toBe("todo");
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 409);
    expect(refused.error.message).toMatch(reason);
    expect(source.fetched).toEqual([]);
  });

  it("refuses a return with a kind of income added without its slip", async () => {
    const source = standIn();
    server = await startServer({ forms: source });
    const { alex, revision } = await alexWithT4({ slip: { type: "T5", issuer: "Maple Bank", boxes: { 13: "1200" } } });
    const year = await finish(alex, revision, { hasEmploymentIncome: true });
    expect(year.returns[0]!.steps).toMatchObject({ income: "todo", confirm: "done", finish: "todo" });
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 409);
    expect(refused.error.message).toMatch(/Waiting for a slip: the T4 \(Employment income\)\./);
    expect(source.fetched).toEqual([]);
  });

  it("waits for the spouse's slips to be confirmed, as a couple's returns read each other", async () => {
    server = await startServer({ forms: standIn() });
    const { alex, sam, revision } = await couple();
    let year = await finish(alex, revision);
    expect(year.returns.find((each) => each.personId === alex.id)!.steps.finish).toBe("todo");
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 409);
    expect(refused.error.message).toMatch(/Sam Martin's return: 1 slip is not confirmed yet\./);

    year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision, personId: sam.id } }));
    expect(year.returns.map((each) => each.steps.finish)).toEqual(["done", "done"]);
    expect((await download(alex.id)).status).toBe(200);
  });

  it("waits for the spouse's facts on Personal info, as this return reads their income", async () => {
    server = await startServer({ forms: standIn() });
    const { alex, sam, revision } = await couple(null);
    let year = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision, personId: sam.id } }));
    year = await finish(alex, year.revision);
    expect(year.returns.find((each) => each.personId === alex.id)!.steps.finish).toBe("todo");
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 409);
    expect(refused.error.message).toMatch(/Sam Martin's return: Say whether Sam Martin lived in Canada all year\./);

    const adults = [{ personId: sam.id, province: "ON", residentAllYear: true }];
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/personal-info", { body: { revision: year.revision, maritalStatus: "married", adults } }));
    const debug = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    // Now a full-year resident, Sam's return asks what it didn't before (the Canada training credit limit).
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    const assumed = Object.fromEntries(estimate.result.people.find((person) => person.personId === sam.id)!.estimates.map((item) => [item.question, item.assumed]));
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: sam.id, answers: assumed } }));
    expect(year.returns.map((each) => each.steps.finish)).toEqual(["done", "done"]);
    expect((await download(alex.id)).status).toBe(200);
  });

  it("names on the worksheet the forms the return needs that Taxi doesn't print: Schedule D for a resident of Quebec", async () => {
    const source = standIn();
    server = await startServer({ forms: source });
    const camille = await camilleInQuebec();
    const text = (await pagesOf(await (await download(camille.id)).arrayBuffer())).flat().map((item) => item.text).join(" ");
    expect(text).toMatch(/Forms to fill in yourself Schedule D, Solidarity Tax Credit \(Revenu Québec\)/);
  });

  it("names Alberta's own Schedule 6 (5009-S6) when an Alberta return gets the Canada workers benefit", async () => {
    server = await startServer({ forms: standIn() });
    const { alex, revision } = await alexWithT4({ province: "AB", slip: { type: "T4", issuer: "Maple Corp", boxes: { 14: "15000", 22: "300" } } });
    await finish(alex, revision);
    const text = (await pagesOf(await (await download(alex.id)).arrayBuffer())).flat().map((item) => item.text).join(" ");
    expect(text).toMatch(/T1\.45300\s+Canada workers benefit/);
    expect(text).toMatch(/Forms to fill in yourself Schedule 6 \(5009-S6\)/);
    expect(text).not.toMatch(/Schedule 6 \((5005|5014)-S6\)/);
  });

  it("answers 404 for someone who has no return in the year", async () => {
    server = await startServer({ forms: standIn() });
    await alexWithT4();
    expect((await download("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("downloading the forms from canada.ca and revenuquebec.ca", () => {
  /** Alex's finished return, printed with the forms downloaded through `send`. */
  async function printWith(send: typeof fetch, timeoutMs?: number) {
    server = await startServer({ forms: officialForms(send, timeoutMs) });
    const { alex, revision } = await alexWithT4();
    await finish(alex, revision);
    return download(alex.id);
  }

  it("asks for each form with a User-Agent naming the app, and a time limit", async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    await printWith(async (url, init) => {
      asked.push({ url: String(url), init });
      return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } });
    });
    expect(asked[0]!.url).toBe(rules.forms.get("T1")!.url);
    const headers = new Headers(asked[0]!.init?.headers);
    expect(headers.get("User-Agent")).toMatch(/Taxi/);
    expect(headers.get("Accept")).toBe("application/pdf");
    expect(asked[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers 503 when canada.ca can't be reached", async () => {
    const refused = await json<{ error: { code: string; message: string } }>(printWith(() => Promise.reject(new TypeError("fetch failed"))), 503);
    expect(refused.error).toMatchObject({ code: "unavailable", message: expect.stringMatching(/couldn't be downloaded: canada\.ca couldn't be reached/) });
  });

  it("answers 503 when canada.ca doesn't answer in time", async () => {
    const refused = await json<{ error: { code: string; message: string } }>(printWith(() => new Promise<Response>(() => {}), 50), 503);
    expect(refused.error).toMatchObject({ code: "unavailable", message: expect.stringMatching(/canada\.ca didn't answer in time/) });
  });

  it("answers 503 when the form's download doesn't finish in time", async () => {
    const endless = () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/pdf" } });
    const refused = await json<{ error: { code: string; message: string } }>(printWith(async () => endless(), 50), 503);
    expect(refused.error).toMatchObject({ code: "unavailable", message: expect.stringMatching(/canada\.ca didn't answer in time/) });
  });
});
