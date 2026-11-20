// Review round 18 and the final Cloudflare run: a passage is cited by the pages (or slides) it runs over, carried
// from the container through the Worker (pageEnd, optional in the contract); and IMP-07's plan refit from both
// later runs.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prompt } from '../src/answer.ts'
import { SETTINGS } from '../src/settings.ts'
import { createHash } from 'node:crypto'
import { type FileSpec, type TestEngine, ask, createCollection, doc, learn, log, makeEngine } from './helpers.ts'

const logged = async (t: TestEngine, event: string) => (await log(t, 'c1')).filter((e: any) => e.event === event)

test('a search carries each passage\'s pages from the container: page and pageEnd', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  const box = t.container('c1') as any
  const search = box.search.bind(box)
  box.search = (body: any) => {
    const found = search(body)
    return { ...found, passages: found.passages.map((p: any) => ({ ...p, page: 1, pageEnd: 4 })) }
  }
  const res = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(res.body.status, 'ok')
  assert.deepEqual([res.body.passages[0].page, res.body.passages[0].pageEnd], [1, 4])
})

test('the answer model is told the pages a passage runs over: "pages 1–4", or "page 4"', () => {
  const [, user] = prompt({
    question: 'Which threshold?',
    passages: [
      { passageId: 'p1', documentName: 'Release.pdf', page: 1, pageEnd: 4, text: 'Release gate: 99.6 percent.' },
      { passageId: 'p2', documentName: 'Deck.pptx', page: 4, pageEnd: 4, text: 'Gate.' },
      { passageId: 'p3', documentName: 'Old.pdf', page: 2, text: 'An engine before pageEnd.' },
      { passageId: 'p4', documentName: 'Notes.md', page: null, pageEnd: null, text: 'No pages.' },
    ],
  })
  assert.match(user.content, /\[1\] Release\.pdf, pages 1–4\n/)
  assert.match(user.content, /\[2\] Deck\.pptx, page 4\n/)
  assert.match(user.content, /\[3\] Old\.pdf, page 2\n/)
  assert.match(user.content, /\[4\] Notes\.md\n/)
})

test('POST /v1/answer takes each passage\'s pageEnd, and answers without it', async () => {
  const t = makeEngine()
  const passages = [{ passageId: 'p1', documentName: 'Release.pdf', page: 1, pageEnd: 4, text: 'The billing gateway listens on port 8443.' }]
  assert.equal((await t.api('POST', '/v1/answer', { question: 'Which port?', passages })).status, 200)
  assert.match(t.ai.calls.at(-1)!.input.messages[1].content, /Release\.pdf, pages 1–4/)
  const older = [{ passageId: 'p1', documentName: 'Release.pdf', page: 3, text: 'The billing gateway listens on port 8443.' }]
  assert.equal((await t.api('POST', '/v1/answer', { question: 'Which port?', passages: older })).status, 200)
  assert.match(t.ai.calls.at(-1)!.input.messages[1].content, /Release\.pdf, page 3\n/)
})

// ==================================================================== IMP-07's plan

/** 50 short Markdown documents of about 500 bytes, as IMP-07's corpus. */
function shortDocs(from: number): FileSpec[] {
  return Array.from({ length: 50 }, (_, i) => {
    const n = from + i
    const line = `Document ${n} of the size test: team ${n % 17} reviewed it, and its gateway port is ${8000 + n}. `
    return { fileId: `s${n}`, name: `${n}-doc.md`, text: line.repeat(Math.ceil(500 / line.length)).slice(0, 500) }
  })
}

test('IMP-07 the engine\'s plan at the try\'s start holds both later runs\' imports of 50 short documents within 25%', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'size-0', shortDocs(0)) // the container starts from the image
  await learn(t, 'c1', 'size-1', shortDocs(50)) // learned in the awake container
  const [cold, warm] = (await logged(t, 'job-done')).map((e: any) => e.plannedSeconds)
  // Measured, submission to commit (harness): g1118a 314 s from the image, 269-285 s in the awake container; the
  // final run (g1118b) 250.4 s and 211.5-224.8 s.
  for (const measured of [314, 250.4]) assert.ok(Math.abs(measured - cold) <= 0.25 * cold, `${measured} s against a plan of ${cold} s`)
  for (const measured of [269, 285, 211.5, 224.8]) assert.ok(Math.abs(measured - warm) <= 0.25 * warm, `${measured} s against a plan of ${warm} s`)
  assert.ok(SETTINGS.perDocumentOneByOneSeconds > SETTINGS.perDocumentSeconds, 'a later try, one at a time, plans more per document')
})

