import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { AddSources } from '../components/AddSources.tsx'
import { AnswerView, AskBox } from '../components/Answer.tsx'
import { AssistantsSwitch, KeepReadyForm } from '../components/CollectionSettings.tsx'
import { FactList } from '../components/FactList.tsx'
import { ActionError, Banner, Loading, Note } from '../components/Feedback.tsx'
import { FINAL, ImportProgress, useImportWatch } from '../components/ImportProgress.tsx'
import { Card, Page, PageHead } from '../components/Page.tsx'
import { SharePanel } from '../components/SharePanel.tsx'
import { SourceViewer, type SourceTarget } from '../components/SourceViewer.tsx'
import { api, collectionPath, describeError, quotaOf } from '../lib/api.ts'
import { plural } from '../lib/format.ts'
import { suggestedQuestions } from '../lib/suggestions.ts'
import type { CollectionDetail, CollectionSummary, Fact, ImportStatus } from '../lib/types.ts'
import { useAsk } from '../lib/useAsk.ts'
import { canCreate, useMe, useSession } from '../session.tsx'
import { NoPermissionPage } from './NotFoundPage.tsx'

// A new collection (design J1, COL-01, COL-03): what it is for, what it knows (files, a web page or a note, with files
// that can't be learned named before anything starts), learning, what it learned (facts to check, and questions to try
// made from them) and sharing. It is private to the person who starts it, its owner, until they share it.

const STEPS = ['What it is for', 'Add what you know', 'Learning', 'What it learned', 'Share it'] as const

/** How many facts "What it learned" shows to check; the questions to try are made from these. */
const FACTS_TO_CHECK = 8

/** Whether "What it learned" has the collection's counts yet: they are read again once learning is done. */
type Counts = 'counting' | 'counted' | 'unknown'

export function NewCollectionPage() {
  const me = useMe()
  const navigate = useNavigate()
  const { reloadCollections } = useSession()
  const [step, setStep] = useState(1)
  const [collection, setCollection] = useState<CollectionSummary | null>(null)
  const [started, setStarted] = useState<ImportStatus | null>(null)
  const [target, setTarget] = useState<SourceTarget | null>(null)
  const [counts, setCounts] = useState<Counts>('counting')

  const refresh = useCallback(async (id: string) => {
    const body = await api.get<CollectionDetail>(collectionPath(id))
    // The engine's counts are those of what it just learned; the collection's own catch up with them a moment later.
    const learned = body.engine?.counts
    setCollection(learned ? { ...body.collection, documents: learned.documents, facts: learned.facts } : body.collection)
  }, [])

  if (!canCreate(me)) {
    return <NoPermissionPage title="New collection" message="Viewers in Knowledge can ask the collections shared with them and report problems, but can't start collections. Ask an Editor or Admin in your organization." />
  }
  return (
    <Page title="New collection" crumbs={[['Collections', '/collections'], ['New collection']]}>
      <PageHead title="New collection" />
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index + 1 === step ? 'step' : undefined}
            className={index + 1 === step ? 'font-semibold' : index + 1 < step ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'text-muted-foreground'}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      {step === 1 ? (
        <Purpose onCreated={(created) => { setCollection(created); setStep(2); void reloadCollections() }} />
      ) : null}
      {step === 2 && collection ? (
        <Card title="Add what you know" description="Add files, a web page, or write a few lines yourself, or start from another collection's export. You can add more any time.">
          <AddSources collectionId={collection.id} collectionName={collection.name} initialMode="files" fromExport onStarted={(status) => { setStarted(status); setStep(3) }} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button type="button" variant="ghost" asChild><Link to={`/collections/${collection.id}`}>Skip for now</Link></Button>
          </div>
        </Card>
      ) : null}
      {step === 3 && collection && started ? (
        <Learning collection={collection} started={started}
          onLearned={() => {
            setCounts('counting')
            refresh(collection.id).then(() => setCounts('counted'), () => setCounts('unknown'))
            void reloadCollections()
            setStep(4)
          }}
          onRetry={() => setStep(2)}
          onContinue={() => { void reloadCollections(); setStep(5) }} />
      ) : null}
      {step === 4 && collection ? (
        <Learned collection={collection} counts={counts} onOpenSource={setTarget} onNext={() => setStep(5)} />
      ) : null}
      {step === 5 && collection ? (
        <div className="@container"><div className="grid items-start gap-4 @4xl:grid-cols-2">
          <SharePanel collection={collection} canShare roleNote="You own it." />
          <Card title="Settings" description="You can change these, and the sharing, any time in the collection's Sharing tab.">
            <AssistantsSwitch collection={collection} onSaved={setCollection} />
            <div className="flex flex-col gap-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Keep it ready</h3>
              <KeepReadyForm collection={collection} onSaved={setCollection} />
            </div>
            <div className="flex justify-end border-t pt-4">
              <Button type="button" onClick={() => { void reloadCollections(); navigate(`/collections/${collection.id}`) }}>Finish</Button>
            </div>
          </Card>
        </div></div>
      ) : null}
      <SourceViewer target={target} onClose={() => setTarget(null)} />
    </Page>
  )
}

