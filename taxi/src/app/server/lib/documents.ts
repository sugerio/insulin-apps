import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, maybeSameSlip, type DocumentList, type DocumentRecord, type Person, type ReadResult, type Slip, type TaxYear } from "#shared";
import { normalizeAmount, sameBoxValue } from "../../shared/amount.ts";
import { Dec } from "../../shared/engine/decimal.ts";
import { documentName } from "../../shared/engine/rules.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { audit, bumpRevision, getYear, runGuarded, yearRow, type YearRow } from "./people.ts";
import { ApiError, conflict, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { FileToRead, ReadOutcome, ReadSlip, SlipReader } from "./reader.ts";
import { loadWorkspace } from "./workspace.ts";

// Step 2: one uploaded file per request. The file is checked (type, name, size, its first bytes), read by AI into
// slips, and stored in D1 in 256 KiB pieces. What comes back is checked against the year's slip types before anything
// is saved; slips are added unconfirmed to the adult whose name is on them. The same file uploaded again (its SHA-256,
// whatever its name), or a file whose slips are all in the year already (same type, issuer and boxes), isn't saved. A
// file with the name of one in the same return is a new version: it replaces that one and its slips, even unchanged.
// A file that couldn't be read can be read again from its stored bytes; any file can be deleted with its slips.

type Db = D1Database;
const CHUNK_BYTES = 256 * 1024;
const CHUNKS_PER_BATCH = 2;
/** The statuses of a file that wasn't read and has no slips: it can be read again, and the same file uploaded replaces it. */
const UNREAD = ["failed", "not_available"] as const;
const UNREAD_SQL = UNREAD.map((status) => `'${status}'`).join(", ");
const isUnread = (status: string) => (UNREAD as readonly string[]).includes(status);
/**
 * A file whose pieces are still being stored: its row goes first (the pieces refer to it) under this status, which no
 * reader shows, and the batch that saves its slips publishes it. It is `duplicate`, which the CHECK still allows and
 * nothing else writes any more (a duplicate isn't saved).
 */
const STAGED = "duplicate";
const STAGED_SQL = `'${STAGED}'`;
/** A file staged this long ago belongs to an upload that stopped part-way: the next upload into the year clears it. */
const STALE_STAGED_MS = 60 * 60 * 1000;
/** How many times an upload looks again at what is stored, when another change to the year was saved first. */
const PUBLISH_ATTEMPTS = 5;

interface DocumentRow {
  id: string;
  name: string;
  content_type: string;
  byte_size: number;
  status: DocumentRecord["status"];
  message: string;
  person_id: string | null;
  created_at: number;
}

const DOCUMENT_COLUMNS = "id, name, content_type, byte_size, status, message, person_id, created_at";

export async function listDocuments(db: Db, orgId: string, year: number): Promise<DocumentList> {
  const row = await openYear(db, orgId, year);
  const [documents, workspace] = await Promise.all([
    db
      .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE org_id = ? AND tax_year_id = ? AND status <> ${STAGED_SQL} ORDER BY created_at DESC, id`)
      .bind(orgId, row.id)
      .all<DocumentRow>(),
    loadWorkspace(db, orgId, row.id),
  ]);
  return { documents: documents.results.map((document) => recordOf(document, workspace.slips)) };
}

function recordOf(document: DocumentRow, slips: { id: string; type: string; personId: string; issuer: string; status: "unconfirmed" | "confirmed"; documentId: string | null }[]): DocumentRecord {
  return {
    id: document.id,
    name: document.name,
    contentType: document.content_type,
    byteSize: document.byte_size,
    status: document.status,
    message: document.message,
    personId: document.person_id,
    slips: slips
      .filter((slip) => slip.documentId === document.id)
      .map((slip) => ({ id: slip.id, type: slip.type, personId: slip.personId, issuer: slip.issuer, status: slip.status })),
    createdAt: document.created_at,
  };
}

async function openYear(db: Db, orgId: string, year: number): Promise<YearRow> {
  const row = await yearRow(db, orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  return row;
}

async function documentRow(db: Db, orgId: string, taxYearId: string, id: string): Promise<DocumentRow> {
  const document = await db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND org_id = ? AND tax_year_id = ? AND status <> ${STAGED_SQL}`)
    .bind(id, orgId, taxYearId)
    .first<DocumentRow>();
  if (!document) throw notFound("No such file in this year");
  return document;
}

/** A stored file's bytes, put back together, for showing it beside its numbers. */
export async function documentFile(db: Db, orgId: string, year: number, id: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string; name: string }> {
  const row = await openYear(db, orgId, year);
  const document = await documentRow(db, orgId, row.id, id);
  const { results } = await db
    .prepare("SELECT bytes FROM document_chunks WHERE document_id = ? AND org_id = ? ORDER BY chunk_index")
    .bind(id, orgId)
    .all<{ bytes: ArrayBuffer | Uint8Array }>();
  const bytes = new Uint8Array(document.byte_size);
  let offset = 0;
  for (const chunk of results) {
    const piece = chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes);
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  if (offset !== document.byte_size) throw notFound("This file wasn't stored");
  return { bytes, contentType: document.content_type, name: document.name };
}

export async function uploadDocument(db: Db, caller: Caller, year: number, request: Request, reader: SlipReader, now: number): Promise<ReadResult> {
  const row = await openYear(db, caller.orgId, year);
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(contentType)) {
    throw new ApiError("validation_failed", "Upload a PDF, PNG or JPEG file", [{ path: "Content-Type", message: "Not a PDF, PNG or JPEG" }]);
  }
  const name = fileName(request.headers.get("X-File-Name"));
  const bytes = await readBytes(request, MAX_DOCUMENT_BYTES);
  if (!looksLike(contentType, bytes)) {
    throw new ApiError("validation_failed", `The file isn't a ${contentType.split("/")[1]!.toUpperCase()}`, [{ path: "body", message: "The content doesn't match its type" }]);
  }
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const personHeader = request.headers.get("X-Person-Id");
  const before = await getYear(db, caller.orgId, year);
  const stored = await storedLike(db, caller.orgId, row.id, name, uploaderOf(before, personHeader).id, sha256);
  if (stored.earlier) return { status: "duplicate", message: alreadyHere(stored.earlier), document: null, replaced: [], year: before };
  const outcome = await readFile(year, before, { bytes, contentType: contentType as FileToRead["contentType"] }, reader);

  // Reading takes seconds and the page uploads several files at once, so what is stored is looked at again after it,
  // and the outcome is saved under the year's revision: of two copies uploaded together, the second sees the first.
  // The file's pieces are staged first; the last batch publishes it with its slips and takes out its earlier versions,
  // so an upload that fails part-way leaves the year as it was.
  const id = crypto.randomUUID();
  let staged = false;
  let published = false;
  try {
    for (let attempt = 1; ; attempt += 1) {
      // The revision first, then what it guards: a change saved after it makes the publish below a conflict.
      const view = await getYear(db, caller.orgId, year);
      const uploader = uploaderOf(view, personHeader);
      const { previous, earlier, unreadCopies } = await storedLike(db, caller.orgId, row.id, name, uploader.id, sha256);
      if (earlier) return { status: "duplicate", message: alreadyHere(earlier), document: null, replaced: [], year: view };
      const { slips } = await loadWorkspace(db, caller.orgId, row.id);
      const reading = checkReading(outcome, year, view, uploader, slips, previous);
      // An earlier version is replaced only by a file read into slips: one that couldn't be read keeps it, and isn't saved.
      if (previous.length > 0 && reading.status !== "read" && reading.status !== "duplicate") {
        return { status: reading.status, message: `${reading.message} The earlier ${name} is kept.`, document: null, replaced: [], year: view };
      }
      if (reading.status === "duplicate" && previous.length === 0) return { status: "duplicate", message: reading.message, document: null, replaced: [], year: view };

      const replacing = previous.length > 0 ? `Replaced the earlier ${name}${slipsNote(slips.filter((slip) => slip.documentId !== null && previous.includes(slip.documentId)))}. ` : "";
      const replaced = previous.map((old) => ({ id: old, name }));
      const removePrevious = [
        bumpRevision(db, caller.orgId, row.id, view.revision, now),
        ...previous.flatMap((old) => [...deleteDocumentRows(db, caller.orgId, row.id, old), audit(db, caller, "document.replaced", old, now)]),
      ];
      if (reading.status === "duplicate") {
        if (!(await publish(db, removePrevious, attempt))) continue;
        return { status: "duplicate", message: `${replacing}${reading.message} This file wasn't saved.`, document: null, replaced, year: await getYear(db, caller.orgId, year) };
      }

      if (!staged) {
        staged = true;
        await stage(db, caller.orgId, row.id, { id, name, contentType, bytes, sha256, personId: uploader.id }, now);
      }
      const slipIds = reading.found.map(() => crypto.randomUUID());
      const saved = await publish(
        db,
        [
          ...removePrevious,
          // The same file uploaded before that couldn't be read is replaced by this one too: it has no slips.
          ...unreadCopies.flatMap((old) => deleteDocumentRows(db, caller.orgId, row.id, old)),
          db
            .prepare("UPDATE documents SET status = ?, message = ?, model_id = ?, person_id = ? WHERE id = ? AND org_id = ?")
            .bind(reading.status, reading.message, reading.modelId, uploader.id, id, caller.orgId),
          ...reading.found.map((slip, index) => insertSlip(db, caller.orgId, row.id, slipIds[index]!, slip, id, now)),
          audit(db, caller, "document.uploaded", id, now),
        ],
        attempt,
      );
      if (!saved) continue;
      published = true;

      const document: DocumentRecord = {
        id,
        name,
        contentType,
        byteSize: bytes.byteLength,
        status: reading.status,
        message: reading.message,
        personId: uploader.id,
        slips: reading.found.map((slip, index) => ({ id: slipIds[index]!, type: slip.type, personId: slip.personId, issuer: slip.issuer, status: "unconfirmed" })),
        createdAt: now,
      };
      return { status: reading.status, message: `${replacing}${reading.message}`, document, replaced, year: await getYear(db, caller.orgId, year) };
    }
  } finally {
    // Best effort: a staged file nobody published is cleared by a later upload if this fails too.
    if (staged && !published) await db.batch(deleteDocumentRows(db, caller.orgId, row.id, id, STAGED_SQL)).catch(() => undefined);
  }
}

const alreadyHere = (earlier: { name: string }) => `The same file is already here, as ${earlier.name}.`;

/**
 * What is stored that bears on a file of this name and content uploaded into `personId`'s return: its earlier versions,
 * a copy under another name (or in the other return), and copies that couldn't be read. Staged files aren't stored yet.
 */
async function storedLike(db: Db, orgId: string, taxYearId: string, name: string, personId: string, sha256: string) {
  // A file of the same name in this return (uploaded in it, or holding a slip of its adult) is an earlier version of
  // this one, whatever its content: this one replaces it, with its slips, once it is read.
  const previous = (
    await db
      .prepare(
        `SELECT id FROM documents d WHERE org_id = ? AND tax_year_id = ? AND name = ? AND status <> ${STAGED_SQL}
           AND (person_id = ? OR EXISTS (SELECT 1 FROM slips s WHERE s.document_id = d.id AND s.person_id = ?))`,
      )
      .bind(orgId, taxYearId, name, personId, personId)
      .all<{ id: string }>()
  ).results.map((each) => each.id);
  const copies = (
    await db
      .prepare(`SELECT id, name, status FROM documents WHERE org_id = ? AND tax_year_id = ? AND sha256 = ? AND status <> ${STAGED_SQL}`)
      .bind(orgId, taxYearId, sha256)
      .all<{ id: string; name: string; status: string }>()
  ).results.filter((each) => !previous.includes(each.id));
  return {
    previous,
    // The same content under another name (or in the other return) is already here.
    earlier: copies.find((copy) => !isUnread(copy.status)) ?? null,
    unreadCopies: copies.filter((copy) => isUnread(copy.status)).map((copy) => copy.id),
  };
}

/** Runs a batch that starts with the year's guarded revision bump: false when the year changed and another attempt is left. */
async function publish(db: Db, statements: D1PreparedStatement[], attempt: number): Promise<boolean> {
  try {
    await runGuarded(db, statements);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "conflict" && attempt < PUBLISH_ATTEMPTS) return false;
    throw error;
  }
}

