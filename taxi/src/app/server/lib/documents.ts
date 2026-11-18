import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, type DocumentList, type DocumentRecord, type Person, type ReadResult, type Slip, type TaxYear } from "#shared";
import { Dec } from "../../shared/engine/decimal.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { audit, bumpRevision, getYear, runGuarded, yearRow, type YearRow } from "./household.ts";
import { ApiError, conflict, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { FileToRead, ReadSlip, SlipReader } from "./reader.ts";
import { loadWorkspace } from "./workspace.ts";

// Step 2: one uploaded file per request. The file is checked (type, size, its first bytes), stored in D1 in 256 KiB
// pieces, and read by AI into slips. What comes back is checked against the year's slip types before anything is
// saved; slips are added unconfirmed to the adult whose name is on them. The same file uploaded again (its SHA-256,
// whatever its name), or a file whose slips are all in the year already (same type, issuer and boxes), isn't saved. A
// file with the name of one in the same return, and other content, is a new version: it replaces that one and its slips.
// A file that couldn't be read can be read again from its stored bytes; any file can be deleted with its slips.

type Db = D1Database;
const CHUNK_BYTES = 256 * 1024;
const CHUNKS_PER_BATCH = 2;
/** The statuses of a file that wasn't read and has no slips: it can be read again, and the same file uploaded replaces it. */
const UNREAD = ["failed", "not_available"] as const;
const UNREAD_SQL = UNREAD.map((status) => `'${status}'`).join(", ");

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
      .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE org_id = ? AND tax_year_id = ? ORDER BY created_at DESC, id`)
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
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND org_id = ? AND tax_year_id = ?`)
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
  const view = await getYear(db, caller.orgId, year);
  const uploader = uploaderOf(view, request.headers.get("X-Person-Id"));

  // A file of the same name in this return (uploaded in it, or holding a slip of its adult) is an earlier version of
  // this one: the same content is unchanged; other content replaces it, with its slips, once this one is read.
  const sameName = (
    await db
      .prepare(
        `SELECT id, sha256, status FROM documents d WHERE org_id = ? AND tax_year_id = ? AND name = ?
           AND (person_id = ? OR EXISTS (SELECT 1 FROM slips s WHERE s.document_id = d.id AND s.person_id = ?))`,
      )
      .bind(caller.orgId, row.id, name, uploader.id, uploader.id)
      .all<{ id: string; sha256: string; status: string }>()
  ).results;
  const unread = (status: string) => (UNREAD as readonly string[]).includes(status);
  if (sameName.some((each) => each.sha256 === sha256 && !unread(each.status))) {
    return { status: "duplicate", message: `${name} is unchanged. Nothing to update.`, document: null, replaced: [], year: view };
  }
  const earlier = await db
    .prepare(`SELECT name FROM documents WHERE org_id = ? AND tax_year_id = ? AND sha256 = ? AND status NOT IN (${UNREAD_SQL}) LIMIT 1`)
    .bind(caller.orgId, row.id, sha256)
    .first<{ name: string }>();
  if (earlier) return { status: "duplicate", message: `The same file is already here, as ${earlier.name}.`, document: null, replaced: [], year: view };

  const workspace = await loadWorkspace(db, caller.orgId, row.id);
  const previous = sameName.map((each) => each.id);
  const reading = await readInto(year, view, uploader, { bytes, contentType: contentType as FileToRead["contentType"] }, reader, workspace.slips, previous);
  // An earlier version is replaced only by a file read into slips: one that couldn't be read keeps it, and isn't saved.
  if (previous.length > 0 && reading.status !== "read" && reading.status !== "duplicate") {
    return { status: reading.status, message: `${reading.message} The earlier ${name} is kept.`, document: null, replaced: [], year: view };
  }
  const replacing = previous.length > 0 ? `Replaced the earlier ${name}${slipsNote(workspace.slips.filter((slip) => slip.documentId !== null && previous.includes(slip.documentId)))}. ` : "";
  const replaced = previous.map((id) => ({ id, name }));
  const removePrevious = previous.flatMap((old) => [...deleteDocumentRows(db, caller.orgId, row.id, old), audit(db, caller, "document.replaced", old, now)]);
  const bump = db.prepare("UPDATE tax_years SET revision = revision + 1, updated_at = ? WHERE id = ? AND org_id = ?").bind(now, row.id, caller.orgId);
  if (reading.status === "duplicate") {
    if (previous.length === 0) return { status: "duplicate", message: reading.message, document: null, replaced: [], year: view };
    await db.batch([...removePrevious, bump]);
    return { status: "duplicate", message: `${replacing}${reading.message} This file wasn't saved.`, document: null, replaced, year: await getYear(db, caller.orgId, year) };
  }

  // The same file uploaded before that couldn't be read is replaced by this one too: it has no slips.
  const unreadCopies = (
    await db
      .prepare(`SELECT id FROM documents WHERE org_id = ? AND tax_year_id = ? AND sha256 = ? AND status IN (${UNREAD_SQL})`)
      .bind(caller.orgId, row.id, sha256)
      .all<{ id: string }>()
  ).results
    .map((each) => each.id)
    .filter((id) => !previous.includes(id));

  // The earlier versions out, then the file, its first pieces and the slips, in one batch; then the rest of the pieces
  // two at a time (a D1 batch has a size limit). The year's revision goes up without a check, so uploads running side
  // by side don't refuse each other.
  const id = crypto.randomUUID();
  const chunks = split(bytes);
  const slipIds = reading.found.map(() => crypto.randomUUID());
  await db.batch([
    ...removePrevious,
    ...unreadCopies.flatMap((old) => deleteDocumentRows(db, caller.orgId, row.id, old)),
    db
      .prepare(
        `INSERT INTO documents (id, org_id, tax_year_id, name, content_type, byte_size, sha256, status, message, model_id, person_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, caller.orgId, row.id, name, contentType, bytes.byteLength, sha256, reading.status, reading.message, reading.modelId, uploader.id, now),
    ...chunks.slice(0, CHUNKS_PER_BATCH).map((chunk, index) => insertChunk(db, caller.orgId, id, index, chunk)),
    ...reading.found.map((slip, index) => insertSlip(db, caller.orgId, row.id, slipIds[index]!, slip, id, now)),
    bump,
    audit(db, caller, "document.uploaded", id, now),
  ]);
  for (let start = CHUNKS_PER_BATCH; start < chunks.length; start += CHUNKS_PER_BATCH) {
    await db.batch(chunks.slice(start, start + CHUNKS_PER_BATCH).map((chunk, offset) => insertChunk(db, caller.orgId, id, start + offset, chunk)));
  }

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

/** " and its 2 slips (1 confirmed)", for saying what replacing a file took with it. */
function slipsNote(slips: { status: string }[]): string {
  if (slips.length === 0) return "";
  const confirmed = slips.filter((slip) => slip.status === "confirmed").length;
  return ` and its ${slips.length === 1 ? "slip" : `${slips.length} slips`}${confirmed > 0 ? ` (${confirmed} confirmed)` : ""}`;
}

/**
 * Reads a file that couldn't be read again, from its stored bytes, into the return it was uploaded in. Its slips and
 * its new status are saved only while it is still unread, so reading it twice at once adds its slips once. A file
 * whose slips are all in the year already is removed, as an upload of it wouldn't have been saved.
 */
export async function readDocumentAgain(db: Db, caller: Caller, year: number, id: string, reader: SlipReader, now: number): Promise<ReadResult> {
  const row = await openYear(db, caller.orgId, year);
  const document = await documentRow(db, caller.orgId, row.id, id);
  if (!(UNREAD as readonly string[]).includes(document.status)) throw conflict("This file was read already");
  const file = await documentFile(db, caller.orgId, year, id);
  const view = await getYear(db, caller.orgId, year);
  const adults = view.adults.map((adult) => adult.personId);
  const uploader = uploaderOf(view, document.person_id !== null && adults.includes(document.person_id) ? document.person_id : null);
  const reading = await readInto(year, view, uploader, { bytes: file.bytes, contentType: file.contentType as FileToRead["contentType"] }, reader, (await loadWorkspace(db, caller.orgId, row.id)).slips);

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
  const results = await db.batch([
    ...statements,
    db.prepare("UPDATE tax_years SET revision = revision + 1, updated_at = ? WHERE id = ? AND org_id = ?").bind(now, row.id, caller.orgId),
    audit(db, caller, reading.status === "duplicate" ? "document.deleted" : "document.read_again", id, now),
  ]);
  if ((results[statements.length - 1]?.meta.changes ?? 0) === 0) throw conflict("This file was read already");

  const updated = await getYear(db, caller.orgId, year);
  if (reading.status === "duplicate") return { status: "duplicate", message: reading.message, document: null, replaced: [], year: updated };
  const saved = await documentRow(db, caller.orgId, row.id, id);
  return { status: reading.status, message: reading.message, document: recordOf(saved, (await loadWorkspace(db, caller.orgId, row.id)).slips), replaced: [], year: updated };
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

/** AI's reading of a file, checked against the year's rules and the slips already in it (less those of the files it replaces). */
async function readInto(year: number, view: TaxYear, uploader: Person, file: FileToRead, reader: SlipReader, slips: Slip[], replacing: string[] = []): Promise<Reading> {
  const rules = rulesFor(year)!;
  const outcome = await reader.read(file, {
    year,
    rules,
    people: view.people.filter((person) => view.members.includes(person.id)).map((person) => ({ name: person.name, relationship: person.relationship })),
  });
  if (outcome.kind !== "read") return { status: outcome.kind, message: outcome.message, modelId: null, found: [] };
  const modelId = outcome.model;
  if (outcome.taxYear !== null && outcome.taxYear !== year) return { status: "not_a_slip", message: `This is a slip for ${outcome.taxYear}, not ${year}.`, modelId, found: [] };
  const planned = plan(outcome.slips, view, year, uploader);
  if (planned.length === 0) return { status: "not_a_slip", message: "No slip this app reads was found in this file.", modelId, found: [] };
  const existing = slips.filter((slip) => slip.documentId === null || !replacing.includes(slip.documentId));
  const found = planned.filter((slip) => !existing.some((other) => sameSlip(other, slip)));
  if (found.length === 0) return { status: "duplicate", message: "The slips in this file are already in this year.", modelId, found: [] };
  const message = found
    .map((slip) => `${slip.type} from ${slip.issuer}${slip.personId === uploader.id ? "" : `, added to ${slip.personName}'s return`}${slip.guessed ? " (check whose it is)" : ""}`)
    .join("; ");
  return { status: "read", message, modelId, found };
}

interface Planned {
  type: string;
  issuer: string;
  personId: string;
  personName: string;
  /** Several adults' names matched: the slip went to the return it was uploaded in, to be checked. */
  guessed: boolean;
  boxes: Record<string, string>;
  unsure: string[];
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
 * isn't is left out and marked unsure), and the adult whose name is on it. A name that matches no adult, or several,
 * leaves the slip in the return it was uploaded in.
 */
function plan(slips: ReadSlip[], view: TaxYear, year: number, uploader: Person): Planned[] {
  const rules = rulesFor(year)!;
  const adults = view.adults.map((adult) => view.people.find((person) => person.id === adult.personId)!);
  const planned: Planned[] = [];
  for (const slip of slips) {
    const type = rules.slips.get(slip.type.trim().toUpperCase());
    if (!type) continue;
    const boxes: Record<string, string> = {};
    const unsure = new Set(slip.unsure.map((box) => box.trim().toUpperCase()).filter((box) => box in type.boxes));
    for (const [rawBox, rawAmount] of Object.entries(slip.boxes)) {
      const box = rawBox.trim().toUpperCase();
      if (!(box in type.boxes)) continue;
      const amount = rawAmount.replace(/[$,\s]/g, "");
      if (/^\d{1,9}(\.\d{1,2})?$/.test(amount)) boxes[box] = Dec.from(amount).toString();
      else unsure.add(box);
    }
    if (Object.keys(boxes).length === 0) continue;
    const match = matchPerson(slip.person, adults);
    const person = match === null || match === "several" ? uploader : match;
    planned.push({
      type: type.id,
      issuer: slip.issuer.trim().slice(0, 100) || "Unknown issuer",
      personId: person.id,
      personName: person.name,
      guessed: match === "several",
      boxes,
      unsure: [...unsure],
    });
  }
  return planned;
}

/** The adult whose name is on the slip: the whole name, or failing that a shared first name; null if none, "several" if more than one. */
function matchPerson(printed: string, adults: Person[]): Person | null | "several" {
  const words = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const target = words(printed);
  if (adults.length === 1) return adults[0]!;
  const whole = adults.filter((adult) => words(adult.name).every((word) => target.includes(word)));
  if (whole.length === 1) return whole[0]!;
  const first = adults.filter((adult) => target.includes(words(adult.name)[0] ?? ""));
  if (first.length === 1) return first[0]!;
  return whole.length > 1 || first.length > 1 ? "several" : null;
}

/**
 * The same slip: same type, person and issuer, and every box both have holds the same amount. A slip typed in by hand
 * often has fewer boxes than the file, so the boxes only one of them has don't count.
 */
function sameSlip(slip: { type: string; issuer: string; personId: string; boxes: Record<string, string> }, other: Planned): boolean {
  if (slip.type !== other.type || slip.personId !== other.personId || slip.issuer.trim().toLowerCase() !== other.issuer.toLowerCase()) return false;
  const shared = Object.keys(slip.boxes).filter((box) => other.boxes[box] !== undefined);
  return shared.length > 0 && shared.every((box) => Dec.from(slip.boxes[box]!).eq(other.boxes[box]!));
}

function fileName(header: string | null): string {
  let name = "document";
  try {
    name = header ? decodeURIComponent(header) : name;
  } catch {
    name = header ?? name;
  }
  name = name.replace(/[\u0000-\u001f]/g, "").trim().split(/[\\/]/).pop() ?? "";
  return name.slice(0, 200) || "document";
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
