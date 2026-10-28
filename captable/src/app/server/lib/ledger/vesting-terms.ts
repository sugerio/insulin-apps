import { notFound } from "../http.ts";
import type { ReadContext, Viewer } from "../read/context.ts";
import { vestingTermsRowJson, type TermsRow } from "../read/structure.ts";
import { currentState, violation } from "./commands/common.ts";
import { conflict, invariantViolation } from "./errors.ts";
import { requestSha256 } from "./run.ts";
import { auditInsert, stmt } from "./statements.ts";
import type { CommandContext } from "./types.ts";
import type { WorkflowRequest } from "./valuations.ts";
import { commitWorkflow, replayed, type StoredResponse } from "./workflow.ts";

/**
 * `POST …/vesting-terms/:id/confirm`: records once that an imported template
 * matches the plan's schedule (`confirmed_by`, `confirmed_at`). It changes no definition and no number: vesting terms
 * are immutable, and the trigger refuses a second confirmation.
 */
export async function confirmVestingTerms(ctx: CommandContext, viewer: Viewer, termsId: string, body: Record<string, never>, request: WorkflowRequest): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const row = await ctx.db.prepare("SELECT * FROM vesting_terms WHERE org_id = ? AND id = ?").bind(ctx.org.id, termsId).first<TermsRow>();
  if (!row) throw notFound("Vesting schedule not found");
  if (row.is_template !== 1 || row.pulley_id === null) {
    throw invariantViolation([violation("NOT_AN_IMPORTED_TEMPLATE", "Only an imported template is confirmed against the plan's schedule")]);
  }
  if (row.confirmed_at !== null) throw conflict("state_changed", "That template is already confirmed");
  const read: ReadContext = { db: ctx.db, config: ctx.config, org: ctx.org, settings: ctx.settings, ledger: ctx.ledger, now: ctx.now, today: ctx.today, viewer };
  const response = await vestingTermsRowJson(read, { ...row, confirmed_by: ctx.actor.userId, confirmed_at: ctx.now }, currentState(ctx));
  return commitWorkflow(ctx, [
    stmt("UPDATE vesting_terms SET confirmed_by = ?, confirmed_at = ? WHERE org_id = ? AND id = ? AND confirmed_at IS NULL", ctx.actor.userId, ctx.now, ctx.org.id, termsId),
    // A concurrent confirmation made the UPDATE a no-op: this batch must not claim it (never judged from meta.changes).
    stmt("INSERT INTO batch_assertions (ok) SELECT confirmed_by IS ? AND confirmed_at IS ? FROM vesting_terms WHERE org_id = ? AND id = ?", ctx.actor.userId, ctx.now, ctx.org.id, termsId),
    auditInsert({
      occurredAt: ctx.now, orgId: ctx.org.id, actorKind: ctx.actor.kind, actorUserId: ctx.actor.userId, actorEmail: ctx.actor.email,
      authMethod: ctx.actor.authMethod, action: "vesting_terms.confirmed", targetType: "vesting_terms", targetId: termsId, result: "success",
      ip: ctx.actor.ip ?? null, userAgent: ctx.actor.userAgent ?? null, requestId: ctx.actor.requestId ?? null, details: { definitionSha256: row.definition_sha256 },
    }),
  ], { route: request.route, key: request.key, hash, body: response });
}
