import { api } from "#shared";

type Me = api.MeResponse;
type ConsoleRole = Me["consoleRole"];

// What someone may do here follows their effective permissions, which the server works out from the console role and
// any custom role (`me.permissions`, `me.access`): recording changes, viewing the whole cap table, or seeing their own
// holdings. These helpers only read the server's answer.

const ROLE_LABELS: Record<ConsoleRole, string> = { OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", USER: "User", VIEWER: "Viewer" };

/** Everyone who administers the company: the workspace (read only without "Record changes"). */
export function hasAdminAccess(me: Me): boolean {
  return me.access === "admin_rw" || me.access === "admin_ro";
}

/** Whoever records changes sets the company up the first time the app opens. */
export function canSetUpCompany(me: Me): boolean {
  return me.permissions.includes("captable.manage");
}

/** Whether a custom role took some of the role's permissions away. */
export function hasCustomRole(me: Me): boolean {
  const own = api.rolePermissions(me.consoleRole);
  return own.some((permission) => !me.permissions.includes(permission));
}

/** What the header shows under the person's name: the role, or "Custom role" when the organization narrowed it. */
export function roleLabel(me: Me): string {
  return hasCustomRole(me) ? "Custom role" : ROLE_LABELS[me.consoleRole];
}

/** The name to greet someone by: the console's display name, else their e-mail. */
export function personName(me: Me): string {
  return me.user.displayName ?? me.user.email ?? "Console user";
}
