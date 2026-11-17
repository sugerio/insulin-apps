// The CollectionEngine Durable Object: one per collection, holding its container (Cognee inside), its imports,
// restore points, backups, keep-ready window and running-time ledger. Grown from the PoC's KnowledgeBox, whose
// consistency rules it keeps:
//
// 1. One op, one process: every Cognee operation in the container runs in its own process; the query process is the
//    one that stays loaded, and it is stopped before anything else touches the databases.
// 2. Quiesce before snapshot: no job, no query process, no open file under /data, nothing staged.
// 3. Commit = checkpoint: snapshot handle, checksum manifest, counts and answer-changing state are written in one
//    storage transaction. That commit is the restore point.
// 4. Never reuse a dirty container: one that held an uncommitted import is destroyed.
// 5. Verify before opening: after a start from a snapshot, the files are checked against that snapshot's own
//    manifest before the databases open.
// 6. Idempotent imports: an import id answers its existing import; a file whose content is already here is skipped.
//
// Requests only record what they want and set the alarm; the alarm (drive) does every container step, so container
// work for one collection never runs twice at once, and questions are answered at once ("waking", "learning")
// instead of waiting.

import type {
  CollectionCounts,
  CollectionSettings,
  CollectionState,
  CollectionStatus,
  DocumentInfo,
  DocumentText,
  Fact,
  HidingRules,
  SearchResult,
  UsageKind,
  WakeProgress,
} from './contract.ts'
import { ORG_HEADER } from './contract.ts'
import { ContainerClient } from './container.ts'
import { type Env, REGISTRY_NAME, callObject, testControls, OUTBOX_NAME, CAPACITY_NAME } from './env.ts'
import { EngineFailure, errorResponse, fail, json, readJson, requireId } from './http.ts'
import { nextWindowStart, validateKeepReady, windowAt } from './keep-ready.ts'
import { matchRoute, ROUTES, TEST_ROUTES } from './routes.ts'
import { DEFAULT_SETTINGS, SETTINGS, instances } from './settings.ts'
import { CollectionStore } from './store.ts'
import type { AnswerState, DocRecord, ImportRecord, Meta, PendingEvent, RestorePointRecord, Runtime, SnapshotRecord } from './types.ts'
import { clock, errorText, iso } from './util.ts'
import * as imports from './imports.ts'
import * as history from './history.ts'
import * as backup from './backup.ts'
import * as exporter from './exporter.ts'

export const EMPTY_COUNTS: CollectionCounts = { documents: 0, activeDocuments: 0, passages: 0, facts: 0, textBytes: 0 }
export const EMPTY_STATE: AnswerState = { documents: [], marks: [], factsKey: null, facts: 0, passages: 0, textBytes: 0 }

const START_FAILURES_BEFORE_EXPIRED = 3
const WAKE_TIMEOUTS_BEFORE_GIVING_UP = 3

