import { getCurrentUser, type AppRole } from '@fours/app/server';

/**
 * Who calls a management route: the Insulin platform's identity (`getCurrentUser`) and, read here and
 * nowhere else, the two headers the hosting gateway adds to it. The organization is the tenant.
 *
 * - `x-suger-app-permissions` (space-separated) can only take permissions away: the result is the
 *   role's own set intersected with the header, unknown keys ignored, so a forged header gains
 *   nothing the role didn't give. Without the header (the Insulin console) the role decides.
 * - `x-suger-access-via`: a person in the browser, an AI agent (`mcp`), an API client (`api`),
 *   `public` for the signer pages the gateway forwards without an identity, or `schedule` for the
 *   platform's five-minute tick. A public or scheduled request never reaches a management route,
 *   whatever else it carries; the tick reaches `POST /api/scheduled` only (`isScheduleTick`).
 */
export const PERMISSIONS = ['esign.manage', 'esign.view'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type AccessVia = 'browser' | 'mcp' | 'api';

/** OWNER, ADMIN and EDITOR send and manage envelopes; USER and VIEWER see them. */
export function rolePermissions(role: AppRole): Permission[] {
  return role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR' ? ['esign.manage', 'esign.view'] : ['esign.view'];
}

export interface Caller {
  userId: string;
  /** The Insulin organization: the tenant every record belongs to. */
  organizationId: string;
  email: string | null;
  name: string | null;
  role: AppRole;
  permissions: ReadonlySet<Permission>;
  accessVia: AccessVia;
  preview: boolean;
}

/** The stand-in owner of the local preview, when the app runs without a console identity. */
const PREVIEW = { userId: 'preview-user', organizationId: 'preview-organization', role: 'OWNER' as const, email: 'preview@example.test', name: 'Preview owner' };

/** `can('esign.view')` is also true for someone who may manage: managing includes viewing. */
export const can = (caller: Caller, permission: Permission): boolean =>
  caller.permissions.has(permission) || (permission === 'esign.view' && caller.permissions.has('esign.manage'));

/**
 * The caller of a management route, or null: a public request, no identity, or an identity the
 * platform contract doesn't recognise. `preview` allows the local preview's stand-in owner.
 */
export function readCaller(request: Request, preview: boolean): Caller | null {
  const via = request.headers.get('x-suger-access-via')?.trim().toLowerCase();
  if (via === 'public' || via === 'schedule') return null;
  const user = getCurrentUser(request);
  const current = user ?? (preview ? PREVIEW : null);
  if (!current || !current.userId || !current.organizationId || current.organizationId.length > 128) return null;
  const own = rolePermissions(current.role);
  const header = user ? request.headers.get('x-suger-app-permissions') : null;
  const listed = header === null ? null : new Set(header.split(/[\s,]+/).filter(Boolean));
  const permissions = new Set(listed === null ? own : own.filter((permission) => listed.has(permission)));
  // Absent (the Insulin console) means the browser; anything unrecognised counts as an API client.
  const accessVia: AccessVia = via === undefined || via === 'browser' ? 'browser' : via === 'mcp' ? 'mcp' : 'api';
  return {
    userId: current.userId,
    organizationId: current.organizationId,
    email: current.email,
    name: current.name,
    role: current.role,
    permissions,
    accessVia,
    preview: !user,
  };
}

/** The headers that carry a person, an organization, a role or permissions: the tick carries none of them. */
const IDENTITY_HEADERS = ['x-suger-user-id', 'x-suger-organization-id', 'x-suger-app-role', 'x-suger-app-permissions', 'x-suger-user-email', 'x-suger-user-name'];

/**
 * Whether a request is the platform's own tick (package.json `insulin.scheduled`): `x-suger-access-via`
 * exactly `schedule`, and no identity at all. The gateway removes every incoming `x-suger-*` header and
 * app Workers have no public route, so only the gateway's tick can send one; a member, a service
 * account or an agent never passes, whatever it sends.
 */
export function isScheduleTick(request: Request): boolean {
  if (request.headers.get('x-suger-access-via') !== 'schedule') return false;
  return IDENTITY_HEADERS.every((name) => !request.headers.has(name)) && getCurrentUser(request) === null;
}
