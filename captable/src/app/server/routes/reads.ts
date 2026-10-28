import { api } from "#shared";
import { Hono, type Context } from "hono";
import { ApiError, log, notFound, readJson } from "../lib/http.ts";
import { DASHBOARD_AUTOMATIC_EXPIRY_LIMIT, hasDueWork, processDue } from "../lib/ledger/daily.ts";
import { loadReadContext, replayed, type Viewer } from "../lib/read/context.ts";
import { READ_HANDLERS, responseSchemaOf, type ReadHandler } from "../lib/read/handlers.ts";
import { orgDetail, orgList } from "../lib/read/orgs.ts";
import { howToExercise, portalOverview, portalSecurity } from "../lib/read/portal.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/**
 * The read endpoints (the API contract): every handler answers from the replayed ledger through one redaction
 * layer, and its answer is checked against the contract's response schema before it leaves, so a field the contract
 * doesn't name fails the request instead of reaching the browser.
 */

const ORG_PREFIX = "/api/orgs/:orgId";

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function parseParams(route: api.AnyRoute, c: Context<AppEnv>): Record<string, string> {
  if (route.params === null) return {};
  const parsed = route.params.safeParse(c.req.param());
  // the API contract: a path segment that doesn't parse is 404, never 400.
  if (!parsed.success) throw notFound();
  return parsed.data as Record<string, string>;
}

function parseQuery(route: api.AnyRoute, c: Context<AppEnv>): Record<string, unknown> {
  if (route.query === null) return {};
  const parsed = route.query.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError("validation_failed", "Some query parameters are invalid", issuesOf(parsed.error));
  return parsed.data as Record<string, unknown>;
}

/** Fails closed: an answer outside its schema is a bug, logged by path only (never the values, which may be personal). */
function checked<T>(routeId: string, value: unknown): T {
  const parsed = responseSchemaOf(routeId).safeParse(value);
  if (!parsed.success) {
    log("read_response_invalid", { routeId, paths: parsed.error.issues.slice(0, 5).map((issue) => issue.path.map(String).join(".")) });
    throw new ApiError("internal", "Something went wrong");
  }
  return parsed.data as T;
}

export function viewerOf(c: Context<AppEnv>): Viewer {
  const auth = c.get("auth");
  const org = c.get("org");
  return { access: org.access, fullAccess: auth.fullAccess, pii: org.pii, userId: auth.user.id, email: auth.user.email };
}

/** Org-scoped admin reads, mounted at `/api/orgs/:orgId` in the contract's order (literal paths before parameters). */
export function readRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  for (const route of api.ROUTE_TABLE) {
    const handler: ReadHandler | undefined = READ_HANDLERS[route.id];
    if (!handler || !route.path.startsWith(`${ORG_PREFIX}/`)) continue;
    const path = route.path.slice(ORG_PREFIX.length);
    const serve = async (c: Context<AppEnv>) => {
      const params = parseParams(route, c);
      const query = parseQuery(route, c);
      const body = route.body.kind === "json" ? await readJson(c, route.body.schema, route.body.maxBytes) : undefined;
      const now = deps.now();
      let ctx = await loadReadContext(c.env.DB, c.get("config"), c.get("org").id, viewerOf(c), now);
      if (route.id === "getDashboard" && c.get("org").access === "admin_rw") {
        const org = c.get("org");
        const state = replayed(ctx, { asOf: ctx.today, asKnownAt: null });
        if (await hasDueWork(c.env.DB, org.id, ctx.today, state)) {
          await processDue(c.env.DB, c.get("config"), org.id, org.timezone, now, {
            automaticExpiryLimit: DASHBOARD_AUTOMATIC_EXPIRY_LIMIT,
          });
          ctx = await loadReadContext(c.env.DB, c.get("config"), org.id, viewerOf(c), now);
        }
      }
      return c.json(checked(route.id, await handler(ctx, { params, query, body })));
    };
    if (route.method === "GET") routes.get(path, serve);
    else if (route.method === "POST") routes.post(path, serve);
    else throw new Error(`Read route ${route.id} has method ${route.method}`);
  }
  return routes;
}

/** `GET /api/orgs` and `GET /api/orgs/:orgId` (the API contract), mounted at `/api/orgs`. */
export function orgRoutes() {
  const routes = new Hono<AppEnv>();
  routes.get("/", async (c) => {
    const auth = c.get("auth");
    return c.json(checked("listOrgs", await orgList(c.env.DB, auth.orgAccess)));
  });
  routes.get("/:orgId", async (c) => {
    const org = c.get("org");
    return c.json(checked("getOrg", await orgDetail(c.env.DB, org.id, org.pii)));
  });
  return routes;
}

/**
 * The holder portal's ledger reads (the API contract), mounted at `/api/portal`. The registration point has already
 * answered 404 to a caller without a holder match or asking about another org; these answer only from the caller's
 * own matched records and through the strict allowlist schemas.
 */
export function portalRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  const enabled = (c: Context<AppEnv>) => {
    if (!c.get("config").portalEnabled) throw notFound();
  };
  routes.get("/overview", async (c) => {
    enabled(c);
    const query = parseQuery(api.routes.getPortalOverview, c) as { asOf?: string };
    return c.json(checked("getPortalOverview", await portalOverview(c.env.DB, c.get("config"), c.get("auth").portalMatches, query, deps.now())));
  });
  routes.get("/orgs/:orgId/securities/:id", async (c) => {
    enabled(c);
    const params = parseParams(api.routes.getPortalSecurity, c);
    const query = parseQuery(api.routes.getPortalSecurity, c) as { asOf?: string };
    return c.json(checked("getPortalSecurity", await portalSecurity(c.env.DB, c.get("config"), c.get("auth").portalMatches, params.orgId!, params.id!, query, deps.now())));
  });
  routes.get("/orgs/:orgId/how-to-exercise", async (c) => {
    enabled(c);
    const params = parseParams(api.routes.getHowToExercise, c);
    return c.json(checked("getHowToExercise", await howToExercise(c.env.DB, c.get("config"), c.get("auth").portalMatches, params.orgId!, deps.now())));
  });
  return routes;
}
