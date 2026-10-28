import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApiRequest, RouteRequest, RouteResult } from "../../../src/app/shared/api/client.ts";
import type { CommandResult } from "../../../src/app/shared/api/commands.ts";
import type { DocumentKind } from "../../../src/app/shared/api/enums.ts";
import type { CapTableResponse } from "../../../src/app/shared/api/holdings.ts";
import type { MeResponse } from "../../../src/app/shared/api/auth.ts";
import type { PortalDocumentList } from "../../../src/app/shared/api/portal/schemas.ts";
import { type ParamName, routes } from "../../../src/app/shared/api/routes.ts";

// Compile-time checks of the typed client helper: `pnpm typecheck` fails if a route's request or result type drifts.
// The assignments below run too, but only the types matter.

const ORG = "aced0001-face-4bad-8cab-dead0001beef";

describe("client types", () => {
  it("derive path parameter names from the pattern", () => {
    expectTypeOf<ParamName<"/api/orgs/:orgId/stakeholders/:id/emails/:emailId/remove">>().toEqualTypeOf<"orgId" | "id" | "emailId">();
    expectTypeOf<ParamName<"/api/orgs/:orgId">>().toEqualTypeOf<"orgId">();
    expectTypeOf<ParamName<"/api/me">>().toEqualTypeOf<never>();
  });

  it("type reads: parameters, optional queries and results", () => {
    expectTypeOf<RouteRequest<typeof routes.getStakeholder>["params"]>().toEqualTypeOf<{ orgId: string; id: string }>();
    expectTypeOf<RouteRequest<typeof routes.runReport>["params"]["reportKey"]>().toEqualTypeOf<
      "cap-table" | "raw-cap-table" | "stakeholders" | "vesting-details" | "exercise-history" | "audit-log"
    >();
    expectTypeOf<RouteResult<typeof routes.getMe>>().toEqualTypeOf<MeResponse>();
    expectTypeOf<RouteResult<typeof routes.getCapTable>>().toEqualTypeOf<CapTableResponse>();
    expectTypeOf<RouteResult<typeof routes.listPortalDocuments>>().toEqualTypeOf<PortalDocumentList>();
    expectTypeOf<RouteResult<typeof routes.downloadDocument>>().toEqualTypeOf<Response>();

    const list: RouteRequest<typeof routes.listStakeholders> = { params: { orgId: ORG } };
    // @ts-expect-error the FMV query needs its date
    const fmv: RouteRequest<typeof routes.getFmv> = { params: { orgId: ORG } };
    expect([list, fmv]).toHaveLength(2);
  });

  it("type commands with and without a dry run", () => {
    const minimal = { stakeholderId: ORG, terminationDate: "2026-12-04", terminationType: "voluntary" } as const;
    const dryRun: RouteRequest<typeof routes.terminateStakeholder> = { params: { orgId: ORG }, dryRun: true, body: minimal };
    const real: RouteRequest<typeof routes.terminateStakeholder> = {
      params: { orgId: ORG },
      body: { ...minimal, expectedLedgerSeq: 412, expectedDiffSha256: "ab".repeat(32) },
      idempotencyKey: "6f7e0c1a-7b51-4d0e-9c7a-0e5e0f2b3c4d",
    };
    // @ts-expect-error a real call sends back the reviewed ledger seq and diff
    const unguarded: RouteRequest<typeof routes.terminateStakeholder> = { params: { orgId: ORG }, body: minimal };
    // @ts-expect-error reverse-command has no dry run
    const reverseDryRun: RouteRequest<typeof routes.reverseCommand> = { params: { orgId: ORG }, dryRun: true, body: {} };
    expectTypeOf<RouteResult<typeof routes.terminateStakeholder>>().toEqualTypeOf<CommandResult>();
    expect([dryRun, real, unguarded, reverseDryRun]).toHaveLength(4);
  });

  it("type raw uploads by their headers, with the Idempotency-Key only on the request", () => {
    expectTypeOf<RouteRequest<typeof routes.uploadDocument>["headers"]["x-document-kind"]>().toEqualTypeOf<DocumentKind>();
    expectTypeOf<RouteRequest<typeof routes.uploadDocument>["body"]>().toEqualTypeOf<Blob | ArrayBuffer | Uint8Array>();
    const headers = {
      "content-type": "application/pdf",
      "x-filename": "OPT-7%20grant%20agreement.pdf",
      "x-document-kind": "GRANT_AGREEMENT",
      "x-content-sha256": "ab".repeat(32),
    } as const;
    const upload: RouteRequest<typeof routes.uploadDocument> = {
      params: { orgId: ORG },
      body: new Uint8Array(1),
      headers,
      idempotencyKey: "6f7e0c1a-7b51-4d0e-9c7a-0e5e0f2b3c4d",
    };
    const twoKeys: RouteRequest<typeof routes.uploadDocument> = {
      params: { orgId: ORG },
      body: new Uint8Array(1),
      // @ts-expect-error the key is the request's idempotencyKey, never a body header
      headers: { ...headers, "idempotency-key": "6f7e0c1a-7b51-4d0e-9c7a-0e5e0f2b3c4d" },
    };
    expect([upload, twoKeys]).toHaveLength(2);
  });

  it("let one ApiRequest serve every route", () => {
    const request: ApiRequest = async () => {
      throw new Error("types only");
    };
    expectTypeOf(request<typeof routes.getMe>).returns.resolves.toEqualTypeOf<MeResponse>();
    expectTypeOf(request<typeof routes.getStakeholder>).parameter(1).toHaveProperty("params").toEqualTypeOf<{ orgId: string; id: string }>();
  });
});
