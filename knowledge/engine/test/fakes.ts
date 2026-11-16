// Test doubles for the engine's Worker logic: Durable Object storage and namespaces, R2, Workers AI, and a container
// that answers like container/server.py (jobs, quiesce, the query process, inbox, files) with ctx.container's
// start / destroy / snapshot calls. The container's Cognee work is simulated: extraction is UTF-8 text, hiding
// replaces e-mail addresses and the organization's words, passages are paragraphs, search counts shared words.
// The real extraction, hiding and ranking are tested in Python (test/python).

import { createHash } from 'node:crypto'
import type { Env } from '../src/env.ts'

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))
export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')

// ==================================================================== Durable Object storage

export class FakeStorage {
  data = new Map<string, unknown>()
  alarm: number | null = null

  async get<T>(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>()
      for (const k of key) if (this.data.has(k)) out.set(k, clone(this.data.get(k)) as T)
      return out
    }
    return clone(this.data.get(key)) as T | undefined
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === 'string') this.data.set(key, clone(value))
    else for (const [k, v] of Object.entries(key)) this.data.set(k, clone(v))
  }

  async delete(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) return key.filter((k) => this.data.delete(k)).length
    return this.data.delete(key)
  }

  async list<T>(options: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean } = {}) {
    let keys = [...this.data.keys()].sort()
    if (options.prefix) keys = keys.filter((k) => k.startsWith(options.prefix!))
    if (options.start) keys = keys.filter((k) => k >= options.start!)
    if (options.startAfter) keys = keys.filter((k) => k > options.startAfter!)
    if (options.end) keys = keys.filter((k) => k < options.end!)
    if (options.reverse) keys.reverse()
    if (options.limit !== undefined) keys = keys.slice(0, options.limit)
    return new Map(keys.map((k) => [k, clone(this.data.get(k)) as T]))
  }

  async deleteAll(): Promise<void> {
    this.data.clear()
  }

  async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
    const before = new Map(this.data)
    try {
      return await fn(this)
    } catch (error) {
      this.data = before
      throw error
    }
  }

  async getAlarm() {
    return this.alarm
  }
  async setAlarm(at: number | Date) {
    this.alarm = typeof at === 'number' ? at : at.getTime()
  }
  async deleteAlarm() {
    this.alarm = null
  }
  async sync() {}
}

export class FakeState {
  storage = new FakeStorage()
  container: FakeContainer | undefined
  pending: Promise<unknown>[] = []
  id: { name: string; toString(): string }

  constructor(name: string, container?: FakeContainer) {
    this.id = { name, toString: () => name }
    this.container = container
  }
  waitUntil(promise: Promise<unknown>) {
    this.pending.push(promise.catch(() => undefined))
  }
}

// ==================================================================== namespaces

type ObjectClass = new (state: any, env: any) => { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> }

export class FakeNamespace {
  instances = new Map<string, { object: any; state: FakeState }>()
  cls: ObjectClass
  env!: Env
  cloud: FakeCloud | null

  constructor(cls: ObjectClass, cloud: FakeCloud | null) {
    this.cls = cls
    this.cloud = cloud
  }

  idFromName(name: string) {
    return { name, toString: () => name }
  }

  instance(name: string) {
    let entry = this.instances.get(name)
    if (!entry) {
      const state = new FakeState(name, this.cloud ? new FakeContainer(this.cloud, name) : undefined)
      entry = { object: new this.cls(state, this.env), state }
      this.instances.set(name, entry)
    }
    return entry
  }

  get(id: { name: string }) {
    return {
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const options = init?.body instanceof ReadableStream ? ({ ...init, duplex: 'half' } as RequestInit) : init
        const request = input instanceof Request ? new Request(input, options) : new Request(input as string, options)
        return this.instance(id.name).object.fetch(request)
      },
    }
  }
}

// ==================================================================== R2

interface Stored {
  body: Uint8Array
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array()
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer())
  throw new Error('unsupported R2 body')
}

function objectBody(key: string, stored: Stored) {
  const body = stored.body
  return {
    key,
    size: body.length,
    httpMetadata: stored.httpMetadata,
    customMetadata: stored.customMetadata,
    get body() {
      return new Blob([body]).stream()
    },
    text: async () => new TextDecoder().decode(body),
    json: async () => JSON.parse(new TextDecoder().decode(body)),
    arrayBuffer: async () => body.slice().buffer,
  }
}

