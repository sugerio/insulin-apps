import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { canChange } from '../../components/CollectionParts.tsx'
import { ActionError, Badge, Banner, ErrorState, Loading, Note } from '../../components/Feedback.tsx'
import { api, collectionPath } from '../../lib/api.ts'
import { formatWhen, formatWhenInline, notRestorableReason, plural } from '../../lib/format.ts'
import type { CollectionDetail, GoBackPreview, RestorePoint } from '../../lib/types.ts'
import { useResource } from '../../lib/useResource.ts'
import type { TabProps } from './CollectionPage.tsx'

// History (design J8, HIS-01, HIS-06, HIS-07): every change is a restore point. Going back explains first what the
// collection will know, which files are set aside (not deleted) and which corrections are undone; it can be undone.
// A version that held a file removed for good, or that has expired, can't be brought back, and says why. Going back
// never changes who has access.

const WENT_BACK = /^Went back to version (\d+)$/

/** A restore point's summary in plain words: "Went back to version 3" names that version's time instead. */
export function describeRestorePoint(point: RestorePoint, all: RestorePoint[]): string {
  const back = WENT_BACK.exec(point.summary)
  if (back) {
    const to = all.find((candidate) => candidate.version === Number(back[1]))
    return to ? `Went back to the version from ${formatWhenInline(to.createdAt)}` : 'Went back to an earlier version'
  }
  return point.summary
}

