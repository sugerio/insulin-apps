import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, type DocumentList, type DocumentRecord, type Person, type TaxYear, type UploadResult } from "#shared";
import { Dec } from "../../shared/engine/decimal.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { audit, getYear, yearRow } from "./household.ts";
import { ApiError, conflict, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { FileToRead, ReadSlip, SlipReader } from "./reader.ts";
import { loadWorkspace } from "./workspace.ts";

// Step 2: one uploaded file per request. The file is checked (type, size, its first bytes), stored in D1 in 256 KiB
// pieces, and read by AI into slips. What comes back is checked against the year's slip types before anything is
// saved; slips are added unconfirmed to the adult whose name is on them. The same file uploaded twice (its SHA-256),
// or a slip already in the year (same type, issuer and boxes), is skipped.

type Db = D1Database;
const CHUNK_BYTES = 256 * 1024;
const CHUNKS_PER_BATCH = 2;

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

export async function listDocuments(db: Db, orgId: string, year: number): Promise<DocumentList> {
  const row = await yearRow(db, orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  const [documents, workspace] = await Promise.all([
    db
      .prepare("SELECT id, name, content_type, byte_size, status, message, person_id, created_at FROM documents WHERE org_id = ? AND tax_year_id = ? ORDER BY created_at DESC, id")
      .bind(orgId, row.id)
      .all<DocumentRow>(),
    loadWorkspace(db, orgId, row.id),
  ]);
  return {
    documents: documents.results.map((document) => ({
      id: document.id,
      name: document.name,
      contentType: document.content_type,
      byteSize: document.byte_size,
      status: document.status,
      message: document.message,
      personId: document.person_id,
      slips: workspace.slips
        .filter((slip) => slip.documentId === document.id)
        .map((slip) => ({ id: slip.id, type: slip.type, personId: slip.personId, issuer: slip.issuer })),
      createdAt: document.created_at,
    })),
  };
}

/** A stored file's bytes, put back together, for showing it beside its numbers. */
export async function documentFile(db: Db, orgId: string, year: number, id: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string; name: string }> {
  const row = await yearRow(db, orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  const document = await db
    .prepare("SELECT name, content_type, byte_size FROM documents WHERE id = ? AND org_id = ? AND tax_year_id = ?")
    .bind(id, orgId, row.id)
    .first<{ name: string; content_type: string; byte_size: number }>();
  if (!document) throw notFound("No such file in this year");
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

export async function uploadDocument(db: Db, caller: Caller, year: number, request: Request, reader: SlipReader, now: number): Promise<UploadResult> {
  const row = await yearRow(db, caller.orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
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
  const id = crypto.randomUUID();

  const earlier = await db
    .prepare("SELECT name FROM documents WHERE org_id = ? AND tax_year_id = ? AND sha256 = ? AND status IN ('read', 'not_a_slip') LIMIT 1")
    .bind(caller.orgId, row.id, sha256)
    .first<{ name: string }>();
  let status: DocumentRecord["status"];
  let message: string;
  let modelId: string | null = null;
  let found: Planned[] = [];
  if (earlier) {
    status = "duplicate";
    message = `The same file was uploaded before, as ${earlier.name}.`;
  } else {
    const rules = rulesFor(year)!;
    const outcome = await reader.read({ bytes, contentType: contentType as FileToRead["contentType"] }, {
      year,
      rules,
      people: view.people.filter((person) => view.members.includes(person.id)).map((person) => ({ name: person.name, relationship: person.relationship })),
    });
    if (outcome.kind !== "read") {
      status = outcome.kind;
      message = outcome.message;
    } else {
      modelId = outcome.model;
      const planned = plan(outcome.slips, view, year, uploader);
      const existing = (await loadWorkspace(db, caller.orgId, row.id)).slips;
      found = planned.filter((slip) => !existing.some((other) => sameSlip(other, slip)));
      if (outcome.taxYear !== null && outcome.taxYear !== year) {
        status = "not_a_slip";
        message = `This is a slip for ${outcome.taxYear}, not ${year}.`;
        found = [];
      } else if (planned.length === 0) {
        status = "not_a_slip";
        message = "No slip this app reads was found in this file.";
      } else if (found.length === 0) {
        status = "duplicate";
        message = "The slips in this file are already in this year.";
      } else {
        status = "read";
        message = found
          .map((slip) => `${slip.type} from ${slip.issuer}${slip.personId === uploader.id ? "" : `, added to ${slip.personName}'s return`}${slip.guessed ? " (check whose it is)" : ""}`)
          .join("; ");
      }
    }
  }

  // The file, its first pieces and the slips in one batch; then the rest of the pieces two at a time (a D1 batch has
  // a size limit). The year's revision goes up without a check: an upload adds slips and overwrites nothing, so
  // uploads running side by side don't refuse each other.
  const chunks = status === "duplicate" ? [] : split(bytes);
  const slipIds = found.map(() => crypto.randomUUID());
  await db.batch([
    db
      .prepare(
        `INSERT INTO documents (id, org_id, tax_year_id, name, content_type, byte_size, sha256, status, message, model_id, person_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, caller.orgId, row.id, name, contentType, bytes.byteLength, sha256, status, message, modelId, uploader.id, now),
    ...chunks.slice(0, CHUNKS_PER_BATCH).map((chunk, index) => insertChunk(db, caller.orgId, id, index, chunk)),
    ...found.map((slip, index) =>
      db
        .prepare(
          `INSERT INTO slips (id, org_id, tax_year_id, person_id, type, issuer, boxes, status, source, document_id, unsure, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'unconfirmed', 'ai', ?, ?, ?, ?)`,
        )
        .bind(slipIds[index]!, caller.orgId, row.id, slip.personId, slip.type, slip.issuer, JSON.stringify(slip.boxes), id, JSON.stringify(slip.unsure), now, now),
    ),
    db.prepare("UPDATE tax_years SET revision = revision + 1, updated_at = ? WHERE id = ? AND org_id = ?").bind(now, row.id, caller.orgId),
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
    status,
    message,
    personId: uploader.id,
    slips: found.map((slip, index) => ({ id: slipIds[index]!, type: slip.type, personId: slip.personId, issuer: slip.issuer })),
    createdAt: now,
  };
  const updated: TaxYear = await getYear(db, caller.orgId, year);
  return { document, year: updated };
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
