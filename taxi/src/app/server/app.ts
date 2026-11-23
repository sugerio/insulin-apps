import { Hono, type Context } from "hono";
import { z } from "zod";
import { COUNTRIES, FORM_LANGUAGES, ROUTE_TABLE, SUPPORTED_YEARS, fileRoutes, routes, type AnyRoute, type ApiCatalog, type Me } from "#shared";
import { yearsFor } from "../shared/rules/index.ts";
import { platformReader } from "./lib/ai.ts";
import * as documents from "./lib/documents.ts";
import { getEstimate } from "./lib/estimate.ts";
import * as hints from "./lib/hints.ts";
import { craForms, printReturn, type FormSource } from "./lib/forms.ts";
import * as people from "./lib/people.ts";
import * as returns from "./lib/returns.ts";
import { ApiError, forbidden, logError, notFound, parseOr400, readJson } from "./lib/http.ts";
import { isScheduleTick, readCaller, type Caller } from "./lib/identity.ts";
import type { SlipReader } from "./lib/reader.ts";
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
  /** What reads an uploaded slip for an organization; tests pass recorded answers. */
  reader?: (orgId: string) => SlipReader;
  /** The same-origin check on writes; off only in the dev server, where the console preview's origin differs. */
  enforceSameOrigin?: boolean;
  /** Where the CRA's print forms come from; tests pass blank stand-in pages. */
  forms?: FormSource;
}

/** What a route's handler gets: the caller, its parsed params and body, the database and the time. */
interface Call<R extends AnyRoute> {
  caller: Caller;
  params: R["params"] extends z.ZodType ? z.infer<R["params"]> : Record<string, never>;
  body: R["body"] extends z.ZodType ? z.infer<R["body"]> : undefined;
  db: D1Database;
  now: number;
  /** The raw request, for a route that takes a file rather than JSON. */
  request: Request;
}
type Answer<R extends AnyRoute> = R["response"] extends z.ZodType ? z.infer<R["response"]> | { status: 201; body: z.infer<R["response"]> } : void;

