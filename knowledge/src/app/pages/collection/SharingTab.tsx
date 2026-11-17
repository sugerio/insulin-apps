import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { roleWhy } from '../../components/CollectionParts.tsx'
import { AssistantsSwitch, KeepReadyForm, NamePurposeForm } from '../../components/CollectionSettings.tsx'
import { DeleteCollectionDialog } from '../../components/DeleteCollection.tsx'
import { ActionError, Banner, Note } from '../../components/Feedback.tsx'
import { Card } from '../../components/Page.tsx'
import { MemberSearch, SharePanel } from '../../components/SharePanel.tsx'
import { api, collectionPath } from '../../lib/api.ts'
import { formatBytes, formatWhen, ROLE_LABEL } from '../../lib/format.ts'
import type { ExportStatus, Member } from '../../lib/types.ts'
import { useMe } from '../../session.tsx'
import type { TabProps } from './CollectionPage.tsx'

// Sharing (design J7): who can ask it and with what role; its settings (name, purpose, AI assistants and API clients,
// keep it ready) and export for its owner and admins; transfer and delete for its owner. All of these are the site's
// only: the API refuses them to AI assistants and API clients.

export function SharingTab({ detail, reload, onDeleted }: TabProps & { onDeleted: () => void }) {
  const me = useMe()
  const { collection, can } = detail
  const configure = can.share || can.settings
  // Said here, not in the Owner only card: after a transfer the page reloads and the card is gone, since the person
  // who sent it is an admin now.
  const [transferred, setTransferred] = useState<string | null>(null)
  return (
    <div className="@container flex flex-col gap-4">
      {transferred ? <Banner kind="ok">{transferred}</Banner> : null}
      {configure ? null : <Banner kind="info">Your role here is {ROLE_LABEL[detail.role]}. Only the collection's owner and admins change sharing and settings.</Banner>}
      <div className="grid items-start gap-4 @4xl:grid-cols-2">
        {/* A new owner (a transfer) shows at once among the people with access. */}
        <SharePanel key={collection.owner.id} collection={collection} canShare={can.share} roleNote={`Your role here: ${ROLE_LABEL[detail.role]} (${roleWhy(me, collection)}).`} />
        <div className="flex flex-col gap-4">
          {can.settings ? (
            <Card title="Collection settings">
              <NamePurposeForm collection={collection} onSaved={() => void reload()} />
              <div className="border-t pt-4"><AssistantsSwitch collection={collection} onSaved={() => void reload()} /></div>
              <div className="flex flex-col gap-2 border-t pt-4">
                <h3 className="text-sm font-semibold">Keep it ready</h3>
                <KeepReadyForm collection={collection} timeZone={detail.engine?.settings.keepReady?.timeZone} onSaved={() => void reload()} />
              </div>
            </Card>
          ) : (
            <Card title="Collection settings">
              <Note>
                AI assistants and API clients: {collection.assistants ? 'on' : 'off'}. Keep it ready: {collection.keepReady ? 'a daily window' : 'only when asked'}.
              </Note>
            </Card>
          )}
          {can.export ? <ExportCard collectionId={collection.id} collectionName={collection.name} /> : null}
          {can.transfer || can.delete ? (
            <OwnerCard detail={detail} onTransferred={(notice) => { setTransferred(notice); void reload() }} onDeleted={onDeleted} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ExportCard({ collectionId, collectionName }: { collectionId: string; collectionName: string }) {
  const [status, setStatus] = useState<ExportStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // A check that fails (the engine busy, a dropped connection) is tried again, a little later each time, and can be
  // tried now; the export goes on meanwhile.
  const [failedChecks, setFailedChecks] = useState(0)
  const [checkNow, setCheckNow] = useState(0)
  const atOnce = useRef(false)
  useEffect(() => {
    if (!status || status.state === 'ready' || status.state === 'failed') return
    let live = true
    const delay = atOnce.current ? 0 : failedChecks ? Math.min(30_000, 3000 * failedChecks) : 2000
    atOnce.current = false
    const timer = setTimeout(() => {
      api.get<{ export: ExportStatus }>(collectionPath(collectionId, `/exports/${status.exportId}`)).then(
        (body) => { if (!live) return; setStatus(body.export); setError(null); setFailedChecks(0) },
        (failure) => { if (!live) return; setError(failure); setFailedChecks((count) => count + 1) },
      )
    }, delay)
    return () => { live = false; clearTimeout(timer) }
  }, [collectionId, status, failedChecks, checkNow])
  async function start() {
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ export: ExportStatus }>(collectionPath(collectionId, '/exports'))
      setStatus(body.export)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Export">
      <p className="text-sm">
        Download {collectionName}: the text of its files, its notes, facts, corrections and history, in an open format Insulin Knowledge can import again. No original files and no hidden values. Owners and admins only.
      </p>
      {status?.state === 'ready' ? (
        <Banner kind="ok" title="Your export is ready" action={<Button asChild size="sm"><a href={collectionPath(collectionId, `/exports/${status.exportId}?download=1`)} download>Download{status.bytes ? ` (${formatBytes(status.bytes)})` : ''}</a></Button>}>
          {status.expiresAt ? `The download is kept until ${formatWhen(status.expiresAt)}.` : null}
        </Banner>
      ) : status?.state === 'failed' ? (
        <Banner kind="danger">The export didn't finish. Nothing was changed. Try again.</Banner>
      ) : status ? <Note>Preparing the export…</Note> : null}
      {failedChecks && status?.state !== 'ready' && status?.state !== 'failed' ? (
        <Banner kind="warn" action={<Button type="button" size="sm" variant="outline" onClick={() => { atOnce.current = true; setCheckNow((count) => count + 1) }}>Check again now</Button>}>
          Couldn't check on the export just now. It goes on, and this page checks again by itself.
        </Banner>
      ) : <ActionError error={error} />}
      <div><Button type="button" variant="outline" disabled={busy || (status !== null && status.state !== 'ready' && status.state !== 'failed')} onClick={() => void start()}>Export</Button></div>
    </Card>
  )
}

function OwnerCard({ detail, onTransferred, onDeleted }: { detail: TabProps['detail']; onTransferred: (notice: string) => void; onDeleted: () => void }) {
  const { collection, can } = detail
  const [picking, setPicking] = useState(false)
  const [target, setTarget] = useState<Member | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [deleting, setDeleting] = useState(false)
  async function transfer() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await api.create(collectionPath(collection.id, '/transfer'), { to: target.id })
      setTarget(null)
      setPicking(false)
      onTransferred(`${target.name} owns “${collection.name}” now. You are an admin of it.`)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Owner only">
      {can.transfer ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">Transfer ownership</p>
              <p className="text-xs text-muted-foreground">The new owner must be an Admin or Editor in Knowledge. You become an admin of the collection.</p>
            </div>
            {picking ? null : <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>Transfer…</Button>}
          </div>
          {picking ? (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <MemberSearch label="New owner" onPick={setTarget}
                filter={(member) => member.type === 'person' && member.id !== collection.owner.id && (member.appRole === 'ADMIN' || member.appRole === 'EDITOR')} />
              <div><Button type="button" variant="ghost" size="sm" onClick={() => setPicking(false)}>Cancel</Button></div>
            </div>
          ) : null}
        </div>
      ) : null}
      {can.delete ? (
        <div className="flex flex-wrap items-start justify-between gap-2 border-t pt-4">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Delete this collection</p>
            <p className="text-xs text-muted-foreground">Files, facts and backups are removed. Restore points can't be opened afterwards and expire within 30 days.</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting(true)}>Delete…</Button>
        </div>
      ) : null}
      <ActionError error={error} />
      <Dialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer “{collection.name}” to {target?.name}?</DialogTitle>
            <DialogDescription>{target?.name} becomes its owner and gets an e-mail. You become an admin of it; only the new owner can transfer it back.</DialogDescription>
          </DialogHeader>
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={() => void transfer()}>{busy ? 'Transferring…' : 'Transfer'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteCollectionDialog collection={{ id: collection.id, name: collection.name, ownerName: collection.owner.name }} byOrgOwner={detail.role !== 'OWNER'}
        open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
    </Card>
  )
}
