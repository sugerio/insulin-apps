// The collection's container, as the Durable Object sees it: Cloudflare's ctx.container (start, destroy, snapshots)
// and the control server inside it (container/server.py) on port 8080. Every Cognee operation is a job in its own
// process; the query process is the one Cognee process that stays loaded between questions.

import type { Manifest, SnapshotHandle } from './types.ts'
import { SETTINGS, type InstanceType } from './settings.ts'
import { clock } from './util.ts'

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

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.container.getTcpPort(SETTINGS.containerPort).fetch(`http://container${path}`, init)
  }

  async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init)
    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { raw: text.slice(0, 500) }
    }
    if (!response.ok) throw new ContainerError(`container ${path} answered ${response.status}`, response.status, body)
    return body as T
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  async waitHealthy(timeoutMs = SETTINGS.healthTimeoutMs): Promise<Health> {
    const deadline = clock.now() + timeoutMs
    while (clock.now() < deadline) {
      if (!this.container.running) throw new ContainerError('container stopped while starting', 0, null)
      try {
        const response = await this.fetch('/health', { signal: AbortSignal.timeout(2000) })
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

  startJob(op: string, args: Record<string, unknown> = {}): Promise<Job> {
    return this.post<Job>('/jobs', { op, args })
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

  putInbox(batch: string, name: string, body: BodyInit): Promise<unknown> {
    return this.call(`/inbox/${encodeURIComponent(batch)}/${encodeURIComponent(name)}`, { method: 'PUT', body })
  }

  deleteInbox(batch: string): Promise<unknown> {
    return this.call(`/inbox/${encodeURIComponent(batch)}`, { method: 'DELETE' })
  }

  /** A file under /data, streamed (backups). */
  getFile(path: string): Promise<Response> {
    return this.fetch(`/files/${path.split('/').map(encodeURIComponent).join('/')}`)
  }

  putFile(path: string, body: BodyInit): Promise<unknown> {
    return this.call(`/files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body })
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
    return this.post<T>('/query/search', body)
  }
}
