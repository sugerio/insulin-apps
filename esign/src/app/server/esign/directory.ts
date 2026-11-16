// Who in the organization can use Esign, as the platform says (its gateway's GET /__insulin/members, DESIGN.md §8.7):
// Esign keeps no directory of its own, and people it hasn't seen yet can still be picked, while people the
// organization removed or took Esign from are not. Asked with the app's token (SUGER_APP_TOKEN) over the gateway's
// service binding. Without the endpoint (the local preview, tests) or when it fails, callers fall back on the people
// Esign has seen (members.ts).
import { gatewayEndpoint } from '../gateway-fetch.ts';

export type DirectoryEnv = {
  SUGER_MEMBERS_URL?: string;
  SUGER_APP_TOKEN?: string;
  /** The fetch the gateway is called with: its service binding (router.ts), or tests' own. */
  MEMBERS_FETCH?: typeof fetch;
};

/** Someone who can use Esign: their id (the x-suger-user-id their requests carry), name and email. */
export type DirectoryMember = { id: string; name?: string; email: string };

/**
 * The organization's people who can use Esign, whose name or email contains `q` when given, at most `limit`; null when
 * the platform can't be asked (no endpoint) or didn't answer as agreed.
 */
export async function directoryMembers(env: DirectoryEnv, organizationId: string, { q = '', limit = 500 }: { q?: string; limit?: number } = {}): Promise<DirectoryMember[] | null> {
  const endpoint = gatewayEndpoint(env.SUGER_MEMBERS_URL, env.SUGER_APP_TOKEN);
  if (!endpoint) return null;
  const url = new URL(endpoint.url);
  if (q) url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  try {
    const response = await (env.MEMBERS_FETCH ?? fetch)(url.href, {
      headers: { authorization: `Bearer ${endpoint.token}`, 'x-suger-organization-id': organizationId },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { members?: unknown };
    if (!Array.isArray(body.members)) return null;
    return body.members.flatMap((item): DirectoryMember[] => {
      const m = item as { id?: unknown; name?: unknown; email?: unknown };
      if (typeof m.id !== 'string' || typeof m.email !== 'string' || !m.email.includes('@')) return [];
      return [{ id: m.id, email: m.email, ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim() } : {}) }];
    });
  } catch {
    return null;
  }
}
