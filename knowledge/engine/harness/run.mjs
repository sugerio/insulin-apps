#!/usr/bin/env node
// The Engine-lane harness (design section 17, "Where the plans run"), grown from the PoC's scripts/run-tests.mjs.
// It runs the engine's GATE plans against a throwaway engine on Cloudflare, called the way the Knowledge app calls
// it, and writes a report. README.md ("The Engine-lane harness") has the whole procedure.
//
//   node harness/run.mjs prepare --run <id>     write harness/.run/<id>/ (both Wrangler configs) and print the steps
//   node harness/run.mjs test [options]         run the plans; needs HARNESS_URL and HARNESS_TOKEN
//   node harness/run.mjs cleanup --run <id>     print the commands that delete the run's Workers and buckets
//
// test options:
//   --only IMP-03,ASK-01     run some plans (default: every plan below except the costly ones)
//   --calibrate              ASK-02: read raw scores and suggest the "won't guess" threshold
//   --wakes 20               ASK-06: how many wakes to time (default 5)
//   --fix-runs 10            FIX-01: how many corrections to time (default 3)
//   --soak 10                the PoC's recovery soak (default 0)
//   --size                   also IMP-07: 500 documents in 10 imports (long)
//   --capacity               also IMP-10: 21 imports across 21 organizations at once (21 containers)
//   --image-change before    HIS-03-real, the real image change: learn and back up a collection, and keep its answers
//   --image-change after     after the engine is deployed again with a changed image: it comes back from its backup
//   --label standard-1       a label for the report, e.g. the questions instance this engine was deployed with

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const engineDir = join(here, '..')
const fixtures = join(engineDir, 'test', 'fixtures')
const args = process.argv.slice(2)
const command = args[0]
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)


// ==================================================================== prepare and cleanup

function runId(id) {
  if (!id || !/^[a-z0-9]{1,12}$/.test(id)) throw new Error('--run needs 1 to 12 lower-case letters or digits')
  return id
}

/** JSON with comments, as Wrangler reads wrangler.jsonc. */
function readJsonc(path) {
  const text = readFileSync(path, 'utf8')
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function prepare(id) {
  const run = runId(id)
  const engineName = `insulin-apps-knowledge-engine-e2e-${run}`
  const out = join(here, '.run', run)
  mkdirSync(out, { recursive: true })
  const engine = readJsonc(join(engineDir, 'wrangler.jsonc'))
  engine.name = engineName
  engine.main = '../../../src/index.ts'
  engine.workers_dev = false
  engine.preview_urls = false
  engine.r2_buckets = engine.r2_buckets.map((b) => ({ binding: b.binding, bucket_name: `${engineName}-${b.binding.toLowerCase()}` }))
  engine.containers = engine.containers.map((c) => ({ ...c, images: { base: { dockerfile: '../../../container/Dockerfile' } } }))
  engine.vars = { ENGINE_TEST_CONTROLS: '1', ENGINE_QUESTIONS_INSTANCE: option('questions-instance', 'standard-4') }
  writeFileSync(join(out, 'engine.jsonc'), `${JSON.stringify(engine, null, 2)}\n`)
  const harness = readJsonc(join(here, 'harness.wrangler.jsonc'))
  harness.name = harness.name.replace('RUN', run)
  harness.main = '../../worker.ts'
  harness.services = [{ binding: 'ENGINE', service: engineName }]
  writeFileSync(join(out, 'harness.jsonc'), `${JSON.stringify(harness, null, 2)}\n`)
  const token = randomBytes(24).toString('hex')
  writeFileSync(join(out, 'token'), token)
  console.log(`Wrote harness/.run/${run}/ (git-ignored). With an account selected (CLOUDFLARE_ACCOUNT_ID, a token
allowed to edit Workers, R2 and Containers), from knowledge/engine/:

  npx wrangler r2 bucket create ${engineName}-files
  npx wrangler r2 bucket create ${engineName}-backups
  # The image's dependency layer is large; Wrangler's own registry credential lasts 15 minutes. Build and push
  # the image with a longer-lived credential first if the upload is slow (README.md, "Build gotchas").
  # Logged in with \`wrangler login\`, a deploy that starts near the end of its token's hour fails while the image is
  # prepared, with a bare "Unauthorized"; and the harness's first deploy can answer "This Worker does not exist" right
  # after uploading it. Both work when run again.
  npx wrangler deploy -c harness/.run/${run}/engine.jsonc
  npx wrangler deploy -c harness/.run/${run}/harness.jsonc
  npx wrangler secret put HARNESS_TOKEN -c harness/.run/${run}/harness.jsonc < harness/.run/${run}/token
  HARNESS_URL=https://<the harness's workers.dev address> HARNESS_TOKEN=$(cat harness/.run/${run}/token) node harness/run.mjs test

Then: node harness/run.mjs cleanup --run ${run}`)
}

function cleanup(id) {
  const run = runId(id)
  const engineName = `insulin-apps-knowledge-engine-e2e-${run}`
  console.log(`The run's plans purge their organizations at the end, which empties the buckets. Then:

  npx wrangler delete -c harness/.run/${run}/harness.jsonc
  npx wrangler delete -c harness/.run/${run}/engine.jsonc
  # The containers application outlives the engine Worker: find ${engineName}-collectionengine and delete it by id.
  npx wrangler containers list
  npx wrangler containers delete <its id>
  npx wrangler r2 bucket delete ${engineName}-files
  npx wrangler r2 bucket delete ${engineName}-backups
  # The run's own image tags, when the image was pushed by hand (README, "Build gotchas"):
  npx wrangler containers images list
  npx wrangler containers images delete <repository>:<tag>
  rm -r harness/.run/${run}

Container snapshots can't be deleted. Cloudflare keeps them as tags in the engine image's repository
(rootfs-snapshot-…, rootfs-set-…): deleting one is refused (403), so the repository stays listed until they expire,
30 days after they were made or last restored. With no handle left they can't be opened.`)
}

// ==================================================================== the client

const BASE = (process.env.HARNESS_URL ?? '').replace(/\/$/, '')
const TOKEN = process.env.HARNESS_TOKEN ?? ''
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const ORG = `e2e-org-${stamp}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts)

async function api(method, path, body, { org = ORG, headers = {} } = {}) {
  const started = Date.now()
  const init = { method, headers: { authorization: `Bearer ${TOKEN}`, ...(org ? { 'x-knowledge-org': org } : {}), ...headers } }
  if (body instanceof Uint8Array) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  const response = await fetch(`${BASE}${path}`, init)
  const buffer = new Uint8Array(await response.arrayBuffer())
  let json = null
  try {
    json = JSON.parse(new TextDecoder().decode(buffer))
  } catch {
    // a zip
  }
  return { status: response.status, body: json, bytes: buffer, ms: Date.now() - started }
}

async function must(method, path, body, ok = [200, 202], options) {
  const res = await api(method, path, body, options)
  if (!ok.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 800)}`)
  return res.body
}

const createCollection = (cid, org = ORG) =>
  must('PUT', `/v1/collections/${cid}`, { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] }, keepReady: null, awakeMinutes: 10 } }, [200], { org })

