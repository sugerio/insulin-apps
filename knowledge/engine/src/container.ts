// The collection's container, as the Durable Object sees it: Cloudflare's ctx.container (start, destroy, snapshots)
// and the control server inside it (container/server.py) on port 8080. Every Cognee operation is a job in its own
// process; the query process is the one Cognee process that stays loaded between questions.
//
// Calls to the control server can drop while the container still runs ("Network connection lost.": on Cloudflare,
// about a second after a container starts, a job starts, or a job ends and the next starts). Each call is sent again
// then (send), so a drop costs no try. Every call is safe to send twice: reads; inbox writes and a backup's files put
// back (the same file again replaces it); deleting a batch's inbox, and cleanup; the query process's start (it
// answers the one running), stop, status and search; and jobs, whose id the Durable Object chooses: POST /jobs with an
// id the server already has answers that job and never starts a second one (server.py). Opening the databases again
// answers that it is under way (query.py; an older image answered 409, which the wake reads the same:
// CollectionEngine.continueOpen).

import type { Manifest, SnapshotHandle } from './types.ts'
import { SETTINGS, type InstanceType } from './settings.ts'
import { clock, errorText } from './util.ts'

/** Waits before each new send of a call that dropped: up to five more sends over about 30 seconds. */
export const DROP_WAITS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]
/** A question doesn't wait that long: two more sends over about 3 seconds, then it answers "busy". */
const QUESTION_DROP_WAITS_MS = [1_000, 2_000]

/** A request's options, or a function that makes them for each send when the body is a stream (it can be read once). */
type Init = RequestInit | (() => Promise<RequestInit>)

/** A body sent as it is, or made again for each send (a stream from R2). */
type Body = string | (() => Promise<BodyInit>)

export interface Drop {
  path: string
  drops: number // this call's drops so far
  error: string
}

export interface Job {
  id: string
  op: string
  state: 'running' | 'succeeded' | 'failed'
  exitCode?: number
  durationMs?: number
  progress?: JobProgress
  result?: any
  error?: string
}

export interface JobProgress {
  done: number
  total: number
  current: string | null
  files?: Record<string, 'reading' | 'understanding' | 'learned' | 'failed'>
  read?: boolean // every file and note of the import was read and hidden; their texts can be fetched
}

export interface Health {
  ok: boolean
  bootId: string
  activeJob: string | null
  dataFormat: string
  query: { state: string }
}

export interface QueryStatus {
  state: 'stopped' | 'loading' | 'loaded' | 'opening' | 'ready' | 'failed'
  dataFilesOpen: number // files under /data the query process holds open
  loadedAt: string | null
  openedAt: string | null
  error: string | null
}

export interface Quiesce {
  quiescent: boolean
  activeJob: string | null
  query: string
  strayProcesses: unknown[]
  openDataFiles: unknown[]
  inboxFiles: number
}

export class ContainerError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export class ContainerClient {
  container: Container
  /** Told of each call that dropped and is sent again (the Durable Object logs it). */
  onDrop: ((drop: Drop) => Promise<unknown>) | null = null

  constructor(container: Container) {
    this.container = container
  }

  get running(): boolean {
    return this.container.running
  }

  /** The engine image this deployment runs. A change makes older snapshots unusable (they are tied to an image). */
  get image(): string {
    const images = Object.entries(this.container.images ?? {}).sort(([a], [b]) => a.localeCompare(b))
    return images.map(([name, ref]) => `${name}=${ref}`).join(',') || 'unknown'
  }

  start(options: { snapshot: SnapshotHandle | null; instance: InstanceType; env?: Record<string, string>; labels?: Record<string, string> }): void {
    const common = { enableInternet: false, instance: options.instance, env: options.env, labels: options.labels }
    if (options.snapshot) {
      this.container.start({ ...common, containerSnapshot: { id: options.snapshot.id } })
    } else {
      const base = this.container.images?.base
      this.container.start(base ? { ...common, image: base } : common)
    }
  }

  async destroy(reason: string): Promise<boolean> {
    if (!this.container.running) return false
    await this.container.destroy(reason)
    for (let i = 0; i < 200 && this.container.running; i++) await clock.wait(100)
    return true
  }

  setInactivityTimeout(ms: number): Promise<void> {
    return this.container.setInactivityTimeout(ms)
  }

  snapshot(name: string): Promise<SnapshotHandle> {
    return this.container.snapshotContainer({ name })
  }

  /** One request to the control server, as it goes: nothing is sent again (waiting for the server to listen). */
  fetchOnce(path: string, init?: RequestInit): Promise<Response> {
    return this.container.getTcpPort(SETTINGS.containerPort).fetch(`http://container${path}`, init)
  }

  /**
   * Sends a request to the control server and reads the answer with `read`. When the call drops while the container
   * still runs, the same request is sent again after DROP_WAITS_MS; a container that stopped, an answer of any status
   * (`read` throws ContainerError for those) or a run of drops past the last wait ends it with the error.
   */
  async send<T>(path: string, init: Init | undefined, read: (response: Response) => Promise<T>, waits: number[] = DROP_WAITS_MS): Promise<T> {
    for (let drops = 0; ; drops++) {
      // Made before the send, outside the try: a body that can't be made (its R2 object is gone) is no drop.
      const options = typeof init === 'function' ? await init() : init
      try {
        return await read(await this.fetchOnce(path, options))
      } catch (error) {
        if (error instanceof ContainerError || drops >= waits.length || !this.container.running) throw error
        await this.onDrop?.({ path: path.split('?')[0], drops: drops + 1, error: errorText(error) }).catch(() => undefined)
        await clock.wait(waits[drops])
        if (!this.container.running) throw error
      }
    }
  }

