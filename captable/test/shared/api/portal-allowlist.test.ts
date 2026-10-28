import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { capTableResponseSchema } from "../../../src/app/shared/api/holdings.ts";
import { SECURITY_STATUSES } from "../../../src/app/shared/api/enums.ts";
import { orgSchema } from "../../../src/app/shared/api/orgs.ts";
import {
  findForbiddenKeys,
  findForbiddenSchemaKeys,
  findForeignIds,
  findNonStrictObjects,
  PORTAL_FORBIDDEN_KEY_PATTERN,
} from "../../../src/app/shared/api/portal/allowlist.ts";
import * as portal from "../../../src/app/shared/api/portal/schemas.ts";
import { ROUTE_TABLE, routes } from "../../../src/app/shared/api/routes.ts";
import { DANA_VISIBLE_IDS } from "./endpoint-examples.ts";
import { OTHER_STAKEHOLDER_ID, portalOverview, portalSecurity, portalSecurityDetail } from "./fixtures.ts";

// The portal allowlist contract test: every schema in src/api/portal is a
// strict object all the way down, carries no key naming percentages, ownership, fully diluted figures or org totals,
// and every holder route answers only with them. The Worker's recursive response test reuses the same helpers.

const isSchema = (value: unknown): value is z.ZodType => typeof value === "object" && value !== null && "_zod" in value;
const PORTAL_SCHEMAS = Object.entries(portal).filter(([, value]) => isSchema(value)) as [string, z.ZodType][];

describe("portal allowlist schemas", () => {
  it("include every portal response", () => {
    expect(PORTAL_SCHEMAS.map(([name]) => name)).toEqual(
      expect.arrayContaining(["portalOverviewSchema", "portalSecuritySchema", "portalSecurityDetailSchema", "portalDocumentListSchema", "howToExerciseSchema"]),
    );
  });

  it.each(PORTAL_SCHEMAS)("%s is strict all the way down", (_name, schema) => {
    expect(findNonStrictObjects(schema)).toEqual([]);
  });

  it.each(PORTAL_SCHEMAS)("%s names no percentage, ownership, fully diluted or org-total key", (_name, schema) => {
    expect(findForbiddenSchemaKeys(schema)).toEqual([]);
  });

  it("refuse an unexpected key at any depth, so a leak fails the request instead of reaching a holder", () => {
    const security = portalOverview.holdings[0]!.securities[0]!;
    const leaks = [
      { ...portalOverview, orgTotals: { fullyDiluted: "24000000" } },
      { ...portalOverview, holdings: [{ ...portalOverview.holdings[0], otherHolders: [] }] },
      { ...portalOverview, holdings: [{ ...portalOverview.holdings[0], securities: [{ ...security, fullyDilutedPct: "1/400" }] }] },
      { ...portalOverview, holdings: [{ ...portalOverview.holdings[0], securities: [{ ...security, numbers: { ...security.numbers, ownership: "1/400" } }] }] },
      { ...portalOverview, holdings: [{ ...portalOverview.holdings[0], securities: [{ ...security, vesting: [{ ...security.vesting[0], pct: "1/4" }] }] }] },
      { ...portalOverview, holdings: [{ ...portalOverview.holdings[0], securities: [{ ...security, documents: [{ ...security.documents[0], holderVisible: true }] }] }] },
    ];
    for (const leak of leaks) expect(portal.portalOverviewSchema.safeParse(leak).success).toBe(false);
    expect(portal.portalOverviewSchema.safeParse(portalOverview).success).toBe(true);
  });

  it("refuse an unexpected key anywhere in a holding's detail, and a detail of another family", () => {
    const detail = portalSecurityDetail.detail;
    const leaks = [
      { ...portalSecurityDetail, detail: { ...detail, poolAvailable: "1000" } },
      { ...portalSecurityDetail, detail: { ...detail, isoSplit: [{ ...detail.isoSplit[0], optioneeTotal: "1" }] } },
      { ...portalSecurityDetail, detail: { ...detail, exercises: [{ ...detail.exercises[0], recordedBy: "admin@example.test" }] } },
      { ...portalSecurityDetail, detail: { ...detail, postTerminationPeriods: [{ ...detail.postTerminationPeriods[0], grantOverride: true }] } },
      { ...portalSecurityDetail, detail: { family: "WARRANT" } },
    ];
    for (const leak of leaks) expect(portal.portalSecurityDetailSchema.safeParse(leak).success).toBe(false);
    expect(portal.portalSecurityDetailSchema.safeParse(portalSecurityDetail).success).toBe(true);
    // The overview's copy carries no detail; the detail route always does.
    expect(portal.portalSecuritySchema.safeParse(portalSecurityDetail).success).toBe(false);
    expect(portal.portalSecurityDetailSchema.safeParse(portalSecurity).success).toBe(false);
  });

  it("never show a retracted security", () => {
    const statuses = portal.portalSecuritySchema.shape.status.options;
    expect([...statuses]).toEqual(SECURITY_STATUSES.filter((status) => status !== "RETRACTED"));
    expect(portal.portalSecuritySchema.safeParse({ ...portalSecurity, status: "RETRACTED" }).success).toBe(false);
  });
});