async function stage(cid, file, org = ORG) {
  const bytes = file.bytes ?? new TextEncoder().encode(file.text)
  const sum = sha256(bytes)
  await must('PUT', `/v1/collections/${cid}/inbox/${file.fileId}`, bytes, [200], {
    org,
    headers: { 'content-type': file.type ?? 'text/markdown', 'x-file-name': encodeURIComponent(file.name), 'x-file-sha256': sum },
  })
  return { fileId: file.fileId, name: file.name, type: file.type ?? 'text/markdown', bytes: bytes.length, sha256: sum }
}

async function startImport(cid, importId, files, { notes = [], small = false, org = ORG } = {}) {
  const staged = []
  for (const file of files) staged.push(await stage(cid, file, org))
  return api('POST', `/v1/collections/${cid}/imports`, { importId, files: staged, notes, small }, { org })
}

async function waitImport(cid, importId, { org = ORG, onPoll } = {}) {
  const deadline = Date.now() + 90 * 60_000
  for (;;) {
    const status = await must('GET', `/v1/collections/${cid}/imports/${importId}`, undefined, [200], { org })
    if (onPoll && (await onPoll(status))) return status
    if (['committed', 'duplicate', 'failed', 'cancelled'].includes(status.state)) return status
    if (Date.now() > deadline) throw new Error(`import ${importId} did not finish`)
    await sleep(4000)
  }
}

async function learn(cid, importId, files, options = {}) {
  const started = await startImport(cid, importId, files, options)
  if (![200, 202].includes(started.status)) throw new Error(`import ${importId}: ${started.status} ${JSON.stringify(started.body)}`)
  const done = await waitImport(cid, importId, options)
  log(`  ${importId}: ${done.state} (version ${done.version}, ${files.length} files, attempt ${done.attempt})`)
  return done
}

/** Asks until the collection answers (waking and learning are answered at once; this waits them out). */
async function search(cid, query, { org = ORG, topK, threshold } = {}) {
  const started = Date.now()
  for (let tries = 0; tries < 200; tries++) {
    const res = await api('POST', `/v1/collections/${cid}/search`, { query, ...(topK ? { topK } : {}), ...(threshold !== undefined ? { threshold } : {}) }, { org })
    if (res.status !== 200) throw new Error(`search -> ${res.status} ${JSON.stringify(res.body)}`)
    if (res.body.status === 'ok') return { ...res.body, ms: res.ms, totalMs: Date.now() - started, waited: tries > 0 }
    await sleep(Math.min(10_000, Math.max(1000, (res.body.retryAfterSeconds ?? 5) * 250)))
  }
  throw new Error('the collection never answered')
}

const state = (cid, org = ORG) => must('GET', `/v1/collections/${cid}/__test/state`, undefined, [200], { org })
const control = (cid, action, body = {}, org = ORG) => must('POST', `/v1/collections/${cid}/__test/${action}`, body, [200], { org })

/**
 * Backs a collection up (the `backup` control puts it to sleep, which backs it up) and checks the backup was taken:
 * one lost on the way (the engine logs it and sleeps anyway) is asked for again, so a plan never goes on without it.
 */
async function backUp(cid, org = ORG) {
  const version = (await status(cid, org)).version
  for (let tries = 1; ; tries++) {
    await control(cid, 'backup', {}, org)
    const { meta } = await state(cid, org)
    if (meta.lastBackupVersion === version && !meta.backupDue) return
    if (tries === 3) throw new Error(`no backup of ${cid} version ${version} after 3 tries`)
    log(`  the backup of ${cid} version ${version} wasn't taken; asking again`)
  }
}
const objects = (org = ORG) => must('GET', '/v1/__test/objects', undefined, [200], { org })
const status = (cid, org = ORG) => must('GET', `/v1/collections/${cid}`, undefined, [200], { org })
const points = async (cid, org = ORG) => (await must('GET', `/v1/collections/${cid}/restore-points`, undefined, [200], { org })).restorePoints
const documents = async (cid, org = ORG) => (await must('GET', `/v1/collections/${cid}/documents`, undefined, [200], { org })).documents

async function waitIdle(cid, org = ORG) {
  for (let i = 0; i < 400; i++) {
    const s = await status(cid, org)
    if (!['learning', 'saving', 'going_back', 'repairing', 'waking_from_backup', 'deleting'].includes(s.state) && !s.currentImport && !s.queuedImports) return s
    await sleep(3000)
  }
  throw new Error(`${cid} stayed busy`)
}

// Changes closer than 5 minutes share a restore point; plans that need separate ones wait this long.
const SHARE_WINDOW_MS = Number(process.env.HARNESS_SHARE_WINDOW_MS ?? 5 * 60_000 + 15_000)

// ==================================================================== fixtures

function corpus(batch) {
  const dir = join(fixtures, 'corpus', batch)
  return readdirSync(dir)
    .sort()
    .map((name) => ({ fileId: name.slice(0, 2) + '-' + batch.slice(-3), name, text: readFileSync(join(dir, name), 'utf8') }))
}
const questions = (file) => JSON.parse(readFileSync(join(fixtures, 'questions', file), 'utf8')).questions
const hidingCases = () => JSON.parse(readFileSync(join(fixtures, 'hiding-cases.json'), 'utf8')).cases

let formats = null
function formatFixtures() {
  if (formats) return formats
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-fixtures-'))
  execFileSync('python3', [join(engineDir, 'test', 'python', 'make_fixtures.py'), dir], { stdio: 'inherit' })
  formats = dir
  return dir
}

function grade(item, passages) {
  const hits = passages.filter((p) => p.documentName.replace(/\.[a-z]+$/, '') === item.expectDoc)
  return { pass: hits.some((p) => p.text.includes(item.expectFact)), rank: passages.findIndex((p) => hits.includes(p)) + 1 || null, top: passages[0]?.score ?? null }
}

function unzip(bytes) {
  const files = new Map()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extra = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength))
    files.set(name, new TextDecoder().decode(inflateRawSync(bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size))))
    at += 30 + nameLength + extra + size
  }
  return files
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null
}

// ==================================================================== the plans

const MAIN = `e2e-${stamp}-main`
// The hiding plans use an organization of their own, so its R2 prefixes hold only their collection.
const HID_ORG = `${ORG}-hid`
const HID = `e2e-${stamp}-hid`
const plans = []
const plan = (id, title, fn, { costly = false } = {}) => plans.push({ id, title, fn, costly })

plan('IMP-04', 'Nothing learned twice', async () => {
  await createCollection(MAIN)
  const first = await learn(MAIN, 'batch-001', corpus('batch-001'))
  const before = { version: (await status(MAIN)).version, points: (await points(MAIN)).length }
  const again = await api('POST', `/v1/collections/${MAIN}/imports`, { importId: 'batch-001', files: [], notes: [], small: false })
  const copy = corpus('batch-001')[0]
  const renamed = await learn(MAIN, 'batch-001-renamed', [{ ...copy, fileId: 'renamed', name: `copy of ${copy.name}` }])
  const after = { version: (await status(MAIN)).version, points: (await points(MAIN)).length }
  const checks = {
    firstCommitted: first.state === 'committed',
    sameIdAnswersExisting: again.status === 200 && again.body.state === 'committed',
    sameContentIsAlreadyHere: renamed.state === 'duplicate' && renamed.files[0].state === 'already_here',
    noNewRestorePoint: before.points === after.points && before.version === after.version,
  }
  return { checks, evidence: { before, after } }
})

