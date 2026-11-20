import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// Who can do what (design section 08), for every route and way in: the plans ACC-01 to ACC-18, DEL-02, DEL-04 and
// HIS-06 of design section 17, against the in-memory engine.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const mcp = (person: Person): Person => ({ ...person, via: 'mcp' })
const search = (person: Person, ids: string[], query = 'partner discounts') => h.json<Record<string, any>>(person, 'POST', '/api/search', { collections: ids, query })
const listIds = async (person: Person) => (await h.json<{ collections: { id: string }[] }>(person, 'GET', '/api/collections')).body.collections.map((collection) => collection.id)

describe('collections are private until shared', () => {
  it('ACC-01 a new collection is private: only its owner lists it, organization owners see a basic row, nobody else', async () => {
    const id = await h.collection(PEOPLE.maya, 'e2e-private')
    expect(await listIds(PEOPLE.maya)).toEqual([id])
    for (const person of [PEOPLE.leo, PEOPLE.ada, PEOPLE.sam, PEOPLE.eli, PEOPLE.apps]) expect(await listIds(person)).not.toContain(id)
    const others = await h.json<{ collections: { id: string }[] }>(PEOPLE.sam, 'GET', '/api/collections/others')
    expect(others.body.collections.map((collection) => collection.id)).toEqual([id])
    // Must catch: the Admin's list doesn't contain it (over the API too).
    expect(await listIds(mcp(PEOPLE.ada))).not.toContain(id)
  })

  it('ACC-02 Viewers can\'t start a collection', async () => {
    const response = await h.call(PEOPLE.leo, 'POST', '/api/collections', { name: 'Not allowed' })
    expect(response.status).toBe(403)
    const catalog = await h.json<{ endpoints: { method: string; path: string }[] }>(PEOPLE.leo, 'GET', '/api/catalog')
    expect(catalog.body.endpoints.some((entry) => entry.method === 'POST' && entry.path === '/api/collections')).toBe(false)
  })

  it('ACC-03 an Admin in Knowledge without a collection role gets 403 on content, history and export', async () => {
    const id = await h.collection(PEOPLE.maya, 'e2e-private')
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    for (const admin of [PEOPLE.ada, PEOPLE.apps]) {
      for (const person of [admin, mcp(admin)]) {
        expect((await search(person, [id])).status).toBe(403)
        expect((await h.call(person, 'GET', `/api/collections/${id}/sources`)).status).toBe(403)
        expect((await h.call(person, 'GET', `/api/collections/${id}/facts`)).status).toBe(403)
        expect((await h.call(person, 'GET', `/api/collections/${id}/history`)).status).toBe(403)
      }
      expect((await h.call(admin, 'POST', '/api/ask', { collections: [id], question: 'discounts?' })).status).toBe(403)
      // Must catch: export answers 403.
      expect((await h.call(admin, 'POST', `/api/collections/${id}/exports`)).status).toBe(403)
    }
  })

  it('ACC-04 an organization owner sees basic information only, and can\'t open, ask or export', async () => {
    const id = await h.collection(PEOPLE.maya, 'Board prep', 'Secret purpose sentence')
    await h.note(PEOPLE.maya, id, 'A confidential source sentence about partner discounts.')
    const others = await h.call(PEOPLE.dana, 'GET', '/api/collections/others')
    const text = await others.text()
    const row = (JSON.parse(text) as { collections: Record<string, any>[] }).collections[0]!
    expect(Object.keys(row).sort()).toEqual(['bytes', 'createdAt', 'documents', 'id', 'keepReady', 'lastUsedAt', 'name', 'owner', 'sharing'])
    expect(row).toMatchObject({ name: 'Board prep', owner: { id: PEOPLE.maya.id, name: 'Maya Example' }, documents: 1 })
    // Must catch: no purpose, source or fact text in the response.
    expect(text).not.toContain('Secret purpose')
    expect(text).not.toContain('confidential')
    expect((await h.call(PEOPLE.dana, 'GET', `/api/collections/${id}`)).status).toBe(403)
    expect((await search(PEOPLE.dana, [id])).status).toBe(403)
    expect((await h.call(PEOPLE.dana, 'POST', `/api/collections/${id}/exports`)).status).toBe(403)
  })

  it('ACC-05 an organization admin gets no owner powers', async () => {
    const id = await h.collection(PEOPLE.maya)
    expect((await h.call(PEOPLE.ada, 'GET', '/api/collections/others')).status).toBe(403)
    // Must catch: the delete's 403.
    expect((await h.call(PEOPLE.ada, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })).status).toBe(403)
  })
})

