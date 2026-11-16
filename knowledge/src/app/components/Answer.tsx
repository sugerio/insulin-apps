import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { api, collectionPath } from '../lib/api.ts'
import type { AskAnswer, AskSource, CollectionSummary, ImportStatus, Report } from '../lib/types.ts'
import { canChange } from './CollectionParts.tsx'
import { ActionError, Badge, Banner, Note } from './Feedback.tsx'
import { FINAL, useImportWatch } from './ImportProgress.tsx'
import type { SourceTarget } from './SourceViewer.tsx'

// Asking on the site (design J2, J4, J5, section 10): the written answer with numbered sources that open the text at
// the exact words, or "I won't guess" when nothing covers the question, or that the collection is waking or learning.
// "Not right" fixes the answer once for those who can change the collection (a correction every new question uses),
// and sends a report to the owner from everyone else; until it is settled, the answer shows that it was reported.

export function AskBox({ onAsk, placeholder, busy, label = 'Question', initial = '', disabled = false }: { onAsk: (question: string) => void; placeholder: string; busy: boolean; label?: string; initial?: string; disabled?: boolean }) {
  const [question, setQuestion] = useState(initial)
  useEffect(() => setQuestion(initial), [initial])
  function submit(event: FormEvent) {
    event.preventDefault()
    if (question.trim() && !disabled) onAsk(question.trim())
  }
  return (
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit} role="search" aria-label="Ask">
      <Input aria-label={label} className="h-10 flex-1" placeholder={placeholder} value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} />
      <Button type="submit" size="lg" className="h-10" disabled={busy || disabled || !question.trim()}>{busy ? 'Looking…' : 'Ask'}</Button>
    </form>
  )
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/** The answer's text with each [n] as a button that opens source n. */
function CitedText({ text, sources, onOpen }: { text: string; sources: AskSource[]; onOpen: (source: AskSource) => void }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const source = sources.find((candidate) => candidate.n === Number(match[1]))
    parts.push(source ? (
      <button key={`${at}-${match[1]}`} type="button" onClick={() => onOpen(source)} title={`Open source ${source.n}: ${source.documentName}`}
        aria-label={`Source ${source.n}: ${source.documentName}`}
        className="mx-0.5 inline-flex h-5 min-w-5 -translate-y-px items-center justify-center rounded-md bg-primary px-1 align-middle text-[11px] font-semibold text-primary-foreground hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-citation={source.n}>
        {source.n}
      </button>
    ) : match[0])
    last = at + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <p className="text-base leading-relaxed [overflow-wrap:anywhere]" data-answer-text="">{parts}</p>
}