export class CollectionEngine {
  state: DurableObjectState
  env: Env
  store: CollectionStore
  box: ContainerClient
  monitoring: Promise<void> | undefined

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.store = new CollectionStore(state.storage)
    this.box = new ContainerClient(state.container as Container)
    if (state.container?.running) this.observeExit()
  }

  // ================================================================== requests

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === '/internal/kick') {
        if (await this.store.getMeta()) await this.state.storage.setAlarm(clock.now())
        return json({ ok: true })
      }
      if (request.method === 'POST' && url.pathname === '/internal/hold') {
        // Hold changes are numbered by the registry: one older than the change this collection holds is refused, so
        // deliveries that overlap can't undo a newer hold or lift.
        const body = await readJson<{ until: string | null; seq?: number; version?: number }>(request)
        const hold: PendingHold = { org: request.headers.get(ORG_HEADER) ?? '', until: body.until, seq: body.seq ?? 0, version: body.version ?? 0 }
        const meta = await this.store.getMeta()
        if (!meta) {
          // Registered, not stored yet: the collection takes the newer of this and what registering said.
          const pending = await this.state.storage.get<PendingHold>('pendingHold')
          if (!pending || (hold.version >= pending.version && hold.seq >= pending.seq)) await this.state.storage.put('pendingHold', hold)
          return json({ ok: true })
        }
        if (meta.org !== hold.org) return json({ ok: true })
        if (hold.version < (meta.holdVersion ?? 0) || hold.seq < (meta.holdSeq ?? 0)) {
          await this.store.log('hold-stale', { seq: hold.seq, version: hold.version, holding: meta.holdSeq, holdingVersion: meta.holdVersion })
          return json({ ok: true, stale: true })
        }
        await this.updateMeta((m) => {
          m.heldUntil = hold.until
          m.holdSeq = hold.seq
          m.holdVersion = hold.version
        })
        await this.store.log(hold.until ? 'held' : 'hold-lifted', { until: hold.until, seq: hold.seq })
        if (isHeld(await this.meta())) await this.dropGoBackForHold()
        await this.state.storage.setAlarm(clock.now())
        return json({ ok: true })
      }
      const match = matchRoute(request.method, url.pathname, testControls(this.env) ? [...TEST_ROUTES, ...ROUTES] : ROUTES)
      if (!match || match === 'method_not_allowed' || match.route.scope !== 'collection') {
        return fail('not_found', 'No such route.')
      }
      const org = request.headers.get(ORG_HEADER)
      if (!org) return fail('bad_request', `Every request must name its organization in ${ORG_HEADER}.`)
      const collectionId = requireId(match.params.cid, 'The collection id')
      return await this.route(match.route.name, match.params, request, org, collectionId)
    } catch (error) {
      return errorResponse(error)
    }
  }

  async route(name: string, params: Record<string, string>, request: Request, org: string, collectionId: string): Promise<Response> {
    if (name === 'putCollection') return json(await this.putCollection(org, collectionId, request))
    const meta = await this.requireMeta(org)
    switch (name) {
      case 'getCollection':
        return json(await this.status())
      case 'deleteCollection':
        return json(await this.startDeletion(), 202)
      case 'getImport': {
        const record = await this.store.getImport(requireId(params.importId, 'The import id'))
        if (!record) return fail('not_found', 'No such import.')
        return json(await imports.view(this, record))
      }
      case 'listRestorePoints':
        return json({ restorePoints: await history.list(this) })
      case 'previewGoBack':
        return json(await history.preview(this, versionParam(params.version)))
      case 'listDocuments':
        return json({ documents: (await this.visibleDocuments()).map(publicDocument) })
      case 'getDocument':
        return json(await this.documentText(requireId(params.docId, 'The document id')))
      case 'listFacts':
        return json(await this.facts(new URL(request.url).searchParams.get('cursor')))
      case 'getExport':
        return exporter.get(this, requireId(params.exportId, 'The export id'), new URL(request.url).searchParams.get('download') === '1')
      case 'testState':
        return json(await this.testState())
    }
    if (meta.deleting) return fail('deleting', 'This collection is being deleted.')
    switch (name) {
      case 'wake':
        await this.requestWake()
        return json(await this.status())
      case 'stageFile':
        return json(await imports.stage(this, requireId(params.fileId, 'The file id'), request))
      case 'keepStaged':
        return json(await imports.keepStaged(this, await readJson(request)))
      case 'startImport': {
        const { status, record } = await imports.submit(this, await readJson(request))
        return json(await imports.view(this, record), status)
      }
      case 'correct': {
        const { status, record } = await imports.submitCorrection(this, await readJson(request))
        return json(await imports.view(this, record), status)
      }
      case 'importExport': {
        const { status, record } = await imports.submitExportImport(this, await readJson(request))
        return json(await imports.view(this, record), status)
      }
      case 'search':
        return json(await this.search(await readJson(request)))
      case 'setDocumentActive':
        return json(await imports.setActive(this, requireId(params.docId, 'The document id'), await readJson(request)))
      case 'removeDocument':
        return json(await imports.removeForGood(this, requireId(params.docId, 'The document id')))
      case 'goBack':
        this.refuseWhileHeld(meta)
        await history.requestGoBack(this, versionParam(params.version), false)
        return json(await this.status())
      case 'undo':
        this.refuseWhileHeld(meta)
        await history.requestUndo(this)
        return json(await this.status())
      case 'startExport':
        return json(await exporter.start(this, await readJson(request)))
      case 'testControl':
        return json(await this.testControl(params.action, await readJson(request)))
    }
    return fail('not_found', 'No such route.')
  }

  // ================================================================== collection and settings

  async requireMeta(org: string): Promise<Meta> {
    const meta = await this.store.getMeta()
    // Another organization's collection answers exactly like a missing one.
    if (!meta || meta.org !== org) return fail('not_found', 'No such collection.')
    return meta
  }

  async meta(): Promise<Meta> {
    const meta = await this.store.getMeta()
    if (!meta) throw new EngineFailure('not_found', 'No such collection.')
    return meta
  }

  /** Reads the latest meta, changes it and writes it back, so a change made by a request during an await is kept. */
  async updateMeta(change: (meta: Meta) => void): Promise<Meta> {
    const meta = await this.meta()
    change(meta)
    await this.store.putMeta(meta)
    return meta
  }

  async putCollection(org: string, collectionId: string, request: Request): Promise<CollectionStatus> {
    const body = await readJson<{ settings?: unknown }>(request)
    const existing = await this.store.getMeta()
    if (existing && existing.org !== org) return fail('not_found', 'No such collection.')
    if (existing?.deleting) return fail('deleting', 'This collection is being deleted.')
    const settings = validateSettings(body.settings, existing?.settings ?? DEFAULT_SETTINGS)
    // Settings carry the app's revision: an older one arriving late never undoes a newer one, and the same one again
    // changes nothing.
    const held = existing?.settings.revision ?? 0
    const sent = (body.settings as { revision?: unknown } | undefined)?.revision
    if (existing && sent !== undefined && settings.revision < held) {
      return fail('stale_settings', 'These settings are older than the ones the engine has.')
    }
    if (existing && sent !== undefined && settings.revision === held && held > 0) return this.status()
    if (!existing) {
      const entry = await callObject<{ state: string; holdUntil?: string | null; holdSeq?: number; holdVersion?: number }>(this.env.REGISTRY, REGISTRY_NAME, '/register', {
        body: { org, collectionId },
      })
      if (entry.state !== 'live') return fail('deleting', 'This collection was deleted; make a new one.')
      // A hold change that reached this collection while it registered is newer than what registering said.
      const pending = await this.state.storage.get<PendingHold>('pendingHold')
      const hold =
        pending && pending.org === org && pending.seq > (entry.holdSeq ?? 0)
          ? pending
          : { until: entry.holdUntil ?? null, seq: entry.holdSeq ?? 0, version: entry.holdVersion ?? 0 }
      if (pending) await this.state.storage.delete('pendingHold')
      const now = iso()
      await this.store.putMeta({
        org,
        collectionId,
        createdAt: now,
        settings,
        version: 0,
        nextVersion: 1,
        deleting: false,
        deleteStartedAt: null,
        lastQuestionAt: null,
        lastActivityAt: null,
        lastRestorePointAt: null,
        lastBackupAt: null,
        lastBackupVersion: null,
        backupDue: false,
        wakeRequested: false,
        op: null,
        queue: [],
        active: null,
        removals: [],
        hidingAppliedAt: now,
        repairNote: null,
        heldUntil: hold.until,
        holdSeq: hold.seq,
        holdVersion: hold.version,
      })
      await this.store.log('created')
    } else {
      const stricter = stricterHiding(existing.settings.hiding, settings.hiding)
      await this.updateMeta((m) => {
        m.settings = settings
      })
      // Stricter rules apply to files already learned: they are read again in the background (it counts as
      // learning), and older restore points that still hold the newly hidden text become not restorable.
      if (stricter && existing.version > 0) await imports.queueReread(this, settings.hiding)
      await this.state.storage.setAlarm(clock.now())
    }
    return this.status()
  }

  // ================================================================== status

  async status(): Promise<CollectionStatus> {
    const meta = await this.meta()
    const runtime = (await this.store.getRuntime()) ?? null
    const point = meta.version ? await this.store.getPoint(meta.version) : undefined
    const active = meta.active ? await this.store.getImport(meta.active) : undefined
    const state = this.collectionState(meta, runtime, active ?? null)
    return {
      collectionId: meta.collectionId,
      state,
      version: meta.version,
      counts: point?.counts ?? EMPTY_COUNTS,
      currentImport: active ? await imports.view(this, active) : null,
      queuedImports: meta.queue.length,
      wake: this.wakeProgress(state, runtime),
      lastRestorePointAt: meta.lastRestorePointAt,
      lastBackupAt: meta.lastBackupAt,
      lastQuestionAt: meta.lastQuestionAt,
      settings: meta.settings,
    }
  }

  collectionState(meta: Meta, runtime: Runtime | null, active: ImportRecord | null): CollectionState {
    if (meta.deleting) return 'deleting'
    if (isHeld(meta)) return 'held'
    if (meta.op?.kind === 'go_back') return 'going_back'
    if (meta.op?.kind === 'repair' || (meta.op?.kind === 'from_backup' && meta.op.reason === 'repair')) return 'repairing'
    if (meta.op?.kind === 'from_backup') return 'waking_from_backup'
    if (active && (active.phase === 'staging' || active.phase === 'running')) return 'learning'
    if (active && active.phase === 'saving') return 'saving'
    if (runtime && this.box.running) {
      if (runtime.phase === 'ready') return 'ready'
      if (runtime.phase !== 'busy') return runtime.fromBackup ? 'waking_from_backup' : 'waking'
    }
    if (meta.wakeRequested && meta.version > 0) return 'waking'
    if (meta.version === 0) return 'empty'
    // A container between a commit (or a backup) and its query process: questions are a moment away.
    return runtime && this.box.running ? 'waking' : 'asleep'
  }

  wakeProgress(state: CollectionState, runtime: Runtime | null): WakeProgress | null {
    if (state !== 'waking' && state !== 'waking_from_backup') return null
    const fromBackup = state === 'waking_from_backup'
    const step = !runtime || !this.box.running || runtime.phase === 'starting' ? 1 : runtime.phase === 'checking' ? 2 : 3
    const total = fromBackup ? SETTINGS.wakeFromBackupSeconds : SETTINGS.wakeSeconds
    const elapsed = runtime ? (clock.now() - Date.parse(runtime.startedAt)) / 1000 : 0
    return { step, fromBackup, etaSeconds: Math.max(5, Math.round(total - elapsed)) }
  }

  // ================================================================== documents and facts

  async currentState(meta?: Meta): Promise<AnswerState> {
    const m = meta ?? (await this.meta())
    return m.version ? ((await this.store.getState(m.version)) ?? EMPTY_STATE) : EMPTY_STATE
  }

  /** Documents of the current restore point, without those being removed for good. */
  async visibleDocuments(): Promise<DocRecord[]> {
    const meta = await this.meta()
    const removing = new Set(meta.removals.map((r) => r.documentId))
    return (await this.currentState(meta)).documents.filter((d) => !removing.has(d.documentId))
  }

  async documentText(documentId: string): Promise<DocumentText> {
    const doc = (await this.visibleDocuments()).find((d) => d.documentId === documentId)
    if (!doc) return fail('not_found', 'No such document.')
    const object = await this.env.FILES.get(doc.textKey)
    if (!object) return fail('not_found', "This document's text isn't available.")
    const stored = (await object.json()) as Omit<DocumentText, 'document'>
    return { document: publicDocument(doc), text: stored.text, pages: stored.pages, hidden: stored.hidden }
  }

  async facts(cursor: string | null): Promise<{ facts: Fact[]; next: string | null }> {
    const meta = await this.meta()
    const state = await this.currentState(meta)
    if (!state.factsKey) return { facts: [], next: null }
    const object = await this.env.FILES.get(state.factsKey)
    if (!object) return { facts: [], next: null }
    const all = ((await object.json()) as { facts: StoredFact[] }).facts ?? []
    const usable = factFilter(state, meta)
    const shown = all.filter(usable)
    const start = Math.max(0, Number(cursor) || 0)
    const page = shown.slice(start, start + 100).map(publicFact)
    return { facts: page, next: start + 100 < shown.length ? String(start + 100) : null }
  }

  // ================================================================== questions

  async search(body: { query?: unknown; topK?: unknown; threshold?: unknown }): Promise<SearchResult> {
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) return fail('bad_request', 'query must be a question or search words.')
    if (query.length > SETTINGS.maxQueryChars) return fail('bad_request', `query must be at most ${SETTINGS.maxQueryChars} characters.`)
    const topK = body.topK === undefined ? SETTINGS.defaultTopK : Number(body.topK)
    if (!Number.isInteger(topK) || topK < 1 || topK > SETTINGS.maxTopK) return fail('bad_request', `topK must be 1 to ${SETTINGS.maxTopK}.`)

    const meta = await this.updateMeta((m) => {
      m.lastQuestionAt = iso()
    })
    const runtime = (await this.store.getRuntime()) ?? null
    const active = meta.active ? ((await this.store.getImport(meta.active)) ?? null) : null
    const state = this.collectionState(meta, runtime, active)
    const empty = (status: SearchResult['status'], retryAfterSeconds: number | null): SearchResult => ({
      status,
      retryAfterSeconds,
      covered: false,
      passages: [],
      facts: [],
      version: meta.version,
    })
    if (state === 'held') return empty('held', Math.max(1, Math.round((Date.parse(meta.heldUntil!) - clock.now()) / 1000)))
    if (state === 'learning' || state === 'saving') return empty('learning', active ? Math.max(5, imports.etaSeconds(active)) : 30)
    if (state === 'going_back' || state === 'repairing') return empty('busy', SETTINGS.goBackSeconds)
    if (meta.version === 0) return empty('ok', null)
    if (state !== 'ready' || !runtime) {
      await this.requestWake()
      const progress = this.wakeProgress(state === 'waking_from_backup' ? state : 'waking', runtime)
      return empty('waking', progress?.etaSeconds ?? SETTINGS.wakeSeconds)
    }

    const current = await this.currentState(meta)
    try {
      const found = await this.box.querySearch<{ passages: SearchResult['passages']; facts: StoredFact[] }>({
        query,
        topK,
        filters: searchFilters(current, meta),
        // The harness's calibration (ASK-02) reads scores below the current threshold; test controls only.
        ...(testControls(this.env) && typeof body.threshold === 'number' ? { threshold: body.threshold } : {}),
      })
      await this.updateMeta((m) => {
        m.lastActivityAt = iso()
      })
      await this.scheduleSoon()
      const docs = new Map(current.documents.map((d) => [d.documentId, d]))
      const usable = factFilter(current, meta)
      const passages = (found.passages ?? [])
        .filter((p) => docs.get(p.documentId)?.active && !p.outdated)
        .map((p) => ({ ...p, documentName: docs.get(p.documentId)!.name, kind: docs.get(p.documentId)!.kind }))
      const facts = (found.facts ?? []).filter(usable).map(publicFact)
      return { status: 'ok', retryAfterSeconds: null, covered: passages.length > 0, passages, facts, version: meta.version }
    } catch (error) {
      await this.store.log('search-failed', { error: errorText(error) })
      if (!this.box.running) {
        await this.store.deleteRuntime()
        await this.requestWake()
        return empty('waking', SETTINGS.wakeSeconds)
      }
      return empty('busy', 5)
    }
  }

  async requestWake(): Promise<void> {
    const meta = await this.meta()
    if (meta.version === 0 || meta.deleting || isHeld(meta)) return
    const runtime = await this.store.getRuntime()
    if (runtime?.phase === 'ready' && this.box.running) {
      await this.updateMeta((m) => {
        m.lastActivityAt = iso()
      })
      return this.scheduleSoon()
    }
    if (!meta.wakeRequested) {
      await this.updateMeta((m) => {
        m.wakeRequested = true
      })
    }
    await this.state.storage.setAlarm(clock.now())
  }

  /** Makes sure the alarm runs soon, without postponing one that is due earlier. */
  async scheduleSoon(at = clock.now()): Promise<void> {
    const current = await this.state.storage.getAlarm()
    if (current === null || current > at) await this.state.storage.setAlarm(at)
  }

  // ================================================================== the alarm

  async alarm(): Promise<void> {
    const meta = await this.store.getMeta()
    if (!meta) return
    try {
      await this.drive()
      if (await this.store.getMeta()) await this.flushOutbox()
    } catch (error) {
      await this.store.log('drive-failed', { error: errorText(error) })
      if (await this.store.getMeta()) await this.state.storage.setAlarm(clock.now() + 10_000)
      return
    }
    if (await this.store.getMeta()) await this.schedule()
  }

  async drive(): Promise<void> {
    let meta = await this.meta()
    if (meta.deleting) return this.runDeletion()
    await this.noticeLostContainer()
    await this.ledgerTick()
    await this.flushOutbox()
    await this.housekeeping()
    // Exports need no container: they are built from the stored texts, facts and history.
    await exporter.runPending(this)
    meta = await this.meta()
    if (meta.heldUntil && !isHeld(meta)) {
      // The hold's time has passed: it ends by itself.
      await this.updateMeta((m) => {
        m.heldUntil = null
      })
      await this.store.log('hold-ended', { until: meta.heldUntil })
      meta = await this.meta()
    }
    if (isHeld(meta)) return this.whileHeld(meta)
    if (meta.op) return history.runOperation(this)
    if (meta.active) {
      const record = await this.store.getImport(meta.active)
      if (record) return imports.advance(this, record)
      await this.updateMeta((m) => {
        m.active = null
      })
    }
    if (meta.queue.length && (await imports.startNext(this))) return
    await this.lifecycle()
  }

  /**
   * The organization is on hold (the app's hard stop on awake hours): only a removal for good runs, wherever it waits
   * in the queue and whatever operation is pending; any other import stops, keeps nothing and waits; a container left
   * running is stopped; nothing else starts. Waking from a backup or a repair waits for the hold to end.
   */
  async whileHeld(meta: Meta): Promise<void> {
    await this.dropGoBackForHold()
    const active = meta.active ? await this.store.getImport(meta.active) : undefined
    if (active && active.kind !== 'remove') return imports.stopForHold(this, active)
    if (active) return imports.advance(this, active)
    const removal = meta.removals.find((r) => meta.queue.includes(r.importId))
    if (removal && (await imports.startNext(this, removal.importId))) return
    if (this.box.running || (await this.store.getRuntime())) {
      await this.box.destroy('the organization is on hold')
      await this.store.deleteRuntime()
      await this.chargeUsage(null)
      await this.store.log('stopped-for-hold')
    }
    if (meta.wakeRequested) {
      await this.updateMeta((m) => {
        m.wakeRequested = false
      })
    }
  }

  /**
   * A go back or undo asked for before the hold landed doesn't wait days to happen by surprise: it is dropped, as one
   * asked for during the hold is refused, and the app hears the collection is held.
   */
  async dropGoBackForHold(): Promise<void> {
    const meta = await this.meta()
    if (meta.op?.kind !== 'go_back') return
    const op = meta.op
    await this.updateMeta((m) => {
      m.op = null
    })
    await this.store.log('go-back-dropped-for-hold', { to: op.target, undo: op.undo })
    await this.event(`state:${meta.version}:held:${iso()}`, { type: 'state', state: 'held', version: meta.version })
  }

  /** Work that needs a container, refused while the organization is on hold: 429 `capacity` until it ends. */
  refuseWhileHeld(meta: Meta): void {
    if (!isHeld(meta)) return
    const seconds = Math.max(1, Math.ceil((Date.parse(meta.heldUntil!) - clock.now()) / 1000))
    fail('capacity', 'This organization has used its awake hours, so this waits until the hold ends.', seconds)
  }

  /** The next time the alarm must run. */
  async schedule(): Promise<void> {
    const meta = await this.meta()
    const now = clock.now()
    const runtime = await this.store.getRuntime()
    const times: number[] = [now + 24 * 60 * 60 * 1000]
    // While held only a removal runs: nothing else polls, and the alarm comes back when the hold ends (never in the
    // past, which would run it again at once, forever).
    const held = isHeld(meta)
    if (held) times.push(Date.parse(meta.heldUntil!))
    if (meta.op && !held) times.push(now + SETTINGS.wakePollMs)
    if (meta.active) {
      const record = await this.store.getImport(meta.active)
      if (record?.retryAt) times.push(record.retryAt)
      else times.push(record?.phase === 'running' ? now + SETTINGS.pollMs : now)
    }
    if (meta.queue.length && (!held || meta.removals.length)) times.push(now + SETTINGS.capacityRetryMs)
    if (meta.wakeRequested && !held) times.push(now + SETTINGS.wakePollMs)
    if (runtime && this.box.running) {
      // After a commit the query process starts again at once; while waking, poll.
      if (runtime.phase === 'busy' && !meta.active && !meta.op) times.push(now)
      else if (runtime.phase !== 'ready' && runtime.phase !== 'busy') times.push(now + SETTINGS.wakePollMs)
      // An idle container sleeps; one that learns or goes back is not idle.
      if (!meta.active && !meta.op) times.push(this.sleepAt(meta, runtime))
      const ledger = await this.store.getLedger()
      times.push(ledger.lastFlushAt + SETTINGS.usageFlushMs)
    } else if (meta.version > 0) {
      const next = nextWindowStart(meta.settings.keepReady, now)
      if (next) times.push(next)
    }
    const pendingWork =
      (await this.state.storage.get('pendingDeletes')) || (await this.state.storage.get('removalCleanup')) || (await this.state.storage.get('hiddenCleanup'))
    if ((await this.store.pendingEvents()).length || pendingWork) times.push(now + 30_000)
    for (const staged of await this.store.listStaged()) times.push(imports.stagedExpiry(staged))
    for (const record of await this.store.listExports()) {
      if (record.status.expiresAt) times.push(Date.parse(record.status.expiresAt))
      if (record.status.state === 'queued') times.push(now)
    }
    await this.state.storage.setAlarm(Math.max(now, Math.min(...times)))
  }

  /** When an awake container may sleep: awakeMinutes after the last question, wake or commit, or a window's end. */
  sleepAt(meta: Meta, runtime: Runtime | null = null): number {
    const last = Date.parse(meta.lastActivityAt ?? meta.lastQuestionAt ?? runtime?.startedAt ?? iso())
    const idle = last + meta.settings.awakeMinutes * 60 * 1000
    const window = windowAt(meta.settings.keepReady, clock.now())
    return window ? Math.max(idle, window.end) : idle
  }

  // ================================================================== the container's life for questions

  observeExit(): void {
    if (this.monitoring || !this.state.container) return
    this.monitoring = this.state.container
      .monitor()
      .catch((error: unknown) => console.warn('container stopped:', String(error)))
      .then(async () => {
        // React to the exit at once: an import is interrupted, questions wake it again.
        if (await this.store.getMeta()) await this.scheduleSoon()
      })
      .finally(() => {
        this.monitoring = undefined
      })
    this.state.waitUntil?.(this.monitoring)
  }

  /** Starts a container and waits for its control server. Never opens a database. */
  async startContainer(snapshot: SnapshotRecord | null, purpose: 'questions' | 'learning', fromBackup = false): Promise<Runtime> {
    const meta = await this.meta()
    await this.box.destroy('replaced')
    const instance = instances(this.env)[purpose]
    const started = clock.now()
    // Running time counts from the start: starting, checking and putting files back are paid for too.
    await this.chargeUsage(purpose === 'learning' || fromBackup ? 'learning' : await this.questionsUsageKind())
    this.box.start({
      snapshot: snapshot?.handle ?? null,
      instance,
      env: testControls(this.env) ? { KNOWLEDGE_TEST_CONTROLS: '1' } : undefined,
      labels: { collection: meta.collectionId, purpose },
    })
    this.observeExit()
    await this.box.setInactivityTimeout(SETTINGS.inactivityTimeoutMs)
    const health = await this.box.waitHealthy()
    const runtime: Runtime = {
      origin: meta.version,
      snapshotId: snapshot?.handle.id ?? null,
      dirty: false,
      instance,
      image: this.box.image,
      dataFormat: health.dataFormat,
      phase: purpose === 'learning' ? 'busy' : 'starting',
      phaseAt: iso(),
      startedAt: iso(started),
      checkJobId: null,
      queryStarted: false,
      verifyFailures: (await this.state.storage.get<number>('verifyFailures')) ?? 0,
      fromBackup,
    }
    await this.store.putRuntime(runtime)
    if (snapshot) {
      snapshot.lastRestoredAt = iso()
      await this.store.putSnapshot(snapshot)
    }
    await this.store.log('container-started', { purpose, instance, from: snapshot?.handle.id ?? 'image', ms: clock.now() - started })
    return runtime
  }

  /** The snapshot the current restore point runs on, if it can still be started. */
  async currentSnapshot(meta: Meta): Promise<{ snapshot: SnapshotRecord | null; unusable: 'expired' | 'engine_changed' | 'damaged' | null }> {
    if (meta.version === 0) return { snapshot: null, unusable: null }
    const point = await this.store.getPoint(meta.version)
    const snapshot = point?.snapshotId ? ((await this.store.getSnapshot(point.snapshotId)) ?? null) : null
    if (!snapshot) return { snapshot: null, unusable: 'expired' }
    if (snapshot.damaged) return { snapshot, unusable: 'damaged' }
    return { snapshot, unusable: history.snapshotProblem(snapshot, this.box.image) }
  }

  /** Wakes the collection for questions, keeps it awake, and lets it sleep. One step per alarm while waking. */
  async lifecycle(): Promise<void> {
    const meta = await this.meta()
    let runtime = (await this.store.getRuntime()) ?? null
    const running = this.box.running
    const now = clock.now()
    const inWindow = windowAt(meta.settings.keepReady, now) !== null
    const awakeUntil = runtime && running ? this.sleepAt(meta, runtime) : null
    const wantAwake = meta.version > 0 && (meta.wakeRequested || inWindow || (awakeUntil !== null && now < awakeUntil))

    if (!wantAwake) {
      if (running || runtime) await this.goToSleep()
      else if (meta.backupDue && meta.lastRestorePointAt && now - Date.parse(meta.lastRestorePointAt) > 6 * 60 * 60 * 1000) {
        await backup.coldBackup(this)
      }
      return
    }

    const current = await this.currentSnapshot(meta)
    if (!running || !runtime || runtime.dirty || runtime.snapshotId !== (current.snapshot?.handle.id ?? null)) {
      if (current.unusable) {
        // A removal for good or a re-learning waiting in the queue brings the files back itself: questions wait for
        // it, and no container starts meanwhile.
        if (meta.removals.length) return
        for (const id of [...meta.queue, ...(meta.active ? [meta.active] : [])]) {
          if ((await this.store.getImport(id))?.kind === 'relearn') return
        }
        await this.updateMeta((m) => {
          m.op = { kind: 'from_backup', reason: current.unusable === 'damaged' ? 'repair' : current.unusable!, startedAt: iso(), restartedAfterFailure: false }
        })
        await this.store.log('snapshot-unusable', { version: meta.version, reason: current.unusable })
        return
      }
      try {
        runtime = await this.startContainer(current.snapshot, 'questions')
      } catch (error) {
        await this.store.log('start-failed', { error: errorText(error) })
        await this.box.destroy('failed to start')
        await this.store.deleteRuntime()
        // A snapshot that fails to start time after time is treated as gone: the collection comes back from its backup.
        if (current.snapshot) {
          const key = `startFailures:${current.snapshot.handle.id}`
          const failures = ((await this.state.storage.get<number>(key)) ?? 0) + 1
          await this.state.storage.put(key, failures)
          if (failures >= START_FAILURES_BEFORE_EXPIRED) {
            current.snapshot.expired = true
            await this.store.putSnapshot(current.snapshot)
            await this.state.storage.delete(key)
          }
        }
        return
      }
      if (current.snapshot) await this.state.storage.delete(`startFailures:${current.snapshot.handle.id}`)
      return this.beginCheck(runtime)
    }

    // A wake that doesn't reach "ready" in time is stopped; the next alarm starts it again.
    if (runtime.phase !== 'ready' && runtime.phase !== 'busy' && clock.now() - Date.parse(runtime.phaseAt ?? runtime.startedAt) > SETTINGS.wakeTimeoutMs) {
      const timeouts = ((await this.state.storage.get<number>('wakeTimeouts')) ?? 0) + 1
      await this.store.log('wake-timed-out', { phase: runtime.phase, timeouts })
      await this.box.destroy('the wake took too long')
      await this.store.deleteRuntime()
      await this.chargeUsage(null)
      if (timeouts < WAKE_TIMEOUTS_BEFORE_GIVING_UP) {
        await this.state.storage.put('wakeTimeouts', timeouts)
        return
      }
      // Waking keeps failing: stop trying (and paying) until someone asks again.
      await this.state.storage.delete('wakeTimeouts')
      await this.updateMeta((m) => {
        m.wakeRequested = false
        m.lastActivityAt = null
        m.lastQuestionAt = null
      })
      await this.store.log('wake-gave-up', { timeouts })
      await this.event(`state:${meta.version}:asleep:wake-gave-up:${iso()}`, { type: 'state', state: 'asleep', version: meta.version })
      return
    }
    if (runtime.phase === 'starting') return this.beginCheck(runtime)
    if (runtime.phase === 'checking') return this.continueCheck(runtime, current.snapshot)
    if (runtime.phase === 'busy') {
      runtime.phase = 'opening'
      runtime.phaseAt = iso()
      await this.store.putRuntime(runtime)
    }
    if (runtime.phase === 'opening') return this.continueOpen(runtime)
  }

  /** Step 2: load the models while the checksum check runs. Nothing opens the databases yet. Safe to repeat. */
  async beginCheck(runtime: Runtime): Promise<void> {
    await this.box.queryStart()
    runtime.queryStarted = true
    await this.store.putRuntime(runtime)
    const check = await this.box.startJob('manifest')
    runtime.phase = 'checking'
    runtime.phaseAt = iso()
    runtime.checkJobId = check.id
    await this.store.putRuntime(runtime)
    await this.store.log('checking', { job: check.id })
  }

  async continueCheck(runtime: Runtime, snapshot: SnapshotRecord | null): Promise<void> {
    const job = await this.box.getJob(runtime.checkJobId ?? '')
    if (job.state === 'running') return
    // The models loaded while the check ran; nothing may have opened a file under /data meanwhile (ASK-06).
    const query = await this.box.queryStatus()
    if (query.dataFilesOpen > 0) {
      await this.store.log('query-opened-early', { dataFilesOpen: query.dataFilesOpen })
      await this.box.queryStop()
      runtime.queryStarted = false
    }
    const expected = snapshot ? await this.store.getManifest(snapshot.handle.id) : undefined
    const match = job.state === 'succeeded' && (!expected || job.result?.digest === expected.digest)
    if (match) {
      runtime.phase = 'opening'
      runtime.phaseAt = iso()
      await this.store.putRuntime(runtime)
      await this.store.log('checksum-ok', { snapshot: snapshot?.handle.id ?? null, files: job.result?.files })
      return this.continueOpen(runtime)
    }
    await this.integrityFailure(runtime, job.state === 'succeeded' ? 'mismatch' : 'check failed')
  }

  /** A failed checksum check: retry once from the same snapshot, then repair from the previous point or the backup. */
  async integrityFailure(runtime: Runtime, why: string): Promise<void> {
    const meta = await this.meta()
    const failures = runtime.verifyFailures + 1
    await this.store.log('checksum-mismatch', { version: meta.version, failures, why })
    await this.box.destroy('checksum mismatch')
    await this.store.deleteRuntime()
    if (failures >= 2) {
      await this.state.storage.delete('verifyFailures')
      if (runtime.snapshotId) await this.markDamaged(runtime.snapshotId)
      await this.updateMeta((m) => {
        m.op = { kind: 'repair', failedVersion: m.version, startedAt: iso(), tried: [] }
        m.repairNote = null
      })
      await this.event(`state:${meta.version}:repairing:${iso()}`, { type: 'state', state: 'repairing', version: meta.version })
      return
    }
    // Remember the failure for the retry.
    await this.state.storage.put('verifyFailures', failures)
  }

  /**
   * A snapshot that failed its integrity check twice is never opened again: every restore point that uses it is
   * not restorable ('damaged'), so History stops offering it and going back to it answers 409.
   */
  async markDamaged(snapshotId: string): Promise<void> {
    const snapshot = await this.store.getSnapshot(snapshotId)
    if (!snapshot || snapshot.damaged) return
    snapshot.damaged = true
    await this.store.putSnapshot(snapshot)
    await this.store.log('snapshot-damaged', { snapshot: snapshotId })
  }

  async continueOpen(runtime: Runtime): Promise<void> {
    if (!runtime.queryStarted) {
      await this.box.queryStart()
      runtime.queryStarted = true
      await this.store.putRuntime(runtime)
    }
    const status = await this.box.queryStatus()
    if (status.state === 'failed') {
      await this.store.log('query-failed', { error: status.error })
      await this.box.queryStop()
      runtime.queryStarted = false
      await this.store.putRuntime(runtime)
      return
    }
    if (status.state === 'loading') return
    if (status.state === 'loaded') {
      await this.box.queryOpen()
      await this.store.log('query-open-requested')
      return
    }
    if (status.state === 'ready') {
      runtime.phase = 'ready'
      await this.store.putRuntime(runtime)
      await this.state.storage.delete(['verifyFailures', 'wakeTimeouts'])
      const meta = await this.updateMeta((m) => {
        m.wakeRequested = false
        m.lastActivityAt = iso()
      })
      await this.store.log('ready', { openedAt: status.openedAt, wakeMs: clock.now() - Date.parse(runtime.startedAt) })
      await this.event(`state:${meta.version}:ready:${runtime.startedAt}`, { type: 'state', state: 'ready', version: meta.version })
    }
  }

  async goToSleep(): Promise<void> {
    const meta = await this.meta()
    const runtime = await this.store.getRuntime()
    if (this.box.running && runtime && !runtime.dirty && meta.backupDue && runtime.snapshotId) {
      try {
        if (runtime.queryStarted) await this.box.queryStop()
        await backup.run(this, runtime)
      } catch (error) {
        await this.store.log('backup-failed', { error: errorText(error) })
      }
    }
    await this.box.destroy('asleep')
    await this.store.deleteRuntime()
    await this.ledgerTick()
    await this.store.log('asleep')
    if (runtime) await this.event(`state:${meta.version}:asleep:${runtime.startedAt}`, { type: 'state', state: 'asleep', version: meta.version })
  }

  /** The container stopped on its own (a crash, a restart of the host): forget it; an import is interrupted. */
  async noticeLostContainer(): Promise<void> {
    const runtime = await this.store.getRuntime()
    if (!runtime || this.box.running) return
    await this.store.deleteRuntime()
    await this.store.log('container-lost', { phase: runtime.phase })
  }

  // ================================================================== running-time ledger

  /** What the container's time counts as now. */
  async usageKind(): Promise<UsageKind | null> {
    const runtime = await this.store.getRuntime()
    if (!runtime || !this.box.running) return null
    const meta = await this.meta()
    if (meta.active || meta.op?.kind === 'from_backup') return 'learning'
    return this.questionsUsageKind()
  }

  /** A container for questions: kept ready (a window, nobody asking) or awake. */
  async questionsUsageKind(): Promise<UsageKind> {
    const meta = await this.meta()
    const now = clock.now()
    const lastQuestion = meta.lastQuestionAt ? Date.parse(meta.lastQuestionAt) : 0
    const window = windowAt(meta.settings.keepReady, now)
    if (window && now - lastQuestion > meta.settings.awakeMinutes * 60 * 1000) return 'ready'
    return 'awake'
  }

  async ledgerTick(): Promise<void> {
    const kind = await this.usageKind()
    await this.chargeUsage(kind)
  }

  /** Closes the running segment, starts one of `kind`, and writes whole seconds to the outbox once a minute. */
  async chargeUsage(kind: UsageKind | null, extra?: { kind: UsageKind; ms: number }): Promise<void> {
    const meta = await this.meta()
    const ledger = await this.store.getLedger()
    const now = clock.now()
    const previous = ledger.kind
    if (ledger.kind && ledger.since !== null) ledger.totals[ledger.kind] = (ledger.totals[ledger.kind] ?? 0) + (now - ledger.since)
    if (extra) ledger.totals[extra.kind] = (ledger.totals[extra.kind] ?? 0) + extra.ms
    ledger.kind = kind
    ledger.since = kind ? now : null
    const events: PendingEvent[] = []
    const changed = kind !== previous
    if (now - ledger.lastFlushAt >= SETTINGS.usageFlushMs || changed || extra) {
      for (const [k, ms] of Object.entries(ledger.totals) as [UsageKind, number][]) {
        const seconds = Math.floor(ms / 1000)
        if (seconds < 1) continue
        ledger.totals[k] = ms - seconds * 1000
        events.push({
          key: `usage:${meta.org}:${meta.collectionId}:${k}:${now}`,
          event: { at: iso(now), org: meta.org, collectionId: meta.collectionId, type: 'usage', kind: k, seconds },
        })
      }
      ledger.lastFlushAt = now
    }
    await this.store.addEvents(events)
    await this.store.putLedger(ledger)
  }

  // ================================================================== the outbox

  /** Adds an event; its de-duplication key is the collection's own, since the outbox serves every collection. */
  async event(key: string, event: Record<string, unknown>): Promise<void> {
    const meta = await this.meta()
    await this.store.addEvents([{ key: `${meta.org}:${meta.collectionId}:${key}`, event: { at: iso(), org: meta.org, collectionId: meta.collectionId, ...event } as PendingEvent['event'] }])
  }

  /** Writes pending events to the Outbox. They were committed first, so a failure here is retried later. */
  async flushOutbox(): Promise<void> {
    const pending = await this.store.pendingEvents()
    if (!pending.length) return
    try {
      for (let i = 0; i < pending.length; i += 50) {
        const batch = pending.slice(i, i + 50)
        await callObject(this.env.OUTBOX, OUTBOX_NAME, '/append', { body: { events: batch.map(([, e]) => e) } })
        await this.state.storage.delete(batch.map(([key]) => key))
      }
    } catch (error) {
      console.warn('outbox not reachable; will retry', errorText(error))
    }
  }

  // ================================================================== housekeeping

  async housekeeping(): Promise<void> {
    const meta = await this.meta()
    const now = clock.now()
    // Staged files nobody imported are deleted after a day, or after the date a waiting import keeps them until.
    const queued = new Set<string>()
    for (const id of [...meta.queue, ...(meta.active ? [meta.active] : [])]) {
      const record = await this.store.getImport(id)
      for (const f of record?.files ?? []) queued.add(f.fileId)
    }
    const old = (await this.store.listStaged()).filter((s) => !queued.has(s.fileId) && now >= imports.stagedExpiry(s))
    if (old.length) {
      // The records go first, with nothing awaited in between: a keep request that comes later finds the file gone
      // (and says so) instead of keeping a file whose original is about to be deleted.
      await this.store.deleteStaged(old.map((s) => s.fileId))
      await imports.deleteLater(this, old.map((s) => imports.inboxKey(meta, s.fileId)))
    } else {
      await imports.deleteLater(this, [])
    }
    await imports.retryRemovalCleanup(this)
    await imports.retryHiddenCleanup(this)
    await exporter.expire(this)
  }

  async releaseCapacity(record: ImportRecord): Promise<void> {
    const meta = await this.meta()
    try {
      await callObject(this.env.CAPACITY, CAPACITY_NAME, '/release', {
        body: { org: meta.org, collectionId: meta.collectionId, importId: record.status.importId, small: record.small },
      })
    } catch (error) {
      await this.store.log('capacity-release-failed', { error: errorText(error) })
    }
  }

  // ================================================================== delete

  async startDeletion(): Promise<{ state: 'deleting' }> {
    const meta = await this.meta()
    if (!meta.deleting) {
      await this.updateMeta((m) => {
        m.deleting = true
        m.deleteStartedAt = iso()
        m.wakeRequested = false
        m.op = null
      })
      // Refuse new work and cancel what was waiting: imports, exports, retries.
      for (const id of [...meta.queue, ...(meta.active ? [meta.active] : [])]) {
        const record = await this.store.getImport(id)
        if (!record) continue
        record.status.state = 'cancelled'
        record.status.finishedAt = iso()
        record.phase = 'done'
        record.retryAt = null
        record.notes = record.notes.map((n) => ({ ...n, text: '' }))
        await this.store.putImport(record)
      }
      for (const record of await this.store.listExports()) {
        if (record.status.state === 'queued' || record.status.state === 'running') {
          record.status.state = 'failed'
          await this.store.putExport(record)
        }
      }
      await this.store.log('deleting')
      await this.event(`state:${meta.version}:deleting`, { type: 'state', state: 'deleting', version: meta.version })
      await callObject(this.env.REGISTRY, REGISTRY_NAME, '/state', { body: { org: meta.org, collectionId: meta.collectionId, state: 'deleting' } }).catch(
        () => undefined,
      )
    }
    await this.state.storage.setAlarm(clock.now())
    return { state: 'deleting' }
  }

  /** Deletes everything the collection has: the container, R2 prefixes (inbox, text, exports, every backup) and storage. */
  async runDeletion(): Promise<void> {
    const meta = await this.meta()
    await this.box.destroy('collection deleted')
    for (const id of [...meta.queue, ...(meta.active ? [meta.active] : [])]) {
      const record = await this.store.getImport(id)
      if (record) await this.releaseCapacity(record)
    }
    await this.chargeUsage(null)
    const prefixes: [R2Bucket, string][] = [
      [this.env.FILES, `inbox/${meta.org}/${meta.collectionId}/`],
      [this.env.FILES, `text/${meta.org}/${meta.collectionId}/`],
      [this.env.FILES, `exports/${meta.org}/${meta.collectionId}/`],
      [this.env.BACKUPS, `backups/${meta.org}/${meta.collectionId}/`],
    ]
    for (const [bucket, prefix] of prefixes) await deletePrefix(bucket, prefix)
    for (const [bucket, prefix] of prefixes) {
      if ((await bucket.list({ prefix, limit: 1 })).objects.length) throw new Error(`objects remain under a deleted collection's prefix`)
    }
    // The last events, then the registry, then this object's own storage. Snapshots can't be deleted: with no
    // handle left they can't be opened, and they expire within 30 days.
    await this.event('deleted', { type: 'deleted' })
    const pending = await this.store.pendingEvents()
    await callObject(this.env.OUTBOX, OUTBOX_NAME, '/append', { body: { events: pending.map(([, e]) => e) } })
    await callObject(this.env.REGISTRY, REGISTRY_NAME, '/state', { body: { org: meta.org, collectionId: meta.collectionId, state: 'deleted' } })
    await this.state.storage.deleteAlarm()
    await this.state.storage.deleteAll()
    console.log(JSON.stringify({ event: 'deleted' }))
  }

  // ================================================================== test controls (ENGINE_TEST_CONTROLS=1 only)

  async testState(): Promise<unknown> {
    if (!testControls(this.env)) return fail('not_found', 'No such route.')
    return {
      meta: await this.meta(),
      runtime: (await this.store.getRuntime()) ?? null,
      running: this.box.running,
      staged: (await this.store.listStaged()).length,
      imports: (await this.store.listImports()).map((r) => ({ ...r.status, kind: r.kind, phase: r.phase })),
      restorePoints: await this.store.listPoints(),
      snapshots: (await this.store.listSnapshots()).map((s) => ({ ...s.handle, image: s.image, createdAt: s.createdAt, expired: s.expired })),
      log: await this.store.readLog(),
    }
  }

  async testControl(action: string, body: Record<string, unknown>): Promise<unknown> {
    if (!testControls(this.env)) return fail('not_found', 'No such route.')
    const meta = await this.meta()
    switch (action) {
      case 'destroy-container': {
        const was = await this.box.destroy('destroyed by the test harness')
        await this.scheduleSoon()
        return { destroyed: was }
      }
      case 'drop-snapshot': {
        const { snapshot } = await this.currentSnapshot(meta)
        if (!snapshot) return fail('bad_request', 'Nothing learned yet.')
        snapshot.expired = true
        await this.store.putSnapshot(snapshot)
        await this.box.destroy('snapshot dropped by the test harness')
        await this.store.deleteRuntime()
        return { dropped: snapshot.handle.id }
      }
      case 'corrupt-manifest': {
        const { snapshot } = await this.currentSnapshot(meta)
        const manifest = snapshot ? await this.store.getManifest(snapshot.handle.id) : undefined
        if (!snapshot || !manifest) return fail('bad_request', 'Nothing learned yet.')
        manifest.digest = `corrupted-${manifest.digest}`
        await this.store.putManifest(snapshot.handle.id, manifest)
        await this.box.destroy('manifest corrupted by the test harness')
        await this.store.deleteRuntime()
        return { corrupted: snapshot.handle.id }
      }
      case 'image-changed': {
        for (const snapshot of await this.store.listSnapshots()) {
          snapshot.image = `${snapshot.image}+before-test-change`
          await this.store.putSnapshot(snapshot)
        }
        await this.box.destroy('engine change simulated by the test harness')
        await this.store.deleteRuntime()
        return { changed: true }
      }
      case 'fail-next-import': {
        await this.state.storage.put('testNextImport', {
          crashFileId: typeof body.crashFileId === 'string' ? body.crashFileId : undefined,
          detectorError: body.detectorError === true,
        })
        return { armed: true }
      }
      case 'sleep':
        await this.goToSleep()
        return { asleep: true }
      case 'backup': {
        await this.updateMeta((m) => {
          m.backupDue = true
        })
        const runtime = await this.store.getRuntime()
        if (runtime && this.box.running) await this.goToSleep()
        else await backup.coldBackup(this)
        return { lastBackupAt: (await this.meta()).lastBackupAt }
      }
      case 'grep':
        return backup.grep(this, Array.isArray(body.values) ? body.values.map(String) : [])
    }
    return fail('not_found', 'No such test control.')
  }
}