plan('IMP-03', 'All or nothing', async () => {
  await sleep(SHARE_WINDOW_MS)
  await learn(MAIN, 'batch-002', corpus('batch-002'))
  await sleep(SHARE_WINDOW_MS)
  const before = await status(MAIN)
  let killedAt = null
  await startImport(MAIN, 'batch-003', corpus('batch-003'))
  // The engine learns an import's files together (in groups), so they turn "learned" all at once: the container is
  // destroyed while they are being understood, before every file is learned.
  const interrupted = await waitImport(MAIN, 'batch-003', {
    onPoll: async (s) => {
      const learned = s.files.filter((f) => f.state === 'learned').length
      if (killedAt === null && s.files.some((f) => f.state === 'understanding') && learned < s.files.length) {
        killedAt = learned
        await control(MAIN, 'destroy-container')
      }
      return killedAt !== null && s.state === 'interrupted'
    },
  })
  const between = await status(MAIN)
  const done = await waitImport(MAIN, 'batch-003')
  const docs = await documents(MAIN)
  const checks = {
    crashedPartWay: killedAt !== null && killedAt < corpus('batch-003').length,
    markedInterrupted: interrupted.state === 'interrupted',
    restorePointUnchanged: between.version === before.version && between.counts.documents === before.counts.documents,
    retryCommitted: done.state === 'committed' && done.attempt === 2,
    documentsEqualUnique: docs.length === 30 && new Set(docs.map((d) => d.sha256)).size === 30,
  }
  return { checks, evidence: { killedAt, before: before.counts, after: (await status(MAIN)).counts } }
})

plan('ASK-01', 'Answerable questions and paraphrases: 37 of 40 at the 0.68 threshold', async () => {
  // Each question must be answered from a passage that holds its fact, and the answer must cite one: an answer
  // with no citations, one that cited outside the passages given (dropped), or one that cites only other passages fails.
  // The bar is 37 of the 40: the "won't guess" threshold is 0.68 (container/calibration.json), chosen knowing it
  // answers 37 of these 40 (on Cloudflare a19, a30 and p-q04 get no passage over it: a19's best is 0.637, a30's
  // 0.656), since a lower one answers questions nothing covers (ASK-02).
  const rows = []
  for (const item of [...questions('answerable.json'), ...questions('paraphrases.json')]) {
    const result = await search(MAIN, item.query, { topK: 5 })
    const g = grade(item, result.passages)
    const row = { id: item.id, query: item.query, ...g, answered: false, citations: [], dropped: null, citesTheFact: false }
    if (result.passages.length) {
      const answer = await api('POST', '/v1/answer', { question: item.query, passages: result.passages.map(({ passageId, documentName, page, text }) => ({ passageId, documentName, page, text })) })
      const citations = answer.body?.citations ?? []
      row.answered = answer.status === 200
      row.answer = answer.body?.text
      row.citations = citations
      row.dropped = answer.body?.dropped ?? null
      row.citesTheFact = citations.some((n) => {
        const p = result.passages[n - 1]
        return p && p.documentName.replace(/\.[a-z]+$/, '') === item.expectDoc && p.text.includes(item.expectFact)
      })
    }
    rows.push(row)
  }
  const passes = (r) => r.pass && r.answered && r.citations.length > 0 && r.dropped === 0 && r.citesTheFact
  const passed = rows.filter(passes).length
  const count = (test) => rows.filter(test).length
  return {
    checks: { atLeast37Of40: passed >= 37 },
    evidence: {
      passed,
      of: rows.length,
      // Each part of a row's pass, counted over the 40.
      expectedDocumentRetrievedWithFact: count((r) => r.pass),
      everyAnswerCites: count((r) => r.answered && r.citations.length > 0),
      noCitationDropped: count((r) => r.dropped === 0),
      aCitedPassageHoldsTheFact: count((r) => r.citesTheFact),
      failed: rows.filter((r) => !passes(r)),
      rows,
    },
  }
})

plan('ASK-02', '"I won\'t guess"', async () => {
  const uncovered = []
  for (const item of questions('uncovered.json')) uncovered.push({ ...item, ...(await search(MAIN, item.query)) })
  const near = []
  for (const item of questions('near-miss.json')) {
    const result = await search(MAIN, item.query)
    let answer = null
    if (result.passages.length) {
      answer = (await api('POST', '/v1/answer', { question: item.query, passages: result.passages.map(({ passageId, documentName, page, text }) => ({ passageId, documentName, page, text })) })).body
    }
    near.push({ id: item.id, query: item.query, covered: result.covered, answer: answer?.text ?? null, citations: answer?.citations ?? [] })
  }
  const wontGuess = uncovered.filter((u) => !u.covered).length
  const evidence = { wontGuess, uncoveredAnsweredWithACitation: uncovered.filter((u) => u.covered).map((u) => u.id), nearMisses: near }
  if (flag('calibrate')) {
    const scores = async (file) => {
      const out = []
      for (const item of questions(file)) out.push((await search(MAIN, item.query, { topK: 1, threshold: 0 })).passages[0]?.score ?? 0)
      return out
    }
    const [answerable, nothing, nearMiss] = [await scores('answerable.json'), await scores('uncovered.json'), await scores('near-miss.json')]
    evidence.calibration = { answerable, uncovered: nothing, nearMiss, suggestedThreshold: Number(((percentile(nothing, 95) + Math.min(...answerable)) / 2).toFixed(3)) }
  }
  // Near misses need a person to read: a confident wrong answer is one that cites a passage for a fact it doesn't hold.
  return { checks: { atLeast19Of20WontGuess: wontGuess >= 19 }, evidence, manual: 'Read evidence.nearMisses: no confident wrong answer.' }
})

