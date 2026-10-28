import { api } from '#shared'
import { Hono, type Context } from 'hono'
import { insertAudit } from '../lib/audit.ts'
import { ApiError, clientIp, notFound, readJson, userAgent } from '../lib/http.ts'
import { commitIdempotent, prepareIdempotency } from '../lib/idempotency.ts'
import type { AppDeps, AppEnv } from '../types.ts'

interface AdminLinkRow {
  id: string
  email: string
  stakeholder_id: string
  source: 'directory' | 'admin'
  created_by: string | null
  created_at: number
  removed_at: number | null
  removed_by: string | null
}

function output(row: AdminLinkRow) {
  return api.adminStakeholderLinkSchema.parse({
    id: row.id,
    email: row.email,
    stakeholderId: row.stakeholder_id,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by,
  })
}

function audit(
  c: Context<AppEnv>,
  now: number,
  action: string,
  id: string,
  details: Record<string, unknown>,
  reason?: string,
  result: 'success' | 'denied' = 'success',
) {
  const auth = c.get('auth')
  return insertAudit(c.env.DB, {
    occurredAt: now,
    orgId: c.req.param('orgId'),
    actorUserId: auth.user.id,
    actorEmail: auth.user.email,
    authMethod: auth.authMethod,
    action,
    targetType: 'admin_stakeholder_link',
    targetId: id,
    result,
    reason: reason ?? null,
    ip: clientIp(c),
    userAgent: userAgent(c),
    details,
  })
}

export function orgAdminLinkRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>()

  routes.get('/admin-links', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, stakeholder_id, source, created_by, created_at, removed_at, removed_by
       FROM admin_stakeholder_links WHERE org_id = ? ORDER BY created_at, id`,
    ).bind(c.req.param('orgId')).all<AdminLinkRow>()
    return c.json(api.adminStakeholderLinkListSchema.parse({ items: results.map(output) }))
  })

  routes.post('/admin-links', async (c) => {
    const input = await readJson(c, api.createAdminLinkRequestSchema)
    const orgId = c.req.param('orgId')!
    const mutation = await prepareIdempotency(c, orgId, 'POST /api/orgs/:orgId/admin-links', input)
    if (mutation.replay) return mutation.replay
    const stakeholder = await c.env.DB.prepare(
      'SELECT 1 FROM stakeholders WHERE org_id = ? AND id = ? AND archived_at IS NULL',
    ).bind(orgId, input.stakeholderId).first()
    if (!stakeholder) throw notFound('Stakeholder not found')
    const now = deps.now()
    const row: AdminLinkRow = {
      id: crypto.randomUUID(), email: input.email, stakeholder_id: input.stakeholderId,
      source: input.source, created_by: c.get('auth').user.id, created_at: now,
      removed_at: null, removed_by: null,
    }
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, [
        c.env.DB.prepare(
          `INSERT INTO admin_stakeholder_links
           (id, org_id, email, stakeholder_id, source, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(row.id, orgId, row.email, row.stakeholder_id, row.source, row.created_by, now),
        audit(c, now, 'access.admin_link_created', row.id, {
          stakeholderId: row.stakeholder_id, source: row.source,
        }),
      ], 201, output(row), now)
      return replay ?? c.json(output(row), 201)
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('unique constraint failed')) {
        throw new ApiError('conflict', 'That administrator link already exists', undefined, { reason: 'state_changed' })
      }
      throw error
    }
  })

  routes.post('/admin-links/:id/remove', async (c) => {
    const input = await readJson(c, api.reasonRequestSchema)
    const orgId = c.req.param('orgId')!
    const id = c.req.param('id')!
    const mutation = await prepareIdempotency(c, orgId, 'POST /api/orgs/:orgId/admin-links/:id/remove', input)
    if (mutation.replay) return mutation.replay
    const row = await c.env.DB.prepare(
      `SELECT id, email, stakeholder_id, source, created_by, created_at, removed_at, removed_by
       FROM admin_stakeholder_links WHERE org_id = ? AND id = ? AND removed_at IS NULL`,
    ).bind(orgId, id).first<AdminLinkRow>()
    if (!row) throw notFound('Administrator link not found')
    const auth = c.get('auth')
    // The link is what keeps an administrator off their own holdings: another administrator must remove it.
    if (auth.user.email !== null && row.email.toLowerCase() === auth.user.email.toLowerCase()) {
      await insertAudit(c.env.DB, {
        occurredAt: deps.now(), orgId, actorUserId: auth.user.id, actorEmail: auth.user.email, authMethod: auth.authMethod,
        action: 'access.denied', targetType: 'admin_stakeholder_link', targetId: id, result: 'denied', reason: 'self_dealing',
        ip: clientIp(c), userAgent: userAgent(c), details: { stakeholderId: row.stakeholder_id },
      }).run()
      throw new ApiError('self_dealing', 'Another administrator must remove this link')
    }
    const now = deps.now()
    const actorEmail = c.get('auth').user.email!
    if (row.email.toLowerCase() === actorEmail.trim().toLowerCase()) {
      await audit(c, now, 'access.denied', id, { stakeholderId: row.stakeholder_id }, 'self_dealing', 'denied').run()
      throw new ApiError('self_dealing', 'A different administrator must remove this link')
    }
    const updated = { ...row, removed_at: now, removed_by: c.get('auth').user.id }
    const replay = await commitIdempotent(c.env.DB, mutation, [
      c.env.DB.prepare(
        `INSERT INTO batch_assertions (ok)
         SELECT EXISTS (SELECT 1 FROM admin_stakeholder_links
          WHERE org_id = ? AND id = ? AND email = ? AND stakeholder_id = ? AND removed_at IS NULL)`,
      ).bind(orgId, id, row.email, row.stakeholder_id),
      c.env.DB.prepare(
        'UPDATE admin_stakeholder_links SET removed_at = ?, removed_by = ? WHERE org_id = ? AND id = ? AND removed_at IS NULL',
      ).bind(now, c.get('auth').user.id, orgId, id),
      c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
      audit(c, now, 'access.admin_link_removed', id, { stakeholderId: row.stakeholder_id }, input.reason),
    ], 200, output(updated), now)
    return replay ?? c.json(output(updated))
  })

  return routes
}
