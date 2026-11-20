// Waking and sleeping: questions answer at once ("waking"), the checksum check finishes before any database opens,
// the container sleeps awakeMinutes after the last question, keep-ready windows follow the organization's time
// zone, and the running-time ledger reaches the outbox.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextWindowStart, windowAt, zonedToUtc } from '../src/keep-ready.ts'
import { clock } from '../src/util.ts'
import { ask, createCollection, doc, learn, log, makeEngine, outboxEvents } from './helpers.ts'

async function asleepCollection() {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'asleep')
  return t
}

test('an empty collection answers at once without a container', async () => {
  const t = makeEngine()
  await createCollection(t)
  const res = await t.api('POST', '/v1/collections/c1/search', { query: 'anything' })
  assert.deepEqual({ status: res.body.status, covered: res.body.covered, passages: res.body.passages }, { status: 'ok', covered: false, passages: [] })
  assert.equal(t.cloud.starts.length, 0)
})

test('AGT-05 an asleep collection answers "waking" at once, and the wake goes start → check → open', async () => {
  const t = await asleepCollection()
  t.cloud.queryPolls = 2
  const startsBefore = t.cloud.starts.length
  const first = await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 1 gateway port' })
  assert.equal(first.body.status, 'waking')
  assert.ok(first.body.retryAfterSeconds > 0)
  assert.equal(t.cloud.starts.length, startsBefore, 'the request itself never starts or waits for a container')
  const steps = new Set<number>()
  for (let i = 0; i < 20; i++) {
    const status = (await t.api('GET', '/v1/collections/c1')).body
    if (status.wake) steps.add(status.wake.step)
    if (status.state === 'ready') break
    await t.drain('c1', { steps: 1 })
  }
  assert.deepEqual([...steps].sort(), [1, 2, 3])
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  assert.equal(answer.body.covered, true)
  assert.equal(answer.body.passages[0].documentName, 'doc-1.md')
})

test('ASK-06 the checksum check finishes before the databases open; models load meanwhile', async () => {
  const t = await asleepCollection()
  t.cloud.calls.length = 0
  await ask(t, 'c1', 'topic number 1 gateway port')
  const calls = t.cloud.calls.filter((c) => c.collection.endsWith(':c1')).map((c) => c.detail ?? `${c.method} ${c.path}`)
  const queryStart = calls.indexOf('POST /query/start')
  const manifest = calls.indexOf('manifest')
  const open = calls.indexOf('open')
  assert.ok(queryStart >= 0 && manifest >= 0 && open >= 0, calls.join(', '))
  assert.ok(queryStart < open && manifest < open, 'models load during the check; nothing opens until it passed')
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(entries.lastIndexOf('checksum-ok') < entries.lastIndexOf('query-open-requested'))
})

test('a query process that opened /data during the check is started again', async () => {
  const t = await asleepCollection()
  await t.api('POST', '/v1/collections/c1/search', { query: 'x' })
  await t.drain('c1', { steps: 1 })
  t.container('c1').query.earlyOpen = true
  await t.drain('c1', { steps: 1 })
  t.container('c1').query.earlyOpen = false
  await t.drain('c1')
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'query-opened-early'))
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'ready')
})

test('sleeps awakeMinutes after the last question, and writes awake time to the outbox', async () => {
  const t = await asleepCollection()
  await ask(t, 'c1', 'topic number 1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'ready')
  t.advance(5 * 60_000)
  await ask(t, 'c1', 'topic number 1 again')
  t.advance(6 * 60_000)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'ready', 'a question moved the sleep')
  t.advance(5 * 60_000)
  await t.drain('c1', { horizonMs: 60_000 })
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.state, 'asleep')
  assert.equal(t.container('c1').running, false)
  await t.drain('c1', { horizonMs: 60_000 })
  const usage = (await outboxEvents(t)).filter((e) => e.type === 'usage')
  const awake = usage.filter((e) => e.kind === 'awake').reduce((s, e) => s + e.seconds, 0)
  assert.ok(awake >= 15 * 60, `awake seconds ${awake}`)
  assert.ok(usage.some((e) => e.kind === 'learning'))
})

test('the first sleep of a day with changes writes a backup', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.ok(status.lastBackupAt)
  assert.ok(t.backups.keys().some((k) => k.endsWith('latest.json')))
  assert.ok((await outboxEvents(t)).some((e) => e.type === 'backup' && e.version === 1))
})

test('keep-ready windows follow the time zone, across a clock change', () => {
  const keepReady = { timeZone: 'Europe/Berlin', days: [1, 2, 3, 4, 5], start: '09:00', hours: 2, paused: false }
  // Monday 2026-11-16, 09:00 in Berlin is 08:00 UTC (winter time).
  const monday = zonedToUtc(2026, 11, 16, 9, 0, 'Europe/Berlin')
  assert.equal(new Date(monday).toISOString(), '2026-11-16T08:00:00.000Z')
  assert.deepEqual(windowAt(keepReady, monday + 30 * 60_000), { start: monday, end: monday + 2 * 3600_000 })
  assert.equal(windowAt(keepReady, monday + 2 * 3600_000), null)
  assert.equal(nextWindowStart(keepReady, monday + 3 * 3600_000), monday + 24 * 3600_000)
  // Saturday and Sunday are skipped: Friday 20th, then Monday 23rd.
  const friday = zonedToUtc(2026, 11, 20, 9, 0, 'Europe/Berlin')
  assert.equal(nextWindowStart(keepReady, friday + 3600_000), zonedToUtc(2026, 11, 23, 9, 0, 'Europe/Berlin'))
  // Summer time: 09:00 in Berlin on Monday 2026-06-15 is 07:00 UTC.
  assert.equal(new Date(zonedToUtc(2026, 6, 15, 9, 0, 'Europe/Berlin')).toISOString(), '2026-06-15T07:00:00.000Z')
  assert.equal(windowAt({ ...keepReady, paused: true }, monday + 60_000), null)
})

test('LIM-10 a keep-ready window wakes the collection at its start, counts as kept ready, and lets it sleep after', async () => {
  const t = await asleepCollection()
  // It is Monday 2026-11-16, about 09:22 UTC: a window from 11:00 Berlin (10:00 UTC) for 1 hour.
  await t.api('PUT', '/v1/collections/c1', { settings: { keepReady: { timeZone: 'Europe/Berlin', days: [1], start: '11:00', hours: 1, paused: false } } })
  const windowStart = Date.parse('2026-11-16T10:00:00Z')
  const alarm = t.storage('c1').alarm!
  assert.ok(alarm <= windowStart, 'an alarm is set for the window')
  const startsBefore = t.cloud.starts.length
  t.advance(windowStart - clock.now())
  await t.drain('c1')
  assert.ok(t.cloud.starts.length > startsBefore, 'woken for the window')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'ready')
  t.advance(70 * 60_000)
  await t.drain('c1', { horizonMs: 60_000 })
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'asleep')
  const ready = (await outboxEvents(t)).filter((e) => e.type === 'usage' && e.kind === 'ready').reduce((s, e) => s + e.seconds, 0)
  assert.ok(ready >= 50 * 60, `kept-ready seconds ${ready}`)
})
