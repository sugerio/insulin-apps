import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentList, Estimate, Person, SlipList, TaxYear, ReadResult } from "#shared";
import type { ReadContext, ReadOutcome, ReadSlip, SlipReader } from "../../src/app/server/lib/reader.ts";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { ORIGIN, OWNER, VIEWER, identityHeaders, startServer, type TestServer } from "../support/server.ts";

// Uploads with a reader that gives recorded answers: no test calls the model.

let server: TestServer;
let answers: ReadOutcome[];
let contexts: ReadContext[];
/** When set, each read waits on it before answering. */
let barrier: (() => Promise<void>) | undefined;
const reader: SlipReader = {
  async read(_file, context) {
    contexts.push(context);
    const answer = answers.shift() ?? { kind: "read", taxYear: 2025, slips: [], model: "test-model" };
    await barrier?.();
    return answer;
  },
};

/** Holds every read until `count` of them have started, so uploads sent together are all past their first checks. */
function readTogether(count: number) {
  const waiting: (() => void)[] = [];
  barrier = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === count) for (const release of waiting.splice(0)) release();
    });
}

beforeEach(async () => {
  answers = [];
  contexts = [];
  barrier = undefined;
  server = await startServer({ now: () => 1_767_225_600_000, reader: () => reader });
});
afterEach(() => server.close());

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

const addPerson = (name: string, relationship: string, birthDate: string) => json<Person>(server.call("POST", "/api/people", { body: { name, relationship, birthDate } }), 201);

/** Alex and Sam, both in 2025 in Ontario. */
async function couple() {
  const alex = await addPerson("Alex Martin", "self", "1985-04-02");
  const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, sam.id] } }), 201);
  return { alex, sam };
}

/** Alex, the only adult of 2025, with Riley, a child, in the year too. */
async function parentAndChild() {
  const alex = await addPerson("Alex Martin", "self", "1985-04-02");
  const riley = await addPerson("Riley Martin", "child", "2008-05-10");
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, riley.id] } }), 201);
  return { alex, riley };
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

/** A file of `size` bytes that starts as a PDF does, so it is stored in several pieces. */
function bigPdf(size: number, fill: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size) as Uint8Array<ArrayBuffer>;
  bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
  bytes.fill(fill, 100);
  return bytes;
}