export class FakeR2 {
  objects = new Map<string, Stored>()
  multipart = 0
  minPartBytes = 5 * 1024 * 1024 // R2: every part but the last is at least 5 MiB (tests that use small parts lower it)

  async put(key: string, value: unknown, options: { sha256?: string; httpMetadata?: any; customMetadata?: any } = {}) {
    const body = await bytesOf(value)
    if (options.sha256 && sha256(body) !== options.sha256) throw new Error('put: the SHA-256 does not match')
    this.objects.set(key, { body, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata })
    return { key, size: body.length }
  }
  async get(key: string) {
    const stored = this.objects.get(key)
    return stored ? objectBody(key, stored) : null
  }
  async head(key: string) {
    const stored = this.objects.get(key)
    return stored ? { key, size: stored.body.length } : null
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort()
    const start = options.cursor ? Number(options.cursor) : 0
    const limit = options.limit ?? 1000
    const page = keys.slice(start, start + limit)
    const truncated = start + limit < keys.length
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.body.length })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: [],
    }
  }
  async createMultipartUpload(key: string, options: { httpMetadata?: any } = {}) {
    this.multipart += 1
    const parts = new Map<number, Uint8Array>()
    return {
      uploadPart: async (n: number, data: unknown) => {
        parts.set(n, await bytesOf(data))
        return { partNumber: n, etag: `etag-${n}` }
      },
      complete: async (uploaded: { partNumber: number }[]) => {
        const sizes = uploaded.map((p) => parts.get(p.partNumber)!.length)
        if (sizes.slice(0, -1).some((s) => s !== sizes[0])) throw new Error('R2 needs parts of one size but the last')
        if (sizes.slice(0, -1).some((s) => s < this.minPartBytes)) throw new Error('R2 needs parts of at least 5 MiB but the last')
        const all = new Uint8Array(sizes.reduce((a, b) => a + b, 0))
        let at = 0
        for (const p of uploaded) {
          all.set(parts.get(p.partNumber)!, at)
          at += parts.get(p.partNumber)!.length
        }
        this.objects.set(key, { body: all, httpMetadata: options.httpMetadata })
      },
      abort: async () => undefined,
    }
  }
  keys(prefix = '') {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
  text(key: string) {
    const stored = this.objects.get(key)
    return stored ? new TextDecoder().decode(stored.body) : null
  }
}

// ==================================================================== Workers AI

export class FakeAI {
  calls: { model: string; input: any }[] = []
  reply: string | Error = 'The billing gateway listens on port 8443 [1]. See also [7].'
  async run(model: string, input: Record<string, unknown>) {
    this.calls.push({ model, input })
    if (this.reply instanceof Error) throw this.reply
    return { response: this.reply }
  }
}

// ==================================================================== the container

/** Snapshots live in the cloud, beside the containers: a snapshot outlives the container it was taken in. */
export class FakeCloud {
  snapshots = new Map<string, Map<string, string>>()
  nextSnapshot = 1
  image = 'registry.example/engine@1'
  starts: { collection: string; snapshot: string | null; instance?: string; env?: Record<string, string> }[] = []
  // Knobs for tests
  jobPolls = 1 // how many GET /jobs/<id> a job stays running
  queryPolls = 1 // how many status calls the query process takes to load, and to open
  crashFileId: string | null = null // ingest crashes (exit 70, no result) on this file
  failExtraction: Record<string, string> = {} // fileId -> permanent reason
  detectorError = false
  dataFormat = 'fmt-1'
  failStarts = 0 // the next starts fail
  hangJobs: string[] = [] // jobs of these ops never finish
  onStart: (() => void) | null = null // e.g. move the fake clock: starting takes time
  openWrites = false // the query process writes under /data when it opens (as databases may): /data no longer equals the snapshot
  lingerPolls = 1 // after a job, /quiesce reports a process still exiting this many times
  calls: { collection: string; method: string; path: string; detail?: string }[] = []
}

interface FakeJob {
  id: string
  op: string
  state: 'running' | 'succeeded' | 'failed'
  polls: number
  args: any
  result?: any
  exitCode?: number
  progress?: any
  prepared?: any
  newlyHidden?: string[]
}

