import { api } from "#shared";
import { Hono, type Context, type Handler } from "hono";
import type { ZodType } from "zod";
import { insertAudit } from "../lib/audit.ts";
import { ApiError, clientIp, log, notFound, readJson, userAgent } from "../lib/http.ts";
import { planCancel, type CancelFields } from "../lib/ledger/commands/cancel.ts";
import { planExercise, type ExerciseFields } from "../lib/ledger/commands/exercise.ts";
import { planExtension, type ExtendFields } from "../lib/ledger/commands/extend.ts";
import { planGrant, type GrantFields } from "../lib/ledger/commands/grant.ts";
import { planLeave, type LeaveFields } from "../lib/ledger/commands/leave.ts";
import { planMarkExecuted, type MarkExecutedFields } from "../lib/ledger/commands/mark-executed.ts";
import { planStakeholderMerge } from "../lib/ledger/commands/merge-stakeholders.ts";
import { planSetPlanTerms, type PlanTermsFields } from "../lib/ledger/commands/plan-terms.ts";
import { planReversal, reversalPreview } from "../lib/ledger/commands/reverse.ts";
import { planTermination, type TerminationInput } from "../lib/ledger/commands/terminate.ts";
import type { CommandDocuments } from "../lib/ledger/documents.ts";
import { processDue } from "../lib/ledger/daily.ts";
import { loadCommandContext, runCommand, type CommandOutcome } from "../lib/ledger/run.ts";
import type { Actor, CommandContext, CommandPlan } from "../lib/ledger/types.ts";
import { cancelScheduledTermination, confirmExpiryRun, previewExpiryRun, scheduleTermination, type StoredResponse } from "../lib/ledger/workflow.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/**
 * The ledger commands (the API contract): `POST /api/orgs/:orgId/commands/<name>[?dryRun=true]`, the reversal preview and
 * the confirmation of a report-only expiry run. The registration point has already checked console identity, the
 * org (404 for any other) and the required access level before the body is read.
 */

type LedgerCommandName = Exclude<api.CommandName, "schedule-termination" | "cancel-scheduled-termination">;
type Built = { plan: CommandPlan; documents: CommandDocuments | null };
type Builder = (ctx: CommandContext, body: never, options: { dryRun: boolean }) => Promise<Built>;

const BUILDERS: Record<LedgerCommandName, Builder> = {
  "terminate-stakeholder": (ctx, body: TerminationInput) => planTermination(ctx, body, { kind: "immediate" }),
  "exercise-option": (ctx, body: ExerciseFields) => planExercise(ctx, body),
  "grant-equity-compensation": (ctx, body: GrantFields) => planGrant(ctx, body),
  // A dry run previews before the person types the confirmation; the real call checks it.
  "cancel-security": (ctx, body: CancelFields, { dryRun }) => planCancel(ctx, body, { confirm: !dryRun }),
  "mark-executed": (ctx, body: MarkExecutedFields, { dryRun }) => planMarkExecuted(ctx, body, { confirm: !dryRun }),
  "record-leave-of-absence": (ctx, body: LeaveFields) => planLeave(ctx, body),
  "extend-exercise-deadline": (ctx, body: ExtendFields, { dryRun }) => planExtension(ctx, body, { confirm: !dryRun }),
  "set-plan-terms": (ctx, body: PlanTermsFields) => planSetPlanTerms(ctx, body),
  "merge-stakeholders": async (ctx, body: api.MergeStakeholders, { dryRun }) => ({
    plan: await planStakeholderMerge(ctx, body, { dryRun }),
    documents: null,
  }),
  "reverse-command": async (ctx, body: api.ReverseCommand) => ({
    plan: (await planReversal(ctx, body, { confirm: true, enforceRefusal: true })).plan,
    documents: null,
  }),
};

export function actorOf(c: Context<AppEnv>): Actor {
  const auth = c.get("auth");
  return {
    kind: "user",
    userId: auth.user.id,
    email: auth.user.email,
    authMethod: auth.authMethod,
    receiptActor: auth.user.id,
    fullAccess: auth.fullAccess,
    ip: clientIp(c),
    userAgent: userAgent(c),
    requestId: c.req.header("CF-Ray") ?? null,
  };
}

export function commandContext(c: Context<AppEnv>, deps: AppDeps): Promise<CommandContext> {
  return loadCommandContext({ db: c.env.DB, now: deps.now(), config: c.get("config"), orgId: c.get("org").id, actor: actorOf(c), source: "app" });
}

/** the API contract: one key per intent, 8–200 characters; a dry run needs none (and ignores one). */
export function idempotencyKey(c: Context<AppEnv>, required: boolean): string | null {
  if (!required) return null;
  const key = c.req.header("Idempotency-Key") ?? "";
  if (key.length < 8 || key.length > 200) {
    throw new ApiError("validation_failed", "Idempotency-Key must be 8–200 characters", [{ path: "Idempotency-Key", message: "Send one key of 8–200 characters per intent" }]);
  }
  return key;
}

function isDryRun(c: Context<AppEnv>): boolean {
  const query = api.commandQuerySchema.safeParse(c.req.query());
  if (!query.success) throw new ApiError("validation_failed", "Some query parameters are invalid", [{ path: "dryRun", message: "Use dryRun=true or dryRun=false" }]);
  return query.data.dryRun === true;
}

function commandResponse(c: Context<AppEnv>, deps: AppDeps, outcome: CommandOutcome): Response {
  if (outcome.replay) {
    return new Response(outcome.replay.body, { status: outcome.replay.status, headers: { "Content-Type": "application/json", "Idempotent-Replay": "true" } });
  }
  void deps;
  return c.json(outcome.result, 200);
}