/**
 * Stores a file's row, staged, and its pieces two at a time (a D1 batch has a size limit). The first batch also clears
 * files left staged in the year by uploads that stopped part-way.
 */
async function stage(
  db: Db,
  orgId: string,
  taxYearId: string,
  file: { id: string; name: string; contentType: string; bytes: Uint8Array; sha256: string; personId: string },
  now: number,
): Promise<void> {
  const chunks = split(file.bytes);
  const stale = `org_id = ? AND tax_year_id = ? AND status = ${STAGED_SQL} AND created_at < ?`;
  await db.batch([
    db.prepare(`DELETE FROM document_chunks WHERE org_id = ? AND document_id IN (SELECT id FROM documents WHERE ${stale})`).bind(orgId, orgId, taxYearId, now - STALE_STAGED_MS),
    db.prepare(`DELETE FROM documents WHERE ${stale}`).bind(orgId, taxYearId, now - STALE_STAGED_MS),
    db
      .prepare(
        `INSERT INTO documents (id, org_id, tax_year_id, name, content_type, byte_size, sha256, status, message, model_id, person_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${STAGED_SQL}, '', NULL, ?, ?)`,
      )
      .bind(file.id, orgId, taxYearId, file.name, file.contentType, file.bytes.byteLength, file.sha256, file.personId, now),
    ...chunks.slice(0, CHUNKS_PER_BATCH).map((chunk, index) => insertChunk(db, orgId, file.id, index, chunk)),
  ]);
  for (let start = CHUNKS_PER_BATCH; start < chunks.length; start += CHUNKS_PER_BATCH) {
    await db.batch(chunks.slice(start, start + CHUNKS_PER_BATCH).map((chunk, offset) => insertChunk(db, orgId, file.id, start + offset, chunk)));
  }
}