export class FakeContainer {
  cloud: FakeCloud
  name: string
  running = false
  data = new Map<string, string>()
  inbox = new Map<string, string | Uint8Array>()
  jobs = new Map<string, FakeJob>()
  active: string | null = null
  query: { state: 'stopped' | 'loading' | 'loaded' | 'opening' | 'ready'; polls: number; openedAt: string | null; earlyOpen: boolean } = {
    state: 'stopped',
    polls: 0,
    openedAt: null,
    earlyOpen: false,
  }
  exited: (() => void) | null = null
  lingering = 0 // a finished job's processes still exiting
  env: Record<string, string> = {}
  bootSnapshot: string | null = null

  constructor(cloud: FakeCloud, name: string) {
    this.cloud = cloud
    this.name = name
  }

  get images() {
    return { base: this.cloud.image }
  }

  start(options: { containerSnapshot?: { id: string }; image?: string; instance?: string; env?: Record<string, string> } = {}) {
    if (this.running) throw new Error('already running')
    if (this.cloud.failStarts > 0) {
      this.cloud.failStarts -= 1
      throw new Error('the container could not start')
    }
    this.cloud.onStart?.()
    const id = options.containerSnapshot?.id ?? null
    if (id && !this.cloud.snapshots.has(id)) throw new Error('snapshot not found')
    this.data = id ? new Map(this.cloud.snapshots.get(id)!) : new Map()
    this.bootSnapshot = id
    this.inbox.clear()
    this.jobs.clear()
    this.active = null
    this.query = { state: 'stopped', polls: 0, openedAt: null, earlyOpen: false }
    this.env = options.env ?? {}
    this.running = true
    this.cloud.starts.push({ collection: this.name, snapshot: id, instance: options.instance, env: options.env })
  }

  monitor() {
    return new Promise<void>((resolve) => {
      this.exited = resolve
    })
  }

  async destroy() {
    this.running = false
    this.data = new Map()
    this.query.state = 'stopped'
    this.exited?.()
    this.exited = null
  }

  signal() {}
  async setInactivityTimeout() {}
  async inspect() {
    return this.running ? { labels: {}, image: this.cloud.image } : null
  }

  async snapshotContainer(options: { name?: string } = {}) {
    if (!this.running) throw new Error('not running')
    // As the engine's rule 2 asks: never while a job, a lingering process, the query process or a staged file is there.
    const busy = (this.active && this.jobs.get(this.active)?.state === 'running') || this.lingering > 0 || this.query.state !== 'stopped' || this.inbox.size > 0
    if (busy) throw new Error('snapshot refused: the container is not quiet')
    const id = `snap-${this.cloud.nextSnapshot++}`
    this.cloud.snapshots.set(id, new Map(this.data))
    return { id, size: [...this.data.values()].reduce((s, v) => s + v.length, 0), name: options.name }
  }

