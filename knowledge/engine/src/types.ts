// The engine's own records, kept in each collection's Durable Object storage. The contract's types are what the
// app sees; these hold what the engine needs besides.

import type {
  CollectionCounts,
  CollectionSettings,
  DocumentInfo,
  ExportStatus,
  HidingRules,
  ImportFile,
  ImportNote,
  ImportStatus,
  NotRestorableReason,
  OutboxEvent,
  UsageKind,
} from './contract.ts'
import type { InstanceType } from './settings.ts'

/** A checksum list of everything under /data in the container, as ops.py `manifest` writes it. */
export interface ManifestSummary {
  digest: string
  files: number
  bytes: number
}
export interface Manifest extends ManifestSummary {
  entries: Record<string, { sha256: string; size: number }>
}

export interface SnapshotHandle {
  id: string
  size: number
  name?: string
}

/** One container snapshot. Several restore points may use it (state-only changes, go back, undo). */
export interface SnapshotRecord {
  handle: SnapshotHandle
  image: string // the engine image it was taken on
  dataFormat: string // the container's database format, from /health
  manifest: ManifestSummary // entries are stored in chunks beside it
  createdAt: string
  lastRestoredAt: string | null
  expired: boolean // set by the harness or when a start from it fails as gone
  damaged?: boolean // failed its integrity check twice: never opened again
}

export interface DocRecord extends Omit<DocumentInfo, 'hiddenValues'> {
  importId: string
  textKey: string // R2 FILES key of its redacted text (DocumentText)
  truncated: boolean
  noteId: string | null
  hiddenCount: number // shown as hiddenValues
}

/** A passage marked outdated by a correction. Tied to the document and its text's hash, not to a passage id. */
export interface OutdatedMark {
  documentId: string
  textHash: string
  noteDocumentId: string
  correctionImportId: string
  needsCheck: boolean // the passage changed when the file was re-read: the correction asks to be checked
  seq?: number // the correction's place in the order corrections were made: when two meet on a passage, the higher wins
}

/** Everything that changes answers, restored with each restore point. */
export interface AnswerState {
  documents: DocRecord[]
  marks: OutdatedMark[]
  factsKey: string | null // R2 FILES key of this version's facts
  facts: number
  passages: number
  textBytes: number
}

export interface ChangeCounts {
  files: number
  notes: number
  corrections: number
  stopped: number
  resumed: number
  removed: number
  reread: number
}

export type RestorePointKind = 'import' | 'change' | 'go_back' | 'undo' | 'remove' | 'reread' | 'from_backup' | 'repair'

export interface RestorePointRecord {
  version: number
  createdAt: string
  kind: RestorePointKind
  summary: string
  changes: ChangeCounts
  snapshotId: string | null // null only for version 0
  previous: number | null // the version that was current before this one: what undo goes back to
  importIds: string[]
  counts: CollectionCounts
  blocked: NotRestorableReason | null
  folded: boolean // merged into a later restore point made within 5 minutes; no longer listed
}

export type WakePhase = 'starting' | 'checking' | 'opening' | 'ready' | 'busy'

/** What the running container holds. `dirty`: an import has written to /data since it started from `origin`. */
export interface Runtime {
  origin: number // the version it started from (0: an empty image)
  snapshotId: string | null
  dirty: boolean
  instance: InstanceType
  image: string
  dataFormat: string
  phase: WakePhase
  phaseAt?: string // when this phase began: a wake step that takes too long is stopped
  startedAt: string
  checkJobId: string | null
  queryStarted: boolean
  verifyFailures: number
  fromBackup: boolean
}

export type ImportKind = 'import' | 'correction' | 'change' | 'remove' | 'reread' | 'relearn' | 'export' // export: started from an export
export type ImportPhase = 'queued' | 'staging' | 'running' | 'saving' | 'done'

export interface StagedFile {
  fileId: string
  name: string
  type: string
  bytes: number
  sha256: string
  stagedAt: string
  keepUntil?: string // an import waiting for the next month will name it: kept until then, not just a day
}

