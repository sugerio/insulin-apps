// The in-memory engine: every route of contract.ts, answered from memory, for `npm run dev`, the local stack, the
// workerd smoke test and the app's tests. It keeps the real engine's rules where the app can see them (one import per
// collection at a time, 2 per organization and 20 in all with notes and corrections first; all or nothing; already
// here; three tries; questions wait while learning and while waking; restore points with go back, undo and remove for
// good, changes within 5 minutes sharing one restore point; organizations kept apart) and none of its machinery (no
// containers, models or storage). Unlike the real engine it goes back and undoes at once, rather than in an alarm. It also has a control
// interface that puts a collection asleep, waking or learning, fails the next import or records usage, for tests.
//
// Development only: the app imports it dynamically when it runs without the SUGER_ENGINE binding in a development
// build, so production builds never contain it (scripts/check-no-stub.mjs looks for STUB_MARKER).

import { ENGINE_API_VERSION, ORG_HEADER } from '../contract'
import type {
  AnswerRequest,
  AnswerResult,
  CollectionCounts,
  CollectionSettings,
  CollectionState,
  CollectionStatus,
  DocumentInfo,
  DocumentText,
  EngineErrorCode,
  ExportStatus,
  Fact,
  GoBackPreview,
  HiddenSpan,
  ImportFileStatus,
  ImportNote,
  ImportRequest,
  ImportStatus,
  NotRestorableReason,
  OutboxEvent,
  Passage,
  PassageRef,
  RemoveResult,
  RestorePoint,
  SearchResult,
  UsageKind,
} from '../contract'
import { applyHiding, DEFAULT_HIDING, type HidingRuleSet } from './hiding'
import { bestSentence, COVERED_THRESHOLD, extractText, firstSentence, keywords, passagesOf, ReadError, score, sha256Hex } from './text'

/** Found in the stub's code and nowhere else: a production build that contains it contains the stub. */
export const STUB_MARKER = 'insulin-knowledge-in-memory-engine'

export interface StubTiming {
  /** How long a sleeping collection takes to wake. */
  wakeMs: number
  /** An import's fixed time, and its time per file or note. */
  importMs: number
  perDocumentMs: number
}

export interface StubOptions {
  now?: () => number
  timing?: Partial<StubTiming>
  /** Imports at once: per organization and for the whole service. */
  capacity?: { organization: number; service: number }
}

/** What the control interface can do (tests call it directly; the stub Worker serves it under /__control/). */
export interface StubControl {
  /** Forces a collection's state until `seconds` pass (forever without), or clears it with `null`. */
  setState(org: string, collectionId: string, state: 'asleep' | 'waking' | 'learning' | 'busy' | 'ready' | null, seconds?: number): void
  /** The next import of a collection (or any) is interrupted `times` times; at 3 it fails, naming `fileName` (or its first file). */
  failNextImport(options?: { org?: string; collectionId?: string; times?: number; fileName?: string }): void
  /** Records running time as the engine's ledger would. */
  addUsage(org: string, collectionId: string, kind: UsageKind, seconds: number): void
  /** Keeps every import from finishing until released. */
  hold(on: boolean): void
  /** Moves the clock forward. */
  advance(ms: number): void
  /** How the built-in model behaves: answers, cites a passage it wasn't given, or is unavailable. */
  setAnswerMode(mode: 'ok' | 'bad_citation' | 'fail'): void
  setTiming(timing: Partial<StubTiming>): void
  /** Marks a restore point as having failed its integrity check twice (not restorable, reason `damaged`). */
  damage(org: string, collectionId: string, version: number): void
  /** Finishes everything that can finish now (imports included, even when held). */
  runUntilIdle(): void
  reset(): void
  snapshot(): { collections: { org: string; collectionId: string; state: CollectionState; version: number; documents: number }[]; outbox: number }
}

export interface StubEngine {
  fetch(request: Request): Promise<Response>
  control: StubControl
}

interface StoredDocument {
  info: DocumentInfo
  text: string
  pages: { page: number; start: number; end: number }[]
  hidden: HiddenSpan[]
  passages: Passage[]
  words: Set<string>[]
  /** Set aside by going back to a version from before it was added: kept, not used. */
  setAside: boolean
}

interface Content {
  documents: Map<string, StoredDocument>
  /** Outdated passages, as `documentId:textHash`. */
  outdated: Set<string>
  corrections: number
}

type PointKind = 'import' | 'change' | 'go_back' | 'undo' | 'remove' | 'reread'

/** What a restore point changed, for its summary; folded restore points add theirs up. */
interface Changes {
  files: number
  notes: number
  corrections: number
  stopped: number
  resumed: number
}

interface Snapshot {
  version: number
  createdAt: number
  kind: PointKind
  changes: Changes
  summary: string
  content: Content
  restorable: boolean
  reason: NotRestorableReason | null
  /** The version undo goes back to: the one before this change (before the first of folded changes). */
  previous: number | null
  /** Folded into a later restore point made within 5 minutes: no longer listed. */
  folded: boolean
}

interface StagedFile {
  bytes: Uint8Array
  name: string
  type: string
  sha256: string
}

interface RunningImport {
  status: ImportStatus
  request: ImportRequest
  correction: boolean
  /** Arrival order, for who goes first among equals. */
  order: number
  startedAt: number | null
  finishAt: number | null
}

interface StubCollection {
  org: string
  id: string
  settings: CollectionSettings
  deleted: boolean
  content: Content
  version: number
  snapshots: Map<number, Snapshot>
  imports: Map<string, RunningImport>
  queue: string[]
  running: string | null
  exports: Map<string, ExportStatus & { body: string }>
  inbox: Map<string, StagedFile>
  awakeSince: number | null
  awakeUntil: number | null
  wakingUntil: number | null
  lastQuestionAt: number | null
  lastBackupAt: number | null
  forced: { state: 'asleep' | 'waking' | 'learning' | 'busy' | 'ready'; until: number | null } | null
  /** Removals for good not yet committed: they go ahead of every import, with their version reserved. */
  removals: { documentId: string; name: string; version: number }[]
}

interface Failure {
  org?: string
  collectionId?: string
  times: number
  fileName?: string
}

class StubError extends Error {
  constructor(readonly status: number, readonly code: EngineErrorCode, message: string, readonly retryAfterSeconds?: number) {
    super(message)
  }
}