  call<T>(path: string, init?: Init, waits?: number[]): Promise<T> {
    return this.send(
      path,
      init,
      async (response) => {
        const text = await response.text()
        let body: unknown
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          body = { raw: text.slice(0, 500) }
        }
        if (!response.ok) throw new ContainerError(`container ${path} answered ${response.status}`, response.status, body)
        return body as T
      },
      waits,
    )
  }

  post<T>(path: string, body: unknown = {}, waits?: number[]): Promise<T> {
    return this.call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, waits)
  }

  async waitHealthy(timeoutMs = SETTINGS.healthTimeoutMs): Promise<Health> {
    const deadline = clock.now() + timeoutMs
    while (clock.now() < deadline) {
      if (!this.container.running) throw new ContainerError('container stopped while starting', 0, null)
      try {
        const response = await this.fetchOnce('/health', { signal: AbortSignal.timeout(2000) })
        if (response.ok) return (await response.json()) as Health
        await response.body?.cancel()
      } catch {
        // Not listening yet.
      }
      await clock.wait(250)
    }
    throw new ContainerError('container did not become healthy', 0, null)
  }

  // ------------------------------------------------------------ jobs

  /** Starts a job under an id chosen here, so a send repeated after a drop names the same job (never a second one). */
  startJob(op: string, args: Record<string, unknown> = {}, id = jobId(op)): Promise<Job> {
    return this.post<Job>('/jobs', { id, op, args })
  }

  getJob(id: string): Promise<Job> {
    return this.call<Job>(`/jobs/${encodeURIComponent(id)}`)
  }

  /** Runs a short job to the end (the manifest, stats). Long jobs are polled from the alarm instead. */
  async runJob(op: string, args: Record<string, unknown> = {}, timeoutMs = SETTINGS.jobTimeoutMs): Promise<Job> {
    let job = await this.startJob(op, args)
    const deadline = clock.now() + timeoutMs
    while (job.state === 'running') {
      if (clock.now() > deadline) throw new ContainerError(`${op} job timed out`, 0, { job: job.id })
      await clock.wait(op === 'manifest' ? 200 : 1000)
      job = await this.getJob(job.id)
    }
    if (job.state !== 'succeeded') throw new ContainerError(`${op} job failed`, 0, { exitCode: job.exitCode, error: job.error })
    return job
  }

  manifest(): Promise<Manifest> {
    return this.runJob('manifest').then((job) => job.result as Manifest)
  }

  async waitQuiescent(timeoutMs = SETTINGS.quiesceTimeoutMs): Promise<Quiesce> {
    const deadline = clock.now() + timeoutMs
    let last: Quiesce | undefined
    while (clock.now() < deadline) {
      last = await this.call<Quiesce>('/quiesce')
      if (last.quiescent) return last
      await clock.wait(500)
    }
    throw new ContainerError('container did not quiesce', 0, last)
  }

  // ------------------------------------------------------------ inbox, text and files

  /** Stages a file of an import. Writing the same file again replaces it, so a drop sends it again. */
  putInbox(batch: string, name: string, body: Body): Promise<unknown> {
    return this.call(`/inbox/${encodeURIComponent(batch)}/${encodeURIComponent(name)}`, put(body))
  }

  deleteInbox(batch: string): Promise<unknown> {
    return this.call(`/inbox/${encodeURIComponent(batch)}`, { method: 'DELETE' })
  }

  /** A learned document's text or another small file, read whole; null when the server has none (yet). */
  readText(path: string): Promise<string | null> {
    return this.send(path, undefined, async (response) => {
      if (response.ok) return response.text()
      await response.body?.cancel()
      return null
    })
  }

  /** A file under /data, read whole (the facts); null when there is none. */
  readFile(path: string): Promise<string | null> {
    return this.readText(filePath(path))
  }

  /**
   * Streams a file under /data to `write` (a backup's upload). A drop, or an upload that fails because the stream
   * broke (R2 refuses a body whose checksum doesn't match), reads the file again from the start.
   */
  copyFile(path: string, write: (body: ReadableStream) => Promise<unknown>): Promise<void> {
    return this.send(filePath(path), undefined, async (response) => {
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new ContainerError(`could not read ${path} for the backup`, response.status, null)
      }
      await write(response.body)
    })
  }

  putFile(path: string, body: Body): Promise<unknown> {
    return this.call(filePath(path), put(body))
  }

  cleanup(): Promise<unknown> {
    return this.post('/cleanup')
  }

  // ------------------------------------------------------------ the query process

  queryStart(): Promise<QueryStatus> {
    return this.post<QueryStatus>('/query/start')
  }

  queryOpen(): Promise<QueryStatus> {
    return this.post<QueryStatus>('/query/open')
  }

  queryStatus(): Promise<QueryStatus> {
    return this.call<QueryStatus>('/query/status')
  }

  queryStop(): Promise<QueryStatus> {
    return this.post<QueryStatus>('/query/stop')
  }

  querySearch<T>(body: unknown): Promise<T> {
    return this.post<T>('/query/search', body, QUESTION_DROP_WAITS_MS)
  }
}

const filePath = (path: string) => `/files/${path.split('/').map(encodeURIComponent).join('/')}`

const put = (body: Body): Init => (typeof body === 'string' ? { method: 'PUT', body } : async () => ({ method: 'PUT', body: await body() }))

/** A job id the server takes as given (its names: letters, digits, dot, dash and underscore). */
const jobId = (op: string) => `${op}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
