import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import type { FormSource } from "../../src/app/server/lib/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { VIEWER, startServer, type TestServer } from "../support/server.ts";

// Printing a return on the CRA's forms. The CRA's PDFs aren't in the repository, so these tests print on blank
// stand-in pages of the same size and count, and read the amounts back from where they were written.

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
      const form = [...rules.forms.values()].find((each) => each.url === url)!;
      const pdf = await PDFDocument.create();
      for (let page = 0; page < form.pages; page += 1) pdf.addPage([612, 792]);
      return pdf.save();
    },
  };
}

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

const T4: { type: string; issuer: string; boxes: Record<string, string> } = { type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } };

/** Alex, single in Ontario, with a T4 (or the slip given): the year at its revision, Alex's slips not yet confirmed. */
async function alexWithT4({ residentAllYear = true as boolean | null, slip = T4 } = {}): Promise<{ alex: Person; revision: number }> {
  const alex = await json<Person>(server.call("POST", "/api/people", { body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } }), 201);
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } }), 201);
  let year = await json<TaxYear>(
    server.call("PUT", "/api/years/2025/household", { body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear }] } }),
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
  let year = await json<TaxYear>(server.call("PUT", "/api/years/2025/household", { body: { revision: 1, maritalStatus: "married", adults } }));
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

const download = (personId: string, as?: typeof VIEWER) => server.call("GET", `/api/years/2025/returns/${personId}/forms`, as ? { as } : {});

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

  it("refuses a form that isn't the one the layout was measured on", async () => {
    server = await startServer({ forms: { ...standIn(), checkHash: true } });
    const { alex, revision } = await alexWithT4();
    await finish(alex, revision);
    const refused = await json<{ error: { code: string; message: string } }>(download(alex.id), 503);
    expect(refused.error).toMatchObject({ code: "unavailable", message: expect.stringMatching(/The CRA has changed T1 Income Tax and Benefit Return/) });
  });

  it.each([
    [null, /Say whether Alex Martin lived in Canada all year\./],
    [false, /Alex Martin moved to or from Canada during the year, which this app doesn't handle yet\./],
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
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/household", { body: { revision: year.revision, maritalStatus: "married", adults } }));
    expect(year.returns.map((each) => each.steps.finish)).toEqual(["done", "done"]);
    expect((await download(alex.id)).status).toBe(200);
  });

  it("answers 404 for someone who has no return in the year", async () => {
    server = await startServer({ forms: standIn() });
    await alexWithT4();
    expect((await download("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