/** " and its 2 slips (1 confirmed)", for saying what replacing a file took with it. */
function slipsNote(slips: { status: string }[]): string {
  if (slips.length === 0) return "";
  const confirmed = slips.filter((slip) => slip.status === "confirmed").length;
  return ` and its ${slips.length === 1 ? "slip" : `${slips.length} slips`}${confirmed > 0 ? ` (${confirmed} confirmed)` : ""}`;
}

/**
 * Reads a file that couldn't be read again, from its stored bytes, into the return it was uploaded in. As for an
 * upload, what is stored is looked at again after reading and the outcome is saved under the year's revision, so a
 * copy read or uploaded at the same time isn't added twice, and of two reads of this file at once the second finds it
 * read. Its slips and its new status are also saved only while it is still unread. A file whose slips are all in the
 * year already is removed, as an upload of it wouldn't have been saved.
 */
export async function readDocumentAgain(db: Db, caller: Caller, year: number, id: string, reader: SlipReader, now: number): Promise<ReadResult> {
  const row = await openYear(db, caller.orgId, year);
  const document = await documentRow(db, caller.orgId, row.id, id);
  if (!isUnread(document.status)) throw conflict("This file was read already");
  const file = await documentFile(db, caller.orgId, year, id);
  const before = await getYear(db, caller.orgId, year);
  // Refused before reading when the year has no adult left to read it into.
  uploadedFor(before, document);
  const outcome = await readFile(year, before, { bytes: file.bytes, contentType: file.contentType as FileToRead["contentType"] }, reader);

  for (let attempt = 1; ; attempt += 1) {
    // The revision first, then what it guards: a change saved after it makes the publish below a conflict.
    const view = await getYear(db, caller.orgId, year);
    const current = await documentRow(db, caller.orgId, row.id, id);
    if (!isUnread(current.status)) throw conflict("This file was read already");
    const uploader = uploadedFor(view, current);
    const reading = checkReading(outcome, year, view, uploader, (await loadWorkspace(db, caller.orgId, row.id)).slips);

    const stillUnread = `EXISTS (SELECT 1 FROM documents WHERE id = ? AND org_id = ? AND status IN (${UNREAD_SQL}))`;
    const slipIds = reading.found.map(() => crypto.randomUUID());
    const statements =
      reading.status === "duplicate"
        ? deleteDocumentRows(db, caller.orgId, row.id, id, UNREAD_SQL)
        : [
            // The slips first, while the file is still unread; then the file's new status.
            ...reading.found.map((slip, index) => insertSlip(db, caller.orgId, row.id, slipIds[index]!, slip, id, now, stillUnread, [id, caller.orgId])),
            db
              .prepare(`UPDATE documents SET status = ?, message = ?, model_id = ?, person_id = ? WHERE id = ? AND org_id = ? AND status IN (${UNREAD_SQL})`)
              .bind(reading.status, reading.message, reading.modelId, uploader.id, id, caller.orgId),
          ];
    const saved = await publish(
      db,
      [bumpRevision(db, caller.orgId, row.id, view.revision, now), ...statements, audit(db, caller, reading.status === "duplicate" ? "document.deleted" : "document.read_again", id, now)],
      attempt,
    );
    if (!saved) continue;

    const updated = await getYear(db, caller.orgId, year);
    if (reading.status === "duplicate") return { status: "duplicate", message: reading.message, document: null, replaced: [], year: updated };
    const record = recordOf(await documentRow(db, caller.orgId, row.id, id), (await loadWorkspace(db, caller.orgId, row.id)).slips);
    return { status: reading.status, message: reading.message, document: record, replaced: [], year: updated };
  }
}

