// Restore points: the list, the preview, going back, undo, repairing after a failed check, and coming back from the
// latest backup when a snapshot expired or the engine image changed. Each restore point keeps its own full
// checksum manifest (through its snapshot), so an older one is checked before it opens.

import type { GoBackPreview, NotRestorableReason, RestorePoint } from './contract.ts'
import type { CollectionEngine } from './collection.ts'
import { fail } from './http.ts'
import { SETTINGS } from './settings.ts'
import type { Operation, RestorePointRecord, SnapshotRecord } from './types.ts'
import { clock, errorText, iso, randomId } from './util.ts'
import { commitPoint, emptyChanges, queueRelearn } from './imports.ts'
import * as backup from './backup.ts'

const REASONS: Record<NotRestorableReason, string> = {
  removed_for_good: "This version can't be brought back: a file in it was removed for good.",
  expired: "This version can't be brought back: restore points are kept for 30 days.",
  engine_changed: "This version can't be brought back: Insulin Knowledge's engine changed since it was saved.",
  newly_hidden: "This version can't be brought back: it holds text that is hidden now.",
  damaged: "This version can't be brought back: its saved copy failed its check.",
}

export function snapshotProblem(snapshot: SnapshotRecord, image: string): 'expired' | 'engine_changed' | null {
  if (snapshot.image !== image) return 'engine_changed'
  if (snapshot.expired) return 'expired'
  const since = Date.parse(snapshot.lastRestoredAt ?? snapshot.createdAt)
  return clock.now() - since > SETTINGS.snapshotLifetimeMs ? 'expired' : null
}

export async function reasonFor(e: CollectionEngine, point: RestorePointRecord): Promise<NotRestorableReason | null> {
  if (point.blocked) return point.blocked
  const snapshot = point.snapshotId ? await e.store.getSnapshot(point.snapshotId) : undefined
  if (snapshot?.damaged) return 'damaged'
  return snapshot ? snapshotProblem(snapshot, e.box.image) : 'expired'
}

export async function list(e: CollectionEngine): Promise<RestorePoint[]> {
  const meta = await e.meta()
  const out: RestorePoint[] = []
  for (const point of (await e.store.listPoints()).reverse()) {
    if (point.folded || point.version === 0) continue
    const reason = await reasonFor(e, point)
    out.push({
      version: point.version,
      createdAt: point.createdAt,
      summary: point.summary,
      documents: point.counts.documents,
      restorable: reason === null,
      reason,
      current: point.version === meta.version,
    })
  }
  return out
}

async function listedPoint(e: CollectionEngine, version: number): Promise<RestorePointRecord> {
  const point = await e.store.getPoint(version)
  if (!point || point.folded) return fail('not_found', 'No such restore point.')
  return point
}

export async function preview(e: CollectionEngine, version: number): Promise<GoBackPreview> {
  const meta = await e.meta()
  const point = await listedPoint(e, version)
  const target = (await e.store.getState(version))!
  const current = await e.currentState(meta)
  const kept = new Set(target.documents.map((d) => d.documentId))
  const targetCorrections = new Set(target.marks.map((m) => m.correctionImportId))
  const reason = await reasonFor(e, point)
  return {
    version,
    documents: target.documents.length,
    setAside: current.documents.filter((d) => !kept.has(d.documentId)).map((d) => ({ documentId: d.documentId, name: d.name })),
    correctionsUndone: new Set(current.marks.filter((m) => !targetCorrections.has(m.correctionImportId)).map((m) => m.correctionImportId)).size,
    restorable: reason === null,
    reason,
  }
}

export async function requestGoBack(e: CollectionEngine, version: number, undo: boolean): Promise<void> {
  const meta = await e.meta()
  if (meta.op) return fail('busy_learning', 'The collection is already going back; try again in a minute.')
  if (meta.active || meta.removals.length) return fail('busy_learning', 'Going back waits until the collection finishes learning.')
  const point = await listedPoint(e, version)
  if (version === meta.version && !undo) return
  const reason = await reasonFor(e, point)
  if (reason) return fail('not_restorable', REASONS[reason])
  await e.updateMeta((m) => {
    m.op = { kind: 'go_back', target: version, undo, startedAt: iso() }
  })
  await e.store.log('go-back-requested', { from: meta.version, to: version, undo })
  await e.state.storage.setAlarm(clock.now())
}

export async function requestUndo(e: CollectionEngine): Promise<void> {
  const meta = await e.meta()
  const point = meta.version ? await e.store.getPoint(meta.version) : undefined
  if (!point || point.previous === null || point.previous === 0) return fail('not_restorable', 'There is nothing to undo.')
  return requestGoBack(e, point.previous, true)
}

