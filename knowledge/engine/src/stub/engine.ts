// The in-memory engine: every route of contract.ts, answered from memory, for `npm run dev`, the local stack, the
// workerd smoke test and the app's tests. It keeps the real engine's rules where the app can see them (one import per
// collection at a time, 2 per organization and 20 in all with notes and corrections first; all or nothing; already
// here; three tries; questions wait while learning and while waking; restore points with go back, undo and remove for
// good, changes within 5 minutes sharing one restore point; organizations kept apart) and none of its machinery (no
// containers, models or storage). Unlike the real engine it goes back and undoes at once, rather than in an alarm. It also has a control
// interface that puts a collection asleep, waking or learning, fails the next import or records usage, for tests.
// Like the real engine it refuses settings out of range (and older revisions), and holds an organization at the
// app's awake-hours stop (POST /v1/orgs/:org/hold).
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
import { readEntry, writeZip, zipEntries } from './zip'

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
  /** A note's own id (the app's), for a note; null for a file. */
  noteId: string | null
}

/** An export's documents and outdated marks as they were exported, read and checked when the import is sent. */
interface ExportedContent {
  documents: { info: DocumentInfo; noteId: string | null; text: string; pages: StoredDocument['pages']; hidden: HiddenSpan[] }[]
  marks: { documentId: string; textHash: string; noteDocumentId: string; needsCheck: boolean }[]
}

interface Content {
  documents: Map<string, StoredDocument>
  /** Outdated passages, as `documentId:textHash`, each with the correction note that marked it. */
  outdated: Map<string, string>
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
  stagedAt: number
  /** Kept for an import waiting for the 1st (POST .../inbox/keep): not cleared before this time. */
  keepUntil: number | null
}

interface RunningImport {
  status: ImportStatus
  request: ImportRequest
  correction: boolean
  /** An empty collection started from an export (POST .../import-export): what it brings back, as exported. */
  restore?: ExportedContent
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
  exports: Map<string, ExportStatus & { body: Uint8Array }>
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
/** Outbox ids are zero-padded sequence numbers, ordered as strings and as numbers. */
const OUTBOX_ID_WIDTH = 12
const ID = /^[A-Za-z0-9_-]{1,64}$/
/** The engine buffers what it stages, up to 64 MB. */
const MAX_STAGED_BYTES = 64 * 1024 * 1024
/** Staged files no import names are cleared a day after they arrived, or after the time they are kept until. */
const STAGED_KEEP_MS = DAY_MS
/** The longest a staged file is kept for an import waiting for the 1st. */
const MAX_KEEP_STAGED_MS = 45 * DAY_MS
/** Changes within this long of the last one share its restore point. */
const SHARE_RESTORE_POINT_MS = 5 * 60 * 1000
const FOLDABLE = new Set<PointKind>(['import', 'change'])
const DEFAULT_SETTINGS: CollectionSettings = { hiding: DEFAULT_HIDING, keepReady: null, awakeMinutes: 10, backupDays: 30, revision: 0 }
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
  return { documents, outdated: new Map(content.outdated), corrections: content.corrections }
}

const refuse = (message: string): never => {
  throw new StubError(400, 'bad_request', message)
}

/** The settings a PUT sends, checked as the real engine checks them (collection.ts validateSettings); missing parts keep `base`. */
function validateSettings(value: unknown, base: CollectionSettings): CollectionSettings {
  if (!value || typeof value !== 'object') return refuse('settings must be an object.')
  const s = value as Partial<CollectionSettings>
  const hiding = s.hiding === undefined ? base.hiding : validateHiding(s.hiding)
  const keepReady = s.keepReady === undefined ? base.keepReady : validateKeepReady(s.keepReady)
  const awakeMinutes = s.awakeMinutes === undefined ? base.awakeMinutes : Number(s.awakeMinutes)
  if (!Number.isInteger(awakeMinutes) || awakeMinutes < 1 || awakeMinutes > 60) return refuse('awakeMinutes must be 1 to 60.')
  const backupDays = s.backupDays === undefined ? base.backupDays : Number(s.backupDays)
  if (!Number.isInteger(backupDays) || backupDays < 1 || backupDays > 3650) return refuse('backupDays must be 1 to 3650.')
  const revision = s.revision === undefined ? base.revision : Number(s.revision)
  if (!Number.isInteger(revision) || revision < 0) return refuse('revision must be a whole number, 0 or more.')
  return { hiding, keepReady, awakeMinutes, backupDays, revision }
}

function validateHiding(value: unknown): CollectionSettings['hiding'] {
  if (!value || typeof value !== 'object') return refuse('settings.hiding must be an object.')
  const h = value as Partial<CollectionSettings['hiding']>
  const flag = (v: unknown, name: string) => (typeof v === 'boolean' ? v : refuse(`settings.hiding.${name} must be true or false.`))
  const words = h.words ?? []
  if (!Array.isArray(words) || words.length > 200 || words.some((word) => typeof word !== 'string' || !word.trim() || word.length > 100)) {
    return refuse('settings.hiding.words must be at most 200 words or phrases of up to 100 characters.')
  }
  return {
    emails: flag(h.emails, 'emails'), phones: flag(h.phones, 'phones'), cards: flag(h.cards, 'cards'), apiKeys: flag(h.apiKeys, 'apiKeys'), secrets: flag(h.secrets, 'secrets'),
    words: [...new Set((words as string[]).map((word) => word.trim()))],
  }
}