plan('IMP-06', 'Every launch format, cited at the right page', async () => {
  const cid = `e2e-${stamp}-formats`
  await createCollection(cid)
  const dir = formatFixtures()
  const name = '16-heron-mobile-release'
  const types = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    html: 'text/html',
  }
  const files = Object.entries(types).map(([ext, type]) => ({ fileId: `fmt-${ext}`, name: `${name}.${ext}`, type, bytes: readFileSync(join(dir, ext, `${name}.${ext}`)) }))
  files.push({ fileId: 'fmt-md', name: `${name}.md`, type: 'text/markdown', text: readFileSync(join(fixtures, 'corpus', 'batch-001', `${name}.md`), 'utf8') })
  files.push({ fileId: 'fmt-txt', name: `${name}.txt`, type: 'text/plain', text: readFileSync(join(fixtures, 'corpus', 'batch-001', `${name}.md`), 'utf8').replace(/^#+ /gm, '') })
  const done = await learn(cid, 'formats', files)
  // The plan tests that each format is read and cited at its page, not ranking: its question is in the documents'
  // own words, so every format's passage clears the threshold. How a question in other words ranks is ASK-01's.
  const result = await search(cid, 'The rollout only advances while crash-free sessions stay at or above what percent?', { topK: 20 })
  const byType = Object.fromEntries(files.map((f) => [f.name.split('.').pop(), result.passages.find((p) => p.documentName === f.name && p.text.includes('99.6 percent'))]))
  // The question this plan asked before, for the report only: each format's passage score and rank for it.
  const reworded = await search(cid, 'Which crash-free sessions threshold gates the phased rollout?', { topK: 20, threshold: 0 })
  const rewordedByType = Object.fromEntries(
    files.map((f) => {
      const at = reworded.passages.findIndex((p) => p.documentName === f.name && p.text.includes('99.6 percent'))
      return [f.name.split('.').pop(), at < 0 ? null : { rank: at + 1, score: reworded.passages[at].score }]
    }),
  )
  const docs = await documents(cid)
  const pptx = docs.find((d) => d.name.endsWith('.pptx'))
  const checks = {
    allLearned: done.state === 'committed' && done.files.every((f) => f.state === 'learned'),
    eachFormatAnswers: Object.values(byType).every(Boolean),
    powerPointCitesItsSlide: byType.pptx?.page === pptx?.pages,
    pdfCitesItsPage: byType.pdf?.page === docs.find((d) => d.name.endsWith('.pdf'))?.pages,
  }
  const scanned = await learn(cid, 'scanned', [{ fileId: 'scan', name: 'Signed form.pdf', type: 'application/pdf', bytes: readFileSync(join(dir, 'scanned.pdf')) }])
  checks.scannedPdfNamedWithReason = scanned.state === 'failed' && /scanned image/.test(scanned.files[0].reason ?? '')
  const large = await learn(cid, 'large', [{ fileId: 'large', name: 'large.txt', type: 'text/plain', bytes: readFileSync(join(dir, 'large.txt')) }])
  checks.largeFileSaysWhatWasLearned = large.state === 'committed' && /first 2 MB/.test(large.files[0].reason ?? '')
  return {
    checks,
    evidence: {
      pages: Object.fromEntries(Object.entries(byType).map(([k, p]) => [k, p?.page ?? null])),
      scores: Object.fromEntries(Object.entries(byType).map(([k, p]) => [k, p?.score ?? null])),
      rewordedQuestion: rewordedByType,
      scanned: scanned.files[0],
      large: large.files[0],
    },
  }
})

plan('IMP-05', 'Three tries, then name the file', async () => {
  const cid = `e2e-${stamp}-tries`
  await createCollection(cid)
  const files = corpus('batch-003').slice(0, 3)
  await control(cid, 'fail-next-import', { crashFileId: files[1].fileId })
  const done = await learn(cid, 'crashing', files)
  const tries = (await state(cid)).log.filter((e) => e.event === 'job-started' && e.importId === 'crashing').length
  const checks = { failed: done.state === 'failed', namesTheFile: done.failedFileId === files[1].fileId, noFourthTry: tries === 3 && done.attempt === 3 }
  return { checks, evidence: { error: done.error, tries } }
})

plan('ASK-06', 'Wake time; the check finishes before any database opens', async () => {
  const wakes = Number(option('wakes', '5'))
  const timings = []
  let orderOk = true
  for (let i = 0; i < wakes; i++) {
    await control(MAIN, 'sleep')
    const result = await search(MAIN, questions('answerable.json')[i % 30].query)
    const events = (await state(MAIN)).log
    const lastStart = events.map((e) => e.event).lastIndexOf('container-started')
    const tail = events.slice(lastStart)
    const check = tail.findIndex((e) => e.event === 'checksum-ok')
    const open = tail.findIndex((e) => e.event === 'query-open-requested')
    const early = tail.some((e) => e.event === 'query-opened-early')
    if (check < 0 || open < 0 || check > open || early) orderOk = false
    timings.push({ toFirstAnswerMs: result.totalMs, instance: tail[0]?.instance, wakeMs: tail.find((e) => e.event === 'ready')?.wakeMs })
  }
  const values = timings.map((t) => t.toFirstAnswerMs)
  return {
    checks: { checksumBeforeAnyDatabaseOpened: orderOk },
    evidence: { label: option('label', null), p50: percentile(values, 50), p90: percentile(values, 90), timings },
    manual: 'Record p50 and p90 for each instance type (deploy with --questions-instance standard-1 and standard-4) for the copy.',
  }
})

plan('ASK-07', 'Answer time when awake', async () => {
  const items = questions('answerable.json')
  await search(MAIN, items[0].query)
  const times = []
  for (let i = 0; i < 100; i++) times.push((await search(MAIN, items[i % items.length].query)).ms)
  return { checks: { p50Under3s: percentile(times, 50) <= 3000 }, evidence: { p50: percentile(times, 50), p90: percentile(times, 90) } }
})

plan('FIX-01', 'Fix once: corrections reach new questions within 2 minutes', async () => {
  const runs = Number(option('fix-runs', '3'))
  const paraphraseOf = Object.fromEntries(questions('paraphrases.json').map((p) => [p.of, p]))
  // Corrected questions that have a paraphrase: the paraphrase must reach the correction too.
  const items = questions('answerable.json').filter((q) => paraphraseOf[q.id]).slice(0, runs)
  const timings = []
  const rows = []
  for (const [i, item] of items.entries()) {
    const found = await search(MAIN, item.query)
    const old = found.passages.find((p) => p.documentName.startsWith(item.expectDoc))
    if (!old) {
      rows.push({ id: item.id, error: 'no passage to correct' })
      continue
    }
    const started = Date.now()
    const note = { noteId: `fix-${i}`, title: `Correction ${i}`, text: `Correction for ${item.query}: the answer changed (correction ${i}).`, outdated: [{ documentId: old.documentId, textHash: old.textHash }] }
    await must('POST', `/v1/collections/${MAIN}/corrections`, { importId: `fix-${stamp}-${i}`, note }, [202])
    let first
    do {
      first = (await search(MAIN, item.query)).passages[0]
    } while (first?.kind !== 'note' && Date.now() - started < 10 * 60_000)
    timings.push(Date.now() - started)
    const para = paraphraseOf[item.id] ? (await search(MAIN, paraphraseOf[item.id].query)).passages[0] : null
    rows.push({ id: item.id, ms: Date.now() - started, noteFirst: first?.kind === 'note', oldLeftOut: !(await search(MAIN, item.query)).passages.some((p) => p.textHash === old.textHash), paraphraseNoteFirst: para ? para.kind === 'note' : null })
  }
  return {
    checks: {
      p90Within2Minutes: rows.length === items.length && percentile(timings, 90) <= 120_000,
      noteAnswers: rows.length === items.length && rows.every((r) => r.noteFirst && r.oldLeftOut),
      paraphrases: rows.length > 0 && rows.every((r) => r.paraphraseNoteFirst === true),
    },
    evidence: { p90: percentile(timings, 90), rows },
  }
})

plan('FIX-02', 'Corrections survive a re-read; a changed passage asks to be checked', async () => {
  // A file is read again when the hiding rules become stricter. The re-read either leaves the corrected passage's
  // words alone (the correction just applies) or changes them (it applies, and asks a person to check it).
  const cid = `e2e-${stamp}-fix`
  await createCollection(cid)
  const item = questions('answerable.json').find((q) => q.expectDoc === '03-oncall-rotation-policy')
  const file = corpus('batch-001').find((f) => f.name.startsWith(item.expectDoc))
  // On Cloudflare each corpus document is one passage, so no word of its file lies outside the corrected passage: a
  // second document gives the re-read a word to hide that leaves the corrected passage alone.
  const other = corpus('batch-001').find((f) => f !== file)
  await learn(cid, 'file', [file, other])
  const old = (await search(cid, item.query)).passages.find((p) => p.text.includes(item.expectFact))
  if (!old) throw new Error('no passage holds the fact to correct')
  await must('POST', `/v1/collections/${cid}/corrections`, {
    importId: 'fix', note: { noteId: 'fix-note', title: 'Correction', text: `Correction: ${item.query} The answer changed.`, outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  }, [202])
  await waitIdle(cid)
  const words = (text) => new Set(text.match(/[A-Za-z]{6,}/g) ?? [])
  const texts = []
  for (const d of (await documents(cid)).filter((d) => d.kind === 'file')) texts.push((await must('GET', `/v1/collections/${cid}/documents/${d.documentId}`)).text)
  const fileText = texts.join('\n')
  const inPassage = words(old.text)
  const elsewhere = [...words(fileText)].find((w) => !inPassage.has(w) && !old.text.toLowerCase().includes(w.toLowerCase()))
  const inside = [...inPassage].find((w) => !item.expectFact.includes(w))
  const rule = (list) => ({ settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: list } } })
  const needsCheck = async () => {
    const found = []
    let since = ''
    for (let more = true; more; ) {
      const page = await must('GET', `/v1/outbox?limit=500${since ? `&since=${since}` : ''}`, undefined, [200], { org: null })
      found.push(...page.events.filter((e) => e.type === 'needs_check' && e.collectionId === cid))
      since = page.cursor
      more = page.more
    }
    return found
  }
  await sleep(SHARE_WINDOW_MS)
  await must('PUT', `/v1/collections/${cid}`, rule([elsewhere]), [200])
  await sleep(5000)
  await waitIdle(cid)
  const unchanged = { noteFirst: (await search(cid, item.query)).passages[0]?.kind === 'note', checks: (await needsCheck()).length }
  await sleep(SHARE_WINDOW_MS)
  await must('PUT', `/v1/collections/${cid}`, rule([elsewhere, inside]), [200])
  await sleep(5000)
  await waitIdle(cid)
  const changedChecks = await needsCheck()
  return {
    checks: {
      unchangedPassageStillCorrected: unchanged.noteFirst && unchanged.checks === 0,
      changedPassageAsksToBeChecked: changedChecks.some((e) => e.noteId === 'fix-note' && e.documentId === old.documentId),
      correctionStillApplies: (await search(cid, item.query)).passages[0]?.kind === 'note',
    },
    evidence: { words: { elsewhere, inside }, unchanged, changedChecks },
  }
})

plan('HIS-05', 'Changes close together share one restore point', async () => {
  await waitIdle(MAIN)
  await sleep(SHARE_WINDOW_MS)
  const before = (await points(MAIN)).length
  for (let i = 0; i < 3; i++) {
    await learn(MAIN, `note-${stamp}-${i}`, [], { notes: [{ noteId: `close-${i}`, title: `Note ${i}`, text: `Close note ${i}.`, outdated: [] }], small: true })
  }
  const after = await points(MAIN)
  return { checks: { oneRestorePoint: after.length === before + 1 }, evidence: { summary: after[0].summary } }
})

plan('HIS-01', 'Go back three restore points, and undo', async () => {
  await waitIdle(MAIN)
  await sleep(SHARE_WINDOW_MS)
  const list = await points(MAIN)
  const target = list.filter((p) => p.restorable)[3]
  if (!target) throw new Error('fewer than four restorable points')
  const beforeDocs = (await documents(MAIN)).map((d) => d.documentId).sort()
  const beforeCounts = (await status(MAIN)).counts
  const preview = await must('GET', `/v1/collections/${MAIN}/restore-points/${target.version}/preview`)
  const targetSnapshot = (await state(MAIN)).restorePoints.find((p) => p.version === target.version).snapshotId
  await must('POST', `/v1/collections/${MAIN}/restore-points/${target.version}/go-back`, {}, [200])
  const back = await waitIdle(MAIN)
  const checked = (await state(MAIN)).log.filter((e) => e.event === 'checksum-ok').at(-1)
  const checks = {
    olderPointsOwnChecksums: checked?.snapshot === targetSnapshot && checked?.version === target.version,
    countsEqualThatPoint: back.counts.documents === target.documents,
    laterFilesSetAside: preview.setAside.length === beforeCounts.documents - target.documents,
  }
  await sleep(SHARE_WINDOW_MS)
  await must('POST', `/v1/collections/${MAIN}/undo`, {}, [200])
  const undone = await waitIdle(MAIN)
  checks.undoRestoresEverything = JSON.stringify((await documents(MAIN)).map((d) => d.documentId).sort()) === JSON.stringify(beforeDocs) && undone.counts.documents === beforeCounts.documents
  return { checks, evidence: { target, checked } }
})

plan('HIS-02', 'Waking from the backup', async () => {
  const items = questions('answerable.json').slice(0, 10)
  const before = []
  for (const item of items) before.push((await search(MAIN, item.query)).passages.map((p) => p.textHash))
  await backUp(MAIN)
  const counts = (await status(MAIN)).counts
  const version = (await status(MAIN)).version
  await control(MAIN, 'drop-snapshot')
  const after = []
  for (const item of items) after.push((await search(MAIN, item.query)).passages.map((p) => p.textHash))
  const now = await status(MAIN)
  const events = (await state(MAIN)).log.map((e) => e.event)
  const summary = (await points(MAIN))[0].summary
  return {
    checks: {
      answersIdentical: JSON.stringify(after) === JSON.stringify(before),
      countsEqual: JSON.stringify(now.counts) === JSON.stringify(counts),
      // From the backup, not by learning everything again (that would pass the other checks too).
      cameBackFromTheBackup: now.version > version && /^Came back from its backup/.test(summary) && events.includes('from-backup-done') && !events.includes('from-backup-relearn'),
    },
    evidence: { summary },
  }
})

plan('HIS-04', 'A failed integrity check', async () => {
  await sleep(SHARE_WINDOW_MS)
  const before = await status(MAIN)
  await control(MAIN, 'corrupt-manifest')
  await search(MAIN, questions('answerable.json')[0].query)
  // The repair names the version on the restore point it makes ("Answering from version …", or "Came back from its
  // backup"); one that answers from an earlier point then learns everything again, which adds a point after it. The
  // first answer may come after both, so every point made since is read, not only the newest.
  await waitIdle(MAIN)
  const made = (await points(MAIN)).filter((p) => p.version > before.version)
  const repair = made.find((p) => /^Answering from version \d+|^Came back from its backup/.test(p.summary))
  const mismatches = (await state(MAIN)).log.filter((e) => e.event === 'checksum-mismatch').length
  return {
    checks: { oneRetry: mismatches >= 2, namesTheVersion: Boolean(repair) },
    evidence: { before: before.version, made: made.map((p) => `v${p.version}: ${p.summary}`) },
  }
})

plan('HIS-03', 'An engine image change (simulated; see README for the real one)', async () => {
  const before = (await search(MAIN, questions('answerable.json')[1].query)).passages.map((p) => p.textHash)
  // Every point that could be restored becomes `engine_changed`. One an earlier plan made unavailable stays so: it
  // keeps a reason an image change doesn't outrank (HIS-04's damaged point stays `damaged`, as a point blocked by a
  // removal or stricter hiding keeps its reason), or becomes `engine_changed` (an expired one; history.ts reasonFor).
  const earlier = new Map((await points(MAIN)).map((p) => [p.version, p]))
  await control(MAIN, 'image-changed')
  const after = (await search(MAIN, questions('answerable.json')[1].query)).passages.map((p) => p.textHash)
  const list = await points(MAIN)
  const older = list.filter((p) => earlier.has(p.version))
  const kept = ['removed_for_good', 'newly_hidden', 'damaged']
  const expected = (p) => (kept.includes(earlier.get(p.version).reason) ? earlier.get(p.version).reason : 'engine_changed')
  return {
    checks: {
      sameAnswers: JSON.stringify(after) === JSON.stringify(before),
      olderPointsUnavailable: older.length > 0 && older.every((p) => !p.restorable && p.reason === expected(p)),
    },
    evidence: { summary: list[0].summary, older: older.map((p) => `v${p.version}: ${p.reason}`) },
    manual: 'The real image change is HIS-03-real: --image-change before, deploy the engine again with a changed image, then --image-change after.',
  }
})

// HIS-03 for real spans two runs of the harness around a second deploy, so its collection is named in a file between
// them (its organization isn't purged at the end of the first).
const REAL_IMAGE_CHANGE = join(here, 'report', 'his03-real.json')

plan('HIS-03-real', 'An engine image change, for real (before and after a second deploy)', async () => {
  const files = corpus('batch-002')
  const items = questions('answerable.json').filter((q) => files.some((f) => f.name.startsWith(q.expectDoc)))
  const answers = async (cid, org) => {
    const out = []
    for (const item of items) out.push((await search(cid, item.query, { org })).passages.map((p) => p.textHash))
    return out
  }
  const phase = option('image-change')
  if (phase === 'before') {
    const [cid, org] = [`e2e-${stamp}-his03`, `${ORG}-his03`]
    await createCollection(cid, org)
    const done = await learn(cid, 'his03', files, { org })
    if (done.state !== 'committed') throw new Error(`the import ${done.state}`)
    const asked = await answers(cid, org)
    await backUp(cid, org)
    const { version, counts } = await status(cid, org)
    mkdirSync(dirname(REAL_IMAGE_CHANGE), { recursive: true })
    writeFileSync(REAL_IMAGE_CHANGE, JSON.stringify({ cid, org, version, counts, answers: asked }, null, 2))
    return {
      checks: { learnedAndBackedUp: true },
      evidence: { cid, org, version },
      manual: 'Deploy the engine again with a changed image (the same one with a layer added will do), then run --only HIS-03-real --image-change after.',
    }
  }
  if (phase !== 'after') throw new Error('--image-change takes before or after')
  const before = JSON.parse(readFileSync(REAL_IMAGE_CHANGE, 'utf8'))
  const { cid, org } = before
  const started = Date.now()
  const asked = await answers(cid, org)
  const firstAnswerSeconds = (Date.now() - started) / 1000
  const list = await points(cid, org)
  const events = (await state(cid, org)).log.map((e) => e.event)
  const checks = {
    sameAnswers: JSON.stringify(asked) === JSON.stringify(before.answers),
    sameCounts: JSON.stringify((await status(cid, org)).counts) === JSON.stringify(before.counts),
    cameBackFromTheBackup: /^Came back from its backup/.test(list[0].summary) && events.includes('from-backup-done') && !events.includes('from-backup-relearn'),
    olderPointsUnavailable: list.length > 1 && list.slice(1).every((p) => !p.restorable && p.reason === 'engine_changed'),
  }
  await api('POST', `/v1/orgs/${org}/purge`, {}, { org })
  return { checks, evidence: { firstAnswerSeconds, points: list.map((p) => `v${p.version}: ${p.summary} (${p.reason ?? 'restorable'})`) } }
}, { costly: 'image-change' })

plan('HID-01', 'Nothing hidden is stored; HID-03 originals are deleted', async () => {
  const cid = HID
  const org = HID_ORG
  await createCollection(cid, org)
  const dir = formatFixtures()
  const planted = hidingCases()
    .filter((c) => c.spans.length && JSON.stringify(c.rules) === JSON.stringify({ emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] }))
    .flatMap((c) => c.spans.map((s) => c.input.slice(s.start, s.end)))
  await learn(cid, 'personal', [{ fileId: 'personal', name: 'personal-data.md', type: 'text/markdown', bytes: readFileSync(join(dir, 'personal-data.md')) }], { org })
  const counts = await objects(org)
  await search(cid, 'contacts and keys', { org })
  await backUp(cid, org)
  await search(cid, 'contacts and keys', { org })
  const found = await control(cid, 'grep', { values: planted }, org)
  const exportId = `exp-${stamp}`
  await must('POST', `/v1/collections/${cid}/exports`, { exportId }, [200], { org })
  let exp
  do {
    await sleep(2000)
    exp = await must('GET', `/v1/collections/${cid}/exports/${exportId}`, undefined, [200], { org })
  } while (exp.state === 'queued' || exp.state === 'running')
  const zip = unzip((await api('GET', `/v1/collections/${cid}/exports/${exportId}?download=1`, undefined, { org })).bytes)
  const everything = [...zip.values()].join('\n')
  const inExport = planted.filter((v) => everything.includes(v))
  const leaks = Object.entries(found).filter(([, where]) => where.container + where.text + where.backups > 0)
  const answer = await search(cid, 'deploy key rotated password', { org })
  return {
    checks: { noPlantedValueAnywhere: !leaks.length && !inExport.length, answersShowHidden: answer.passages.some((p) => p.text.includes('[hidden]')), inboxEmptyAfterTheImport: counts.inbox === 0 },
    evidence: { planted: planted.length, leaks: leaks.map(([v]) => v.length), inExport: inExport.length, objects: counts },
  }
})

