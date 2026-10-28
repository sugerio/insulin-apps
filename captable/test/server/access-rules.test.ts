import { afterEach, describe, expect, it } from 'vitest'
import {
  addEmail, linkAdmin, readHarness, type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

describe('write access and self-dealing rules', () => {
  it('blocks an administrator linked to the affected stakeholder', async () => {
    harness = await readHarness()
    await linkAdmin(harness.db, harness.orgId, 'OWNER@example.test', harness.id('S04'))
    const response = await harness.api('POST', harness.path('/stakeholders/S04-placeholder/emails'), harness.owner, {
      email: 'another@example.test', kind: 'contact',
    })
    expect(response.status).toBe(404)
    const affected = await harness.api('POST', harness.path(`/stakeholders/${harness.id('S04')}/emails`), harness.owner, {
      email: 'another@example.test', kind: 'contact',
    })
    expect(affected.status).toBe(403)
    expect(await affected.json()).toMatchObject({ error: { code: 'self_dealing' } })
  })

  it('blocks a case-insensitive stakeholder e-mail match and permits unrelated stakeholders', async () => {
    harness = await readHarness()
    await addEmail(harness.db, harness.orgId, harness.id('S04'), 'OWNER@EXAMPLE.TEST')
    const blocked = await harness.api('POST', harness.path(`/stakeholders/${harness.id('S04')}/emails`), harness.owner, {
      email: 'secondary@example.test', kind: 'contact',
    })
    expect(blocked.status).toBe(403)
    const allowed = await harness.api('POST', harness.path(`/stakeholders/${harness.id('S05')}/emails`), harness.owner, {
      email: 's05@example.test', kind: 'self',
    })
    expect(allowed.status).toBe(201)
  })

  it('admin links are company-scoped, idempotent, removable, and editor-readable', async () => {
    harness = await readHarness()
    const body = { email: 'manager@example.test', stakeholderId: harness.id('S04'), source: 'admin' }
    const key = crypto.randomUUID()
    const created = await harness.api('POST', harness.path('/admin-links'), harness.admin, body, { 'Idempotency-Key': key })
    expect(created.status).toBe(201)
    const link = await created.json() as { id: string }
    const replay = await harness.api('POST', harness.path('/admin-links'), harness.admin, body, { 'Idempotency-Key': key })
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
    const listed = await harness.api('GET', harness.path('/admin-links'), harness.editor)
    expect(await listed.json()).toMatchObject({ items: [{ id: link.id, email: 'manager@example.test' }] })
    const removed = await harness.api('POST', harness.path(`/admin-links/${link.id}/remove`), harness.owner, { reason: 'Role ended' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ removedAt: expect.any(Number), removedBy: 'owner-user' })
  })

  it('audits and refuses removing the administrator link that names the caller', async () => {
    harness = await readHarness()
    const id = await linkAdmin(harness.db, harness.orgId, 'OWNER@example.test', harness.id('S04'))
    const response = await harness.api(
      'POST', harness.path(`/admin-links/${id}/remove`), harness.owner, { reason: 'Trying to bypass the guard' },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'self_dealing' } })
    expect(await harness.db.prepare('SELECT removed_at FROM admin_stakeholder_links WHERE id = ?').bind(id).first('removed_at'))
      .toBeNull()
    expect(await harness.db.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'access.denied' AND reason = 'self_dealing' AND target_id = ?",
    ).bind(id).first<number>('n')).toBe(1)
  })
})
