import { api, engine, type OrgAccess } from "#shared";
import type { AppConfig } from "../config.ts";
import { notFound } from "../http.ts";
import { loadLedger, stateAt, type LoadedLedger } from "./ledger.ts";
import { getOrgRow, orgLocalDate, orgSettings, type OrgRow } from "./org.ts";

/** Who is reading: the access and PII rules every admin view passes through (one redaction layer). */
export interface Viewer {
  access: OrgAccess;
  fullAccess: boolean;
  /** Console administrators see personal data; holder views use their own allowlisted projection. */
  pii: boolean;
  userId: string | null;
  email: string | null;
}

export interface ReadContext {
  db: D1Database;
  config: AppConfig | null;
  org: OrgRow;
  settings: api.OrgSettings;
  ledger: LoadedLedger;
  now: number;
  today: string;
  viewer: Viewer;
}

export async function loadReadContext(db: D1Database, config: AppConfig | null, orgId: string, viewer: Viewer, now: number): Promise<ReadContext> {
  const org = await getOrgRow(db, orgId);
  if (!org) throw notFound("Organization not found");
  const ledger = await loadLedger(db, orgId);
  if (!ledger) throw notFound("Organization not found");
  return { db, config, org, settings: orgSettings(org.settings), ledger, now, today: orgLocalDate(org.timezone, now), viewer };
}

export interface HoldingsView {
  asOf: string;
  asKnownAt: number | null;
}

/** `asOf` defaults to the org's today and `asKnownAt` to the head (the API contract). */
export function holdingsView(ctx: ReadContext, query: { asOf?: string | undefined; asKnownAt?: number | undefined }): HoldingsView {
  return { asOf: query.asOf ?? ctx.today, asKnownAt: query.asKnownAt ?? null };
}

export function replayed(ctx: ReadContext, view: HoldingsView): engine.LedgerState {
  return stateAt(ctx.ledger, { asOf: view.asOf, asKnownAt: view.asKnownAt });
}

/** What every holdings response echoes (the API contract): the date, the known seq, the head and the engine version. */
export function echo(ctx: ReadContext, state: engine.LedgerState) {
  return {
    asOf: state.asOf,
    asKnownAt: state.asKnownAt ?? state.ledgerSeq,
    ledgerSeq: ctx.ledger.seq,
    ledgerHeadHash: ctx.ledger.headHash,
    engineVersion: engine.ENGINE_VERSION,
  };
}

/** A decimal as the API carries it: canonical and never negative (an over-granted pool shows as 0 available). */
export function dec(value: engine.Dec | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return value.isNegative() ? "0" : value.toString();
}

export function decOrNull(value: engine.Dec | null | undefined): string | null {
  return value === null || value === undefined ? null : dec(value);
}

/** An exact fraction (the API contractpercentages): `n` or `n/d` in lowest terms, never negative. */
export function ratio(value: engine.Rational): string {
  return value.sign() < 0 ? "0" : value.toJSON();
}

/** A price or ratio as a canonical decimal when it terminates within the storage bound, else null. */
export function exactDecimal(value: engine.Rational | null): string | null {
  if (value === null) return null;
  const exact = value.toDecExact();
  return exact !== null && engine.Dec.isCanonical(exact.toString()) ? exact.toString() : null;
}

/** E-mail masking for views without personal-data access: `a•••@example.test`. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/** Admin-facing actor labels prefer a display name; only a fallback e-mail is subject to PII masking. */
export function userActorLabel(
  user: { email: string; display_name: string | null },
  pii: boolean,
): string {
  return user.display_name?.trim() || (pii ? user.email : maskEmail(user.email));
}

export async function userActorLabels(
  db: D1Database,
  ids: readonly (string | null)[],
  pii: boolean,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const { results } = await db.prepare(
    "SELECT id, email, display_name FROM users WHERE id IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(unique)).all<{ id: string; email: string; display_name: string | null }>();
  return new Map(results.map((user) => [user.id, userActorLabel(user, pii)]));
}

export function email(ctx: ReadContext, value: string): string {
  return ctx.viewer.pii ? value : maskEmail(value);
}
