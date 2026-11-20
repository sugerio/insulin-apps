// Who in the organization can use Esign, as the platform says (its gateway's member lookup and member status,
// DESIGN.md §8.9): Esign keeps no directory of its own, and people it hasn't seen yet can still be picked, while people
// the organization removed or took Esign from are not. Both are asked with the app's token (SUGER_APP_TOKEN) over the
// gateway's service binding.
//
// - The member lookup (SUGER_MEMBERS_URL) answers for the person of a browser request only, passed back in the
//   x-suger-member-lookup header the gateway signed on it: the app's token alone reads no one. It gives the people to
//   share with and checks an API client's people. Without the endpoint or the header (the local preview, tests, an AI
//   agent's or API client's request) or when it fails, callers fall back on the people Esign has seen (members.ts).
// - Member status (SUGER_MEMBER_STATUS_URL) answers by id, with no request of theirs: whether whoever scheduled a send
//   may still send (scheduled-send.ts).
import { gatewayEndpoint } from '../gateway-fetch.ts';

export type DirectoryEnv = {
  SUGER_MEMBERS_URL?: string;
  SUGER_MEMBER_STATUS_URL?: string;
  SUGER_APP_TOKEN?: string;
  /** The fetch the gateway is called with: its service binding (router.ts), or tests' own. */
  MEMBERS_FETCH?: typeof fetch;
};

/** The header of a browser request that the member lookup takes back: the organization and the person, signed. */
export const MEMBER_LOOKUP_HEADER = 'x-suger-member-lookup';

/** Someone who can use Esign: their id (the x-suger-user-id their requests carry), name and email. */
export type DirectoryMember = { id: string; name?: string; email: string };

/** The most one lookup answers (the platform's limit): a larger organization is asked by name or email. */
export const LOOKUP_MAX = 20;
/** The longest text the platform searches for. */
export const LOOKUP_QUERY_MAX = 100;

/**
 * The organization's people who can use Esign whose name or email contains `q` (1 to 100 characters), at most 20, as
 * the platform finds them for the person of the browser request being served (`lookup`, its x-suger-member-lookup
 * header); never the organization's API clients. Null when it can't be asked (no endpoint, no header) or didn't answer
 * as agreed.
 */
export async function lookupMembers(env: DirectoryEnv, lookup: string | null | undefined, q: string): Promise<DirectoryMember[] | null> {
  const endpoint = gatewayEndpoint(env.SUGER_MEMBERS_URL, env.SUGER_APP_TOKEN);
  const text = q.trim();
  if (!endpoint || !lookup || !text || text.length > LOOKUP_QUERY_MAX) return null;
  const url = new URL(endpoint.url);
  url.searchParams.set('q', text);
  try {
    const response = await (env.MEMBERS_FETCH ?? fetch)(url.href, {
      headers: { authorization: `Bearer ${endpoint.token}`, [MEMBER_LOOKUP_HEADER]: lookup },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { members?: unknown };
    if (!Array.isArray(body.members)) return null;
    return body.members.flatMap((item): DirectoryMember[] => {
      const m = item as { type?: unknown; id?: unknown; name?: unknown; email?: unknown };
      if (m.type !== undefined && m.type !== 'person') return [];
      if (typeof m.id !== 'string' || typeof m.email !== 'string' || !m.email.includes('@')) return [];
      return [{ id: m.id, email: m.email, ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim() } : {}) }];
    });
  } catch {
    return null;
  }
}

/** Whether Esign has the platform's member status to ask (without it, the local preview and tests). */
export const memberStatusConfigured = (env: DirectoryEnv) => gatewayEndpoint(env.SUGER_MEMBER_STATUS_URL, env.SUGER_APP_TOKEN) !== null;

/**
 * Someone Esign holds, as the platform says now: still able to use Esign (`member`), with their role and, as their
 * requests carry them, permissions in it, and whether the account is active; or no longer (`away`: a person who left
 * or lost Esign, a revoked or deleted API client).
 */
export type MemberNow =
  | { status: 'member'; role?: string; permissions?: string[]; active: boolean }
  | { status: 'away' };

/**
 * An organization's people and API clients as the platform says now (POST SUGER_MEMBER_STATUS_URL): `answered`, with
 * whether the organization is active and each id asked about (an id the answer leaves out isn't there); `deleted`, the
 * organization no longer exists; or `unconfirmed`, the platform has no record that Esign is used in it yet, which it
 * makes at the next request to Esign there (DESIGN.md §8.9).
 */
export type OrganizationNow =
  | { status: 'answered'; active: boolean; members: Map<string, MemberNow> }
  | { status: 'deleted' }
  | { status: 'unconfirmed' };

/** The most ids one member status request takes (the platform's limit). */
export const STATUS_IDS_MAX = 100;
/** The longest one member status request may take. */
export const STATUS_TIMEOUT_MS = 5000;

/**
 * The organization, and up to 100 of its people or API clients by id, as the platform says now, in one request: null
 * when the platform can't be asked, didn't answer as agreed, or took longer than `timeoutMs` (at most
 * STATUS_TIMEOUT_MS: an answer that comes late is no answer).
 */
export async function organizationNow(env: DirectoryEnv, organizationId: string, ids: string[], timeoutMs = STATUS_TIMEOUT_MS): Promise<OrganizationNow | null> {
  const endpoint = gatewayEndpoint(env.SUGER_MEMBER_STATUS_URL, env.SUGER_APP_TOKEN);
  const limit = Math.min(timeoutMs, STATUS_TIMEOUT_MS);
  if (!endpoint || ids.length > STATUS_IDS_MAX || limit <= 0) return null;
  const started = Date.now();
  try {
    const response = await (env.MEMBERS_FETCH ?? fetch)(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ org: organizationId, ids }),
      signal: AbortSignal.timeout(limit),
    });
    if (Date.now() - started > limit) return null;
    if (response.status === 404) {
      const error = (await response.json().catch(() => ({})) as { error?: unknown }).error;
      if (error === 'org_deleted') return { status: 'deleted' };
      if (error === 'unknown_organization') return { status: 'unconfirmed' };
      return null;
    }
    if (!response.ok) return null;
    const body = await response.json() as { standing?: unknown; members?: unknown };
    if (!Array.isArray(body.members)) return null;
    // A standing the platform doesn't give (one from before it did) is active; anything else it gives is not.
    const active = (standing: unknown) => standing === undefined || standing === 'active';
    const members = new Map<string, MemberNow>();
    for (const item of body.members) {
      const entry = item as { id?: unknown; status?: unknown; appRole?: unknown; permissions?: unknown; standing?: unknown };
      if (typeof entry.id !== 'string' || !ids.includes(entry.id) || typeof entry.status !== 'string') continue;
      members.set(entry.id, entry.status !== 'member' ? { status: 'away' } : {
        status: 'member',
        ...(typeof entry.appRole === 'string' ? { role: entry.appRole } : {}),
        ...(Array.isArray(entry.permissions) ? { permissions: entry.permissions.filter((key): key is string => typeof key === 'string') } : {}),
        active: active(entry.standing),
      });
    }
    return { status: 'answered', active: active(body.standing), members };
  } catch {
    return null;
  }
}