export function SourceList({ sources, onOpen, names }: { sources: AskSource[]; onOpen: (source: AskSource) => void; names?: Map<string, string> }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="Sources">
      {sources.map((source) => (
        <li key={source.passageId}>
          <button type="button" onClick={() => onOpen(source)}
            className="flex w-full min-w-0 gap-3 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-source={source.n}>
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">{source.n}</span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="font-medium [overflow-wrap:anywhere]">
                {source.documentName}
                <span className="font-normal text-muted-foreground">
                  {source.kind === 'note' ? ' · note' : ''}{source.page ? ` · page ${source.page}` : ''}{names && names.size > 1 ? ` · ${names.get(source.collectionId) ?? ''}` : ''}
                </span>
              </span>
              <span className="line-clamp-3 text-muted-foreground [overflow-wrap:anywhere]">“{source.text}”</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

export const sourceTarget = (source: Pick<AskSource, 'collectionId' | 'documentId' | 'start' | 'end'>): SourceTarget => ({ collectionId: source.collectionId, documentId: source.documentId, start: source.start, end: source.end })

/** Steps while a sleeping collection wakes (design section 10, "Waking"). */
const WAKE_STEPS = ['Starting from the last restore point', 'Checking nothing changed while it slept', 'Opening what it knows']

export function WakeSteps({ step }: { step: number }) {
  return (
    <ol className="flex flex-col gap-1 text-sm" aria-label="Waking up">
      {WAKE_STEPS.map((label, index) => (
        <li key={label} className={index + 1 < step ? 'text-emerald-700 dark:text-emerald-400' : index + 1 === step ? 'font-medium' : 'text-muted-foreground'}>
          {index + 1 < step ? '✓ ' : index + 1 === step ? '→ ' : '· '}{label}
        </li>
      ))}
    </ol>
  )
}

export function AnswerView({ question, answer, collections, onOpenSource, onAskAgain }: {
  question: string
  answer: AskAnswer
  /** The collections asked, with the person's role in each. */
  collections: CollectionSummary[]
  onOpenSource: (target: SourceTarget) => void
  onAskAgain: () => void
}) {
  const names = new Map(collections.map((collection) => [collection.id, collection.name]))
  // A fix or a report goes to the collection of the first source, or the only collection asked.
  const primaryId = answer.citations[0]?.collectionId ?? answer.sources[0]?.collectionId ?? answer.collections.find((entry) => entry.status === 'ok')?.id ?? collections[0]?.id
  const primary = collections.find((collection) => collection.id === primaryId) ?? null
  const [panel, setPanel] = useState<'fix' | 'report' | 'write' | null>(null)
  const [reported, setReported] = useState<Report | null>(null)
  const open = (source: AskSource) => onOpenSource(sourceTarget(source))

  useEffect(() => {
    setPanel(null)
    setReported(null)
    if (!primary || (answer.outcome !== 'answered' && answer.outcome !== 'sources_only')) return
    let live = true
    api.get<{ reports: Report[] }>(collectionPath(primary.id, '/reports?status=open')).then((body) => {
      if (!live) return
      setReported(body.reports.find((report) => normalized(report.question) === normalized(question)) ?? null)
    }, () => undefined)
    return () => { live = false }
    // Once per answer: a reloaded collection (a new object) leaves an open fix or report alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, primary?.id, question])

  const owner = primary?.owner.name ?? 'the owner'
  const mayChange = canChange(primary?.role)
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5" aria-label="Answer" data-outcome={answer.outcome}>
      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">You asked: {question}</p>
      {answer.skipped.length ? <Banner kind="info">{answer.skipped.map((entry) => entry.message).join(' ')}</Banner> : null}
      {answer.outcome === 'waiting' ? (
        <Waiting answer={answer} onAskAgain={onAskAgain} />
      ) : answer.outcome === 'wont_guess' ? (
        <>
          <p className="text-base font-medium" data-wont-guess="">{answer.message ?? "I couldn't find this in the collections you picked, so I won't guess."}</p>
          <Note>Answers come only from the collection's files, web pages and notes. This question was added to the list of questions nothing covers, which the owner sees.</Note>
          {primary ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setPanel(panel === 'report' ? null : 'report')}>Ask {owner} to add it</Button>
              {mayChange ? <Button type="button" onClick={() => setPanel(panel === 'write' ? null : 'write')}>Write the answer</Button> : null}
            </div>
          ) : null}
          {panel === 'report' && primary ? <ReportPanel collection={primary} question={question} answer="" answerId={answer.answerId} missing onDone={() => undefined} /> : null}
          {panel === 'write' && primary ? <WriteAnswerPanel collection={primary} question={question} onAskAgain={onAskAgain} /> : null}
        </>
      ) : (
        <>
          {answer.outcome === 'answered' && answer.text ? (
            <CitedText text={answer.text} sources={answer.sources} onOpen={open} />
          ) : (
            <Banner kind="info">{answer.message ?? 'Here are the sources without a written answer.'}</Banner>
          )}
          {reported ? (
            <Banner kind="warn">{reported.reportedBy.name ?? 'Someone'} reported that this answer may be wrong. {owner} is checking.</Banner>
          ) : null}
          {answer.sources.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Sources</h3>
              <SourceList sources={answer.sources} onOpen={open} names={names} />
            </div>
          ) : null}
          {answer.outcome === 'answered' ? (
            <Note>
              {answer.writer === 'own' ? `Written by your organization's model${answer.model ? ` (${answer.model})` : ''} from the sources above.` : "Written by Insulin Knowledge's built-in model (Gemma 4) from the sources above."}
              {' '}Answers come only from {collections.length === 1 ? collections[0]!.name : 'the collections you picked'}, never from the internet.
            </Note>
          ) : null}
          {primary && panel === null ? (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
              <span className="text-muted-foreground">Is something wrong?</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setPanel(mayChange ? 'fix' : 'report')}>Not right</Button>
            </div>
          ) : null}
          {panel === 'fix' && primary ? <FixPanel collection={primary} question={question} sources={answer.sources.filter((source) => source.collectionId === primary.id)} reportId={reported?.id ?? null} onCancel={() => setPanel(null)} onAskAgain={onAskAgain} /> : null}
          {panel === 'report' && primary ? <ReportPanel collection={primary} question={question} answer={answer.text ?? ''} answerId={answer.answerId} onDone={() => undefined} onCancel={() => setPanel(null)} /> : null}
        </>
      )}
    </section>
  )
}

function Waiting({ answer, onAskAgain }: { answer: AskAnswer; onAskAgain: () => void }) {
  const waking = answer.status === 'waking'
  const retry = Math.max(3, Math.min(90, answer.retryAfterSeconds ?? 30))
  const [left, setLeft] = useState(retry)
  useEffect(() => {
    setLeft(retry)
    const timer = setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000)
    return () => clearInterval(timer)
  }, [answer, retry])
  useEffect(() => {
    if (left === 0) onAskAgain()
  }, [left, onAskAgain])
  const step = waking ? Math.min(3, 1 + Math.floor(((retry - left) / retry) * 3)) : 0
  return (
    <div className="flex flex-col gap-3" data-waiting={answer.status}>
      <p className="font-medium">{answer.message}</p>
      {waking ? <WakeSteps step={step} /> : null}
      <Note>
        {waking
          ? 'Collections sleep 10 minutes after the last question, which keeps Insulin Knowledge free. An owner can keep one ready for a daily window in Sharing.'
          : 'Questions wait while a collection learns, so no answer comes from a half-learned collection.'}
        {' '}Asking again in {left} seconds.
      </Note>
      <div><Button type="button" variant="outline" size="sm" onClick={onAskAgain}>Ask again now</Button></div>
    </div>
  )
}