// ==================================================================== an answer the model gave no text for

const PASSAGES = [{ passageId: 'p1', documentName: 'Gateway.md', page: null, text: 'The billing gateway listens on port 8443.' }]
const CUT_OFF = { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
const WRITTEN = { choices: [{ message: { content: 'The billing gateway listens on port 8443 [1].' }, finish_reason: 'stop' }] }

/** Workers AI answers with `replies` in turn. */
function aiReplies(t: ReturnType<typeof makeEngine>, replies: unknown[]) {
  let n = 0
  ;(t.ai as any).run = async (model: string, input: Record<string, unknown>) => {
    t.ai.calls.push({ model, input })
    return replies[Math.min(n++, replies.length - 1)]
  }
}

test('the answer model is asked without reasoning (documented: chat_template_kwargs.enable_thinking) and with room to answer', async () => {
  const t = makeEngine()
  aiReplies(t, [WRITTEN])
  assert.equal((await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })).status, 200)
  const input = t.ai.calls[0].input
  assert.deepEqual(input.chat_template_kwargs, { enable_thinking: false })
  assert.ok(input.max_completion_tokens >= 1000, `max_completion_tokens ${input.max_completion_tokens}`)
  assert.equal(input.max_tokens, undefined, 'max_tokens is deprecated for this model')
})

test('an answer cut off with no text (all its tokens spent reasoning) is asked once more, and written', async () => {
  const t = makeEngine()
  aiReplies(t, [CUT_OFF, WRITTEN])
  const res = await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.citations, [1])
  assert.equal(t.ai.calls.length, 2)
})

test('cut off twice, or empty without being cut off, answers 503 model_unavailable', async () => {
  const t = makeEngine()
  aiReplies(t, [CUT_OFF, CUT_OFF, WRITTEN])
  const twice = await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })
  assert.deepEqual([twice.status, twice.body.error, t.ai.calls.length], [503, 'model_unavailable', 2])
  t.ai.calls.length = 0
  aiReplies(t, [{ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, WRITTEN])
  const empty = await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })
  assert.deepEqual([empty.status, empty.body.error, t.ai.calls.length], [503, 'model_unavailable', 1])
})

// ==================================================================== a backup and R2's transient refusals

test('DEL-01 a backup stores identical content once, and rides over R2 refusing a read for its rate (10058)', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  const box = t.container('c1')
  box.data.set('copies/a.bin', 'the same bytes')
  box.data.set('copies/b.bin', 'the same bytes')
  box.data.set('copies/c.bin', 'the same bytes')
  const heads: string[] = []
  const puts: string[] = []
  const head = t.backups.head.bind(t.backups)
  const put = t.backups.put.bind(t.backups)
  let refused = 0
  ;(t.backups as any).head = async (key: string) => {
    heads.push(key)
    if (refused < 1) {
      refused += 1
      throw new Error('head: Reduce your rate of simultaneous reads on the same object. (10058)')
    }
    return head(key)
  }
  ;(t.backups as any).put = async (key: string, value: unknown, options?: any) => {
    puts.push(key)
    return put(key, value, options)
  }
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep, backed up
  assert.deepEqual(await logged(t, 'backup-failed'), [])
  assert.equal((await logged(t, 'backup')).length, 1)
  const blob = (text: string) => `backups/org-acme/c1/blobs/${createHash('sha256').update(text).digest('hex')}`
  assert.equal(puts.filter((k) => k === blob('the same bytes')).length, 1, 'stored once')
  assert.equal(heads.filter((k) => k === blob('the same bytes')).length, 1, 'checked once')
  const blobs = heads.filter((k) => k.includes('/blobs/'))
  assert.equal(new Set(blobs).size, blobs.length - 1, 'no key checked twice, but the one R2 refused')
  // And it comes back from that backup: every copy of the shared content is put back.
  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  assert.equal((await ask(t, 'c1', 'topic number 1 gateway port')).body.status, 'ok')
  assert.deepEqual(['copies/a.bin', 'copies/b.bin', 'copies/c.bin'].map((path) => box.data.get(path)), ['the same bytes', 'the same bytes', 'the same bytes'])
})

test('an R2 error that isn\'t transient fails the backup at once', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  let heads = 0
  ;(t.backups as any).head = async () => {
    heads += 1
    throw new Error('head: Access denied. (10002)')
  }
  t.advance(11 * 60_000)
  await t.drain('c1')
  assert.equal((await logged(t, 'backup-failed')).length, 1)
  assert.equal(heads, 1)
})
