import { z } from "zod";

// Who may do what. The platform sends the app role (`x-suger-app-role`) and may narrow it with
// `x-suger-app-permissions`; the app decides by permission, never by role name (AGENTS.md, "Access").

export const ROLES = ["OWNER", "ADMIN", "EDITOR", "USER", "VIEWER"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** The permission catalog, as `insulin.permissions` in package.json declares it. */
export const PERMISSIONS = ["personaltax.prepare", "personaltax.view"] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

/** A role's own permissions: Owner, Admin and Editor prepare returns; User and Viewer only see them. */
export function rolePermissions(role: Role): readonly Permission[] {
  return role === "USER" || role === "VIEWER" ? ["personaltax.view"] : PERMISSIONS;
}

/** How a request reached the app: a person in the browser, an AI agent over MCP, or an API client. */
export const accessViaSchema = z.enum(["browser", "mcp", "api"]);
export type AccessVia = z.infer<typeof accessViaSchema>;

export const meSchema = z.strictObject({
  user: z.strictObject({ id: z.string(), email: z.string().nullable(), displayName: z.string().nullable() }),
  role: roleSchema,
  permissions: z.array(permissionSchema),
  accessVia: accessViaSchema,
  /** The local preview, with a stand-in owner and no platform account. */
  preview: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

export const canPrepare = (me: Pick<Me, "permissions">) => me.permissions.includes("personaltax.prepare");
export const canView = (me: Pick<Me, "permissions">) => me.permissions.includes("personaltax.view");
