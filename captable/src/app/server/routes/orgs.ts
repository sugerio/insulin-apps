import { api, engine } from '#shared'
import { Hono, type Context } from 'hono'
import { insertAudit } from '../lib/audit.ts'
import { ApiError, clientIp, notFound, readJson, userAgent } from '../lib/http.ts'
import { commitIdempotent, prepareIdempotency } from '../lib/idempotency.ts'
import { companyResourceAssertion, isCompanyResource } from '../lib/documents/visibility.ts'
import { orgSettings, type OrgRow as ReadOrgRow } from '../lib/read/org.ts'
import { orgJson as readOrgJson } from '../lib/read/orgs.ts'
import type { AppDeps, AppEnv } from '../types.ts'

interface OrgRow extends ReadOrgRow { ledger_seq: number; ledger_head_hash: string | null }

function output(row: OrgRow) {
  return readOrgJson(row, { seq: row.ledger_seq, head_hash: row.ledger_head_hash }, true)
}

async function getOrg(db: D1Database, id: string): Promise<OrgRow | null> {
  return db.prepare(
    `SELECT o.*, h.seq AS ledger_seq, h.head_hash AS ledger_head_hash,
       (SELECT source_system FROM import_runs r WHERE r.org_id = o.id AND r.status = 'committed'
        ORDER BY r.updated_at DESC LIMIT 1) AS import_source
     FROM orgs o JOIN ledger_heads h ON h.org_id = o.id WHERE o.id = ? AND o.status = 'active'`,
  ).bind(id).first<OrgRow>()
}

function audit(c: Context<AppEnv>, now: number, action: string, orgId: string, details: Record<string, unknown>) {
  const auth = c.get('auth')
  return insertAudit(c.env.DB, {
    occurredAt: now,
    orgId,
    actorUserId: auth.user.id,
    actorEmail: auth.user.email,
    authMethod: auth.authMethod,
    action,
    targetType: 'organization',
    targetId: orgId,
    result: 'success',
    ip: clientIp(c),
    userAgent: userAgent(c),
    details,
  })
}

