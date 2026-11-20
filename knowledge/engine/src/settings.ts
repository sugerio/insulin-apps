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
  // A running import that hasn't renewed its slot for this long is presumed lost and its slot freed. An import renews
  // it at every step (every pollMs while its job runs), so one that learns for hours keeps it.
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
  // A try's job is given up after an hour, or three times its planned time when that is longer (a large text).
  jobTimeoutMs: 60 * 60 * 1000,
  quiesceTimeoutMs: 60 * 1000,
  queryLoadTimeoutMs: 5 * 60 * 1000,
  // A wake that hasn't reached "ready" by then is stopped and started again.
  wakeTimeoutMs: 10 * 60 * 1000,
  // Re-ask the capacity guard this often while an import waits, in case a release notice was lost.
  capacityRetryMs: 30 * 1000,
  // After Cloudflare had no container to give a start (its account limits, or too many starts at once), no container
  // is asked for until this long has passed.
  noContainerRetryMs: 30 * 1000,
  // The container's own inactivity timeout: a safety net behind the Durable Object's sleep alarm.
  inactivityTimeoutMs: 60 * 60 * 1000,
  // Usage is written to the outbox at least this often while a container runs.
  usageFlushMs: 60 * 1000,
  // Files staged in the inbox: the app checks the organization's limit (25 MB by default); this is the engine's cap.
  maxFileBytes: 64 * 1024 * 1024,
  // Uploads go to R2 in parts this large (R2's least is 5 MB): one part at a time is held in memory.
  uploadPartBytes: 8 * 1024 * 1024,
  cancelledKeepMs: 30 * 24 * 60 * 60 * 1000, // an id cancelled before the engine saw it is remembered this long
  maxExportImportBytes: 32 * 1024 * 1024, // an export a collection starts from is read whole into memory
  maxFilesPerImport: 200,
  // Staged files nobody imported are deleted after a day, or at most this long when kept for a waiting import.
  stagedKeepMs: 24 * 60 * 60 * 1000,
  maxKeepStagedMs: 45 * 24 * 60 * 60 * 1000,
  maxNotesPerImport: 50,
  maxNoteChars: 20000,
  // Planning values, measured on Cloudflare (standard-4, the Engine-lane run of 2026-11-17, documents learned one at a
  // time), from a try's job start to its commit: one short file or note 110-116 s (about 50 s of Cognee, 55 s saving);
  // 20 short documents 211 s, 41 learned again 317 s (5.3 s each); one 2 MiB text (848 passages) 1,835 s. Time grows
  // with the text, not only with the documents: a document's text is planned from its size until it is read (a
  // file's bytes, at most the 2 MB read limit; a quarter of them for formats that aren't plain text), then from the
  // text read. Starting the container (from a snapshot or the image, and its check) took 29-31 s more. Documents are
  // learned in groups now, and the fixed part and the time per document are fitted to the two runs that did so
  // (2026-11-18, IMP-07: 50 short documents, submission to commit, against the engine's plan at the try's start):
  // g1118a 314 s from the image and 269-285 s in the awake container (Cognee 3.6-4.0 s per document); the final run
  // (g1118b) 250.4 s and 211.5-224.8 s (Cognee 3.0-3.2 s; outside Cognee 60-67 s: 12-20 s before the job, ~7 s of the
  // job, ~40 s saving). The two runs' same import differs by a quarter, so the plan sits between them: 65 s fixed and
  // 3.4 s per document, 256 s for an import in the awake container and 286 s for one that starts its container, holds
  // every one of them within 25%. A later try of an import learns them one at a time again: 5.3 s. The collection's
  // size isn't planned for: Cognee's time per document doesn't grow with it. The container start is planned only for
  // a try that starts one (not one learning in the awake collection's).
  containerStartSeconds: 30,
  importBaseSeconds: 65,
  perDocumentSeconds: 3.4,
  perDocumentOneByOneSeconds: 5.3,
  perTextMiBSeconds: 860,
  readLimitBytes: 2 * 1024 * 1024,
  wakeSeconds: 60,
  wakeFromBackupSeconds: 300,
  goBackSeconds: 60,
  // A repair that answers from an earlier restore point learns everything again once nobody has asked for the
  // collection's awakeMinutes, or after this long at most.
  repairWaitMs: 60 * 60 * 1000,
  // Search
  defaultTopK: 8,
  maxTopK: 20,
  maxQueryChars: 2000,
  // The built-in answer model (Gemma 4 on Workers AI).
  answerModel: '@cf/google/gemma-4-26b-a4b-it',
  // An answer the model had no capacity for is asked again only while this long has passed since the first call (an
  // answer takes 6-8 s: at most three calls).
  answerBudgetMs: 20 * 1000,
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
