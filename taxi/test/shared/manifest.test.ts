import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { PERMISSIONS, rolePermissions } from "#shared";
import { NAVIGATION, navigationFor } from "../../src/app/lib/navigation.ts";

describe("the package.json manifest", () => {
  it("declares exactly the permissions the server checks, each with the least role that has it", () => {
    const declared = packageJson.insulin.permissions.map((permission) => permission.key);
    expect(declared).toEqual([...PERMISSIONS]);
    for (const permission of packageJson.insulin.permissions) {
      const least = permission.role as "EDITOR" | "VIEWER";
      expect(rolePermissions(least)).toContain(permission.key);
    }
    expect(rolePermissions("VIEWER")).not.toContain("taxi.prepare");
  });

  it("has a navigation every role sees, with Returns and Profile", () => {
    expect(NAVIGATION.map((item) => item.path)).toEqual(["/returns", "/profile"]);
    expect(navigationFor(NAVIGATION, "VIEWER")).toHaveLength(2);
  });
});