// ==================================================================== helpers

interface PendingHold {
  org: string
  until: string | null
  seq: number
  version: number
}

export const isHeld = (meta: Meta): boolean => !!meta.heldUntil && Date.parse(meta.heldUntil) > clock.now()

function versionParam(value: string): number {
  const version = Number(value)
  if (!Number.isInteger(version) || version < 1) return fail('bad_request', 'version must be a restore point number.')
  return version
}

export function publicDocument(doc: DocRecord): DocumentInfo {
  const { documentId, kind, name, type, bytes, textBytes, pages, sha256, active, addedAt, version } = doc
  return { documentId, kind, name, type, bytes, textBytes, pages, sha256, active, hiddenValues: doc.hiddenCount ?? 0, addedAt, version }
}

/** A fact as the contract shows it: the stored passage hash becomes passageTextHash. */
export function publicFact(fact: StoredFact): Fact {
  const { factId, sentence, documentId, passageId, sourceSentence } = fact
  return { factId, sentence, documentId, passageId, passageTextHash: fact.textHash ?? '', sourceSentence }
}

export type StoredFact = Omit<Fact, 'passageTextHash'> & { textHash?: string }

/** What the query process leaves out and how it ranks notes (container/rank.py). */
export function searchFilters(state: AnswerState, meta: Meta) {
  const removing = new Set(meta.removals.map((r) => r.documentId))
  const notes = new Map<string, string[][]>()
  for (const mark of state.marks) {
    const refs = notes.get(mark.noteDocumentId) ?? []
    refs.push([mark.documentId, mark.textHash])
    notes.set(mark.noteDocumentId, refs)
  }
  return {
    inactive: state.documents.filter((d) => !d.active || removing.has(d.documentId)).map((d) => d.documentId).concat([...removing]),
    outdated: state.marks.map((m) => [m.documentId, m.textHash]),
    corrections: [...notes.entries()].map(([noteDocumentId, refs]) => ({ noteDocumentId, refs })),
  }
}

