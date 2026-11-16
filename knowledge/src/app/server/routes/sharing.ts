import { Hono } from 'hono'
import { z } from 'zod'
import { authorize, quoted } from '../access.ts'
import type { AppEnv } from '../env.ts'
import { ApiError, badRequest, browserOnly, forbidden, readJson } from '../http.ts'
import { can } from '../identity.ts'
import { appLink, MAIL, sendMail } from '../mail.ts'
import { actsAsViewer, lookupMembers, memberOf, memberStatus, type PrincipalType } from '../members.ts'
import { callerOf, iso, json, now, param, type Ctx } from './common.ts'

/**
 * Sharing, like a Google Doc (design section 08): the owner or a collection Admin gives everyone in the organization
 * who can use Knowledge one role (up to Editor), and people or API clients their own (Viewer, Editor or Admin); the
 * highest wins. A collection Admin can change anyone's role except the owner's. Sharing lives here in D1, never in the
 * engine, so going back to a restore point never changes it. Every route is browser-only (DESIGN.md §2.5).
 */
const roleSchema = z.enum(['VIEWER', 'EDITOR', 'ADMIN'])

export function sharingRoutes() {
  const app = new Hono<AppEnv>()

  const onlyInBrowser = async (c: Ctx, next: () => Promise<void>) => {
    if (callerOf(c).via !== 'browser') throw browserOnly()
    await next()
  }
  app.use('/collections/:id/sharing', onlyInBrowser)
  app.use('/collections/:id/sharing/*', onlyInBrowser)
  app.use('/members', onlyInBrowser)

  app.get('/collections/:id/sharing', async (c) => {
    const caller = callerOf(c)
    const db = c.env.DB
    const { collection } = await authorize(db, caller, param(c, 'id'), 'read')
    const owner = await memberOf(db, collection.org_id, 'person', collection.owner_id)
    const { results } = await db.prepare(
      `SELECT s.principal_type, s.principal_id, s.role, s.status, s.shared_by, s.shared_at, m.name, m.email, m.app_role, m.permissions, m.unchecked
       FROM collection_shares s LEFT JOIN members m ON m.org_id = s.org_id AND m.principal_type = s.principal_type AND m.principal_id = s.principal_id
       WHERE s.collection_id = ? AND s.org_id = ? ORDER BY s.status, lower(COALESCE(m.name, m.email, s.principal_id))`,
    ).bind(collection.id, collection.org_id).all<{ principal_type: PrincipalType; principal_id: string; role: string; status: string; shared_by: string; shared_at: number; name: string | null; email: string | null; app_role: string | null; permissions: string | null; unchecked: number | null }>()
    return json(c, {
      owner: { id: collection.owner_id, name: owner?.name ?? null, email: owner?.email ?? null, actsAsViewer: actsAsViewer(owner?.app_role ?? null, owner?.permissions ?? null) },
      general: collection.general_role,
      assistants: collection.assistants === 1,
      shares: results.map((row) => ({
        type: row.principal_type,
        id: row.principal_id,
        name: row.name ?? row.email ?? null,
        email: row.principal_type === 'person' ? row.email : null,
        role: row.role,
        status: row.unchecked ? 'checking' : row.status,
        // A Viewer in Knowledge, or a custom role that can't change content, acts as a Viewer here, whatever they were given.
        actsAsViewer: actsAsViewer(row.app_role, row.permissions) && row.role !== 'VIEWER',
        sharedBy: row.shared_by,
        sharedAt: iso(row.shared_at),
      })),
    })
  })

  app.put('/collections/:id/sharing/general', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ role: z.string().nullable() }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'share')
    if (body.role !== null && body.role !== 'VIEWER' && body.role !== 'EDITOR') {
      throw badRequest('Everyone in the organization can get Viewer or Editor at most. Give Admin to named people.')
    }
    await c.env.DB.prepare(`UPDATE collections SET general_role = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(body.role, now(c), collection.id, collection.org_id).run()
    return json(c, { general: body.role })
  })

  app.put('/collections/:id/sharing/:type/:principalId', async (c) => {
    const caller = callerOf(c)
    const type = param(c, 'type')
    if (type !== 'person' && type !== 'client') throw badRequest('Share with a person or an API client.')
    const principalId = param(c, 'principalId')
    const body = await readJson(c, z.object({ role: roleSchema }).strict())
    const db = c.env.DB
    const at = now(c)
    const { collection } = await authorize(db, caller, param(c, 'id'), 'share')
    if (type === 'person' && principalId === collection.owner_id) throw forbidden("The owner's role can't be changed. The owner can transfer ownership instead.")
    if (principalId.length > 128) throw badRequest('That person or client is not valid.')
    // Only people who can use Knowledge (or the app's live API clients) of this organization: the platform says who.
    const status = await memberStatus(c.env, collection.org_id, [principalId]).catch(() => null)
    if (status && status !== 'deleted') {
      const entry = status.entries.find((candidate) => candidate.id === principalId && (candidate.type === type || candidate.gone))
      if (!entry?.member) throw badRequest(type === 'client' ? "That API client can't use Knowledge in your organization." : "That person can't use Knowledge in your organization. Invite them on insulinapps.com first.")
      await db.prepare(
        `INSERT INTO members (org_id, principal_type, principal_id, app_role, org_role, permissions, away, unchecked, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?7, 0, 0, ?6)
         ON CONFLICT (org_id, principal_type, principal_id) DO UPDATE SET app_role = COALESCE(excluded.app_role, members.app_role),
           permissions = CASE WHEN excluded.app_role IS NOT NULL THEN excluded.permissions ELSE members.permissions END, away = 0, updated_at = excluded.updated_at`,
      ).bind(collection.org_id, type, principalId, entry.appRole, entry.orgRole, at, entry.permissions ? JSON.stringify(entry.permissions) : null).run()
    } else {
      const known = await memberOf(db, collection.org_id, type, principalId)
      if (!known || known.away) throw badRequest('Pick someone from the list of people who can use Knowledge.')
    }
    const existing = await db.prepare(`SELECT role, status FROM collection_shares WHERE collection_id = ? AND org_id = ? AND principal_type = ? AND principal_id = ?`)
      .bind(collection.id, collection.org_id, type, principalId).first<{ role: string; status: string }>()
    await db.prepare(
      `INSERT INTO collection_shares (collection_id, org_id, principal_type, principal_id, role, status, shared_by, shared_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)
       ON CONFLICT (collection_id, principal_type, principal_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
    ).bind(collection.id, collection.org_id, type, principalId, body.role, caller.id, at).run()
    if (!existing && type === 'person') {
      const member = await memberOf(db, collection.org_id, 'person', principalId)
      if (member?.email) await sendMail(c.env, collection.org_id, { to: member.email, ...MAIL.sharedWithYou(caller.name ?? caller.email ?? 'Someone', collection.name, body.role, appLink(c.env, `/collections/${collection.id}`)) }, 'shared_with_you')
    }
    const member = await memberOf(db, collection.org_id, type, principalId)
    return json(c, { share: { type, id: principalId, role: body.role, status: existing?.status ?? 'active', actsAsViewer: actsAsViewer(member?.app_role ?? null, member?.permissions ?? null) && body.role !== 'VIEWER' } })
  })

  app.delete('/collections/:id/sharing/:type/:principalId', async (c) => {
    const caller = callerOf(c)
    const type = param(c, 'type')
    if (type !== 'person' && type !== 'client') throw badRequest('Stop sharing with a person or an API client.')
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'share')
    if (type === 'person' && param(c, 'principalId') === collection.owner_id) throw forbidden(`The owner of ${quoted(collection.name)} always has access.`)
    await c.env.DB.prepare(`DELETE FROM collection_shares WHERE collection_id = ? AND org_id = ? AND principal_type = ? AND principal_id = ?`)
      .bind(collection.id, collection.org_id, type, param(c, 'principalId')).run()
    return json(c, { removed: true })
  })

  // The sharing dialog's search: people who can use Knowledge, and the app's API clients (the platform's member lookup).
  app.get('/members', async (c) => {
    const caller = callerOf(c)
    if (!can(caller, 'knowledge.collections.share')) throw forbidden("Your role in Knowledge can't share collections.")
    const q = (c.req.query('q') ?? '').trim().slice(0, 100)
    const found = await lookupMembers(c.env, caller, q, c.req.header('x-suger-member-lookup') ?? null, now(c))
    if (found) return json(c, { members: found })
    if (c.env.SUGER_MEMBERS_URL) throw new ApiError('not_configured', "The list of people isn't available right now. Try again in a minute.")
    // The local preview has no platform: the people Knowledge has seen.
    const { results } = await c.env.DB.prepare(
      `SELECT principal_type, principal_id, name, email, app_role FROM members WHERE org_id = ?1 AND away = 0 AND (?2 = '' OR lower(COALESCE(name, '')) LIKE ?3 OR lower(COALESCE(email, '')) LIKE ?3) ORDER BY lower(COALESCE(name, email, principal_id)) LIMIT 20`,
    ).bind(caller.organizationId, q, `%${q.toLowerCase()}%`).all<{ principal_type: PrincipalType; principal_id: string; name: string | null; email: string | null; app_role: string | null }>()
    return json(c, { members: results.map((row) => ({ type: row.principal_type, id: row.principal_id, name: row.name ?? row.email ?? row.principal_id, email: row.principal_type === 'person' ? row.email : null, appRole: row.app_role })) })
  })

  return app
}

