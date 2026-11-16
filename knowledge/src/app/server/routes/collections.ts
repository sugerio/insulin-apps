import { Hono } from 'hono'
import { z } from 'zod'
import { ACTIONS, authorize, loadCollection, ownerName, quoted, ROLE_RANK, roleIn, type Action, type CollectionRole, type CollectionRow } from '../access.ts'
import type { AppEnv } from '../env.ts'
import { badRequest, browserOnly, forbidden, logError, notFound, readJson } from '../http.ts'
import { idempotent } from '../idempotency.ts'
import { can, isOrgOwner, type Caller } from '../identity.ts'
import { effectiveLimit, quotaExceeded, SECONDS_PER_HOUR, usageOf } from '../limits.ts'
import { MAIL, sendMail } from '../mail.ts'
import { memberOf, memberStatus } from '../members.ts'
import { engineSettings, pushSettings, readOrgSettings } from '../settings.ts'
import { callerOf, engineFor, iso, json, now, param, type Ctx } from './common.ts'

const nameSchema = z.string().trim().min(1, 'give the collection a name').max(200, 'use at most 200 characters')
const purposeSchema = z.string().trim().max(500, 'use at most 500 characters')
const keepReadySchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1, 'pick at least one day').max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'give the start as HH:MM'),
  hours: z.number().int().min(1, 'keep it ready for at least 1 hour').max(3, 'keep it ready for at most 3 hours a day'),
}).strict()

/** What a list shows about a collection the caller has a role in. */
async function summaryOf(db: D1Database, caller: Caller, collection: CollectionRow) {
  const { granted, role } = await roleIn(db, caller, collection)
  const shares = await db.prepare(`SELECT principal_type, COUNT(*) AS n FROM collection_shares WHERE collection_id = ? AND org_id = ? AND status = 'active' GROUP BY principal_type`)
    .bind(collection.id, collection.org_id).all<{ principal_type: string; n: number }>()
  return {
    id: collection.id,
    name: collection.name,
    purpose: collection.purpose,
    role,
    grantedRole: granted,
    owner: { id: collection.owner_id, name: await ownerName(db, collection) },
    createdAt: iso(collection.created_at),
    lastUsedAt: iso(collection.last_used_at),
    documents: collection.documents,
    bytes: collection.bytes,
    facts: collection.facts,
    version: collection.version,
    state: collection.state === 'deleting' ? 'deleting' : collection.engine_state,
    assistants: collection.assistants === 1,
    keepReady: collection.keep_ready ? { ...(JSON.parse(collection.keep_ready) as object), paused: collection.keep_ready_paused === 1 } : null,
    sharing: {
      general: collection.general_role,
      people: shares.results.find((row) => row.principal_type === 'person')?.n ?? 0,
      clients: shares.results.find((row) => row.principal_type === 'client')?.n ?? 0,
    },
  }
}

/** What the caller may do in a collection, for the screens (the server checks again on every request). */
function abilities(caller: Caller, collection: CollectionRow, role: CollectionRole | null): Record<Action, boolean> {
  const entries = (Object.keys(ACTIONS) as Action[]).map((action) => {
    const rule = ACTIONS[action]
    const allowed = role !== null && ROLE_RANK[role] >= ROLE_RANK[rule.role] && can(caller, rule.permission) && (!rule.browserOnly || caller.via === 'browser')
      && (caller.via === 'browser' || collection.assistants === 1)
    return [action, allowed || (action === 'delete' && isOrgOwner(caller) && caller.via === 'browser')]
  })
  return Object.fromEntries(entries) as Record<Action, boolean>
}