  getTcpPort() {
    // Node needs `duplex` to send a stream; Workers don't.
    return { fetch: (url: string, init?: RequestInit) => this.serve(new Request(url, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } as RequestInit : init)) }
  }

  // ------------------------------------------------------------ server.py

  async serve(request: Request): Promise<Response> {
    if (!this.running) throw new Error('container is not running')
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const method = request.method
    this.cloud.calls.push({ collection: this.name, method, path: url.pathname })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, bootId: 'boot', activeJob: this.active, dataFormat: this.cloud.dataFormat, query: { state: this.query.state } })
    }
    if (method === 'PUT' && parts[0] === 'inbox' && parts.length === 3) {
      this.inbox.set(`${parts[1]}/${parts[2]}`, new Uint8Array(await request.arrayBuffer()))
      return json({ stored: true }, 201)
    }
    if (method === 'DELETE' && parts[0] === 'inbox' && parts.length === 2) {
      for (const key of [...this.inbox.keys()]) if (key.startsWith(`${parts[1]}/`)) this.inbox.delete(key)
      return json({ deleted: parts[1] })
    }
    if (method === 'POST' && url.pathname === '/jobs') {
      const { op, args } = (await request.json()) as { op: string; args: any }
      if (this.active && this.jobs.get(this.active)?.state === 'running') return json({ error: 'busy' }, 409)
      if (['ingest', 'remove', 'reread', 'stats'].includes(op) && this.query.state !== 'stopped') return json({ error: 'query_running' }, 409)
      const job: FakeJob = { id: `${op}-${this.jobs.size + 1}`, op, state: 'running', polls: op === 'manifest' || op === 'stats' || op === 'grep' ? 0 : this.cloud.jobPolls, args }
      this.jobs.set(job.id, job)
      this.active = job.id
      this.cloud.calls.push({ collection: this.name, method, path: '/jobs', detail: op })
      if (op === 'ingest') {
        try {
          this.read(job)
        } catch (error) {
          this.fail(job, error)
        }
      }
      if (job.state === 'running' && job.polls === 0) this.finish(job)
      return json(this.view(job), 202)
    }
    if (method === 'GET' && parts[0] === 'jobs' && parts.length === 2) {
      const job = this.jobs.get(parts[1])
      if (!job) return json({ error: 'no such job' }, 404)
      if (job.state === 'running') {
        job.polls -= 1
        if (job.op === 'ingest') job.progress = { ...job.progress, ...this.progress(job) }
        if (job.polls <= 0) this.finish(job)
      }
      return json(this.view(job))
    }
    if (method === 'GET' && url.pathname === '/quiesce') {
      const running = this.active && this.jobs.get(this.active)?.state === 'running'
      const quiescent = !running && this.lingering === 0 && this.query.state === 'stopped' && this.inbox.size === 0
      if (!running && this.lingering > 0) this.lingering -= 1
      return json({ quiescent, activeJob: running ? this.active : null, query: this.query.state, strayProcesses: [], openDataFiles: [], inboxFiles: this.inbox.size })
    }
    if (method === 'POST' && url.pathname === '/cleanup') {
      this.inbox.clear()
      return json({ removed: 0 })
    }
    if (parts[0] === 'query') return this.queryRoute(parts[1], request, json)
    if (method === 'GET' && parts[0] === 'text' && parts.length === 2) {
      const text = this.data.get(`text/${parts[1]}.json`)
      return text ? new Response(text) : json({ error: 'no such text' }, 404)
    }
    if (parts[0] === 'files') {
      const path = parts.slice(1).join('/')
      if (method === 'GET') {
        const value = this.data.get(path)
        return value === undefined ? json({ error: 'no such file' }, 404) : new Response(value, { headers: { 'content-length': String(value.length) } })
      }
      if (method === 'PUT') {
        if (this.query.state !== 'stopped') return json({ error: 'busy' }, 409)
        this.data.set(path, await request.text())
        return json({ stored: path }, 201)
      }
    }
    return json({ error: 'not found' }, 404)
  }

  async queryRoute(action: string, request: Request, json: (b: unknown, s?: number) => Response): Promise<Response> {
    const q = this.query
    if (action === 'start') {
      if (q.state === 'stopped') {
        q.state = 'loading'
        q.polls = this.cloud.queryPolls
      }
      return json(this.queryStatus())
    }
    if (action === 'status') {
      if ((q.state === 'loading' || q.state === 'opening') && --q.polls <= 0) {
        q.state = q.state === 'loading' ? 'loaded' : 'ready'
        if (q.state === 'ready') q.openedAt = new Date().toISOString()
      }
      return json(this.queryStatus())
    }
    if (action === 'stop') {
      q.state = 'stopped'
      return json(this.queryStatus())
    }
    if (action === 'open') {
      if (q.state !== 'loaded') return json({ error: 'not loaded' }, 409)
      this.cloud.calls.push({ collection: this.name, method: 'POST', path: '/query/open', detail: 'open' })
      if (this.cloud.openWrites) this.data.set('system/databases/opened', `opened ${this.cloud.calls.length}`)
      q.state = 'opening'
      q.polls = this.cloud.queryPolls
      return json(this.queryStatus(), 202)
    }
    if (action === 'search') {
      if (q.state !== 'ready') return json({ error: 'not ready' }, 409)
      return json(this.search((await request.json()) as any))
    }
    return json({ error: 'not found' }, 404)
  }

  queryStatus() {
    return { state: this.query.state, dataFilesOpen: this.query.earlyOpen ? 1 : 0, loadedAt: null, openedAt: this.query.openedAt, error: null }
  }

  view(job: FakeJob) {
    return { id: job.id, op: job.op, state: job.state, exitCode: job.exitCode, progress: job.progress, result: job.result }
  }

  batch(job: FakeJob) {
    return JSON.parse(new TextDecoder().decode(this.inbox.get(`${job.args.batchId}/batch.json`) as Uint8Array))
  }

  progress(job: FakeJob) {
    const batch = this.batch(job)
    const files: Record<string, string> = {}
    const total = (batch.files ?? []).length
    const done = Math.max(0, total - job.polls)
    ;(batch.files ?? []).forEach((f: any, i: number) => {
      files[f.fileId] = i < done ? 'learned' : 'understanding'
    })
    return { done, total, current: null, files, read: true }
  }

  finish(job: FakeJob) {
    if (this.cloud.hangJobs.includes(job.op)) return
    this.lingering = this.cloud.lingerPolls
    try {
      job.result = this.run(job)
      job.state = 'succeeded'
      job.exitCode = 0
    } catch (error) {
      this.fail(job, error)
    }
  }

  fail(job: FakeJob, error: unknown) {
    job.state = 'failed'
    job.exitCode = error instanceof Crash ? 70 : 2
    job.result = error instanceof Stop ? error.result : undefined
    if (error instanceof Crash) job.progress = { done: 0, total: 0, current: error.fileId, files: { [error.fileId]: 'reading' } }
  }

  run(job: FakeJob): any {
    switch (job.op) {
      case 'manifest':
        return manifestOf(this.data)
      case 'stats': {
        const docs = [...this.data.keys()].filter((k) => k.startsWith('text/'))
        const passages = [...this.data.keys()].filter((k) => k.startsWith('passages/')).reduce((n, k) => n + JSON.parse(this.data.get(k)!).length, 0)
        return { documents: docs.length, passages, relational: { documents: docs.length, integrity: 'ok' } }
      }
      case 'grep': {
        const counts: Record<string, number> = {}
        for (const value of job.args.values) counts[value] = [...this.data.values()].reduce((n, v) => n + (v.split(value).length - 1), 0)
        return { counts }
      }
      case 'ingest':
        return this.ingest(job)
      case 'remove':
        return this.remove(job)
      case 'reread':
        return this.reread(job)
    }
    throw new Stop({ reason: 'unknown op' })
  }

  /**
   * The import's first step, at the job's start: read and hide every file and note (or take the texts stored after an
   * earlier try), stop on any failure, and write the redacted texts, so the progress says they are read.
   */
  read(job: FakeJob) {
    const batch = this.batch(job)
    if (JSON.parse(this.data.get('ledger.json') ?? '{"batches":{}}').batches[batch.importId]) throw new Stop({ reason: 'already ingested' })
    const words: string[] = batch.hiding?.words ?? []
    const test = this.env.KNOWLEDGE_TEST_CONTROLS === '1' ? (batch.test ?? {}) : {}
    const prepared: any[] = []
    const stored = (documentId: string) => JSON.parse(new TextDecoder().decode(this.inbox.get(`${batch.importId}/${documentId}.json`) as Uint8Array))
    const newlyHidden: string[] = []
    const again = (s: any) => {
      const more = hideFake(s.text, words)
      if (more.text !== s.text) newlyHidden.push(s.documentId)
      return { ...s, text: more.text, hidden: [...s.hidden, ...more.hidden] }
    }
    if (batch.kind === 'relearn') {
      // Saved texts are hidden again with the rules in force, as ops.py does.
      for (const d of batch.documents) prepared.push({ stored: { ...again(stored(d.documentId)), documentId: d.documentId, kind: d.kind, name: d.name }, fileId: null })
    } else {
      for (const f of batch.files ?? []) {
        if (f.stored) {
          prepared.push({ stored: again(stored(f.documentId)), fileId: f.fileId })
          continue
        }
        if (this.cloud.crashFileId === f.fileId || test.crashFileId === f.fileId) throw new Crash(f.fileId)
        if (this.cloud.failExtraction[f.fileId]) throw new Stop({ reason: this.cloud.failExtraction[f.fileId], failedFileId: f.fileId, permanent: true, code: 'unsupported_type' })
        const original = this.inbox.get(`${batch.importId}/${f.fileId}`)
        this.inbox.delete(`${batch.importId}/${f.fileId}`)
        if (this.cloud.detectorError || test.detectorError) {
          throw new Stop({ reason: 'Hiding sensitive information failed, so nothing from this import was stored.', failedFileId: f.fileId })
        }
        const text = hideFake(new TextDecoder().decode(original as Uint8Array), words)
        prepared.push({ stored: { documentId: f.documentId, kind: 'file', name: f.name, type: f.type, ...text, pageCount: null, truncated: false }, fileId: f.fileId })
      }
      for (const n of batch.notes ?? []) {
        const s = n.stored ? again(stored(n.documentId)) : { documentId: n.documentId, kind: 'note', name: n.title, type: 'text/markdown', ...hideFake(n.text, words), pageCount: null }
        prepared.push({ stored: s, fileId: null, noteId: n.noteId })
      }
    }
    for (const item of prepared) this.data.set(`text/${item.stored.documentId}.json`, JSON.stringify(item.stored))
    job.prepared = prepared
    job.newlyHidden = newlyHidden
    job.progress = { done: 0, total: prepared.length, current: null, read: true, files: Object.fromEntries((batch.files ?? []).map((f: any) => [f.fileId, 'understanding'])) }
  }

  ingest(job: FakeJob) {
    const batch = this.batch(job)
    const documents: any[] = []
    for (const item of job.prepared) {
      const s = item.stored
      this.data.set(`passages/${s.documentId}.json`, JSON.stringify(paragraphs(s.documentId, s.text)))
      this.data.set(`cognee/${s.documentId}`, `learned ${s.text}`)
      documents.push({ documentId: s.documentId, fileId: item.fileId, noteId: item.noteId, kind: s.kind, textBytes: Buffer.byteLength(s.text), pages: null, hidden: s.hidden.length, truncated: false, changed: true })
    }
    const facts = this.rebuildFacts()
    const ledger = JSON.parse(this.data.get('ledger.json') ?? '{"batches":{}}')
    ledger.batches[batch.importId] = documents.map((d) => d.documentId)
    this.data.set('ledger.json', JSON.stringify(ledger))
    return { documents, marks: [], facts, newFacts: documents.length, changed: job.newlyHidden ?? [], files: Object.fromEntries((batch.files ?? []).map((f: any) => [f.fileId, 'learned'])) }
  }

  remove(job: FakeJob) {
    const batch = this.batch(job)
    for (const id of batch.documentIds) {
      for (const key of [`text/${id}.json`, `passages/${id}.json`, `cognee/${id}`]) this.data.delete(key)
    }
    return { removed: batch.documentIds, documents: [], facts: this.rebuildFacts(), newFacts: 0 }
  }

  reread(job: FakeJob) {
    const batch = this.batch(job)
    const changed: string[] = []
    const documents: any[] = []
    const marks: any[] = []
    for (const id of batch.documentIds) {
      const stored = JSON.parse(this.data.get(`text/${id}.json`) ?? 'null')
      if (!stored) continue
      const again = hideFake(stored.text, batch.hiding?.words ?? [])
      if (again.text === stored.text) {
        documents.push({ documentId: id, changed: false, textBytes: Buffer.byteLength(stored.text), hidden: stored.hidden.length })
        continue
      }
      const oldPassages = JSON.parse(this.data.get(`passages/${id}.json`) ?? '[]')
      const updated = { ...stored, text: again.text, hidden: [...stored.hidden, ...again.hidden] }
      this.data.set(`text/${id}.json`, JSON.stringify(updated))
      const newPassages = paragraphs(id, again.text)
      this.data.set(`passages/${id}.json`, JSON.stringify(newPassages))
      this.data.set(`cognee/${id}`, `learned ${again.text}`)
      for (const mark of batch.marks ?? []) {
        if (mark.documentId !== id) continue
        const old = oldPassages.find((p: any) => p.textHash === mark.textHash)
        const moved = old ? newPassages.find((p: any) => p.index === old.index) : null
        marks.push({ documentId: id, textHash: mark.textHash, newTextHash: moved?.textHash ?? null, changed: !moved || moved.text !== old.text })
      }
      changed.push(id)
      documents.push({ documentId: id, changed: true, textBytes: Buffer.byteLength(again.text), hidden: updated.hidden.length })
    }
    return { documents, changed, marks, facts: this.rebuildFacts(), newFacts: 0 }
  }

  rebuildFacts() {
    // One fact per passage, from its first sentence, so a correction's outdated passage has a fact to hide.
    const facts: any[] = []
    for (const [key, value] of this.data) {
      if (!key.startsWith('passages/')) continue
      for (const passage of JSON.parse(value)) {
        const sentence = passage.text.split(/(?<=\.)\s/)[0]
        facts.push({ factId: `f_${passage.passageId}`, sentence, documentId: passage.documentId, passageId: passage.passageId, sourceSentence: sentence, textHash: passage.textHash })
      }
    }
    this.data.set('facts.json', JSON.stringify({ facts }))
    return facts.length
  }

  search(body: { query: string; topK: number; filters: any }) {
    const words = (body.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w))
    const inactive = new Set<string>(body.filters?.inactive ?? [])
    const outdated = new Set<string>((body.filters?.outdated ?? []).map(([d, h]: string[]) => `${d}:${h}`))
    const notesFor = new Map<string, string[]>()
    const notesByDoc = new Map<string, Set<string>>()
    for (const c of body.filters?.corrections ?? []) {
      for (const [d, h] of c.refs) {
        notesFor.set(`${d}:${h}`, [...(notesFor.get(`${d}:${h}`) ?? []), c.noteDocumentId])
        notesByDoc.set(d, new Set([...(notesByDoc.get(d) ?? []), c.noteDocumentId]))
      }
    }
    const all: any[] = []
    for (const [key, value] of this.data) if (key.startsWith('passages/')) all.push(...JSON.parse(value))
    const scored = all
      .map((p) => ({ ...p, score: words.length ? words.filter((w) => p.text.toLowerCase().includes(w)).length / words.length : 0 }))
      .sort((a, b) => b.score - a.score)
    const kept = new Map<string, any>()
    for (const p of scored) {
      if (inactive.has(p.documentId)) continue
      if (outdated.has(`${p.documentId}:${p.textHash}`)) {
        for (const note of notesFor.get(`${p.documentId}:${p.textHash}`) ?? []) {
          const first = all.find((x) => x.documentId === note)
          if (first && !inactive.has(note)) kept.set(first.passageId, { ...first, score: p.score + 1e-6 })
        }
        continue
      }
      if (!kept.has(p.passageId) || kept.get(p.passageId).score < p.score) kept.set(p.passageId, p)
    }
    for (const p of [...kept.values()]) {
      for (const note of notesByDoc.get(p.documentId) ?? []) {
        for (const n of kept.values()) if (n.documentId === note && n.score <= p.score) n.score = p.score + 1e-6
      }
    }
    const passages = [...kept.values()]
      .filter((p) => p.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, body.topK)
      .map((p) => ({ passageId: p.passageId, documentId: p.documentId, documentName: '', kind: 'file', page: null, start: p.start, end: p.end, text: p.text, textHash: p.textHash, score: Math.min(1, p.score), outdated: false }))
    const shown = new Set(passages.map((p) => p.passageId))
    const facts = JSON.parse(this.data.get('facts.json') ?? '{"facts":[]}').facts.filter((f: any) => shown.has(f.passageId))
    return { passages, facts }
  }
}