/** The adult a file was uploaded for, while still an adult of the year; otherwise the person preparing. */
function uploadedFor(view: TaxYear, document: DocumentRow): Person {
  const adult = document.person_id !== null && view.adults.some((each) => each.personId === document.person_id);
  return uploaderOf(view, adult ? document.person_id : null);
}

/** Deletes an uploaded file and every slip read from it, in whichever return it is, under the year's revision. */
export async function deleteDocument(db: Db, caller: Caller, year: number, id: string, revision: number, now: number): Promise<TaxYear> {
  const row = await openYear(db, caller.orgId, year);
  await documentRow(db, caller.orgId, row.id, id);
  await runGuarded(db, [bumpRevision(db, caller.orgId, row.id, revision, now), ...deleteDocumentRows(db, caller.orgId, row.id, id), audit(db, caller, "document.deleted", id, now)]);
  return getYear(db, caller.orgId, year);
}

/** A file's slips, pieces and row; with `onlyIf`, only while its status is one of those (the last statement's changes say whether it was). */
function deleteDocumentRows(db: Db, orgId: string, taxYearId: string, id: string, onlyIf?: string): D1PreparedStatement[] {
  const status = onlyIf ? ` AND status IN (${onlyIf})` : "";
  const exists = onlyIf ? ` AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND org_id = ?${status})` : "";
  const existsBinds = onlyIf ? [id, orgId] : [];
  return [
    db.prepare(`DELETE FROM slips WHERE document_id = ? AND org_id = ? AND tax_year_id = ?${exists}`).bind(id, orgId, taxYearId, ...existsBinds),
    db.prepare(`DELETE FROM document_chunks WHERE document_id = ? AND org_id = ?${exists}`).bind(id, orgId, ...existsBinds),
    db.prepare(`DELETE FROM documents WHERE id = ? AND org_id = ? AND tax_year_id = ?${status}`).bind(id, orgId, taxYearId),
  ];
}

