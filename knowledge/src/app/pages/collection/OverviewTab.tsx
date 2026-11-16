import { Link } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { WakeSteps } from '../../components/Answer.tsx'
import { canChange } from '../../components/CollectionParts.tsx'
import { Banner, Note } from '../../components/Feedback.tsx'
import { ImportProgress } from '../../components/ImportProgress.tsx'
import { Card } from '../../components/Page.tsx'
import { collectionPath } from '../../lib/api.ts'
import { formatNumber, formatWhen, keepReadyLabel, plural, stateMessage } from '../../lib/format.ts'
import type { AttentionCollection, FactWithCheck, RestorePoint } from '../../lib/types.ts'
import { useResource } from '../../lib/useResource.ts'
import { describeRestorePoint } from './HistoryTab.tsx'
import type { TabProps } from './CollectionPage.tsx'

// Overview: what the collection covers, its state in plain words (design section 10), the steps while it wakes, its
// keep-ready window, where people ask it, and what needs attention (for those who can change it).

export function OverviewTab({ detail }: TabProps) {
  const { collection, engine, questions } = detail
  const state = engine?.state ?? collection.state
  const editor = canChange(detail.role)
  const facts = useResource<{ facts: FactWithCheck[] }>(collection.facts > 0 ? collectionPath(collection.id, '/facts') : null)
  const attention = useResource<{ collections: AttentionCollection[] }>(editor ? `/api/attention?collection=${encodeURIComponent(collection.id)}` : null)
  const history = useResource<{ restorePoints: RestorePoint[] }>(editor ? null : collectionPath(collection.id, '/history'))
  const items = attention.data?.collections[0]?.items ?? []
  const asked = questions.browser + questions.mcp + questions.api
  const keepReady = collection.keepReady
  const zone = engine?.settings.keepReady?.timeZone
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={formatNumber(collection.documents)} label="documents and notes" />
        <Stat value={formatNumber(collection.facts)} label="facts learned" />
        <Stat value={formatNumber(asked)} label="questions asked" />
        <Stat value={`${formatNumber(detail.awakeHoursThisMonth)} h`} label="awake this month" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Right now" right={<Button asChild size="sm"><Link to={`/collections/${collection.id}/ask`}>Ask it</Link></Button>}>
          <p className="text-sm" data-state-message={state}>{stateMessage(state, collection.name)}</p>
          {state === 'waking' || state === 'waking_from_backup' ? <WakeSteps step={engine?.wake?.step ?? 1} /> : null}
          {engine?.currentImport ? <ImportProgress status={engine.currentImport} collectionName={collection.name} title="Learning now" /> : null}
          {engine && engine.queuedImports > 0 ? <Note>{plural(engine.queuedImports, 'more import')} waiting to start.</Note> : null}
          {keepReady ? (
            keepReady.paused
              ? <Banner kind="warn">Keep-ready for {collection.name} is paused: your organization has used 90% of its awake hours this month. It starts again on the 1st.</Banner>
              : <Note>Kept ready {keepReadyLabel(keepReady)}{zone ? ` (${zone})` : ''}, so answers then take a few seconds.</Note>
          ) : (
            <Note>Sleeps {engine?.settings.awakeMinutes ?? 10} minutes after the last question; the next question wakes it in about a minute. A collection is never lost by sitting unused: after 30 days it comes back from its latest backup.</Note>
          )}
        </Card>
        <Card title="Where people ask it">
          <ul className="flex flex-col divide-y text-sm">
            <li className="flex justify-between gap-2 py-2"><span>This site</span><span className="text-muted-foreground">{plural(questions.browser, 'question')}</span></li>
            <li className="flex justify-between gap-2 py-2"><span>AI assistants</span><span className="text-muted-foreground">{plural(questions.mcp, 'question')}</span></li>
            <li className="flex justify-between gap-2 py-2"><span>API clients</span><span className="text-muted-foreground">{plural(questions.api, 'question')}</span></li>
          </ul>
          {collection.assistants ? null : <Note>AI assistants and API clients are turned off for this collection. Its owner or an admin can turn them on in Sharing.</Note>}
        </Card>
        <Card title="A few things it knows" right={collection.facts > 0 ? <Button asChild variant="link" size="sm" className="h-auto p-0"><Link to={`/collections/${collection.id}/knows`}>See all</Link></Button> : null}>
          {collection.facts === 0 ? (
            <Note>Nothing learned yet. {editor ? <>Add files, a web page or a note in <Link className="underline underline-offset-4" to={`/collections/${collection.id}/sources`}>Sources</Link>.</> : 'Its owner and editors add sources.'}</Note>
          ) : (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
              {(facts.data?.facts ?? []).slice(0, 5).map((fact) => <li key={fact.factId} className="[overflow-wrap:anywhere]">{fact.sentence}</li>)}
            </ul>
          )}
        </Card>
        {editor ? (
          <Card title="Needs your attention" right={items.length ? <Button asChild variant="link" size="sm" className="h-auto p-0"><Link to={`/attention?collection=${collection.id}`}>Open</Link></Button> : null}>
            {attention.loading ? <Note>Checking…</Note> : items.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {items.slice(0, 4).map((item) => (
                  <li key={item.id} className="[overflow-wrap:anywhere]">
                    {item.kind === 'unreadable' ? `Couldn't read “${item.files[0]?.name ?? 'a file'}”` : item.kind === 'hidden' ? `Hidden before learning: ${plural(item.total, 'value')} in “${item.documentName}”` : item.kind === 'needs_check' ? `A correction of “${item.documentName ?? 'a file'}” asks to be checked` : `${item.reportedBy.name ?? 'Someone'} says an answer is wrong`}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-emerald-700 dark:text-emerald-400">Nothing right now.</p>}
          </Card>
        ) : (
          <Card title="Recent changes">
            <ul className="flex flex-col divide-y text-sm">
              {(history.data?.restorePoints ?? []).slice(0, 3).map((point) => (
                <li key={point.version} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{describeRestorePoint(point, history.data?.restorePoints ?? [])}</span>
                  <span className="text-muted-foreground">{formatWhen(point.createdAt)}</span>
                </li>
              ))}
            </ul>
            {history.data && history.data.restorePoints.length === 0 ? <Note>No changes yet.</Note> : null}
          </Card>
        )}
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
