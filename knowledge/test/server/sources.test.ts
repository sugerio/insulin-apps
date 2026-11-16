import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// Adding files, web pages and notes, and how imports wait and queue: plans IMP-01, IMP-02, IMP-08, IMP-09 and IMP-11's
// plain messages, against the in-memory engine.

let h: Harness
afterEach(() => h?.close())

const encoder = new TextEncoder()
const TEXT_PDF = `%PDF-1.4\n1 0 obj << /Type /Page /Resources << /Font << /F1 2 0 R >> >> >>\nstream\nBT /F1 12 Tf (Partner discounts stop at 20 percent on the PDF.) Tj ET\nendstream\nendobj\n%%EOF\n`
const SCANNED_PDF = `%PDF-1.4\n1 0 obj << /Type /Page /Resources << /XObject << /Im1 2 0 R >> >> >>\nendobj\n2 0 obj << /Type /XObject /Subtype /Image /Width 10 /Height 10 >>\nstream\n\u0001\u0002\u0003\nendstream\nendobj\n%%EOF\n`

/** Preflight, upload and learn files, as the site does; returns the import's answer. */
async function addFiles(person: Person, id: string, files: { name: string; text: string }[], options: { expectRefused?: string[] } = {}) {
  const preflight = await h.json<{ files: { name: string; accepted: boolean; fileId?: string; reason?: string }[] }>(person, 'POST', `/api/collections/${id}/preflight`, {
    files: files.map((file) => ({ name: file.name, bytes: encoder.encode(file.text).byteLength })),
  })
  expect(preflight.status).toBe(200)
  const accepted: string[] = []
  for (const file of preflight.body.files) {
    if (!file.accepted) continue
    const bytes = encoder.encode(files.find((candidate) => candidate.name === file.name)!.text)
    const uploaded = await h.json<{ accepted: boolean; reason: string | null }>(person, 'PUT', `/api/collections/${id}/uploads/${file.fileId}`, bytes, { 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' })
    expect(uploaded.status).toBe(200)
    if (uploaded.body.accepted) accepted.push(file.fileId!)
  }
  return { preflight: preflight.body.files, accepted }
}

describe('preflight and imports', () => {
  it('IMP-01 preflight and the upload name the files that can\'t be learned; only the rest are learned', async () => {
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya)
    const files = [
      { name: 'Signed form.pdf', text: SCANNED_PDF },
      { name: 'Budget.xlsm', text: 'macros' },
      { name: 'Rules.pdf', text: TEXT_PDF },
      { name: 'Partners.md', text: '# Partners\n\nGold partners get a named contact.' },
      { name: 'Pricing.txt', text: 'Private offers need a quote number.' },
      { name: 'Page.html', text: '<html><body><p>Resellers sign the reseller terms.</p></body></html>' },
      { name: 'Plan.docx', text: 'The plan is reviewed every quarter.' },
    ]
    const { preflight, accepted } = await addFiles(PEOPLE.maya, id, files)
    expect(preflight.find((file) => file.name === 'Budget.xlsm')).toMatchObject({ accepted: false, reason: expect.stringMatching(/type Insulin can't read.*\.xlsx/) })
    const scanned = preflight.find((file) => file.name === 'Signed form.pdf')!
    expect(accepted).toHaveLength(5)
    expect(accepted).not.toContain(scanned.fileId)
    const refused = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: [...accepted, scanned.fileId] })
    expect(refused.status).toBe(400)
    expect(refused.body.message).toMatch(/“Signed form.pdf” is a scanned image with no text/)
    const started = await h.json<{ import: { importId: string; files: { name: string; state: string }[] } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: accepted })
    expect(started.status).toBe(202)
    // Must catch: the scanned PDF never enters the batch.
    expect(started.body.import.files.map((file) => file.name).sort()).toEqual(['Page.html', 'Partners.md', 'Plan.docx', 'Pricing.txt', 'Rules.pdf'])
    await h.tick()
    const sources = await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)
    expect(sources.body.sources).toHaveLength(5)
    expect(h.gateway.mail.some((mail) => mail.to === PEOPLE.maya.email && /learned 5 files/.test(mail.text))).toBe(true)
    // The same files again change nothing: "already here".
    const again = await addFiles(PEOPLE.maya, id, files.slice(3, 5))
    const duplicate = await h.json<{ import: { state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: again.accepted })
    expect(duplicate.body.import.state).toBe('duplicate')
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE org_id = ? AND state = 'held'`).bind(ORG).first('n')).toBe(0)
  })

  it('IMP-02 a file over the size limit is refused at preflight; more than 2 MB of text says what was learned', async () => {
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya)
    const big = await h.json<{ files: { accepted: boolean; reason: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'Deck.pptx', bytes: 26 * 1024 * 1024 }] })
    // Must catch: the 26 MB refusal.
    expect(big.body.files[0]).toMatchObject({ accepted: false, reason: expect.stringMatching(/26 MB; the largest file your organization can add is 25 MB/) })
    const long = 'Partner programs pay rebates every quarter. '.repeat(50_000)
    const { accepted } = await addFiles(PEOPLE.maya, id, [{ name: 'Long.txt', text: long }])
    const learned = await h.json<{ import: { files: { state: string; reason?: string }[] } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: accepted })
    expect(learned.body.import.files[0]).toMatchObject({ state: 'learned', reason: 'Only the first 2 MB of its text was learned.' })
    // An upload larger than the limit is refused while it streams, whatever preflight was told.
    const small = await h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'Liar.txt', bytes: 10 }] })
    h.gateway.limits = { status: 200, pages: [{ defaults: { file_bytes: 1000 }, organizations: [] }] }
    await h.tick()
    const tooBig = await h.json<{ error: string; limit: string }>(PEOPLE.maya, 'PUT', `/api/collections/${id}/uploads/${small.body.files[0]!.fileId}`, encoder.encode('x'.repeat(5000)), { 'x-file-name': 'Liar.txt' })
    expect(tooBig.status).toBe(429)
    expect(tooBig.body.limit).toBe('file_bytes')
  })

  it('IMP-08 questions wait while a collection learns, and answers include the new files after the commit', async () => {
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    h.engine.control.hold(true)
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'Gold partners get a named contact for renewals.', title: 'Gold' })).status).toBe(202)
    const mcp = await h.json<Record<string, any>>({ ...PEOPLE.leo, via: 'mcp' }, 'POST', '/api/search', { collections: [id], query: 'gold partners named contact' })
    expect(mcp.body).toMatchObject({ status: 'learning', covered: false, passages: [] })
    expect(mcp.body.retryAfterSeconds).toBeGreaterThan(0)
    const site = await h.json<Record<string, any>>(PEOPLE.leo, 'POST', '/api/ask', { collections: [id], question: 'Who do gold partners contact?' })
    // Must catch: no answer from a half-learned collection.
    expect(site.body).toMatchObject({ outcome: 'waiting', status: 'learning', text: null, sources: [] })
    expect(site.body.message).toMatch(/“Partner Programs” is learning\. Questions wait/)
    h.engine.control.hold(false)
    await h.tick()
    const after = await h.json<Record<string, any>>(PEOPLE.leo, 'POST', '/api/ask', { collections: [id], question: 'Who do gold partners contact for renewals?' })
    expect(after.body.outcome).toBe('answered')
    expect(after.body.citations[0].documentName).toBe('Gold')
  })

  it('IMP-09 a third import waits behind two, and a correction jumps ahead of a queued large import', async () => {
    h = await createHarness({ timing: { importMs: 1000, perDocumentMs: 100 } })
    const [a, b, c, d] = [await h.collection(PEOPLE.maya, 'A'), await h.collection(PEOPLE.maya, 'B'), await h.collection(PEOPLE.maya, 'C'), await h.collection(PEOPLE.maya, 'D')]
    const start = async (id: string, count: number) => {
      const { accepted } = await addFiles(PEOPLE.maya, id, Array.from({ length: count }, (_, index) => ({ name: `File ${id.slice(0, 4)} ${index}.txt`, text: `Fact number ${index} about collection ${id}.` })))
      return (await h.json<{ import: { importId: string; state: string; waitingFor: string | null } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: accepted })).body.import
    }
    const first = await start(a, 1)
    const second = await start(b, 10)
    const third = await start(c, 50)
    expect([first.state, second.state]).toEqual(['learning', 'learning'])
    expect(third).toMatchObject({ state: 'queued', waitingFor: 'organization' })
    const correction = await h.json<{ import: { importId: string; state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${d}/corrections`, { text: 'Partner discounts stop at 15 percent.' })
    expect(correction.body.import.state).toBe('queued')
    h.clock.advance(1100) // A finishes: its slot goes to the correction, not to the large import queued before it
    const status = async (id: string, importId: string) => (await h.json<{ import: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${importId}`)).body.import.state
    expect(await status(d, correction.body.import.importId)).toBe('learning')
    expect(await status(c, third.importId)).toBe('queued')
    h.clock.advance(1100)
    // Must catch: the correction finishes first.
    expect(await status(d, correction.body.import.importId)).toBe('committed')
    expect(await status(c, third.importId)).toBe('learning')
    h.clock.advance(10_000)
    expect(await status(c, third.importId)).toBe('committed')
  })
})

describe('web pages', () => {
  const page = '<html><head><title>Reseller terms</title></head><body><p>Resellers renew every year in March.</p></body></html>'

  it('IMP-11 fetches a public page and learns it; private or unreachable addresses get plain words', async () => {
    const asked: string[] = []
    h = await createHarness({
      env: {
        WEB_FETCH: (async (input: RequestInfo | URL) => {
          const url = String(input)
          asked.push(url)
          if (url.startsWith('https://www.example.com/terms')) return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          if (url.startsWith('https://www.example.com/moved')) return new Response(null, { status: 302, headers: { location: 'http://192.168.1.10/admin' } })
          throw new TypeError('connect ECONNREFUSED')
        }) as typeof fetch,
      },
    })
    const id = await h.collection(PEOPLE.maya)
    const added = await h.json<{ import: { files: { name: string; state: string }[] }; page: { title: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/web-pages`, { url: 'https://www.example.com/terms' })
    expect(added.status).toBe(202)
    expect(added.body.import.files[0]).toMatchObject({ name: 'Reseller terms.html', state: 'learned' })
    const again = await h.json<{ import: { state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/web-pages`, { url: 'https://www.example.com/terms' })
    expect(again.body.import.state).toBe('duplicate')
    for (const [url, message] of [
      ['http://10.0.0.5/wiki', /Only public web pages/],
      ['http://localhost:8080/', /Only public web pages/],
      ['https://www.example.com/moved', /Only public web pages/],
      ['ftp://www.example.com/file', /Only web pages/],
      ['https://unreachable.example.com/', /Couldn't reach that page/],
    ] as const) {
      const refused = await h.json<{ message: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/web-pages`, { url })
      expect(refused.status).toBeGreaterThanOrEqual(400)
      // Must catch: no raw error text on screen.
      expect(refused.body.message).toMatch(message)
      expect(refused.body.message).not.toMatch(/ECONNREFUSED|TypeError/)
    }
    expect(asked).not.toContain('http://192.168.1.10/admin')
  })
})
