import { Hono, type Context } from "hono";
import { z } from "zod";
import { ROUTE_TABLE, SUPPORTED_YEARS, routes, type AnyRoute, type ApiCatalog, type Me } from "#shared";
import * as household from "./lib/household.ts";
import { ApiError, forbidden, logError, notFound, parseOr400, readJson } from "./lib/http.ts";
import { isScheduleTick, readCaller, type Caller } from "./lib/identity.ts";
import { reportUsage, type MetricsEnv } from "./lib/usage-metrics.ts";
import { requireSameOrigin } from "./middleware/same-origin.ts";
import { securityHeaders } from "./middleware/security-headers.ts";

export type AppEnv = {
  /** The D1 database, and where the hourly usage report goes (router.ts): absent in the local preview and in tests. */
  Bindings: { DB: D1Database } & MetricsEnv;
  Variables: { caller: Caller; origin: string };
};

export interface AppOptions {
  now?: () => number;
  /** The same-origin check on writes; off only in the dev server, where the console preview's origin differs. */
  enforceSameOrigin?: boolean;
}

/** What a route's handler gets: the caller, its parsed params and body, the database and the time. */
interface Call<R extends AnyRoute> {
  caller: Caller;
  params: R["params"] extends z.ZodType ? z.infer<R["params"]> : Record<string, never>;
  body: R["body"] extends z.ZodType ? z.infer<R["body"]> : undefined;
  db: D1Database;
  now: number;
}
type Answer<R extends AnyRoute> = R["response"] extends z.ZodType ? z.infer<R["response"]> | { status: 201; body: z.infer<R["response"]> } : void;

export function createApp(options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders());
  app.use("*", async (c, next) => {
    c.set("origin", new URL(c.req.url).origin);
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true, service: "personal-tax" }));

  // The platform's tick, every five minutes (package.json `insulin.scheduled`): the hourly usage report, sent by the
  // first tick of each hour. It carries no identity and no Origin, so it comes before both checks, and it is never in
  // the catalog.
  app.post("/api/scheduled", async (c) => {
    if (!isScheduleTick(c.req.raw)) throw forbidden("Only the platform can call this");
    return c.json({ metrics: await reportUsage(c.env.DB, c.env, now()) });
  });

  if (options.enforceSameOrigin ?? !import.meta.env.DEV) app.use("/api/*", requireSameOrigin());
  app.use("/api/*", async (c, next) => {
    const caller = readCaller(c.req.raw);
    if (!caller) return c.json({ error: { code: "unauthenticated", message: "Open this app from Insulin Apps" } }, 401);
    c.set("caller", caller);
    await next();
  });

  /** Mounts a route of the table: its permission, its params and body checked, its answer checked against the contract. */
  function mount<R extends AnyRoute>(route: R, handle: (call: Call<R>) => Promise<Answer<R>>) {
    app.on(route.method, route.path, async (c: Context<AppEnv>) => {
      const caller = c.get("caller");
      if (route.permission && !caller.permissions.has(route.permission)) {
        throw forbidden(route.permission === "personaltax.prepare" ? "Your role can view returns but not change them" : undefined);
      }
      // A path param that fails its schema names nothing that exists.
      const params = route.params ? (route.params as z.ZodType).safeParse(c.req.param()) : null;
      if (params && !params.success) throw notFound();
      const body = route.body ? parseOr400(route.body as z.ZodType, await readJson(c.req.raw), "request body") : undefined;
      const answer = await handle({ caller, params: params?.data ?? {}, body, db: c.env.DB, now: now() } as Call<R>);
      if (route.response === null) return c.body(null, 204);
      const created = typeof answer === "object" && answer !== null && "status" in answer && answer.status === 201;
      const payload = (route.response as z.ZodType).parse(created ? (answer as { body: unknown }).body : answer);
      return c.json(payload, created ? 201 : 200);
    });
  }

  mount(routes.getMe, async ({ caller }) => meOf(caller));
  mount(routes.getCatalog, async ({ caller }) => catalogFor(caller));
  mount(routes.listYears, async ({ caller, db }) => household.listYears(db, caller.orgId, SUPPORTED_YEARS));
  mount(routes.startYear, async ({ caller, body, db, now }) => {
    const { view, created } = await household.startYear(db, caller, body.year, now);
    return created ? { status: 201, body: view } : view;
  });
  mount(routes.getYear, async ({ caller, params, db }) => household.getYear(db, caller.orgId, params.year));
  mount(routes.saveHousehold, async ({ caller, params, body, db, now }) => household.saveHousehold(db, caller, params.year, body, now));
  mount(routes.addPerson, async ({ caller, body, db, now }) => ({ status: 201, body: await household.addPerson(db, caller, body, now) }));
  mount(routes.updatePerson, async ({ caller, params, body, db, now }) => household.updatePerson(db, caller, params.id, body, now));
  mount(routes.removePerson, async ({ caller, params, db, now }) => household.removePerson(db, caller, params.id, now));
  app.all("/api/*", () => {
    throw notFound("Unknown API route");
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) return error.toResponse();
    logError("unhandled_error", error, { method: c.req.method, route: c.req.routePath || "unmatched" });
    return new ApiError("internal", "Something went wrong").toResponse();
  });
  return app;
}

function meOf(caller: Caller): Me {
  return {
    user: { id: caller.userId, email: caller.email, displayName: caller.name },
    role: caller.role,
    permissions: [...caller.permissions],
    accessVia: caller.accessVia,
    preview: caller.preview,
  };
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...document } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return document;
}

/** `GET /api/catalog`: only the routes the caller may use, with their bodies as JSON Schema. */
export function catalogFor(caller: Pick<Caller, "permissions">): ApiCatalog {
  return {
    endpoints: ROUTE_TABLE.filter((route) => route.permission === null || caller.permissions.has(route.permission)).map((route) => ({
      method: route.method,
      path: route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}"),
      summary: route.summary,
      query: null,
      body: route.body ? jsonSchemaOf(route.body) : null,
      idempotencyKey: false,
    })),
  };
}
