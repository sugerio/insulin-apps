import {
  ENGINE_API_VERSION,
  ORG_HEADER,
  type AnswerRequest,
  type AnswerResult,
  type CollectionSettings,
  type CollectionStatus,
  type DocumentInfo,
  type DocumentText,
  type EngineError,
  type EngineErrorCode,
  type EngineHealth,
  type ExportStatus,
  type Fact,
  type GoBackPreview,
  type ImportExportRequest,
  type ImportNote,
  type ImportRequest,
  type ImportStatus,
  type KeepStagedRequest,
  type OrgHoldRequest,
  type OutboxPage,
  type RemoveResult,
  type RestorePoint,
  type SearchRequest,
  type SearchResult,
} from '../../../../engine/src/contract.ts'
import { beforeDeadline } from '../deadline.ts'
import type { EngineFetcher } from '../env.ts'

export { ENGINE_API_VERSION }

/**
 * A correction for the engine: the note it learns, with the passages it marks outdated. contract.ts names the route's
 * body `CorrectionRequest` without spelling it out; the body sent is the note both alone and as a one-note import,
 * so it reads as either.
 */
export interface CorrectionRequest {
  importId: string
  note: ImportNote
}

/** The engine answered with an error (`EngineError`), or couldn't be reached at all (status 0). */
export class EngineCallError extends Error {
  override name = 'EngineCallError'
  constructor(readonly status: number, readonly code: EngineErrorCode | 'unreachable', message: string, readonly retryAfterSeconds?: number) {
    super(message)
  }
}

/** The organization used on the engine's service-wide routes (the outbox, health), which belong to no organization. */
export const SERVICE_ORG = '_service'

/**
 * Anything the engine can be asked, typed on contract.ts, for one organization. With a `deadline` (the tick's), every
 * call, its body included, is given up at that time (EngineCallError 0 unreachable).
 */
