/**
 * A template's default signers: for some of its roles, who usually signs as it, a name, an email or
 * both (a company's own countersigner, say). The send form fills them in, and a recipient of a new
 * envelope that leaves out its name or email gets its role's default. They are kept with the
 * template like its name, and are never evidence: an envelope records whom it was sent to.
 */

const MAX_NAME = 200;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type DefaultSigner = { name?: string; email?: string };
export type DefaultSigners = Record<string, DefaultSigner>;

/**
 * Default signers from a request: an object whose keys are some of `roles` and whose values have a
 * `name` (up to 200 characters), an `email`, or both; empty ones are left out. Null when absent or
 * empty, or 'invalid'.
 */
export function parseDefaultSigners(value: unknown, roles: readonly string[]): DefaultSigners | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const out: [string, DefaultSigner][] = [];
  for (const [role, item] of Object.entries(value as Record<string, unknown>)) {
    if (!roles.includes(role) || !item || typeof item !== 'object' || Array.isArray(item)) return 'invalid';
    const v = item as Record<string, unknown>;
    if (Object.keys(v).some((key) => key !== 'name' && key !== 'email')) return 'invalid';
    if ((v.name !== undefined && v.name !== null && typeof v.name !== 'string') || (v.email !== undefined && v.email !== null && typeof v.email !== 'string')) return 'invalid';
    const name = typeof v.name === 'string' ? v.name.trim() : '', email = typeof v.email === 'string' ? v.email.trim() : '';
    if (name.length > MAX_NAME || CONTROL.test(name) || (email && (email.length > MAX_EMAIL || !EMAIL.test(email)))) return 'invalid';
    if (name || email) out.push([role, { ...(name ? { name } : {}), ...(email ? { email } : {}) }]);
  }
  // fromEntries defines each key, so a role named `__proto__` is kept like any other.
  return out.length ? Object.fromEntries(out) : null;
}

/** Stored default signers as returned: those of `roles` that are well formed; anything else is dropped. */
export function storedDefaultSigners(raw: string | null | undefined, roles: readonly string[]): DefaultSigners {
  let value: unknown;
  try { value = JSON.parse(raw ?? '{}'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const kept = Object.entries(value as Record<string, unknown>).filter(([role]) => roles.includes(role));
  const parsed = parseDefaultSigners(Object.fromEntries(kept), roles);
  return parsed === null || parsed === 'invalid' ? {} : parsed;
}

/** The names among default signers, which must be drawable like any signer's (checked when they are given). */
export const defaultSignerNames = (signers: DefaultSigners | null) => Object.values(signers ?? {}).flatMap((s) => s.name ? [s.name] : []);
