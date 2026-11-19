import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { AnswerView, AskBox } from '../components/Answer.tsx'
import { CollectionCard } from '../components/CollectionParts.tsx'
import { Banner, ErrorState, Loading, Note } from '../components/Feedback.tsx'
import { Card, Page, PageHead } from '../components/Page.tsx'
import { SourceViewer, type SourceTarget } from '../components/SourceViewer.tsx'
import { describeError, quotaOf } from '../lib/api.ts'
import { formatNumber, plural } from '../lib/format.ts'
import type { AttentionCollection, CollectionSummary, Me, Usage } from '../lib/types.ts'
import { useAsk } from '../lib/useAsk.ts'
import { useResource } from '../lib/useResource.ts'
import { canCreate, canEdit, canManageRules, useMe, useSession } from '../session.tsx'

// Home (design J0, J1, J2): before anything exists, the first-visit start; then a question across the collections the
// person picks (at least 1, at most 5: nothing searches every collection by default), what needs their attention, and
// their collections.

const MAX_PICK = 5

export function HomePage() {
  const me = useMe()
  const { collections, collectionsError, reloadCollections } = useSession()
  if (collections === null) return <Page title="Home" crumbs={[['Home']]}><Loading /></Page>
  if (collectionsError && collections.length === 0) {
    return <Page title="Home" crumbs={[['Home']]}><PageHead title="Knowledge" /><ErrorState error={collectionsError} title="Couldn't load your collections" onRetry={() => void reloadCollections()} /></Page>
  }
  if (collections.length === 0) return <FirstVisit me={me} />
  return <Ask me={me} collections={collections} />
}

function FirstVisit({ me }: { me: Me }) {
  const creator = canCreate(me)
  return (
    <Page title="Home" crumbs={[['Home']]}>
      <div className="flex flex-col gap-3 pt-2">
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">Your team's knowledge, answered with sources.</h1>
        <p className="max-w-3xl text-base text-muted-foreground">
          Add files, web pages and notes. Check what Insulin learned. Ask here, or from Claude, ChatGPT and other AI assistants. Every answer shows where it came from, and if nothing covers the question, it won't guess.
        </p>
      </div>
      <ol className="grid gap-3 md:grid-cols-3" aria-label="Getting started">
        <Step n={1} done title="Sign up on insulinapps.com">One account for every Insulin app, with your e-mail address, Google or your company's single sign-on.</Step>
        <Step n={2} done title="Join your organization">Its owners and admins give each person a role in Knowledge: Admin, Editor or Viewer, in Settings › People.</Step>
        <Step n={3} title="Start a collection">
          {creator ? (
            <>
              Name it, say in one sentence what it is for, and add files. No settings to choose.
              <Button asChild className="mt-3 self-start"><Link to="/collections/new">New collection</Link></Button>
            </>
          ) : (
            <>Viewers in Knowledge ask the collections shared with them, and can't start one. Nothing is shared with you yet: ask a colleague who owns a collection to share it with you.</>
          )}
        </Step>
      </ol>
      <Card title="What makes it different">
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          <li><b>No setup.</b> Insulin chooses how to read, store and search your files.</li>
          <li><b>Checkable.</b> See what it learned as plain sentences, each with its source.</li>
          <li><b>Fix once.</b> Correct an answer and every place that asks gets the fix.</li>
          <li><b>Undo anything.</b> Every change saves a restore point.</li>
          <li><b>Private until shared.</b> A new collection is yours alone until you share it.</li>
          <li><b>Yours.</b> Export any collection you own or run, in an open format.</li>
        </ul>
      </Card>
      <Note>New here? The <Link className="underline underline-offset-4" to="/docs">Docs</Link> explain collections, asking, sharing and what each role can do.</Note>
    </Page>
  )
}

function Step({ n, title, done = false, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {done ? <Check className="size-3.5 text-emerald-600" aria-hidden="true" /> : null}Step {n}{done ? ' · done' : ''}
      </span>
      <span className="font-semibold">{title}</span>
      <span className="flex flex-col text-muted-foreground">{children}</span>
    </li>
  )
}