/** Facts from documents in use whose source passage isn't outdated. */
export function factFilter(state: AnswerState, meta: Meta): (fact: StoredFact) => boolean {
  const removing = new Set(meta.removals.map((r) => r.documentId))
  const active = new Set(state.documents.filter((d) => d.active && !removing.has(d.documentId)).map((d) => d.documentId))
  const outdated = new Set(state.marks.map((m) => `${m.documentId}:${m.textHash}`))
  return (fact) => active.has(fact.documentId) && !(fact.textHash && outdated.has(`${fact.documentId}:${fact.textHash}`))
}

export function validateSettings(value: unknown, base: CollectionSettings): CollectionSettings {
  if (value === undefined) return base
  if (!value || typeof value !== 'object') return fail('bad_request', 'settings must be an object.')
  const s = value as Partial<CollectionSettings>
  const hiding = s.hiding === undefined ? base.hiding : validateHiding(s.hiding)
  const keepReady = s.keepReady === undefined ? base.keepReady : validateKeepReady(s.keepReady)
  if (typeof keepReady === 'string') return fail('bad_request', keepReady)
  const awakeMinutes = s.awakeMinutes === undefined ? base.awakeMinutes : Number(s.awakeMinutes)
  if (!Number.isInteger(awakeMinutes) || awakeMinutes < 1 || awakeMinutes > 60) return fail('bad_request', 'awakeMinutes must be 1 to 60.')
  const backupDays = s.backupDays === undefined ? (base.backupDays ?? DEFAULT_SETTINGS.backupDays) : Number(s.backupDays)
  if (!Number.isInteger(backupDays) || backupDays < 1 || backupDays > 3650) return fail('bad_request', 'backupDays must be 1 to 3650.')
  const revision = s.revision === undefined ? (base.revision ?? 0) : Number(s.revision)
  if (!Number.isInteger(revision) || revision < 0) return fail('bad_request', 'revision must be a whole number, 0 or more.')
  return { hiding, keepReady, awakeMinutes, backupDays, revision }
}

