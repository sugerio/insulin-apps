// Typed access to one collection's Durable Object storage. Large values (checksum manifests, a restore point's
// answer state) are split into chunks, so no single value nears the storage limit.

import type {
  AnswerState,
  ExportRecord,
  ImportRecord,
  Ledger,
  Manifest,
  Meta,
  PendingEvent,
  RestorePointRecord,
  Runtime,
  SnapshotRecord,
  StagedFile,
} from './types.ts'
import { clock, iso } from './util.ts'

const CHUNK_CHARS = 100_000
const LOG_KEEP = 300

type Writer = Pick<DurableObjectStorage, 'put' | 'delete'> | DurableObjectTransaction

export function chunkEntries(prefix: string, value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value)
  const entries: Record<string, unknown> = {}
  let count = 0
  for (let at = 0; at < text.length || count === 0; at += CHUNK_CHARS) {
    entries[`${prefix}#${count}`] = text.slice(at, at + CHUNK_CHARS)
    count += 1
  }
  entries[`${prefix}#n`] = count
  return entries
}

export class CollectionStore {
  storage: DurableObjectStorage

  constructor(storage: DurableObjectStorage) {
    this.storage = storage
  }

  // ------------------------------------------------------------ chunked values

  async putChunked(prefix: string, value: unknown, writer: Writer = this.storage): Promise<void> {
    const entries = chunkEntries(prefix, value)
    const keys = Object.keys(entries)
    for (let i = 0; i < keys.length; i += 100) {
      await writer.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])))
    }
  }

  async getChunked<T>(prefix: string, reader: Pick<DurableObjectStorage, 'get'> | DurableObjectTransaction = this.storage): Promise<T | undefined> {
    const count = await reader.get<number>(`${prefix}#n`)
    if (count === undefined) return undefined
    const keys = Array.from({ length: count }, (_, i) => `${prefix}#${i}`)
    let text = ''
    for (let i = 0; i < keys.length; i += 100) {
      const got = await reader.get<string>(keys.slice(i, i + 100))
      for (const key of keys.slice(i, i + 100)) text += got.get(key) ?? ''
    }
    return JSON.parse(text) as T
  }

  async deleteChunked(prefix: string, writer: Writer = this.storage): Promise<void> {
    const count = (await this.storage.get<number>(`${prefix}#n`)) ?? 0
    const keys = [...Array.from({ length: count }, (_, i) => `${prefix}#${i}`), `${prefix}#n`]
    for (let i = 0; i < keys.length; i += 100) await writer.delete(keys.slice(i, i + 100))
  }

  // ------------------------------------------------------------ records

  getMeta = () => this.storage.get<Meta>('meta')
  putMeta = (meta: Meta) => this.storage.put('meta', meta)

  getRuntime = () => this.storage.get<Runtime>('runtime')
  putRuntime = (runtime: Runtime) => this.storage.put('runtime', runtime)
  deleteRuntime = () => this.storage.delete('runtime')

  getImport = (importId: string, reader: Pick<DurableObjectStorage, 'get'> | DurableObjectTransaction = this.storage) =>
    reader.get<ImportRecord>(`imp:${importId}`)
  putImport = (record: ImportRecord, writer: Writer = this.storage) => writer.put(`imp:${record.status.importId}`, record)
  async listImports(): Promise<ImportRecord[]> {
    return [...(await this.storage.list<ImportRecord>({ prefix: 'imp:' })).values()]
  }

  getPoint = (version: number) => this.storage.get<RestorePointRecord>(`rp:${pad(version)}`)
  putPoint = (point: RestorePointRecord, writer: Writer = this.storage) => writer.put(`rp:${pad(point.version)}`, point)
  async listPoints(): Promise<RestorePointRecord[]> {
    return [...(await this.storage.list<RestorePointRecord>({ prefix: 'rp:' })).values()].sort((a, b) => a.version - b.version)
  }

  getState = (version: number, reader?: DurableObjectTransaction) => this.getChunked<AnswerState>(`state:${pad(version)}`, reader)
  putState = (version: number, state: AnswerState, writer?: Writer) => this.putChunked(`state:${pad(version)}`, state, writer)

  getSnapshot = (id: string) => this.storage.get<SnapshotRecord>(`snap:${id}`)
  putSnapshot = (record: SnapshotRecord, writer: Writer = this.storage) => writer.put(`snap:${record.handle.id}`, record)
  async listSnapshots(): Promise<SnapshotRecord[]> {
    return [...(await this.storage.list<SnapshotRecord>({ prefix: 'snap:' })).values()]
  }
  getManifest = (snapshotId: string) => this.getChunked<Manifest>(`manifest:${snapshotId}`)
  putManifest = (snapshotId: string, manifest: Manifest, writer?: Writer) => this.putChunked(`manifest:${snapshotId}`, manifest, writer)

  getStaged = (fileId: string) => this.storage.get<StagedFile>(`staged:${fileId}`)
  putStaged = (file: StagedFile) => this.storage.put(`staged:${file.fileId}`, file)
  deleteStaged = (fileIds: string[]) => (fileIds.length ? this.storage.delete(fileIds.map((id) => `staged:${id}`)) : Promise.resolve(0))
  async listStaged(): Promise<StagedFile[]> {
    return [...(await this.storage.list<StagedFile>({ prefix: 'staged:' })).values()]
  }

  getExport = (exportId: string) => this.storage.get<ExportRecord>(`exp:${exportId}`)
  putExport = (record: ExportRecord) => this.storage.put(`exp:${record.status.exportId}`, record)
  async listExports(): Promise<ExportRecord[]> {
    return [...(await this.storage.list<ExportRecord>({ prefix: 'exp:' })).values()]
  }

  async getLedger(): Promise<Ledger> {
    return (await this.storage.get<Ledger>('ledger')) ?? { kind: null, since: null, totals: {}, lastFlushAt: clock.now() }
  }
  putLedger = (ledger: Ledger) => this.storage.put('ledger', ledger)

  async pendingEvents(): Promise<[string, PendingEvent][]> {
    return [...(await this.storage.list<PendingEvent>({ prefix: 'pending:' })).entries()]
  }
  async addEvents(events: PendingEvent[], writer: Writer = this.storage): Promise<void> {
    if (!events.length) return
    const stamp = `${pad(clock.now(), 15)}`
    await writer.put(Object.fromEntries(events.map((e, i) => [`pending:${stamp}:${String(i).padStart(3, '0')}:${e.key}`, e])))
  }

  /** The engine's own log, for the harness's evidence (ASK-06 reads the order of the checksum check and the open). */
  async log(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    const entries = (await this.storage.get<unknown[]>('log')) ?? []
    entries.push({ at: iso(), event, ...detail })
    await this.storage.put('log', entries.slice(-LOG_KEEP))
    console.log(JSON.stringify({ event, ...detail }))
  }
  async readLog(): Promise<unknown[]> {
    return (await this.storage.get<unknown[]>('log')) ?? []
  }
}

export const pad = (n: number, width = 10): string => String(n).padStart(width, '0')
