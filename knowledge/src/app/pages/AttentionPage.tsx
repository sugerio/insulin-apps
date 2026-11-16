import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ActionError, Badge, Banner, ErrorState, Loading, Note } from '../components/Feedback.tsx'
import { Card, Page, PageHead } from '../components/Page.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { formatWhen, plural } from '../lib/format.ts'
import type { AttentionCollection, AttentionItem } from '../lib/types.ts'
import { useResource } from '../lib/useResource.ts'
import { canEdit, useMe } from '../session.tsx'
import { NoPermissionPage } from './NotFoundPage.tsx'

// Needs attention (design J6, LAUNCH items): what only a person can settle, across the collections the person can
// change: files Insulin couldn't read, values hidden before learning, answers reported as wrong, and corrections to
// check after their file was read again. Insulin keeps answering while they wait.

export function AttentionPage() {
  const me = useMe()
  const [params] = useSearchParams()
  const only = params.get('collection')
  const attention = useResource<{ collections: AttentionCollection[] }>(canEdit(me) ? `/api/attention${only ? `?collection=${encodeURIComponent(only)}` : ''}` : null)
  if (!canEdit(me)) {
    return <NoPermissionPage title="Needs attention" message="Needs attention is for people who can change collections. Your role in Knowledge can only read; you can still report a wrong answer from any answer." />
  }
  const list = attention.data?.collections ?? []
  const waiting = list.filter((collection) => collection.items.length)
  return (
    <Page title="Needs attention" crumbs={[['Needs attention']]}>
      <PageHead title="Needs attention"
        sub="Things only a person can decide, in the collections you can change. Insulin keeps answering while they wait."
        actions={only ? <Button asChild variant="outline" size="sm"><Link to="/attention">Show every collection</Link></Button> : null} />
      {attention.loading ? <Loading /> : attention.error ? <ErrorState error={attention.error} onRetry={() => void attention.reload()} /> : waiting.length === 0 ? (
        <Banner kind="ok">Nothing needs your attention{only && list[0] ? ` in ${list[0].name}` : ''}.</Banner>
      ) : waiting.map((collection) => (
        <Card key={collection.id} title={collection.name}
          right={<Button asChild variant="outline" size="sm"><Link to={`/collections/${collection.id}`}>Open the collection</Link></Button>}>
          <ul className="flex flex-col gap-3">
            {collection.items.map((item) => <Item key={item.id} collection={collection} item={item} onSettled={() => void attention.reload()} />)}
          </ul>
        </Card>
      ))}
      <Note>Files Insulin couldn't read and hidden values are listed for 30 days. A file leaves the list once a file with the same name is learned in that collection.</Note>
    </Page>
  )
}