export function HistoryTab({ detail, reload }: TabProps) {
  const { collection } = detail
  const editor = canChange(detail.role) && detail.can.change
  const history = useResource<{ restorePoints: RestorePoint[] }>(collectionPath(collection.id, '/history'))
  const [asking, setAsking] = useState<RestorePoint | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // Going back (or undoing it) is accepted at once and finishes later: until then the collection is going back, and
  // History is refreshed, and the change announced, when it has finished.
  const [pending, setPending] = useState<string | null>(null)
  // A go back the awake-hours stop cut short (the engine dropped it when it held the organization).
  const [stopped, setStopped] = useState(false)
  const state = pending ? 'going_back' : detail.engine?.state ?? collection.state
  const points = history.data?.restorePoints ?? []
  const { reload: reloadHistory } = history

  async function finished(done: string) {
    setPending(null)
    setNotice(done)
    await reloadHistory()
    await reload()
  }

  /** After the engine accepted a go back or an undo: announced now if it finished, or once it has. */
  async function accepted(status: { state: string } | undefined, done: string) {
    if (status?.state === 'going_back') setPending(done)
    else await finished(done)
  }

  useEffect(() => {
    if (!pending) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const body = await api.get<CollectionDetail>(collectionPath(collection.id))
        if (!live) return
        if (body.engine?.state === 'held') {
          setPending(null)
          setStopped(true)
          await reloadHistory()
          await reload()
          return
        }
        if (body.engine?.state !== 'going_back') {
          await finished(pending)
          return
        }
      } catch {
        // Not known yet: asked again in a moment.
      }
      if (live) timer = setTimeout(() => void check(), 1500)
    }
    timer = setTimeout(() => void check(), 1000)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // Followed while this go back is pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, collection.id])

  async function undo() {
    setBusy(true)
    setError(null)
    setNotice(null)
    setStopped(false)
    try {
      const body = await api.create<{ collection?: { state: string } }>(collectionPath(collection.id, '/history/undo'))
      await accepted(body.collection, 'Undone. Everything is back as it was before you went back.')
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Every change saves a restore point automatically; changes made within 5 minutes of each other share one. Going back never deletes files: anything added later is set aside, so you can use it again. Going back never changes who has access.
      </p>
      {state === 'going_back' ? <Banner kind="info" title="Going back to an earlier version.">About a minute. Questions wait for a moment. This page says when it has finished.</Banner> : null}
      {stopped ? (
        <Banner kind="warn">Going back was stopped: Knowledge has stopped until the 1st, because your organization has used this month's awake hours. Nothing changed; go back again once it runs again.</Banner>
      ) : state === 'held' ? (
        <Banner kind="warn">Knowledge has stopped until the 1st: your organization has used this month's awake hours. Going back and undo wait until then; everything is kept.</Banner>
      ) : null}
      {notice ? <Banner kind="ok">{notice}</Banner> : null}
      <ActionError error={error} />
      {history.loading ? <Loading /> : history.error ? <ErrorState error={history.error} onRetry={() => void history.reload()} /> : points.length === 0 ? (
        <Note>No changes yet. The first files, web pages or notes it learns make its first restore point.</Note>
      ) : (
        <ol className="flex flex-col gap-0 border-l pl-5" aria-label="Restore points">
          {points.map((point) => (
            <li key={point.version} className="relative pb-5" data-restore-point={point.version}>
              <span className={`absolute top-1.5 -left-[25px] size-2.5 rounded-full ${point.current ? 'bg-primary' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
              <p className="text-xs text-muted-foreground">{formatWhen(point.createdAt)} · restore point</p>
              <p className="flex flex-wrap items-center gap-2 font-medium [overflow-wrap:anywhere]">
                {describeRestorePoint(point, points)}
                {point.current ? <Badge tone="green">Now</Badge> : null}
              </p>
              <p className="text-xs text-muted-foreground">{plural(point.documents, 'document')}</p>
              {!point.restorable && !point.current ? <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">{notRestorableReason(point.reason)}</p> : null}
              {editor && point.current && WENT_BACK.test(point.summary) && state !== 'going_back' && state !== 'held' ? (
                <Button type="button" variant="outline" size="sm" className="mt-2" disabled={busy} onClick={() => void undo()}>Undo</Button>
              ) : null}
              {editor && !point.current && point.restorable && state !== 'going_back' && state !== 'held' ? (
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { setNotice(null); setStopped(false); setAsking(point) }}>Go back to this version</Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <Note>Restore points last 30 days and come back in about a minute. Daily backups are kept {plural(detail.backupDays ?? 30, 'day')}, and the latest one as long as the collection exists, so it is never lost.</Note>
      {asking ? (
        <GoBackDialog collectionId={collection.id} collectionName={collection.name} point={asking} onClose={() => setAsking(null)}
          onDone={(status) => {
            const done = `${collection.name} now answers from the version of ${formatWhenInline(asking.createdAt)}. You can undo it here.`
            setAsking(null)
            setNotice(null)
            void accepted(status, done)
          }} />
      ) : null}
    </div>
  )
}

function GoBackDialog({ collectionId, collectionName, point, onClose, onDone }: { collectionId: string; collectionName: string; point: RestorePoint; onClose: () => void; onDone: (status: { state: string } | undefined) => void }) {
  const preview = useResource<{ preview: GoBackPreview }>(collectionPath(collectionId, `/history/${point.version}/preview`))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function goBack() {
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ collection?: { state: string } }>(collectionPath(collectionId, `/history/${point.version}/go-back`))
      onDone(body.collection)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const view = preview.data?.preview
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <DialogHeader>
          <DialogTitle>Go back to the version from {formatWhenInline(point.createdAt)}?</DialogTitle>
          <DialogDescription>Here is what changes. Nothing is deleted, and you can undo it.</DialogDescription>
        </DialogHeader>
        {/* A long list of files scrolls inside the dialog, so its buttons stay on a phone's screen. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        {preview.loading ? <Loading /> : preview.error || !view ? <ErrorState error={preview.error} onRetry={() => void preview.reload()} /> : !view.restorable ? (
          <Banner kind="warn">{notRestorableReason(view.reason)}</Banner>
        ) : (
          <ul className="list-disc pl-5 text-sm" data-go-back-preview="">
            <li>{collectionName} will answer from what it knew then: {plural(view.documents, 'document')}.</li>
            {view.setAside.length ? (
              <li>{plural(view.setAside.length, 'file')} added later will be set aside, not deleted: {view.setAside.map((document) => `“${document.name}”`).join(', ')}. You can use {view.setAside.length === 1 ? 'it' : 'them'} again from Sources.</li>
            ) : null}
            {view.correctionsUndone ? <li>{plural(view.correctionsUndone, 'later correction')} will be undone too.</li> : null}
            <li>It takes about a minute; questions wait for a moment. You can undo it from History.</li>
            <li>Who has access doesn't change.</li>
          </ul>
        )}
        </div>
        <ActionError error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={busy || !view?.restorable} onClick={() => void goBack()}>{busy ? 'Going back…' : 'Go back'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
