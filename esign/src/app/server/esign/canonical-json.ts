/**
 * Canonical JSON for hashing: object keys sorted by UTF-16 code units, no whitespace, strings and
 * finite numbers as JSON.stringify writes them, and only plain JSON values. The same value always
 * gives the same text, and a value that does not round-trip through JSON (undefined, NaN, a Date,
 * a class instance) is refused rather than silently changed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Canonical JSON: not a plain object');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => {
      if (record[key] === undefined) throw new Error(`Canonical JSON: undefined value for ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    }).join(',')}}`;
  }
  throw new Error(`Canonical JSON: unsupported ${typeof value}`);
}
