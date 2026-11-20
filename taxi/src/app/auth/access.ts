import { rolePermissions, type Me, type Role } from "#shared";

// What the shell says about the person: their name and role. What they may do follows `me.permissions`, which the
// server works out from the role and any custom role; these helpers only read its answer.

const ROLE_LABELS: Record<Role, string> = { OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", USER: "User", VIEWER: "Viewer" };

/** "Custom role" when the organization narrowed the role's permissions, else the role. */
export function roleLabel(me: Me): string {
  const narrowed = rolePermissions(me.role).some((permission) => !me.permissions.includes(permission));
  return narrowed ? "Custom role" : ROLE_LABELS[me.role];
}

export function personName(me: Me): string {
  return me.user.displayName ?? me.user.email ?? "Insulin Apps user";
}
