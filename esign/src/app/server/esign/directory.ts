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
 * requests carry them, permissions in it, and whether the account and the organization are active; or no longer
 * (`away`: a person who left or lost Esign, a revoked or deleted API client, or the organization deleted); or nothing
 * yet (`unconfirmed`: the platform has no record that Esign is used in the organization, which it makes at the next
 * request to Esign there, DESIGN.md §8.9).
 */
export type MemberNow =
  | { status: 'member'; role?: string; permissions?: string[]; active: boolean; orgActive: boolean }
  | { status: 'away' }
  | { status: 'unconfirmed' };

/**
 * One person's or API client's standing in Esign in the organization, by id (POST SUGER_MEMBER_STATUS_URL): null when
 * the platform can't be asked or didn't answer as agreed.
 */
export async function memberNow(env: DirectoryEnv, organizationId: string, id: string): Promise<MemberNow | null> {
  const endpoint = gatewayEndpoint(env.SUGER_MEMBER_STATUS_URL, env.SUGER_APP_TOKEN);
  if (!endpoint) return null;
  try {
    const response = await (env.MEMBERS_FETCH ?? fetch)(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ org: organizationId, ids: [id] }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      const error = (await response.json().catch(() => ({})) as { error?: unknown }).error;
      if (error === 'org_deleted') return { status: 'away' };
      if (error === 'unknown_organization') return { status: 'unconfirmed' };
      return null;
    }
    if (!response.ok) return null;
    const body = await response.json() as { standing?: unknown; members?: unknown };
    if (!Array.isArray(body.members)) return null;
    const entry = body.members.find((item) => (item as { id?: unknown })?.id === id) as { status?: unknown; appRole?: unknown; permissions?: unknown; standing?: unknown } | undefined;
    if (!entry || typeof entry.status !== 'string') return null;
    if (entry.status !== 'member') return { status: 'away' };
    // A standing the platform doesn't give (one from before it did) is active; anything else it gives is not.
    const active = (standing: unknown) => standing === undefined || standing === 'active';
    return {
      status: 'member',
      ...(typeof entry.appRole === 'string' ? { role: entry.appRole } : {}),
      ...(Array.isArray(entry.permissions) ? { permissions: entry.permissions.filter((key): key is string => typeof key === 'string') } : {}),
      active: active(entry.standing),
      orgActive: active(body.standing),
    };
  } catch {
    return null;
  }
}