export function storedResponse(stored: StoredResponse): Response {
  return Response.json(stored.body, { status: stored.status, headers: stored.replay ? { "Idempotent-Replay": "true" } : undefined });
}

/**
 * A refused attempt on the admin's own holdings (the ledger rules) is audited like the registration point's denials, dry
 * run or not; the 403 itself is unchanged.
 */
function auditingSelfDealing(deps: AppDeps, handler: Handler<AppEnv>): Handler<AppEnv> {
  return async (c, next) => {
    try {
      return await handler(c, next);
    } catch (error) {
      if (error instanceof ApiError && error.code === "self_dealing") {
        const auth = c.get("auth");
        await insertAudit(c.env.DB, {
          occurredAt: deps.now(), orgId: c.get("org").id, actorUserId: auth.user.id, actorEmail: auth.user.email,
          authMethod: auth.authMethod, action: "access.denied", result: "denied", reason: "self_dealing",
          ip: clientIp(c), userAgent: userAgent(c), details: { method: c.req.method, path: c.req.path },
        }).run().catch((failure: unknown) => log("audit_write_failed", { action: "access.denied", errorClass: (failure as Error).name }));
      }
      throw error;
    }
  };
}

export function commandRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();

  routes.post("/process-due", async (c) => {
    const org = c.get("org");
    return c.json(await processDue(c.env.DB, c.get("config"), org.id, org.timezone, deps.now()));
  });

  for (const name of Object.keys(BUILDERS) as LedgerCommandName[]) {
    const spec = api.COMMANDS[name];
    const route = api.ROUTE_TABLE.find((entry) => entry.method === "POST" && entry.path === `/api/orgs/:orgId/commands/${name}`)!;
    const maxBytes = route.body.kind === "json" ? route.body.maxBytes : undefined;
    routes.post(`/commands/${name}`, auditingSelfDealing(deps, async (c) => {
      // A command without a dry run (reverse-command) previews elsewhere: `?dryRun=true` must never run it for real.
      if (spec.dryRunSchema === null && c.req.query("dryRun") !== undefined) {
        throw new ApiError("validation_failed", "This command has no dry run", [{ path: "dryRun", message: "Use the reversal preview instead" }]);
      }
      const dryRun = spec.dryRunSchema !== null && isDryRun(c);
      const schema = (dryRun ? spec.dryRunSchema : spec.schema) as ZodType<Record<string, unknown>>;
      const body = await readJson(c, schema, maxBytes);
      const key = idempotencyKey(c, !dryRun);
      const ctx = await commandContext(c, deps);
      const guard = body as { expectedLedgerSeq?: number; expectedDiffSha256?: string; acknowledge?: string[] };
      const outcome = await runCommand(ctx, {
        route: `POST ${route.path}`,
        path: c.req.path,
        body,
        dryRun,
        idempotencyKey: key,
        expectedLedgerSeq: guard.expectedLedgerSeq ?? null,
        expectedDiffSha256: guard.expectedDiffSha256 ?? null,
        acknowledge: guard.acknowledge ?? [],
      }, (current) => BUILDERS[name](current, body as never, { dryRun }));
      return commandResponse(c, deps, outcome);
    }));
  }

  routes.post("/commands/schedule-termination", auditingSelfDealing(deps, async (c) => {
    const spec = api.COMMANDS["schedule-termination"];
    const dryRun = isDryRun(c);
    const body = (await readJson(c, (dryRun ? spec.dryRunSchema : spec.schema) as typeof spec.schema)) as api.ScheduleTermination;
    const key = idempotencyKey(c, !dryRun);
    const ctx = await commandContext(c, deps);
    return storedResponse(await scheduleTermination(ctx, body as unknown as TerminationInput, {
      route: "POST /api/orgs/:orgId/commands/schedule-termination",
      path: c.req.path,
      body,
      dryRun,
      key,
      expectedLedgerSeq: body.expectedLedgerSeq ?? null,
      expectedDiffSha256: body.expectedDiffSha256 ?? null,
      acknowledge: body.acknowledge ?? [],
    }));
  }));

  routes.post("/commands/cancel-scheduled-termination", auditingSelfDealing(deps, async (c) => {
    const body = await readJson(c, api.cancelScheduledTerminationSchema);
    const key = idempotencyKey(c, true)!;
    const ctx = await commandContext(c, deps);
    return storedResponse(await cancelScheduledTermination(ctx, body, {
      route: "POST /api/orgs/:orgId/commands/cancel-scheduled-termination",
      path: c.req.path,
      key,
    }));
  }));

  routes.get("/commands/:id/reversal-preview", auditingSelfDealing(deps, async (c) => {
    const params = api.routes.getReversalPreview.params.safeParse(c.req.param());
    if (!params.success) throw notFound();
    const ctx = await commandContext(c, deps);
    return c.json(await reversalPreview(ctx, params.data.id));
  }));

  routes.post("/expiry-runs/:runId/confirm", auditingSelfDealing(deps, async (c) => {
    const params = api.routes.confirmExpiryRun.params.safeParse(c.req.param());
    if (!params.success) throw notFound();
    const input = { db: c.env.DB, now: deps.now(), config: c.get("config"), orgId: c.get("org").id, actor: actorOf(c), source: "app" as const };
    // The dry run shows each expiry's effect for review; the real call is held to those effects.
    if (isDryRun(c)) return c.json(await previewExpiryRun(input, params.data.runId, await readJson(c, api.confirmExpiryRunDryRunSchema)));
    const body = await readJson(c, api.confirmExpiryRunSchema);
    const key = idempotencyKey(c, true)!;
    return storedResponse(await confirmExpiryRun(input, params.data.runId, body, { route: "POST /api/orgs/:orgId/expiry-runs/:runId/confirm", path: c.req.path, key }));
  }));

  return routes;
}
