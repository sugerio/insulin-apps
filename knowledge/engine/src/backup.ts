// Backups to R2 (BACKUPS), on every day with changes: the files under /data (SQLite, LanceDB, the graph, redacted
// texts, facts) stored by content hash, so an unchanged file or database segment is stored once, plus an index per
// day naming every file and the answer state. Daily backups are kept 30 days; the latest is kept for the
// collection's life, so a collection is never lost by sitting unused.

import type { CollectionEngine } from './collection.ts'
import type { AnswerState, Manifest, Meta, Runtime, SnapshotRecord } from './types.ts'
import { SETTINGS } from './settings.ts'
import { clock, errorText, iso, utcDay } from './util.ts'
import { unzipEntry, zipEntries } from './zip.ts'

export interface BackupIndex {
  format: 1
  collectionId: string
  version: number
  snapshotId?: string | null // the snapshot the backed-up container started from
  createdAt: string
  day: string
  image: string
  dataFormat: string
  manifest: Manifest
  state: AnswerState
}

const prefix = (meta: Meta) => `backups/${meta.org}/${meta.collectionId}/`
const blobKey = (meta: Meta, sha256: string) => `${prefix(meta)}blobs/${sha256}`

/** Backs up the running container, which must hold the current restore point, clean and quiescent. */
export async function run(e: CollectionEngine, runtime: Runtime): Promise<BackupIndex> {
  const meta = await e.meta()
  if (runtime.dirty) throw new Error('a container with uncommitted changes is never backed up')
  if (runtime.queryStarted) {
    await e.box.queryStop()
    runtime.queryStarted = false
    runtime.phase = 'busy'
    await e.store.putRuntime(runtime)
  }
  await e.box.waitQuiescent()
  const manifest = await e.box.manifest()
  let uploaded = 0
  for (const [path, entry] of Object.entries(manifest.entries)) {
    const key = blobKey(meta, entry.sha256)
    if (await e.env.BACKUPS.head(key)) continue
    // R2 checks the bytes against the manifest's checksum: a stream cut short by a drop is refused and read again.
    await e.box.copyFile(path, (body) => e.env.BACKUPS.put(key, body, { sha256: entry.sha256 }))
    uploaded += 1
  }
  const day = utcDay()
  const index: BackupIndex = {
    format: 1,
    collectionId: meta.collectionId,
    version: meta.version,
    snapshotId: runtime.snapshotId,
    createdAt: iso(),
    day,
    image: runtime.image,
    dataFormat: runtime.dataFormat,
    manifest,
    state: await e.currentState(meta),
  }
  const body = JSON.stringify(index)
  await e.env.BACKUPS.put(`${prefix(meta)}daily/${day}.json`, body, { httpMetadata: { contentType: 'application/json' } })
  await e.env.BACKUPS.put(`${prefix(meta)}latest.json`, body, { httpMetadata: { contentType: 'application/json' } })
  await e.updateMeta((m) => {
    m.lastBackupAt = index.createdAt
    m.lastBackupVersion = index.version
    m.backupDue = m.version !== index.version
  })
  await e.event(`backup:${day}:${index.version}`, { type: 'backup', version: index.version })
  await e.store.log('backup', { version: index.version, files: manifest.files, uploaded })
  await prune(e)
  return index
}

/** A backup while asleep: starts the current restore point, checks it, backs it up and stops it. */
export async function coldBackup(e: CollectionEngine): Promise<void> {
  const meta = await e.meta()
  const { snapshot, unusable } = await e.currentSnapshot(meta)
  if (!snapshot || unusable) {
    await e.store.log('backup-skipped', { reason: unusable ?? 'no snapshot' })
    return
  }
  try {
    const runtime = await e.startContainer(snapshot, 'learning')
    const expected = await e.store.getManifest(snapshot.handle.id)
    const actual = await e.box.manifest()
    if (!expected || actual.digest !== expected.digest) throw new Error('checksum mismatch before the backup')
    await e.chargeUsage('awake')
    await run(e, runtime)
  } catch (error) {
    await e.store.log('backup-failed', { error: errorText(error) })
  } finally {
    await e.box.destroy('backup done')
    await e.store.deleteRuntime()
    await e.chargeUsage(null)
  }
}