describe("holder routes", () => {
  const holderRoutes = ROUTE_TABLE.filter((route) => route.path.startsWith("/api/portal/"));

  it("are every /api/portal route and only those", () => {
    expect(holderRoutes.length).toBe(5);
    for (const route of ROUTE_TABLE) expect(route.auth === "holder", route.id).toBe(route.path.startsWith("/api/portal/"));
  });

  it.each(holderRoutes.map((route) => [route.id, route] as const))("%s answers only from allowlist schemas", (_id, route) => {
    if (route.response.kind === "file") return; // a download streams a document the caller may see
    expect(route.response.kind).toBe("json");
    if (route.response.kind !== "json") return;
    expect(findNonStrictObjects(route.response.schema)).toEqual([]);
    expect(findForbiddenSchemaKeys(route.response.schema)).toEqual([]);
  });

  it("Preview as stakeholder returns exactly the holder's payload, page by page", () => {
    expect(routes.previewAsStakeholder.response.schema).toBe(portal.portalOverviewSchema);
    expect(routes.getPortalOverview.response.schema).toBe(portal.portalOverviewSchema);
    expect(routes.previewPortalSecurity.response.schema).toBe(routes.getPortalSecurity.response.schema);
    expect(routes.getPortalSecurity.response.schema).toBe(portal.portalSecurityDetailSchema);
    expect(routes.previewPortalDocuments.response.schema).toBe(routes.listPortalDocuments.response.schema);
    expect(routes.previewHowToExercise.response.schema).toBe(routes.getHowToExercise.response.schema);
  });
});

describe("the release-gate helpers", () => {
  it("find forbidden keys in a JSON response, at any depth", () => {
    expect(findForbiddenKeys(portalOverview)).toEqual([]);
    expect(findForbiddenKeys({ holdings: [{ securities: [{ numbers: { fullyDiluted: "1" } }] }], capTableUrl: "/x" })).toEqual([
      "$.holdings[0].securities[0].numbers.fullyDiluted",
      "$.capTableUrl",
    ]);
    expect(PORTAL_FORBIDDEN_KEY_PATTERN.test("ownershipPercent")).toBe(true);
  });

  it("find ids the caller may not see", () => {
    expect(findForeignIds(portalOverview, DANA_VISIBLE_IDS)).toEqual([]);
    const leaked = { ...portalOverview, holdings: [{ ...portalOverview.holdings[0], stakeholderId: OTHER_STAKEHOLDER_ID }] };
    expect(findForeignIds(leaked, DANA_VISIBLE_IDS)).toEqual(["$.holdings[0].stakeholderId"]);
  });

  it("do flag admin schemas, which carry percentages and strip instead of refusing", () => {
    expect(findForbiddenSchemaKeys(capTableResponseSchema).length).toBeGreaterThan(0);
    expect(findNonStrictObjects(orgSchema)).toContain("$");
  });
});
