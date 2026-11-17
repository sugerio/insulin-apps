import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx'
import { AddSources } from '../../components/AddSources.tsx'
import { canChange } from '../../components/CollectionParts.tsx'
import { ActionError, Badge, Banner, ErrorState, Loading, Note } from '../../components/Feedback.tsx'
import { ImportProgress, useImportWatch } from '../../components/ImportProgress.tsx'
import { Card } from '../../components/Page.tsx'
import { api, collectionPath } from '../../lib/api.ts'
import { formatBytes, formatDay, formatResetDay, formatWhen, plural, sourceKind } from '../../lib/format.ts'
import type { DocumentInfo, ImportStatus } from '../../lib/types.ts'
import { useResource } from '../../lib/useResource.ts'
import { useSupportSentence } from '../../session.tsx'
import type { TabProps } from './CollectionPage.tsx'

// Sources (design J1, J9, section 10): the files, web pages and notes a collection holds, adding more (for its editors),
// the learning progress, "Stop using" (kept, not used for answers) and "Remove for good" (its owner and admins).

export function SourcesTab({ detail, reload, openSource }: TabProps) {
  const { collection } = detail
  const editor = canChange(detail.role) && detail.can.change
  const sources = useResource<{ sources: DocumentInfo[] }>(collectionPath(collection.id, '/sources'))
  const [started, setStarted] = useState<ImportStatus | null>(detail.engine?.currentImport ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState<DocumentInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const watch = useImportWatch(collection.id, started, () => { void sources.reload(); void reload() })
  // The lists of imports not learned yet are read again when an import is added, and whenever the one watched changes
  // state or ends (it starts, is waiting again, or is learned).
  const changed = watch.status ? `${watch.status.importId}:${watch.status.state}` : null

  async function setActive(document: DocumentInfo, active: boolean) {
    setBusy(document.documentId)
    setError(null)
    setNotice(null)
    try {
      await api.patch(collectionPath(collection.id, `/sources/${encodeURIComponent(document.documentId)}`), { active })
      setNotice(active ? `Using “${document.name}” again. A restore point was saved.` : `Stopped using “${document.name}”. It is kept, and you can use it again. A restore point was saved.`)
      await sources.reload()
      await reload()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(null)
    }
  }

  const all = sources.data?.sources ?? []
  const files = all.filter((document) => document.kind === 'file')
  const notes = all.filter((document) => document.kind === 'note')
  const actions = (document: DocumentInfo) => (
    <div className="flex flex-wrap gap-2 @2xl:justify-end">
      {editor ? (
        <Button type="button" variant="outline" size="sm" disabled={busy === document.documentId} title={document.active ? 'Keep the file but stop answering from it' : undefined}
          onClick={() => void setActive(document, !document.active)}>
          {document.active ? 'Stop using' : 'Use again'}
        </Button>
      ) : null}
      {detail.can.remove ? (
        <Button type="button" variant="outline" size="sm" className="text-destructive" title="Delete the file and keep it out of every earlier version" onClick={() => setRemoving(document)}>
          Remove for good
        </Button>
      ) : null}
    </div>
  )
  const name = (document: DocumentInfo) => (
    <>
      <button type="button" className="text-left font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline" onClick={() => openSource({ documentId: document.documentId })}>
        {document.name}
      </button>
      <div className="text-xs text-muted-foreground">{sourceKind(document)}{document.pages ? ` · ${plural(document.pages, 'page')}` : ''}</div>
    </>
  )
  const status = (document: DocumentInfo) => (document.active ? <Badge tone="green">Learned</Badge> : <Badge tone="grey" title="Kept, but not used for answers">Not used</Badge>)
  // A table where there is room, a list of cards on a narrow screen.
  const table = (list: DocumentInfo[], label: string) => (
    <div className="@container">
      <ul className="flex flex-col divide-y @2xl:hidden" aria-label={label}>
        {list.map((document) => (
          <li key={document.documentId} className="flex flex-col gap-2 py-3" data-source-row={document.active ? 'active' : 'inactive'}>
            <div className="min-w-0">{name(document)}</div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{status(document)}<span>Added {formatDay(document.addedAt)}</span><span>{formatBytes(document.textBytes)}</span></div>
            {actions(document)}
          </li>
        ))}
      </ul>
      <div className="hidden @2xl:block">
        <Table aria-label={label}>
          <TableHeader>
            <TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Added</TableHead><TableHead className="text-right">Size</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {list.map((document) => (
              <TableRow key={document.documentId}>
                <TableCell className="max-w-80 whitespace-normal">{name(document)}</TableCell>
                <TableCell>{status(document)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDay(document.addedAt)}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{formatBytes(document.textBytes)}</TableCell>
                <TableCell>{actions(document)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {editor ? (
        <Card title={`Add to ${collection.name}`}>
          <AddSources collectionId={collection.id} collectionName={collection.name} onStarted={(status) => { setNotice(null); setStarted(status); void reload() }} />
        </Card>
      ) : (
        <Banner kind="info">Your role here is Viewer: you can read this list and open every source. The collection's owner, admins and editors add or remove sources.</Banner>
      )}
      {watch.status ? <ImportProgress status={watch.status} collectionName={collection.name} error={watch.error} /> : null}
      <WaitingImports collectionId={collection.id} state="waiting" editor={editor} refresh={changed} onCancelled={(what) => setNotice(`Cancelled ${what}: it won't be learned.`)} />
      <WaitingImports collectionId={collection.id} state="queued" editor={editor} refresh={changed} onCancelled={(what) => setNotice(`Cancelled ${what}: it won't be learned.`)} />
      {notice ? <Banner kind="ok">{notice}</Banner> : null}
      <ActionError error={error} />
      {sources.loading ? <Loading /> : sources.error ? <ErrorState error={sources.error} onRetry={() => void sources.reload()} /> : (
        <>
          <Card title="Files and web pages" description={files.length ? `${plural(files.length, 'source')}. Open one to read its text.` : undefined}>
            {files.length ? table(files, 'Files and web pages') : <Note>No files or web pages yet.</Note>}
          </Card>
          <Card title="Notes" description="Short answers written here. Corrections are saved as notes too.">
            {notes.length ? table(notes, 'Notes') : <Note>A note is a short answer you write yourself, like “The MDF limit is $50,000 since October.”</Note>}
          </Card>
        </>
      )}
      {removing ? (
        <RemoveDialog collectionId={collection.id} collectionName={collection.name} document={removing} onClose={() => setRemoving(null)}
          onRemoved={(blocked) => {
            setNotice(`Removed “${removing.name}” for good.${blocked ? ` ${plural(blocked, 'earlier version')} in History can no longer be brought back.` : ''}`)
            setRemoving(null)
            void sources.reload()
            void reload()
          }} />
      ) : null}
    </div>
  )
}

function RemoveDialog({ collectionId, collectionName, document, onClose, onRemoved }: {
  collectionId: string
  collectionName: string
  document: DocumentInfo
  onClose: () => void
  onRemoved: (blocked: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const body = await api.delete<{ removed: { blockedRestorePoints: number[] } }>(collectionPath(collectionId, `/sources/${encodeURIComponent(document.documentId)}`))
      onRemoved(body.removed.blockedRestorePoints.length)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">Remove “{document.name}” for good?</DialogTitle>
          <DialogDescription>This can't be undone.</DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm">
          <li>Its text leaves {collectionName} and its latest backup now.</li>
          <li>Earlier versions in History that contain it can no longer be brought back.</li>
          <li>“Stop using” keeps the file instead, and can be undone.</li>
        </ul>
        <ActionError error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove for good'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface WaitingImport {
  importId: string
  kind: 'files' | 'web_page' | 'note' | 'correction'
  createdAt: string
  createdBy: { id: string; name: string | null }
  files: string[]
  notes: number
  titles: string[]
  /** When one waiting for the 1st starts by itself; null for one Insulin has and learns in turn. */
  waitsFor: string | null
}

/** What a waiting import brings, in plain words: its files' names, or its notes' titles. */
function waitingWhat(entry: WaitingImport): string {
  if (entry.files.length) return entry.files.length === 1 ? `“${entry.files[0]}”` : plural(entry.files.length, 'file')
  if (entry.kind === 'correction') return 'a correction'
  if (entry.titles.length === 1) return `the note “${entry.titles[0]}”`
  return entry.notes === 1 ? 'a note' : plural(entry.notes, 'note')
}

/**
 * The two lists of imports not learned yet that can still be cancelled: their titles and what they say. Waiting for the
 * 1st is a limit, so it names Insulin Apps support, as every limit message does.
 */
const WAITING_LISTS = {
  waiting: { title: 'Waiting for the 1st', description: "Your organization has learned this month's documents. These are learned on the 1st, by themselves; everything already learned keeps answering." },
  queued: { title: 'Waiting to be learned', description: 'Insulin has these and learns them in turn. Until it starts on one, it can be cancelled.' },
} as const

/**
 * The collection's imports waiting for the 1st (its organization has learned this month's documents), or those Insulin
 * has but hasn't started learning (`queued`): each with what it brings, who added it and, for the 1st, when it starts
 * by itself (the day in UTC, as the limits' month and the learning progress name it); its editors can cancel one, and it
 * is never learned. A cancel that can't be done (it started meanwhile) reads the list again too.
 */
function WaitingImports({ collectionId, state, editor, refresh, onCancelled }: { collectionId: string; state: keyof typeof WAITING_LISTS; editor: boolean; refresh: unknown; onCancelled: (what: string) => void }) {
  const waiting = useResource<{ imports: WaitingImport[] }>(collectionPath(collectionId, `/imports?state=${state}`))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const support = useSupportSentence()
  const { reload } = waiting
  useEffect(() => { if (refresh) void reload() }, [refresh, reload])
  const list = waiting.data?.imports ?? []
  // Emptied by a cancel that couldn't be done, the card stays to say why.
  if (!list.length && !error) return null
  async function cancel(entry: WaitingImport) {
    setBusy(entry.importId)
    setError(null)
    try {
      await api.delete(collectionPath(collectionId, `/imports/${encodeURIComponent(entry.importId)}`))
      onCancelled(waitingWhat(entry))
      await reload()
    } catch (failure) {
      setError(failure)
      await reload()
    } finally {
      setBusy(null)
    }
  }
  const description = state === 'waiting' ? `${WAITING_LISTS.waiting.description} ${support}` : WAITING_LISTS[state].description
  return (
    <Card title={WAITING_LISTS[state].title} description={description}>
      <ul className="flex flex-col divide-y rounded-lg border empty:hidden" aria-label={WAITING_LISTS[state].title}>
        {list.map((entry) => (
          <li key={entry.importId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-waiting-import={entry.importId}>
            <span className="min-w-0 grow basis-48 [overflow-wrap:anywhere]">
              <b>{waitingWhat(entry)}</b>
              <span className="block text-xs text-muted-foreground">Added by {entry.createdBy.name ?? 'someone'} {formatWhen(entry.createdAt)}{entry.waitsFor ? ` · starts ${formatResetDay(entry.waitsFor)}` : ''}</span>
            </span>
            {editor ? <Button type="button" variant="outline" size="sm" disabled={busy === entry.importId} onClick={() => void cancel(entry)}>Cancel</Button> : null}
          </li>
        ))}
      </ul>
      <ActionError error={error} />
    </Card>
  )
}
