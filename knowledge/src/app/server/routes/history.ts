import { Hono } from 'hono'
import { authorize } from '../access.ts'
import type { AppEnv } from '../env.ts'
import { ApiError, badRequest, logError, notFound } from '../http.ts'
import { idempotent, stableId } from '../idempotency.ts'
import { ensureAwakeBlock } from '../limits.ts'
import { reconcileHistory } from '../outbox.ts'
import { callerOf, engineFor, json, now, param } from './common.ts'

/**
 * History (restore points: go back, undo) and export. Restore points and what they hold live in the engine; going
 * back never changes sharing, which lives here. Export is per collection, for its Owner and Admins, browser-only.
 */
function versionOf(raw: string): number {
  const version = Number(raw)
  if (!Number.isInteger(version) || version < 1) throw badRequest('That restore point is not valid.')
  return version
}

export function historyRoutes() {
  const app = new Hono<AppEnv>()

  // The engine's restore points (changes within 5 minutes share one); the history list in D1 follows them.
  app.get('/:id/history', async (c) => {
    const { collection } = await authorize(c.env.DB, callerOf(c), param(c, 'id'), 'read')
    const listed = await engineFor(c).restorePoints(collection.id)
    await reconcileHistory(c.env, collection.org_id, collection.id, listed.restorePoints).catch((error) => logError('history_reconcile_failed', error, { org: collection.org_id }))
    return json(c, listed)
  })

  app.get('/:id/history/:version/preview', async (c) => {
    const { collection } = await authorize(c.env.DB, callerOf(c), param(c, 'id'), 'read')
    return json(c, { preview: await engineFor(c).preview(collection.id, versionOf(param(c, 'version'))) })
  })

  app.post('/:id/history/undo', async (c) => {
    const { collection } = await authorize(c.env.DB, callerOf(c), param(c, 'id'), 'change')
    return idempotent(c, null, true, async () => {
      await ensureAwakeBlock(c.env, collection.org_id, collection.id, now(c))
      return json(c, { collection: await engineFor(c).undo(collection.id) })
    })
  })

  app.post('/:id/history/:version/go-back', async (c) => {
    const { collection } = await authorize(c.env.DB, callerOf(c), param(c, 'id'), 'change')
    const version = versionOf(param(c, 'version'))
    return idempotent(c, null, true, async () => {
      // Going back starts the collection from that restore point: awake time, like any work of the engine's.
      await ensureAwakeBlock(c.env, collection.org_id, collection.id, now(c))
      return json(c, { collection: await engineFor(c).goBack(collection.id, version) })
    })
  })

  app.post('/:id/exports', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'export')
    return idempotent(c, null, true, async () => {
      await ensureAwakeBlock(c.env, collection.org_id, collection.id, now(c))
      // The same id when the same request comes back after its answer was lost: the engine answers the export it started.
      const exportId = (await stableId(c)).replace(/-/g, '')
      const status = await engineFor(c).startExport(collection.id, exportId)
      await c.env.DB.prepare(`INSERT INTO exports (id, org_id, collection_id, requested_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`).bind(exportId, caller.organizationId, collection.id, caller.id, now(c)).run()
      return json(c, { export: status }, 202)
    })
  })

  app.get('/:id/exports/:exportId', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'export')
    const exportId = param(c, 'exportId')
    const row = await c.env.DB.prepare(`SELECT id FROM exports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(exportId, caller.organizationId, collection.id).first()
    if (!row) throw notFound('There is no such export of this collection.')
    const engine = engineFor(c)
    if (c.req.query('download') === '1') {
      const status = await engine.getExport(collection.id, exportId)
      if (status.state !== 'ready') {
        throw new ApiError('conflict', status.state === 'failed' ? "This export failed. Start a new one." : "This export isn't ready yet. Try again in a minute.", { export: status })
      }
      const file = await engine.download(collection.id, exportId)
      const headers = new Headers({ 'content-type': file.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' })
      const safeName = collection.name.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 80) || 'collection'
      const extension = (file.headers.get('content-type') ?? '').includes('json') ? 'json' : 'zip'
      headers.set('content-disposition', `attachment; filename="export.${extension}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.${extension}`)}`)
      return new Response(file.body, { status: 200, headers })
    }
    return json(c, { export: await engine.getExport(collection.id, exportId) })
  })

  return app
}
