// The engine's API, which the Knowledge app calls over the SUGER_ENGINE service binding.
//
// The engine has no public address and trusts only that binding. Every request carries
// `x-knowledge-org: <organization id>`; the engine refuses a request without it (400) and answers
// 404 not_found for a collection that belongs to another organization. The app checks the caller's
// permissions, collection role and limits before it calls. Bodies are JSON unless a route says
// otherwise; errors are `EngineError` with a 4xx or 5xx status.
//
// Two service-wide routes, `GET /v1/outbox` and `GET /v1/health`, belong to no organization: the header is optional
// there and ignored. `POST /v1/answer` is service-wide too but still names the organization it answers for.
//
// Both the real engine (src/index.ts) and the in-memory one (src/stub/) implement exactly this.
// Change a shape only together with both, and with the app's engine client.

export const ENGINE_API_VERSION = 1
export const ORG_HEADER = 'x-knowledge-org'

export type EngineErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'deleting'
  | 'not_restorable'
  | 'busy_learning'
  | 'capacity'
  | 'too_large'
  | 'unsupported_type'
  | 'model_unavailable'
  | 'stale_settings'
  | 'internal'

export interface EngineError {
  error: EngineErrorCode
  message: string
  retryAfterSeconds?: number
}

// ---------------------------------------------------------------- collections

export type CollectionState =
  | 'empty' // created, nothing learned yet
  | 'asleep'
  | 'waking'
  | 'waking_from_backup'
  | 'ready'
  | 'learning'
  | 'saving'
  | 'going_back'
  | 'repairing'
  | 'deleting'
  | 'deleted'
  | 'held' // the organization is on hold (POST /v1/orgs/:org/hold): no container starts but to remove or delete

export interface HidingRules {
  emails: boolean
  phones: boolean
  cards: boolean
  apiKeys: boolean
  secrets: boolean // values labelled as passwords or secrets
  words: string[] // the organization's own words (NEXT in the UI; the engine supports it)
}

export interface KeepReady {
  timeZone: string // IANA, e.g. "Europe/Berlin"
  days: number[] // 0 = Sunday … 6 = Saturday
  start: string // "HH:MM" in timeZone
  hours: number // 1 to 3
  paused: boolean // paused by the app at 90% of awake hours
}

export interface CollectionSettings {
  hiding: HidingRules
  keepReady: KeepReady | null
  awakeMinutes: number // stays awake this long after the last question (default 10)
  backupDays: number // daily backups kept this many days (the organization's backup_days limit); the latest is kept for the collection's life
  revision: number // grows with every change the app makes; a PUT with a lower revision than the engine has answers 409 stale_settings and changes nothing
}

// POST /v1/orgs/:org/hold: the app's hard stop on awake hours, enforced in the engine. While held (until `until`, or
// until a call with `until: null`), the engine starts no container for the organization's collections except to remove
// a file for good or delete a collection; running ones stop, and an interrupted import keeps nothing and waits. Answers
// `{ held: boolean, until: string | null }`.
export interface OrgHoldRequest {
  until: string | null // ISO time
}

export interface CollectionCounts {
  documents: number // every stored document, including ones not used
  activeDocuments: number
  passages: number
  facts: number
  textBytes: number // redacted text kept, with page maps
}

export interface WakeProgress {
  step: 1 | 2 | 3 // 1 start, 2 check (load models meanwhile), 3 open
  fromBackup: boolean
  etaSeconds: number
}

export interface CollectionStatus {
  collectionId: string
  state: CollectionState
  version: number // the committed restore point (0: nothing learned)
  counts: CollectionCounts
  currentImport: ImportStatus | null
  queuedImports: number
  wake: WakeProgress | null
  lastRestorePointAt: string | null // ISO times
  lastBackupAt: string | null
  lastQuestionAt: string | null
  settings: CollectionSettings
}

// ---------------------------------------------------------------- imports

export interface ImportFile {
  fileId: string // staged with PUT /v1/collections/:cid/inbox/:fileId
  name: string
  type: string // media type
  bytes: number
  sha256: string // hex, of the original bytes
}

export interface PassageRef {
  documentId: string
  textHash: string // sha256 hex of the passage's text
}

export interface ImportNote {
  noteId: string
  title: string
  text: string
  outdated: PassageRef[] // passages this note corrects; they are marked outdated
}

// POST /v1/collections/:cid/inbox/keep: keep staged files that an import waiting for the next month will name, instead
// of clearing them after a day. `until` is at most 45 days ahead; answers `{ kept: string[] }` (the ids still staged).
export interface KeepStagedRequest {
  fileIds: string[]
  until: string // ISO time
}

export interface ImportRequest {
  importId: string // idempotent: the same id answers the existing import
  files: ImportFile[]
  notes: ImportNote[]
  small: boolean // notes and corrections: goes ahead of normal imports in the queue
}

// POST /v1/collections/:cid/corrections: a small import of one note that marks the passages it corrects as
// outdated. `notes` (one note) is accepted in place of `note`; files are not.
export interface CorrectionRequest {
  importId: string
  note: ImportNote
}

export type ImportState =
  | 'queued'
  | 'reading' // extraction and hiding
  | 'learning'
  | 'saving'
  | 'committed'
  | 'duplicate' // everything was already here; nothing changed
  | 'interrupted' // will be retried; nothing was kept
  | 'failed' // gave up after 3 tries, or a file failed closed
  | 'cancelled'