plan('HID-02', 'Fails closed', async () => {
  const [cid, org] = [HID, HID_ORG]
  const before = (await documents(cid, org)).length
  await control(cid, 'fail-next-import', { detectorError: true }, org)
  const done = await learn(cid, 'detector', [corpus('batch-002')[0]], { org })
  return { checks: { stopped: done.state === 'failed', noNewDocument: (await documents(cid, org)).length === before }, evidence: { error: done.error } }
})

plan('HID-04', 'A stricter rule applies to old files', async () => {
  const [cid, org] = [HID, HID_ORG]
  await waitIdle(cid, org)
  await sleep(SHARE_WINDOW_MS)
  const word = 'Ledgerline'
  await learn(cid, 'with-word', [corpus('batch-001')[0]], { org })
  // A backup and a ready export that hold the word, before the rule hides it.
  await backUp(cid, org)
  const exportId = `exp-hid-${stamp}`
  await must('POST', `/v1/collections/${cid}/exports`, { exportId }, [200], { org })
  let before
  do {
    await sleep(2000)
    before = await must('GET', `/v1/collections/${cid}/exports/${exportId}`, undefined, [200], { org })
  } while (before.state === 'queued' || before.state === 'running')
  const heldBefore = (await control(cid, 'grep', { values: [word] }, org))[word]
  await sleep(SHARE_WINDOW_MS)
  await must('PUT', `/v1/collections/${cid}`, { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [word] } } }, [200], { org })
  await sleep(5000)
  const idle = await waitIdle(cid, org)
  await search(cid, 'billing gateway owner', { org })
  const found = (await control(cid, 'grep', { values: [word] }, org))[word]
  const list = await points(cid, org)
  const exportAfter = await must('GET', `/v1/collections/${cid}/exports/${exportId}`, undefined, [200], { org })
  const latest = (await state(cid, org)).log.filter((e) => e.event === 'backup-done' || e.event === 'backup').pop()
  return {
    checks: {
      heldBeforeInBackupAndExport: before.state === 'ready' && heldBefore.backups > 0 && heldBefore.exports > 0,
      wordGone: found.container + found.text + found.backups + found.exports === 0,
      exportDropped: exportAfter.state === 'failed',
      newLatestBackup: latest?.version === idle.version,
      earlierBlocked: list.slice(1).some((p) => p.reason === 'newly_hidden'),
    },
    evidence: { summary: list[0].summary, version: idle.version, heldBefore, found, latest },
  }
})