const DEV_TIMING: StubTiming = { wakeMs: 0, importMs: 0, perDocumentMs: 0 }
const DAY_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9_-]{1,64}$/
/** The engine buffers what it stages, up to 64 MB. */
const MAX_STAGED_BYTES = 64 * 1024 * 1024
/** Changes within this long of the last one share its restore point. */
const SHARE_RESTORE_POINT_MS = 5 * 60 * 1000
const FOLDABLE = new Set<PointKind>(['import', 'change'])
const NO_CHANGES: Changes = { files: 0, notes: 0, corrections: 0, stopped: 0, resumed: 0 }

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** A restore point's summary in plain words: "Added 5 files", "Added a note", "Correction", "Stopped using 1 file". */
function describe(changes: Changes): string {
  const parts: string[] = []
  if (changes.files) parts.push(`Added ${plural(changes.files, 'file')}`)
  if (changes.notes) parts.push(`${changes.files ? 'and' : 'Added'} ${changes.notes === 1 ? 'a note' : plural(changes.notes, 'note')}`)
  if (changes.corrections) parts.push(changes.corrections === 1 ? 'Correction' : plural(changes.corrections, 'correction'))
  if (changes.stopped) parts.push(`Stopped using ${plural(changes.stopped, 'file')}`)
  if (changes.resumed) parts.push(`Using ${plural(changes.resumed, 'file')} again`)
  return parts.join(parts.length === 2 && changes.files && changes.notes ? ' ' : ', ') || 'No changes'
}

const addChanges = (a: Changes, b: Changes): Changes => ({ files: a.files + b.files, notes: a.notes + b.notes, corrections: a.corrections + b.corrections, stopped: a.stopped + b.stopped, resumed: a.resumed + b.resumed })

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

