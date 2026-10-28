import { api, engine } from "#shared";
import { notFound } from "../http.ts";
import { email, replayed, type ReadContext } from "./context.ts";
import { ActorLabels } from "./records.ts";

/**
 * Report-only expiry runs: while `settings.expiry.mode` is `report_only`, on-demand due processing records what it
 * would expire in `expiry_runs`, and an administrator confirms it. These reads show the runs and their proposals to
 * every admin; the candidates appear on the dashboard's Needs attention list, and any write administrator can confirm.
 */

interface ExpiryProposalDetails {
  securityId: string;
  displayId: string;
  reason: "contractual_deadline" | "expiration";
  lastExerciseDate: string;
  effectiveDate: string;
  quantity: string;
}

/** A run's metadata, projected in SQL: its proposals are counted (`json_array_length`), never loaded or parsed. */
interface RunMeta {
  id: number;
  started_at: number;
  local_date: string | null;
  confirmed_at: number | null;
  reserved_at: number | null;
  reserved: number;
  proposal_count: number | null;
}

const RUN_META = `id, created_at AS started_at, local_date, confirmed_at,
  json_extract(confirmation, '$.reservedAt') AS reserved_at, confirmation IS NOT NULL AS reserved,
  json_array_length(candidates) AS proposal_count`;
const REPORT_ONLY_RUNS = "org_id = ?1";

/** The company's newest report-only run's metadata. */
async function newestRun(ctx: ReadContext): Promise<RunMeta | null> {
  return ctx.db.prepare(`SELECT ${RUN_META} FROM expiry_runs WHERE ${REPORT_ONLY_RUNS} ORDER BY id DESC LIMIT 1`).bind(ctx.org.id).first<RunMeta>();
}

/**
 * A run's state. Each day's run re-proposes every current candidate, so only the org's newest report-only run is ever
 * the one to confirm, and only while expiry is report-only: any older or automatic-era run that was never confirmed
 * is superseded, a stopped confirmation included (its exact retry still resumes on the server). The newest run is
 * `confirming` while a confirmation is bound to it, else `pending`.
 */
function stateOf(ctx: ReadContext, run: RunMeta, newestId: number | null): api.ExpiryRunState {
  if (run.confirmed_at !== null) return "confirmed";
  if (run.id !== newestId || ctx.settings.expiry.mode !== "report_only") return "superseded";
  return run.reserved ? "confirming" : "pending";
}

function summaryOf(ctx: ReadContext, run: RunMeta, newestId: number | null): api.ExpiryRunSummary {
  return {
    runId: run.id,
    localDate: run.local_date ?? new Date(run.started_at).toISOString().slice(0, 10),
    startedAt: run.started_at,
    state: stateOf(ctx, run, newestId),
    proposalCount: run.proposal_count ?? 0,
  };
}

/**
 * `GET …/expiry-runs`: the runs pending confirmation (`pending` or `confirming`), newest first. By the state rule only
 * the newest report-only run can be one, so this reads one row's metadata.
 */
export async function expiryRunList(ctx: ReadContext): Promise<api.ExpiryRunList> {
  const newest = await newestRun(ctx);
  const items = newest === null ? [] : [summaryOf(ctx, newest, newest.id)].filter((run) => run.state === "pending" || run.state === "confirming");
  return api.expiryRunListSchema.parse({ items });
}

/** The number of runs pending confirmation: the dashboard's `EXPIRY_RUN_TO_CONFIRM` count. */
export async function pendingExpiryRuns(ctx: ReadContext): Promise<number> {
  return (await expiryRunList(ctx)).items.length;
}

/**
 * `GET …/expiry-runs/:runId`: a run, its state, and each proposal with its holder and what confirming would cancel
 * today (the confirmation's dry run computes the same candidates: `engine.expiryCandidates` on today's state).
 */
export async function expiryRunDetail(ctx: ReadContext, runId: number): Promise<api.ExpiryRunDetail> {
  // One run by org and id (the primary key), plus the newest run's id for its state.
  const [found, newest] = await ctx.db.batch([
    ctx.db.prepare(`SELECT ${RUN_META}, candidates, confirmed_by FROM expiry_runs WHERE ${REPORT_ONLY_RUNS} AND id = ?2`).bind(ctx.org.id, runId),
    ctx.db.prepare(`SELECT id FROM expiry_runs WHERE ${REPORT_ONLY_RUNS} ORDER BY id DESC LIMIT 1`).bind(ctx.org.id),
  ]);
  const row = ((found?.results ?? []) as (RunMeta & { candidates: string; confirmed_by: string | null })[])[0];
  if (!row) throw notFound("Expiry run not found");
  const newestId = ((newest?.results ?? []) as { id: number }[])[0]?.id ?? null;
  const proposals = JSON.parse(row.candidates) as ExpiryProposalDetails[];
  const state = replayed(ctx, { asOf: ctx.today, asKnownAt: null });
  const confirmable = new Map(engine.expiryCandidates(state, ctx.today).map((candidate) => [candidate.securityId, candidate]));
  const identities = new Map(ctx.ledger.reference.securities.map((security) => [security.id, security]));
  const holderIds = [...new Set(proposals.map((proposal) => state.securities.get(proposal.securityId)?.identity.stakeholderId).filter((id): id is string => id !== undefined))];
  const { results: holders } = await ctx.db.prepare(
    `SELECT s.id, s.display_name,
       (SELECT e.email FROM stakeholder_emails e WHERE e.org_id = s.org_id AND e.stakeholder_id = s.id AND e.removed_at IS NULL
          AND e.kind = 'self' ORDER BY e.created_at, e.id LIMIT 1) AS email
     FROM stakeholders s WHERE s.org_id = ? AND s.id IN (SELECT value FROM json_each(?))`,
  ).bind(ctx.org.id, JSON.stringify(holderIds)).all<{ id: string; display_name: string; email: string | null }>();
  const holderOf = new Map(holders.map((row) => [row.id, row]));
  const confirmedBy = row.confirmed_by ? await new ActorLabels(ctx).user(row.confirmed_by) : null;
  return api.expiryRunDetailSchema.parse({
    ...summaryOf(ctx, row, newestId),
    confirmedAt: row.confirmed_at,
    confirmedBy,
    confirmationStartedAt: row.reserved_at,
    proposals: proposals.map((proposal) => {
      // A security's identity row is never deleted (a reversal leaves it), so every proposal has one.
      const identity = identities.get(proposal.securityId);
      if (!identity) throw new Error(`Expiry run ${row.id} proposes an unknown security`);
      const stakeholderId = state.securities.get(proposal.securityId)?.identity.stakeholderId
        ?? engine.resolveStakeholderId(state, identity.stakeholderId);
      const holder = holderOf.get(stakeholderId);
      const now = confirmable.get(proposal.securityId);
      return {
        securityId: proposal.securityId,
        displayId: proposal.displayId,
        family: identity.family === "WARRANT" ? "WARRANT" : "EQUITY_COMPENSATION",
        holder: {
          stakeholderId,
          name: holder?.display_name ?? "",
          email: holder?.email ? email(ctx, holder.email) : null,
        },
        quantity: proposal.quantity,
        reason: proposal.reason,
        lastExerciseDate: proposal.lastExerciseDate,
        effectiveDate: proposal.effectiveDate,
        confirmable: now ? { quantity: now.quantity.toString(), effectiveDate: now.effectiveDate } : null,
      };
    }),
  });
}