class Stop extends Error {
  result: any
  constructor(result: any) {
    super(result.reason)
    this.result = result
  }
}
class Crash extends Error {
  fileId: string
  constructor(fileId: string) {
    super('crashed')
    this.fileId = fileId
  }
}

const STOP = new Set(['what', 'the', 'and', 'does', 'how', 'are', 'for', 'with', 'which', 'when', 'who', 'many', 'long', 'much', 'this', 'that', 'into', 'from'])

/** The fake container's hiding: e-mail addresses and the organization's words. Offsets as JavaScript counts them. */
export function hideFake(text: string, words: string[]) {
  const hidden: { start: number; end: number; kind: string }[] = []
  const patterns: [RegExp, string][] = [[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email']]
  for (const w of words) patterns.push([new RegExp(`(?<!\\w)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'gi'), 'word'])
  let out = text
  for (const [pattern, kind] of patterns) {
    out = out.replace(pattern, (match, offset: number) => {
      hidden.push({ start: offset, end: offset + 8, kind })
      return '[hidden]'
    })
  }
  return { text: out, pages: [], hidden }
}

export function paragraphs(documentId: string, text: string) {
  const out: any[] = []
  let at = 0
  text.split(/\n\n/).forEach((para, index) => {
    const start = text.indexOf(para, at)
    at = start + para.length
    if (para.trim()) out.push({ passageId: `${documentId}:p${index}`, documentId, index, start, end: at, page: null, text: para, textHash: sha256(para) })
  })
  return out
}

export function manifestOf(data: Map<string, string>) {
  const entries: Record<string, { sha256: string; size: number }> = {}
  let bytes = 0
  for (const key of [...data.keys()].sort()) {
    entries[key] = { sha256: sha256(data.get(key)!), size: data.get(key)!.length }
    bytes += data.get(key)!.length
  }
  const digest = sha256(Object.entries(entries).map(([k, e]) => `${k}\0${e.sha256}\0${e.size}\n`).join(''))
  return { digest, files: Object.keys(entries).length, bytes, entries }
}
