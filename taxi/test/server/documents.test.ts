import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentList, Estimate, Person, SlipList, TaxYear, ReadResult } from "#shared";
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
const upload = (bytes: Uint8Array<ArrayBuffer>, name = "slip.pdf", contentType = "application/pdf", as?: typeof VIEWER, personId?: string) =>
  server.call("POST", "/api/years/2025/documents", {
    raw: bytes,
    headers: { "Content-Type": contentType, "X-File-Name": encodeURIComponent(name), ...(personId ? { "X-Person-Id": personId } : {}) },
    ...(as ? { as } : {}),
  });

const T4 = { type: "T4", person: "SAM MARTIN", issuer: "Island Grocers", boxes: { 14: "31,000.00", 16: "1636.25", 22: "$2,400.00", 99: "5" }, unsure: ["16"] };

describe("uploading a slip", () => {
  it("reads it into unconfirmed slips for the adult named on it", async () => {
    const { sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "claude-opus-5-5" });
    const result = await json<ReadResult>(upload(pdf("one"), "T4 Sam.pdf", undefined, undefined, sam.id));
    expect(result.document).toMatchObject({ name: "T4 Sam.pdf", status: "read", message: "T4 from Island Grocers", personId: sam.id });
    expect(result.year.returns.map((each) => [each.personId, each.steps.upload])).toEqual([
      [result.year.adults[0]!.personId, "todo"],
      [sam.id, "done"],
    ]);
    const [slip] = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    // Box 99 isn't a T4 box: dropped. Amounts lose their $ and commas.
    expect(slip).toMatchObject({ personId: sam.id, source: "ai", status: "unconfirmed", boxes: { 14: "31000", 16: "1636.25", 22: "2400" }, unsure: ["16"], documentId: result.document!.id });
    expect(contexts[0]!.people.map((person) => person.name)).toEqual(["Alex Martin", "Sam Martin"]);
    const estimate = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    expect(estimate.input.slips).toHaveLength(1);
  });

  it("skips the same file, and the same slips from another file", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const first = await json<ReadResult>(upload(pdf("one"), "first.pdf"));
    // The same bytes under another name: not read, not saved, and the year doesn't change.
    const again = await json<ReadResult>(upload(pdf("one"), "copy.pdf"));
    expect(again).toMatchObject({ status: "duplicate", message: "The same file is already here, as first.pdf.", document: null });
    expect(again.year.revision).toBe(first.year.revision);
    expect(contexts).toHaveLength(1);
    const scan = await json<ReadResult>(upload(pdf("scan of the same slip"), "scan.pdf"));
    expect(scan).toMatchObject({ status: "duplicate", message: "The slips in this file are already in this year.", document: null });
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.name)).toEqual(["first.pdf"]);
  });

  it("replaces a file of the same name in the return with a changed one, and its slips", async () => {
    const { sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const first = await json<ReadResult>(upload(pdf("v1"), "T4.pdf", undefined, undefined, sam.id));
    await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: first.year.revision, personId: sam.id } }));
    // The corrected slip: one box changed.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "32000", 22: "2400" } }], model: "m" });
    const second = await json<ReadResult>(upload(pdf("v2"), "T4.pdf", undefined, undefined, sam.id));
    expect(second).toMatchObject({
      status: "read",
      message: "Replaced the earlier T4.pdf and its slip (1 confirmed). T4 from Island Grocers",
      replaced: [{ id: first.document!.id, name: "T4.pdf" }],
    });
    expect(second.document!.message).toBe("T4 from Island Grocers");
    const slips = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(slips).toEqual([expect.objectContaining({ documentId: second.document!.id, status: "unconfirmed", boxes: { 14: "32000", 22: "2400" } })]);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.id)).toEqual([second.document!.id]);
    // The same slips as the version replaced still count: they are the new version's now.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "32000", 22: "2400" } }], model: "m" });
    const third = await json<ReadResult>(upload(pdf("v3, rescanned"), "T4.pdf", undefined, undefined, sam.id));
    expect(third).toMatchObject({ status: "read", replaced: [{ id: second.document!.id }] });
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
  });

  it("says a file of the same name and content is unchanged, without reading it", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const first = await json<ReadResult>(upload(pdf("one"), "T4.pdf"));
    const again = await json<ReadResult>(upload(pdf("one"), "T4.pdf"));
    expect(again).toMatchObject({ status: "duplicate", message: "T4.pdf is unchanged. Nothing to update.", document: null, replaced: [] });
    expect(again.year.revision).toBe(first.year.revision);
    expect(contexts).toHaveLength(1);
  });

  it("keeps the earlier version when the new one can't be read into slips", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "failed", message: "AI reading failed (500). Try again." });
    const first = await json<ReadResult>(upload(pdf("v1"), "T4.pdf"));
    const second = await json<ReadResult>(upload(pdf("v2"), "T4.pdf"));
    expect(second).toMatchObject({ status: "failed", message: "AI reading failed (500). Try again. The earlier T4.pdf is kept.", document: null, replaced: [] });
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.id)).toEqual([first.document!.id]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
  });

  it("doesn't replace a file of the same name in the other return", async () => {
    const { alex, sam } = await couple();
    answers.push(
      { kind: "read", taxYear: 2025, slips: [T4], model: "m" },
      { kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Alex Martin", issuer: "Maple Corp" }], model: "m" },
    );
    await json<ReadResult>(upload(pdf("sam's"), "scan.pdf", undefined, undefined, sam.id));
    const alexs = await json<ReadResult>(upload(pdf("alex's"), "scan.pdf", undefined, undefined, alex.id));
    expect(alexs).toMatchObject({ status: "read", replaced: [] });
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents).toHaveLength(2);
  });

  it("skips a slip already typed in by hand, even when the file shows more boxes", async () => {
    const { sam } = await couple();
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T4", issuer: "island grocers", boxes: { 14: "31000", 22: "2400" } } }),
      201,
    );
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "31000.00", 22: "2400", 24: "31000" } }], model: "m" });
    const result = await json<ReadResult>(upload(pdf("typed earlier")));
    expect(result).toMatchObject({ status: "duplicate", message: "The slips in this file are already in this year.", document: null });
    // A different amount in a box both have is a different slip.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "32000", 22: "2400" } }], model: "m" });
    expect((await json<ReadResult>(upload(pdf("other amount")))).status).toBe("read");
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
    for (const tag of ["receipt", "old", "broken", "off"]) statuses.push((await json<ReadResult>(upload(pdf(tag), `${tag}.pdf`))).document!);
    expect(statuses.map((document) => [document.status, document.message])).toEqual([
      ["not_a_slip", "No slip this app reads was found in this file."],
      ["not_a_slip", "This is a slip for 2024, not 2025."],
      ["failed", "AI reading failed (500). Try again."],
      ["not_available", "AI reading isn't available here."],
    ]);
    // A failed file can be uploaded again, and replaces the one that failed.
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const retried = await json<ReadResult>(upload(pdf("broken"), "broken again.pdf"));
    expect(retried.status).toBe("read");
    const names = (await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => [document.name, document.status]);
    expect(names).toHaveLength(4);
    expect(names).toContainEqual(["broken again.pdf", "read"]);
    expect(names).not.toContainEqual(["broken.pdf", "failed"]);
  });

  it("puts a slip with the other adult's name in their return, and says so", async () => {
    const { alex, sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const result = await json<ReadResult>(upload(pdf("sam's slip"), "slip.pdf", undefined, undefined, alex.id));
    expect(result.document).toMatchObject({ personId: alex.id, message: "T4 from Island Grocers, added to Sam Martin's return" });
    expect(result.document!.slips[0]!.personId).toBe(sam.id);
    // The slip is Sam's, read from a file: Sam's upload step is done; Alex uploaded it, so Alex's is too.
    expect(result.year.returns.map((each) => each.steps.upload)).toEqual(["done", "done"]);
  });

  it("keeps a slip with no matching name in the return it was uploaded in", async () => {
    const { sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee" }], model: "m" });
    const result = await json<ReadResult>(upload(pdf("other name"), "slip.pdf", undefined, undefined, sam.id));
    expect(result.document!.message).toBe("T4 from Island Grocers");
    expect(result.document!.slips[0]!.personId).toBe(sam.id);
    // Without a person, a file goes into the return of the person preparing.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee", issuer: "Other Co" }], model: "m" });
    const unnamed = await json<ReadResult>(upload(pdf("no person")));
    expect(unnamed.document!.personId).toBe(unnamed.year.adults[0]!.personId);
  });

  it("refuses a return that isn't an adult's of the year, before reading", async () => {
    await couple();
    expect((await upload(pdf("x"), "slip.pdf", undefined, undefined, crypto.randomUUID())).status).toBe(400);
    expect(contexts).toHaveLength(0);
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
    const document = (await json<ReadResult>(upload(bytes, "big.pdf"))).document!;
    const list = await json<DocumentList>(server.call("GET", "/api/years/2025/documents", { as: VIEWER }));
    expect(list.documents).toEqual([expect.objectContaining({ id: document.id, name: "big.pdf", byteSize: 600 * 1024, slips: [expect.objectContaining({ type: "T4" })] })]);
    const file = await server.call("GET", `/api/years/2025/documents/${document.id}/file`, { as: VIEWER });
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
});

describe("reading a file again", () => {
  it("reads a file that failed from its stored bytes, into the return it was uploaded in", async () => {
    const { sam } = await couple();
    answers.push({ kind: "failed", message: "AI reading failed (500). Try again." });
    const failed = (await json<ReadResult>(upload(pdf("flaky"), "flaky.pdf", undefined, undefined, sam.id))).document!;
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee" }], model: "m" });
    const result = await json<ReadResult>(server.call("POST", `/api/years/2025/documents/${failed.id}/read`));
    expect(result).toMatchObject({ status: "read", message: "T4 from Island Grocers" });
    expect(result.document).toMatchObject({ id: failed.id, status: "read", personId: sam.id, slips: [expect.objectContaining({ personId: sam.id, status: "unconfirmed" })] });
    expect(result.year.returns.find((each) => each.personId === sam.id)!.steps.upload).toBe("done");
    // A file that was read can't be read again.
    expect((await server.call("POST", `/api/years/2025/documents/${failed.id}/read`)).status).toBe(409);
    expect(contexts).toHaveLength(2);
  });

  it("removes the file when its slips are already in the year", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "not_available", message: "Not set up." });
    await json<ReadResult>(upload(pdf("one"), "one.pdf"));
    const unread = (await json<ReadResult>(upload(pdf("two"), "two.pdf"))).document!;
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const result = await json<ReadResult>(server.call("POST", `/api/years/2025/documents/${unread.id}/read`));
    expect(result).toMatchObject({ status: "duplicate", document: null });
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.name)).toEqual(["one.pdf"]);
  });

  it("refuses a viewer and an unknown file", async () => {
    await couple();
    answers.push({ kind: "failed", message: "Try again." });
    const failed = (await json<ReadResult>(upload(pdf("x")))).document!;
    expect((await server.call("POST", `/api/years/2025/documents/${failed.id}/read`, { as: VIEWER })).status).toBe(403);
    expect((await server.call("POST", `/api/years/2025/documents/${crypto.randomUUID()}/read`)).status).toBe(404);
  });
});