/** Uploads over a D1 binding whose batch fails once it stores a file's third piece (index 2). */
function uploadFailingAtThirdPiece(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const db = new Proxy(server.db, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: Parameters<typeof target.batch>[0]) => {
          const third = statements.some((statement) => {
            const { sql, params } = statement as unknown as { sql: string; params: unknown[] };
            return sql.includes("INSERT INTO document_chunks") && Number(params[1]) >= 2;
          });
          if (third) throw new Error("D1_ERROR: the batch failed");
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const headers = { ...identityHeaders(OWNER), Origin: ORIGIN, "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(name) };
  return server.app.fetch(new Request(`${ORIGIN}/api/years/2025/documents`, { method: "POST", headers, body: bytes }), { DB: db });
}

const count = async (table: string) => (await server.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

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

  it("saves one of two copies uploaded together, whatever their names", async () => {
    await couple();
    readTogether(2);
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const same = await Promise.all([json<ReadResult>(upload(pdf("one"), "T4.pdf")), json<ReadResult>(upload(pdf("one"), "T4 (1).pdf"))]);
    expect(same.map((result) => result.status).sort()).toEqual(["duplicate", "read"]);
    const saved = same.find((result) => result.status === "read")!.document!;
    expect(same.find((result) => result.status === "duplicate")).toMatchObject({ message: `The same file is already here, as ${saved.name}.`, document: null });
    // A scan and a photo of the same slip, uploaded together: the second finds the first's slip.
    const maple = { ...T4, person: "Alex Martin", issuer: "Maple Corp" };
    answers.push({ kind: "read", taxYear: 2025, slips: [maple], model: "m" }, { kind: "read", taxYear: 2025, slips: [maple], model: "m" });
    const copies = await Promise.all([json<ReadResult>(upload(pdf("maple scan"), "maple.pdf")), json<ReadResult>(upload(pdf("maple photo"), "maple photo.pdf"))]);
    expect(copies.map((result) => [result.status, result.message]).sort()).toEqual([
      ["duplicate", "The slips in this file are already in this year."],
      ["read", "T4 from Maple Corp"],
    ]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.map((slip) => slip.issuer).sort()).toEqual(["Island Grocers", "Maple Corp"]);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents).toHaveLength(2);
    expect(await count("documents")).toBe(2);
  });

  it("saves every different file uploaded together", async () => {
    await couple();
    readTogether(3);
    answers.push(
      { kind: "read", taxYear: 2025, slips: [T4], model: "m" },
      { kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Alex Martin", issuer: "Maple Corp" }], model: "m" },
      { kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Alex Martin", issuer: "Harbour Cafe" }], model: "m" },
    );
    const results = await Promise.all(["island", "maple", "harbour"].map((tag) => json<ReadResult>(upload(pdf(tag), `${tag}.pdf`))));
    expect(results.map((result) => result.status)).toEqual(["read", "read", "read"]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(3);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents).toHaveLength(3);
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

  it("reads a file of the same name and content again, and replaces the earlier one", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const first = await json<ReadResult>(upload(pdf("one"), "T4.pdf"));
    const again = await json<ReadResult>(upload(pdf("one"), "T4.pdf"));
    expect(again).toMatchObject({ status: "read", message: "Replaced the earlier T4.pdf and its slip. T4 from Island Grocers, added to Sam Martin's return", replaced: [{ id: first.document!.id }] });
    expect(contexts).toHaveLength(2);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.id)).toEqual([again.document!.id]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.map((slip) => slip.documentId)).toEqual([again.document!.id]);
    // The same content under another name is still already here.
    const copy = await json<ReadResult>(upload(pdf("one"), "copy.pdf"));
    expect(copy).toMatchObject({ status: "duplicate", message: "The same file is already here, as T4.pdf.", document: null });
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

  it("replaces a file by name with a reading that may match several slips, saving it, so nothing is lost", async () => {
    const { alex } = await couple();
    // Two T4s from one employer typed in by hand, then a file with a third.
    for (const boxes of [{ 14: "10000" }, { 14: "20000" }]) {
      const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
      await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes } }), 201);
    }
    const maple = { type: "T4", person: "Alex Martin", issuer: "Maple Corp" };
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...maple, boxes: { 14: "60000", 22: "9000" }, unsure: [] }], model: "m" });
    const first = await json<ReadResult>(upload(pdf("v1"), "tax-slip.pdf"));
    expect(first.message).toBe("T4 from Maple Corp");
    // Its new version has box 22 only, and 14 unread: it may be either slip typed in, so it is kept as a slip of its own.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...maple, boxes: { 22: "9000" }, unsure: ["14"] }], model: "m" });
    const second = await json<ReadResult>(upload(pdf("v2"), "tax-slip.pdf"));
    expect(second).toMatchObject({
      status: "read",
      message: "Replaced the earlier tax-slip.pdf and its slip. T4 from Maple Corp; it may be the same slip as the T4 from Maple Corp already here: check at Confirm",
      replaced: [{ id: first.document!.id }],
    });
    const slips = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(slips.map((slip) => [slip.boxes, slip.unsure, slip.documentId]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([
      [{ 14: "10000" }, [], null],
      [{ 14: "20000" }, [], null],
      [{ 22: "9000" }, ["14"], second.document!.id],
    ]);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.id)).toEqual([second.document!.id]);
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

  it("skips a reading that adds nothing to a slip already here, and keeps one that adds anything as its own, flagged", async () => {
    const { sam } = await couple();
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T4", issuer: "island grocers", boxes: { 14: "31000", 22: "2400" } } }),
      201,
    );
    const read = async (tag: string, boxes: Record<string, string>, unsure: string[] = []) => {
      answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes, unsure }], model: "m" });
      return json<ReadResult>(upload(pdf(tag), `${tag}.pdf`));
    };
    // The same amounts, or some of them, with a box it couldn't read that the slip has: nothing new.
    for (const [tag, boxes, unsure] of [["same", { 14: "31000.00", 22: "2400" }, []], ["part", { 22: "2400" }, ["14"]]] as const) {
      expect(await read(tag, boxes, [...unsure])).toMatchObject({ status: "duplicate", message: "The slips in this file are already in this year.", document: null });
    }
    // A different amount in a box both have is a different slip.
    expect((await read("other amount", { 14: "32000", 22: "2400" })).message).toBe("T4 from Island Grocers, added to Sam Martin's return");
    // A box more, or a box it couldn't read that the slip lacks: a slip of its own, which may be the same one.
    const flagged = /^T4 from Island Grocers, added to Sam Martin's return; it may be the same slip as the T4 from island grocers already here: check at Confirm$/i;
    expect((await read("more", { 14: "31000", 22: "2400", 24: "31000" })).message).toMatch(flagged);
    expect((await read("unread 16", { 22: "2400" }, ["16"])).message).toMatch(flagged);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(4);
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
      ["not_a_slip", "This is for 2024, not 2025."],
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

  it("reads receipts and last year's notice of assessment, each with the years it may carry", async () => {
    await couple();
    const noa = { type: "NOA", person: "Alex Martin", issuer: "Canada Revenue Agency", boxes: { 1: "17,000.00", 3: "3000" }, unsure: [] };
    const rrsp = { type: "RRSP", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 2: "2000.00" }, unsure: [] };
    const medical = { type: "MEDICAL", person: "Alex Martin", issuer: "Lakeview Pharmacy", boxes: { 1: "25.00" }, unsure: [] };
    answers.push(
      { kind: "read", taxYear: 2024, slips: [noa], model: "m" },
      { kind: "read", taxYear: 2026, slips: [rrsp], model: "m" },
      { kind: "read", taxYear: 2024, slips: [rrsp], model: "m" },
      { kind: "read", taxYear: 2025, slips: [medical], model: "m" },
      { kind: "read", taxYear: 2025, slips: [medical], model: "m" },
    );
    expect(await json<ReadResult>(upload(pdf("noa"), "noa.pdf"))).toMatchObject({ status: "read", message: "Notice of assessment for 2024 from Canada Revenue Agency" });
    expect((await json<ReadResult>(upload(pdf("rrsp 2026"), "rrsp.pdf"))).status).toBe("read");
    // An RRSP receipt for 2024 belongs to last year's return.
    expect(await json<ReadResult>(upload(pdf("rrsp 2024"), "old rrsp.pdf"))).toMatchObject({ status: "not_a_slip", message: "This is for 2024, not 2025." });
    // The same amount from the same pharmacy twice is two receipts, not a copy.
    expect((await json<ReadResult>(upload(pdf("march"), "march.pdf"))).status).toBe("read");
    expect((await json<ReadResult>(upload(pdf("april"), "april.pdf"))).status).toBe("read");
    const slips = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(slips.map((slip) => slip.type).sort()).toEqual(["MEDICAL", "MEDICAL", "NOA", "RRSP"]);
    expect(slips.find((slip) => slip.type === "NOA")!.boxes).toEqual({ 1: "17000", 3: "3000" });
    // Medical receipts count toward the medical expenses claimed.
    const result = await json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
    const alex = result.input.people.find((person) => person.name === "Alex Martin")!.id;
    expect(new Evaluation(rulesFor(2025)!, result.input).line(alex, "T1.33099").value?.toString()).toBe("50");
  });

  it("keeps a slip whose boxes couldn't be read, to be entered, and a readable copy beside it, flagged, in either order", async () => {
    await couple();
    const t5 = { type: "T5", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1250.00" }, unsure: [] };
    const blurred = (issuer: string) => ({ type: "T4", person: "Alex Martin", issuer, boxes: {}, unsure: ["14"] });
    const clear = (issuer: string) => ({ type: "T4", person: "Alex Martin", issuer, boxes: { 14: "60000", 22: "9000" }, unsure: [] });
    const send = async (tag: string, slips: ReadSlip[]) => {
      answers.push({ kind: "read", taxYear: 2025, slips, model: "m" });
      return (await json<ReadResult>(upload(pdf(tag), `${tag}.pdf`))).message;
    };
    // A slip with no amount read and no box named unread is skipped.
    expect(await send("blurry", [t5, blurred("Maple Corp"), { ...blurred("Nothing Read Inc"), unsure: [] }])).toBe("T5 from Lakeview Credit Union; T4 from Maple Corp");
    expect(await send("maple clear", [clear("Maple Corp")])).toBe("T4 from Maple Corp; it may be the same slip as the T4 from Maple Corp already here: check at Confirm");
    await send("harbour clear", [clear("Harbour Cafe")]);
    expect(await send("harbour blurred", [blurred("Harbour Cafe")])).toBe("T4 from Harbour Cafe; it may be the same slip as the T4 from Harbour Cafe already here: check at Confirm");
    // Both in one file.
    expect(await send("island", [blurred("Island Grocers"), clear("Island Grocers")])).toBe(
      "T4 from Island Grocers; T4 from Island Grocers; it may be the same slip as the T4 from Island Grocers also in this file: check at Confirm",
    );
    const t4s = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.filter((slip) => slip.type === "T4");
    expect(t4s).toHaveLength(6);
    for (const issuer of ["Harbour Cafe", "Island Grocers", "Maple Corp"]) {
      expect(t4s.filter((slip) => slip.issuer === issuer).map((slip) => [slip.boxes, slip.unsure])).toEqual(
        expect.arrayContaining([
          [{}, ["14"]],
          [{ 14: "60000", 22: "9000" }, []],
        ]),
      );
    }
  });

  it("keeps partial or fuller readings of a slip already here as slips of their own, flagged, never filling one in", async () => {
    const { alex, sam } = await couple();
    const send = async (tag: string, slip: ReadSlip) => {
      answers.push({ kind: "read", taxYear: 2025, slips: [slip], model: "m" });
      return json<ReadResult>(upload(pdf(tag), `${tag}.pdf`));
    };
    // Two partly read T5008s from one broker may be two sales: both are kept.
    const sale = { type: "T5008", person: "Alex Martin", issuer: "Northern Brokerage" };
    await send("sale a", { ...sale, boxes: { 21: "5000" }, unsure: ["20"] });
    expect((await send("sale b", { ...sale, boxes: { 20: "3000" }, unsure: ["21"] })).message).toBe(
      "T5008 from Northern Brokerage; it may be the same slip as the T5008 from Northern Brokerage already here: check at Confirm",
    );
    // A fuller reading of a confirmed slip typed in by hand leaves it as it was.
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    const typed = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T5", issuer: "Lakeview Credit Union", boxes: { 13: "1200" } } }),
      201,
    );
    await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: typed.revision, personId: sam.id } }));
    expect((await send("t5", { type: "T5", person: "Sam Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1200.00", 15: "500" }, unsure: [] })).message).toBe(
      "T5 from Lakeview Credit Union, added to Sam Martin's return; it may be the same slip as the T5 from Lakeview Credit Union already here: check at Confirm",
    );
    const slips = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(slips.filter((slip) => slip.personId === alex.id).map((slip) => slip.boxes)).toHaveLength(2);
    expect(slips.filter((slip) => slip.personId === sam.id).map((slip) => [slip.boxes, slip.status, slip.source])).toEqual(
      expect.arrayContaining([
        [{ 13: "1200", 15: "500" }, "unconfirmed", "ai"],
        [{ 13: "1200" }, "confirmed", "manual"],
      ]),
    );
  });

  it("keeps the fuller of two copies of a slip in one file", async () => {
    await couple();
    const copy = { type: "T4", person: "Alex Martin", issuer: "Maple Corp", boxes: { 22: "9000" }, unsure: ["14"] };
    answers.push({ kind: "read", taxYear: 2025, slips: [copy, { ...copy, boxes: { 14: "60000", 22: "9000.00" }, unsure: [] }], model: "m" });
    expect((await json<ReadResult>(upload(pdf("two copies"), "copies.pdf"))).message).toBe("T4 from Maple Corp");
    const slips = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(slips.map((slip) => [slip.boxes, slip.unsure])).toEqual([[{ 14: "60000", 22: "9000" }, []]]);
  });

  it("saves a slip printed twice in a file once", async () => {
    await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4, { ...T4, boxes: { 14: "31000", 22: "2400" } }], model: "m" });
    expect((await json<ReadResult>(upload(pdf("two copies"), "t4 copies.pdf"))).message).toBe("T4 from Island Grocers, added to Sam Martin's return");
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
  });

  it("adds only the documents whose type may carry the year printed, and says what was left out", async () => {
    await couple();
    // One scan holding this year's T4 and last year's notice of assessment: the reader gives the file one year.
    const noa = { type: "NOA", person: "Alex Martin", issuer: "Canada Revenue Agency", boxes: { 1: "17000" }, unsure: [] };
    const papers = [{ ...T4, person: "Alex Martin" }, noa];
    const advice = "If a file holds documents of different years, upload each document as a file of its own.";
    answers.push({ kind: "read", taxYear: 2024, slips: papers, model: "m" }, { kind: "read", taxYear: 2025, slips: papers, model: "m" });
    const as2024 = await json<ReadResult>(upload(pdf("read as 2024"), "papers.pdf"));
    expect(as2024).toMatchObject({
      status: "read",
      message: `Notice of assessment for 2024 from Canada Revenue Agency; T4 from Island Grocers: not added, as the file reads as printed for 2024 and this kind of document printed for 2024 isn't for the 2025 return. ${advice}`,
    });
    const as2025 = await json<ReadResult>(upload(pdf("read as 2025"), "papers again.pdf"));
    expect(as2025).toMatchObject({
      status: "read",
      message: `T4 from Island Grocers; Notice of assessment for 2024 from Canada Revenue Agency: not added, as the file reads as printed for 2025 and this kind of document printed for 2025 isn't for the 2025 return. ${advice}`,
    });
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.map((slip) => slip.type).sort()).toEqual(["NOA", "T4"]);
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

  it("keeps a slip with no matching name in the return it was uploaded in, to check", async () => {
    const { sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee" }], model: "m" });
    const result = await json<ReadResult>(upload(pdf("other name"), "slip.pdf", undefined, undefined, sam.id));
    expect(result.document!.message).toBe("T4 from Island Grocers (check whose it is)");
    expect(result.document!.slips[0]!.personId).toBe(sam.id);
    // Without a person, a file goes into the return of the person preparing.
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee", issuer: "Other Co" }], model: "m" });
    const unnamed = await json<ReadResult>(upload(pdf("no person")));
    expect(unnamed.document!.personId).toBe(unnamed.year.adults[0]!.personId);
  });

  it("doesn't add a slip of someone with no return here, but keeps a receipt for them", async () => {
    const { alex } = await parentAndChild();
    answers.push(
      { kind: "read", taxYear: 2025, slips: [{ ...T4, person: "RILEY MARTIN" }], model: "m" },
      { kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee", issuer: "Other Co" }], model: "m" },
      { kind: "read", taxYear: 2025, slips: [{ type: "MEDICAL", person: "Riley Martin", issuer: "Lakeview Pharmacy", boxes: { 1: "40.00" }, unsure: [] }], model: "m" },
    );
    const rileys = await json<ReadResult>(upload(pdf("riley's t4"), "riley.pdf"));
    expect(rileys).toMatchObject({ status: "not_a_slip", message: "T4 from Island Grocers is Riley Martin's, who has no return here: not added." });
    expect(rileys.document!.slips).toEqual([]);
    // Even with one adult in the year, a name that matches nobody in it is a guess.
    const someones = await json<ReadResult>(upload(pdf("someone's t4"), "someone.pdf"));
    expect(someones.document).toMatchObject({ status: "read", message: "T4 from Other Co (check whose it is)" });
    expect(someones.document!.slips[0]!.personId).toBe(alex.id);
    // A child's medical receipt is claimed on the parent's return.
    const receipt = await json<ReadResult>(upload(pdf("riley's prescription"), "prescription.pdf"));
    expect(receipt.document).toMatchObject({ status: "read", message: "Medical expense receipt from Lakeview Pharmacy" });
    expect(receipt.document!.slips[0]!.personId).toBe(alex.id);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.map((slip) => slip.issuer).sort()).toEqual(["Lakeview Pharmacy", "Other Co"]);
  });

  it("refuses a file without its name, before reading", async () => {
    await couple();
    for (const name of [undefined, encodeURIComponent("folder/ ")]) {
      const response = server.call("POST", "/api/years/2025/documents", { raw: pdf("nameless"), headers: { "Content-Type": "application/pdf", ...(name === undefined ? {} : { "X-File-Name": name }) } });
      expect(await json(response, 400)).toMatchObject({ error: { code: "validation_failed", issues: [{ path: "X-File-Name" }] } });
    }
    expect(contexts).toHaveLength(0);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents).toEqual([]);
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
    const bytes = bigPdf(600 * 1024, 7);
    const document = (await json<ReadResult>(upload(bytes, "big.pdf"))).document!;
    const list = await json<DocumentList>(server.call("GET", "/api/years/2025/documents", { as: VIEWER }));
    expect(list.documents).toEqual([expect.objectContaining({ id: document.id, name: "big.pdf", byteSize: 600 * 1024, slips: [expect.objectContaining({ type: "T4" })] })]);
    const file = await server.call("GET", `/api/years/2025/documents/${document.id}/file`, { as: VIEWER });
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("changes nothing when storing a new version fails part-way", async () => {
    const { sam } = await couple();
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const first = await json<ReadResult>(upload(pdf("v1"), "T4.pdf", undefined, undefined, sam.id));
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "32000", 22: "2400" } }], model: "m" });
    const failed = await uploadFailingAtThirdPiece(bigPdf(600 * 1024, 9), "T4.pdf");
    expect(failed.status).toBe(500);
    // The earlier version, its slip and its bytes are all still there; nothing of the new one is.
    const after = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(after.revision).toBe(first.year.revision);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.id)).toEqual([first.document!.id]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toEqual([expect.objectContaining({ documentId: first.document!.id, boxes: { 14: "31000", 16: "1636.25", 22: "2400" } })]);
    const file = await server.call("GET", `/api/years/2025/documents/${first.document!.id}/file`);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf("v1"));
    expect([await count("documents"), await count("document_chunks")]).toEqual([1, 1]);
  });

  it("never shows a file still being stored, and clears one an upload left long ago", async () => {
    await couple();
    const taxYear = (await server.db.prepare("SELECT id FROM tax_years").first<{ id: string }>())!.id;
    const bytes = pdf("one");
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    // One being stored by an upload still running, with the same name and content as the file below; one left by an
    // upload that stopped two hours ago.
    const [storing, stopped] = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [id, createdAt] of [[storing, 1_767_225_600_000 - 60_000], [stopped, 1_767_225_600_000 - 2 * 60 * 60_000]] as const) {
      await server.db
        .prepare(
          `INSERT INTO documents (id, org_id, tax_year_id, name, content_type, byte_size, sha256, status, message, created_at)
           VALUES (?, 'org-a', ?, 'T4.pdf', 'application/pdf', ?, ?, 'duplicate', '', ?)`,
        )
        .bind(id, taxYear, bytes.byteLength, sha256, createdAt)
        .run();
      await server.db.prepare("INSERT INTO document_chunks (document_id, chunk_index, org_id, bytes) VALUES (?, 0, 'org-a', ?)").bind(id, bytes).run();
    }
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents).toEqual([]);
    expect((await server.call("GET", `/api/years/2025/documents/${storing}/file`)).status).toBe(404);
    expect((await server.call("POST", `/api/years/2025/documents/${storing}/read`)).status).toBe(404);
    expect((await server.call("DELETE", `/api/years/2025/documents/${storing}`, { body: { revision: 1 } })).status).toBe(404);
    // Neither is an earlier version or a copy of a file uploaded now.
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    expect(await json<ReadResult>(upload(bytes, "T4.pdf"))).toMatchObject({ status: "read", replaced: [] });
    const left = (await server.db.prepare("SELECT id FROM documents WHERE status = 'duplicate'").all<{ id: string }>()).results.map((row) => row.id);
    expect(left).toEqual([storing]);
    expect(await count("document_chunks")).toBe(2);
  });
});

