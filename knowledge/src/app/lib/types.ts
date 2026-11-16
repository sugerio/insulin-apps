import type { CollectionStatus, DocumentInfo, DocumentText, ExportStatus, Fact, GoBackPreview, ImportStatus as EngineImportStatus, Passage, RestorePoint } from '../../../engine/src/contract.ts'

// The shapes the screens read from Knowledge's API (src/app/server/routes/), as the server sends them.

export type { CollectionStatus, DocumentInfo, DocumentText, ExportStatus, Fact, GoBackPreview, Passage, RestorePoint }

/**
 * An import as the app answers it: the engine's, or one waiting for next month's documents learned (`waiting`,
 * learned on the 1st by itself).
 */
export type ImportStatus = Omit<EngineImportStatus, 'state' | 'waitingFor'> & {
  state: EngineImportStatus['state'] | 'waiting'
  waitingFor: EngineImportStatus['waitingFor'] | 'month'
}

export type AppRole = 'ADMIN' | 'EDITOR' | 'VIEWER'
export type CollectionRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER'
export type Action = 'read' | 'report' | 'change' | 'remove' | 'share' | 'settings' | 'export' | 'transfer' | 'delete'

export interface Me {
  organizationId: string
  user: { id: string; email: string | null; name: string | null; kind: 'person' | 'client' }
  role: AppRole
  organizationRole: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER' | 'APPS' | null
  isOrganizationOwner: boolean
  permissions: string[]
  accessVia: 'browser' | 'mcp' | 'api'
  preview: boolean
  engine: boolean
  supportConfigured: boolean
}

export interface KeepReadyWindow {
  days: number[]
  start: string
  hours: number
  paused?: boolean
}

export interface CollectionSummary {
  id: string
  name: string
  purpose: string
  role: CollectionRole | null
  grantedRole: CollectionRole | null
  owner: { id: string; name: string | null }
  createdAt: string | null
  lastUsedAt: string | null
  documents: number
  bytes: number
  facts: number
  version: number
  state: string
  assistants: boolean
  keepReady: KeepReadyWindow | null
  sharing: { general: 'VIEWER' | 'EDITOR' | null; people: number; clients: number }
}

export interface OtherCollection {
  id: string
  name: string
  owner: { id: string; name: string | null }
  createdAt: string | null
  lastUsedAt: string | null
  documents: number
  bytes: number
  keepReady: boolean
  sharing: { general: 'VIEWER' | 'EDITOR' | null; people: number; clients: number }
}

export interface CollectionDetail {
  collection: CollectionSummary
  role: CollectionRole
  can: Record<Action, boolean>
  engine: CollectionStatus | null
  awakeHoursThisMonth: number
  questions: { browser: number; mcp: number; api: number }
  /** Answers on the site, and how many whoever asked marked right. */
  answers?: { total: number; markedRight: number }
  /** Daily backups are kept this many days (the organization's backup_days). */
  backupDays?: number
}

export interface AskSource extends Passage {
  n: number
  collectionId: string
}

export interface AskCitation {
  n: number
  passageId: string
  documentId: string
  documentName: string
  collectionId: string
  page: number | null
  start: number
  end: number
}

export interface CollectionAskStatus {
  id: string
  name: string
  status: 'ok' | 'waking' | 'learning' | 'busy' | 'held'
  retryAfterSeconds: number | null
  covered: boolean
}

export interface AskAnswer {
  answerId: string | null
  outcome: 'answered' | 'sources_only' | 'wont_guess' | 'waiting'
  status?: 'learning' | 'waking' | 'busy' | 'held'
  text: string | null
  model?: string | null
  writer?: 'builtin' | 'own' | null
  message: string | null
  retryAfterSeconds?: number
  citations: AskCitation[]
  sources: AskSource[]
  collections: CollectionAskStatus[]
  skipped: { collectionId: string; reason: string; message: string }[]
}

export interface SourceDetail {
  source: DocumentText
  owner: { id: string; name: string | null }
  lastEdit: string
  collection: { id: string; name: string }
}

export interface FactWithCheck extends Fact {
  checked?: { by: string | null; at: string } | null
}

export interface Report {
  id: string
  answerId: string | null
  question: string
  answer: string
  note: string
  status: 'open' | 'fixed' | 'dismissed'
  reportedBy: { id: string; name: string | null }
  createdAt: string
  resolvedAt: string | null
  correctionId: string | null
}

export interface Share {
  type: 'person' | 'client'
  id: string
  name: string | null
  email: string | null
  role: 'VIEWER' | 'EDITOR' | 'ADMIN'
  status: 'active' | 'on_hold' | 'checking'
  actsAsViewer: boolean
}

export interface Sharing {
  owner: { id: string; name: string | null; email: string | null; actsAsViewer: boolean }
  general: 'VIEWER' | 'EDITOR' | null
  assistants: boolean
  shares: Share[]
}

export interface Member {
  type: 'person' | 'client'
  id: string
  name: string
  email: string | null
  appRole: string | null
}

export interface LimitUsage {
  key: string
  label: string
  unit: 'count' | 'bytes' | 'hours' | 'days'
  limit: number | null
  used: number | null
  reserved: number | null
  percent: number | null
  resetsAt: string | null
}

export interface Usage {
  period: string
  limits: LimitUsage[]
  collections: { id: string; name: string; awakeHours: number; keepReady: boolean; keepReadyPaused: boolean }[]
}

export interface HidingRules {
  emails: boolean
  phones: boolean
  cards: boolean
  apiKeys: boolean
  secrets: boolean
  words: string[]
}

export interface Rules {
  timeZone: string
  answerWriter: { kind: 'builtin' } | { kind: 'own'; integrationKey: string; url: string; model: string }
  hiding: HidingRules
  supportConfigured?: boolean
}

export interface Health {
  engine: { reachable: boolean; label: string | null }
  organization: { collections: number; documents: number; bytes: number; awake: number | null; learning: number | null; kept_ready: number | null }
  collections: { id: string; name: string; state: string; version: number; documents: number; lastRestorePointAt: string | null; lastBackupAt: string | null; lastUsedAt: string | null }[]
  /** Daily backups are kept this many days (the organization's backup_days). */
  backupDays?: number
}

export type AttentionItem =
  | { kind: 'unreadable'; id: string; at: string; files: { name: string; reason: string }[]; message: string }
  | { kind: 'hidden'; id: string; at: string; documentId: string; documentName: string; total: number }
  | { kind: 'needs_check'; id: string; at: string; correctionId: string | null; text: string | null; documentId: string; documentName: string | null; noteId: string; textHash: string }
  | { kind: 'reported'; id: string; at: string; question: string; note: string; answer: string; reportedBy: { id: string; name: string | null } }

export interface AttentionCollection {
  id: string
  name: string
  role: CollectionRole
  items: AttentionItem[]
}
