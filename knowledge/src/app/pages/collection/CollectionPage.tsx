import { useCallback, useEffect } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { RoleBadge, StateBadge } from '../../components/CollectionParts.tsx'
import { Banner, ErrorState, Loading } from '../../components/Feedback.tsx'
import { Page, PageHead } from '../../components/Page.tsx'
import { SourceViewer, type SourceTarget } from '../../components/SourceViewer.tsx'
import { collectionPath, describeError, isApiError } from '../../lib/api.ts'
import { listState, sharingSummary } from '../../lib/format.ts'
import type { CollectionDetail } from '../../lib/types.ts'
import { useResource } from '../../lib/useResource.ts'
import { useMe, useSession } from '../../session.tsx'
import { AskTab } from './AskTab.tsx'
import { HistoryTab } from './HistoryTab.tsx'
import { KnowsTab } from './KnowsTab.tsx'
import { OverviewTab } from './OverviewTab.tsx'
import { SharingTab } from './SharingTab.tsx'
import { SourcesTab } from './SourcesTab.tsx'

// A collection (design section 07): Overview, Ask, Sources, What it knows, Sharing and History, for anyone with a role
// in it; what each tab offers follows the person's role there (the server checks every action again). A source opens
// beside any tab, from the address (`?source=<id>&from=&to=`), so an assistant's link lands on the exact words.

export const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'ask', label: 'Ask' },
  { key: 'sources', label: 'Sources' },
  { key: 'knows', label: 'What it knows' },
  { key: 'sharing', label: 'Sharing' },
  { key: 'history', label: 'History' },
] as const
export type TabKey = (typeof TABS)[number]['key']

/** States that change on their own: the page checks again every few seconds while one lasts. */
const MOVING = new Set(['waking', 'waking_from_backup', 'learning', 'saving', 'going_back', 'repairing', 'deleting'])

export interface TabProps {
  detail: CollectionDetail
  reload: () => Promise<void>
  openSource: (target: Omit<SourceTarget, 'collectionId'>) => void
}

export function CollectionPage() {
  const me = useMe()
  const { id = '', tab: rawTab } = useParams()
  const navigate = useNavigate()
  const { reloadCollections } = useSession()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find((entry) => entry.key === rawTab)?.key ?? (rawTab === undefined ? 'overview' : null)) as TabKey | null
  const first = useResource<CollectionDetail>(collectionPath(id))
  const state = first.data?.engine?.state ?? first.data?.collection.state ?? ''
  const live = useResource<CollectionDetail>(MOVING.has(state) ? collectionPath(id) : null, { pollMs: 2500 })
  const detail = live.data ?? first.data
  const reload = useCallback(async () => {
    await first.reload()
    await reloadCollections()
  }, [first, reloadCollections])

  // A state that settles (learning finished, woke up, went back) reloads the page's data once.
  const liveState = live.data ? live.data.engine?.state ?? live.data.collection.state : null
  const reloadFirst = first.reload
  useEffect(() => {
    if (liveState && !MOVING.has(liveState)) void reloadFirst()
  }, [liveState, reloadFirst])

  const sourceId = params.get('source')
  const target: SourceTarget | null = sourceId ? {
    collectionId: id,
    documentId: sourceId,
    start: params.has('from') ? Number(params.get('from')) : null,
    end: params.has('to') ? Number(params.get('to')) : null,
    find: params.get('find'),
  } : null
  const openSource = useCallback((next: Omit<SourceTarget, 'collectionId'>) => {
    const search = new URLSearchParams()
    search.set('source', next.documentId)
    if (typeof next.start === 'number' && typeof next.end === 'number') {
      search.set('from', String(next.start))
      search.set('to', String(next.end))
    }
    if (next.find) search.set('find', next.find)
    setParams(search, { replace: false })
  }, [setParams])
  const closeSource = () => setParams(new URLSearchParams(), { replace: false })

  if (first.loading && !detail) return <Page title="Collection" crumbs={[['Collections', '/collections'], ['…']]}><Loading /></Page>
  if (!detail) {
    const status = isApiError(first.error) ? first.error.status : 0
    const title = status === 403 ? 'No access' : status === 404 ? 'Not found' : "Couldn't open this collection"
    return (
      <Page title={title} crumbs={[['Collections', '/collections'], [title]]}>
        <PageHead title={status === 403 ? "You don't have access to this collection" : status === 404 ? "There's no such collection" : title} />
        {status === 403 || status === 404 ? (
          <Banner kind="info">{describeError(first.error)}</Banner>
        ) : <ErrorState error={first.error} onRetry={() => void first.reload()} />}
        <div><Button asChild variant="outline"><Link to="/collections">See your collections</Link></Button></div>
      </Page>
    )
  }
  if (tab === null) {
    return (
      <Page title="Not found" crumbs={[['Collections', '/collections'], [detail.collection.name, `/collections/${id}`], ['Not found']]}>
        <PageHead title="There's no such tab" />
        <div><Button asChild variant="outline"><Link to={`/collections/${id}`}>Open the collection</Link></Button></div>
      </Page>
    )
  }
  const { collection } = detail
  const label = TABS.find((entry) => entry.key === tab)!.label
  const props: TabProps = { detail, reload, openSource }
  return (
    <Page title={`${label} · ${collection.name}`} crumbs={[['Collections', '/collections'], [collection.name, `/collections/${id}`], [label]]}>
      <PageHead title={collection.name} after={<StateBadge state={detail.engine?.state ?? listState(collection)} />}
        sub={collection.purpose || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Owner {collection.owner.name ?? 'unknown'}{collection.owner.id === me.user.id ? ' (you)' : ''} · {sharingSummary(collection.sharing)}</span>
            <RoleBadge me={me} collection={collection} />
          </div>
        } />
      <nav aria-label="Collection" className="-mx-4 overflow-x-auto px-4">
        <ul className="flex min-w-max gap-1 border-b">
          {TABS.map((entry) => (
            <li key={entry.key}>
              <Link to={entry.key === 'overview' ? `/collections/${id}` : `/collections/${id}/${entry.key}`} aria-current={entry.key === tab ? 'page' : undefined}
                className="-mb-px inline-flex h-9 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground">
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === 'overview' ? <OverviewTab {...props} /> : null}
      {tab === 'ask' ? <AskTab {...props} /> : null}
      {tab === 'sources' ? <SourcesTab {...props} /> : null}
      {tab === 'knows' ? <KnowsTab {...props} /> : null}
      {tab === 'sharing' ? <SharingTab {...props} onDeleted={() => { void reloadCollections(); navigate('/collections') }} /> : null}
      {tab === 'history' ? <HistoryTab {...props} /> : null}
      <SourceViewer target={target} onClose={closeSource} />
    </Page>
  )
}
