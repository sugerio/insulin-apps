// Follow-ups from the engine's second run on Cloudflare (g1118a):
// - an import learned in the container already running plans no container start, and documents are planned at the
//   run's grouped rate (IMP-07: warm imports came in at 74-78% of their plan);
// - the save step logs each of its parts' times, and the query process's reopening after a commit its own
//   (FIX-01 misses its 2 minutes by about 10 s: where do the 53-55 s of saving go?).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type FileSpec, type TestEngine, createCollection, learn, log, makeEngine } from './helpers.ts'

const logged = async (t: TestEngine, event: string) => (await log(t, 'c1')).filter((e: any) => e.event === event)

/** 50 short Markdown documents of about 500 bytes, as IMP-07's corpus. */
function shortDocs(from: number): FileSpec[] {
  return Array.from({ length: 50 }, (_, i) => {
    const n = from + i
    const line = `Document ${n} of the size test: team ${n % 17} reviewed it, and its gateway port is ${8000 + n}. `
    return { fileId: `s${n}`, name: `${n}-doc.md`, text: line.repeat(Math.ceil(500 / line.length)).slice(0, 500) }
  })
}

const within = (planned: number, measured: number, share: number) => Math.abs(planned - measured) <= measured * share

test('IMP-07 an import learned in the running container plans no container start; 50 short documents plan near what the run measured', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'size-0', shortDocs(0)) // the container starts from the image
  await learn(t, 'c1', 'size-1', shortDocs(50)) // the container is still awake: learned in it
  assert.equal(t.cloud.starts.length, 1, 'one container for both')
  const [first, warm] = (await logged(t, 'job-done')).map((e: any) => e.plannedSeconds)
  // The run (standard-4, one container for all ten imports): size-0 314 s, size-1..9 269-280 s (harness, incl. staging).
  assert.ok(within(first, 314, 0.15), `the first import plans ${first} s; it took 314 s`)
  assert.ok(within(warm, 276, 0.15), `a warm import plans ${warm} s; they took 269-280 s`)
  assert.equal(first - warm, 30, 'the difference is the container start')
})

test('FIX-01 the save step logs the time of each of its parts, and the query process its reopening after the commit', async () => {
  const t = makeEngine()
  await createCollection(t)
  // Each call to the container takes a second of the clock, so every part takes time.
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  box.serve = async (request: Request) => {
    t.advance(1_000)
    return serve(request)
  }
  await learn(t, 'c1', 'imp-1', shortDocs(0).slice(0, 2))
  const [saved] = await logged(t, 'saved')
  assert.ok(saved, 'a saved line')
  assert.equal(saved.importId, 'imp-1')
  const parts = ['quiesceMs', 'statsMs', 'manifestMs', 'textsMs', 'factsMs', 'snapshotMs', 'commitMs']
  for (const part of parts) assert.ok(Number.isFinite(saved[part]) && saved[part] >= 0, `${part}: ${saved[part]}`)
  assert.ok(saved.statsMs >= 1_000 && saved.manifestMs >= 1_000 && saved.textsMs >= 2_000, JSON.stringify(saved))
  assert.equal(saved.totalMs, parts.reduce((sum, part) => sum + saved[part], 0))
  const ready = (await logged(t, 'ready')).at(-1)
  assert.ok(Number.isFinite(ready.openMs) && ready.openMs >= 1_000, `reopened in ${ready.openMs} ms`)
  assert.ok(Number.isFinite(ready.sinceCommitMs) && ready.sinceCommitMs >= ready.openMs, JSON.stringify(ready))
})