function Purpose({ onCreated }: { onCreated: (collection: CollectionSummary) => void }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = await api.create<{ collection: CollectionSummary }>('/api/collections', { name: name.trim(), purpose: purpose.trim() })
      onCreated(body.collection)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const quota = quotaOf(error)
  return (
    <Card title="What should Insulin learn about?">
      <form className="flex max-w-2xl flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-name">Name</Label>
          <Input id="new-name" required maxLength={200} placeholder="For example: Renewals playbook" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-purpose">In one sentence, what is it for?</Label>
          <Textarea id="new-purpose" rows={2} maxLength={500} placeholder="For example: How we run renewals: timeline, discounts and churn risk." value={purpose} onChange={(event) => setPurpose(event.target.value)} />
          <Note>AI assistants read this to decide when to ask the collection.</Note>
        </div>
        <Banner kind="info" title="Private to you until you share it.">You'll be its owner. In the last step you can share it with everyone in your organization or with specific people, like a shared document.</Banner>
        <Note>No technical settings. Insulin chooses how to read, store and search your files.</Note>
        {quota ? <Banner kind="warn" title="Your organization is at a limit">{quota.message}</Banner> : <ActionError error={error} />}
        <div><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Next'}</Button></div>
      </form>
    </Card>
  )
}

function Learning({ collection, started, onLearned, onRetry, onContinue }: { collection: CollectionSummary; started: ImportStatus; onLearned: () => void; onRetry: () => void; onContinue: () => void }) {
  const { status, error } = useImportWatch(collection.id, started, (final) => { if (final.state === 'committed' || final.state === 'duplicate') onLearned() })
  const current = status ?? started
  const failed = FINAL.has(current.state) && current.state !== 'committed' && current.state !== 'duplicate'
  return (
    <div className="flex flex-col gap-3">
      <ImportProgress status={current} collectionName={collection.name} title="Learning your files" error={error} />
      {failed ? <div><Button type="button" variant="outline" onClick={onRetry}>Add files again</Button></div> : null}
      {current.state === 'waiting' ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Note>Nothing to check yet: you can share it now, and it learns on the 1st by itself.</Note>
          <Button type="button" onClick={onContinue}>Continue</Button>
        </div>
      ) : null}
    </div>
  )
}

function Learned({ collection, counts, onOpenSource, onNext }: { collection: CollectionSummary; counts: Counts; onOpenSource: (target: SourceTarget) => void; onNext: () => void }) {
  const { question, answer, error, busy, ask } = useAsk()
  const again = useCallback(() => { if (question) void ask([collection.id], question) }, [ask, collection.id, question])
  // The facts shown to check, as the list loaded them, make the questions to try.
  const [facts, setFacts] = useState<Fact[]>([])
  const suggestions = useMemo(() => suggestedQuestions(facts.slice(0, FACTS_TO_CHECK)), [facts])
  // A question picked is put in the box (a new box each time, so it replaces whatever was typed) and asked.
  const [picked, setPicked] = useState({ text: '', times: 0 })
  function pick(text: string) {
    setPicked((current) => ({ text, times: current.times + 1 }))
    void ask([collection.id], text)
  }
  return (
    <Card title="Here's what Insulin learned">
      {counts === 'counting' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner role={undefined} aria-label={undefined} aria-hidden="true" />Counting what {collection.name} learned…</p>
      ) : counts === 'counted' ? (
        <p className="text-sm">{collection.name} now has {plural(collection.documents, 'document')} and {plural(collection.facts, 'fact')}.</p>
      ) : null}
      <h3 className="text-sm font-semibold">Check the most important facts</h3>
      <FactList collection={collection} editor limit={FACTS_TO_CHECK} search={false} onLoaded={setFacts} onOpenSource={(target) => onOpenSource({ collectionId: collection.id, ...target })} />
      <h3 className="text-sm font-semibold">Try a question</h3>
      {suggestions.length ? (
        <div className="flex flex-col gap-2">
          <Note>Pick one made from the facts above, or ask your own.</Note>
          <ul className="flex flex-col items-start gap-2" aria-label="Questions to try">
            {suggestions.map((text) => (
              <li key={text} className="max-w-full">
                <Button type="button" variant="outline" size="sm" className="h-auto max-w-full justify-start py-1.5 text-left whitespace-normal [overflow-wrap:anywhere]" disabled={busy}
                  onClick={() => pick(text)}>
                  {text}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <AskBox key={picked.times} initial={picked.text} busy={busy} placeholder={`Ask a question about ${collection.name}…`} onAsk={(text) => void ask([collection.id], text)} />
      {busy && !answer ? <Loading label={`Looking in ${collection.name}…`} /> : null}
      {error ? <Banner kind="danger" title="Couldn't ask">{describeError(error)}</Banner> : null}
      {answer ? <AnswerView question={question} answer={answer} collections={[collection]} onOpenSource={onOpenSource} onAskAgain={again} /> : null}
      <div className="flex justify-end"><Button type="button" onClick={onNext}>Next: share it</Button></div>
    </Card>
  )
}