/**
 * Whether a backup was taken of a snapshot's restore point, in the database format the running image reads. Matched
 * by the snapshot it came from, not by version (a change that adds no data keeps the snapshot); a backup taken after a
 * wake differs a little from its snapshot's files (open databases change /data), so checksums alone would miss it.
 * The same files are a match too: a snapshot taken right after coming back from this backup holds exactly its files,
 * so a later repair or expiry of that snapshot comes back from the same backup again. Restoring checks the files
 * against the backup's own list.
 */
export function holds(index: BackupIndex, snapshot: SnapshotRecord, dataFormat: string): boolean {
  return index.dataFormat === dataFormat && holdsFiles(index, snapshot)
}

/** The backup's files are the snapshot's: taken from it, or byte for byte the same (the database format aside). */
export function holdsFiles(index: BackupIndex, snapshot: SnapshotRecord): boolean {
  return index.snapshotId === snapshot.handle.id || index.manifest.digest === snapshot.manifest.digest
}

export async function latestIndex(e: CollectionEngine): Promise<BackupIndex | null> {
  const meta = await e.meta()
  const object = await e.env.BACKUPS.get(`${prefix(meta)}latest.json`)
  return object ? ((await object.json()) as BackupIndex) : null
}

/** Puts a backup's files into an empty container. False when a file is missing or the result doesn't match. */
export async function restoreFiles(e: CollectionEngine, index: BackupIndex): Promise<boolean> {
  const meta = await e.meta()
  for (const [path, entry] of Object.entries(index.manifest.entries)) {
    const key = blobKey(meta, entry.sha256)
    if (!(await e.env.BACKUPS.head(key))) {
      await e.store.log('backup-file-missing', { path })
      return false
    }
    // Read from R2 for each send: a send repeated after a drop streams the file again.
    await e.box.putFile(path, async () => {
      const object = await e.env.BACKUPS.get(key)
      if (!object) throw new Error(`the backup's file ${path} went missing`)
      return object.body
    })
  }
  const actual = await e.box.manifest()
  if (actual.digest !== index.manifest.digest) {
    await e.store.log('backup-checksum-mismatch', { day: index.day })
    return false
  }
  await e.store.log('checksum-ok', { backup: index.day, files: actual.files })
  return true
}

async function dailyIndexes(e: CollectionEngine): Promise<string[]> {
  const meta = await e.meta()
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const listed = await e.env.BACKUPS.list({ prefix: `${prefix(meta)}daily/`, cursor })
    keys.push(...listed.objects.map((o) => o.key))
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return keys
}

/** Drops daily backups older than the collection's backupDays, then every stored file no backup names any more. */
export async function prune(e: CollectionEngine): Promise<void> {
  const days = (await e.meta()).settings.backupDays ?? SETTINGS.backupDays
  const cutoff = utcDay(clock.now() - days * 24 * 60 * 60 * 1000)
  const old = (await dailyIndexes(e)).filter((key) => (key.split('/').pop() ?? '').slice(0, 10) < cutoff)
  if (old.length) await e.env.BACKUPS.delete(old)
  await collectGarbage(e)
}