function Ask({ me, collections }: { me: Me; collections: CollectionSummary[] }) {
  const [picked, setPicked] = useState<string[]>(() => collections.slice(0, 1).map((collection) => collection.id))
  const { question, answer, error, busy, ask } = useAsk()
  const [target, setTarget] = useState<SourceTarget | null>(null)
  const attention = useResource<{ collections: AttentionCollection[] }>(canEdit(me) ? '/api/attention' : null)
  const usage = useResource<Usage>(canManageRules(me) ? '/api/usage' : null)
  useEffect(() => {
    setPicked((current) => current.filter((id) => collections.some((collection) => collection.id === id)))
  }, [collections])
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((other) => other !== id) : current.length >= MAX_PICK ? current : [...current, id]))
  const asked = collections.filter((collection) => picked.includes(collection.id))
  const again = useCallback(() => { if (question) void ask(picked, question) }, [ask, picked, question])
  const waiting = attention.data?.collections.filter((collection) => collection.items.length) ?? []
  const quota = quotaOf(error)
  const limits = usage.data?.limits
  const of = (key: string) => limits?.find((limit) => limit.key === key)
  return (
    <Page title="Home" crumbs={[['Home']]}>
      <PageHead title="Knowledge" sub="Your team's knowledge, answered with sources. Ask here, or from your AI assistant." />
      <section className="flex flex-col gap-3" aria-label="Ask across collections">
        <AskBox busy={busy} disabled={picked.length === 0} label="Ask across the collections you picked" placeholder="Ask a question…" onAsk={(text) => void ask(picked, text)} initial={question} />
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Search in">
          <span className="text-sm text-muted-foreground">Search in:</span>
          {collections.map((collection) => (
            <button key={collection.id} type="button" aria-pressed={picked.includes(collection.id)} onClick={() => toggle(collection.id)}
              disabled={!picked.includes(collection.id) && picked.length >= MAX_PICK}
              className="max-w-full truncate rounded-full border px-3 py-1 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground">
              {collection.name}
            </button>
          ))}
        </div>
        <Note>Pick at least one collection, up to {MAX_PICK}. Nothing searches every collection by default.{picked.length === 0 ? ' Pick one to ask.' : ''}</Note>
      </section>
      {busy && !answer ? <Loading label="Looking in the collections you picked…" /> : null}
      {error ? (
        quota ? <Banner kind="warn" title="Knowledge can't answer right now">{quota.message}</Banner> : <Banner kind="danger" title="Couldn't ask">{describeError(error)}</Banner>
      ) : null}
      {answer ? <AnswerView question={question} answer={answer} collections={asked.length ? asked : collections} onOpenSource={setTarget} onAskAgain={again} /> : null}
      {waiting.length ? (
        <Card title="Needs your attention" right={<Button asChild variant="link" size="sm" className="h-auto p-0"><Link to="/attention">Open</Link></Button>}>
          <ul className="flex flex-col divide-y text-sm">
            {waiting.map((collection) => (
              <li key={collection.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 [overflow-wrap:anywhere]">{collection.name}</span>
                <Link className="text-muted-foreground underline-offset-4 hover:underline" to={`/attention?collection=${collection.id}`}>{plural(collection.items.length, 'thing')}</Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <h2 className="mt-2 text-base font-semibold">Your collections</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {collections.map((collection) => <CollectionCard key={collection.id} me={me} collection={collection} />)}
        {canCreate(me) ? (
          <Link to="/collections/new" className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-4 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span className="font-medium">+ New collection</span>
            <span className="text-xs text-muted-foreground">Name it, add files, done</span>
          </Link>
        ) : null}
      </div>
      {limits ? (
        <Note>
          {formatNumber(of('collections')?.used ?? 0)} of {of('collections')?.limit === null ? 'unlimited' : formatNumber(of('collections')?.limit ?? 0)} collections ·{' '}
          {formatNumber(of('questions_month')?.used ?? 0)} of {of('questions_month')?.limit === null ? 'unlimited' : formatNumber(of('questions_month')?.limit ?? 0)} questions this month ·{' '}
          <Link className="underline underline-offset-4" to="/rules">Usage and limits</Link>
        </Note>
      ) : null}
      <SourceViewer target={target} onClose={() => setTarget(null)} />
    </Page>
  )
}
