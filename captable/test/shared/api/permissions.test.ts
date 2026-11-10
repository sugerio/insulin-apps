import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, rolePermissions, type Permission } from "../../../src/app/shared/api/auth.ts";

// The catalog in package.json (`insulin.permissions`) is what the hosting platform offers for custom roles; it must name
// exactly the permissions the app enforces, each with the least built-in role that has it.

interface CatalogEntry { key: string; label: string; description: string; role: string }
const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { insulin?: { permissions?: CatalogEntry[] } };
const catalog = manifest.insulin?.permissions ?? [];

function leastRole(permission: Permission): string {
  if (rolePermissions("VIEWER").includes(permission)) return "VIEWER";
  return rolePermissions("EDITOR").includes(permission) ? "EDITOR" : "ADMIN";
}

describe("the permission catalog", () => {
  it("names exactly the permissions the app enforces", () => {
    expect(catalog.map((entry) => entry.key).sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(catalog)("$key gives the least built-in role that has it, and plain-language text", (entry) => {
    expect(entry.role).toBe(leastRole(entry.key as Permission));
    expect(entry.label.length).toBeGreaterThan(0);
    expect(entry.label.length).toBeLessThanOrEqual(80);
    expect(entry.description.length).toBeLessThanOrEqual(300);
    expect(entry.description).not.toMatch(/admin_r[ow]|captable\.|portfolio\./);
  });

  it("gives Owner, Admin and Editor everything and User and Viewer their own holdings", () => {
    for (const role of ["OWNER", "ADMIN", "EDITOR"] as const) expect([...rolePermissions(role)].sort()).toEqual([...PERMISSIONS].sort());
    for (const role of ["USER", "VIEWER"] as const) expect(rolePermissions(role)).toEqual(["portfolio.view"]);
  });
});
