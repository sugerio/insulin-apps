import { api, engine } from '#shared'
import { Hono, type Context } from 'hono'
import { assertNotSelfDealing } from '../lib/access/self-dealing.ts'
import { insertAudit } from '../lib/audit.ts'
import { ApiError, clientIp, notFound, readJson, userAgent } from '../lib/http.ts'
import { commitIdempotent, prepareIdempotency } from '../lib/idempotency.ts'
import { loadReadContext, replayed, type Viewer } from '../lib/read/context.ts'
import {
  stakeholderJson as readStakeholderJson,
  stakeholderRows,
  type EmailRow as ReadEmailRow,
  type StakeholderRow as ReadStakeholderRow,
} from '../lib/read/stakeholders.ts'
import type { AppDeps, AppEnv } from '../types.ts'

interface StakeholderRow extends ReadStakeholderRow { org_id: string }
interface EmailRow extends ReadEmailRow { org_id: string }

function databaseMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : ''
}

async function getStakeholder(db: D1Database, orgId: string, id: string): Promise<StakeholderRow | null> {
  return db.prepare('SELECT * FROM stakeholders WHERE org_id = ? AND id = ? AND archived_at IS NULL')
    .bind(orgId, id).first<StakeholderRow>()
}

async function getEmails(db: D1Database, orgId: string, stakeholderId: string): Promise<EmailRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM stakeholder_emails WHERE org_id = ? AND stakeholder_id = ? ORDER BY created_at, id`,
  ).bind(orgId, stakeholderId).all<EmailRow>()
  return results
}

function viewerOf(c: Context<AppEnv>): Viewer {
  const auth = c.get('auth')
  const org = c.get('org')
  return { access: org.access, fullAccess: false, pii: org.pii, userId: auth.user.id, email: auth.user.email }
}

async function stakeholderWriteJson(c: Context<AppEnv>, deps: AppDeps, row: StakeholderRow, emails?: EmailRow[]) {
  const ctx = await loadReadContext(c.env.DB, c.get('config'), row.org_id, viewerOf(c), deps.now())
  const rows = await stakeholderRows(ctx, row.id)
  rows.stakeholders = [row]
  if (emails) rows.emails.set(row.id, emails)
  const auth = c.get('auth')
  rows.addedBy.set(auth.user.id, auth.user.displayName ?? auth.user.email ?? auth.user.id)
  const state = replayed(ctx, { asOf: ctx.today, asKnownAt: null })
  const holder = engine.computeMetrics(state).holders.find((item) => item.stakeholderId === row.id)
  return api.stakeholderSchema.parse(readStakeholderJson(ctx, row, rows, state, state, holder))
}

function emailJson(row: EmailRow, addedBy: string | null): api.StakeholderEmail {
  return api.stakeholderEmailSchema.parse({
    id: row.id,
    email: row.email,
    kind: row.kind,
    contactName: row.contact_name,
    contactRole: row.contact_role,
    authorizingDocumentId: row.authorizing_document_id,
    addedBy,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  })
}

function audit(c: Context<AppEnv>, now: number, action: string, orgId: string, targetType: string, targetId: string, details: Record<string, unknown>, reason?: string) {
  const auth = c.get('auth')
  return insertAudit(c.env.DB, {
    occurredAt: now,
    orgId,
    actorUserId: auth.user.id,
    actorEmail: auth.user.email,
    authMethod: auth.authMethod,
    action,
    targetType,
    targetId,
    result: 'success',
    reason: reason ?? null,
    ip: clientIp(c),
    userAgent: userAgent(c),
    details,
  })
}

async function validateAuthorizingDocument(db: D1Database, orgId: string, documentId: string | undefined): Promise<void> {
  if (!documentId) return
  const found = await db.prepare('SELECT 1 FROM documents WHERE org_id = ? AND id = ? AND archived_at IS NULL')
    .bind(orgId, documentId).first()
  if (!found) throw notFound('Authorizing document not found')
}

async function assertIssuerAssignedIdAvailable(
  db: D1Database,
  orgId: string,
  issuerAssignedId: string | null | undefined,
  exceptId?: string,
): Promise<void> {
  if (!issuerAssignedId) return
  const duplicate = await db.prepare(
    `SELECT 1 FROM stakeholders
     WHERE org_id = ? AND issuer_assigned_id = ? AND archived_at IS NULL AND (? IS NULL OR id <> ?)`,
  ).bind(orgId, issuerAssignedId, exceptId ?? null, exceptId ?? null).first()
  if (duplicate) {
    throw new ApiError('conflict', 'That issuer-assigned ID is already in use', undefined, { reason: 'state_changed' })
  }
}

async function assertDuplicateEmailAcknowledged(
  db: D1Database,
  orgId: string,
  emails: readonly string[],
  acknowledge: readonly string[],
  exceptStakeholderId?: string,
): Promise<void> {
  if (emails.length === 0 || acknowledge.includes('DUPLICATE_EMAIL')) return
  const duplicate = await db.prepare(
    `SELECT 1 FROM stakeholder_emails
     WHERE org_id = ? AND removed_at IS NULL
       AND lower(email) IN (SELECT lower(value) FROM json_each(?))
       AND (? IS NULL OR stakeholder_id <> ?) LIMIT 1`,
  ).bind(orgId, JSON.stringify(emails), exceptStakeholderId ?? null, exceptStakeholderId ?? null).first()
  if (duplicate) {
    throw new ApiError('warnings_unacknowledged', 'Review the warning before continuing', undefined, {
      warnings: [{ code: 'DUPLICATE_EMAIL', message: 'This e-mail is already used by another stakeholder' }],
    })
  }
}

export function stakeholderRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>()

  routes.post('/', async (c) => {
    const input = await readJson(c, api.createStakeholderRequestSchema)
    const orgId = c.req.param('orgId')!
    const mutation = await prepareIdempotency(c, orgId, 'POST /api/orgs/:orgId/stakeholders', input)
    if (mutation.replay) return mutation.replay
    for (const item of input.emails) await validateAuthorizingDocument(c.env.DB, orgId, item.authorizingDocumentId)
    if (new Set(input.emails.map((item) => item.email)).size !== input.emails.length) {
      throw new ApiError('validation_failed', 'Remove duplicate e-mail addresses')
    }
    await assertDuplicateEmailAcknowledged(
      c.env.DB, orgId, input.emails.map((item) => item.email), input.acknowledge,
    )
    await assertIssuerAssignedIdAvailable(c.env.DB, orgId, input.issuerAssignedId)
    const now = deps.now()
    const auth = c.get('auth')
    const row: StakeholderRow = {
      id: crypto.randomUUID(), org_id: orgId, kind: input.kind, display_name: input.displayName,
      legal_name: input.legalName ?? null, relationship: input.relationship,
      issuer_assigned_id: input.issuerAssignedId ?? null,
      address: input.address ? JSON.stringify(input.address) : null,
      phone: input.phone ?? null, country_of_residence: input.countryOfResidence ?? null,
      tax_status: input.taxStatus, hire_date: input.hireDate ?? null, comments: input.comments ?? null,
      portal_access: 'auto', outside_counsel: 0,
      archived_at: null, merged_into_id: null, merged_by_command_id: null, version: 1, pulley_id: null,
    }
    const emails: EmailRow[] = input.emails.map((item) => ({
      id: crypto.randomUUID(), org_id: orgId, stakeholder_id: row.id, email: item.email,
      kind: item.kind, contact_name: item.contactName ?? null,
      contact_role: item.contactRole ?? null, authorizing_document_id: item.authorizingDocumentId ?? null,
      added_by: auth.user.id, created_at: now, removed_at: null,
    }))
    const body = await stakeholderWriteJson(c, deps, row, emails)
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        "INSERT INTO batch_assertions (ok) SELECT EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')",
      ).bind(orgId),
      c.env.DB.prepare(
        `INSERT INTO stakeholders
         (id, org_id, kind, display_name, legal_name, relationship, issuer_assigned_id, address, phone,
          country_of_residence, tax_status, hire_date, comments, portal_access, outside_counsel, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, 1, ?, ?)`,
      ).bind(row.id, orgId, row.kind, row.display_name, row.legal_name, row.relationship, row.issuer_assigned_id,
        row.address, row.phone, row.country_of_residence, row.tax_status, row.hire_date, row.comments,
        row.outside_counsel, now, now),
      ...emails.map((item) => c.env.DB.prepare(
        `INSERT INTO stakeholder_emails
         (id, org_id, stakeholder_id, email, kind, contact_name, contact_role,
          authorizing_document_id, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(item.id, orgId, row.id, item.email, item.kind, item.contact_name,
        item.contact_role, item.authorizing_document_id, auth.user.id, now)),
      audit(c, now, 'stakeholder.created', orgId, 'stakeholder', row.id, {
        kind: row.kind, relationship: row.relationship, emailCount: emails.length,
      }),
    ]
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, statements, 201, body, now)
      return replay ?? c.json(body, 201)
    } catch (error) {
      if (databaseMessage(error).includes('batch assertion failed')) {
        throw new ApiError('conflict', 'The company changed; refresh and try again', undefined, { reason: 'state_changed' })
      }
      if (databaseMessage(error).includes('unique constraint failed')) {
        throw new ApiError('conflict', 'The stakeholder conflicts with an existing record', undefined, { reason: 'state_changed' })
      }
      throw error
    }
  })

  routes.patch('/:id', async (c) => {
    const input = await readJson(c, api.patchStakeholderRequestSchema)
    const orgId = c.req.param('orgId')!
    const id = c.req.param('id')!
    const mutation = await prepareIdempotency(c, orgId, 'PATCH /api/orgs/:orgId/stakeholders/:id', input)
    if (mutation.replay) return mutation.replay
    const current = await getStakeholder(c.env.DB, orgId, id)
    if (!current) throw notFound('Stakeholder not found')
    if (current.version !== input.version) throw new ApiError('conflict', 'The stakeholder changed; refresh and try again', undefined, { reason: 'stale_version' })
    if (current.relationship === 'ex_employee' && input.relationship !== undefined) {
      throw new ApiError('conflict', 'Reverse the termination before changing this relationship', undefined, { reason: 'state_changed' })
    }
    await assertIssuerAssignedIdAvailable(c.env.DB, orgId, input.issuerAssignedId, id)
    const now = deps.now()
    const updated: StakeholderRow = {
      ...current,
      kind: input.kind ?? current.kind,
      display_name: input.displayName ?? current.display_name,
      legal_name: input.legalName === undefined ? current.legal_name : input.legalName,
      relationship: input.relationship ?? current.relationship,
      issuer_assigned_id: input.issuerAssignedId === undefined ? current.issuer_assigned_id : input.issuerAssignedId,
      address: input.address === undefined ? current.address : input.address === null ? null : JSON.stringify(input.address),
      phone: input.phone === undefined ? current.phone : input.phone,
      country_of_residence: input.countryOfResidence === undefined ? current.country_of_residence : input.countryOfResidence,
      tax_status: input.taxStatus ?? current.tax_status,
      hire_date: input.hireDate === undefined ? current.hire_date : input.hireDate,
      comments: input.comments === undefined ? current.comments : input.comments,
      portal_access: input.portalAccess ?? current.portal_access,
      outside_counsel: current.outside_counsel,
      version: current.version + 1,
    }
    const body = await stakeholderWriteJson(c, deps, updated)
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, [
        c.env.DB.prepare(
          `UPDATE stakeholders SET kind = ?, display_name = ?, legal_name = ?, relationship = ?, issuer_assigned_id = ?,
           address = ?, phone = ?, country_of_residence = ?, tax_status = ?, hire_date = ?, comments = ?,
           portal_access = ?, outside_counsel = ?, version = ?, updated_at = ?
           WHERE org_id = ? AND id = ? AND version = ?`,
        ).bind(updated.kind, updated.display_name, updated.legal_name, updated.relationship, updated.issuer_assigned_id,
          updated.address, updated.phone, updated.country_of_residence, updated.tax_status, updated.hire_date,
          updated.comments, updated.portal_access, updated.outside_counsel, updated.version, now, orgId, id, input.version),
        c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
        audit(c, now, 'stakeholder.updated', orgId, 'stakeholder', id, {
          fields: Object.keys(input).filter((key) => key !== 'version'),
        }),
      ], 200, body, now)
      return replay ?? c.json(body)
    } catch (error) {
      const message = databaseMessage(error)
      if (message.includes('unique constraint failed')) {
        throw new ApiError('conflict', 'That issuer-assigned ID is already in use', undefined, { reason: 'state_changed' })
      }
      if (message.includes('stale version') || message.includes('batch assertion failed')) {
        throw new ApiError('conflict', 'The stakeholder changed; refresh and try again', undefined, { reason: 'stale_version' })
      }
      throw error
    }
  })

  routes.post('/:id/emails', async (c) => {
    const input = await readJson(c, api.addStakeholderEmailRequestSchema)
    const orgId = c.req.param('orgId')!
    const stakeholderId = c.req.param('id')!
    const mutation = await prepareIdempotency(c, orgId, 'POST /api/orgs/:orgId/stakeholders/:id/emails', input)
    if (mutation.replay) return mutation.replay
    const stakeholder = await getStakeholder(c.env.DB, orgId, stakeholderId)
    if (!stakeholder) throw notFound('Stakeholder not found')
    await assertNotSelfDealing(c.env.DB, orgId, c.get('auth').user.email ?? '', [stakeholderId])
    await assertDuplicateEmailAcknowledged(c.env.DB, orgId, [input.email], input.acknowledge, stakeholderId)
    await validateAuthorizingDocument(c.env.DB, orgId, input.authorizingDocumentId)
    const now = deps.now()
    const row: EmailRow = {
      id: crypto.randomUUID(), org_id: orgId, stakeholder_id: stakeholderId, email: input.email,
      kind: input.kind, contact_name: input.contactName ?? null,
      contact_role: input.contactRole ?? null, authorizing_document_id: input.authorizingDocumentId ?? null,
      added_by: c.get('auth').user.id, created_at: now, removed_at: null,
    }
    const body = emailJson(row, c.get('auth').user.displayName ?? c.get('auth').user.email)
    try {
      const replay = await commitIdempotent(c.env.DB, mutation, [
        c.env.DB.prepare(
          `INSERT INTO stakeholder_emails
           (id, org_id, stakeholder_id, email, kind, contact_name, contact_role,
            authorizing_document_id, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(row.id, orgId, stakeholderId, row.email, row.kind, row.contact_name,
          row.contact_role, row.authorizing_document_id, row.added_by, now),
        audit(c, now, 'stakeholder_email.added', orgId, 'stakeholder_email', row.id, {
          stakeholderId, kind: row.kind,
        }),
      ], 201, body, now)
      return replay ?? c.json(body, 201)
    } catch (error) {
      if (databaseMessage(error).includes('unique constraint failed')) {
        throw new ApiError('conflict', 'That e-mail is already active on this stakeholder', undefined, { reason: 'state_changed' })
      }
      throw error
    }
  })

  routes.post('/:id/emails/:emailId/remove', async (c) => {
    const input = await readJson(c, api.removeStakeholderEmailRequestSchema)
    const orgId = c.req.param('orgId')!
    const stakeholderId = c.req.param('id')!
    const emailId = c.req.param('emailId')!
    const mutation = await prepareIdempotency(c, orgId, 'POST /api/orgs/:orgId/stakeholders/:id/emails/:emailId/remove', input)
    if (mutation.replay) return mutation.replay
    if (!await getStakeholder(c.env.DB, orgId, stakeholderId)) throw notFound('Stakeholder not found')
    await assertNotSelfDealing(c.env.DB, orgId, c.get('auth').user.email ?? '', [stakeholderId])
    const row = (await getEmails(c.env.DB, orgId, stakeholderId))
      .find((item) => item.id === emailId && item.removed_at === null)
    if (!row) throw notFound('Stakeholder e-mail not found')
    const now = deps.now()
    const removed = { ...row, removed_at: now }
    const body = emailJson(removed, c.get('auth').user.displayName ?? c.get('auth').user.email)
    const replay = await commitIdempotent(c.env.DB, mutation, [
      c.env.DB.prepare(
        `UPDATE stakeholder_emails SET removed_at = ?, removed_by = ?
         WHERE org_id = ? AND stakeholder_id = ? AND id = ? AND removed_at IS NULL`,
      ).bind(now, c.get('auth').user.id, orgId, stakeholderId, emailId),
      audit(c, now, 'stakeholder_email.removed', orgId, 'stakeholder_email', emailId, {
        stakeholderId, kind: row.kind,
      }, input.reason),
    ], 200, body, now)
    return replay ?? c.json(body)
  })

  return routes
}
