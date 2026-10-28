import { api } from "#shared";
import { Hono, type Context } from "hono";
import { insertAudit } from "../lib/audit.ts";
import { ApiError, clientIp, userAgent } from "../lib/http.ts";
import { loadReadContext, type Viewer } from "../lib/read/context.ts";
import { writeCsv } from "../lib/reports/csv.ts";
import { buildReport, reportJsonSheets, type ReportParameters } from "../lib/reports/reports.ts";
import { writeXlsx } from "../lib/reports/xlsx.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const LABELS: Record<api.ReportKey, string> = {
  "cap-table": "CapTable",
  "raw-cap-table": "RawCapTable",
  stakeholders: "Stakeholders",
  "vesting-details": "VestingDetails",
  "exercise-history": "ExerciseHistory",
  "audit-log": "AuditLog",
};

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function filename(company: string, key: api.ReportKey, extension: api.ReportFormat, date: string): string {
  const stem = company.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "") || "Company";
  return `${stem}_${LABELS[key]}_${date}.${extension}`;
}

function headers(type: string, filenameValue: string): HeadersInit {
  return {
    "Content-Type": type,
    "Content-Disposition": contentDisposition(filenameValue),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
}

function completedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const FILTERS: Record<api.ReportKey, ReadonlySet<string>> = {
  "cap-table": new Set(["asOf", "asKnownAt"]),
  "raw-cap-table": new Set(["asOf", "asKnownAt"]),
  stakeholders: new Set(["asOf"]),
  "vesting-details": new Set(["asOf", "asKnownAt"]),
  "exercise-history": new Set(["from", "to"]),
  "audit-log": new Set(["from", "to"]),
};

function validateParameters(c: Context<AppEnv>, key: api.ReportKey): void {
  const allowed = new Set(["format", "includePii", ...FILTERS[key]]);
  for (const parameter of new URL(c.req.url).searchParams.keys()) {
    if (!allowed.has(parameter)) {
      throw new ApiError("validation_failed", `${parameter} is not supported for the ${key} report`, [
        { path: parameter, message: `Remove ${parameter}; supported parameters are ${[...allowed].join(", ")}` },
      ]);
    }
  }
}

async function auditExport(
  c: Context<AppEnv>,
  deps: AppDeps,
  key: api.ReportKey,
  format: api.ReportFormat,
  params: ReportParameters,
  report: Awaited<ReturnType<typeof buildReport>>,
  requestedIncludePii: boolean | undefined,
  includePii: boolean,
): Promise<void> {
  const now = deps.now();
  const auth = c.get("auth");
  const org = c.get("org");
  const details: Record<string, unknown> = {
    reportKey: key, format, rowCount: report.rowCount,
    requestedIncludePii: requestedIncludePii ?? null, includePii,
    ledgerSeq: report.ledgerSeq, ledgerHeadHash: report.ledgerHeadHash, engineVersion: report.engineVersion,
    deliveryState: format === "csv" ? "started" : "generated",
  };
  if (FILTERS[key].has("asOf")) details.asOf = report.asOf;
  if (FILTERS[key].has("asKnownAt")) details.asKnownAt = report.asKnownAt;
  if (FILTERS[key].has("from")) details.from = params.from ?? null;
  if (FILTERS[key].has("to")) details.to = params.to ?? null;
  await insertAudit(c.env.DB, {
    occurredAt: now,
    orgId: org.id,
    actorUserId: auth.user.id,
    actorEmail: auth.user.email,
    authMethod: auth.authMethod,
    action: `export.${key}`,
    targetType: "report",
    targetId: key,
    result: "success",
    ip: clientIp(c),
    userAgent: userAgent(c),
    requestId: c.req.header("CF-Ray") ?? null,
    details,
  }).run();
}

function viewer(c: Context<AppEnv>, includePii: boolean): Viewer {
  const auth = c.get("auth");
  const org = c.get("org");
  return { access: org.access, fullAccess: auth.fullAccess, pii: includePii, userId: auth.user.id, email: auth.user.email };
}

function jsonResponse(
  key: api.ReportKey,
  generatedAt: number,
  includePii: boolean,
  report: Awaited<ReturnType<typeof buildReport>>,
): string {
  return JSON.stringify(api.reportJsonSchema.parse({
    reportKey: key,
    generatedAt,
    asOf: report.asOf,
    asKnownAt: report.asKnownAt,
    ledgerSeq: report.ledgerSeq,
    ledgerHeadHash: report.ledgerHeadHash,
    engineVersion: report.engineVersion,
    includePii,
    sheets: reportJsonSheets(report),
  }));
}

export function reportRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  routes.on("HEAD", "/reports/:reportKey", (c) => c.body(null, 405, { Allow: "GET" }));
  routes.get("/reports/:reportKey", async (c) => {
    // Hono dispatches HEAD through GET even when an explicit HEAD handler is registered.
    if (c.req.method === "HEAD") return c.body(null, 405, { Allow: "GET" });
    const keyResult = api.reportKeySchema.safeParse(c.req.param("reportKey"));
    if (!keyResult.success) throw new ApiError("not_found", "Report not found");
    validateParameters(c, keyResult.data);
    const parsed = api.reportQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ApiError("validation_failed", "Some query parameters are invalid", issuesOf(parsed.error));
    const key = keyResult.data;
    const format = api.resolveReportFormat(key, parsed.data.format);
    if (format === null) throw new ApiError("validation_failed", `${key} is not available as ${parsed.data.format}`);
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      throw new ApiError("validation_failed", "from must be on or before to", [{ path: "from", message: "Use a date on or before to" }]);
    }
    const org = c.get("org");
    // Console administrators have PII access; holders cannot reach report routes.
    const requestedPii = parsed.data.includePii ?? org.pii;
    const includePii = org.pii && requestedPii;
    const params: ReportParameters = {
      asOf: parsed.data.asOf,
      asKnownAt: parsed.data.asKnownAt,
      from: parsed.data.from,
      to: parsed.data.to,
    };
    const now = deps.now();
    const context = await loadReadContext(c.env.DB, c.get("config"), org.id, viewer(c, includePii), now);
    const report = await buildReport(context, key, params);
    const fileDate = report.asOf ?? parsed.data.to ?? context.today;
    const name = filename(context.org.display_name, key, format, fileDate);
    // Materialize and validate every byte before durable side effects. CSV records a generated/started export because
    // HTTP cannot prove that a client retained the whole response after the first byte.
    const body = format === "csv"
      ? new TextEncoder().encode(writeCsv([[...report.sheets[0]!.columns.map((column) => column.header)], ...report.sheets[0]!.rows]))
      : format === "xlsx" ? writeXlsx(report.sheets) : jsonResponse(key, now, includePii, report);
    const response = new Response(format === "csv" ? completedStream(body as Uint8Array) : body as BodyInit, {
      headers: headers(api.REPORT_CONTENT_TYPES[format], name),
    });
    await auditExport(c, deps, key, format, params, report, parsed.data.includePii, includePii);
    return response;
  });
  return routes;
}