function validateHiding(value: unknown): HidingRules {
  if (!value || typeof value !== 'object') return fail('bad_request', 'settings.hiding must be an object.')
  const h = value as Partial<HidingRules>
  const flag = (v: unknown, name: string) => (typeof v === 'boolean' ? v : fail('bad_request', `settings.hiding.${name} must be true or false.`))
  const words = h.words ?? []
  if (!Array.isArray(words) || words.length > 200 || words.some((w) => typeof w !== 'string' || !w.trim() || w.length > 100)) {
    return fail('bad_request', 'settings.hiding.words must be at most 200 words or phrases of up to 100 characters.')
  }
  return {
    emails: flag(h.emails, 'emails'),
    phones: flag(h.phones, 'phones'),
    cards: flag(h.cards, 'cards'),
    apiKeys: flag(h.apiKeys, 'apiKeys'),
    secrets: flag(h.secrets, 'secrets'),
    words: [...new Set(words.map((w) => w.trim()))],
  }
}

/** True when the new rules hide something the old ones didn't. */
export function stricterHiding(before: HidingRules, after: HidingRules): boolean {
  const flags: (keyof Omit<HidingRules, 'words'>)[] = ['emails', 'phones', 'cards', 'apiKeys', 'secrets']
  if (flags.some((f) => after[f] && !before[f])) return true
  const old = new Set(before.words.map((w) => w.toLowerCase()))
  return after.words.some((w) => !old.has(w.toLowerCase()))
}

export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0
  for (;;) {
    const listed = await bucket.list({ prefix, limit: 1000 })
    if (!listed.objects.length) return deleted
    await bucket.delete(listed.objects.map((o) => o.key))
    deleted += listed.objects.length
  }
}

export type { RestorePointRecord }
