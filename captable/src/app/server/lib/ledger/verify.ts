import { api, engine } from "#shared";
import { orgLocalDate } from "../read/org.ts";

/**
 * The Worker's side of ledger verification (the ledger rules; the API contract): the org's rows in one D1 batch (one snapshot),
 * checked by the engine's `verifyLedgerRows`, shared with the on-demand administrator verification endpoint. Nothing
 * here reads the replay cache.
 */

export async function loadVerificationRows(db: D1Database, orgId: string): Promise<engine.LedgerVerificationRows> {
  const queries = engine.ledgerVerificationQueries(orgId);
  const names = Object.keys(queries) as (keyof typeof queries)[];
  const results = await db.batch(names.map((name) => db.prepare(queries[name])));
  return engine.ledgerVerificationRowsFrom(orgId, Object.fromEntries(names.map((name, index) => [name, (results[index]?.results ?? []) as Record<string, unknown>[]])));
}

export interface OrgVerification {
  report: api.LedgerVerification;
  state: engine.LedgerState | null;
  rows: engine.LedgerVerificationRows;
}

/**
 * Verifies one org's ledger now, replayed to its today (or its latest effective date, when later). `asOf` overrides the
 * date (an import verifies as of its reviewed date).
 */
export async function verifyOrgLedger(db: D1Database, orgId: string, now: number, options: { asOf?: string } = {}): Promise<OrgVerification> {
  const rows = await loadVerificationRows(db, orgId);
  const org = await db.prepare("SELECT timezone FROM orgs WHERE id = ?").bind(orgId).first<{ timezone: string }>();
  const asOf = options.asOf ?? engine.verificationAsOf(rows, orgLocalDate(org?.timezone ?? "UTC", now));
  const result = engine.verifyLedgerRows(rows, { asOf });
  const report = api.ledgerVerificationSchema.parse({
    orgId,
    checkedAt: now,
    ledgerSeq: result.ledgerSeq,
    ledgerHeadHash: result.ledgerHeadHash,
    ok: result.ok,
    checks: result.checks,
  });
  return { report, state: result.state, rows };
}

/** The failed checks' problems, as one line per problem, for an error that stops a caller. */
export function verificationProblems(report: api.LedgerVerification): { code: string; message: string }[] {
  return report.checks.flatMap((check) => check.problems.map((problem) => ({ code: `LEDGER_${check.name.toUpperCase()}`, message: problem })));
}