function insertSlip(db: Db, orgId: string, taxYearId: string, id: string, slip: Planned, documentId: string, now: number, onlyIf?: string, onlyIfBinds: unknown[] = []): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO slips (id, org_id, tax_year_id, person_id, type, issuer, boxes, status, source, document_id, unsure, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', 'ai', ?, ?, ?, ?${onlyIf ? ` WHERE ${onlyIf}` : ""}`,
    )
    .bind(id, orgId, taxYearId, slip.personId, slip.type, slip.issuer, JSON.stringify(slip.boxes), documentId, JSON.stringify(slip.unsure), now, now, ...onlyIfBinds);
}

interface Reading {
  status: ReadResult["status"];
  message: string;
  modelId: string | null;
  /** The slips to add: those read, less the ones already in the year. */
  found: Planned[];
}

const membersOf = (view: TaxYear) => view.people.filter((person) => view.members.includes(person.id));

/** AI's reading of a file, told the names and relationships of the year's people so it can say whose each slip is. */
function readFile(year: number, view: TaxYear, file: FileToRead, reader: SlipReader): Promise<ReadOutcome> {
  // The year's rules say which documents of its country are read (slips.yaml) and how (year.yaml, reading).
  return reader.read(file, { year, rules: rulesFor(view.country, year)!, people: membersOf(view).map((person) => ({ name: person.name, relationship: person.relationship })) });
}

