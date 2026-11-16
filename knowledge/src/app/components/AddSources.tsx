import { useRef, useState, type FormEvent } from 'react'
import { FileUp, Globe, NotebookPen } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { formatBytes, plural } from '../lib/format.ts'
import type { ImportStatus } from '../lib/types.ts'
import { ActionError, Banner, Note } from './Feedback.tsx'
import { useLimitStop } from './LimitDialog.tsx'

// Adding what a collection knows (design J1 step 2, J9, IMP-01, IMP-11): files, a public web page, or a note. Files go
// through preflight first, which names every file that can't be learned (its type, its size, or a scanned PDF with no
// text) before anything starts; the person then learns the rest, all or nothing. Every step is the API's.

interface PreflightFile {
  name: string
  bytes: number
  accepted: boolean
  fileId?: string
  reason?: string
}

type Mode = 'files' | 'web' | 'note' | null

export const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.md,.markdown,.txt,.html,.htm'

export function AddSources({ collectionId, collectionName, onStarted, initialMode = null }: {
  collectionId: string
  collectionName: string
  onStarted: (status: ImportStatus, kind: 'files' | 'web' | 'note') => void
  initialMode?: Mode
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  return (
    <div className="flex flex-col gap-4" data-add-sources="">
      <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Add">
        <WayButton active={mode === 'files'} onClick={() => setMode(mode === 'files' ? null : 'files')} icon={<FileUp aria-hidden="true" />} title="Upload files"
          sub="PDF, Word, PowerPoint, Excel, Markdown, text or web page files" />
        <WayButton active={mode === 'web'} onClick={() => setMode(mode === 'web' ? null : 'web')} icon={<Globe aria-hidden="true" />} title="Add a web page"
          sub="A public page, such as a help-center article" />
        <WayButton active={mode === 'note'} onClick={() => setMode(mode === 'note' ? null : 'note')} icon={<NotebookPen aria-hidden="true" />} title="Write a note"
          sub="A few lines in your own words" />
      </div>
      {mode === 'files' ? <UploadFiles collectionId={collectionId} collectionName={collectionName} onStarted={(status) => { setMode(null); onStarted(status, 'files') }} onCancel={() => setMode(null)} /> : null}
      {mode === 'web' ? <AddWebPage collectionId={collectionId} onStarted={(status) => { setMode(null); onStarted(status, 'web') }} onCancel={() => setMode(null)} /> : null}
      {mode === 'note' ? <WriteNote collectionId={collectionId} onStarted={(status) => { setMode(null); onStarted(status, 'note') }} onCancel={() => setMode(null)} /> : null}
      <Note>Before Insulin reads anything, it hides e-mail addresses, phone numbers, card numbers, API keys and values labelled as passwords or secrets.</Note>
    </div>
  )
}

function WayButton({ active, onClick, icon, title, sub }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; sub: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className="flex min-w-0 items-start gap-3 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:border-primary aria-pressed:bg-accent [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </span>
    </button>
  )
}

