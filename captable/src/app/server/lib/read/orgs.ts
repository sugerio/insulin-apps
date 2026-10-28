import { api } from "#shared";
import type { ResolvedOrg } from "../access/resolve.ts";
import { log, notFound } from "../http.ts";
import { orgSettings, type OrgRow } from "./org.ts";

/** The company record: profile, settings and ledger head. The EIN is shown only with PII access. */
export function orgJson(row: OrgRow, head: { seq: number; head_hash: string | null } | null, fullAccess: boolean): api.Org {
  let address: api.Org["address"] = null;
  if (row.address !== null) {
    try {
      const parsed = api.addressSchema.safeParse(JSON.parse(row.address));
      address = parsed.success ? parsed.data : null;
    } catch {
      address = null;
    }
  }
  return api.orgSchema.parse({
    id: row.id,
    orgKey: row.org_key,
    slug: row.slug,
    status: row.status,
    legalName: row.legal_name,
    displayName: row.display_name,
    entityType: row.entity_type,
    jurisdiction: row.jurisdiction,
    incorporationDate: row.incorporation_date,
    timezone: row.timezone,
    currency: row.currency,
    importSource: row.import_source,
    fiscalYearEnd: row.fiscal_year_end,
    ein: row.ein === null ? null : fullAccess ? row.ein : `••-•••${row.ein.slice(-4)}`,
    address,
    shareUnit: row.share_unit,
    shareUnitFrozen: (head?.seq ?? 0) > 0,
    settings: orgSettings(row.settings),
    ledgerSeq: head?.seq ?? 0,
    ledgerHeadHash: head?.head_hash ?? null,
    version: row.version,
  });
}

export async function orgDetail(db: D1Database, orgId: string, fullAccess: boolean): Promise<api.Org> {
  const row = await db.prepare(
    `SELECT o.*,
       (SELECT source_system FROM import_runs r WHERE r.org_id = o.id AND r.status = 'committed'
        ORDER BY r.updated_at DESC LIMIT 1) AS import_source
     FROM orgs o WHERE o.id = ? AND o.status = 'active'`,
  ).bind(orgId).first<OrgRow>();
  if (!row) throw notFound("Organization not found");
  const head = await db.prepare("SELECT seq, head_hash FROM ledger_heads WHERE org_id = ?").bind(orgId).first<{ seq: number; head_hash: string | null }>();
  return orgJson(row, head, fullAccess);
}

/** `GET /api/orgs`: the caller's Insulin organization's active company, when they have access. */
export async function orgList(db: D1Database, orgAccess: ReadonlyMap<string, ResolvedOrg>): Promise<api.OrgList> {
  const ids = [...orgAccess.keys()];
  if (ids.length === 0) return { items: [] };
  const [orgs, heads] = await db.batch([
    db.prepare(
      `SELECT o.*,
         (SELECT source_system FROM import_runs r WHERE r.org_id = o.id AND r.status = 'committed'
          ORDER BY r.updated_at DESC LIMIT 1) AS import_source
       FROM orgs o WHERE o.status = 'active' AND o.id IN (SELECT value FROM json_each(?))
       ORDER BY o.display_name, o.id`,
    ).bind(JSON.stringify(ids)),
    db.prepare("SELECT h.org_id, h.seq, h.head_hash FROM ledger_heads h JOIN orgs o ON o.id = h.org_id WHERE o.status = 'active' AND h.org_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
  ]);
  const headOf = new Map(((heads?.results ?? []) as { org_id: string; seq: number; head_hash: string | null }[]).map((row) => [row.org_id, row]));
  return api.orgListSchema.parse({
    items: ((orgs?.results ?? []) as OrgRow[]).map((row) => orgJson(
      row,
      headOf.get(row.id) ?? null,
      orgAccess.get(row.id)?.pii ?? false,
    )),
  });
}

interface SignatoryRow {
  id: string;
  name: string;
  title: string | null;
  capabilities: string;
  active: number;
  pulley_id: string | null;
}

function capabilitiesOf(row: SignatoryRow): string[] {
  try {
    const value: unknown = JSON.parse(row.capabilities);
    // The column's CHECK keeps it a JSON array; anything that isn't a string in it is dropped, not guessed.
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    log("signatory_capabilities_unreadable", { id: row.id });
    return [];
  }
}

/**
 * Company › Signatories: the imported officers whose names and titles appear on grants, certificates, SAFEs and
 * warrants. These historical records are view only.
 */
export async function signatoryList(db: D1Database, orgId: string): Promise<api.OrgSignatoryList> {
  const { results } = await db.prepare(
    `SELECT id, name, title, capabilities, active, pulley_id FROM org_signatories
     WHERE org_id = ? ORDER BY active DESC, name, id`,
  ).bind(orgId).all<SignatoryRow>();
  return {
    items: results.map((row) => ({
      id: row.id,
      name: row.name,
      title: row.title,
      capabilities: capabilitiesOf(row),
      active: row.active === 1,
      importedFromPulley: row.pulley_id !== null,
    })),
  };
}