export class EngineClient {
  constructor(private readonly engine: EngineFetcher, readonly org: string, private readonly deadline?: number) {}

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = { method, headers: { [ORG_HEADER]: this.org, accept: 'application/json', ...headers } }
    if (this.deadline !== undefined) init.signal = AbortSignal.timeout(Math.max(1, this.deadline - Date.now()))
    if (body !== undefined) {
      if (body instanceof ReadableStream || body instanceof Uint8Array || body instanceof ArrayBuffer) {
        init.body = body as BodyInit
        ;(init as RequestInit & { duplex?: string }).duplex = 'half'
      } else {
        init.body = JSON.stringify(body)
        ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
      }
    }
    let response: Response
    try {
      // A service binding routes by its own name; the host is only a placeholder.
      response = await beforeDeadline(this.engine.fetch(new Request(`https://engine.knowledge.insulinapps.localhost${path}`, init)), this.deadline, 'The engine')
    } catch (error) {
      throw new EngineCallError(0, 'unreachable', error instanceof Error ? error.message : 'The engine could not be reached')
    }
    if (response.ok) return response
    let failure: Partial<EngineError> = {}
    try {
      failure = (await beforeDeadline(response.json(), this.deadline, 'The engine')) as Partial<EngineError>
    } catch {
      // A body that isn't JSON says nothing more than the status.
    }
    throw new EngineCallError(response.status, (failure.error as EngineErrorCode) ?? 'internal', failure.message ?? `The engine answered ${response.status}`, failure.retryAfterSeconds)
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.call(method, path, body)
    try {
      return (await beforeDeadline(response.json(), this.deadline, 'The engine')) as T
    } catch (error) {
      throw new EngineCallError(0, 'unreachable', error instanceof Error ? error.message : 'The engine\'s answer could not be read')
    }
  }

  private static id(value: string): string {
    return encodeURIComponent(value)
  }

  /** 409 stale_settings when the engine already has a newer revision: a newer push won, and nothing changed. */
  putCollection(collectionId: string, settings: CollectionSettings): Promise<CollectionStatus> {
    return this.json('PUT', `/v1/collections/${EngineClient.id(collectionId)}`, { settings })
  }

  getCollection(collectionId: string): Promise<CollectionStatus> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}`)
  }

  wake(collectionId: string): Promise<CollectionStatus> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/wake`)
  }

  /**
   * Streams a file to the collection's inbox. The engine buffers it (at most 64 MB) and computes its SHA-256, which it
   * answers with; `sha256`, when known, is checked against it.
   */
  async stage(collectionId: string, fileId: string, body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>, file: { name: string; type: string; sha256?: string; bytes?: number }): Promise<{ fileId: string; bytes: number; sha256: string }> {
    const headers: Record<string, string> = { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }
    if (file.sha256) headers['x-file-sha256'] = file.sha256
    if (file.bytes !== undefined) headers['content-length'] = String(file.bytes)
    const response = await this.call('PUT', `/v1/collections/${EngineClient.id(collectionId)}/inbox/${EngineClient.id(fileId)}`, body, headers)
    return (await response.json()) as { fileId: string; bytes: number; sha256: string }
  }

  /**
   * Keeps staged files past the day the engine otherwise keeps them, for an import waiting for the 1st (`until` at most
   * 45 days ahead). Answers the ids it still had and now keeps; the others are gone.
   */
  keepStaged(collectionId: string, request: KeepStagedRequest): Promise<{ kept: string[] }> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/inbox/keep`, request)
  }

  /** Starts an empty collection from a Knowledge export staged in its inbox: an import like any other. */
  importExport(collectionId: string, request: ImportExportRequest): Promise<ImportStatus> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/import-export`, request)
  }

  startImport(collectionId: string, request: ImportRequest): Promise<ImportStatus> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/imports`, request)
  }

  getImport(collectionId: string, importId: string): Promise<ImportStatus> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/imports/${EngineClient.id(importId)}`)
  }

  /**
   * Cancels an import the engine hasn't started learning, or remembers an id it has no import for as cancelled, so a
   * submission with it still on its way learns nothing: answers it `cancelled`. 409 busy_learning once learning has
   * started or the import is finished.
   */
  cancelImport(collectionId: string, importId: string): Promise<ImportStatus> {
    return this.json('DELETE', `/v1/collections/${EngineClient.id(collectionId)}/imports/${EngineClient.id(importId)}`)
  }

  search(collectionId: string, request: SearchRequest): Promise<SearchResult> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/search`, request)
  }

  answer(request: AnswerRequest): Promise<AnswerResult> {
    return this.json('POST', '/v1/answer', request)
  }

  documents(collectionId: string): Promise<{ documents: DocumentInfo[] }> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/documents`)
  }

  document(collectionId: string, documentId: string): Promise<DocumentText> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/documents/${EngineClient.id(documentId)}`)
  }

  setDocumentActive(collectionId: string, documentId: string, active: boolean): Promise<ImportStatus> {
    return this.json('PATCH', `/v1/collections/${EngineClient.id(collectionId)}/documents/${EngineClient.id(documentId)}`, { active })
  }

  removeDocument(collectionId: string, documentId: string): Promise<RemoveResult> {
    return this.json('DELETE', `/v1/collections/${EngineClient.id(collectionId)}/documents/${EngineClient.id(documentId)}`)
  }

  facts(collectionId: string, cursor?: string | null): Promise<{ facts: Fact[]; next: string | null }> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/facts${query}`)
  }

  correct(collectionId: string, request: CorrectionRequest): Promise<ImportStatus> {
    const body = { ...request, files: [], notes: [request.note], small: true }
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/corrections`, body)
  }

  restorePoints(collectionId: string): Promise<{ restorePoints: RestorePoint[] }> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/restore-points`)
  }

  preview(collectionId: string, version: number): Promise<GoBackPreview> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/restore-points/${version}/preview`)
  }

  goBack(collectionId: string, version: number): Promise<CollectionStatus> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/restore-points/${version}/go-back`)
  }

  undo(collectionId: string): Promise<CollectionStatus> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/undo`)
  }

  startExport(collectionId: string, exportId: string): Promise<ExportStatus> {
    return this.json('POST', `/v1/collections/${EngineClient.id(collectionId)}/exports`, { exportId })
  }

  getExport(collectionId: string, exportId: string): Promise<ExportStatus> {
    return this.json('GET', `/v1/collections/${EngineClient.id(collectionId)}/exports/${EngineClient.id(exportId)}`)
  }

  /** The export's file, as the engine streams it; an export that isn't ready answers its status as JSON instead. */
  download(collectionId: string, exportId: string): Promise<Response> {
    return this.call('GET', `/v1/collections/${EngineClient.id(collectionId)}/exports/${EngineClient.id(exportId)}?download=1`)
  }

  /** 202 `{ state: 'deleting' }`, or `{ state: 'deleted' }` once the delete has finished (asking again is safe). */
  async deleteCollection(collectionId: string): Promise<{ state: 'deleting' | 'deleted' }> {
    const response = await this.call('DELETE', `/v1/collections/${EngineClient.id(collectionId)}`)
    const body = (await beforeDeadline(response.json(), this.deadline, 'The engine').catch(() => ({}))) as { state?: string }
    return { state: body.state === 'deleted' ? 'deleted' : 'deleting' }
  }

  /**
   * The awake-hours stop, enforced in the engine: until `until` nothing runs for the organization but removing a file
   * for good and deleting; `null` lets go.
   */
  hold(org: string, request: OrgHoldRequest): Promise<{ held: boolean; until: string | null }> {
    return this.json('POST', `/v1/orgs/${encodeURIComponent(org)}/hold`, request)
  }

  async purge(org: string): Promise<void> {
    await this.call('POST', `/v1/orgs/${encodeURIComponent(org)}/purge`)
  }

  outbox(since: string | null, limit: number): Promise<OutboxPage> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (since) query.set('since', since)
    return this.json('GET', `/v1/outbox?${query}`)
  }

  health(): Promise<EngineHealth> {
    return this.json('GET', '/v1/health')
  }
}