function UploadFiles({ collectionId, collectionName, onStarted, onCancel }: { collectionId: string; collectionName: string; onStarted: (status: ImportStatus) => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<'pick' | 'checking' | 'confirm' | 'starting'>('pick')
  const [checked, setChecked] = useState<PreflightFile[]>([])
  const [ready, setReady] = useState<string[]>([])
  const [error, setError] = useState<unknown>(null)
  const { stopIfAwakeHours } = useLimitStop()

  async function check(files: File[]) {
    if (!files.length) return
    setError(null)
    setPhase('checking')
    try {
      const preflight = await api.post<{ files: PreflightFile[] }>(collectionPath(collectionId, '/preflight'), {
        files: files.map((file) => ({ name: file.name, bytes: file.size, type: file.type || undefined })),
      })
      const results: PreflightFile[] = []
      const accepted: string[] = []
      // Each accepted file is uploaded; the upload can still name a PDF that is only a scanned image.
      for (const entry of preflight.files) {
        if (!entry.accepted || !entry.fileId) {
          results.push(entry)
          continue
        }
        const file = files.find((candidate) => candidate.name === entry.name && candidate.size === entry.bytes) ?? files.find((candidate) => candidate.name === entry.name)!
        const uploaded = await api.upload<{ accepted: boolean; reason: string | null }>(collectionPath(collectionId, `/uploads/${entry.fileId}`), file, file.name)
        if (uploaded.accepted) accepted.push(entry.fileId)
        results.push({ ...entry, accepted: uploaded.accepted, reason: uploaded.reason ?? undefined })
      }
      setChecked(results)
      setReady(accepted)
      if (results.every((entry) => entry.accepted)) await start(accepted)
      else setPhase('confirm')
    } catch (failure) {
      stopIfAwakeHours(failure)
      setError(failure)
      setPhase('pick')
    }
  }

  async function start(fileIds: string[]) {
    setPhase('starting')
    setError(null)
    try {
      const body = await api.create<{ import: ImportStatus }>(collectionPath(collectionId, '/imports'), { fileIds })
      onStarted(body.import)
    } catch (failure) {
      stopIfAwakeHours(failure)
      setError(failure)
      setPhase('confirm')
    }
  }

  const refused = checked.filter((entry) => !entry.accepted)
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      {phase === 'pick' || phase === 'checking' ? (
        <>
          <Label htmlFor="upload-files">Files to add to {collectionName}</Label>
          <Input id="upload-files" ref={input} type="file" multiple accept={ACCEPT} disabled={phase === 'checking'}
            onChange={(event) => void check(Array.from(event.currentTarget.files ?? []))} />
          <Note>PDF with text, Word, PowerPoint, Excel, Markdown, plain text or web page files, up to your organization's largest file size (25 MB unless Insulin Apps changed it). Files that can't be learned are named before anything starts.</Note>
          {phase === 'checking' ? <p className="text-sm text-muted-foreground" role="status">Checking and uploading…</p> : null}
        </>
      ) : null}
      {phase === 'confirm' || phase === 'starting' ? (
        <>
          <Banner kind="warn" title={`${refused.length} of ${plural(checked.length, 'file')} can't be learned`}>
            <ul className="mt-1 list-disc pl-5">
              {refused.map((entry) => <li key={entry.name}>{entry.reason ?? `“${entry.name}” can't be learned.`}</li>)}
            </ul>
          </Banner>
          {ready.length ? (
            <p className="text-sm">Learn the other {plural(ready.length, 'file')}? {checked.filter((entry) => entry.accepted).map((entry) => `${entry.name} (${formatBytes(entry.bytes)})`).join(', ')}.</p>
          ) : <p className="text-sm">None of these files can be learned. Nothing was started.</p>}
          <div className="flex flex-wrap gap-2">
            {ready.length ? <Button type="button" disabled={phase === 'starting'} onClick={() => void start(ready)}>Learn {plural(ready.length, 'file')}</Button> : null}
            <Button type="button" variant="outline" onClick={() => { setPhase('pick'); setChecked([]); setReady([]); onCancel() }}>Cancel</Button>
          </div>
        </>
      ) : null}
      <ActionError error={error} />
      {phase === 'pick' ? <div><Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button></div> : null}
    </div>
  )
}

function AddWebPage({ collectionId, onStarted, onCancel }: { collectionId: string; onStarted: (status: ImportStatus) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const { stopIfAwakeHours } = useLimitStop()
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ import: ImportStatus }>(collectionPath(collectionId, '/web-pages'), { url: url.trim() })
      onStarted(body.import)
    } catch (failure) {
      stopIfAwakeHours(failure)
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={(event) => void submit(event)}>
      <Label htmlFor="web-page">Address of a public web page</Label>
      <Input id="web-page" type="url" inputMode="url" required placeholder="https://www.example.com/help/partner-program" value={url} onChange={(event) => setUrl(event.target.value)} />
      <Note>Insulin reads the page now. Add it again later to read it again.</Note>
      <ActionError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !url.trim()}>{busy ? 'Reading the page…' : 'Add the page'}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function WriteNote({ collectionId, onStarted, onCancel }: { collectionId: string; onStarted: (status: ImportStatus) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const { stopIfAwakeHours } = useLimitStop()
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ import: ImportStatus }>(collectionPath(collectionId, '/notes'), { title: title.trim() || undefined, text: text.trim() })
      onStarted(body.import)
    } catch (failure) {
      stopIfAwakeHours(failure)
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="note-title">Title</Label>
        <Input id="note-title" maxLength={200} placeholder="For example: MDF approvals" value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="note-text">Note</Label>
        <Textarea id="note-text" required rows={5} placeholder="For example: Since October, partner managers can approve MDF requests up to $50,000." value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <Note>Insulin learns a note like a file, ahead of other files, and cites it by its title.</Note>
      <ActionError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save and learn it'}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
