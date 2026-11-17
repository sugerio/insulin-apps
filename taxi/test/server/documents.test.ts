import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentList, Estimate, Person, SlipList, TaxYear, UploadResult } from "#shared";
import type { ReadContext, ReadOutcome, SlipReader } from "../../src/app/server/lib/reader.ts";
import { VIEWER, startServer, type TestServer } from "../support/server.ts";

// Uploads with a reader that gives recorded answers: no test calls the model.

let server: TestServer;
let answers: ReadOutcome[];
let contexts: ReadContext[];
const reader: SlipReader = {
  async read(_file, context) {
    contexts.push(context);
    return answers.shift() ?? { kind: "read", taxYear: 2025, slips: [], model: "test-model" };
  },
};

beforeEach(async () => {
  answers = [];
  contexts = [];
  server = await startServer({ now: () => 1_767_225_600_000, reader: () => reader });
});
afterEach(() => server.close());

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

/** Alex and Sam, both in 2025 in Ontario. */
async function couple() {
  const add = (name: string, relationship: string, birthDate: string) => json<Person>(server.call("POST", "/api/people", { body: { name, relationship, birthDate } }), 201);
  const alex = await add("Alex Martin", "self", "1985-04-02");
  const sam = await add("Sam Martin", "spouse", "1987-09-15");
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, sam.id] } }), 201);
  return { alex, sam };
}

/** A PDF's bytes: only its first bytes matter to the app; `tag` makes each file different. */
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n%%EOF\n`) as Uint8Array<ArrayBuffer>;
const upload = (bytes: Uint8Array<ArrayBuffer>, name = "slip.pdf", contentType = "application/pdf", as?: typeof VIEWER) =>
  server.call("POST", "/api/years/2025/documents", { raw: bytes, headers: { "Content-Type": contentType, "X-File-Name": encodeURIComponent(name) }, ...(as ? { as } : {}) });

const T4 = { type: "T4", person: "SAM MARTIN", issuer: "Island Grocers", boxes: { 14: "31,000.00", 16: "1636.25", 22: "$2,400.00", 99: "5" }, unsure: ["16"] };

describe("uploading a slip", () => {
  it("reads it into unconfirmed slips for the adult named on it", async () => {
    const { sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "claude-opus-5-5" });
    const result = await json<UploadResult>(upload(pdf("one"), "T4 Sam.pdf"));
    expect(result.document).toMatchObject({ name: "T4 Sam.pdf", status: "read", message: "T4 from Island Grocers for Sam Martin" });
    expect(result.year.steps.upload).toBe("done");
    const [slip] = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    // Box 99 isn't a T4 box: dropped. Amounts lose their $ and commas.
    expect(slip).toMatchObject({ personId: sam.id, source: "ai", status: "unconfirmed", boxes: { 14: "31000", 16: "1636.25", 22: "2400" }, unsure: ["16"], documentId: result.document.id });
    expect(contexts[0]!.people.map((person) => person.name)).toEqual(["Alex Martin", "Sam Martin"]);
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.slips).toHaveLength(1);
  });

  it("skips the same file, and the same slips from another file", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    await json<UploadResult>(upload(pdf("one"), "first.pdf"));
    const again = await json<UploadResult>(upload(pdf("one"), "copy.pdf"));
    expect(again.document).toMatchObject({ status: "duplicate", message: "The same file was uploaded before, as first.pdf." });
    expect(contexts).toHaveLength(1);
    const scan = await json<UploadResult>(upload(pdf("scan of the same slip"), "scan.pdf"));
    expect(scan.document).toMatchObject({ status: "duplicate", message: "The slips in this file are already in this year." });
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
  });

  it("skips a slip already typed in by hand, even when the file shows more boxes", async () => {
    const { sam } = await couple();
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T4", issuer: "island grocers", boxes: { 14: "31000", 22: "2400" } } }),
      201,
    );
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "31000.00", 22: "2400", 24: "31000" } }], model: "m" });
    const result = await json<UploadResult>(upload(pdf("typed earlier")));
    expect(result.document).toMatchObject({ status: "duplicate", message: "The slips in this file are already in this year." });
    // A different amount in a box both have is a different slip.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "32000", 22: "2400" } }], model: "m" });
    expect((await json<UploadResult>(upload(pdf("other amount")))).document.status).toBe("read");
  });

  it("says when a file holds no slip, another year's slip, or can't be read", async () => {
    await couple();
    answers.push(
      { kind: "read", taxYear: null, slips: [{ type: "RECEIPT", person: "Alex", issuer: "Pharmacy", boxes: { 1: "10" }, unsure: [] }], model: "m" },
      { kind: "read", taxYear: 2024, slips: [T4], model: "m" },
      { kind: "failed", message: "AI reading failed (500). Try again." },
      { kind: "not_available", message: "AI reading isn't available here." },
    );
    const statuses = [];
    for (const tag of ["receipt", "old", "broken", "off"]) statuses.push((await json<UploadResult>(upload(pdf(tag)))).document);
    expect(statuses.map((document) => [document.status, document.message])).toEqual([
      ["not_a_slip", "No slip this app reads was found in this file."],
      ["not_a_slip", "This is a slip for 2024, not 2025."],
      ["failed", "AI reading failed (500). Try again."],
      ["not_available", "AI reading isn't available here."],
    ]);
    // A failed file can be uploaded again.
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    expect((await json<UploadResult>(upload(pdf("broken")))).document.status).toBe("read");
  });

  it("gives a slip with no matching name to the person preparing, to be checked", async () => {
    const { alex } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee" }], model: "m" });
    const result = await json<UploadResult>(upload(pdf("other name")));
    expect(result.document.message).toBe("T4 from Island Grocers for Alex Martin (check whose it is)");
    expect(result.document.slips[0]!.personId).toBe(alex.id);
  });

  it("refuses a file that isn't a PDF, PNG or JPEG, or isn't what it says, and a viewer", async () => {
    await couple();
    expect((await upload(pdf("x"), "notes.txt", "text/plain")).status).toBe(400);
    expect((await upload(new TextEncoder().encode("hello") as Uint8Array<ArrayBuffer>, "fake.pdf")).status).toBe(400);
    expect((await upload(pdf("x"), "slip.pdf", "application/pdf", VIEWER)).status).toBe(403);
    expect(contexts).toHaveLength(0);
  });

  it("lists the files with their slips, and gives a file back as stored", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const bytes = new Uint8Array(600 * 1024) as Uint8Array<ArrayBuffer>;
    bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
    bytes.fill(7, 100);
    const { document } = await json<UploadResult>(upload(bytes, "big.pdf"));
    const list = await json<DocumentList>(server.call("GET", "/api/years/2025/documents", { as: VIEWER }));
    expect(list.documents).toEqual([expect.objectContaining({ id: document.id, name: "big.pdf", byteSize: 600 * 1024, slips: [expect.objectContaining({ type: "T4" })] })]);
    const file = await server.call("GET", `/api/years/2025/documents/${document.id}/file`, { as: VIEWER });
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
});
