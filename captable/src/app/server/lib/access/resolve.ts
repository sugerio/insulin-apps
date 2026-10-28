import type { AppRole } from '@fours/app/server'
import type { OrgAccess } from '#shared'

export interface ResolvedOrg {
  id: string
  orgKey: string
  slug: string
  displayName: string
  status: 'active'
  timezone: string
  access: OrgAccess
  pii: boolean
}

export interface PortalMatch {
  orgId: string
  stakeholderId: string
  stakeholderName: string
}

export interface AccessResolution {
  orgAccess: Map<string, ResolvedOrg>
  portalMatches: PortalMatch[]
}

interface OrgRow {
  id: string
  org_key: string
  slug: string
  display_name: string
  status: ResolvedOrg['status']
  timezone: string
}

/** Resolve platform roles inside the caller's one-company console organization. */
export async function resolveAccess(
  db: D1Database,
  identity: { role: AppRole; email: string | null; organizationId: string },
): Promise<AccessResolution> {
  const orgAccess = new Map<string, ResolvedOrg>()
  const org = await db.prepare(
    `SELECT id, org_key, slug, display_name, status, timezone
     FROM orgs WHERE console_organization_id = ? AND status = 'active'
     ORDER BY created_at, id LIMIT 1`,
  ).bind(identity.organizationId).first<OrgRow>()

  if (org && ['OWNER', 'ADMIN', 'EDITOR'].includes(identity.role)) {
    orgAccess.set(org.id, {
      id: org.id,
      orgKey: org.org_key,
      slug: org.slug,
      displayName: org.display_name,
      status: org.status,
      timezone: org.timezone,
      access: identity.role === 'EDITOR' ? 'admin_ro' : 'admin_rw',
      pii: true,
    })
  }

  let portalMatches: PortalMatch[] = []
  if (identity.email && ['USER', 'VIEWER'].includes(identity.role)) {
    const { results } = await db.prepare(
      `SELECT DISTINCT s.org_id, s.id AS stakeholder_id, s.display_name AS stakeholder_name
       FROM stakeholder_emails se
       JOIN stakeholders s ON s.org_id = se.org_id AND s.id = se.stakeholder_id
       JOIN orgs o ON o.id = s.org_id
       WHERE lower(se.email) = lower(?) AND se.kind = 'self' AND se.removed_at IS NULL
         AND s.archived_at IS NULL AND s.portal_access <> 'closed' AND o.status = 'active'
         AND o.console_organization_id = ?
       ORDER BY s.display_name, s.id`,
    ).bind(identity.email, identity.organizationId).all<{ org_id: string; stakeholder_id: string; stakeholder_name: string }>()
    portalMatches = results.map((row) => ({
      orgId: row.org_id,
      stakeholderId: row.stakeholder_id,
      stakeholderName: row.stakeholder_name,
    }))
  }

  return { orgAccess, portalMatches }
}

export function accessMeetsMinimum(access: OrgAccess, minimum: OrgAccess): boolean {
  const rank: Record<OrgAccess, number> = { admin_ro: 1, admin_rw: 2 }
  return rank[access] >= rank[minimum]
}
