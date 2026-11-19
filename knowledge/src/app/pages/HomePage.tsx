import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import {
  BadgeCheck, Bell, BookOpen, Check, ChevronDown, ChevronRight, Download, FileUp, FolderPlus, Library, ListChecks, Lock,
  MessageCircleQuestionMark, Plus, Sparkles, Undo2, UserPlus, WandSparkles, Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'
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

// Home (design J0, J1, J2): before anything exists, the first-visit start (a headline, the next step, a picture of how
// it works and what makes it different); then a question across the collections the person picks (at least 1, at most
// 5: nothing searches every collection by default), what needs their attention, and their collections. Motion is only
// ever behind motion-safe: (the flow's steps come in one after another and a dot runs along its connectors three
// times), so with reduced motion the page is still.

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

/** An icon in a rounded square, as the home's headers have it. Decorative: the heading beside it says what it is. */
function IconTile({ icon: Drawn, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm', className)}>
      <Drawn className="size-5" focusable="false" />
    </span>
  )
}

function FirstVisit({ me }: { me: Me }) {
  const creator = canCreate(me)
  return (
    <Page title="Home" crumbs={[['Home']]}>
      <div className="flex flex-col items-start gap-5 pt-2" data-home-start="">
        <IconTile icon={Library} className="size-11" />
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Your team's knowledge, answered with sources.</h1>
          <p className="text-base text-muted-foreground">Add what your team knows, then ask here or from your AI assistant.</p>
        </div>
        <GettingStarted creator={creator} />
        <div className="flex flex-wrap items-center gap-2">
          {creator ? (
            <Button asChild size="lg" className="h-10 px-4"><Link to="/collections/new"><Plus aria-hidden="true" />New collection</Link></Button>
          ) : (
            <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm" data-viewer-note="">
              <UserPlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" focusable="false" />
              <span>Nothing is shared with you yet: ask a colleague to share one with you.</span>
            </p>
          )}
          <Button asChild variant="ghost" size="lg" className="h-10 px-3 text-muted-foreground"><Link to="/docs"><BookOpen aria-hidden="true" />Read the Docs</Link></Button>
        </div>
      </div>
      <HowItWorks />
      <Different />
    </Page>
  )
}

/** Getting started as a checklist: the two steps the platform has done, small, then the next one. */
function GettingStarted({ creator }: { creator: boolean }) {
  const steps: { label: string; done: boolean; icon: LucideIcon }[] = [
    { label: 'Signed up', done: true, icon: Check },
    { label: 'Joined your organization', done: true, icon: Check },
    creator ? { label: 'Start a collection', done: false, icon: FolderPlus } : { label: 'Get a collection shared with you', done: false, icon: UserPlus },
  ]
  return (
    <ol aria-label="Getting started" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
      {steps.map((step, index) => {
        const Drawn = step.icon
        return (
          <li key={step.label} aria-current={step.done ? undefined : 'step'} data-done={step.done ? '' : undefined}
            className={cn('flex items-center gap-2', step.done ? 'text-xs text-muted-foreground' : 'text-sm font-medium')}>
            {index > 0 ? <span aria-hidden="true" className="hidden h-px w-6 bg-border sm:block" /> : null}
            <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full',
              step.done ? 'size-5 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'size-6 bg-primary text-primary-foreground')}>
              <Drawn className={step.done ? 'size-3' : 'size-3.5'} focusable="false" />
            </span>
            <span>{step.label}{step.done ? <span className="sr-only">, done</span> : null}</span>
          </li>
        )
      })}
    </ol>
  )
}

const FLOW: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: FileUp, title: 'Add files', detail: 'web pages and notes too' },
  { icon: Sparkles, title: 'Insulin learns', detail: 'facts you can check' },
  { icon: MessageCircleQuestionMark, title: 'Ask', detail: 'here or from your AI assistant' },
  { icon: BadgeCheck, title: 'Answers with sources', detail: "or “I won't guess”" },
]

