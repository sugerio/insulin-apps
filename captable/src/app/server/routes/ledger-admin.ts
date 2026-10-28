import { api } from "#shared";
import { Hono, type Context } from "hono";
import { insertAudit } from "../lib/audit.ts";
import { clientIp, notFound, readJson, userAgent } from "../lib/http.ts";
import { conflict } from "../lib/ledger/errors.ts";
import { uuidv7 } from "../lib/ledger/ids.ts";
import { findReceipt, requestSha256 } from "../lib/ledger/run.ts";
import { prepare, receiptInsert } from "../lib/ledger/statements.ts";
import { clearValuationReview, flagMaterialEvent, recordValuation, reverseValuationEvent, voidValuation } from "../lib/ledger/valuations.ts";
import { verifyOrgLedger } from "../lib/ledger/verify.ts";
import { confirmVestingTerms } from "../lib/ledger/vesting-terms.ts";
import { getOrgRow } from "../lib/read/org.ts";
import type { AppDeps, AppEnv } from "../types.ts";
import { commandContext, idempotencyKey, storedResponse } from "./commands.ts";
import { viewerOf } from "./reads.ts";

/**
 * Write routes outside the command catalogue: 409A valuations and their events, the
 * confirmation of a vesting template and on-demand ledger verification.
 * The registration point checks the identity, company and write role before any body is read.
 */

function paramsOf<T>(route: api.AnyRoute, c: Context<AppEnv>): T {
  const parsed = route.params?.safeParse(c.req.param());
  // the API contract: a path segment that doesn't parse is 404, never 400.
  if (!parsed?.success) throw notFound();
  return parsed.data as T;
}

/** Mounted at `/api/orgs/:orgId`. */
export function ledgerWriteRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  const request = (c: Context<AppEnv>, route: api.AnyRoute) => ({ route: `${route.method} ${route.path}`, path: c.req.path, key: idempotencyKey(c, true)! });

  routes.post("/valuations", async (c) => {
    const route = api.routes.recordValuation;
    const body = await readJson(c, api.recordValuationRequestSchema);
    return storedResponse(await recordValuation(await commandContext(c, deps), body, request(c, route)));
  });
  routes.post("/valuations/material-events", async (c) => {
    const route = api.routes.flagMaterialEvent;
    const body = await readJson(c, api.materialEventRequestSchema);
    return storedResponse(await flagMaterialEvent(await commandContext(c, deps), body, request(c, route)));
  });
  routes.post("/valuations/:id/review-cleared", async (c) => {
    const route = api.routes.clearValuationReview;
    const params = paramsOf<{ id: string }>(route, c);
    const body = await readJson(c, api.reviewClearedRequestSchema);
    return storedResponse(await clearValuationReview(await commandContext(c, deps), params.id, body, request(c, route)));
  });
  routes.post("/valuations/:id/events/:eventId/reverse", async (c) => {
    const route = api.routes.reverseValuationEvent;
    const params = paramsOf<{ id: string; eventId: string }>(route, c);
    const body = await readJson(c, api.reverseValuationEventRequestSchema);
    return storedResponse(await reverseValuationEvent(await commandContext(c, deps), params.id, params.eventId, body, request(c, route)));
  });
  routes.post("/valuations/:id/void", async (c) => {
    const route = api.routes.voidValuation;
    const params = paramsOf<{ id: string }>(route, c);
    const body = await readJson(c, api.voidValuationRequestSchema);
    return storedResponse(await voidValuation(await commandContext(c, deps), params.id, body, request(c, route)));
  });
  routes.post("/vesting-terms/:id/confirm", async (c) => {
    const route = api.routes.confirmVestingTerms;
    const params = paramsOf<{ id: string }>(route, c);
    const body = await readJson(c, api.emptyRequestSchema);
    return storedResponse(await confirmVestingTerms(await commandContext(c, deps), viewerOf(c), params.id, body as Record<string, never>, request(c, route)));
  });
  return routes;
}

/** Mounted at `/api/admin`: owners/admins can run shared ledger verification on demand. */
export function ledgerAdminRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  routes.post("/orgs/:orgId/verify-ledger", async (c) => {
    const route = api.routes.verifyLedger;
    const { orgId } = paramsOf<{ orgId: string }>(route, c);
    const key = idempotencyKey(c, true)!;
    const auth = c.get("auth");
    const db = c.env.DB;
    const template = `${route.method} ${route.path}`;
    const hash = requestSha256(template, c.req.path, {});
    const replay = async () => {
      const receipt = await findReceipt(db, orgId, auth.user.id, template, key);
      if (!receipt) return null;
      if (receipt.request_sha256 !== hash) throw conflict("idempotency_key_reused", "Idempotency-Key was already used for a different request");
      return storedResponse({ status: receipt.response_status, body: JSON.parse(receipt.response_body), replay: true });
    };
    const prior = await replay();
    if (prior) return prior;
    if (!await getOrgRow(db, orgId)) throw notFound("Organization not found");
    const now = deps.now();
    const { report } = await verifyOrgLedger(db, orgId, now);
    try {
      await db.batch([
        prepare(db, receiptInsert({ id: uuidv7(now), scope: orgId, actor: auth.user.id, route: template, key, requestSha256: hash, status: 200, body: JSON.stringify(report), now })),
        insertAudit(db, {
          occurredAt: now, orgId, actorUserId: auth.user.id, actorEmail: auth.user.email, authMethod: auth.authMethod,
          action: "ledger.verified", targetType: "org", targetId: orgId, result: report.ok ? "success" : "error",
          ip: clientIp(c), userAgent: userAgent(c), requestId: c.req.header("CF-Ray") ?? null,
          details: { ok: report.ok, ledgerSeq: report.ledgerSeq, failed: report.checks.filter((check) => !check.ok).map((check) => check.name) },
        }),
      ]);
    } catch (error) {
      // A concurrent first request with the same key stored its report first: answer with it.
      const raced = await replay();
      if (raced) return raced;
      throw error;
    }
    return c.json(report, 200);
  });
  return routes;
}
