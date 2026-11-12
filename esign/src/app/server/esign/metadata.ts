/**
 * What a host says about its own templates and envelopes: a template's name, and metadata, a small
 * set of string keys and values (its own ids, for instance) that Esign keeps and returns as given
 * and never reads. They label a record; they are never evidence: not sealed, and not shown to signers.
 */

export const MAX_TEMPLATE_NAME = 200;
export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_VALUE = 500;
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

export type Metadata = Record<string, string>;

/** A template's name from a request: trimmed, without control characters; null when absent or empty, or 'invalid'. */
export function parseTemplateName(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'invalid';
  const name = value.trim();
  if (name.length > MAX_TEMPLATE_NAME || /[\u0000-\u001f\u007f]/.test(name)) return 'invalid';
  return name || null;
}

/**
 * Metadata from a request: an object of at most 20 keys (letters, digits, `_`, `.` and `-`, up to 40
 * characters) whose values are strings of up to 500 characters without control characters. Null
 * when absent or empty, or 'invalid'.
 */
export function parseMetadata(value: unknown): Metadata | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) return 'invalid';
  const out: Metadata = {};
  for (const [key, item] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!METADATA_KEY.test(key) || typeof item !== 'string' || item.length > MAX_METADATA_VALUE || /[\u0000-\u001f\u007f]/.test(item)) return 'invalid';
    out[key] = item;
  }
  return entries.length ? out : null;
}

/** Stored metadata as returned: the string values of a JSON object; anything else is dropped. */
export function storedMetadata(raw: unknown): Metadata {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The keys of `value` that `allowed` doesn't list, for a request that must name only known fields. */
export function unknownKeys(value: object, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}
