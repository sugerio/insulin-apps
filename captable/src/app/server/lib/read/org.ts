import { api, engine } from "#shared";

/** An `orgs` row as D1 returns it. */
export interface OrgRow {
  id: string;
  console_organization_id: string | null;
  org_key: string;
  slug: string;
  status: "active";
  legal_name: string;
  display_name: string;
  entity_type: "C_CORPORATION";
  jurisdiction: string;
  incorporation_date: string | null;
  timezone: string;
  currency: string;
  import_source: api.ImportSource | null;
  fiscal_year_end: string;
  ein: string | null;
  address: string | null;
  share_unit: string;
  settings: string;
  version: number;
  created_at: number;
  updated_at: number;
  pulley_id: string | null;
}

/** An active company that can execute writes always has an immutable console owner. */
export type OwnedOrgRow = OrgRow & { console_organization_id: string };

export async function getOrgRow(db: D1Database, orgId: string): Promise<OrgRow | null> {
  return db.prepare(
    `SELECT o.*,
       (SELECT source_system FROM import_runs r WHERE r.org_id = o.id AND r.status = 'committed'
        ORDER BY r.updated_at DESC LIMIT 1) AS import_source
     FROM orgs o WHERE o.id = ? AND o.status = 'active'`,
  ).bind(orgId).first<OrgRow>();
}

/**
 * The org's settings with every section filled: the column defaults to `'{}'` and older rows may hold only some
 * sections, so each section falls back to DEFAULT_ORG_SETTINGS on its own instead of failing the whole object. Each
 * section decodes with the contract's read side (`storedOrgSettingsSchema`): a portal section saved before
 * `privacyNoticeDocumentId` existed reads it as null.
 */
export function orgSettings(raw: string): api.OrgSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    // An unreadable settings column is treated as empty: every section takes its default.
  }
  const defaults = api.DEFAULT_ORG_SETTINGS;
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as (keyof api.OrgSettings)[]) {
    const value = stored[key];
    const fallback = defaults[key];
    const candidate = value !== null && typeof value === "object" && fallback !== null && typeof fallback === "object"
      ? { ...fallback, ...value }
      : value === undefined ? fallback : value;
    const section = api.storedOrgSettingsSchema.shape[key].safeParse(candidate);
    merged[key] = section.success ? section.data : fallback;
  }
  return merged as api.OrgSettings;
}

/** The org's local date: "today" for deadlines, defaults and "no ledger date after today" (the ledger rules). */
export function orgLocalDate(timezone: string, now: number): string {
  try {
    return engine.orgToday(timezone, now);
  } catch {
    // A bad imported time zone must not stop reads; UTC is the documented fallback.
    return engine.orgToday("UTC", now);
  }
}