plan('HIS-07', 'Remove for good', async () => {
  const [cid, org] = [HID, HID_ORG]
  const file = corpus('batch-003')[2]
  const sentence = 'migration never blocks production traffic for long'
  if (!(await documents(cid, org)).some((d) => d.name === file.name)) {
    await sleep(SHARE_WINDOW_MS)
    await learn(cid, 'to-remove', [file], { org })
    await sleep(SHARE_WINDOW_MS)
  }
  const target = (await documents(cid, org)).find((d) => d.name === file.name)
  await backUp(cid, org)
  const removed = await must('DELETE', `/v1/collections/${cid}/documents/${target.documentId}`, undefined, [200], { org })
  await waitIdle(cid, org)
  await search(cid, 'migration lock timeout', { org })
  const found = (await control(cid, 'grep', { values: [sentence] }, org))[sentence]
  const refused = []
  for (const version of removed.blockedRestorePoints) {
    const res = await api('POST', `/v1/collections/${cid}/restore-points/${version}/go-back`, {}, { org })
    refused.push(res.status === 409 && res.body.error === 'not_restorable')
  }
  return {
    checks: { textGoneEverywhere: found.container + found.text + found.backups + found.exports === 0, blockedPointsRefused: refused.length > 0 && refused.every(Boolean) },
    evidence: { removed, found },
  }
})

