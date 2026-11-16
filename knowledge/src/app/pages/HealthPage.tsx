import { useState } from 'react'
import { Label } from '@/components/ui/label.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx'
import { Banner, ErrorState, Loading, Note } from '../components/Feedback.tsx'
import { Card, Page, PageHead } from '../components/Page.tsx'
import { formatBytes, formatWhen, formatWhenInline, listState, plural } from '../lib/format.ts'
import type { Health } from '../lib/types.ts'
import { useResource } from '../lib/useResource.ts'
import { canManageRules, useMe } from '../session.tsx'
import { NoPermissionPage } from './NotFoundPage.tsx'

// Health (design J12, Admins in Knowledge): for each collection the admin has a role in, whether it is awake or asleep,
// its last restore point and backup, and any repairs, in plain words; for the organization, totals only. "Engine
// terms" shows the technical names behind the plain words, for operators and self-hosters (the one place they appear).

function awakeLabel(state: string): string {
  switch (state) {
    case 'ready': return 'Awake'
    case 'learning': case 'saving': return 'Awake, learning'
    case 'waking': return 'Waking up'
    case 'waking_from_backup': return 'Coming back from its backup'
    case 'going_back': return 'Going back to an earlier version'
    case 'repairing': return 'Awake, repairing'
    case 'deleting': return 'Being deleted'
    case 'empty': return 'Asleep, nothing learned yet'
    default: return 'Asleep'
  }
}

/** What each plain state is underneath, for "Engine terms" (design section 06's last column). */
const ENGINE_TERMS: Record<string, string> = {
  ready: 'container running, query process loaded',
  asleep: 'container stopped after the idle timeout',
  empty: 'Durable Object created, no snapshot yet',
  waking: 'start from the latest snapshot, verify its checksums, open the databases',
  waking_from_backup: 'snapshot expired or engine changed: import the latest backup, new restore point',
  learning: 'batch running; query process stopped',
  saving: 'quiesce, stats, manifest, snapshot, one Durable Object transaction',
  going_back: 'start from an older snapshot and verify its own manifest',
  repairing: 'integrity check failed: answering from the previous restore point or the latest backup',
  deleting: 'deletion protocol running',
}

export function HealthPage() {
  const me = useMe()
  const allowed = canManageRules(me)
  const health = useResource<Health>(allowed ? '/api/health' : null)
  const [engineTerms, setEngineTerms] = useState(false)
  if (!allowed) return <NoPermissionPage title="Health" message="Health is for Admins in Knowledge." />
  const data = health.data
  return (
    <Page title="Health" crumbs={[['Admin'], ['Health']]} wide>
      <PageHead title="Health" sub="How the collections you have a role in are doing, in plain words. Collections you have no role in aren't listed; your organization's totals are below."
        actions={
          <div className="flex items-center gap-2">
            <Switch id="engine-terms" checked={engineTerms} onCheckedChange={setEngineTerms} />
            <Label htmlFor="engine-terms" className="font-normal">Engine terms</Label>
          </div>
        } />
      {health.loading ? <Loading /> : health.error || !data ? <ErrorState error={health.error} onRetry={() => void health.reload()} /> : (
        <>
          {!data.engine.reachable ? <Banner kind="warn" title="Knowledge's engine isn't answering right now">Collections can't be asked or changed until it answers again. Everything already learned is kept.</Banner> : null}
          <Card title="Your collections">
            {data.collections.length ? (
              <div className="@container">
              <ul className="flex flex-col divide-y @3xl:hidden" aria-label="Your collections' health">
                {data.collections.map((collection) => (
                  <li key={collection.id} className="flex flex-col gap-1 py-3 text-sm">
                    <span className="font-medium [overflow-wrap:anywhere]">{collection.name}</span>
                    <span>{awakeLabel(listState(collection))} · {plural(collection.documents, 'document')}</span>
                    <span className="text-xs text-muted-foreground">Last saved {formatWhenInline(collection.lastRestorePointAt)} · backed up {collection.lastBackupAt ? formatWhenInline(collection.lastBackupAt) : 'not yet'} · last used {formatWhenInline(collection.lastUsedAt)}</span>
                    <span className={collection.state === 'repairing' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}>
                      {collection.state === 'repairing' ? 'Answering from an earlier version while Insulin repairs it' : 'No repairs needed'}
                    </span>
                    {engineTerms ? <span className="font-mono text-xs text-muted-foreground" data-engine-terms="">{collection.state} · version {collection.version} · {ENGINE_TERMS[collection.state] ?? ''}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="hidden @3xl:block">
                <Table aria-label="Your collections' health">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Collection</TableHead><TableHead>State</TableHead><TableHead>Last restore point</TableHead><TableHead>Last backup</TableHead><TableHead>Repairs</TableHead><TableHead>Last used</TableHead>
                      {engineTerms ? <TableHead>Engine terms</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.collections.map((collection) => (
                      <TableRow key={collection.id}>
                        <TableCell className="max-w-64 font-medium whitespace-normal [overflow-wrap:anywhere]">{collection.name}</TableCell>
                        <TableCell>{awakeLabel(listState(collection))}<div className="text-xs text-muted-foreground">{plural(collection.documents, 'document')}</div></TableCell>
                        <TableCell>{formatWhen(collection.lastRestorePointAt)}</TableCell>
                        <TableCell>{collection.lastBackupAt ? formatWhen(collection.lastBackupAt) : 'Not yet'}</TableCell>
                        <TableCell className={collection.state === 'repairing' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}>
                          {collection.state === 'repairing' ? 'Answering from an earlier version while Insulin repairs it' : 'None needed'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatWhen(collection.lastUsedAt)}</TableCell>
                        {engineTerms ? (
                          <TableCell className="max-w-80 font-mono text-xs whitespace-normal text-muted-foreground" data-engine-terms="">
                            {collection.state} · version {collection.version}<br />{ENGINE_TERMS[collection.state] ?? ''}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              </div>
            ) : <Note>You have no role in any collection yet.</Note>}
          </Card>
          <Card title="Your organization">
            <p className="text-sm">
              {plural(data.organization.collections, 'collection')} · {plural(data.organization.documents, 'document')} · {formatBytes(data.organization.bytes)} stored ·{' '}
              {plural(data.organization.awake ?? 0, 'collection')} awake now · {plural(data.organization.learning ?? 0, 'collection')} learning · {plural(data.organization.kept_ready ?? 0, 'collection')} kept ready
            </p>
            <Note>Totals only: Health shows nothing of collections you have no role in.</Note>
          </Card>
          {engineTerms ? (
            <Card title="Engine terms" description="The technical names behind the plain words, for operators and people who run Knowledge themselves.">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-engine-terms="">
                <dt className="text-muted-foreground">Engine</dt><dd className="font-mono text-xs">{data.engine.reachable ? data.engine.label ?? 'answering' : 'not answering'}</dd>
                <dt className="text-muted-foreground">Collection</dt><dd>One Durable Object and container per collection, with its own Cognee dataset</dd>
                <dt className="text-muted-foreground">Restore point</dt><dd>Container snapshot and Durable Object checkpoint, written in one transaction</dd>
                <dt className="text-muted-foreground">Backup</dt><dd>A daily export of the collection to R2, kept 30 days; the latest kept as long as the collection exists</dd>
                <dt className="text-muted-foreground">Awake now</dt><dd>{plural(data.organization.awake ?? 0, 'container')} running</dd>
              </dl>
            </Card>
          ) : null}
        </>
      )}
    </Page>
  )
}