function copyContent(content: Content): Content {
  const documents = new Map<string, StoredDocument>()
  for (const [id, document] of content.documents) {
    documents.set(id, { ...document, info: { ...document.info }, pages: [...document.pages], hidden: [...document.hidden], passages: document.passages.map((passage) => ({ ...passage })), words: document.words })
  }
  return { documents, outdated: new Set(content.outdated), corrections: content.corrections }
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function createStubEngine(options: StubOptions = {}): StubEngine {
  const baseNow = options.now ?? Date.now
  const capacity = options.capacity ?? { organization: 2, service: 20 }
  let offset = 0
  let timing: StubTiming = { ...DEV_TIMING, ...options.timing }
  const now = () => baseNow() + offset
  let collections = new Map<string, StubCollection>()
  let outbox: { seq: number; event: OutboxEvent }[] = []
  let sequence = 0
  let failures: Failure[] = []
  let held = false
  let answerMode: 'ok' | 'bad_citation' | 'fail' = 'ok'
  let order = 0

  const key = (org: string, collectionId: string) => `${org}\u0000${collectionId}`

  function emit(event: Omit<OutboxEvent, 'id' | 'at'> & Record<string, unknown>): void {
    sequence += 1
    outbox.push({ seq: sequence, event: { id: `e${sequence}`, at: new Date(now()).toISOString(), ...event } as OutboxEvent })
    const cutoff = now() - 7 * DAY_MS
    outbox = outbox.filter((entry) => Date.parse(entry.event.at) >= cutoff)
  }

  function find(org: string, collectionId: string): StubCollection {
    const collection = collections.get(key(org, collectionId))
    if (!collection) throw new StubError(404, 'not_found', 'There is no such collection.')
    return collection
  }

  function live(org: string, collectionId: string): StubCollection {
    const collection = find(org, collectionId)
    if (collection.deleted) throw new StubError(409, 'deleting', 'This collection is being deleted.')
    return collection
  }

  // ------------------------------------------------------------------ state

  function running(collection: StubCollection): RunningImport | null {
    return collection.running ? collection.imports.get(collection.running) ?? null : null
  }

  function forcedState(collection: StubCollection): StubCollection['forced'] {
    if (collection.forced && collection.forced.until !== null && collection.forced.until <= now()) collection.forced = null
    return collection.forced
  }

  function stateOf(collection: StubCollection): CollectionState {
    if (collection.deleted) return 'deleted'
    const forced = forcedState(collection)
    if (forced && forced.state !== 'busy') return forced.state
    const current = running(collection)
    if (current) return current.status.state === 'saving' ? 'saving' : 'learning'
    if (collection.removals.length) return 'learning'
    if (collection.wakingUntil !== null && collection.wakingUntil > now()) return 'waking'
    if (collection.awakeUntil !== null && collection.awakeUntil > now()) return 'ready'
    if (collection.version === 0 && collection.content.documents.size === 0) return 'empty'
    return 'asleep'
  }

  function counts(content: Content): CollectionCounts {
    let activeDocuments = 0
    let passages = 0
    let facts = 0
    let textBytes = 0
    for (const document of content.documents.values()) {
      textBytes += new TextEncoder().encode(document.text).byteLength
      if (!document.info.active) continue
      activeDocuments += 1
      for (const passage of document.passages) {
        if (content.outdated.has(`${passage.documentId}:${passage.textHash}`)) continue
        passages += 1
        facts += 1
      }
    }
    return { documents: content.documents.size, activeDocuments, passages, facts, textBytes }
  }

  function statusOf(collection: StubCollection): CollectionStatus {
    const state = stateOf(collection)
    const current = running(collection)
    const lastSnapshot = collection.snapshots.get(collection.version)
    return {
      collectionId: collection.id,
      state,
      version: collection.version,
      counts: counts(collection.content),
      currentImport: current ? { ...current.status } : null,
      queuedImports: collection.queue.length,
      wake: state === 'waking' ? { step: 2, fromBackup: false, etaSeconds: Math.max(1, Math.ceil(((collection.wakingUntil ?? now()) - now()) / 1000)) } : null,
      lastRestorePointAt: iso(lastSnapshot?.createdAt ?? null),
      lastBackupAt: iso(collection.lastBackupAt),
      lastQuestionAt: iso(collection.lastQuestionAt),
      settings: collection.settings,
    }
  }

  /** Starts the awake window after a question or a commit; a collection that was asleep starts counting awake time. */
  function keepAwake(collection: StubCollection): void {
    if (collection.awakeSince === null) collection.awakeSince = now()
    collection.awakeUntil = now() + collection.settings.awakeMinutes * 60_000
  }

  /** Starts waking a sleeping collection. One put to sleep by the control interface takes at least a minute to wake. */
  function wake(collection: StubCollection): void {
    if (stateOf(collection) !== 'asleep') return
    const ms = collection.forced?.state === 'asleep' ? Math.max(timing.wakeMs, 60_000) : timing.wakeMs
    collection.forced = null
    if (ms <= 0) {
      keepAwake(collection)
      return
    }
    collection.wakingUntil = now() + ms
    collection.awakeSince = now()
  }

  // ------------------------------------------------------------------ imports

  function eta(collection: StubCollection, item: RunningImport): number {
    const finish = item.finishAt ?? now() + durationOf(item.request)
    let wait = Math.max(0, finish - now())
    if (item.startedAt === null) for (const id of collection.queue) if (id !== item.status.importId) wait += durationOf(collection.imports.get(id)!.request)
    return Math.ceil(wait / 1000)
  }

  function durationOf(request: ImportRequest): number {
    return timing.importMs + timing.perDocumentMs * (request.files.length + request.notes.length)
  }

  function start(collection: StubCollection, item: RunningImport): void {
    collection.queue = collection.queue.filter((id) => id !== item.status.importId)
    collection.running = item.status.importId
    item.startedAt = now()
    item.finishAt = now() + durationOf(item.request)
    item.status.state = 'learning'
    item.status.queuePosition = null
    item.status.waitingFor = null
    item.status.files = item.status.files.map((file) => ({ ...file, state: 'understanding' }))
  }

  function pump(force = false): void {
    for (let rounds = 0; rounds < 1000; rounds += 1) {
      let changed = false
      for (const collection of collections.values()) {
        // Removals for good go ahead of everything, the import running included.
        if (collection.removals.length && (force || !held)) {
          commitRemovals(collection)
          changed = true
        }
        const current = running(collection)
        if (current && (force || !held) && (current.finishAt ?? 0) <= now()) {
          finish(collection, current)
          changed = true
        }
        if (collection.wakingUntil !== null && collection.wakingUntil <= now()) {
          collection.wakingUntil = null
          keepAwake(collection)
        }
        if (collection.awakeUntil !== null && collection.awakeUntil <= now() && !running(collection)) {
          const since = collection.awakeSince ?? collection.awakeUntil
          const seconds = Math.round((collection.awakeUntil - since) / 1000)
          collection.awakeSince = null
          collection.awakeUntil = null
          if (seconds > 0) emit({ org: collection.org, collectionId: collection.id, type: 'usage', kind: 'awake', seconds })
        }
      }
      // Start what may start: one per collection, small ones first, within the organization's and the service's capacity.
      const waiting = [...collections.values()]
        .filter((collection) => !collection.deleted && !collection.running && collection.queue.length > 0)
        .map((collection) => ({ collection, item: next(collection) }))
        .sort((a, b) => Number(b.item.request.small) - Number(a.item.request.small) || a.item.order - b.item.order)
      for (const { collection, item } of waiting) {
        const service = [...collections.values()].filter((other) => other.running).length
        const organization = [...collections.values()].filter((other) => other.running && other.org === collection.org).length
        if (organization >= capacity.organization) {
          item.status.waitingFor = 'organization'
          continue
        }
        if (service >= capacity.service) {
          item.status.waitingFor = 'service'
          continue
        }
        start(collection, item)
        changed = true
      }
      if (!changed) break
    }
    for (const collection of collections.values()) {
      collection.queue.forEach((id, index) => {
        const item = collection.imports.get(id)!
        item.status.queuePosition = index + 1
        item.status.etaSeconds = eta(collection, item)
      })
      const current = running(collection)
      if (current) current.status.etaSeconds = eta(collection, current)
    }
  }

  function next(collection: StubCollection): RunningImport {
    const items = collection.queue.map((id) => collection.imports.get(id)!)
    return items.find((item) => item.request.small) ?? items[0]!
  }

  function failureFor(collection: StubCollection): Failure | null {
    const index = failures.findIndex((failure) => (!failure.org || failure.org === collection.org) && (!failure.collectionId || failure.collectionId === collection.id))
    return index >= 0 ? failures[index]! : null
  }

  function finished(collection: StubCollection, item: RunningImport): void {
    collection.running = null
    item.status.finishedAt = new Date(now()).toISOString()
    item.status.etaSeconds = null
    item.status.queuePosition = null
    item.status.waitingFor = null
    emit({ org: collection.org, collectionId: collection.id, type: 'import', import: { ...item.status, files: item.status.files.map((file) => ({ ...file })) } })
    const seconds = Math.round(((item.finishAt ?? now()) - (item.startedAt ?? now())) / 1000)
    if (seconds > 0) emit({ org: collection.org, collectionId: collection.id, type: 'usage', kind: 'learning', seconds })
  }

  function failImport(collection: StubCollection, item: RunningImport, fileId: string | null, message: string, code: EngineErrorCode = 'internal'): void {
    item.status.state = 'failed'
    item.status.failedFileId = fileId
    item.status.error = { error: code, message }
    item.status.files = item.status.files.map((file) =>
      file.fileId === fileId ? { ...file, state: 'failed', reason: message } : { ...file, state: 'waiting' },
    )
    finished(collection, item)
  }

  function finish(collection: StubCollection, item: RunningImport): void {
    const failure = failureFor(collection)
    if (failure) {
      failure.times -= 1
      if (failure.times <= 0) failures = failures.filter((other) => other !== failure)
      if (item.status.attempt >= 3) {
        const file = item.request.files.find((candidate) => candidate.name === failure.fileName) ?? item.request.files[0]
        failImport(collection, item, file?.fileId ?? null, `Couldn't learn “${file?.name ?? 'the note'}” after 3 tries.`)
        return
      }
      // Interrupted: nothing from it is kept, and it tries again.
      const stopped = { ...item.status, state: 'interrupted' as const, files: item.status.files.map((file) => ({ ...file })) }
      emit({ org: collection.org, collectionId: collection.id, type: 'import', import: stopped })
      item.status.attempt += 1
      item.status.state = 'queued'
      item.status.files = item.status.files.map((file) => ({ ...file, state: 'waiting' }))
      item.startedAt = null
      item.finishAt = null
      collection.running = null
      collection.queue.unshift(item.status.importId)
      return
    }
    learn(collection, item)
  }

  function learn(collection: StubCollection, item: RunningImport): void {
    const content = copyContent(collection.content)
    const files: ImportFileStatus[] = []
    const added: StoredDocument[] = []
    const rules = collection.settings.hiding
    for (const file of item.request.files) {
      const staged = collection.inbox.get(file.fileId)
      if (!staged) {
        failImport(collection, item, file.fileId, `“${file.name}” wasn't received. Add it again.`, 'bad_request')
        return
      }
      const existing = [...content.documents.values()].find((document) => document.info.sha256 === staged.sha256)
      if (existing || added.some((document) => document.info.sha256 === staged.sha256)) {
        files.push({ fileId: file.fileId, name: file.name, state: 'already_here', documentId: existing?.info.documentId })
        continue
      }
      let read
      try {
        read = extractText(staged.bytes, file.type || staged.type, file.name)
      } catch (error) {
        // A file that can't be read stops the batch: nothing from it is kept.
        const reason = error instanceof ReadError ? error.reason : `Couldn't read “${file.name}”.`
        failImport(collection, item, file.fileId, reason, error instanceof ReadError && error.code === 'unsupported_type' ? 'unsupported_type' : 'bad_request')
        return
      }
      const document = buildDocument('file', file.name, file.type || staged.type, staged.bytes.byteLength, staged.sha256, read.text, read.pages, rules, collection.version + 1)
      added.push(document)
      files.push({
        fileId: file.fileId,
        name: file.name,
        state: 'learned',
        documentId: document.info.documentId,
        ...(read.truncated ? { reason: 'Only the first 2 MB of its text was learned.' } : {}),
      })
    }
    for (const note of item.request.notes) {
      const text = note.title.trim() ? `${note.title.trim()}\n\n${note.text}` : note.text
      added.push(buildDocument('note', note.title.trim() || 'Note', 'text/plain', new TextEncoder().encode(text).byteLength, '', text, [], rules, collection.version + 1, note))
    }
    for (const file of item.request.files) collection.inbox.delete(file.fileId)
    item.status.files = files
    if (added.length === 0) {
      item.status.state = 'duplicate'
      finished(collection, item)
      return
    }
    for (const document of added) content.documents.set(document.info.documentId, document)
    for (const note of item.request.notes) for (const ref of note.outdated) content.outdated.add(`${ref.documentId}:${ref.textHash}`)
    if (item.correction) content.corrections += 1
    const filesAdded = added.filter((document) => document.info.kind === 'file').length
    const notesAdded = added.length - filesAdded
    commit(collection, content, 'import', item.correction ? { ...NO_CHANGES, files: filesAdded, corrections: notesAdded } : { ...NO_CHANGES, files: filesAdded, notes: notesAdded }, { importId: item.status.importId })
    item.status.state = 'committed'
    item.status.version = collection.version
    item.status.newFacts = added.reduce((sum, document) => sum + document.passages.length, 0)
    finished(collection, item)
    keepAwake(collection)
  }

  function buildDocument(kind: 'file' | 'note', name: string, type: string, bytes: number, sha256: string, raw: string, pages: { page: number; start: number; end: number }[], rules: HidingRuleSet, version: number, note?: ImportNote): StoredDocument {
    const documentId = note ? `n_${note.noteId}` : randomId('d')
    const hidden = applyHiding(raw, rules)
    // The page map moves with the text where values were hidden.
    const shift = (offset: number) => {
      let delta = 0
      for (const range of hidden.found) if (range.end <= offset) delta += 8 - (range.end - range.start)
      return offset + delta
    }
    const mapped = pages.map((page) => ({ page: page.page, start: shift(page.start), end: shift(page.end) }))
    const passages = passagesOf(hidden.text, mapped).map((span, index) => ({
      passageId: `${documentId}:${index + 1}`,
      documentId,
      documentName: name,
      kind,
      page: span.page,
      start: span.start,
      end: span.end,
      text: span.text,
      textHash: sha256Hex(span.text),
      score: 0,
      outdated: false,
    }))
    return {
      info: { documentId, kind, name, type, bytes, textBytes: new TextEncoder().encode(hidden.text).byteLength, pages: mapped.length || null, sha256: sha256 || documentId, active: true, addedAt: new Date(now()).toISOString(), version },
      text: hidden.text,
      pages: mapped,
      hidden: hidden.hidden,
      passages,
      words: passages.map((passage) => keywords(passage.text)),
      setAside: false,
    }
  }

  /**
   * Commits a restore point. A change within 5 minutes of the last one shares its restore point: the earlier one folds
   * into the new one (it is no longer listed, and undo takes both back). Going back, undo, removals and re-reads
   * never fold. `importId` is the app's import, or null when none is involved (going back, undo).
   */
  function commit(collection: StubCollection, content: Content, kind: PointKind, changes: Changes, options: { importId?: string | null; summary?: string; previous?: number | null; version?: number } = {}): void {
    const prev = collection.snapshots.get(collection.version)
    const fold = !!prev && !prev.folded && prev.restorable && FOLDABLE.has(prev.kind) && FOLDABLE.has(kind) && now() - prev.createdAt < SHARE_RESTORE_POINT_MS
    const total = fold ? addChanges(prev!.changes, changes) : changes
    const version = Math.max(collection.version + 1, options.version ?? 0)
    const summary = options.summary ?? describe(total)
    const previous = options.previous !== undefined ? options.previous : fold ? prev!.previous : collection.version || null
    if (fold) prev!.folded = true
    collection.version = version
    collection.content = content
    for (const document of content.documents.values()) if (document.info.version > version) document.info.version = version
    collection.snapshots.set(version, { version, createdAt: now(), kind: fold && prev!.kind === 'import' ? 'import' : kind, changes: total, summary, content: copyContent(content), restorable: true, reason: null, previous, folded: false })
    collection.lastBackupAt = now()
    emit({ org: collection.org, collectionId: collection.id, type: 'committed', version, summary, counts: counts(content), importId: options.importId ?? null })
    emit({ org: collection.org, collectionId: collection.id, type: 'backup', version })
  }

  /** Pending removals for good, each its own restore point, at the version it was promised. */
  function commitRemovals(collection: StubCollection): void {
    for (const removal of collection.removals.splice(0)) {
      commit(collection, copyContent(collection.content), 'remove', NO_CHANGES, { importId: `rm-${removal.documentId}-${removal.version}`, summary: `Removed “${removal.name}” for good`, version: removal.version })
    }
  }

  /** Stop using / use again: committed at once, or `duplicate` when nothing changes. */
  function changeStatus(collection: StubCollection, importId: string, state: 'committed' | 'duplicate'): ImportStatus {
    const at = new Date(now()).toISOString()
    return {
      importId, state, attempt: 1, queuePosition: null, waitingFor: null, files: [], notes: 0,
      version: collection.version, newFacts: 0, failedFileId: null, error: null, etaSeconds: null, createdAt: at, finishedAt: at,
    }
  }

  function enqueue(collection: StubCollection, request: ImportRequest, correction: boolean): { status: ImportStatus; created: boolean } {
    const existing = collection.imports.get(request.importId)
    if (existing) return { status: existing.status, created: false }
    for (const file of request.files) {
      if (!collection.inbox.has(file.fileId)) throw new StubError(400, 'bad_request', `“${file.name}” wasn't received. Add it again.`)
    }
    if (collection.queue.length >= 100) throw new StubError(429, 'capacity', 'This collection has too many imports waiting.', 60)
    const status: ImportStatus = {
      importId: request.importId,
      state: 'queued',
      attempt: 1,
      queuePosition: collection.queue.length + 1,
      waitingFor: null,
      files: request.files.map((file) => ({ fileId: file.fileId, name: file.name, state: 'waiting' })),
      notes: request.notes.length,
      version: null,
      newFacts: null,
      failedFileId: null,
      error: null,
      etaSeconds: null,
      createdAt: new Date(now()).toISOString(),
      finishedAt: null,
    }
    order += 1
    collection.imports.set(request.importId, { status, request, correction, order, startedAt: null, finishAt: null })
    collection.queue.push(request.importId)
    return { status, created: true }
  }

  // ------------------------------------------------------------------ search and facts

  function facts(content: Content): Fact[] {
    const list: Fact[] = []
    for (const document of content.documents.values()) {
      if (!document.info.active) continue
      for (const passage of document.passages) {
        if (content.outdated.has(`${passage.documentId}:${passage.textHash}`)) continue
        const sentence = firstSentence(passage.text)
        list.push({ factId: `f_${passage.passageId}`, sentence, documentId: document.info.documentId, passageId: passage.passageId, sourceSentence: sentence })
      }
    }
    return list
  }

  function search(collection: StubCollection, query: string, topK: number): SearchResult {
    const forced = forcedState(collection)
    const answer = (status: SearchResult['status'], retryAfterSeconds: number | null): SearchResult => ({ status, retryAfterSeconds, covered: false, passages: [], facts: [], version: collection.version })
    if (forced?.state === 'busy') return answer('busy', 30)
    const state = stateOf(collection)
    if (state === 'learning' || state === 'saving') return answer('learning', Math.max(5, running(collection)?.status.etaSeconds ?? 60))
    if (state === 'waking') return answer('waking', Math.max(1, Math.ceil(((collection.wakingUntil ?? now() + 60_000) - now()) / 1000)))
    if (state === 'asleep') {
      wake(collection)
      if (stateOf(collection) === 'waking') return answer('waking', Math.max(1, Math.ceil(((collection.wakingUntil ?? now()) - now()) / 1000)))
    }
    collection.lastQuestionAt = now()
    if (state !== 'empty') keepAwake(collection)
    const wanted = keywords(query)
    const found: Passage[] = []
    for (const document of collection.content.documents.values()) {
      if (!document.info.active) continue
      document.passages.forEach((passage, index) => {
        if (collection.content.outdated.has(`${passage.documentId}:${passage.textHash}`)) return
        let value = score(wanted, document.words[index] ?? new Set())
        if (value <= 0) return
        // Notes, corrections among them, rank above the file passages they match as well.
        if (document.info.kind === 'note') value = Math.min(1, value + 0.05)
        found.push({ ...passage, score: Math.round(value * 1000) / 1000 })
      })
    }
    found.sort((a, b) => b.score - a.score || a.passageId.localeCompare(b.passageId))
    const passages = found.slice(0, topK)
    const covered = (passages[0]?.score ?? 0) >= COVERED_THRESHOLD
    const factList = facts(collection.content).filter((fact) => passages.some((passage) => passage.passageId === fact.passageId)).slice(0, 5)
    return { status: 'ok', retryAfterSeconds: null, covered, passages, facts: factList, version: collection.version }
  }

  // ------------------------------------------------------------------ history

  function restorePoints(collection: StubCollection): RestorePoint[] {
    return [...collection.snapshots.values()]
      .filter((snapshot) => !snapshot.folded)
      .sort((a, b) => b.version - a.version)
      .map((snapshot) => {
        const expired = snapshot.restorable && snapshot.createdAt < now() - 30 * DAY_MS && snapshot.version !== collection.version
        return {
          version: snapshot.version,
          createdAt: new Date(snapshot.createdAt).toISOString(),
          summary: snapshot.summary,
          documents: snapshot.content.documents.size,
          restorable: snapshot.restorable && !expired,
          reason: expired ? 'expired' : snapshot.reason,
          current: snapshot.version === collection.version,
        }
      })
  }

  function preview(collection: StubCollection, version: number): GoBackPreview {
    const snapshot = collection.snapshots.get(version)
    if (!snapshot || snapshot.folded) throw new StubError(404, 'not_found', 'There is no such restore point.')
    const point = restorePoints(collection).find((candidate) => candidate.version === version)!
    const setAside = [...collection.content.documents.values()]
      .filter((document) => !snapshot.content.documents.has(document.info.documentId) && !document.setAside)
      .map((document) => ({ documentId: document.info.documentId, name: document.info.name }))
    return {
      version,
      documents: snapshot.content.documents.size,
      setAside,
      correctionsUndone: Math.max(0, collection.content.corrections - snapshot.content.corrections),
      restorable: point.restorable,
      reason: point.reason,
    }
  }

  /** Goes back to a restore point (undo: to the one before the current change). Later files are set aside, not deleted. */
  function goBack(collection: StubCollection, version: number, undo: boolean): CollectionStatus {
    if (running(collection) || collection.removals.length) throw new StubError(409, 'busy_learning', 'Going back waits until the collection finishes learning.')
    const view = preview(collection, version)
    if (version === collection.version && !undo) return statusOf(collection)
    if (!view.restorable) throw new StubError(409, 'not_restorable', 'This version can no longer be brought back.')
    const from = collection.version
    const current = collection.snapshots.get(from)
    const content = copyContent(collection.snapshots.get(version)!.content)
    for (const document of collection.content.documents.values()) {
      if (!content.documents.has(document.info.documentId)) {
        content.documents.set(document.info.documentId, { ...document, info: { ...document.info, active: false }, setAside: true })
      }
    }
    commit(collection, content, undo ? 'undo' : 'go_back', NO_CHANGES, {
      importId: null,
      summary: undo ? `Undid “${current?.summary ?? `version ${from}`}”` : `Went back to version ${version}`,
      previous: from,
    })
    keepAwake(collection)
    return statusOf(collection)
  }

  // ------------------------------------------------------------------ routes

  async function body<T>(request: Request): Promise<T> {
    try {
      return (await request.json()) as T
    } catch {
      throw new StubError(400, 'bad_request', 'The request body must be JSON.')
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    pump()
    if (path === '/v1/health' && method === 'GET') return json({ engine: `in-memory stub, API ${ENGINE_API_VERSION}`, collections: [...collections.values()].filter((collection) => !collection.deleted).length })
    if (path === '/v1/outbox' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
      const after = outbox.filter((entry) => entry.seq > since)
      const page = after.slice(0, limit)
      return json({ events: page.map((entry) => entry.event), cursor: String(page.at(-1)?.seq ?? since), more: after.length > page.length })
    }
    if (path === '/v1/answer' && method === 'POST') return json(answer(await body<AnswerRequest>(request)))
    const purge = path.match(/^\/v1\/orgs\/([^/]+)\/purge$/)
    if (purge && method === 'POST') {
      const org = decodeURIComponent(purge[1]!)
      for (const collection of collections.values()) if (collection.org === org && !collection.deleted) remove(collection)
      return json({ state: 'deleting' }, 202)
    }
    const match = path.match(/^\/v1\/collections\/([^/]+)(\/.*)?$/)
    if (!match) throw new StubError(404, 'not_found', 'There is no such route.')
    const org = request.headers.get(ORG_HEADER)?.trim()
    if (!org) throw new StubError(400, 'bad_request', `Every request names the organization in ${ORG_HEADER}.`)
    const collectionId = decodeURIComponent(match[1]!)
    if (!ID.test(collectionId)) throw new StubError(400, 'bad_request', 'That collection id is not valid.')
    const rest = match[2] ?? ''
    if (rest === '' && method === 'PUT') {
      const { settings } = await body<{ settings: CollectionSettings }>(request)
      if (!settings || typeof settings !== 'object') throw new StubError(400, 'bad_request', 'Send the collection\'s settings.')
      const elsewhere = [...collections.values()].find((collection) => collection.id === collectionId && collection.org !== org)
      if (elsewhere) throw new StubError(404, 'not_found', 'There is no such collection.')
      let collection = collections.get(key(org, collectionId))
      if (collection?.deleted) throw new StubError(409, 'deleting', 'This collection is being deleted.')
      if (!collection) {
        collection = {
          org, id: collectionId, settings: normalSettings(settings), deleted: false, content: { documents: new Map(), outdated: new Set(), corrections: 0 },
          version: 0, snapshots: new Map(), imports: new Map(), queue: [], running: null, exports: new Map(), inbox: new Map(),
          awakeSince: null, awakeUntil: null, wakingUntil: null, lastQuestionAt: null, lastBackupAt: null, forced: null, removals: [],
        }
        collections.set(key(org, collectionId), collection)
      } else {
        rehide(collection, normalSettings(settings))
      }
      return json(statusOf(collection))
    }
    if (rest === '' && method === 'GET') return json(statusOf(find(org, collectionId)))
    if (rest === '' && method === 'DELETE') {
      const collection = find(org, collectionId)
      if (collection.deleted) return json({ state: 'deleted' }, 202)
      remove(collection)
      return json({ state: 'deleting' }, 202)
    }
    const collection = live(org, collectionId)
    if (rest === '/wake' && method === 'POST') {
      wake(collection)
      return json(statusOf(collection))
    }
    const inbox = rest.match(/^\/inbox\/([^/]+)$/)
    if (inbox && method === 'PUT') {
      const fileId = decodeURIComponent(inbox[1]!)
      if (!ID.test(fileId)) throw new StubError(400, 'bad_request', 'That file id is not valid.')
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > MAX_STAGED_BYTES) throw new StubError(413, 'too_large', 'This file is too large.')
      const sha256 = sha256Hex(bytes)
      const expected = request.headers.get('x-file-sha256')?.trim().toLowerCase()
      if (expected && expected !== sha256) throw new StubError(400, 'bad_request', 'The file changed on the way. Add it again.')
      let name = 'file'
      try {
        name = decodeURIComponent(request.headers.get('x-file-name') ?? 'file')
      } catch {
        throw new StubError(400, 'bad_request', 'The file name is not valid.')
      }
      collection.inbox.set(fileId, { bytes, name, type: request.headers.get('content-type') ?? 'application/octet-stream', sha256 })
      return json({ fileId, bytes: bytes.byteLength, sha256 })
    }
    if (rest === '/imports' && method === 'POST') {
      const request_ = await body<ImportRequest>(request)
      // The same import id answers the import it started, whatever the body says now.
      const existing = typeof request_?.importId === 'string' ? collection.imports.get(request_.importId) : undefined
      if (existing) return json(existing.status, 200)
      validateImport(request_)
      const { status, created } = enqueue(collection, request_, false)
      pump()
      return json(created ? currentStatus(collection, status.importId) : status, created ? 202 : 200)
    }
    const oneImport = rest.match(/^\/imports\/([^/]+)$/)
    if (oneImport && method === 'GET') {
      const item = collection.imports.get(decodeURIComponent(oneImport[1]!))
      if (!item) throw new StubError(404, 'not_found', 'There is no such import.')
      return json(item.status)
    }
    if (rest === '/search' && method === 'POST') {
      const { query, topK } = await body<{ query: string; topK?: number }>(request)
      if (typeof query !== 'string' || !query.trim()) throw new StubError(400, 'bad_request', 'Ask a question.')
      return json(search(collection, query, Math.min(20, Math.max(1, Math.floor(topK ?? 8)))))
    }
    if (rest === '/documents' && method === 'GET') return json({ documents: [...collection.content.documents.values()].map((document) => document.info) })
    const document = rest.match(/^\/documents\/([^/]+)$/)
    if (document) {
      const documentId = decodeURIComponent(document[1]!)
      const stored = collection.content.documents.get(documentId)
      const pending = collection.removals.find((removal) => removal.documentId === documentId)
      if (pending && method === 'DELETE') {
        const blocked = [...collection.snapshots.values()].filter((snapshot) => snapshot.reason === 'removed_for_good' && !snapshot.folded).map((snapshot) => snapshot.version)
        return json({ version: pending.version, blockedRestorePoints: blocked.sort((a, b) => a - b) } satisfies RemoveResult)
      }
      if (!stored) throw new StubError(404, 'not_found', 'There is no such document.')
      if (method === 'GET') return json({ document: stored.info, text: stored.text, pages: stored.pages, hidden: stored.hidden } satisfies DocumentText)
      if (method === 'PATCH') {
        const { active } = await body<{ active: boolean }>(request)
        if (typeof active !== 'boolean') throw new StubError(400, 'bad_request', 'Say whether to use the file.')
        if (collection.removals.length) throw new StubError(409, 'busy_learning', 'A file is being removed for good; try again in a minute.')
        const importId = randomId('chg')
        if (stored.info.active === active) return json(changeStatus(collection, importId, 'duplicate'))
        const content = copyContent(collection.content)
        const changed = content.documents.get(documentId)!
        changed.info.active = active
        changed.setAside = false
        commit(collection, content, 'change', { ...NO_CHANGES, stopped: active ? 0 : 1, resumed: active ? 1 : 0 }, { importId })
        const status = changeStatus(collection, importId, 'committed')
        emit({ org: collection.org, collectionId: collection.id, type: 'import', import: status })
        return json(status)
      }
      if (method === 'DELETE') {
        // Remove for good: the text goes at once, from every restore point too, and those that held it can't be
        // brought back. The removal commits as its own restore point, ahead of every import, at the version promised.
        const version = collection.version + 1 + collection.removals.length
        const content = copyContent(collection.content)
        content.documents.delete(documentId)
        collection.content = content
        const blocked: number[] = []
        for (const snapshot of collection.snapshots.values()) {
          if (snapshot.content.documents.delete(documentId)) {
            snapshot.restorable = false
            snapshot.reason = 'removed_for_good'
            if (!snapshot.folded) blocked.push(snapshot.version)
          }
        }
        collection.removals.push({ documentId, name: stored.info.name, version })
        pump()
        return json({ version, blockedRestorePoints: blocked.sort((a, b) => a - b) } satisfies RemoveResult)
      }
    }
    if (rest === '/facts' && method === 'GET') {
      const all = facts(collection.content)
      const from = Math.max(0, Number(url.searchParams.get('cursor') ?? 0) || 0)
      const page = all.slice(from, from + 50)
      return json({ facts: page, next: from + 50 < all.length ? String(from + 50) : null })
    }
    if (rest === '/corrections' && method === 'POST') {
      const raw = await body<{ importId?: string; note?: ImportNote; notes?: ImportNote[] }>(request)
      const note = raw.note ?? raw.notes?.[0]
      if (typeof raw.importId !== 'string' || !ID.test(raw.importId) || !note || typeof note.text !== 'string' || !note.text.trim()) {
        throw new StubError(400, 'bad_request', 'Send the correction as a note.')
      }
      const request_: ImportRequest = { importId: raw.importId, files: [], notes: [normalNote(note)], small: true }
      const { status, created } = enqueue(collection, request_, true)
      pump()
      return json(created ? currentStatus(collection, status.importId) : status, created ? 202 : 200)
    }
    if (rest === '/restore-points' && method === 'GET') return json({ restorePoints: restorePoints(collection) })
    const point = rest.match(/^\/restore-points\/(\d+)\/(preview|go-back)$/)
    if (point) {
      const version = Number(point[1])
      if (point[2] === 'preview' && method === 'GET') return json(preview(collection, version))
      if (point[2] === 'go-back' && method === 'POST') return json(goBack(collection, version, false))
    }
    if (rest === '/undo' && method === 'POST') {
      const previous = collection.snapshots.get(collection.version)?.previous ?? null
      if (!previous) throw new StubError(409, 'not_restorable', 'There is nothing to undo.')
      return json(goBack(collection, previous, true))
    }
    if (rest === '/exports' && method === 'POST') {
      const { exportId } = await body<{ exportId: string }>(request)
      if (typeof exportId !== 'string' || !ID.test(exportId)) throw new StubError(400, 'bad_request', 'Send an export id.')
      const existing = collection.exports.get(exportId)
      if (existing) return json(exportStatus(existing))
      const content = JSON.stringify(exportOf(collection), null, 2)
      const status = { exportId, state: 'ready' as const, bytes: new TextEncoder().encode(content).byteLength, readyAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 7 * DAY_MS).toISOString(), body: content }
      collection.exports.set(exportId, status)
      return json(exportStatus(status))
    }
    const oneExport = rest.match(/^\/exports\/([^/]+)$/)
    if (oneExport && method === 'GET') {
      const status = collection.exports.get(decodeURIComponent(oneExport[1]!))
      if (!status) throw new StubError(404, 'not_found', 'There is no such export.')
      if (url.searchParams.get('download') === '1' && status.state === 'ready') {
        return new Response(status.body, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="collection-${collection.id}.json"` } })
      }
      return json(exportStatus(status))
    }
    throw new StubError(404, 'not_found', 'There is no such route.')
  }

  function currentStatus(collection: StubCollection, importId: string): ImportStatus {
    return collection.imports.get(importId)!.status
  }

  function exportStatus(status: ExportStatus): ExportStatus {
    return { exportId: status.exportId, state: status.state, bytes: status.bytes, readyAt: status.readyAt, expiresAt: status.expiresAt }
  }

  function exportOf(collection: StubCollection) {
    return {
      format: 'insulin-knowledge-export',
      collectionId: collection.id,
      version: collection.version,
      documents: [...collection.content.documents.values()].map((document) => ({ ...document.info, text: document.text, pages: document.pages })),
      outdated: [...collection.content.outdated].map((entry): PassageRef => ({ documentId: entry.slice(0, entry.lastIndexOf(':')), textHash: entry.slice(entry.lastIndexOf(':') + 1) })),
      facts: facts(collection.content),
      history: restorePoints(collection),
    }
  }

  function normalSettings(settings: CollectionSettings): CollectionSettings {
    return {
      hiding: { ...DEFAULT_HIDING, ...(settings.hiding ?? {}), words: Array.isArray(settings.hiding?.words) ? settings.hiding.words.filter((word) => typeof word === 'string') : [] },
      keepReady: settings.keepReady ?? null,
      awakeMinutes: Number.isFinite(settings.awakeMinutes) && settings.awakeMinutes > 0 ? settings.awakeMinutes : 10,
    }
  }

  function normalNote(note: ImportNote): ImportNote {
    return {
      noteId: typeof note.noteId === 'string' && ID.test(note.noteId) ? note.noteId : randomId('note').slice(5),
      title: typeof note.title === 'string' ? note.title.slice(0, 200) : '',
      text: note.text,
      outdated: Array.isArray(note.outdated) ? note.outdated.filter((ref) => typeof ref?.documentId === 'string' && typeof ref?.textHash === 'string') : [],
    }
  }

  function validateImport(request: ImportRequest): void {
    if (!request || typeof request.importId !== 'string' || !ID.test(request.importId)) throw new StubError(400, 'bad_request', 'Send an import id.')
    if (!Array.isArray(request.files) || !Array.isArray(request.notes)) throw new StubError(400, 'bad_request', 'Send the files and notes to learn.')
    if (request.files.length + request.notes.length === 0) throw new StubError(400, 'bad_request', 'There is nothing to learn.')
    request.notes = request.notes.map(normalNote)
    request.small = Boolean(request.small)
  }

  /** Stricter rules apply to what is stored: re-read, a new restore point, and older ones with the text blocked. */
  function rehide(collection: StubCollection, settings: CollectionSettings): void {
    const before = collection.settings.hiding
    collection.settings = settings
    const after = settings.hiding
    const stricter = (['emails', 'phones', 'cards', 'apiKeys', 'secrets'] as const).some((rule) => after[rule] && !before[rule]) || after.words.some((word) => !before.words.includes(word))
    if (!stricter || collection.content.documents.size === 0) return
    const content = copyContent(collection.content)
    const changed = new Set<string>()
    for (const [id, document] of content.documents) {
      const result = applyHiding(document.text, after)
      if (result.found.length === 0) continue
      const rebuilt = buildDocument(document.info.kind, document.info.name, document.info.type, document.info.bytes, document.info.sha256, document.text, document.pages, after, document.info.version)
      content.documents.set(id, { ...rebuilt, info: { ...rebuilt.info, documentId: id, active: document.info.active, addedAt: document.info.addedAt }, passages: rebuilt.passages.map((passage) => ({ ...passage, documentId: id, passageId: passage.passageId.replace(rebuilt.info.documentId, id) })), hidden: [...document.hidden, ...rebuilt.hidden] })
      changed.add(id)
    }
    if (changed.size === 0) return
    for (const snapshot of collection.snapshots.values()) {
      if ([...changed].some((id) => snapshot.content.documents.has(id))) {
        snapshot.restorable = false
        snapshot.reason = 'newly_hidden'
      }
    }
    commit(collection, content, 'reread', NO_CHANGES, { summary: 'Hid information under the new rules' })
  }

  function remove(collection: StubCollection): void {
    collection.deleted = true
    collection.content = { documents: new Map(), outdated: new Set(), corrections: 0 }
    collection.snapshots.clear()
    collection.inbox.clear()
    collection.exports.clear()
    collection.queue = []
    collection.running = null
    collection.removals = []
    emit({ org: collection.org, collectionId: collection.id, type: 'deleted' })
  }

  function answer(request: AnswerRequest): AnswerResult {
    if (answerMode === 'fail') throw new StubError(503, 'model_unavailable', 'The built-in model is not available right now.')
    if (!request || typeof request.question !== 'string' || !Array.isArray(request.passages) || request.passages.length === 0) {
      throw new StubError(400, 'bad_request', 'Send the question and the passages to answer from.')
    }
    const used = request.passages.slice(0, 2)
    const text = used.map((passage, index) => `${bestSentence(passage.text, request.question)} [${index + 1}]`).join(' ')
    if (answerMode === 'bad_citation') return { text: `${text} [${request.passages.length + 1}]`, citations: [...used.map((_, index) => index + 1), request.passages.length + 1], model: 'in-memory writer' }
    return { text, citations: used.map((_, index) => index + 1), model: 'in-memory writer' }
  }

  const control: StubControl = {
    setState(org, collectionId, state, seconds) {
      const collection = find(org, collectionId)
      collection.forced = state === null ? null : { state, until: seconds === undefined ? null : now() + seconds * 1000 }
      if (state === 'asleep') {
        collection.awakeUntil = null
        collection.awakeSince = null
        collection.wakingUntil = null
      }
    },
    failNextImport(failure = {}) {
      failures.push({ times: 1, ...failure })
    },
    addUsage(org, collectionId, kind, seconds) {
      emit({ org, collectionId, type: 'usage', kind, seconds })
    },
    hold(on) {
      held = on
      if (!on) pump()
    },
    advance(ms) {
      offset += ms
      pump()
    },
    setAnswerMode(mode) {
      answerMode = mode
    },
    setTiming(next) {
      timing = { ...timing, ...next }
    },
    damage(org, collectionId, version) {
      const snapshot = find(org, collectionId).snapshots.get(version)
      if (!snapshot) throw new StubError(404, 'not_found', 'There is no such restore point.')
      snapshot.restorable = false
      snapshot.reason = 'damaged'
    },
    runUntilIdle() {
      for (let rounds = 0; rounds < 100; rounds += 1) {
        const busy = [...collections.values()].some((collection) => collection.running || collection.queue.length || collection.removals.length)
        if (!busy) break
        for (const collection of collections.values()) {
          const current = running(collection)
          if (current) current.finishAt = now()
        }
        pump(true)
      }
    },
    reset() {
      collections = new Map()
      outbox = []
      failures = []
      held = false
      answerMode = 'ok'
      offset = 0
    },
    snapshot() {
      return {
        collections: [...collections.values()].map((collection) => ({ org: collection.org, collectionId: collection.id, state: stateOf(collection), version: collection.version, documents: collection.content.documents.size })),
        outbox: outbox.length,
      }
    },
  }

  return {
    control,
    async fetch(request: Request): Promise<Response> {
      try {
        return await handle(request)
      } catch (error) {
        if (error instanceof StubError) {
          return json({ error: error.code, message: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }, error.status)
        }
        return json({ error: 'internal', message: 'The in-memory engine failed.' }, 500)
      }
    },
  }
}