describe('the collection role matrix', () => {
  it('ACC-06 each collection role may do exactly what section 08 says', async () => {
    const id = await h.collection(PEOPLE.maya)
    expect(await h.share(PEOPLE.maya, id, PEOPLE.eli, 'ADMIN')).toBe(200)
    expect(await h.share(PEOPLE.maya, id, PEOPLE.ada, 'EDITOR')).toBe(200)
    expect(await h.share(PEOPLE.maya, id, PEOPLE.apps, 'VIEWER')).toBe(200)
    const roles: [Person, string][] = [[PEOPLE.maya, 'OWNER'], [PEOPLE.eli, 'ADMIN'], [PEOPLE.ada, 'EDITOR'], [PEOPLE.apps, 'VIEWER']]
    const allowed = {
      ask: ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'],
      report: ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'],
      change: ['OWNER', 'ADMIN', 'EDITOR'],
      remove: ['OWNER', 'ADMIN'],
      share: ['OWNER', 'ADMIN'],
      settings: ['OWNER', 'ADMIN'],
      export: ['OWNER', 'ADMIN'],
      transfer: ['OWNER'],
      delete: ['OWNER'],
    }
    for (const [person, role] of roles) {
      expect((await h.json<{ role: string }>(person, 'GET', `/api/collections/${id}`)).body.role).toBe(role)
      const outcomes: Record<string, number> = {
        ask: (await search(person, [id])).status,
        report: (await h.call(person, 'POST', `/api/collections/${id}/reports`, { question: 'Is this right?' })).status,
        change: (await h.call(person, 'POST', `/api/collections/${id}/notes`, { text: `A note from ${role}.` })).status,
        remove: (await h.call(person, 'DELETE', `/api/collections/${id}/sources/no-such-document`)).status,
        share: (await h.call(person, 'PUT', `/api/collections/${id}/sharing/general`, { role: null })).status,
        settings: (await h.call(person, 'PATCH', `/api/collections/${id}`, { purpose: `Purpose by ${role}` })).status,
        export: (await h.call(person, 'POST', `/api/collections/${id}/exports`)).status,
        transfer: role === 'OWNER' ? 0 : (await h.call(person, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id })).status,
        delete: role === 'OWNER' ? 0 : (await h.call(person, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })).status,
      }
      for (const [action, roles] of Object.entries(allowed)) {
        if (outcomes[action] === 0) continue
        const refused = outcomes[action] === 403
        expect({ role, action, refused }).toEqual({ role, action, refused: !roles.includes(role) })
      }
    }
    // Must catch: a collection Editor's share attempt answers 403.
    expect((await h.call(PEOPLE.ada, 'PUT', `/api/collections/${id}/sharing/person/${PEOPLE.leo.id}`, { role: 'VIEWER' })).status).toBe(403)
  })

  it('ACC-07 the Viewer cap: a Viewer in Knowledge shared as Editor acts as Viewer', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'EDITOR')
    const sharing = await h.json<{ shares: { id: string; actsAsViewer: boolean }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sharing`)
    expect(sharing.body.shares.find((share) => share.id === PEOPLE.leo.id)?.actsAsViewer).toBe(true)
    expect((await h.json<{ role: string }>(PEOPLE.leo, 'GET', `/api/collections/${id}`)).body.role).toBe('VIEWER')
    // Must catch: adding a source answers 403, in the browser and over the API.
    expect((await h.call(PEOPLE.leo, 'POST', `/api/collections/${id}/notes`, { text: 'Not allowed.' })).status).toBe(403)
    expect((await h.call(mcp(PEOPLE.leo), 'POST', `/api/collections/${id}/notes`, { text: 'Not allowed.' })).status).toBe(403)
  })

  it('ACC-08 the highest role wins, and removing a share takes it back', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.call(PEOPLE.maya, 'PUT', `/api/collections/${id}/sharing/general`, { role: 'VIEWER' })
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    expect((await h.call(PEOPLE.eli, 'POST', `/api/collections/${id}/notes`, { text: 'Eli adds a note.' })).status).toBe(202)
    await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${id}/sharing/person/${PEOPLE.eli.id}`)
    // Must catch: adding a source fails after the removal.
    expect((await h.call(PEOPLE.eli, 'POST', `/api/collections/${id}/notes`, { text: 'Eli adds another.' })).status).toBe(403)
    expect((await h.json<{ role: string }>(PEOPLE.eli, 'GET', `/api/collections/${id}`)).body.role).toBe('VIEWER')
  })

  it('ACC-09 general access stops at Editor, and a collection Admin can\'t change the owner\'s role', async () => {
    const id = await h.collection(PEOPLE.maya)
    const admin = await h.json<{ error: string }>(PEOPLE.maya, 'PUT', `/api/collections/${id}/sharing/general`, { role: 'ADMIN' })
    // Must catch: the 400.
    expect(admin.status).toBe(400)
    expect((await h.call(PEOPLE.maya, 'PUT', `/api/collections/${id}/sharing/general`, { role: 'EDITOR' })).status).toBe(200)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'ADMIN')
    expect((await h.call(PEOPLE.eli, 'PUT', `/api/collections/${id}/sharing/person/${PEOPLE.maya.id}`, { role: 'VIEWER' })).status).toBe(403)
    expect((await h.call(PEOPLE.eli, 'DELETE', `/api/collections/${id}/sharing/person/${PEOPLE.maya.id}`)).status).toBe(403)
    expect(await h.share(PEOPLE.eli, id, PEOPLE.leo, 'EDITOR')).toBe(200)
  })

  it('ACC-10 transfer goes to an Editor in Knowledge, the old owner becomes an Admin; a Viewer is refused', async () => {
    const id = await h.collection(PEOPLE.maya)
    // Must catch: the refusal.
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.leo.id })).status).toBe(400)
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id })).status).toBe(200)
    expect((await h.json<{ role: string }>(PEOPLE.eli, 'GET', `/api/collections/${id}`)).body.role).toBe('OWNER')
    expect((await h.json<{ role: string }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)).body.role).toBe('ADMIN')
    expect(h.gateway.mail.some((mail) => mail.to === PEOPLE.eli.email && /now yours/.test(mail.subject))).toBe(true)
  })

  it('ACC-11 custom roles narrow powers: without edit everything acts as Viewer; without export no export', async () => {
    const noEdit: Person = { ...PEOPLE.maya, permissions: ['knowledge.use', 'knowledge.collections.create', 'knowledge.collections.share', 'knowledge.collections.export'] }
    const id = await h.collection(PEOPLE.maya)
    expect((await h.json<{ role: string }>(noEdit, 'GET', `/api/collections/${id}`)).body.role).toBe('VIEWER')
    expect((await h.call(noEdit, 'POST', `/api/collections/${id}/notes`, { text: 'Not allowed.' })).status).toBe(403)
    expect((await h.call(noEdit, 'POST', `/api/collections/${id}/exports`)).status).toBe(403)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'ADMIN')
    const noExport: Person = { ...PEOPLE.eli, permissions: ['knowledge.use', 'knowledge.collections.edit', 'knowledge.collections.share'] }
    expect((await h.json<{ role: string }>(noExport, 'GET', `/api/collections/${id}`)).body.role).toBe('ADMIN')
    // Must catch: the export refusal.
    expect((await h.call(noExport, 'POST', `/api/collections/${id}/exports`)).status).toBe(403)
    expect((await h.call({ ...PEOPLE.eli }, 'POST', `/api/collections/${id}/exports`)).status).toBe(202)
  })

  it('ACC-12 sharing, unsharing, settings, export, transfer and delete are browser-only', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.client, 'ADMIN')
    const adminClient: Person = { ...PEOPLE.client, role: 'ADMIN' }
    for (const person of [mcp(PEOPLE.maya), adminClient]) {
      const refusals = [
        await h.call(person, 'PUT', `/api/collections/${id}/sharing/person/${PEOPLE.leo.id}`, { role: 'VIEWER' }),
        await h.call(person, 'DELETE', `/api/collections/${id}/sharing/person/${PEOPLE.leo.id}`),
        await h.call(person, 'PUT', `/api/collections/${id}/sharing/general`, { role: 'VIEWER' }),
        await h.call(person, 'GET', `/api/collections/${id}/sharing`),
        await h.call(person, 'PATCH', `/api/collections/${id}`, { name: 'Renamed' }),
        await h.call(person, 'POST', `/api/collections/${id}/exports`),
        await h.call(person, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id }),
        await h.call(person, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' }),
        await h.call(person, 'GET', '/api/members?q=a'),
      ]
      for (const response of refusals) {
        expect(response.status).toBe(403)
        expect(((await response.json()) as { error: string }).error).toBe('browser_only')
      }
    }
    // Must catch: the API delete's 403, and the collection is still there.
    expect((await h.json<{ role: string }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)).status).toBe(200)
  })

  it('ACC-13 another organization\'s collections don\'t exist: 404, the same as an unknown id, every way in', async () => {
    const id = await h.collection(PEOPLE.maya)
    for (const person of [PEOPLE.outsider, mcp(PEOPLE.outsider), { ...PEOPLE.outsider, via: 'api' as const }]) {
      const theirs = await h.call(person, 'GET', `/api/collections/${id}`)
      const unknown = await h.call(person, 'GET', '/api/collections/00000000-0000-4000-8000-000000000000')
      // Must catch: no 403 that would reveal the id exists.
      expect(theirs.status).toBe(404)
      expect(await theirs.json()).toEqual(await unknown.json())
      expect((await search(person, [id])).status).toBe(404)
    }
    expect((await h.call(PEOPLE.outsider, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })).status).toBe(404)
    expect(await listIds(PEOPLE.outsider)).toEqual([])
  })

  it('ACC-14 forged identity headers do nothing: the organization role only when the deploy trusts it, permissions only narrow', async () => {
    await h.collection(PEOPLE.maya)
    h.env.TRUST_ORG_ROLE = false
    const forged: Person = { ...PEOPLE.leo, orgRole: 'OWNER', permissions: ['knowledge.use', 'knowledge.rules.manage', 'knowledge.collections.create'] }
    // Must catch: the "Other collections" list stays absent.
    expect((await h.call(forged, 'GET', '/api/collections/others')).status).toBe(403)
    expect((await h.call(forged, 'POST', '/api/collections', { name: 'Forged' })).status).toBe(403)
    expect((await h.call(forged, 'GET', '/api/rules')).status).toBe(403)
    expect((await h.json<{ isOrganizationOwner: boolean }>(forged, 'GET', '/api/me')).body.isOrganizationOwner).toBe(false)
    // Trusted, an API client still has no organization role.
    h.env.TRUST_ORG_ROLE = true
    const client = await h.call({ ...PEOPLE.client, role: 'ADMIN' }, 'GET', '/api/collections/others', undefined, { 'x-suger-org-role': 'OWNER' })
    expect(client.status).toBe(403)
  })
})

