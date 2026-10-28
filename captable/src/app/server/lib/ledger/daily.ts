import { api, engine } from "#shared";
import type { AppConfig } from "../config.ts";
import { ApiError, log } from "../http.ts";
import { orgLocalDate } from "../read/org.ts";
import { expiryCandidatesToday, planExpiry, proposalOf } from "./commands/expire.ts";
import { planTermination, type TerminationInput } from "./commands/terminate.ts";
import { loadCommandContext, runCommand } from "./run.ts";
import type { Actor } from "./types.ts";

function systemActor(purpose: string): Actor {
  return { kind: "system", userId: null, email: null, authMethod: null, receiptActor: `system:${purpose}`, fullAccess: false };
}

const storedTermination = api.terminateStakeholderSchema.omit({
  expectedLedgerSeq: true,
  expectedDiffSha256: true,
  acknowledge: true,
});

export interface ProcessDueResult {
  localDate: string;
  appliedTerminations: number;
  expiredSecurities: number;
  proposedExpirations: number;
  remainingExpirations: number;
  failures: number;
}

export interface ProcessDueOptions {
  /** Background dashboard loads use a small cap; the explicit endpoint processes every candidate. */
  automaticExpiryLimit?: number;
}

export const DASHBOARD_AUTOMATIC_EXPIRY_LIMIT = 10;
const STAGING_CLEANUP_LIMIT = 100;
const ONE_DAY_MS = 86_400_000;

/** Upserts one company's report-only proposal with a public sequence that no other company can advance. */
export async function upsertExpiryRun(
  db: D1Database,
  orgId: string,
  localDate: string,
  candidates: string,
  createdAt: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO expiry_runs (org_id, org_seq, local_date, candidates, created_at)
     SELECT ?, COALESCE(MAX(org_seq) + 1, 1), ?, ?, ? FROM expiry_runs WHERE org_id = ?
     ON CONFLICT (org_id, local_date) DO UPDATE SET candidates = excluded.candidates
     WHERE expiry_runs.confirmed_at IS NULL AND expiry_runs.confirmation IS NULL`,
  ).bind(orgId, localDate, candidates, createdAt, orgId).run();
}

/** The exact engine candidate check plus the only due work that lives outside the ledger replay. */
export async function hasDueWork(
  db: D1Database,
  orgId: string,
  localDate: string,
  state: engine.LedgerState,
): Promise<boolean> {
  if (engine.expiryCandidates(state, localDate).length > 0) return true;
  return await db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM scheduled_terminations
       WHERE org_id = ?1 AND status = 'SCHEDULED' AND termination_date <= ?2 LIMIT 1
     ) AS due`,
  ).bind(orgId, localDate).first<number>('due') === 1;
}

/**
 * Runs due ledger work for one company. Every command has a stable, date-scoped receipt key, so dashboard loads and
 * explicit retries are safe. Report-only expiry proposals are one immutable logical run per company and local date.
 */
export async function processDue(
  db: D1Database,
  config: AppConfig | null,
  orgId: string,
  timezone: string,
  now: number,
  options: ProcessDueOptions = {},
): Promise<ProcessDueResult> {
  const localDate = orgLocalDate(timezone, now);
  const result: ProcessDueResult = {
    localDate,
    appliedTerminations: 0,
    expiredSecurities: 0,
    proposedExpirations: 0,
    remainingExpirations: 0,
    failures: 0,
  };
  const failures: { kind: string; id: string; code: string }[] = [];
  try {
    const consoleOrganizationId = await db.prepare(
      "SELECT console_organization_id FROM orgs WHERE id = ? AND status = 'active'",
    ).bind(orgId).first<string>("console_organization_id");
    await db.prepare(
      `DELETE FROM document_upload_chunks WHERE rowid IN (
         SELECT rowid FROM document_upload_chunks
         WHERE console_organization_id IS ? AND org_id = ? AND created_at < ? ORDER BY created_at, rowid LIMIT ?
       )`,
    ).bind(consoleOrganizationId, orgId, now - ONE_DAY_MS, STAGING_CLEANUP_LIMIT).run();
  } catch (error) {
    log("document_staging_cleanup_failed", { orgId, code: error instanceof Error ? error.name : "unknown" });
  }
  const { results: due } = await db.prepare(
    `SELECT id, request, version, created_by FROM scheduled_terminations
     WHERE org_id = ? AND status = 'SCHEDULED' AND termination_date <= ?
     ORDER BY termination_date, id LIMIT 100`,
  ).bind(orgId, localDate).all<{ id: string; request: string; version: number; created_by: string | null }>();

  for (const row of due) {
    try {
      const ctx = await loadCommandContext({ db, now, config, orgId, actor: systemActor("terminate"), source: "system" });
      const input: TerminationInput = storedTermination.parse(JSON.parse(row.request));
      await runCommand(ctx, {
        route: "SYSTEM apply-scheduled-termination",
        path: `/system/scheduled-terminations/${row.id}`,
        body: { scheduledTerminationId: row.id },
        dryRun: false,
        idempotencyKey: `system:terminate:${row.id}`,
        expectedLedgerSeq: null,
        expectedDiffSha256: null,
        acknowledge: [],
        autoAcknowledge: true,
      }, (current) => planTermination(current, input, {
        kind: "apply",
        scheduledTerminationId: row.id,
        version: row.version,
        createdBy: row.created_by,
      }));
      result.appliedTerminations += 1;
    } catch (error) {
      result.failures += 1;
      failures.push({ kind: "scheduled-termination", id: row.id, code: error instanceof ApiError ? error.code : (error as Error).name });
    }
  }

  try {
    const ctx = await loadCommandContext({ db, now, config, orgId, actor: systemActor("expire"), source: "system" });
    const candidates = expiryCandidatesToday(ctx);
    if (candidates.length > 0 && ctx.settings.expiry.mode === "report_only") {
      const details = JSON.stringify(candidates.map((candidate) => proposalOf(ctx, candidate)));
      await upsertExpiryRun(db, orgId, localDate, details, now);
      result.proposedExpirations = candidates.length;
    } else if (ctx.settings.expiry.mode === "automatic") {
      const limit = options.automaticExpiryLimit === undefined
        ? candidates.length
        : Math.max(0, Math.floor(options.automaticExpiryLimit));
      const selected = candidates.slice(0, limit);
      result.remainingExpirations = candidates.length - selected.length;
      for (const candidate of selected) {
        try {
          const current = await loadCommandContext({ db, now, config, orgId, actor: systemActor("expire"), source: "system" });
          await runCommand(current, {
            route: "SYSTEM expire-securities",
            path: `/system/expire/${candidate.securityId}`,
            body: { securityId: candidate.securityId, localDate },
            dryRun: false,
            idempotencyKey: `system:expire:${orgId}:${localDate}:${candidate.securityId}`,
            expectedLedgerSeq: null,
            expectedDiffSha256: null,
            acknowledge: [],
            autoAcknowledge: true,
          }, (next) => planExpiry(next, candidate.securityId));
          result.expiredSecurities += 1;
        } catch (error) {
          result.failures += 1;
          failures.push({ kind: "expiry", id: candidate.securityId, code: error instanceof ApiError ? error.code : (error as Error).name });
        }
      }
      if (result.remainingExpirations > 0) {
        log("process_due_remaining_expirations", { orgId, localDate, remaining: result.remainingExpirations });
      }
    }
  } catch (error) {
    result.failures += 1;
    failures.push({ kind: "expiry", id: orgId, code: error instanceof ApiError ? error.code : (error as Error).name });
  }

  if (failures.length > 0) log("process_due_failures", { orgId, localDate, failures });
  return result;
}