/** AI's reading of a file, checked against the year's rules and the slips already in it (less those of the files it replaces). */
function checkReading(outcome: ReadOutcome, year: number, view: TaxYear, uploader: Person, slips: Slip[], replacing: string[] = []): Reading {
  const rules = rulesFor(view.country, year)!;
  if (outcome.kind !== "read") return { status: outcome.kind, message: outcome.message, modelId: null, found: [] };
  const modelId = outcome.model;
  const read = plan(outcome.slips, view, year, uploader);
  // The year printed must be one each document's type may carry: the tax year, or last year on a notice of assessment.
  const printed = outcome.taxYear;
  const forYear = (slip: { type: string }) => printed === null || rules.slips.get(slip.type)!.printedYears.some((offset) => year + offset === printed);
  const all = [...read.planned, ...read.skipped];
  if (printed !== null && !all.some(forYear) && !(all.length === 0 && printed === year)) {
    return { status: "not_a_slip", message: `This is for ${printed}, not ${year}.`, modelId, found: [] };
  }
  const planned = read.planned.filter(forYear);
  // The reader gives the whole file one year, which may be another document's in it than this one's: the note says how
  // the file reads, not what this document says.
  const otherYear = all.filter((slip) => !forYear(slip));
  const notAdded = [
    ...otherYear.map(
      (slip) =>
        `${documentName(rules.slips.get(slip.type), slip.type)} from ${slip.issuer}: not added, as the file reads as printed for ${printed} and this kind of document printed for ${printed} isn't for the ${year} return`,
    ),
    ...read.skipped
      .filter(forYear)
      .map((slip) => `${documentName(rules.slips.get(slip.type), slip.type)} from ${slip.issuer} is ${slip.personName}'s, who has no return here: not added`),
  ];
  const advice = otherYear.length > 0 ? " If a file holds documents of different years, upload each document as a file of its own." : "";
  if (planned.length === 0) {
    return { status: "not_a_slip", message: notAdded.length > 0 ? `${notAdded.join("; ")}.${advice}` : "No slip this app reads was found in this file.", modelId, found: [] };
  }
  const existing = slips.filter((slip) => slip.documentId === null || !replacing.includes(slip.documentId));
  // Left out only when sure: a reading that adds nothing to a slip already here, or to one kept from this file (a T4 PDF
  // often prints the same slip several times; the fuller copies are kept first), isn't added. Anything else is a slip
  // of its own, even when it may be the same as another: two partly read slips of one issuer can be different ones,
  // so the message and Confirm point it out for a person to decide. Receipts are never matched: two can hold the same
  // amount from the same place (a monthly prescription).
  const kept: Planned[] = [];
  for (const slip of [...planned].sort((a, b) => Object.keys(b.boxes).length - Object.keys(a.boxes).length)) {
    if (!rules.slips.get(slip.type)!.receipt && [...existing, ...kept].some((other) => addsNothing(slip, other))) continue;
    kept.push(slip);
  }
  const found = planned.filter((slip) => kept.includes(slip));
  if (found.length === 0) return { status: "duplicate", message: "The slips in this file are already in this year.", modelId, found: [] };
  const name = (slip: { type: string }) => documentName(rules.slips.get(slip.type), slip.type);
  const message = [
    ...found.map((slip, index) => {
      const said = `${name(slip)} from ${slip.issuer}${slip.personId === uploader.id ? "" : `, added to ${slip.personName}'s return`}${slip.guessed ? " (check whose it is)" : ""}`;
      if (rules.slips.get(slip.type)!.receipt) return said;
      const here = existing.find((other) => maybeSameSlip(other, slip));
      const inFile = here ? undefined : found.slice(0, index).find((other) => maybeSameSlip(other, slip));
      const like = here ?? inFile;
      return like ? `${said}; it may be the same slip as the ${name(like)} from ${like.issuer} ${here ? "already here" : "also in this file"}: check at Confirm` : said;
    }),
    ...notAdded,
  ].join("; ");
  return { status: "read", message: advice ? `${message}.${advice}` : message, modelId, found };
}

