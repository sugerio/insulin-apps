import type { api } from "#shared";

type Me = api.MeResponse;
type ConsoleRole = Me["consoleRole"];

// What the console role lets someone do here: OWNER and ADMIN manage the cap table, EDITOR views it, USER and VIEWER see
// their own holdings. The server decides (`me.access`); these helpers only read its answer.

const ROLE_LABELS: Record<ConsoleRole, string> = { OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", USER: "User", VIEWER: "Viewer" };

/** Admins and editors: the company workspace (editors read only). */
export function hasAdminAccess(me: Me): boolean {
  return me.access === "admin_rw" || me.access === "admin_ro";
}

/** Owners and admins set the company up the first time the app opens. */
export function canSetUpCompany(me: Me): boolean {
  return me.consoleRole === "OWNER" || me.consoleRole === "ADMIN";
}

/** What the header shows under the person's name. */
export function roleLabel(me: Me): string {
  return ROLE_LABELS[me.consoleRole];
}

/** The name to greet someone by: the console's display name, else their e-mail. */
export function personName(me: Me): string {
  return me.user.displayName ?? me.user.email ?? "Console user";
}
