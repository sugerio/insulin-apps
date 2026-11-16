import type { Context } from 'hono'
import type { AppEnv } from './env.ts'
import { nowOf } from './env.ts'
import { ApiError } from './http.ts'

/**
 * `Idempotency-Key` on changes: the first request with a key runs and its response is kept for a day; the same
 * request with the same key gets that response again (`Idempotent-Replay: true`), a different request with it
 * 409 idempotency_key_reused, and one while the first is still running 409 conflict. Creating things (a collection,
 * an import, a note, a report…) needs a key; other changes take one when given. Only successful answers are kept, so a
 * refused or failed change can be sent again with the same key.
 */
const KEEP_MS = 24 * 60 * 60 * 1000

async function hashOf(method: string, path: string, body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([method, path, body ?? null])))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function idempotent(c: Context<AppEnv>, body: unknown, required: boolean, run: () => Promise<Response>): Promise<Response> {
  const key = c.req.header('idempotency-key')?.trim() ?? ''
  if (!key) {
    if (required) throw new ApiError('idempotency_key_required', 'Send an Idempotency-Key header (a new random value for each change) so a retried request is not done twice.')
    return run()
  }
  if (!/^[\x21-\x7e]{8,200}$/.test(key)) throw new ApiError('bad_request', 'The Idempotency-Key must be 8 to 200 visible ASCII characters.')
  const caller = c.get('caller')
  const db = c.env.DB
  const now = nowOf(c.env)
  const route = `${c.req.method} ${c.req.path}`
  const hash = await hashOf(c.req.method, c.req.path, body)
  await db.prepare(`DELETE FROM idempotency WHERE org_id = ? AND actor = ? AND key = ? AND created_at < ?`).bind(caller.organizationId, caller.id, key, now - KEEP_MS).run()
  const claim = await db.prepare(
    `INSERT INTO idempotency (org_id, actor, key, route, request_hash, status, body, created_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?) ON CONFLICT DO NOTHING`,
  ).bind(caller.organizationId, caller.id, key, route, hash, now).run()
  if (claim.meta.changes !== 1) {
    const row = await db.prepare(`SELECT route, request_hash, status, body FROM idempotency WHERE org_id = ? AND actor = ? AND key = ?`).bind(caller.organizationId, caller.id, key)
      .first<{ route: string; request_hash: string; status: number; body: string | null }>()
    if (!row || row.route !== route || row.request_hash !== hash) throw new ApiError('idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Use a new one.')
    if (row.status === 0) throw new ApiError('conflict', 'The same request is still running. Try again in a moment.')
    return new Response(row.body, { status: row.status, headers: { 'content-type': 'application/json', 'idempotent-replay': 'true', 'cache-control': 'no-store' } })
  }
  let response: Response
  try {
    response = await run()
  } catch (error) {
    await forget(db, caller.organizationId, caller.id, key)
    throw error
  }
  if (response.status >= 300) {
    await forget(db, caller.organizationId, caller.id, key)
    return response
  }
  await db.prepare(`UPDATE idempotency SET status = ?, body = ? WHERE org_id = ? AND actor = ? AND key = ? AND status = 0`)
    .bind(response.status, await response.clone().text(), caller.organizationId, caller.id, key).run()
  return response
}

/** A refused or failed change keeps nothing: the same key may be sent again. */
async function forget(db: D1Database, org: string, actor: string, key: string): Promise<void> {
  await db.prepare(`DELETE FROM idempotency WHERE org_id = ? AND actor = ? AND key = ? AND status = 0`).bind(org, actor, key).run()
}