export interface ImportRecord {
  status: ImportStatus
  kind: ImportKind
  small: boolean
  phase: ImportPhase
  // textBytes: the text read from the file or note (redacted), once known; until then the plan estimates it.
  files: (ImportFile & { documentId: string; duplicateOf: string | null; textBytes?: number })[]
  notes: (ImportNote & { documentId: string; textBytes?: number })[]
  hiding: HidingRules
  jobId: string | null
  capacity: 'none' | 'waiting' | 'granted'
  reserveVersion: number | null // remove for good: the version promised in RemoveResult
  removeDocumentIds: string[]
  rereadDocumentIds: string[]
  storedTextBytes?: number // the saved texts it learns again (re-read, re-learning, an export's): its plan counts them
  snapshotTaken: boolean
  learningStartedAt: number | null // its first try's job start (the time left counts from this try's: jobStartedAt)
  retryAt: number | null
  containerReused?: boolean // this try learns in the container that was already running: its plan counts no start
  jobStartedAt: number | null // this try's job: the time left counts from it; a job far past its time is given up
  textsSaved: boolean // every file and note was read and hidden, and its redacted text saved: originals are gone
  rebuild: boolean // a removal whose restore point can't be started: the other documents are learned again
  restoreFrom: number | null // re-learning after a repair: also bring back that version's documents
  afterAnswering?: number // a repair answers from this earlier version: its re-learning waits while people ask
  rounds?: number // a removal for good that failed its three tries this many times: each wait is longer
  turns?: number // how many times the alarm started it (a removal or a hold can send it back to the queue): keys its events
  fromExport?: { collectionId: string; version: number } // an empty collection started from that collection's export
  expectedVersion?: number | null // API 2: the collection version the import was based on, checked when it applies (contract.ts, ExpectedVersion)
  result: Record<string, any> | null // the container job's result, kept until the commit
  test: { crashFileId?: string; detectorError?: boolean } | null
}

export interface ExportRecord {
  status: ExportStatus
  key: string
  documentIds: string[]
  startedAt: number | null
}

/** An outbox event before the outbox numbers it. */
export type OutboxEventDraft = OutboxEvent extends infer E ? (E extends OutboxEvent ? Omit<E, 'id'> : never) : never

export interface PendingEvent {
  key: string // for de-duplication in the outbox
  event: OutboxEventDraft
}

export interface Ledger {
  kind: UsageKind | null // what the running container's time counts as
  since: number | null
  totals: Partial<Record<UsageKind, number>> // milliseconds not yet written to the outbox
  lastFlushAt: number
}

export type Operation =
  | { kind: 'go_back'; target: number; undo: boolean; startedAt: string }
  | { kind: 'from_backup'; reason: 'expired' | 'engine_changed' | 'repair'; startedAt: string; restartedAfterFailure: boolean }
  | { kind: 'repair'; failedVersion: number; startedAt: string; tried: number[] }

export interface Meta {
  org: string
  collectionId: string
  createdAt: string
  settings: CollectionSettings
  version: number // the current restore point
  nextVersion: number
  deleting: boolean
  deleteStartedAt: string | null
  lastQuestionAt: string | null
  lastActivityAt: string | null // a question, a wake or a commit: the container sleeps awakeMinutes after it
  lastRestorePointAt: string | null
  lastBackupAt: string | null
  lastBackupVersion: number | null
  backupDue: boolean
  wakeRequested: boolean
  op: Operation | null
  queue: string[] // import ids waiting, in order (removals, then small, then the rest)
  active: string | null // the import being worked on
  removals: { documentId: string; importId: string; version: number }[] // remove for good, pending in the container
  hidingAppliedAt: string | null
  repairNote: string | null // "answering from version n", while repairing
  heldUntil?: string | null // the organization's hold: no container starts until then, but to remove or delete
  holdSeq?: number // which of the registry's hold changes heldUntil comes from: an older delivery is refused
  holdVersion?: number // the app's version of that hold wish: a delivery of an older one is refused too
}

export type { CollectionSettings }
