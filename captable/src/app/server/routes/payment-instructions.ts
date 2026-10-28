import { api } from '#shared'
import { Hono } from 'hono'
import { insertAudit } from '../lib/audit.ts'
import { clientIp, readJson, userAgent } from '../lib/http.ts'
import { commitIdempotent, prepareIdempotency } from '../lib/idempotency.ts'
import { maskPaymentInstructionDetails, parsePaymentInstructionDetails } from '../lib/payment-instructions.ts'
import { ApiError } from '../lib/http.ts'
import type { AppDeps, AppEnv } from '../types.ts'

interface PaymentRow {
  details: string
  updated_by: string
  updated_at: number
  display_name: string | null
  email: string | null
}

function output(row: PaymentRow | null, mask = false) {
  if (!row) return null
  const details = parsePaymentInstructionDetails(row.details)
  if (!details) return null
  return api.paymentInstructionSchema.parse({
    details: mask ? maskPaymentInstructionDetails(details) : details,
    updatedBy: row.display_name ?? row.email ?? row.updated_by,
    updatedAt: row.updated_at,
  })
}

export function paymentInstructionRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>()

  routes.get('/payment-instructions', async (c) => {
    const row = await c.env.DB.prepare(
      `SELECT p.details, p.updated_by, p.updated_at, u.display_name, u.email
       FROM payment_instructions p LEFT JOIN users u ON u.id = p.updated_by
       WHERE p.org_id = ?`,
    ).bind(c.req.param('orgId')).first<PaymentRow>()
    return c.json(output(row, c.get('auth').consoleRole === 'EDITOR'))
  })

  routes.post('/payment-instructions', async (c) => {
    const input = await readJson(c, api.setPaymentInstructionsRequestSchema)
    const orgId = c.req.param('orgId')!
    const mutation = await prepareIdempotency(c, orgId, 'POST /api/orgs/:orgId/payment-instructions', input)
    if (mutation.replay) return mutation.replay
    const current = await c.env.DB.prepare(
      'SELECT updated_at FROM payment_instructions WHERE org_id = ?',
    ).bind(orgId).first<{ updated_at: number }>()
    if ((current?.updated_at ?? null) !== input.updatedAt) {
      throw new ApiError('conflict', 'Payment instructions changed; refresh and try again', undefined, {
        reason: 'stale_version',
      })
    }
    const auth = c.get('auth')
    const now = Math.max(deps.now(), (current?.updated_at ?? -1) + 1)
    const row: PaymentRow = {
      details: JSON.stringify(input.details),
      updated_by: auth.user.id,
      updated_at: now,
      display_name: auth.user.displayName,
      email: auth.user.email,
    }
    const body = output(row)!
    const write = current === null
      ? c.env.DB.prepare(
        `INSERT INTO payment_instructions (org_id, details, updated_by, updated_at, version)
         SELECT ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM payment_instructions WHERE org_id = ?)`,
      ).bind(orgId, row.details, auth.user.id, now, orgId)
      : c.env.DB.prepare(
        `UPDATE payment_instructions SET details = ?, updated_by = ?, updated_at = ?, version = version + 1
         WHERE org_id = ? AND updated_at = ?`,
      ).bind(row.details, auth.user.id, now, orgId, input.updatedAt)
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, [
        c.env.DB.prepare(
          "INSERT INTO batch_assertions (ok) SELECT EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')",
        ).bind(orgId),
        write,
        c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
        insertAudit(c.env.DB, {
          occurredAt: now, orgId, actorUserId: auth.user.id, actorEmail: auth.user.email,
          authMethod: auth.authMethod, action: 'payment_instructions.set', targetType: 'payment_instructions',
          targetId: orgId, result: 'success', ip: clientIp(c), userAgent: userAgent(c),
          details: { fields: Object.keys(input.details).sort() },
        }),
      ], 200, body, now)
      return replay ?? c.json(body)
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('batch assertion failed')) {
        throw new ApiError('conflict', 'Payment instructions changed; refresh and try again', undefined, {
          reason: 'stale_version',
        })
      }
      throw error
    }
  })

  return routes
}