const FIX_STEPS = ['Saving your correction', 'Learning it', 'Saving a restore point']

function stepOf(status: ImportStatus | null): number {
  if (!status) return 1
  if (status.state === 'committed') return 4
  if (status.state === 'saving') return 3
  if (status.state === 'learning' || status.state === 'reading') return 2
  return 1
}

function FixPanel({ collection, question, sources, reportId, onCancel, onAskAgain }: {
  collection: CollectionSummary
  question: string
  sources: AskSource[]
  reportId: string | null
  onCancel: () => void
  onAskAgain: () => void
}) {
  const [text, setText] = useState('')
  const [outdated, setOutdated] = useState(sources[0]?.passageId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [started, setStarted] = useState<ImportStatus | null>(null)
  const { status } = useImportWatch(collection.id, started)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const source = sources.find((candidate) => candidate.passageId === outdated)
    try {
      const body = await api.create<{ import: ImportStatus }>(collectionPath(collection.id, '/corrections'), {
        text: text.trim(), question, ...(source ? { outdated: [{ documentId: source.documentId, textHash: source.textHash }] } : {}), ...(reportId ? { reportId } : {}),
      })
      setStarted(body.import)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  if (started) {
    const step = stepOf(status)
    const failed = status && FINAL.has(status.state) && status.state !== 'committed'
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4" data-fix="">
        {step < 4 && !failed ? (
          <ol className="flex flex-col gap-1 text-sm" aria-label="Fixing">
            {FIX_STEPS.map((label, index) => (
              <li key={label} className={index + 1 < step ? 'text-emerald-700 dark:text-emerald-400' : index + 1 === step ? 'font-medium' : 'text-muted-foreground'}>
                {index + 1 < step ? '✓ ' : index + 1 === step ? '→ ' : '· '}{label}
              </li>
            ))}
          </ol>
        ) : null}
        {failed ? <Banner kind="danger">{status?.error?.message ?? "The correction couldn't be learned."} Nothing was changed. Try again.</Banner> : null}
        {step === 4 ? (
          <Banner kind="ok" title="Fixed." action={<Button type="button" size="sm" onClick={onAskAgain}>Ask again</Button>}>
            New questions on this site and from AI assistants use your correction. Answers already given don't change.
          </Banner>
        ) : null}
      </div>
    )
  }
  return (
    <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={(event) => void save(event)} data-fix="">
      <h3 className="font-semibold">Fix this answer once. It changes everywhere.</h3>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fix-text">What's the right answer?</Label>
        <Textarea id="fix-text" required rows={4} value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {sources.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Which source is out of date?</legend>
          <RadioGroup value={outdated} onValueChange={setOutdated}>
            {sources.map((source) => (
              <div key={source.passageId} className="flex items-start gap-2">
                <RadioGroupItem id={`outdated-${source.n}`} value={source.passageId} className="mt-0.5" />
                <Label htmlFor={`outdated-${source.n}`} className="font-normal leading-snug">
                  [{source.n}] {source.documentName}{source.page ? `, page ${source.page}` : ''}
                </Label>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <RadioGroupItem id="outdated-none" value="" className="mt-0.5" />
              <Label htmlFor="outdated-none" className="font-normal">None of them. Something is missing.</Label>
            </div>
          </RadioGroup>
        </fieldset>
      ) : null}
      <Note>Insulin saves your correction as a note and learns it, in about a minute. Questions to {collection.name} wait meanwhile. The source you pick stays, marked as corrected.</Note>
      <ActionError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save the correction'}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

export function ReportPanel({ collection, question, answer, answerId, missing = false, onDone, onCancel }: {
  collection: CollectionSummary
  question: string
  answer: string
  answerId: string | null
  missing?: boolean
  onDone: () => void
  onCancel?: () => void
}) {
  const owner = collection.owner.name ?? 'the owner'
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function send(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.create(collectionPath(collection.id, '/reports'), {
        question, answer: answer.slice(0, 8000), note: note.trim() || (missing ? 'Nothing in the collection covers this question.' : undefined), ...(answerId ? { answerId } : {}),
      })
      setSent(true)
      onDone()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  if (sent) {
    return (
      <Banner kind="ok" title={`Sent to ${owner}, the owner.`}>
        {missing ? `${owner} and the collection's admins get an e-mail with your question.` : 'Until it is checked, everyone who gets this answer also sees that it was reported.'}
      </Banner>
    )
  }
  return (
    <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={(event) => void send(event)} data-report="">
      <h3 className="font-semibold">{missing ? `Ask ${owner} to add it` : `Tell ${owner} what's wrong`}</h3>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="report-note">{missing ? 'Anything to add? (optional)' : 'What did you expect?'}</Label>
        <Textarea id="report-note" rows={3} maxLength={2000} placeholder={missing ? 'For example: we need this for EMEA resellers.' : 'For example: the limit went up to $50,000 in October, I think.'}
          value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      <Note>{owner}, the owner, and the collection's admins get an e-mail. A report doesn't change any answer.</Note>
      <ActionError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>{busy ? 'Sending…' : `Send to ${owner}`}</Button>
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  )
}

function WriteAnswerPanel({ collection, question, onAskAgain }: { collection: CollectionSummary; question: string; onAskAgain: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [started, setStarted] = useState<ImportStatus | null>(null)
  const { status } = useImportWatch(collection.id, started)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ import: ImportStatus }>(collectionPath(collection.id, '/notes'), { title: question.slice(0, 200), text: text.trim() })
      setStarted(body.import)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  if (started) {
    const done = status?.state === 'committed'
    return done
      ? <Banner kind="ok" title="Saved and learned." action={<Button type="button" size="sm" onClick={onAskAgain}>Ask again</Button>}>New questions use your answer, cited as a note.</Banner>
      : status && FINAL.has(status.state)
        ? <Banner kind="danger">{status.error?.message ?? "Your answer couldn't be learned."} Nothing was changed. Try again.</Banner>
        : <Banner kind="info">Learning your answer. Questions to {collection.name} wait until it finishes, about a minute.</Banner>
  }
  return (
    <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={(event) => void save(event)}>
      <Label htmlFor="write-answer">Your answer, saved as a note in {collection.name}</Label>
      <Textarea id="write-answer" required rows={4} value={text} onChange={(event) => setText(event.target.value)} />
      <ActionError error={error} />
      <div><Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save the answer'}</Button></div>
      <Badge tone="grey" className="self-start">Cited as “{question.slice(0, 80)}”</Badge>
    </form>
  )
}