/** How it works, as a picture: four steps with connectors, down on a phone and across on wider screens. */
function HowItWorks() {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10 sm:gap-6 sm:p-6">
      <h2 id={headingId} className="text-base leading-snug font-semibold">How it works</h2>
      <ol aria-labelledby={headingId} className="grid sm:grid-cols-4" data-flow="">
        {FLOW.map((step, index) => {
          const Drawn = step.icon
          const last = index === FLOW.length - 1
          return (
            <li key={step.title} style={{ animationDelay: `${index * 150}ms` }}
              className="relative flex items-center gap-4 py-4 sm:flex-col sm:gap-3 sm:px-2 sm:py-0 sm:text-center motion-safe:animate-in motion-safe:fill-mode-both motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:animation-duration-500">
              {last ? null : <Connector index={index} />}
              <span aria-hidden="true" className={cn('relative flex size-12 shrink-0 items-center justify-center rounded-full ring-1',
                last ? 'bg-primary text-primary-foreground ring-primary' : 'bg-background ring-foreground/15')}>
                <Drawn className="size-5" focusable="false" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{step.title}</span>
                <span className="text-xs text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/**
 * The dashed line from one step to the next, with an arrowhead; a dot runs along it after the steps have come in, each
 * connector in turn, three times. Without motion only the line and its arrowhead show.
 */
function Connector({ index }: { index: number }) {
  return (
    <span aria-hidden="true" data-connector=""
      className="pointer-events-none absolute top-[calc(50%+1.75rem)] bottom-[calc(1.75rem-50%)] left-6 border-l border-dashed border-foreground/25 sm:top-6 sm:right-[calc(2rem-50%)] sm:bottom-auto sm:left-[calc(50%+2rem)] sm:border-t sm:border-l-0">
      <ChevronDown className="absolute -bottom-2 -left-[7.5px] size-3.5 text-foreground/40 sm:hidden" focusable="false" />
      <ChevronRight className="absolute -top-[7.5px] -right-2 hidden size-3.5 text-foreground/40 sm:block" focusable="false" />
      <span style={{ animationDelay: `${900 + index * 1000}ms` }} data-flow-dot=""
        className="absolute inset-0 hidden motion-safe:block motion-safe:animate-flow-down sm:motion-safe:animate-flow-across">
        <span className="absolute -top-1 -left-[4.5px] size-2 rounded-full bg-primary ring-4 ring-primary/15 sm:-top-[4.5px] sm:-left-1" />
      </span>
    </span>
  )
}

const DIFFERENT: { icon: LucideIcon; title: string; line: string }[] = [
  { icon: WandSparkles, title: 'No setup', line: 'Insulin picks how to read your files.' },
  { icon: ListChecks, title: 'Checkable', line: 'See what it learned, with sources.' },
  { icon: Wrench, title: 'Fix once', line: 'One fix reaches everyone who asks.' },
  { icon: Undo2, title: 'Undo anything', line: 'Every change saves a restore point.' },
  { icon: Lock, title: 'Private until shared', line: 'Yours alone until you share it.' },
  { icon: Download, title: 'Yours to keep', line: 'Export yours in an open format.' },
]

/** What makes it different, as icon tiles: an icon, a few words and one short line each. */
function Different() {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-snug font-semibold">What makes it different</h2>
      <ul aria-labelledby={headingId} className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {DIFFERENT.map((tile) => {
          const Drawn = tile.icon
          return (
            <li key={tile.title} className="flex min-w-0 flex-col gap-2 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 sm:flex-row sm:gap-3">
              <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <Drawn className="size-4.5" focusable="false" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{tile.title}</span>
                <span className="text-sm text-muted-foreground">{tile.line}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The asking home's header: an icon, a short heading and one line. */
function HomeHead({ title, sub }: { title: ReactNode; sub: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <IconTile icon={MessageCircleQuestionMark} />
      <div className="flex min-w-0 flex-col">
        <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        <p className="text-sm text-muted-foreground">{sub}</p>
      </div>
    </div>
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
      <HomeHead title="Ask your collections" sub="Every answer shows its sources." />
      <section className="flex flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10" aria-label="Ask across collections">
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
        <Note>{picked.length === 0 ? 'Pick at least one collection to ask.' : `Up to ${MAX_PICK} at once. Nothing searches every collection by default.`}</Note>
      </section>
      {busy && !answer ? <Loading label="Looking in the collections you picked…" /> : null}
      {error ? (
        quota ? <Banner kind="warn" title="Knowledge can't answer right now">{quota.message}</Banner> : <Banner kind="danger" title="Couldn't ask">{describeError(error)}</Banner>
      ) : null}
      {answer ? <AnswerView question={question} answer={answer} collections={asked.length ? asked : collections} onOpenSource={setTarget} onAskAgain={again} /> : null}
      {waiting.length ? (
        <Card title={<span className="flex items-center gap-2"><Bell className="size-4 text-muted-foreground" aria-hidden="true" focusable="false" />Needs your attention</span>}
          right={<Button asChild variant="link" size="sm" className="h-auto p-0"><Link to="/attention">Open</Link></Button>}>
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
          <Link to="/collections/new" className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-muted"><Plus className="size-4" focusable="false" /></span>
            <span className="font-medium">New collection</span>
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
