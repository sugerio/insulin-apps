// Pre-filled fields (fields.ts, type `Prefill`): a template's fields that nobody signs, whose values the sender gives
// when the envelope is sent (`prefill: {name: value}` on POST /api/envelopes), else their default. The values are
// drawn on the envelope's initial document (D0) before anyone signs, so what signers see, sign and the seal covers is
// the document with them; the envelope keeps only its signers' fields, and the values in its details.
//
// Drawn as Title and Date signed text is (renderText: printable ASCII, at most 128 characters), 18 points high, smaller
// down to 12 points when the box is narrow, never cut: a value that doesn't fit is refused. The PDF is loaded and saved
// as a signature's output is (no metadata update, no object streams), so the same values give the same bytes, and a
// retried send stores the very same D0.
import { PDFDocument } from 'pdf-lib';
import { renderText } from './field-render.ts';
import { PREFILL, validPrefillValue, type PrefillDefinition, type TemplateField } from './fields.ts';

/** The tallest and smallest text a pre-filled value is drawn with, in PDF points. */
const PREFILL_HEIGHT = 18, PREFILL_MIN_HEIGHT = 12;
/** renderText's image height, in pixels. */
const TEXT_ROWS = 96;

/** A value given, by name. */
export type PrefillInput = Record<string, string>;
/** What an envelope keeps of its pre-filled fields (its details): each name's label and the value drawn. */
export type PrefillValue = { name: string; label: string; value: string };

/** The request's `prefill`: an object of names to strings, or 'invalid'. */
export function parsePrefill(value: unknown): PrefillInput | null | 'invalid' {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 60) return 'invalid';
  const out: PrefillInput = {};
  for (const [name, given] of entries) {
    if (name.length > 64 || typeof given !== 'string') return 'invalid';
    out[name] = given;
  }
  return out;
}

/**
 * The values to draw: each of the template's names, as given or its default; or why not (names the template hasn't,
 * values the renderer can't draw, required ones without a value).
 */
export function resolvePrefill(definitions: PrefillDefinition[], given: PrefillInput | null):
  { values: PrefillValue[] } | { error: 'unknown_prefill' | 'invalid_prefill' | 'prefill_missing'; fields: string[] } {
  const known = new Set(definitions.map((d) => d.name));
  const unknown = Object.keys(given ?? {}).filter((name) => !known.has(name));
  if (unknown.length) return { error: 'unknown_prefill', fields: unknown };
  const invalid = Object.entries(given ?? {}).filter(([, value]) => !validPrefillValue(value)).map(([name]) => name);
  if (invalid.length) return { error: 'invalid_prefill', fields: invalid };
  // Own values only: a name like `toString` is the field's, not something the values' object inherits.
  const values = definitions.map((d) => ({ name: d.name, label: d.label, value: (given && Object.hasOwn(given, d.name) ? given[d.name] : undefined) ?? d.default ?? '' }));
  const missing = definitions.filter((d, i) => d.required && !values[i]!.value).map((d) => d.name);
  if (missing.length) return { error: 'prefill_missing', fields: missing };
  return { values };
}

/** A value that doesn't fit its box even at the smallest size: the names of those that don't. */
export class PrefillDoesNotFit extends Error {
  readonly fields: string[];
  constructor(fields: string[]) { super('Pre-filled value does not fit'); this.fields = fields; }
}

/**
 * The document with each pre-filled field's value drawn in its box(es); the source as it is when nothing is to be
 * drawn. Throws PrefillDoesNotFit naming the values too long for their boxes.
 */
export async function stampPrefill(source: Uint8Array, fields: TemplateField[], values: PrefillValue[]): Promise<Uint8Array> {
  const byName = new Map(values.filter((v) => v.value).map((v) => [v.name, v.value]));
  const placed = fields.filter((f) => f.type === PREFILL && byName.has(f.name!));
  if (!placed.length) return source;
  const pdf = await PDFDocument.load(source, { updateMetadata: false, throwOnInvalidObject: true });
  const tooLong = new Set<string>();
  const images = new Map<string, { image: Uint8Array; png: Awaited<ReturnType<PDFDocument['embedPng']>> }>();
  for (const field of placed) {
    const value = byName.get(field.name!)!;
    let drawn = images.get(value);
    if (!drawn) { const image = await renderText(value); drawn = { image, png: await pdf.embedPng(image) }; images.set(value, drawn); }
    const { image, png } = drawn;
    const page = pdf.getPage(field.page - 1);
    const box = { x: field.rect.x * page.getWidth(), y: field.rect.y * page.getHeight(), width: field.rect.width * page.getWidth(), height: field.rect.height * page.getHeight() };
    const pixels = new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(16);
    // As tall as allowed, narrower if the box is; centred in the box's height.
    const height = Math.min(PREFILL_HEIGHT, box.height, box.width * TEXT_ROWS / pixels);
    if (height < PREFILL_MIN_HEIGHT - 1e-9) { tooLong.add(field.name!); continue; }
    const width = pixels * height / TEXT_ROWS, top = box.y + (box.height - height) / 2;
    page.drawImage(png, { x: box.x, y: page.getHeight() - top - height, width, height });
  }
  if (tooLong.size) throw new PrefillDoesNotFit([...tooLong]);
  return pdf.save({ useObjectStreams: false });
}