export function orgRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>()

  routes.post('/', async (c) => {
    if (!['OWNER', 'ADMIN'].includes(c.get('auth').consoleRole)) {
      throw new ApiError('forbidden', 'An owner or administrator must set up the company')
    }
    const input = await readJson(c, api.createOrgRequestSchema)
    const mutation = await prepareIdempotency(c, 'global', 'POST /api/orgs', input)
    if (mutation.replay) return mutation.replay
    const consoleOrganizationId = c.get('auth').consoleOrganizationId
    const existing = await c.env.DB.prepare(
      "SELECT id FROM orgs WHERE console_organization_id = ? AND status = 'active' LIMIT 1",
    ).bind(consoleOrganizationId).first()
    if (existing) {
      throw new ApiError('conflict', 'This app already has a company', undefined, { reason: 'state_changed' })
    }
    const now = deps.now()
    const id = crypto.randomUUID()
    const settings = api.orgSettingsSchema.parse({ ...api.DEFAULT_ORG_SETTINGS, ...input.settings })
    const genesis = engine.genesisHash(id)
    const row: OrgRow = {
      id, console_organization_id: consoleOrganizationId,
      org_key: input.orgKey, slug: input.orgKey, status: 'active',
      legal_name: input.legalName, display_name: input.displayName, entity_type: 'C_CORPORATION',
      jurisdiction: input.jurisdiction ?? 'US-DE', incorporation_date: input.incorporationDate ?? null,
      timezone: input.timezone, currency: input.currency ?? 'USD', fiscal_year_end: input.fiscalYearEnd ?? '12-31',
      ein: input.ein ?? null, address: input.address ? JSON.stringify(input.address) : null,
      share_unit: input.shareUnit ?? '1', settings: JSON.stringify(settings), version: 1,
      created_at: now, updated_at: now, pulley_id: null, import_source: null,
      ledger_seq: 0, ledger_head_hash: null,
    }
    const body = output(row)
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, [
        c.env.DB.prepare(
          `UPDATE orgs SET status = 'archived', version = version + 1, updated_at = ?
           WHERE console_organization_id = ? AND status = 'importing' AND EXISTS (
             SELECT 1 FROM import_runs r WHERE r.org_id = orgs.id
               AND r.console_organization_id = ?
               AND (r.status = 'failed' OR (r.attempt_expires_at IS NOT NULL AND r.attempt_expires_at <= ?))
           )`,
        ).bind(now, consoleOrganizationId, consoleOrganizationId, now),
        c.env.DB.prepare(
          `INSERT INTO orgs
           (id, console_organization_id, org_key, slug, status, legal_name, display_name, entity_type, jurisdiction, incorporation_date,
            timezone, currency, fiscal_year_end, ein, address, share_unit, settings, version, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM orgs WHERE console_organization_id = ? AND status <> 'archived'
           )`,
        ).bind(id, consoleOrganizationId, row.org_key, row.slug, row.legal_name, row.display_name, row.entity_type, row.jurisdiction,
          row.incorporation_date, row.timezone, row.currency, row.fiscal_year_end, row.ein, row.address,
          row.share_unit, row.settings, now, now, consoleOrganizationId),
        c.env.DB.prepare(
          `INSERT INTO batch_assertions (ok)
           SELECT changes() = 1 AND (
             SELECT COUNT(*) FROM orgs WHERE console_organization_id = ? AND status <> 'archived'
           ) = 1`,
        ).bind(consoleOrganizationId),
        c.env.DB.prepare(
          'INSERT INTO ledger_heads (org_id, seq, genesis_hash, head_hash, updated_at) VALUES (?, 0, ?, NULL, ?)',
        ).bind(id, genesis, now),
        audit(c, now, 'organization.created', id, { orgKey: row.org_key }),
      ], 201, body, now)
      return replay ?? c.json(body, 201)
    } catch (error) {
      if (error instanceof Error && (
        error.message.toLowerCase().includes('unique constraint failed')
        || error.message.toLowerCase().includes('batch assertion failed')
      )) {
        const importing = await c.env.DB.prepare(
          `SELECT 1 FROM orgs WHERE console_organization_id = ? AND status = 'importing' AND EXISTS (
             SELECT 1 FROM import_runs r WHERE r.org_id = orgs.id
               AND r.console_organization_id = ? AND r.status <> 'failed'
               AND (r.attempt_expires_at IS NULL OR r.attempt_expires_at > ?)
           ) LIMIT 1`,
        ).bind(consoleOrganizationId, consoleOrganizationId, now).first()
        if (importing) {
          throw new ApiError('conflict', 'A company import is already running. Wait for it to finish before setting up a company.', undefined, {
            reason: 'state_changed',
          })
        }
        throw new ApiError('conflict', 'This app already has a company', undefined, { reason: 'state_changed' })
      }
      throw error
    }
  })

  routes.patch('/:orgId', async (c) => {
    const input = await readJson(c, api.patchOrgRequestSchema)
    const orgId = c.req.param('orgId')!
    const mutation = await prepareIdempotency(c, orgId, 'PATCH /api/orgs/:orgId', input)
    if (mutation.replay) return mutation.replay
    const current = await getOrg(c.env.DB, orgId)
    if (!current) throw notFound('Company not found')
    if (current.version !== input.version) {
      throw new ApiError('conflict', 'The company changed; refresh and try again', undefined, { reason: 'stale_version' })
    }
    if (input.shareUnit !== undefined && input.shareUnit !== current.share_unit && current.ledger_seq > 0) {
      throw new ApiError('invariant_violation', 'The share unit cannot change after the ledger is populated')
    }
    const settings = api.orgSettingsSchema.parse({ ...orgSettings(current.settings), ...input.settings })
    const resourceIds = [...new Set([
      settings.portal.noticeFormDocumentId,
      settings.portal.privacyNoticeDocumentId,
    ].filter((id): id is string => id !== null))]
    for (const documentId of resourceIds) {
      if (!await isCompanyResource(c.env.DB, orgId, documentId)) {
        throw new ApiError('invariant_violation', 'Portal documents must be published company resources', undefined, {
          violations: [{ code: 'COMPANY_RESOURCE_REQUIRED', message: 'Publish the document to all holders first' }],
        })
      }
    }
    const updated: OrgRow = {
      ...current,
      legal_name: input.legalName ?? current.legal_name,
      display_name: input.displayName ?? current.display_name,
      jurisdiction: input.jurisdiction ?? current.jurisdiction,
      incorporation_date: input.incorporationDate === undefined ? current.incorporation_date : input.incorporationDate,
      timezone: input.timezone ?? current.timezone,
      fiscal_year_end: input.fiscalYearEnd ?? current.fiscal_year_end,
      ein: input.ein === undefined ? current.ein : input.ein,
      address: input.address === undefined ? current.address : input.address === null ? null : JSON.stringify(input.address),
      share_unit: input.shareUnit ?? current.share_unit,
      settings: JSON.stringify(settings),
      version: current.version + 1,
    }
    const now = deps.now()
    const body = output(updated)
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, [
        c.env.DB.prepare(
          `UPDATE orgs SET legal_name = ?, display_name = ?, jurisdiction = ?, incorporation_date = ?, timezone = ?,
           fiscal_year_end = ?, ein = ?, address = ?, share_unit = ?, settings = ?, version = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(updated.legal_name, updated.display_name, updated.jurisdiction, updated.incorporation_date,
          updated.timezone, updated.fiscal_year_end, updated.ein, updated.address, updated.share_unit,
          updated.settings, updated.version, now, orgId),
        ...resourceIds.map((documentId) => companyResourceAssertion(c.env.DB, orgId, documentId)),
        audit(c, now, 'organization.updated', orgId, {
          fields: Object.keys(input).filter((key) => key !== 'version'),
        }),
      ], 200, body, now)
      return replay ?? c.json(body)
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('batch assertion failed')) {
        throw new ApiError('conflict', 'A portal document changed; refresh and try again', undefined, {
          reason: 'state_changed',
        })
      }
      throw error
    }
  })

  return routes
}
