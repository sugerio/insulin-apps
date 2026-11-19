// A removal for good that learns kept documents again (they shared entities with it, and Cognee kept the removed
// spelling: container/ops.py rebuild_shared_entities) plans their time, so its job isn't stopped before it can finish
// (F219: a plan of under 100 s and an hour's limit for 6 MiB of text to learn again, about 88 minutes).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCollection, doc, learn, log, makeEngine } from './helpers.ts'

const MiB = 1024 * 1024

test('F219 a removal that learns 6 MiB of kept documents again plans them, and runs past an hour without being stopped', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2), doc(3), doc(4)])
  const documents = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  const target = documents.find((d: any) => d.name === 'doc-4.md')
  const kept = documents.filter((d: any) => d !== target).map((d: any) => d.documentId)
  // The container's removal says, before it learns them, which kept documents it learns again and their text.
  t.cloud.hangJobs = ['remove']
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  box.serve = async (request: Request) => {
    const response = await serve(request)
    if (request.method !== 'GET' || !new URL(request.url).pathname.startsWith('/jobs/remove')) return response
    const job = (await response.json()) as any
    job.progress = { ...(job.progress ?? {}), relearning: { documentIds: kept, textBytes: 6 * MiB } }
    if (job.result) job.result.relearning = { documentIds: kept, textBytes: 6 * MiB, ms: 95 * 60_000 } // and its result, how long it took
    return Response.json(job)
  }
  assert.equal((await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)).status, 200)
  for (let minute = 1; minute <= 100; minute++) {
    t.advance(60_000)
    await t.drain('c1', { steps: 8 })
  }
  const events = await log(t, 'c1')
  assert.ok(!events.some((e: any) => e.event === 'import-try-failed'), events.filter((e: any) => e.event === 'import-try-failed').map((e: any) => e.reason).join())
  const record = (await t.object('c1').store.listImports()).find((r: any) => r.kind === 'remove') as any
  assert.deepEqual(record.rereadDocumentIds, kept, 'its plan counts the kept documents')
  assert.equal(record.storedTextBytes, 6 * MiB)
  assert.equal(record.status.attempt, 1, 'still its first try, at 100 minutes')
  t.cloud.hangJobs = []
  await t.drain('c1', { steps: 200 })
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 3)
  // Its commit says which kept documents it learned again, their text, how long, and the plan that counted them.
  const committed = (await log(t, 'c1')).filter((e: any) => e.event === 'committed').at(-1) as any
  assert.equal(committed.kind, 'remove')
  assert.deepEqual([committed.relearned, committed.relearnedTextBytes, committed.relearnMs], [kept, 6 * MiB, 95 * 60_000])
  assert.ok(committed.plannedSeconds > 5_000, `${committed.plannedSeconds} s planned for 6 MiB learned again`)
})

test('F219 a removal that learns nothing again says so where it commits', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-2.md')
  await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  await t.drain('c1', { steps: 200 })
  const committed = (await log(t, 'c1')).filter((e: any) => e.event === 'committed').at(-1) as any
  assert.deepEqual([committed.kind, committed.relearned, committed.relearnedTextBytes, committed.relearnMs], ['remove', [], 0, 0])
  assert.ok(committed.plannedSeconds > 0 && committed.plannedSeconds < 200, `${committed.plannedSeconds} s: one removal, nothing learned again`)
})