describe("reading a file again", () => {
  it("reads a file that failed from its stored bytes, into the return it was uploaded in", async () => {
    const { sam } = await couple();
    answers.push({ kind: "failed", message: "AI reading failed (500). Try again." });
    const failed = (await json<ReadResult>(upload(pdf("flaky"), "flaky.pdf", undefined, undefined, sam.id))).document!;
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, person: "Jordan Lee" }], model: "m" });
    const result = await json<ReadResult>(server.call("POST", `/api/years/2025/documents/${failed.id}/read`));
    expect(result).toMatchObject({ status: "read", message: "T4 from Island Grocers (check whose it is)" });
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

  it("adds a slip once when two copies of it, or a copy and an upload, are read at the same time", async () => {
    await couple();
    const unread = async (tag: string) => {
      answers.push({ kind: "not_available", message: "Not set up." });
      return (await json<ReadResult>(upload(pdf(tag), `${tag}.pdf`))).document!;
    };
    const readAgain = (document: { id: string }) => json<ReadResult>(server.call("POST", `/api/years/2025/documents/${document.id}/read`));
    // A scan and a photo of the same slip, both stored before AI reading was set up, read again together.
    const [scan, photo, mapleScan] = [await unread("scan"), await unread("photo"), await unread("maple scan")];
    readTogether(2);
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const results = await Promise.all([readAgain(scan), readAgain(photo)]);
    expect(results.map((result) => [result.status, result.message]).sort()).toEqual([
      ["duplicate", "The slips in this file are already in this year."],
      ["read", "T4 from Island Grocers, added to Sam Martin's return"],
    ]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
    expect((await json<DocumentList>(server.call("GET", "/api/years/2025/documents"))).documents.map((document) => document.name).sort()).toEqual(
      ["maple scan.pdf", results.find((result) => result.status === "read")!.document!.name].sort(),
    );
    // A copy read again while another copy is uploaded.
    const maple = { ...T4, person: "Alex Martin", issuer: "Maple Corp" };
    answers.push({ kind: "read", taxYear: 2025, slips: [maple], model: "m" }, { kind: "read", taxYear: 2025, slips: [maple], model: "m" });
    const both = await Promise.all([readAgain(mapleScan), json<ReadResult>(upload(pdf("maple photo"), "maple photo.pdf"))]);
    expect(both.map((result) => result.status).sort()).toEqual(["duplicate", "read"]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.map((slip) => slip.issuer).sort()).toEqual(["Island Grocers", "Maple Corp"]);
  });

  it("keeps a fuller reading from a file read again as a slip of its own, flagged", async () => {
    const { sam } = await couple();
    answers.push({ kind: "failed", message: "Try again." });
    const failed = (await json<ReadResult>(upload(pdf("flaky"), "flaky.pdf"))).document!;
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: sam.id, type: "T4", issuer: "Island Grocers", boxes: { 14: "31000" } } }), 201);
    answers.push({ kind: "read", taxYear: 2025, slips: [{ ...T4, boxes: { 14: "31000", 22: "2400" }, unsure: [] }], model: "m" });
    const result = await json<ReadResult>(server.call("POST", `/api/years/2025/documents/${failed.id}/read`));
    expect(result).toMatchObject({
      status: "read",
      message: "T4 from Island Grocers, added to Sam Martin's return; it may be the same slip as the T4 from Island Grocers already here: check at Confirm",
    });
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips.map((slip) => slip.boxes).sort((x, y) => Object.keys(x).length - Object.keys(y).length)).toEqual([
      { 14: "31000" },
      { 14: "31000", 22: "2400" },
    ]);
  });

  it("reads a file once when it is read again twice at the same time", async () => {
    await couple();
    answers.push({ kind: "failed", message: "Try again." });
    const failed = (await json<ReadResult>(upload(pdf("flaky"), "flaky.pdf"))).document!;
    readTogether(2);
    answers.push({ kind: "read", taxYear: 2025, slips: [T4], model: "m" }, { kind: "read", taxYear: 2025, slips: [T4], model: "m" });
    const responses = await Promise.all([1, 2].map(() => server.call("POST", `/api/years/2025/documents/${failed.id}/read`)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toHaveLength(1);
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