export async function runOperation(e: CollectionEngine): Promise<void> {
  const op = (await e.meta()).op
  if (!op) return
  try {
    if (op.kind === 'go_back') await goBack(e, op)
    else if (op.kind === 'repair') await repair(e, op)
    else await fromBackup(e, op)
  } catch (error) {
    await e.store.log('operation-failed', { kind: op.kind, error: errorText(error) })
    await e.box.destroy('operation failed')
    await e.store.deleteRuntime()
    const failures = ((await e.state.storage.get<number>('opFailures')) ?? 0) + 1
    if (failures >= 3) {
      // Give up on this operation; the collection stays at its current version.
      await e.state.storage.delete('opFailures')
      await e.updateMeta((m) => {
        m.op = null
      })
    } else {
      await e.state.storage.put('opFailures', failures)
    }
  }
}

/**
 * Starts a container from a restore point's snapshot and checks it against that point's own manifest. True when
 * the files match; the container then holds exactly that restore point and nothing has opened its databases.
 */
async function startVerified(e: CollectionEngine, point: RestorePointRecord): Promise<boolean> {
  const snapshot = point.snapshotId ? await e.store.getSnapshot(point.snapshotId) : undefined
  if (!snapshot) return false
  const expected = await e.store.getManifest(snapshot.handle.id)
  await e.startContainer(snapshot, 'questions')
  const actual = await e.box.manifest()
  if (!expected || actual.digest !== expected.digest) {
    await e.store.log('checksum-mismatch', { version: point.version, snapshot: snapshot.handle.id })
    await e.box.destroy('checksum mismatch')
    await e.store.deleteRuntime()
    return false
  }
  await e.store.log('checksum-ok', { version: point.version, snapshot: snapshot.handle.id })
  return true
}

/** After a verified start: the query process loads and opens next, in the normal wake steps. */
async function openAfterVerified(e: CollectionEngine): Promise<void> {
  const runtime = await e.store.getRuntime()
  if (runtime) {
    runtime.phase = 'opening'
    runtime.phaseAt = iso()
    await e.store.putRuntime(runtime)
  }
  await e.updateMeta((m) => {
    m.wakeRequested = true
    m.lastActivityAt = iso()
  })
}

function syntheticRecord(prefix: string) {
  const importId = randomId(prefix)
  return {
    status: {
      importId,
      state: 'committed' as const,
      attempt: 1,
      queuePosition: null,
      waitingFor: null,
      files: [],
      notes: 0,
      version: null,
      newFacts: 0,
      failedFileId: null,
      error: null,
      etaSeconds: null,
      createdAt: iso(),
      finishedAt: null,
    },
    kind: 'change' as const,
    small: true,
    phase: 'done' as const,
    files: [],
    notes: [],
    hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] },
    jobId: null,
    capacity: 'none' as const,
    reserveVersion: null,
    removeDocumentIds: [],
    rereadDocumentIds: [],
    snapshotTaken: false,
    learningStartedAt: null,
    retryAt: null,
    jobStartedAt: null,
    textsSaved: false,
    rebuild: false,
    restoreFrom: null,
    result: null,
    test: null,
  }
}

async function goBack(e: CollectionEngine, op: Extract<Operation, { kind: 'go_back' }>): Promise<void> {
  const meta = await e.meta()
  const target = await e.store.getPoint(op.target)
  const reason = target ? await reasonFor(e, target) : 'expired'
  if (!target || reason) {
    await e.store.log('go-back-refused', { to: op.target, reason })
    await e.updateMeta((m) => {
      m.op = null
    })
    return
  }
  if (!(await startVerified(e, target))) {
    const failures = ((await e.state.storage.get<number>('goBackFailures')) ?? 0) + 1
    if (failures < 2) {
      await e.state.storage.put('goBackFailures', failures)
      return
    }
    await e.state.storage.delete('goBackFailures')
    await e.updateMeta((m) => {
      m.op = null
    })
    if (target.snapshotId) await e.markDamaged(target.snapshotId)
    await e.store.log('go-back-failed', { to: op.target })
    return
  }
  await e.state.storage.delete('goBackFailures')
  const current = meta.version ? await e.store.getPoint(meta.version) : undefined
  const state = (await e.store.getState(target.version))!
  await commitPoint(e, {
    record: syntheticRecord(op.undo ? 'undo' : 'back'),
    kind: op.undo ? 'undo' : 'go_back',
    changes: emptyChanges(),
    state,
    snapshot: null,
    snapshotId: target.snapshotId,
    newFacts: 0,
    summary: op.undo ? `Undid “${current?.summary ?? `version ${meta.version}`}”` : `Went back to version ${target.version}`,
    previous: meta.version,
    importEvent: false,
  })
  await e.updateMeta((m) => {
    m.op = null
  })
  await openAfterVerified(e)
}