describe("deleting a file", () => {
  it("deletes the file and every slip read from it, in either return, confirmed or not", async () => {
    const { alex, sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4, { ...T4, person: "Alex Martin", issuer: "Maple Corp" }], model: "m" });
    const { document, year } = await json<ReadResult>(upload(pdf("both"), "both.pdf", undefined, undefined, alex.id));
    expect(document!.slips.map((slip) => slip.personId).sort()).toEqual([alex.id, sam.id].sort());
    const confirmed = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: year.revision, personId: sam.id } }));
    const listed = (await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents[0]!;
    expect(listed.slips.find((slip) => slip.personId === sam.id)!.status).toBe("confirmed");
    // A stale revision is refused, and a viewer can't delete.
    expect((await server.call("DELETE", `/api/years/2025/documents/${document!.id}`, { body: { revision: year.revision } })).status).toBe(409);
    expect((await server.call("DELETE", `/api/years/2025/documents/${document!.id}`, { body: { revision: confirmed.revision }, as: VIEWER })).status).toBe(403);
    const after = await json<TaxYear>(server.call("DELETE", `/api/years/2025/documents/${document!.id}`, { body: { revision: confirmed.revision } }));
    expect(after.revision).toBe(confirmed.revision + 1);
    expect(after.returns.map((each) => each.steps.upload)).toEqual(["todo", "todo"]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toEqual([]);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents).toEqual([]);
    expect((await server.call("GET", `/api/years/2025/documents/${document!.id}/file`)).status).toBe(404);
    // The same file can be uploaded again.
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    expect((await json<ReadResult>(upload(pdf("both"), "both.pdf"))).status).toBe("read");
  });

  it("keeps slips typed in by hand", async () => {
    const { sam } = await couple();
    answers.push({ kind: "not_available", message: "Not set up." });
    const { document } = await json<ReadResult>(upload(pdf("x")));
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    const added = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T4", issuer: "Island Grocers", boxes: { 14: "100" } } }),
      201,
    );
    await json<TaxYear>(server.call("DELETE", `/api/years/2025/documents/${document!.id}`, { body: { revision: added.revision } }));
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
  });
});