plan('DEL-03', 'Export and import again', async () => {
  // A collection of its own with a stopped source and a correction, exported and started again from the export in
  // an empty collection (POST .../import-export): the copy answers the same, passage for passage.
  const source = `e2e-${stamp}-exp`
  await createCollection(source)
  await learn(source, 'files', corpus('batch-001'))
  const asked = questions('answerable.json').filter((q) => corpus('batch-001').some((f) => f.name.startsWith(q.expectDoc)))
  const corrected = asked[0]
  const old = (await search(source, corrected.query)).passages.find((p) => p.text.includes(corrected.expectFact))
  if (!old) throw new Error('no passage holds the fact to correct')
  await must('POST', `/v1/collections/${source}/corrections`, {
    importId: 'fix', note: { noteId: 'fix-note', title: 'Correction', text: `Correction: ${corrected.query} The answer changed.`, outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  }, [202])
  await waitIdle(source)
  const stoppedItem = asked[1]
  const stopped = (await documents(source)).find((d) => d.name.startsWith(stoppedItem.expectDoc))
  await must('PATCH', `/v1/collections/${source}/documents/${stopped.documentId}`, { active: false })
  await waitIdle(source)

  const exportId = `exp-${stamp}`
  await must('POST', `/v1/collections/${source}/exports`, { exportId })
  let exp
  do {
    await sleep(2000)
    exp = await must('GET', `/v1/collections/${source}/exports/${exportId}`)
  } while (exp.state === 'queued' || exp.state === 'running')
  const bytes = (await api('GET', `/v1/collections/${source}/exports/${exportId}?download=1`)).bytes
  const names = [...unzip(bytes).keys()]
  const copy = `e2e-${stamp}-copy`
  await createCollection(copy)
  const staged = await stage(copy, { fileId: 'export', name: 'knowledge-export.zip', type: 'application/zip', bytes })
  await must('POST', `/v1/collections/${copy}/import-export`, { importId: 'from-export', fileId: 'export', sha256: staged.sha256 }, [202])
  const restored = await waitImport(copy, 'from-export')
  // The same passages with the same scores; passages that tie may come in either order.
  const answer = async (cid, query) =>
    (await search(cid, query)).passages.map((p) => `${p.score.toFixed(3)} ${p.documentId} ${p.kind} ${p.textHash} ${p.outdated}`).sort().reverse()
  const same = []
  for (const item of asked) {
    const [a, b] = [await answer(source, item.query), await answer(copy, item.query)]
    same.push(JSON.stringify(a) === JSON.stringify(b) ? { id: item.id, same: true } : { id: item.id, same: false, source: a, copy: b })
  }
  const fixed = (await search(copy, corrected.query)).passages
  const copyDocs = await documents(copy)
  const required = ['README.txt', 'collection.json', 'notes.json', 'facts.json', 'corrections.json', 'history.json']
  return {
    checks: {
      holdsEverything: required.every((r) => names.includes(r)),
      noOriginals: !names.some((n) => /\.(pdf|docx|pptx|xlsx|html)$/.test(n)),
      startedWithOneRestorePoint: restored.state === 'committed' && (await points(copy)).length === 1,
      sameCounts: JSON.stringify((await status(copy)).counts) === JSON.stringify((await status(source)).counts),
      answersMatch: same.every((s) => s.same),
      correctionKept: fixed[0]?.kind === 'note' && !fixed.some((p) => p.textHash === old.textHash),
      stoppedSourceKept: copyDocs.find((d) => d.documentId === stopped.documentId)?.active === false,
      refusedWhenNotEmpty: (await api('POST', `/v1/collections/${source}/import-export`, { importId: 'again', fileId: 'none', sha256: staged.sha256 })).status === 409,
    },
    evidence: { files: names.length, same, restored },
  }
})

plan('DEL-01', 'Deleting during an import', async () => {
  const org = `${ORG}-del`
  const cid = `e2e-${stamp}-del`
  await createCollection(cid, org)
  await learn(cid, 'first', corpus('batch-002'), { org })
  await backUp(cid, org)
  await startImport(cid, 'during', corpus('batch-003'), { org })
  await waitImport(cid, 'during', { org, onPoll: (s) => s.state === 'learning' || s.state === 'reading' })
  const deleting = await api('DELETE', `/v1/collections/${cid}`, undefined, { org })
  for (let i = 0; i < 100 && (await status(cid, org)).state !== 'deleted'; i++) await sleep(3000)
  const counts = await objects(org)
  const again = await api('DELETE', `/v1/collections/${cid}`, undefined, { org })
  return {
    checks: {
      accepted: deleting.status === 202,
      deleted: (await status(cid, org)).state === 'deleted',
      nothingLeftInR2: Object.values(counts).every((n) => n === 0),
      reconcilingChangesNothing: again.status === 202 && Object.values(await objects(org)).every((n) => n === 0),
    },
    evidence: { counts },
  }
})

plan('soak', "The PoC's recovery soak", async () => {
  const rounds = Number(option('soak', '0'))
  const results = []
  const reference = (await search(MAIN, questions('answerable.json')[0].query)).passages.map((p) => p.textHash)
  for (let i = 0; i < rounds; i++) {
    await control(MAIN, 'destroy-container')
    const again = await search(MAIN, questions('answerable.json')[0].query)
    results.push({ round: i + 1, same: JSON.stringify(again.passages.map((p) => p.textHash)) === JSON.stringify(reference), ms: again.totalMs })
  }
  return { checks: { everyRoundSame: results.every((r) => r.same) }, evidence: { results } }
})

plan('IMP-07', '500 documents in 10 imports', async () => {
  const cid = `e2e-${stamp}-size`
  await createCollection(cid)
  const base = [...corpus('batch-001'), ...corpus('batch-002'), ...corpus('batch-003')]
  const rows = []
  for (let batch = 0; batch < 10; batch++) {
    const files = Array.from({ length: 50 }, (_, i) => {
      const n = batch * 50 + i
      const doc = base[n % base.length]
      return { fileId: `s${n}`, name: `${n}-${doc.name}`, text: `${doc.text}\n\nRevision ${n}: reviewed by team ${n % 17}.` }
    })
    // The engine's own plan for the import, as the answer to its submission gives it (etaSeconds: the whole try,
    // before its job starts; nothing waits ahead of it here), against the time from then to its commit. An import
    // that needed a second try isn't the plan's to meet.
    const begun = await startImport(cid, `size-${batch}`, files)
    if (![200, 202].includes(begun.status)) throw new Error(`import size-${batch}: ${begun.status} ${JSON.stringify(begun.body)}`)
    const started = Date.now()
    const planned = begun.body.etaSeconds
    const done = await waitImport(cid, `size-${batch}`)
    rows.push({ batch, seconds: (Date.now() - started) / 1000, planned, attempt: done.attempt, state: done.state })
    log(`  size-${batch}: ${done.state} in ${rows.at(-1).seconds} s, planned ${planned} s (attempt ${done.attempt})`)
  }
  const snapshots = (await state(cid)).snapshots
  const timed = rows.filter((r) => r.state === 'committed' && r.attempt === 1 && r.planned !== null)
  return {
    checks: {
      within25Percent: timed.length === rows.length && timed.every((r) => Math.abs(r.seconds - r.planned) <= r.planned * 0.25),
      snapshotUnder20GB: snapshots.every((s) => s.size < 20 * 1024 ** 3),
    },
    evidence: { rows, largestSnapshotBytes: Math.max(...snapshots.map((s) => s.size)) },
  }
}, { costly: 'size' })

plan('IMP-10', 'The service-wide guard', async () => {
  const orgs = Array.from({ length: 21 }, (_, i) => `${ORG}-cap${i}`)
  for (const org of orgs) await createCollection('cap', org)
  for (const org of orgs) await startImport('cap', 'cap', corpus('batch-003'), { org })
  let maxRunning = 0
  let sawServiceWait = false
  for (let i = 0; i < 200; i++) {
    const statuses = await Promise.all(orgs.map((org) => must('GET', '/v1/collections/cap/imports/cap', undefined, [200], { org })))
    maxRunning = Math.max(maxRunning, statuses.filter((s) => ['reading', 'learning', 'saving'].includes(s.state)).length)
    sawServiceWait ||= statuses.some((s) => s.waitingFor === 'service')
    if (statuses.every((s) => ['committed', 'failed'].includes(s.state))) break
    await sleep(5000)
  }
  for (const org of orgs) await api('POST', `/v1/orgs/${org}/purge`, {}, { org })
  return { checks: { atMost20: maxRunning <= 20, theTwentyFirstSaysSo: sawServiceWait }, evidence: { maxRunning } }
}, { costly: 'capacity' })

// ==================================================================== running and the report

async function runPlans() {
  if (!BASE || !TOKEN) throw new Error('set HARNESS_URL and HARNESS_TOKEN (node harness/run.mjs prepare --run <id> prints how)')
  const only = option('only', null)?.split(',')
  const chosen = plans.filter((p) => (only ? only.includes(p.id) : !p.costly || flag(p.costly)) && (p.id !== 'soak' || Number(option('soak', '0')) > 0))
  const report = { startedAt: new Date().toISOString(), base: BASE.replace(/\/\/[^.]+/, '//…'), org: ORG, label: option('label', null), results: [] }
  log(`organization ${ORG}; plans ${chosen.map((p) => p.id).join(', ')}`)
  for (const p of chosen) {
    const started = Date.now()
    log(`=== ${p.id} ${p.title}`)
    let entry
    try {
      const result = await p.fn()
      const failed = Object.entries(result.checks).filter(([, ok]) => !ok).map(([name]) => name)
      entry = { id: p.id, title: p.title, pass: failed.length === 0, failed, ...result }
    } catch (error) {
      entry = { id: p.id, title: p.title, pass: false, error: String(error.stack ?? error) }
    }
    entry.seconds = Math.round((Date.now() - started) / 1000)
    report.results.push(entry)
    log(`=== ${p.id}: ${entry.pass ? 'PASS' : 'FAIL'}${entry.failed?.length ? ` (${entry.failed.join(', ')})` : ''}${entry.error ? ` (${entry.error.split('\n')[0]})` : ''}`)
    save(report)
  }
  // Usage the run caused, for LIM-09's comparison with Cloudflare's own figures.
  const usage = {}
  let since = ''
  for (let more = true; more; ) {
    const page = await must('GET', `/v1/outbox?limit=500${since ? `&since=${since}` : ''}`, undefined, [200], { org: null })
    for (const e of page.events) if (e.type === 'usage' && e.org.startsWith(ORG)) usage[e.kind] = (usage[e.kind] ?? 0) + e.seconds
    since = page.cursor
    more = page.more
  }
  report.usageSeconds = usage
  for (const org of [ORG, HID_ORG, `${ORG}-del`]) await api('POST', `/v1/orgs/${org}/purge`, {}, { org })
  report.finishedAt = new Date().toISOString()
  save(report)
  process.exitCode = report.results.every((r) => r.pass) ? 0 : 1
}

function save(report) {
  const dir = join(here, 'report')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `run-${stamp}.json`), JSON.stringify(report, null, 2))
  const lines = [
    '# Knowledge engine: Engine-lane run',
    '',
    `Started ${report.startedAt}${report.finishedAt ? `, finished ${report.finishedAt}` : ' (in progress)'}${report.label ? `, ${report.label}` : ''}.`,
    '',
    '| Plan | Result | Time | Failed checks | Still for a person |',
    '| --- | --- | --- | --- | --- |',
    ...report.results.map((r) => `| ${r.id} ${r.title} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.seconds} s | ${r.error ? r.error.split('\n')[0].replace(/\|/g, '/') : r.failed.join(', ') || '–'} | ${r.manual ?? '–'} |`),
    '',
  ]
  if (report.usageSeconds) lines.push('## Running time the run caused (LIM-09)', '', '```', JSON.stringify(report.usageSeconds, null, 2), '```', '', "Compare with Cloudflare's figures for the same period; the plan passes within 5%.", '')
  writeFileSync(join(dir, `REPORT-${stamp}.md`), lines.join('\n'))
}

// ==================================================================== the command

if (command === 'prepare') prepare(option('run'))
else if (command === 'cleanup') cleanup(option('run'))
else if (command === 'test') await runPlans()
else {
  console.error('usage: node harness/run.mjs prepare --run <id> | test [options] | cleanup --run <id>')
  process.exitCode = 2
}