/**
 * The current restore point failed its check twice. Come back from the latest backup when it holds this very
 * version; otherwise answer from the newest earlier restore point that passes its check; otherwise learn everything
 * again from the stored text.
 */
async function repair(e: CollectionEngine, op: Extract<Operation, { kind: 'repair' }>): Promise<void> {
  const meta = await e.meta()
  const latest = await backup.latestIndex(e)
  const failed = (await e.currentSnapshot(meta)).snapshot
  if (latest && failed && latest.manifest.digest === failed.manifest.digest && !op.tried.includes(-1)) {
    await e.updateMeta((m) => {
      m.op = { kind: 'from_backup', reason: 'repair', startedAt: iso(), restartedAfterFailure: false }
    })
    return
  }
  const candidates = (await e.store.listPoints())
    .filter((p) => p.version < op.failedVersion && !p.folded && p.version > 0 && !op.tried.includes(p.version))
    .reverse()
  for (const candidate of candidates) {
    if (await reasonFor(e, candidate)) continue
    const tried = [...op.tried, candidate.version]
    await e.updateMeta((m) => {
      m.op = { ...op, tried }
    })
    if (!(await startVerified(e, candidate))) return // next alarm tries the next one
    const state = (await e.store.getState(candidate.version))!
    const note = `Answering from version ${candidate.version} after version ${op.failedVersion} failed its check`
    await commitPoint(e, {
      record: syntheticRecord('repair'),
      kind: 'repair',
      changes: emptyChanges(),
      state,
      snapshot: null,
      snapshotId: candidate.snapshotId,
      newFacts: 0,
      summary: note,
      previous: meta.version,
      importEvent: false,
    })
    await e.updateMeta((m) => {
      m.op = null
      m.repairNote = note
    })
    await e.event(`state:repaired:${candidate.version}:${iso()}`, {
      type: 'state',
      state: 'repairing',
      version: candidate.version,
    })
    await openAfterVerified(e)
    // Meanwhile everything is learned again from the saved text, with the files added after this version.
    await queueRelearn(e, 'repair', op.failedVersion)
    return
  }
  await e.store.log('repair-relearn', { failedVersion: op.failedVersion })
  await e.updateMeta((m) => {
    m.op = null
  })
  await queueRelearn(e, 'repair', op.failedVersion)
}

/**
 * The current restore point's snapshot expired or the engine image changed: start an empty container and put the
 * latest backup's files back when it holds this version in the same database format, check them against the
 * backup's manifest, and save a new restore point. Otherwise everything is learned again from its stored text.
 */
async function fromBackup(e: CollectionEngine, op: Extract<Operation, { kind: 'from_backup' }>): Promise<void> {
  const meta = await e.meta()
  const latest = await backup.latestIndex(e)
  const current = (await e.currentSnapshot(meta)).snapshot
  const runtime = await e.startContainer(null, 'learning', true)
  const usable = latest && current && backup.holds(latest, current, runtime.dataFormat)
  if (!usable || !(await backup.restoreFiles(e, latest))) {
    await e.store.log('from-backup-relearn', { reason: op.reason, backupVersion: latest?.version ?? null })
    await e.box.destroy('backup not usable; learning again')
    await e.store.deleteRuntime()
    await e.updateMeta((m) => {
      m.op = null
    })
    await queueRelearn(e, op.reason)
    return
  }
  await e.box.waitQuiescent()
  const manifest = await e.box.manifest()
  const snapshot = await e.box.snapshot(`${meta.collectionId}-from-backup-${latest.day}`)
  const state = await e.currentState(meta)
  const committed = await commitPoint(e, {
    record: syntheticRecord('restore'),
    kind: 'from_backup',
    changes: emptyChanges(),
    state,
    snapshot: { handle: snapshot, manifest },
    snapshotId: snapshot.id,
    newFacts: 0,
    summary: `Came back from its backup of ${latest.day}`,
    previous: meta.version,
    importEvent: false,
  })
  if (!committed) {
    // A removal for good came first: it brings the files back itself, without the removed one.
    await e.box.destroy('a removal for good goes first')
    await e.store.deleteRuntime()
    await e.updateMeta((m) => {
      m.op = null
    })
    return
  }
  await e.updateMeta((m) => {
    m.op = null
    m.backupDue = false
  })
  await e.store.log('from-backup-done', { version: (await e.meta()).version, backupDay: latest.day })
  await openAfterVerified(e)
}