export function createApp(options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const readerFor = options.reader ?? platformReader;
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders());
  app.use("*", async (c, next) => {
    c.set("origin", new URL(c.req.url).origin);
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true, service: "taxi" }));

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
        throw forbidden(route.permission === "taxi.prepare" ? "Your role can view returns but not change them" : undefined);
      }
      // A path param that fails its schema names nothing that exists.
      const params = route.params ? (route.params as z.ZodType).safeParse(c.req.param()) : null;
      if (params && !params.success) throw notFound();
      const body = route.body ? parseOr400(route.body as z.ZodType, await readJson(c.req.raw), "request body") : undefined;
      const answer = await handle({ caller, params: params?.data ?? {}, body, db: c.env.DB, now: now(), request: c.req.raw } as Call<R>);
      if (route.response === null) return c.body(null, 204);
      const created = typeof answer === "object" && answer !== null && "status" in answer && answer.status === 201;
      const payload = (route.response as z.ZodType).parse(created ? (answer as { body: unknown }).body : answer);
      return c.json(payload, created ? 201 : 200);
    });
  }

  mount(routes.getMe, async ({ caller }) => meOf(caller));
  mount(routes.getCatalog, async ({ caller }) => catalogFor(caller));
  mount(routes.listYears, async ({ caller, db }) => people.listYears(db, caller.orgId, COUNTRIES.map((country) => ({ country, years: yearsFor(country) }))));
  mount(routes.startYear, async ({ caller, body, db, now }) => {
    const { view, created } = await people.startYear(db, caller, body.year, body.country, body.people, now);
    return created ? { status: 201, body: view } : view;
  });
  mount(routes.getYear, async ({ caller, params, db }) => people.getYear(db, caller.orgId, params.year));
  mount(routes.getEstimate, async ({ caller, params, db }) => getEstimate(db, caller.orgId, params.year));
  mount(routes.listHints, async ({ caller, params, db }) => hints.listHints(db, caller.orgId, params.year));
  mount(routes.decideHint, async ({ caller, params, body, db, now }) => hints.decideHint(db, caller, params.year, params.hint, body, now));
  mount(routes.setYearPeople, async ({ caller, params, body, db, now }) => people.setYearPeople(db, caller, params.year, body, now));
  mount(routes.savePersonalInfo, async ({ caller, params, body, db, now }) => people.savePersonalInfo(db, caller, params.year, body, now));
  mount(routes.listDocuments, async ({ caller, params, db }) => documents.listDocuments(db, caller.orgId, params.year));
  mount(routes.uploadDocument, async ({ caller, params, db, now, request }) =>
    documents.uploadDocument(db, caller, params.year, request, readerFor(caller.orgId), now),
  );
  mount(routes.readDocumentAgain, async ({ caller, params, db, now }) => documents.readDocumentAgain(db, caller, params.year, params.id, readerFor(caller.orgId), now));
  mount(routes.deleteDocument, async ({ caller, params, body, db, now }) => documents.deleteDocument(db, caller, params.year, params.id, body.revision, now));
  // A stored file's bytes, to show it beside the numbers read from it: not JSON, so outside the route table.
  app.get(fileRoutes.documentFile.path, async (c) => {
    const caller = c.get("caller");
    if (!caller.permissions.has(fileRoutes.documentFile.permission)) throw forbidden();
    const year = Number(c.req.param("year"));
    if (!(SUPPORTED_YEARS as readonly number[]).includes(year)) throw notFound();
    const file = await documents.documentFile(c.env.DB, caller.orgId, year, c.req.param("id"));
    return new Response(file.bytes, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  // A return printed on the CRA's forms, with its worksheet, as a PDF to save: not JSON, so outside the route table.
  // ?language=fr prints Revenu Québec's forms on their French versions.
  app.get(fileRoutes.returnForms.path, async (c) => {
    const caller = c.get("caller");
    if (!caller.permissions.has(fileRoutes.returnForms.permission)) throw forbidden();
    const year = Number(c.req.param("year"));
    if (!(SUPPORTED_YEARS as readonly number[]).includes(year)) throw notFound();
    const language = parseOr400(z.enum(FORM_LANGUAGES).default("en"), c.req.query("language"), "language");
    const pdf = await printReturn(c.env.DB, caller.orgId, year, c.req.param("personId"), options.forms ?? craForms, now(), language);
    return new Response(pdf.bytes, {
      headers: {
        "Content-Type": "application/pdf",
        // Opened in a tab to look at, or saved with ?download=1.
        "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(pdf.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  mount(routes.saveAnswers, async ({ caller, params, body, db, now }) => returns.saveAnswers(db, caller, params.year, body, now));
  mount(routes.listSlips, async ({ caller, params, db }) => returns.listSlips(db, caller.orgId, params.year));
  mount(routes.addSlip, async ({ caller, params, body, db, now }) => ({ status: 201, body: await returns.addSlip(db, caller, params.year, body, now) }));
  mount(routes.updateSlip, async ({ caller, params, body, db, now }) => returns.updateSlip(db, caller, params.year, params.id, body, now));
  mount(routes.removeSlip, async ({ caller, params, body, db, now }) => returns.removeSlip(db, caller, params.year, params.id, body.revision, now));
  mount(routes.confirmSlips, async ({ caller, params, body, db, now }) => returns.confirmSlips(db, caller, params.year, body, now));
  mount(routes.listPeople, async ({ caller, db }) => ({ people: await people.listPeople(db, caller.orgId) }));
  mount(routes.addPerson, async ({ caller, body, db, now }) => ({ status: 201, body: await people.addPerson(db, caller, body, now) }));
  mount(routes.updatePerson, async ({ caller, params, body, db, now }) => people.updatePerson(db, caller, params.id, body, now));
  mount(routes.removePerson, async ({ caller, params, db, now }) => people.removePerson(db, caller, params.id, now));
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

/** `GET /api/catalog`: only the routes the caller may use, with their bodies as JSON Schema, then those that answer with a file. */
export function catalogFor(caller: Pick<Caller, "permissions">): ApiCatalog {
  const pathOf = (path: string) => path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
  return {
    endpoints: [
      ...ROUTE_TABLE.filter((route) => route.permission === null || caller.permissions.has(route.permission)).map((route) => ({
        method: route.method,
        path: pathOf(route.path),
        summary: route.summary,
        query: null,
        body: route.body ? jsonSchemaOf(route.body) : null,
        idempotencyKey: false,
      })),
      ...Object.values(fileRoutes)
        .filter((route) => caller.permissions.has(route.permission))
        .map((route) => ({ method: route.method, path: pathOf(route.path), summary: route.summary, query: route.query, body: null, idempotencyKey: false })),
    ],
  };
}