function validateKeepReady(value: unknown): CollectionSettings['keepReady'] {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return refuse('keepReady must be an object or null.')
  const k = value as Partial<NonNullable<CollectionSettings['keepReady']>>
  let zone = false
  try {
    zone = typeof k.timeZone === 'string' && Boolean(new Intl.DateTimeFormat('en-US', { timeZone: k.timeZone }))
  } catch {
    zone = false
  }
  if (!zone) return refuse('keepReady.timeZone must be an IANA time zone, such as "Europe/Berlin".')
  if (!Array.isArray(k.days) || k.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return refuse('keepReady.days must list days from 0 (Sunday) to 6 (Saturday).')
  if (typeof k.start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(k.start)) return refuse('keepReady.start must be a time such as "09:00".')
  if (!Number.isInteger(k.hours) || (k.hours as number) < 1 || (k.hours as number) > 3) return refuse('keepReady.hours must be 1, 2 or 3.')
  return { timeZone: k.timeZone!, days: [...new Set(k.days)].sort(), start: k.start, hours: k.hours as number, paused: k.paused === true }
}

/** The real engine's document ids: d_ (files) or n_ (notes) and 24 hexadecimal digits. */
const DOCUMENT_ID = /^[dn]_[0-9a-f]{24}$/
const HIDDEN_KINDS = new Set(['email', 'phone', 'card', 'api_key', 'secret', 'word'])
/** The largest export a collection starts from (it is read whole), and what it may bring back in all. */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024
/**
 * The real engine's export format (exportfile.ts EXPORT_FORMAT) and its bounds (EXPORT_LIMITS), each for an entry the
 * import reads: collection.json, a document's .json and its .txt. Entries it doesn't read (notes.json and the other
 * lists for people) are of any size.
 */
const EXPORT_FORMAT = 2
const EXPORT_COLLECTION_BYTES = 64 * 1024
const EXPORT_DOCUMENT_BYTES = 4 * 1024 * 1024
const EXPORT_TEXT_BYTES = 3 * 1024 * 1024
const EXPORT_PAGES = 20_000

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
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
  /** Organizations on hold (the app's awake-hours stop), until when; and the newest version of the app's wish taken. */
  let holds = new Map<string, number>()
  let holdVersions = new Map<string, number>()
  let answerMode: 'ok' | 'bad_citation' | 'fail' = 'ok'
  let order = 0

  const key = (org: string, collectionId: string) => `${org}\u0000${collectionId}`

  function emit(event: Omit<OutboxEvent, 'id' | 'at'> & Record<string, unknown>): void {
    sequence += 1
    // As the real engine numbers them: the id is the cursor that continues after the event.
    outbox.push({ seq: sequence, event: { id: String(sequence).padStart(OUTBOX_ID_WIDTH, '0'), at: new Date(now()).toISOString(), ...event } as OutboxEvent })
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

  /** Whether the organization is on hold now; a hold past its time ends by itself. */
  function onHold(org: string): boolean {
    const until = holds.get(org)
    if (until === undefined) return false
    if (until <= now()) {
      holds.delete(org)
      return false
    }
    return true
  }

  function stateOf(collection: StubCollection): CollectionState {
    if (collection.deleted) return 'deleted'
    if (onHold(collection.org) && !collection.removals.length) return 'held'
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

  /**
   * An organization on hold runs nothing: the import running stops (it keeps nothing and waits in the queue), and its
   * collections stop being awake, the time they were awake written to the ledger.
   */
  function stopForHold(collection: StubCollection): void {
    const current = running(collection)
    if (current) {
      emit({ org: collection.org, collectionId: collection.id, type: 'import', import: { ...current.status, state: 'interrupted', files: current.status.files.map((file) => ({ ...file })) } })
      current.status.state = 'queued'
      current.status.files = current.status.files.map((file) => ({ ...file, state: 'waiting' }))
      current.startedAt = null
      current.finishAt = null
      collection.running = null
      collection.queue.unshift(current.status.importId)
    }
    if (collection.awakeSince !== null) {
      const seconds = Math.round((now() - collection.awakeSince) / 1000)
      if (seconds > 0) emit({ org: collection.org, collectionId: collection.id, type: 'usage', kind: 'awake', seconds })
      collection.awakeSince = null
    }
    collection.awakeUntil = null
    collection.wakingUntil = null
  }

  /** Work that needs the collection running, refused while its organization is on hold. */
  function refuseWhileHeld(collection: StubCollection): void {
    if (!onHold(collection.org)) return
    const seconds = Math.max(1, Math.ceil(((holds.get(collection.org) ?? now()) - now()) / 1000))
    throw new StubError(429, 'capacity', 'This organization has used its awake hours, so nothing runs until the hold ends.', seconds)
  }

  function pump(force = false): void {
    clearStaged()
    for (const collection of collections.values()) if (!collection.deleted && onHold(collection.org)) stopForHold(collection)
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
        // The running-time ledger: awake time is written every minute while awake, and the rest when it sleeps.
        if (collection.awakeSince !== null) {
          const asleep = collection.awakeUntil !== null && collection.awakeUntil <= now() && !running(collection)
          const until = asleep ? collection.awakeUntil! : now()
          if (asleep || until - collection.awakeSince >= 60_000) {
            const seconds = Math.round((until - collection.awakeSince) / 1000)
            collection.awakeSince = asleep ? null : until
            if (asleep) collection.awakeUntil = null
            if (seconds > 0) emit({ org: collection.org, collectionId: collection.id, type: 'usage', kind: 'awake', seconds })
          }
        } else if (collection.awakeUntil !== null && collection.awakeUntil <= now()) {
          collection.awakeUntil = null
        }
      }
      // Start what may start: one per collection, small ones first, within the organization's and the service's capacity.
      const waiting = [...collections.values()]
        .filter((collection) => !collection.deleted && !collection.running && collection.queue.length > 0 && !onHold(collection.org))
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

  /** The day's cleanup of the inbox: staged files no queued or running import names, past the time they are kept. */
  function clearStaged(): void {
    for (const collection of collections.values()) {
      if (!collection.inbox.size) continue
      const named = new Set(collection.queue.concat(collection.running ?? []).flatMap((id) => collection.imports.get(id)?.request.files.map((file) => file.fileId) ?? []))
      for (const [fileId, staged] of collection.inbox) {
        if (!named.has(fileId) && now() >= Math.max(staged.stagedAt + STAGED_KEEP_MS, staged.keepUntil ?? 0)) collection.inbox.delete(fileId)
      }
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
    if (item.restore) {
      restoreFrom(collection, item, item.restore)
      return
    }
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
    // The newest correction of a passage wins ("Write it again"), as in the real engine: it takes the passage over, and
    // an earlier correction left correcting nothing is kept but no longer used, so it can't answer instead.
    const superseded = new Set<string>()
    for (const note of item.request.notes) {
      for (const ref of note.outdated) {
        const key = `${ref.documentId}:${ref.textHash}`
        const earlier = content.outdated.get(key)
        if (earlier && earlier !== note.noteId) superseded.add(earlier)
        content.outdated.set(key, note.noteId)
      }
    }
    const stillCorrecting = new Set(content.outdated.values())
    for (const document of content.documents.values()) {
      if (document.noteId && superseded.has(document.noteId) && !stillCorrecting.has(document.noteId)) document.info = { ...document.info, active: false }
    }
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

  /** An export's content committed as the collection's first restore point. */
  /**
   * An export learned as the collection's first restore point, when it learns (not when it was sent): its texts hidden
   * again with the rules in force now. A passage a correction marked outdated keeps its mark under the hash its text
   * has now; one that no longer reads the same asks for the correction to be checked. Its status lists each document
   * it restored, files in `files` and notes counted in `notes`, as the real engine reports them.
   */
  function restoreFrom(collection: StubCollection, item: RunningImport, exported: ExportedContent): void {
    for (const file of item.request.files) collection.inbox.delete(file.fileId)
    const rules = collection.settings.hiding
    const content: Content = { documents: new Map(), outdated: new Map(), corrections: 0 }
    const moved = new Map<string, string | null>()
    for (const doc of exported.documents) {
      const documentId = doc.info.documentId
      const again = hiddenAgain(doc.text, doc.pages, doc.hidden, rules)
      const passages = passagesFor(documentId, doc.info.name, doc.info.kind, again.text, again.pages)
      if (again.text !== doc.text) movePassages(documentId, doc, again.shift, passages, moved)
      content.documents.set(documentId, {
        info: { ...doc.info, textBytes: new TextEncoder().encode(again.text).byteLength, hiddenValues: again.hidden.length, version: collection.version + 1, addedAt: new Date(now()).toISOString() },
        text: again.text, pages: again.pages, hidden: again.hidden, passages, words: passages.map((passage) => keywords(passage.text)), setAside: false, noteId: doc.noteId,
      })
    }
    const marks = exported.marks.map((mark) => ({ documentId: mark.documentId, textHash: mark.textHash, noteId: exported.documents.find((doc) => doc.info.documentId === mark.noteDocumentId)?.noteId ?? '' }))
    const checks = followMarks(content, marks, moved)
    content.corrections = new Set(exported.marks.map((mark) => mark.noteDocumentId)).size
    const documents = [...content.documents.values()]
    const files = documents.filter((document) => document.info.kind === 'file')
    commit(collection, content, 'import', { ...NO_CHANGES, files: files.length, notes: documents.length - files.length }, { importId: item.status.importId })
    item.status.files = files.map((document) => ({ fileId: document.info.documentId, name: document.info.name, state: 'learned', documentId: document.info.documentId }))
    item.status.notes = documents.length - files.length
    item.status.state = 'committed'
    item.status.version = collection.version
    item.status.newFacts = documents.reduce((sum, document) => sum + document.passages.length, 0)
    finished(collection, item)
    for (const check of checks) emit({ org: collection.org, collectionId: collection.id, type: 'needs_check', ...check })
    keepAwake(collection)
  }

  function passagesFor(documentId: string, name: string, kind: 'file' | 'note', text: string, pages: StoredDocument['pages']): Passage[] {
    return passagesOf(text, pages).map((span, index) => ({
      passageId: `${documentId}:${index + 1}`, documentId, documentName: name, kind, page: span.page, start: span.start, end: span.end,
      text: span.text, textHash: sha256Hex(span.text), score: 0, outdated: false,
    }))
  }

  /**
   * What an export brings back, read and checked as the real engine reads it (exportfile.ts): collection.json (beside
   * a README.txt) and each document's .json and .txt (ids shaped as the real engine's, a file's SHA-256, page maps and
   * hidden values within the text, a note's id, and its marks on documents of the export). The lists for people
   * (notes.json and the others) aren't read. Its texts are hidden again when it learns (restoreFrom). Null when the
   * zip isn't a Knowledge export.
   */
  async function contentOfExport(bytes: Uint8Array): Promise<ExportedContent | null> {
    const files = zipEntries(bytes)
    if (!files || !files.has('README.txt') || !files.has('collection.json')) return null
    // Every name is checked before anything is inflated, and only what an export brings back is read (collection.json
    // and its documents), each within its own bound and all of it within one budget: anything else stays packed,
    // whatever its size.
    const needed = [...files.values()].filter((entry) => entry.name === 'collection.json' || entry.name.startsWith('documents/'))
    const bound = (name: string) => (name === 'collection.json' ? EXPORT_COLLECTION_BYTES : name.endsWith('.txt') ? EXPORT_TEXT_BYTES : EXPORT_DOCUMENT_BYTES)
    for (const entry of needed) {
      const match = /^documents\/(.+)\.(json|txt)$/.exec(entry.name)
      if (entry.name.startsWith('documents/') && (!match || !DOCUMENT_ID.test(match[1]!))) return null
      if (entry.size > bound(entry.name)) return null
    }
    if (needed.reduce((sum, entry) => sum + entry.size, 0) > MAX_EXPORT_BYTES) return null
    const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
    const isSha256 = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    const text = async (name: string) => {
      const content = await readEntry(files.get(name)!, bound(name))
      if (!content) throw new Error(`${name} is damaged`)
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content)
    }
    const read = async (name: string) => JSON.parse(await text(name)) as any
    const exported: ExportedContent = { documents: [], marks: [] }
    try {
      const collection = await read('collection.json')
      if (collection?.format !== EXPORT_FORMAT || typeof collection.collectionId !== 'string' || !isInt(collection.version)) return null
      for (const name of files.keys()) {
        if (!name.startsWith('documents/')) continue
        const match = /^documents\/(.+)\.(json|txt)$/.exec(name)
        if (!match || !files.has(`documents/${match[1]}.json`) || !files.has(`documents/${match[1]}.txt`)) return null
        if (match[2] === 'txt') continue
        const documentId = match[1]!
        const meta = await read(name)
        const info = meta?.document
        if (info?.documentId !== documentId || (info.kind !== 'file' && info.kind !== 'note')) return null
        if (documentId[0] !== (info.kind === 'file' ? 'd' : 'n')) return null
        if (typeof info.name !== 'string' || typeof info.type !== 'string' || typeof info.active !== 'boolean') return null
        if (!isInt(info.bytes) || !(info.pages === null || isInt(info.pages))) return null
        if (info.kind === 'file' ? !isSha256(info.sha256) : !(info.sha256 === '' || isSha256(info.sha256))) return null
        // The page map as [page, start, end]; where each "[hidden]" starts, by kind; never overlapping.
        const pages = meta.pages
        if (!Array.isArray(pages) || pages.length > EXPORT_PAGES || !pages.every((page: unknown) => Array.isArray(page) && page.length === 3 && page.every(isInt) && (page as number[])[1]! <= (page as number[])[2]!)) return null
        const kinds = meta.hidden
        if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) return null
        const hidden: HiddenSpan[] = []
        for (const [kind, starts] of Object.entries(kinds)) {
          if (!HIDDEN_KINDS.has(kind) || !Array.isArray(starts) || !starts.every(isInt)) return null
          for (const start of starts as number[]) hidden.push({ start, end: start + 8, kind: kind as HiddenSpan['kind'] })
        }
        hidden.sort((a, b) => a.start - b.start)
        for (let index = 1; index < hidden.length; index += 1) if (hidden[index]!.start < hidden[index - 1]!.end) return null
        const noteId = info.kind === 'note' ? meta.noteId : null
        if (info.kind === 'note' && (typeof noteId !== 'string' || !noteId)) return null
        const outdated = meta.outdated ?? []
        if (!Array.isArray(outdated) || (outdated.length && info.kind !== 'note')) return null
        for (const mark of outdated) {
          if (typeof mark?.documentId !== 'string' || !isSha256(mark.textHash)) return null
          exported.marks.push({ documentId: mark.documentId, textHash: mark.textHash, noteDocumentId: documentId, needsCheck: mark.needsCheck === true })
        }
        const stored = await text(`documents/${documentId}.txt`)
        if (pages.some((page: number[]) => page[2]! > stored.length) || hidden.some((span) => stored.slice(span.start, span.end) !== '[hidden]')) return null
        exported.documents.push({
          info: {
            documentId, kind: info.kind, name: info.name, type: info.type, bytes: info.bytes, textBytes: new TextEncoder().encode(stored).byteLength, pages: info.pages,
            sha256: info.sha256, active: info.active, hiddenValues: hidden.length, addedAt: new Date(now()).toISOString(), version: 0,
          },
          noteId, text: stored, pages: pages.map(([page, start, end]: number[]) => ({ page: page!, start: start!, end: end! })), hidden,
        })
      }
      // A mark is on a passage of a document of the export; one passage has one correction.
      const here = new Set(exported.documents.map((doc) => doc.info.documentId))
      const seen = new Set<string>()
      for (const mark of exported.marks) {
        const key = `${mark.documentId}:${mark.textHash}`
        if (!here.has(mark.documentId) || seen.has(key)) return null
        seen.add(key)
      }
      exported.documents.sort((a, b) => (a.info.documentId < b.info.documentId ? -1 : 1))
    } catch {
      return null
    }
    return exported
  }

  /** A stored text hidden again with these rules: what it hid before stays hidden and moves with what is hidden now. */
  /**
   * Where each passage of a text is after more of it was hidden (`shift` takes an offset there to the new text): the
   * hash of the passage that holds most of it now, or null when none does, by the old passage's `documentId:textHash`.
   */
  function movePassages(documentId: string, before: { text: string; pages: StoredDocument['pages'] }, shift: (offset: number) => number, passages: Passage[], moved: Map<string, string | null>): void {
    for (const span of passagesOf(before.text, before.pages)) {
      const start = shift(span.start)
      const end = shift(span.end)
      let best: Passage | null = null
      let overlap = 0
      for (const passage of passages) {
        const shared = Math.min(end, passage.end) - Math.max(start, passage.start)
        if (shared > overlap) {
          overlap = shared
          best = passage
        }
      }
      moved.set(`${documentId}:${sha256Hex(span.text)}`, best?.textHash ?? null)
    }
  }

  /**
   * Corrections' outdated marks follow their passage to its new text (a re-read, or an export hidden again), as in the
   * real engine (imports.ts followMarks): one whose passage changed, or can't be found, asks for its correction to be
   * checked, under the hash its mark has now. Two marks that come to one passage keep the newer (`marks` are in the
   * order they were made), and a correction left correcting nothing is kept but no longer used. The checks to ask for.
   */
  function followMarks(content: Content, marks: { documentId: string; textHash: string; noteId: string }[], moved: Map<string, string | null>): { noteId: string; documentId: string; textHash: string }[] {
    const superseded = new Set<string>()
    const changed = new Set<string>()
    content.outdated = new Map()
    for (const mark of marks) {
      const key = `${mark.documentId}:${mark.textHash}`
      const hash = (moved.has(key) ? moved.get(key) : mark.textHash) ?? mark.textHash
      const at = `${mark.documentId}:${hash}`
      const earlier = content.outdated.get(at)
      if (earlier !== undefined && earlier !== mark.noteId) superseded.add(earlier)
      content.outdated.set(at, mark.noteId)
      if (moved.has(key) && moved.get(key) !== mark.textHash) changed.add(at)
    }
    const stillCorrecting = new Set(content.outdated.values())
    for (const document of content.documents.values()) {
      if (document.noteId && superseded.has(document.noteId) && !stillCorrecting.has(document.noteId)) document.info = { ...document.info, active: false }
    }
    return [...changed].map((at) => ({ noteId: content.outdated.get(at)!, documentId: at.slice(0, at.lastIndexOf(':')), textHash: at.slice(at.lastIndexOf(':') + 1) }))
  }

  function hiddenAgain(text: string, pages: StoredDocument['pages'], hidden: HiddenSpan[], rules: HidingRuleSet): { text: string; pages: StoredDocument['pages']; hidden: HiddenSpan[]; shift: (offset: number) => number } {
    const result = applyHiding(text, rules)
    if (!result.found.length) return { text, pages, hidden, shift: (offset) => offset }
    const shift = (offset: number) => {
      let delta = 0
      for (const range of result.found) if (range.end <= offset) delta += 8 - (range.end - range.start)
      return offset + delta
    }
    const carried = hidden.filter((mark) => !result.found.some((range) => range.start < mark.end && mark.start < range.end))
      .map((mark) => ({ ...mark, start: shift(mark.start), end: shift(mark.end) }))
    return {
      text: result.text,
      pages: pages.map((page) => ({ page: page.page, start: shift(page.start), end: shift(page.end) })),
      hidden: [...result.hidden, ...carried].sort((a, b) => a.start - b.start),
      shift,
    }
  }

  /** A collection's export as the real engine writes it: a zip of open formats, no originals, no hidden values. */
  async function exportZip(collection: StubCollection): Promise<Uint8Array> {
    const documents = [...collection.content.documents.values()]
    const noteDocument = new Map(documents.filter((document) => document.noteId).map((document) => [document.noteId!, document.info.documentId]))
    const { words, ...hiding } = collection.settings.hiding
    const entries: [string, string][] = [
      ['README.txt', 'This file is an export of an Insulin Knowledge collection (made by the in-memory engine).\n'],
      ['collection.json', JSON.stringify({ format: EXPORT_FORMAT, collectionId: collection.id, version: collection.version, exportedAt: new Date(now()).toISOString(), settings: { hiding: { ...hiding, words: words.length }, awakeMinutes: collection.settings.awakeMinutes }, counts: counts(collection.content) }, null, 2)],
    ]
    // A mark whose correction note or file is gone (removed for good) isn't exported: nothing could read it back.
    const marks = [...collection.content.outdated].map(([mark, noteId]) => ({ documentId: mark.slice(0, mark.lastIndexOf(':')), textHash: mark.slice(mark.lastIndexOf(':') + 1), noteDocumentId: noteDocument.get(noteId) ?? '', needsCheck: false }))
      .filter((mark) => mark.noteDocumentId && collection.content.documents.has(mark.documentId))
    for (const document of documents) {
      // The real engine's format 2: a compact page map, where each "[hidden]" starts by kind, and a correcting note's marks.
      const hidden: Partial<Record<HiddenSpan['kind'], number[]>> = {}
      for (const span of document.hidden) (hidden[span.kind] ??= []).push(span.start)
      const outdated = marks.filter((mark) => mark.noteDocumentId === document.info.documentId).map(({ documentId, textHash, needsCheck }) => ({ documentId, textHash, needsCheck }))
      entries.push([`documents/${document.info.documentId}.txt`, document.text])
      entries.push([`documents/${document.info.documentId}.json`, JSON.stringify({ document: document.info, noteId: document.noteId, truncated: false, pages: document.pages.map((page) => [page.page, page.start, page.end]), hidden, outdated })])
    }
    // For people; not read back.
    entries.push(['notes.json', JSON.stringify({ notes: documents.filter((document) => document.info.kind === 'note').map((document) => ({ documentId: document.info.documentId, noteId: document.noteId, title: document.info.name, text: document.text })) }, null, 2)])
    entries.push(['facts.json', JSON.stringify({ facts: facts(collection.content) }, null, 2)])
    entries.push(['corrections.json', JSON.stringify({ corrections: marks }, null, 2)])
    entries.push(['history.json', JSON.stringify({ restorePoints: restorePoints(collection) }, null, 2)])
    return writeZip(entries)
  }

  function buildDocument(kind: 'file' | 'note', name: string, type: string, bytes: number, sha256: string, raw: string, pages: { page: number; start: number; end: number }[], rules: HidingRuleSet, version: number, note?: ImportNote): StoredDocument {
    // Shaped as the real engine's ids, so an export from here reads there too: a note's comes from its own id.
    const documentId = note ? `n_${sha256Hex(note.noteId).slice(0, 24)}` : `d_${randomHex(12)}`
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
      info: { documentId, kind, name, type, bytes, textBytes: new TextEncoder().encode(hidden.text).byteLength, pages: mapped.length || null, sha256, active: true, addedAt: new Date(now()).toISOString(), version, hiddenValues: hidden.hidden.length },
      text: hidden.text,
      pages: mapped,
      hidden: hidden.hidden,
      passages,
      words: passages.map((passage) => keywords(passage.text)),
      setAside: false,
      noteId: note?.noteId ?? null,
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
        list.push({ factId: `f_${passage.passageId}`, sentence, documentId: document.info.documentId, passageId: passage.passageId, passageTextHash: passage.textHash, sourceSentence: sentence })
      }
    }
    return list
  }

  function search(collection: StubCollection, query: string, topK: number): SearchResult {
    const forced = forcedState(collection)
    const answer = (status: SearchResult['status'], retryAfterSeconds: number | null): SearchResult => ({ status, retryAfterSeconds, covered: false, passages: [], facts: [], version: collection.version })
    if (forced?.state === 'busy') return answer('busy', 30)
    const state = stateOf(collection)
    if (state === 'held') return answer('held', Math.max(1, Math.ceil(((holds.get(collection.org) ?? now()) - now()) / 1000)))
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
    // Only passages that pass the threshold are answered, as the real engine does: none means "I won't guess".
    const passages = found.filter((passage) => passage.score >= COVERED_THRESHOLD).slice(0, topK)
    const covered = passages.length > 0
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
      const raw = url.searchParams.get('since') ?? ''
      const since = /^\d{1,20}$/.test(raw) ? Number(raw) : 0
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
      const after = outbox.filter((entry) => entry.seq > since)
      const page = after.slice(0, limit)
      return json({ events: page.map((entry) => entry.event), cursor: page.at(-1)?.event.id ?? (raw && since ? String(since).padStart(OUTBOX_ID_WIDTH, '0') : ''), more: after.length > page.length })
    }
    if (path === '/v1/answer' && method === 'POST') return json(answer(await body<AnswerRequest>(request)))
    const hold = path.match(/^\/v1\/orgs\/([^/]+)\/hold$/)
    if (hold && method === 'POST') {
      const org = decodeURIComponent(hold[1]!)
      if (request.headers.get(ORG_HEADER)?.trim() !== org) throw new StubError(404, 'not_found', 'No such organization.')
      const { until, version } = await body<{ until?: unknown; version?: unknown }>(request)
      const at = typeof until === 'string' ? Date.parse(until) : NaN
      if (until !== null && !Number.isFinite(at)) throw new StubError(400, 'bad_request', 'until must be a date and time, such as 2026-12-01T00:00:00Z, or null.')
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new StubError(400, 'bad_request', "version must be the app's version of the hold, a whole number.")
      // As the real engine: the app's wishes are versioned, and one older than the newest taken (delayed, or sent
      // again after a lost answer), or that one again, changes nothing and is answered with the state the newest made.
      if (!holdVersions.has(org) || version > holdVersions.get(org)!) {
        holdVersions.set(org, version)
        if (until === null) holds.delete(org)
        else holds.set(org, at)
        pump()
      }
      const held = onHold(org)
      return json({ held, until: held ? new Date(holds.get(org)!).toISOString() : null })
    }
    const purge = path.match(/^\/v1\/orgs\/([^/]+)\/purge$/)
    if (purge && method === 'POST') {
      const org = decodeURIComponent(purge[1]!)
      if (request.headers.get(ORG_HEADER)?.trim() !== org) throw new StubError(404, 'not_found', 'No such organization.')
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
      const next = validateSettings(settings, collection?.settings ?? DEFAULT_SETTINGS)
      // Settings carry the app's revision: an older one arriving late never undoes a newer one, and the same one again
      // changes nothing.
      const sent = (settings as { revision?: unknown }).revision
      if (collection && sent !== undefined && next.revision < collection.settings.revision) throw new StubError(409, 'stale_settings', 'These settings are older than the ones the engine has.')
      if (collection && sent !== undefined && next.revision === collection.settings.revision && next.revision > 0) return json(statusOf(collection))
      if (!collection) {
        collection = {
          org, id: collectionId, settings: next, deleted: false, content: { documents: new Map(), outdated: new Map(), corrections: 0 },
          version: 0, snapshots: new Map(), imports: new Map(), queue: [], running: null, exports: new Map(), inbox: new Map(),
          awakeSince: null, awakeUntil: null, wakingUntil: null, lastQuestionAt: null, lastBackupAt: null, forced: null, removals: [],
        }
        collections.set(key(org, collectionId), collection)
      } else {
        rehide(collection, next)
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
    if (rest === '/inbox/keep' && method === 'POST') {
      const keep = await body<{ fileIds?: unknown; until?: unknown }>(request)
      const fileIds = keep?.fileIds
      if (!Array.isArray(fileIds) || fileIds.length > 1000 || !fileIds.every((id) => typeof id === 'string' && ID.test(id))) throw new StubError(400, 'bad_request', 'fileIds must be a list of at most 1000 file ids.')
      const until = typeof keep.until === 'string' ? Date.parse(keep.until) : NaN
      if (!Number.isFinite(until)) throw new StubError(400, 'bad_request', 'until must be a date and time, such as 2026-12-01T00:00:00Z.')
      if (until > now() + MAX_KEEP_STAGED_MS) throw new StubError(400, 'bad_request', 'Staged files can be kept at most 45 days.')
      const kept: string[] = []
      for (const fileId of fileIds as string[]) {
        const staged = collection.inbox.get(fileId)
        if (!staged) continue
        staged.keepUntil = Math.max(staged.keepUntil ?? 0, until)
        kept.push(fileId)
      }
      return json({ kept })
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
      collection.inbox.set(fileId, { bytes, name, type: request.headers.get('content-type') ?? 'application/octet-stream', sha256, stagedAt: now(), keepUntil: null })
      return json({ fileId, bytes: bytes.byteLength, sha256 })
    }
    if (rest === '/import-export' && method === 'POST') {
      const raw = await body<{ importId?: unknown; fileId?: unknown; sha256?: unknown }>(request)
      if (typeof raw?.importId !== 'string' || !ID.test(raw.importId) || typeof raw.fileId !== 'string' || !ID.test(raw.fileId)) throw new StubError(400, 'bad_request', 'Send an import id and the staged export\'s file id.')
      if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) throw new StubError(400, 'bad_request', 'Send the SHA-256 of the export that was read.')
      const existing = collection.imports.get(raw.importId)
      if (existing) return json(existing.status, 200)
      if (collection.version > 0 || collection.content.documents.size || collection.queue.length || collection.running || collection.removals.length) {
        throw new StubError(409, 'bad_request', 'An export starts an empty collection only: this one already has something in it.')
      }
      const staged = collection.inbox.get(raw.fileId)
      if (!staged) throw new StubError(400, 'bad_request', 'The export wasn\'t received. Add it again.')
      if (staged.bytes.byteLength > MAX_EXPORT_BYTES) throw new StubError(413, 'too_large', 'That export is too large to start a collection from.')
      // Only the file the app read and reserved for: one staged again under the same id since then is refused.
      if (staged.sha256 !== raw.sha256) throw new StubError(409, 'bad_request', 'The staged export isn\'t the one that was checked. Upload it again.')
      const restored = await contentOfExport(staged.bytes)
      if (!restored) throw new StubError(409, 'bad_request', 'That file isn\'t a Knowledge export.')
      const request_: ImportRequest = { importId: raw.importId, files: [{ fileId: raw.fileId, name: staged.name, type: staged.type, bytes: staged.bytes.byteLength, sha256: staged.sha256 }], notes: [], small: false }
      const { status } = enqueue(collection, request_, false)
      collection.imports.get(status.importId)!.restore = restored
      pump()
      return json(currentStatus(collection, status.importId), 202)
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
        // Stop using needs no container: it commits at once, held or not.
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
      if (point[2] === 'go-back' && method === 'POST') {
        refuseWhileHeld(collection)
        return json(goBack(collection, version, false))
      }
    }
    if (rest === '/undo' && method === 'POST') {
      refuseWhileHeld(collection)
      const previous = collection.snapshots.get(collection.version)?.previous ?? null
      if (!previous) throw new StubError(409, 'not_restorable', 'There is nothing to undo.')
      return json(goBack(collection, previous, true))
    }
    if (rest === '/exports' && method === 'POST') {
      const { exportId } = await body<{ exportId: string }>(request)
      if (typeof exportId !== 'string' || !ID.test(exportId)) throw new StubError(400, 'bad_request', 'Send an export id.')
      const existing = collection.exports.get(exportId)
      if (existing) return json(exportStatus(existing))
      refuseWhileHeld(collection)
      const content = await exportZip(collection)
      const status = { exportId, state: 'ready' as const, bytes: content.byteLength, readyAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 7 * DAY_MS).toISOString(), body: content }
      collection.exports.set(exportId, status)
      return json(exportStatus(status))
    }
    const oneExport = rest.match(/^\/exports\/([^/]+)$/)
    if (oneExport && method === 'GET') {
      const status = collection.exports.get(decodeURIComponent(oneExport[1]!))
      if (!status) throw new StubError(404, 'not_found', 'There is no such export.')
      if (url.searchParams.get('download') === '1' && status.state === 'ready') {
        return new Response(status.body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${collection.id}-${status.exportId}.zip"` } })
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
    const moved = new Map<string, string | null>()
    for (const [id, document] of content.documents) {
      const again = hiddenAgain(document.text, document.pages, document.hidden, after)
      if (again.text === document.text) continue
      const passages = passagesFor(id, document.info.name, document.info.kind, again.text, again.pages)
      movePassages(id, document, again.shift, passages, moved)
      content.documents.set(id, {
        ...document, info: { ...document.info, textBytes: new TextEncoder().encode(again.text).byteLength, hiddenValues: again.hidden.length },
        text: again.text, pages: again.pages, hidden: again.hidden, passages, words: passages.map((passage) => keywords(passage.text)),
      })
      changed.add(id)
    }
    if (changed.size === 0) return
    // A passage a correction marked outdated that now reads differently: its mark follows it, and the correction asks
    // to be checked.
    const marks = [...content.outdated].map(([mark, noteId]) => ({ documentId: mark.slice(0, mark.lastIndexOf(':')), textHash: mark.slice(mark.lastIndexOf(':') + 1), noteId }))
    const checks = followMarks(content, marks, moved)
    for (const snapshot of collection.snapshots.values()) {
      if ([...changed].some((id) => snapshot.content.documents.has(id))) {
        snapshot.restorable = false
        snapshot.reason = 'newly_hidden'
      }
    }
    commit(collection, content, 'reread', NO_CHANGES, { summary: 'Hid information under the new rules' })
    for (const check of checks) emit({ org: collection.org, collectionId: collection.id, type: 'needs_check', ...check })
  }

  function remove(collection: StubCollection): void {
    collection.deleted = true
    collection.content = { documents: new Map(), outdated: new Map(), corrections: 0 }
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
    // A citation outside the passages given is taken out of the text and counted, as the real engine does.
    return { text, citations: used.map((_, index) => index + 1), model: 'in-memory writer', dropped: answerMode === 'bad_citation' ? 1 : 0 }
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
      holds = new Map()
      holdVersions = new Map()
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