export type ImportFileState =
  | 'waiting'
  | 'reading'
  | 'understanding'
  | 'learned'
  | 'already_here'
  | 'failed'

export interface ImportFileStatus {
  fileId: string
  name: string
  state: ImportFileState
  reason?: string // plain words, for a person
  documentId?: string
}

export interface ImportStatus {
  importId: string
  state: ImportState
  attempt: number // 1 to 3
  queuePosition: number | null
  waitingFor: 'organization' | 'service' | null // why it is queued
  files: ImportFileStatus[]
  notes: number
  version: number | null // set when committed
  newFacts: number | null
  failedFileId: string | null
  error: EngineError | null
  etaSeconds: number | null
  createdAt: string
  finishedAt: string | null
}

// ---------------------------------------------------------------- questions

export interface Passage {
  passageId: string
  documentId: string
  documentName: string
  kind: 'file' | 'note'
  page: number | null
  start: number // character offsets in the document's redacted text
  end: number
  text: string
  textHash: string
  score: number // 0 to 1
  outdated: boolean
}

export interface Fact {
  factId: string
  sentence: string
  documentId: string
  passageId: string
  passageTextHash: string // the source passage's textHash, so a fix can mark it outdated without searching
  sourceSentence: string
}

export interface SearchRequest {
  query: string
  topK?: number // default 8, at most 20
}

export interface SearchResult {
  status: 'ok' | 'waking' | 'learning' | 'busy' | 'held'
  retryAfterSeconds: number | null
  covered: boolean // false: nothing passes the calibrated threshold ("I won't guess")
  passages: Passage[] // outdated passages left out; notes ranked above the passages they correct
  facts: Fact[]
  version: number
}

export interface AnswerRequest {
  question: string
  passages: Pick<Passage, 'passageId' | 'documentName' | 'page' | 'text'>[]
}

export interface AnswerResult {
  text: string // cites passages as [1], [2], … in the order given
  citations: number[] // 1-based passage numbers the text cites, all within the passages given
  dropped: number // citations the model wrote outside the passages given; the app then shows sources without the text
  model: string
}

// ---------------------------------------------------------------- documents

export interface DocumentInfo {
  documentId: string
  kind: 'file' | 'note'
  name: string
  type: string
  bytes: number // original size
  textBytes: number
  pages: number | null
  sha256: string
  active: boolean // false: "stop using" (kept, not used for answers)
  hiddenValues: number // values hidden before learning
  addedAt: string
  version: number // the restore point that added it
}

export interface HiddenSpan {
  start: number
  end: number
  kind: 'email' | 'phone' | 'card' | 'api_key' | 'secret' | 'word'
}

export interface DocumentText {
  document: DocumentInfo
  text: string // redacted: hidden values are replaced by "[hidden]"
  pages: { page: number; start: number; end: number }[]
  hidden: HiddenSpan[] // positions of "[hidden]" in text
}

export interface RemoveResult {
  version: number
  blockedRestorePoints: number[] // versions that held the file and can no longer be restored
}

// ---------------------------------------------------------------- history

export type NotRestorableReason = 'removed_for_good' | 'expired' | 'engine_changed' | 'newly_hidden' | 'damaged' // failed its integrity check twice

export interface RestorePoint {
  version: number
  createdAt: string
  summary: string // plain words: "Added 5 files", "Correction", "Went back to version 3"
  documents: number
  restorable: boolean
  reason: NotRestorableReason | null
  current: boolean
}

export interface GoBackPreview {
  version: number
  documents: number
  setAside: Pick<DocumentInfo, 'documentId' | 'name'>[] // added later: set aside, not deleted
  correctionsUndone: number
  restorable: boolean
  reason: NotRestorableReason | null
}

// ---------------------------------------------------------------- exports

export interface ExportStatus {
  exportId: string
  state: 'queued' | 'running' | 'ready' | 'failed'
  bytes: number | null
  readyAt: string | null
  expiresAt: string | null
}

// ---------------------------------------------------------------- outbox

export type UsageKind = 'awake' | 'learning' | 'export' | 'ready'

export type OutboxEvent =
  | { id: string; at: string; org: string; collectionId: string; type: 'committed'; version: number; summary: string; counts: CollectionCounts; importId: string | null }
  | { id: string; at: string; org: string; collectionId: string; type: 'import'; import: ImportStatus }
  | { id: string; at: string; org: string; collectionId: string; type: 'usage'; kind: UsageKind; seconds: number }
  | { id: string; at: string; org: string; collectionId: string; type: 'state'; state: CollectionState; version: number }
  | { id: string; at: string; org: string; collectionId: string; type: 'backup'; version: number }
  | { id: string; at: string; org: string; collectionId: string; type: 'deleted' }
  // A file re-read changed a passage a correction marked outdated: the correction asks to be checked.
  | { id: string; at: string; org: string; collectionId: string; type: 'needs_check'; noteId: string; documentId: string; textHash: string }

export interface OutboxPage {
  events: OutboxEvent[]
  cursor: string // pass as `since` next time
  more: boolean
}

export interface EngineHealth {
  engine: string // a version label, never an account id or digest
  collections: number
}