describe('people who leave, return or change role', () => {
  it('ACC-15 shares go on hold when someone leaves and come back when they return, with "Welcome back"', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    await h.tick() // takes the first cursor
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.eli.id })
    await h.tick()
    expect((await search(PEOPLE.eli, [id])).status).toBe(403)
    const held = await h.json<{ shares: { id: string; status: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sharing`)
    expect(held.body.shares.find((share) => share.id === PEOPLE.eli.id)?.status).toBe('on_hold')
    h.gateway.addEvent({ type: 'returned', org: ORG, user: PEOPLE.eli.id, orgRole: 'EDITOR', appRole: 'EDITOR' })
    await h.tick()
    // Must catch: the shares come back.
    expect((await search(PEOPLE.eli, [id])).status).toBe(200)
    expect(h.gateway.mail.some((mail) => mail.to === PEOPLE.eli.email && /back/i.test(mail.text))).toBe(true)
  })

  it('ACC-15 a first "returned" for someone Knowledge never held changes nothing', async () => {
    await h.tick()
    h.gateway.addEvent({ type: 'returned', org: ORG, user: 'u-new-person', orgRole: 'VIEWER', appRole: 'VIEWER' })
    await h.tick()
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE principal_id = 'u-new-person'`).first('n')).toBe(0)
    expect(h.gateway.mail).toEqual([])
  })

  it('ACC-16 an owner leaves: the longest-standing organization owner takes the collection; ownership doesn\'t come back', async () => {
    const id = await h.collection(PEOPLE.maya)
    const elis = await h.collection(PEOPLE.eli, 'Eli\'s notes')
    await h.share(PEOPLE.eli, elis, PEOPLE.maya, 'VIEWER')
    await h.tick()
    h.gateway.addEvent({ type: 'owners', org: ORG, owners: [{ user: PEOPLE.sam.id, since: '2025-06-01T00:00:00Z' }, { user: PEOPLE.dana.id, since: '2024-01-01T00:00:00Z' }] })
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.maya.id })
    await h.tick()
    // Must catch: the owner is the longest-standing one.
    expect((await h.json<{ role: string }>(PEOPLE.dana, 'GET', `/api/collections/${id}`)).body.role).toBe('OWNER')
    expect((await h.call(PEOPLE.sam, 'GET', `/api/collections/${id}`)).status).toBe(403)
    expect(h.gateway.mail.some((mail) => mail.to === PEOPLE.dana.email && /is now yours/.test(mail.text))).toBe(true)
    h.gateway.addEvent({ type: 'returned', org: ORG, user: PEOPLE.maya.id, orgRole: 'EDITOR', appRole: 'EDITOR' })
    await h.tick()
    expect((await h.json<{ role: string }>(PEOPLE.maya, 'GET', `/api/collections/${elis}`)).body.role).toBe('VIEWER')
    expect((await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}`)).status).toBe(403)
  })

  it('ACC-17 an owner becomes a Viewer: the organization owner owns it, the former owner can still ask', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    h.gateway.addEvent({ type: 'role_changed', org: ORG, user: PEOPLE.maya.id, orgRole: 'VIEWER', appRole: 'VIEWER' })
    await h.tick()
    expect((await h.json<{ role: string }>(PEOPLE.dana, 'GET', `/api/collections/${id}`)).body.role).toBe('OWNER')
    const demoted: Person = { ...PEOPLE.maya, role: 'VIEWER', orgRole: 'VIEWER' }
    // Must catch: the former owner can still ask.
    const asked = await search(demoted, [id])
    expect(asked.status).toBe(200)
    expect(asked.body.covered).toBe(true)
    expect((await h.json<{ role: string }>(demoted, 'GET', `/api/collections/${id}`)).body.role).toBe('VIEWER')
  })

  it('ACC-18 the member lookup shows at most 20 people who can use Knowledge, with name, address and role only', async () => {
    h.gateway.setMember(ORG, 'u-nora', { appRole: null, name: 'Nora No-Knowledge', email: 'nora@example.test' })
    for (let index = 0; index < 30; index += 1) h.gateway.setMember(ORG, `u-many-${index}`, { appRole: 'VIEWER', name: `Many ${index}`, email: `many${index}@example.test` })
    const nora = await h.json<{ members: Record<string, unknown>[] }>(PEOPLE.apps, 'GET', '/api/members?q=nora')
    // Must catch: a member without Knowledge isn't found.
    expect(nora.body.members).toEqual([])
    const many = await h.json<{ members: Record<string, unknown>[] }>(PEOPLE.apps, 'GET', '/api/members?q=many')
    expect(many.body.members).toHaveLength(20)
    expect(Object.keys(many.body.members[0]!).sort()).toEqual(['appRole', 'email', 'id', 'name', 'type'])
    const client = await h.json<{ members: { type: string; email: unknown }[] }>(PEOPLE.apps, 'GET', '/api/members?q=crm')
    expect(client.body.members).toEqual([expect.objectContaining({ type: 'client', email: null })])
  })
})

describe('deleting, exporting and history', () => {
  it('DEL-02 the owner and an organization owner delete after typing the name; the owner hears; an Admin is refused', async () => {
    const mine = await h.collection(PEOPLE.maya, 'Mine')
    const theirs = await h.collection(PEOPLE.maya, 'Board prep')
    // Must catch: the Admin's refusal.
    expect((await h.call(PEOPLE.ada, 'DELETE', `/api/collections/${theirs}`, { confirmName: 'Board prep' })).status).toBe(403)
    expect((await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${mine}`, { confirmName: 'mine' })).status).toBe(400)
    expect((await h.json<{ state: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${mine}`, { confirmName: 'Mine' })).body.state).toBe('deleted')
    expect(h.gateway.mail.filter((mail) => /deleted/.test(mail.subject))).toEqual([])
    expect((await h.call(PEOPLE.dana, 'DELETE', `/api/collections/${theirs}`, { confirmName: 'Board prep' })).status).toBe(202)
    expect(h.gateway.mail.some((mail) => mail.to === PEOPLE.maya.email && /an owner of your organization, deleted “Board prep”/.test(mail.text))).toBe(true)
    expect(await listIds(PEOPLE.maya)).toEqual([])
    expect(await h.db.prepare(`SELECT action FROM activity ORDER BY at, action`).all()).toMatchObject({ results: [{ action: 'deleted' }, { action: 'deleted_by_org_owner' }] })
  })

  it('DEL-04 only the collection\'s Owner and Admins export; Editors, Viewers, organization owners, API clients and assistants are refused', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    await h.share(PEOPLE.maya, id, PEOPLE.client, 'ADMIN')
    await h.share(PEOPLE.maya, id, PEOPLE.ada, 'ADMIN')
    for (const person of [PEOPLE.eli, PEOPLE.leo, PEOPLE.dana, { ...PEOPLE.client, role: 'ADMIN' as const }, mcp(PEOPLE.maya)]) {
      expect((await h.call(person, 'POST', `/api/collections/${id}/exports`)).status).toBe(403)
    }
    const made = await h.json<{ export: { exportId: string; state: string } }>(PEOPLE.ada, 'POST', `/api/collections/${id}/exports`)
    expect(made.status).toBe(202)
    const file = await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/exports/${made.body.export.exportId}?download=1`)
    expect(file.headers.get('content-disposition')).toMatch(/attachment/)
    expect((await h.call(PEOPLE.eli, 'GET', `/api/collections/${id}/exports/${made.body.export.exportId}`)).status).toBe(403)
  })

  it('HIS-06 going back to before a share doesn\'t change sharing', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'First version of the partner rules.')
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    h.clock.advance(6 * 60_000) // changes within 5 minutes would share one restore point
    await h.note(PEOPLE.maya, id, 'Second version of the partner rules.')
    const back = await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/history/1/go-back`)
    expect(back.status).toBe(200)
    // Must catch: the share survives.
    expect((await h.json<{ role: string }>(PEOPLE.leo, 'GET', `/api/collections/${id}`)).body.role).toBe('VIEWER')
  })
})