interface Planned {
  type: string;
  issuer: string;
  personId: string;
  personName: string;
  /** The name matched no one in the year, or several: the slip went to the return it was uploaded in, to be checked. */
  guessed: boolean;
  boxes: Record<string, string>;
  unsure: string[];
}

/** A slip of someone in the year who has no return here (a child's T4): not added. */
interface Skipped {
  type: string;
  issuer: string;
  personName: string;
}

/** The adult whose return the file is uploaded in: the `X-Person-Id` header, or the person preparing without it. */
function uploaderOf(view: TaxYear, header: string | null): Person {
  const adults = view.adults.map((adult) => view.people.find((person) => person.id === adult.personId)!);
  if (adults.length === 0) throw conflict("Add yourself to this year before uploading");
  if (header === null || header === "") return adults.find((person) => person.relationship === "self") ?? adults[0]!;
  const adult = adults.find((person) => person.id === header);
  if (!adult) throw new ApiError("validation_failed", "Upload into the return of an adult of this year", [{ path: "X-Person-Id", message: "Not an adult of this year" }]);
  return adult;
}

/**
 * What AI read, checked against the year's rules: a known type, only its boxes, amounts that are decimals (a box that
 * isn't is left out and marked unsure), and whose it is by the name on it, among everyone in the year. A slip goes to
 * the adult named. One naming someone else in the year is skipped, unless it is a receipt (a child's medical or child
 * care receipt is claimed by an adult), which stays in the return it was uploaded in. A name that matches no one, or
 * several, leaves the slip in that return too, to be checked.
 */
