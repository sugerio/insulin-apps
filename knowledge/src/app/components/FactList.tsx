import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { formatDay, plural } from '../lib/format.ts'
import type { CollectionSummary, DocumentInfo, FactWithCheck, ImportStatus } from '../lib/types.ts'
import { useSupportSentence } from '../session.tsx'
import { ActionError, Badge, Banner, ErrorState, Loading, Note } from './Feedback.tsx'
import { FINAL, nextMonth, useImportWatch } from './ImportProgress.tsx'

// What a collection knows (design J1 step 4, FIX-04): facts as sentences a person can check, each with the source it
// came from. Its editors mark one "Looks right" (with their name) or fix it once (a correction every new question
// uses); everyone else reports a problem to the owner.

interface FactsPage {
  facts: FactWithCheck[]
  next: string | null
}

export function FactList({ collection, editor, onOpenSource, limit, search = true, onLoaded }: {
  collection: CollectionSummary
  editor: boolean
  onOpenSource: (target: { documentId: string; find?: string | null }) => void
  /** Show only the first few (the new collection's "check the most important facts"). */
  limit?: number
  search?: boolean
  /** Called with the facts loaded so far (all of them, not only those shown), after each load and change. */
  onLoaded?: (facts: FactWithCheck[]) => void
}) {
  const [facts, setFacts] = useState<FactWithCheck[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [query, setQuery] = useState('')
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [fixing, setFixing] = useState<FactWithCheck | null>(null)
  const [reporting, setReporting] = useState<FactWithCheck | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loaded = useRef(onLoaded)
  useEffect(() => { loaded.current = onLoaded })

  async function load(cursor: string | null) {
    setLoading(true)
    try {
      const page = await api.get<FactsPage>(collectionPath(collection.id, `/facts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`))
      setFacts((current) => (cursor ? [...current, ...page.facts] : page.facts))
      setNext(page.next)
      setError(null)
    } catch (failure) {
      setError(failure)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(null)
    api.get<{ sources: DocumentInfo[] }>(collectionPath(collection.id, '/sources'))
      .then((body) => setNames(new Map(body.sources.map((document) => [document.documentId, document.name]))), () => undefined)
    // Loaded once per collection; "Show more" pages on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection.id])

  useEffect(() => {
    if (!loading && !error) loaded.current?.(facts)
  }, [facts, loading, error])

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    const list = wanted ? facts.filter((fact) => fact.sentence.toLowerCase().includes(wanted) || (names.get(fact.documentId) ?? '').toLowerCase().includes(wanted)) : facts
    return limit ? list.slice(0, limit) : list
  }, [facts, query, names, limit])

  async function check(fact: FactWithCheck) {
    setBusy(fact.factId)
    setActionError(null)
    try {
      const body = await api.post<{ check: { by: string | null; at: string } }>(collectionPath(collection.id, `/facts/${encodeURIComponent(fact.factId)}/check`))
      setFacts((current) => current.map((candidate) => (candidate.factId === fact.factId ? { ...candidate, checked: body.check } : candidate)))
    } catch (failure) {
      setActionError(failure)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-facts="">
      {search ? (
        <Input type="search" aria-label="Search what it knows" placeholder="Search the facts shown…" value={query} onChange={(event) => setQuery(event.target.value)} />
      ) : null}
      {notice ? <Banner kind="ok">{notice}</Banner> : null}
      <ActionError error={actionError} />
      {error && !facts.length ? <ErrorState error={error} onRetry={() => void load(null)} /> : null}
      {loading && !facts.length ? <Loading /> : null}
      {!loading && !error && !facts.length ? <Note>Nothing learned yet. Facts appear here once files, web pages or notes are learned.</Note> : null}
      {facts.length && !shown.length ? <Note>No facts match.{next && !limit ? ' “Show more” at the end of the list adds the rest to search.' : ''} Try another word, or ask a question instead.</Note> : null}
      <ul className="flex flex-col divide-y rounded-xl bg-card ring-1 ring-foreground/10">
        {shown.map((fact) => (
          <li key={fact.factId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between" data-fact="">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm [overflow-wrap:anywhere]">{fact.sentence}</p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>from{' '}
                  <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => onOpenSource({ documentId: fact.documentId, find: fact.sourceSentence })}>
                    {names.get(fact.documentId) ?? 'its source'}
                  </button>
                </span>
                {fact.checked ? <Badge tone="green">Checked by {fact.checked.by ?? 'someone'}, {formatDay(fact.checked.at)}</Badge> : null}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {editor ? (
                <>
                  {fact.checked ? null : <Button type="button" variant="outline" size="sm" disabled={busy === fact.factId} onClick={() => void check(fact)}>Looks right</Button>}
                  <Button type="button" variant="outline" size="sm" onClick={() => { setNotice(null); setFixing(fact) }}>Fix</Button>
                </>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => { setNotice(null); setReporting(fact) }}>Report a problem</Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!limit && next ? <div><Button type="button" variant="outline" disabled={loading} onClick={() => void load(next)}>{loading ? 'Loading…' : 'Show more'}</Button></div> : null}
      {facts.length ? <Note>Showing {plural(shown.length, 'fact')}{collection.facts > shown.length ? ` of ${collection.facts.toLocaleString('en-US')}` : ''}. Each fact is one sentence Insulin took from a source. Check the ones that matter; fix the ones that are wrong.</Note> : null}
      {fixing ? <FixFactDialog collection={collection} fact={fixing} onClose={() => setFixing(null)} onFixed={() => { setNotice('Fixed. New questions on this site and from AI assistants use your fix.'); setFixing(null); void load(null) }} /> : null}
      {reporting ? <ReportFactDialog collection={collection} fact={reporting} onClose={() => setReporting(null)} onSent={() => { setNotice(`Sent to ${collection.owner.name ?? 'the owner'}, the owner.`); setReporting(null) }} /> : null}
    </div>
  )
}

function FixFactDialog({ collection, fact, onClose, onFixed }: { collection: CollectionSummary; fact: FactWithCheck; onClose: () => void; onFixed: () => void }) {
  const [text, setText] = useState(fact.sentence)
  const [notify, setNotify] = useState(false)
  const support = useSupportSentence()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [started, setStarted] = useState<ImportStatus | null>(null)
  const { status } = useImportWatch(collection.id, started, (final) => { if (final.state === 'committed') onFixed() })
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ import: ImportStatus }>(collectionPath(collection.id, '/corrections'), { text: text.trim(), factId: fact.factId, notifyAuthors: notify })
      setStarted(body.import)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const failed = status && FINAL.has(status.state) && status.state !== 'committed'
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>Fix a fact</DialogTitle>
            <DialogDescription>Your fix is saved as a note and used everywhere {collection.name} is asked. The old sentence is marked as corrected.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fact-fix">The right fact</Label>
            <Textarea id="fact-fix" required rows={3} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          {started ? null : (
            <div className="flex items-start gap-2">
              <Checkbox id="fact-notify" checked={notify} onCheckedChange={(value) => setNotify(value === true)} className="mt-0.5" />
              <Label htmlFor="fact-notify" className="font-normal leading-snug">Tell the person who added this file, so they can update it too. They get an e-mail with a link, not your fix.</Label>
            </div>
          )}
          {status?.state === 'waiting' ? <Banner kind="info">Your organization has learned this month's documents, so {collection.name} learns your fix on {nextMonth()}, by itself. {support}</Banner>
            : started && !failed ? <Banner kind="info">Learning your fix, about a minute. Questions to {collection.name} wait meanwhile.</Banner> : null}
          {failed ? <Banner kind="danger">{status?.error?.message ?? "The fix couldn't be learned."} Nothing was changed.</Banner> : null}
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{started ? 'Close' : 'Cancel'}</Button>
            {started ? null : <Button type="submit" disabled={busy || !text.trim() || text.trim() === fact.sentence}>{busy ? 'Saving…' : 'Save the fix'}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ReportFactDialog({ collection, fact, onClose, onSent }: { collection: CollectionSummary; fact: FactWithCheck; onClose: () => void; onSent: () => void }) {
  const owner = collection.owner.name ?? 'the owner'
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function send(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.create(collectionPath(collection.id, '/reports'), { question: `Fact: ${fact.sentence}`.slice(0, 2000), answer: fact.sentence, note: note.trim() || undefined })
      onSent()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void send(event)}>
          <DialogHeader>
            <DialogTitle>Tell {owner} what's wrong</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">“{fact.sentence}”</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fact-report">What's wrong with it?</Label>
            <Textarea id="fact-report" rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          <Note>{owner} and the collection's admins get an e-mail. A report doesn't change anything until they fix it.</Note>
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Sending…' : `Send to ${owner}`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