export function collectionRoutes() {
  const app = new Hono<AppEnv>()

  // The collections the caller can ask: their own, those shared with everyone, those shared with them by name. API
  // clients see only those shared with them by name; assistants and API clients don't see collections whose switch is off.
  app.get('/', async (c) => {
    const caller = callerOf(c)
    const db = c.env.DB
    const { results } = await db.prepare(
      `SELECT c.* FROM collections c WHERE c.org_id = ?1 AND c.state != 'deleted' AND (
         (?2 = 'person' AND (c.owner_id = ?3 OR c.general_role IS NOT NULL))
         OR EXISTS (SELECT 1 FROM collection_shares s WHERE s.collection_id = c.id AND s.org_id = ?1 AND s.principal_type = ?2 AND s.principal_id = ?3 AND s.status = 'active'))
       ORDER BY lower(c.name), c.created_at`,
    ).bind(caller.organizationId, caller.kind, caller.id).all<CollectionRow>()
    const visible = results.filter((collection) => caller.via === 'browser' || collection.assistants === 1)
    return json(c, { collections: await Promise.all(visible.map((collection) => summaryOf(db, caller, collection))) })
  })

  app.post('/', async (c) => {
    const caller = callerOf(c)
    if (caller.kind === 'client') throw forbidden("API clients can't start collections. A person starts one and shares it with the client by name.")
    if (!can(caller, 'knowledge.collections.create')) throw forbidden("Your role in Knowledge can't start collections. Ask an admin of your organization to make you an Editor.")
    const body = await readJson(c, z.object({ name: nameSchema, purpose: purposeSchema.optional() }).strict())
    return idempotent(c, body, true, async () => {
      const db = c.env.DB
      const at = now(c)
      const org = caller.organizationId
      const engine = engineFor(c)
      const limit = await effectiveLimit(db, org, 'collections', at)
      const id = crypto.randomUUID()
      // One statement: the collection is added only while the organization is under its limit.
      const inserted = await db.prepare(
        `INSERT INTO collections (id, org_id, owner_id, owner_since, name, purpose, created_at, created_by, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?4, ?3, ?4
         WHERE ?7 IS NULL OR (SELECT COUNT(*) FROM collections WHERE org_id = ?2 AND state = 'active') < ?7`,
      ).bind(id, org, caller.id, at, body.name, body.purpose ?? '', limit).run()
      if (inserted.meta.changes !== 1) throw quotaExceeded(c.env, 'collections', limit ?? 0, at)
      const collection = (await loadCollection(db, org, id))!
      try {
        await engine.putCollection(id, engineSettings(collection, await readOrgSettings(db, org)))
      } catch (error) {
        await db.prepare(`DELETE FROM collections WHERE id = ? AND org_id = ?`).bind(id, org).run()
        throw error
      }
      return json(c, { collection: await summaryOf(db, caller, collection) }, 201)
    })
  })

  // Organization owners: basic information about every collection they have no role in, and nothing of its contents.
  app.get('/others', async (c) => {
    const caller = callerOf(c)
    if (!isOrgOwner(caller)) throw forbidden('Only owners of the organization see the other collections.')
    const db = c.env.DB
    const { results } = await db.prepare(
      `SELECT c.* FROM collections c WHERE c.org_id = ?1 AND c.state = 'active' AND c.owner_id != ?2 AND c.general_role IS NULL
         AND NOT EXISTS (SELECT 1 FROM collection_shares s WHERE s.collection_id = c.id AND s.org_id = ?1 AND s.principal_type = 'person' AND s.principal_id = ?2 AND s.status = 'active')
       ORDER BY lower(c.name), c.created_at`,
    ).bind(caller.organizationId, caller.id).all<CollectionRow>()
    const collections = await Promise.all(results.map(async (collection) => {
      const shares = await db.prepare(`SELECT principal_type, COUNT(*) AS n FROM collection_shares WHERE collection_id = ? AND org_id = ? AND status = 'active' GROUP BY principal_type`)
        .bind(collection.id, collection.org_id).all<{ principal_type: string; n: number }>()
      return {
        id: collection.id,
        name: collection.name,
        owner: { id: collection.owner_id, name: await ownerName(db, collection) },
        createdAt: iso(collection.created_at),
        lastUsedAt: iso(collection.last_used_at),
        documents: collection.documents,
        bytes: collection.bytes,
        keepReady: collection.keep_ready !== null,
        sharing: {
          general: collection.general_role,
          people: shares.results.find((row) => row.principal_type === 'person')?.n ?? 0,
          clients: shares.results.find((row) => row.principal_type === 'client')?.n ?? 0,
        },
      }
    }))
    return json(c, { collections })
  })

  app.get('/:id', async (c) => {
    const caller = callerOf(c)
    const { collection, role } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    let engine = null
    if (c.env.ENGINE) {
      try {
        engine = await engineFor(c).getCollection(collection.id)
        if (engine.state !== collection.engine_state) {
          await c.env.DB.prepare(`UPDATE collections SET engine_state = ? WHERE id = ? AND org_id = ?`).bind(engine.state, collection.id, collection.org_id).run()
        }
      } catch (error) {
        logError('engine_status_failed', error, { org: collection.org_id })
      }
    }
    const awake = await c.env.DB.prepare(`SELECT awake_seconds FROM collection_usage WHERE collection_id = ? AND period = ?`).bind(collection.id, new Date(now(c)).toISOString().slice(0, 7)).first<{ awake_seconds: number }>()
    const asked = await c.env.DB.prepare(`SELECT via, COUNT(*) AS n FROM questions WHERE org_id = ? AND collection_id = ? GROUP BY via`).bind(collection.org_id, collection.id).all<{ via: string; n: number }>()
    return json(c, {
      collection: await summaryOf(c.env.DB, caller, collection),
      role,
      can: abilities(caller, collection, role),
      engine,
      awakeHoursThisMonth: Math.round(((awake?.awake_seconds ?? 0) / SECONDS_PER_HOUR) * 100) / 100,
      questions: Object.fromEntries(['browser', 'mcp', 'api'].map((via) => [via, asked.results.find((row) => row.via === via)?.n ?? 0])),
    })
  })

  // Settings: name, purpose, the switch for AI assistants and API clients, keep-ready, minutes awake. Browser-only.
  // An organization owner may turn keep-ready off on any collection, without a role in it (D9).
  app.patch('/:id', async (c) => {
    const caller = callerOf(c)
    if (caller.via !== 'browser') throw browserOnly()
    const body = await readJson(c, z.object({
      name: nameSchema.optional(),
      purpose: purposeSchema.optional(),
      assistants: z.boolean().optional(),
      keepReady: keepReadySchema.nullable().optional(),
      awakeMinutes: z.number().int().min(5).max(60).optional(),
    }).strict())
    const db = c.env.DB
    const at = now(c)
    const org = caller.organizationId
    const onlyKeepReadyOff = Object.keys(body).length === 1 && body.keepReady === null
    let collection: CollectionRow
    if (onlyKeepReadyOff && isOrgOwner(caller)) {
      const found = await loadCollection(db, org, param(c, 'id'))
      if (!found) throw notFound("There's no such collection.")
      collection = found
    } else {
      collection = (await authorize(db, caller, param(c, 'id'), 'settings')).collection
    }
    const statements: D1PreparedStatement[] = []
    const set = (sql: string, ...values: unknown[]) => statements.push(db.prepare(`UPDATE collections SET ${sql}, updated_at = ? WHERE id = ? AND org_id = ?`).bind(...values, at, collection.id, org))
    if (body.name !== undefined) set('name = ?', body.name)
    if (body.purpose !== undefined) set('purpose = ?', body.purpose)
    if (body.assistants !== undefined) set('assistants = ?', body.assistants ? 1 : 0)
    if (body.awakeMinutes !== undefined) set('awake_minutes = ?', body.awakeMinutes)
    if (body.keepReady === null) set('keep_ready = NULL, keep_ready_paused = 0')
    if (statements.length) await db.batch(statements)
    if (body.keepReady) {
      const limit = await effectiveLimit(db, org, 'ready_collections', at)
      const awakeLimit = await effectiveLimit(db, org, 'awake_hours_month', at)
      const usage = await usageOf(db, org, at)
      const paused = awakeLimit !== null && (usage.awake_hours_month?.used ?? 0) >= awakeLimit * SECONDS_PER_HOUR * 0.9 ? 1 : 0
      // One statement: kept ready only while the organization is under its limit of collections kept ready.
      const updated = await db.prepare(
        `UPDATE collections SET keep_ready = ?1, keep_ready_paused = ?2, updated_at = ?3 WHERE id = ?4 AND org_id = ?5
           AND (keep_ready IS NOT NULL OR ?6 IS NULL OR (SELECT COUNT(*) FROM collections WHERE org_id = ?5 AND state = 'active' AND keep_ready IS NOT NULL) < ?6)`,
      ).bind(JSON.stringify(body.keepReady), paused, at, collection.id, org, limit).run()
      if (updated.meta.changes !== 1) throw quotaExceeded(c.env, 'ready_collections', limit ?? 0, at)
    }
    const fresh = (await loadCollection(db, org, collection.id))!
    if (body.keepReady !== undefined || body.awakeMinutes !== undefined) await pushSettings(c.env, fresh, await readOrgSettings(db, org), at)
    if (onlyKeepReadyOff && isOrgOwner(caller) && !(await roleIn(db, caller, fresh)).role) return json(c, { collection: { id: fresh.id, keepReady: null } })
    return json(c, { collection: await summaryOf(db, caller, fresh) })
  })

  // Delete: the owner, or an owner of the organization, one at a time, after typing its name. Browser-only.
  app.delete('/:id', async (c) => {
    const caller = callerOf(c)
    if (caller.via !== 'browser') throw browserOnly()
    const body = await readJson(c, z.object({ confirmName: z.string() }).strict())
    const db = c.env.DB
    const at = now(c)
    const org = caller.organizationId
    const collection = await loadCollection(db, org, param(c, 'id'))
    if (!collection) throw notFound("There's no such collection.")
    const { role } = await roleIn(db, caller, collection)
    const owner = role === 'OWNER'
    if (!owner && !isOrgOwner(caller)) {
      throw role ? forbidden(`Only the owner of ${quoted(collection.name)} or an owner of your organization can delete it.`) : forbidden(`You don't have access to ${quoted(collection.name)}.`)
    }
    if (body.confirmName.trim() !== collection.name) throw badRequest(`Type the collection's name, ${quoted(collection.name)}, to delete it.`)
    if (collection.state === 'active') {
      await db.batch([
        db.prepare(`UPDATE collections SET state = 'deleting', deleted_at = ?3, deleted_by = ?4, keep_ready = NULL, updated_at = ?3 WHERE id = ?1 AND org_id = ?2 AND state = 'active'`).bind(collection.id, org, at, caller.id),
        db.prepare(`UPDATE reservations SET state = 'released', settled_at = ?3 WHERE org_id = ?1 AND ref = ?2 AND state = 'held'`).bind(org, `awake:${collection.id}`, at),
        db.prepare(`INSERT INTO activity (id, org_id, collection_id, collection_name, action, actor_id, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), org, collection.id, collection.name, owner ? 'deleted' : 'deleted_by_org_owner', caller.id, at, JSON.stringify({ owner: collection.owner_id })),
      ])
      if (!owner && collection.owner_id !== caller.id) {
        const recipient = await memberOf(db, org, 'person', collection.owner_id)
        if (recipient?.email) await sendMail(c.env, org, { to: recipient.email, ...MAIL.deletedByOrgOwner(caller.name ?? caller.email ?? 'An owner', collection.name) }, 'deleted_by_org_owner')
      }
    }
    // The engine deletes it; the tick asks again until it is done.
    let state: 'deleting' | 'deleted' = 'deleting'
    if (c.env.ENGINE) {
      try {
        const engine = engineFor(c)
        const answer = await engine.deleteCollection(collection.id)
        if (answer.state === 'deleted' || (await engine.getCollection(collection.id)).state === 'deleted') {
          await db.prepare(`UPDATE collections SET state = 'deleted', engine_state = 'deleted', updated_at = ? WHERE id = ? AND org_id = ?`).bind(at, collection.id, org).run()
          state = 'deleted'
        }
      } catch (error) {
        logError('delete_failed', error, { org })
      }
    }
    return json(c, { state }, 202)
  })

  // Transfer ownership to an Admin or Editor in Knowledge; the old owner becomes a collection Admin. Browser-only.
  app.post('/:id/transfer', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ to: z.string().min(1).max(128) }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'transfer')
    return idempotent(c, body, true, async () => {
      const db = c.env.DB
      const at = now(c)
      const org = caller.organizationId
      if (body.to === caller.id) throw badRequest('You already own it.')
      const status = await memberStatus(c.env, org, [body.to]).catch(() => null)
      let appRole: string | null = null
      if (status && status !== 'deleted') {
        const entry = status.entries.find((candidate) => candidate.id === body.to && candidate.type === 'person')
        appRole = entry?.member ? entry.appRole : null
      } else {
        const known = await memberOf(db, org, 'person', body.to)
        appRole = known && !known.away ? known.app_role : null
      }
      if (appRole !== 'ADMIN' && appRole !== 'EDITOR') {
        throw badRequest('Ownership can only go to someone who is an Admin or Editor in Knowledge. Viewers can only read.')
      }
      await db.batch([
        db.prepare(`UPDATE collections SET owner_id = ?3, owner_since = ?4, updated_at = ?4 WHERE id = ?1 AND org_id = ?2 AND owner_id = ?5`).bind(collection.id, org, body.to, at, caller.id),
        db.prepare(`DELETE FROM collection_shares WHERE collection_id = ? AND org_id = ? AND principal_type = 'person' AND principal_id = ?`).bind(collection.id, org, body.to),
        db.prepare(
          `INSERT INTO collection_shares (collection_id, org_id, principal_type, principal_id, role, status, shared_by, shared_at, updated_at)
           VALUES (?1, ?2, 'person', ?3, 'ADMIN', 'active', ?4, ?5, ?5)
           ON CONFLICT (collection_id, principal_type, principal_id) DO UPDATE SET role = 'ADMIN', status = 'active', updated_at = excluded.updated_at`,
        ).bind(collection.id, org, caller.id, body.to, at),
        db.prepare(`INSERT INTO activity (id, org_id, collection_id, collection_name, action, actor_id, at, detail) VALUES (?, ?, ?, ?, 'transferred', ?, ?, ?)`)
          .bind(crypto.randomUUID(), org, collection.id, collection.name, caller.id, at, JSON.stringify({ from: caller.id, to: body.to })),
      ])
      const recipient = await memberOf(db, org, 'person', body.to)
      if (recipient?.email) await sendMail(c.env, org, { to: recipient.email, ...MAIL.transferredToYou(caller.name ?? caller.email ?? 'Its owner', collection.name) }, 'transferred')
      return json(c, { collection: await summaryOf(db, caller, (await loadCollection(db, org, collection.id))!) })
    })
  })

  return app
}
