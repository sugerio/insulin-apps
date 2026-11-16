import { useCallback, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
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
import type { CollectionDetail, CollectionSummary, ImportStatus } from '../lib/types.ts'
import { useAsk } from '../lib/useAsk.ts'
import { canCreate, useMe, useSession } from '../session.tsx'
import { NoPermissionPage } from './NotFoundPage.tsx'

// A new collection (design J1, COL-03): what it is for, what it knows (files, a web page or a note, with files that
// can't be learned named before anything starts), learning, what it learned (facts to check and a question to try),
// and sharing. It is private to the person who starts it, its owner, until they share it.

const STEPS = ['What it is for', 'Add what you know', 'Learning', 'What it learned', 'Share it'] as const

export function NewCollectionPage() {
  const me = useMe()
  const navigate = useNavigate()
  const { reloadCollections } = useSession()
  const [step, setStep] = useState(1)
  const [collection, setCollection] = useState<CollectionSummary | null>(null)
  const [started, setStarted] = useState<ImportStatus | null>(null)
  const [target, setTarget] = useState<SourceTarget | null>(null)

  const refresh = useCallback(async (id: string) => {
    const body = await api.get<CollectionDetail>(collectionPath(id))
    setCollection(body.collection)
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
        <Card title="Add what you know" description="Add files, a web page, or write a few lines yourself. You can add more any time.">
          <AddSources collectionId={collection.id} collectionName={collection.name} initialMode="files" onStarted={(status) => { setStarted(status); setStep(3) }} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button type="button" variant="ghost" asChild><Link to={`/collections/${collection.id}`}>Skip for now</Link></Button>
          </div>
        </Card>
      ) : null}
      {step === 3 && collection && started ? (
        <Learning collection={collection} started={started} onLearned={() => { void refresh(collection.id); void reloadCollections(); setStep(4) }} onRetry={() => setStep(2)} />
      ) : null}
      {step === 4 && collection ? (
        <Learned collection={collection} onOpenSource={setTarget} onNext={() => setStep(5)} />
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

function Learning({ collection, started, onLearned, onRetry }: { collection: CollectionSummary; started: ImportStatus; onLearned: () => void; onRetry: () => void }) {
  const { status, error } = useImportWatch(collection.id, started, (final) => { if (final.state === 'committed' || final.state === 'duplicate') onLearned() })
  const current = status ?? started
  const failed = FINAL.has(current.state) && current.state !== 'committed' && current.state !== 'duplicate'
  return (
    <div className="flex flex-col gap-3">
      <ImportProgress status={current} collectionName={collection.name} title="Learning your files" error={error} />
      {failed ? <div><Button type="button" variant="outline" onClick={onRetry}>Add files again</Button></div> : null}
    </div>
  )
}

function Learned({ collection, onOpenSource, onNext }: { collection: CollectionSummary; onOpenSource: (target: SourceTarget) => void; onNext: () => void }) {
  const { question, answer, error, busy, ask } = useAsk()
  const again = useCallback(() => { if (question) void ask([collection.id], question) }, [ask, collection.id, question])
  return (
    <Card title="Here's what Insulin learned">
      <p className="text-sm">{collection.name} now has {plural(collection.documents, 'document')} and {plural(collection.facts, 'fact')}.</p>
      <h3 className="text-sm font-semibold">Check the most important facts</h3>
      <FactList collection={collection} editor limit={8} search={false} onOpenSource={(target) => onOpenSource({ collectionId: collection.id, ...target })} />
      <h3 className="text-sm font-semibold">Try a question</h3>
      <AskBox busy={busy} placeholder={`Ask a question about ${collection.name}…`} onAsk={(text) => void ask([collection.id], text)} />
      {busy && !answer ? <Loading label={`Looking in ${collection.name}…`} /> : null}
      {error ? <Banner kind="danger" title="Couldn't ask">{describeError(error)}</Banner> : null}
      {answer ? <AnswerView question={question} answer={answer} collections={[collection]} onOpenSource={onOpenSource} onAskAgain={again} /> : null}
      <div className="flex justify-end"><Button type="button" onClick={onNext}>Next: share it</Button></div>
    </Card>
  )
}