async function collectGarbage(e: CollectionEngine): Promise<void> {
  const meta = await e.meta()
  const referenced = new Set<string>()
  for (const key of [...(await dailyIndexes(e)), `${prefix(meta)}latest.json`]) {
    const object = await e.env.BACKUPS.get(key)
    if (!object) continue
    const index = (await object.json()) as BackupIndex
    for (const entry of Object.values(index.manifest.entries)) referenced.add(entry.sha256)
  }
  let cursor: string | undefined
  do {
    const listed = await e.env.BACKUPS.list({ prefix: `${prefix(meta)}blobs/`, cursor })
    const unused = listed.objects.map((o) => o.key).filter((key) => !referenced.has(key.split('/').pop() ?? ''))
    if (unused.length) await e.env.BACKUPS.delete(unused)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}

/** Remove for good: every backup that holds the document is dropped; the caller writes a new latest one. */
export async function dropDocument(e: CollectionEngine, documentId: string): Promise<void> {
  const meta = await e.meta()
  let latestDropped = false
  for (const key of [...(await dailyIndexes(e)), `${prefix(meta)}latest.json`]) {
    const object = await e.env.BACKUPS.get(key)
    if (!object) continue
    const index = (await object.json()) as BackupIndex
    if (index.state.documents.some((d) => d.documentId === documentId)) {
      await e.env.BACKUPS.delete(key)
      latestDropped ||= key.endsWith('latest.json')
    }
  }
  await collectGarbage(e)
  // Without a latest backup, one is taken soon.
  if (latestDropped) {
    await e.updateMeta((m) => {
      m.backupDue = true
    })
  }
}

/**
 * Stricter hiding changed these documents' texts in version `before`: every backup of an earlier version that holds
 * one of them holds its words unhidden, so it is dropped; the caller writes a new latest one.
 */
export async function dropOlder(e: CollectionEngine, before: number, documentIds: string[]): Promise<void> {
  const meta = await e.meta()
  const changed = new Set(documentIds)
  let latestDropped = false
  for (const key of [...(await dailyIndexes(e)), `${prefix(meta)}latest.json`]) {
    const object = await e.env.BACKUPS.get(key)
    if (!object) continue
    const index = (await object.json()) as BackupIndex
    if (index.version < before && index.state.documents.some((d) => changed.has(d.documentId))) {
      await e.env.BACKUPS.delete(key)
      latestDropped ||= key.endsWith('latest.json')
    }
  }
  await collectGarbage(e)
  if (latestDropped) {
    await e.updateMeta((m) => {
      m.backupDue = true
    })
  }
}

/** HID-01's and HID-04's evidence, test controls only: where each planted value can still be found. */
export async function grep(e: CollectionEngine, values: string[]): Promise<Record<string, Record<string, number>>> {
  const meta = await e.meta()
  const found: Record<string, Record<string, number>> = {}
  for (const value of values) found[value] = { container: 0, text: 0, backups: 0, exports: 0 }
  const count = (haystack: string, needle: string) => (needle ? haystack.split(needle).length - 1 : 0)
  const runtime = await e.store.getRuntime()
  if (runtime && e.box.running) {
    const job = await e.box.runJob('grep', { values })
    for (const value of values) found[value].container = Number(job.result?.counts?.[value] ?? 0)
  }
  const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes)
  for (const [bucket, area, start] of [
    [e.env.FILES, 'text', `text/${meta.org}/${meta.collectionId}/`],
    [e.env.BACKUPS, 'backups', prefix(meta)],
    [e.env.FILES, 'exports', `exports/${meta.org}/${meta.collectionId}/`],
  ] as const) {
    let cursor: string | undefined
    do {
      const listed = await bucket.list({ prefix: start, cursor })
      for (const object of listed.objects) {
        const body = await bucket.get(object.key)
        if (!body) continue
        const bytes = new Uint8Array(await body.arrayBuffer())
        // An export's entries are deflated: each is read.
        const texts: string[] = [decode(bytes)]
        if (area === 'exports') {
          for (const entry of zipEntries(bytes)?.values() ?? []) {
            const inflated = await unzipEntry(entry, 64 * 1024 * 1024)
            if (inflated) texts.push(decode(inflated))
          }
        }
        for (const value of values) for (const text of texts) found[value][area] += count(text, value)
      }
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
  }
  return found
}