function Item({ collection, item, onSettled }: { collection: AttentionCollection; item: AttentionItem; onSettled: () => void }) {
  const [fixing, setFixing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function stillRight(check: Extract<AttentionItem, { kind: 'needs_check' }>) {
    setBusy(true)
    setError(null)
    try {
      await api.post(collectionPath(collection.id, '/correction-checks/clear'), { noteId: check.noteId, documentId: check.documentId, textHash: check.textHash })
      onSettled()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  async function dismiss(reportId: string) {
    setBusy(true)
    setError(null)
    try {
      await api.patch(collectionPath(collection.id, `/reports/${encodeURIComponent(reportId)}`), { status: 'dismissed' })
      onSettled()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const frame = (tone: 'red' | 'blue' | 'amber', tag: string, title: string, body: React.ReactNode, actions: React.ReactNode) => (
    <li className="flex flex-col gap-2 rounded-lg border p-3" data-attention={item.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{tag}</Badge>
        <h3 className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{formatWhen(item.at)}</span>
      </div>
      <div className="text-sm [overflow-wrap:anywhere]">{body}</div>
      <div className="flex flex-wrap gap-2">{actions}</div>
      <ActionError error={error} />
    </li>
  )
  if (item.kind === 'unreadable') {
    const names = item.files.map((file) => `“${file.name}”`).join(', ')
    return frame('red', "Can't read", `Couldn't read ${names || 'a file'}`, <p>{item.message}</p>,
      <Button asChild variant="outline" size="sm"><Link to={`/collections/${collection.id}/sources`}>Upload a version with text</Link></Button>)
  }
  if (item.kind === 'hidden') {
    return frame('blue', 'Hidden', `Hidden before learning: ${plural(item.total, 'value')}`,
      <p>In “{item.documentName}”. Insulin removed {item.total === 1 ? 'it' : 'them'} before reading the file, so no answer can show {item.total === 1 ? 'it' : 'them'}.</p>,
      <Button asChild variant="outline" size="sm"><Link to={`/collections/${collection.id}/sources?source=${encodeURIComponent(item.documentId)}`}>See where</Link></Button>)
  }
  if (item.kind === 'needs_check') {
    return frame('amber', 'Check', 'A correction asks to be checked',
      <>
        <p>{item.documentName ? <>“{item.documentName}”</> : 'A file'} was read again, and the words your correction applies to now read differently. Check that the correction still says the right thing, and write it again if not.</p>
        {item.text ? <p className="mt-1 rounded-md bg-muted px-3 py-2">“{item.text}”</p> : null}
      </>,
      <>
        <Button type="button" size="sm" disabled={busy} onClick={() => void stillRight(item)}>Still right</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setFixing(true)}>Write it again</Button>
        <Button asChild variant="outline" size="sm"><Link to={`/collections/${collection.id}/sources?source=${encodeURIComponent(item.documentId)}`}>Open the file</Link></Button>
        {fixing ? <RewriteDialog collection={collection} item={item} onClose={() => setFixing(false)} onSaved={() => { setFixing(false); onSettled() }} /> : null}
      </>)
  }
  const who = item.reportedBy.name ?? 'Someone'
  return (
    <>
      {frame('amber', 'Reported', `${who} says an answer is wrong`, (
        <>
          <p><span className="text-muted-foreground">Question:</span> “{item.question}”</p>
          {item.note ? <p className="mt-1 rounded-md bg-muted px-3 py-2">“{item.note}”</p> : null}
        </>
      ), (
        <>
          <Button type="button" size="sm" onClick={() => setFixing(true)}>Fix the answer</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void dismiss(item.id.replace(/^report:/, ''))}>It's right</Button>
        </>
      ))}
      {fixing ? <FixReportDialog collection={collection} item={item} onClose={() => setFixing(false)} onFixed={() => { setFixing(false); onSettled() }} /> : null}
    </>
  )
}

/**
 * "Write it again": a new correction of the file, starting from what the correction said (as Insulin learned it,
 * hidden values hidden). Once learned, it settles the check.
 */
function RewriteDialog({ collection, item, onClose, onSaved }: { collection: AttentionCollection; item: Extract<AttentionItem, { kind: 'needs_check' }>; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(item.text ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.create(collectionPath(collection.id, '/corrections'), { text: text.trim(), outdated: [{ documentId: item.documentId, textHash: item.textHash }] })
      onSaved()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>Write the correction again</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">{item.documentName ? `“${item.documentName}” was read again.` : 'Its file was read again.'} Say what is right now.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rewrite-fix">What's the right answer?</Label>
            <Textarea id="rewrite-fix" required rows={4} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <Note>Saved as a new correction of that file. Once Insulin has learned it, this check is settled.</Note>
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save the correction'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FixReportDialog({ collection, item, onClose, onFixed }: { collection: AttentionCollection; item: Extract<AttentionItem, { kind: 'reported' }>; onClose: () => void; onFixed: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.create(collectionPath(collection.id, '/corrections'), { text: text.trim(), question: item.question.slice(0, 2000), reportId: item.id.replace(/^report:/, '') })
      onFixed()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>Fix the answer</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">“{item.question}”</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report-fix">What's the right answer?</Label>
            <Textarea id="report-fix" required rows={4} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <Note>Saved as a correction that new questions on this site and from AI assistants use, in about a minute. The report is closed as fixed once Insulin has learned it.</Note>
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save the correction'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
