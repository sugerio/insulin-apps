// Service-wide settings (design section 12, "Service-wide settings"). The numbers are planning values until Phase 0
// measures them. Instance types can be overridden per deployment with ENGINE_QUESTIONS_INSTANCE and
// ENGINE_LEARNING_INSTANCE, so moving questions to standard-1 (Q10) needs no code change.

import type { CollectionSettings } from './contract.ts'

export const ENGINE_LABEL = 'insulin-knowledge-engine 0.1.0 (api 1)'

export type InstanceType = 'lite' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4'
const INSTANCE_TYPES: InstanceType[] = ['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4']

export interface EngineEnvSettings {
  ENGINE_QUESTIONS_INSTANCE?: string
  ENGINE_LEARNING_INSTANCE?: string
}

export function instances(env: EngineEnvSettings): { questions: InstanceType; learning: InstanceType } {
  const pick = (value: string | undefined): InstanceType =>
    INSTANCE_TYPES.includes(value as InstanceType) ? (value as InstanceType) : 'standard-4'
  return { questions: pick(env.ENGINE_QUESTIONS_INSTANCE), learning: pick(env.ENGINE_LEARNING_INSTANCE) }
}

export const SETTINGS = {
  containerPort: 8080,
  // Imports at once: across the service, and per organization.
  importsAtOnce: 20,
  importsPerOrganization: 2,
  // A running import that hasn't renewed its slot for this long is presumed lost and its slot freed.
  capacityLeaseMs: 30 * 60 * 1000,
  // Three tries per import before the failing file is named.
  maxAttempts: 3,
  // Changes within this window share one restore point.
  shareRestorePointMs: 5 * 60 * 1000,
  // Snapshots last 30 days from creation or last restore.
  snapshotLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  // Daily backups kept (the latest is kept for the collection's life).
  backupDays: 30,
  // Outbox events are kept 7 days.
  outboxKeepMs: 7 * 24 * 60 * 60 * 1000,
  // Exports can be downloaded for 7 days.
  exportKeepMs: 7 * 24 * 60 * 60 * 1000,
  // Polling while a container job runs, and while waking.
  pollMs: 3000,
  wakePollMs: 1000,
  healthTimeoutMs: 10 * 60 * 1000,
  jobTimeoutMs: 60 * 60 * 1000,
  quiesceTimeoutMs: 60 * 1000,
  queryLoadTimeoutMs: 5 * 60 * 1000,
  // A wake that hasn't reached "ready" by then is stopped and started again.
  wakeTimeoutMs: 10 * 60 * 1000,
  // Re-ask the capacity guard this often while an import waits, in case a release notice was lost.
  capacityRetryMs: 30 * 1000,
  // The container's own inactivity timeout: a safety net behind the Durable Object's sleep alarm.
  inactivityTimeoutMs: 60 * 60 * 1000,
  // Usage is written to the outbox at least this often while a container runs.
  usageFlushMs: 60 * 1000,
  // Files staged in the inbox: the app checks the organization's limit (25 MB by default); this is the engine's cap.
  maxFileBytes: 64 * 1024 * 1024,
  // Uploads go to R2 in parts this large (R2's least is 5 MB): one part at a time is held in memory.
  uploadPartBytes: 8 * 1024 * 1024,
  maxFilesPerImport: 200,
  // Staged files nobody imported are deleted after a day, or at most this long when kept for a waiting import.
  stagedKeepMs: 24 * 60 * 60 * 1000,
  maxKeepStagedMs: 45 * 24 * 60 * 60 * 1000,
  maxNotesPerImport: 50,
  maxNoteChars: 20000,
  // Planning values from the PoC (section 13): about 43 s per import plus 5.3 s per document.
  importBaseSeconds: 43,
  perDocumentSeconds: 5.3,
  wakeSeconds: 60,
  wakeFromBackupSeconds: 300,
  goBackSeconds: 60,
  // Search
  defaultTopK: 8,
  maxTopK: 20,
  maxQueryChars: 2000,
  // The built-in answer model (Gemma 4 on Workers AI).
  answerModel: '@cf/google/gemma-4-26b-a4b-it',
  maxAnswerPassages: 20,
  maxPassageChars: 6000,
}

export const DEFAULT_SETTINGS: CollectionSettings = {
  hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] },
  keepReady: null,
  awakeMinutes: 10,
  backupDays: 30,
  revision: 0,
}
