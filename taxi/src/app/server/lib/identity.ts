import { getCurrentUser } from "@fours/app/server";
import { accessViaSchema, roleSchema, rolePermissions, withIncluded, type AccessVia, type Permission, type Role } from "#shared";
import { readAppEnv } from "#platform";

// Who is calling, from the platform's headers. With `isScheduleTick`, the only code that reads identity headers.

export interface Caller {
  userId: string;
  /** The platform's organization: the tenant every query is scoped by. */
  orgId: string;
  email: string | null;
  name: string | null;
  role: Role;
  /** The role's permissions, narrowed by `x-suger-app-permissions` when the platform sends it. */
  permissions: ReadonlySet<Permission>;
  accessVia: AccessVia;
  /** The local preview's stand-in owner (dev server only, never in a build). */
  preview: boolean;
}

const PREVIEW = {
  userId: "preview-user",
  organizationId: "preview-organization",
  role: "OWNER",
  email: "preview@example.test",
  name: "Preview owner",
} as const;

/**
 * `x-suger-app-permissions` only takes permissions away: the result is the role's own set intersected with the header,
 * so a forged header gains nothing, and then what those include (Prepare returns includes viewing, which every role
 * that prepares has). `x-suger-access-via` absent means the browser (the Insulin console sends neither); a value that
 * isn't one of the three counts as an API client, the most limited channel.
 */
export function readGrant(request: Request, role: Role): { permissions: Set<Permission>; accessVia: AccessVia } {
  const own = rolePermissions(role);
  const header = request.headers.get("x-suger-app-permissions");
  const listed = header === null ? null : new Set(header.split(/[\s,]+/).filter(Boolean));
  const permissions = new Set(withIncluded(listed === null ? own : own.filter((permission) => listed.has(permission))));
  const raw = request.headers.get("x-suger-access-via");
  const via = accessViaSchema.safeParse(raw?.trim().toLowerCase());
  return { permissions, accessVia: raw === null ? "browser" : via.success ? via.data : "api" };
}

const IDENTITY_HEADERS = [
  "x-suger-user-id",
  "x-suger-organization-id",
  "x-suger-app-role",
  "x-suger-app-permissions",
  "x-suger-user-email",
  "x-suger-user-name",
];

/**
 * The platform's five-minute tick: `x-suger-access-via` exactly `schedule` and no identity at all. The gateway strips
 * every incoming `x-suger-*` header, so only its own tick can send one.
 */
export function isScheduleTick(request: Request): boolean {
  if (request.headers.get("x-suger-access-via") !== "schedule") return false;
  return IDENTITY_HEADERS.every((name) => !request.headers.has(name)) && getCurrentUser(request) === null;
}

/** The caller, or null: no identity, or a request marked `schedule` (nobody, on every route but the tick's). */
export function readCaller(request: Request): Caller | null {
  if (request.headers.get("x-suger-access-via")?.trim().toLowerCase() === "schedule") return null;
  const user = getCurrentUser(request);
  const preview = user === null && import.meta.env.DEV && readAppEnv("SUGER_ACCESS_MODE") !== "console";
  const current = user ?? (preview ? PREVIEW : null);
  if (!current) return null;
  if (current.userId.length < 3 || current.userId.length > 80) return null;
  if (current.organizationId.length < 1 || current.organizationId.length > 128) return null;
  // The console may still send OWNER and USER; both are known roles here.
  const role = roleSchema.safeParse(current.role);
  if (!role.success) return null;
  const grant = readGrant(request, role.data);
  return {
    userId: current.userId,
    orgId: current.organizationId,
    email: current.email ?? null,
    name: current.name?.slice(0, 200) ?? null,
    role: role.data,
    permissions: grant.permissions,
    accessVia: grant.accessVia,
    preview,
  };
}