function plan(slips: ReadSlip[], view: TaxYear, year: number, uploader: Person): { planned: Planned[]; skipped: Skipped[] } {
  const rules = rulesFor(view.country, year)!;
  const adults = new Set(view.adults.map((adult) => adult.personId));
  const members = membersOf(view);
  const planned: Planned[] = [];
  const skipped: Skipped[] = [];
  for (const slip of slips) {
    const type = rules.slips.get(slip.type.trim().toUpperCase());
    if (!type) continue;
    const boxes: Record<string, string> = {};
    const unsure = new Set(slip.unsure.map((box) => box.trim().toUpperCase()).filter((box) => box in type.boxes));
    for (const [rawBox, rawAmount] of Object.entries(slip.boxes)) {
      const box = rawBox.trim().toUpperCase();
      if (!(box in type.boxes)) continue;
      // A code box keeps one of its codes; anything else read there is for a person to enter.
      if (box in type.codes) {
        const code = rawAmount.trim().toUpperCase();
        if (type.codes[box]!.includes(code)) boxes[box] = code;
        else unsure.add(box);
        continue;
      }
      const amount = normalizeAmount(rawAmount);
      if (/^\d{1,9}(\.\d{1,2})?$/.test(amount)) boxes[box] = Dec.from(amount).toString();
      else unsure.add(box);
    }
    // A slip with no amount read is still kept when it names boxes it couldn't read: they are entered at Confirm.
    if (Object.keys(boxes).length === 0 && unsure.size === 0) continue;
    const issuer = slip.issuer.trim().slice(0, 100) || "Unknown issuer";
    const match = matchPerson(slip.person, members);
    const named = match === null || match === "several" ? null : match;
    if (named && !adults.has(named.id) && !type.receipt) {
      skipped.push({ type: type.id, issuer, personName: named.name });
      continue;
    }
    const person = named && adults.has(named.id) ? named : uploader;
    planned.push({ type: type.id, issuer, personId: person.id, personName: person.name, guessed: named === null, boxes, unsure: [...unsure] });
  }
  return { planned, skipped };
}

/** The person whose name is on the slip: the whole name, or failing that a shared first name; null if none, "several" if more than one. */
function matchPerson(printed: string, people: Person[]): Person | null | "several" {
  const words = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const target = words(printed);
  // A name with no letters a to z left (another script) can't be matched, rather than matching every slip.
  const named = people.filter((person) => words(person.name).length > 0);
  const whole = named.filter((person) => words(person.name).every((word) => target.includes(word)));
  if (whole.length === 1) return whole[0]!;
  const first = named.filter((person) => target.includes(words(person.name)[0]!));
  if (first.length === 1) return first[0]!;
  return whole.length > 1 || first.length > 1 ? "several" : null;
}

/**
 * A reading that adds nothing to a slip: the same type, person and issuer, at least one amount, every amount it has on
 * the slip with the same value, and every box it couldn't read one the slip has.
 */
function addsNothing(reading: Planned, slip: { type: string; issuer: string; personId: string; boxes: Record<string, string> }): boolean {
  if (slip.type !== reading.type || slip.personId !== reading.personId || slip.issuer.trim().toLowerCase() !== reading.issuer.toLowerCase()) return false;
  const amounts = Object.entries(reading.boxes);
  return (
    amounts.length > 0 &&
    amounts.every(([box, amount]) => slip.boxes[box] !== undefined && sameBoxValue(slip.boxes[box], amount)) &&
    reading.unsure.every((box) => slip.boxes[box] !== undefined)
  );
}

/** The file's name from X-File-Name, without a folder. Required: a file replaces the one of its name in the return. */
function fileName(header: string | null): string {
  let name = header ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not URI-encoded: taken as sent.
  }
  name = name.replace(/[\u0000-\u001f]/g, "").split(/[\\/]/).pop()!.trim().slice(0, 200);
  if (name === "") throw new ApiError("validation_failed", "Send the file's name in an X-File-Name header", [{ path: "X-File-Name", message: "Required: the file's name, URI-encoded" }]);
  return name;
}

/** The body's bytes, refusing more than `limit` while reading rather than trusting Content-Length. */
async function readBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader?.read();
    if (!next || next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader?.cancel();
      throw new ApiError("payload_too_large", "A file can be at most 10 MiB");
    }
    chunks.push(next.value);
  }
  if (total === 0) throw new ApiError("validation_failed", "The file is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A file is what its type says by its first bytes: a PDF starts with %PDF-, a PNG and a JPEG with their signatures. */
function looksLike(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "application/pdf") return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (contentType === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function split(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) chunks.push(bytes.slice(offset, offset + CHUNK_BYTES));
  return chunks;
}

const insertChunk = (db: Db, orgId: string, documentId: string, index: number, bytes: Uint8Array) =>
  db.prepare("INSERT INTO document_chunks (document_id, chunk_index, org_id, bytes) VALUES (?, ?, ?, ?)").bind(documentId, index, orgId, bytes);

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
