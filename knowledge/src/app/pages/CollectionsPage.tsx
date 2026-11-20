import { useContext, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx'
import { StateBadge } from '../components/CollectionParts.tsx'
import { DeleteCollectionDialog } from '../components/DeleteCollection.tsx'
import { ActionError, Banner, ErrorState, Loading, Note } from '../components/Feedback.tsx'
import { Card, Page, PageHead } from '../components/Page.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { formatBytes, formatDay, listState, plural, ROLE_LABEL, sharingSummary } from '../lib/format.ts'
import { PlatformAccountContext } from '../lib/platform.ts'
import type { OtherCollection } from '../lib/types.ts'
import { useResource } from '../lib/useResource.ts'
import { canCreate, useMe, useSession } from '../session.tsx'

// Collections (design J7b, ACC-01, ACC-04): the person's own and those shared with them, with their role in each; and,
// for owners of the organization, "Other collections in <organization>": basic information only (no purpose, no
// contents), and delete after typing the name.

export function CollectionsPage() {
  const me = useMe()
  const { collections, collectionsError, reloadCollections } = useSession()
  const organization = useContext(PlatformAccountContext)?.organization?.name ?? 'your organization'
  const others = useResource<{ collections: OtherCollection[] }>(me.isOrganizationOwner ? '/api/collections/others' : null)
  const [deleting, setDeleting] = useState<OtherCollection | null>(null)
  const [deleted, setDeleted] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  // An organization owner may turn keep-ready off on any collection, without a role in it (it uses the organization's
  // awake hours).
  async function stopKeepReady(collection: OtherCollection) {
    setError(null)
    setDeleted(null)
    try {
      await api.patch(collectionPath(collection.id), { keepReady: null })
      setDeleted(`Keep-ready is off for “${collection.name}”. It sleeps 10 minutes after the last question now.`)
      await others.reload()
    } catch (failure) {
      setError(failure)
    }
  }
  const actions = (collection: OtherCollection) => (
    <div className="flex flex-wrap gap-2">
      {collection.keepReady ? <Button type="button" variant="outline" size="sm" onClick={() => void stopKeepReady(collection)}>Turn off keep-ready</Button> : null}
      <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting(collection)}>Delete…</Button>
    </div>
  )
  return (
    <Page title="Collections" crumbs={[['Collections']]}>
      <PageHead title="Collections" sub="A collection is files, web pages and notes about one subject, with its own owner, sharing and history."
        actions={canCreate(me) ? <Button asChild><Link to="/collections/new">New collection</Link></Button> : null} />
      {deleted ? <Banner kind="ok">{deleted}</Banner> : null}
      <ActionError error={error} />
      {collections === null ? <Loading /> : collectionsError ? (
        <ErrorState error={collectionsError} title="Couldn't load your collections" onRetry={() => void reloadCollections()} />
      ) : (
        <Card title="Your collections" description="Yours, and those shared with you. Your role in each decides what you can do there.">
          {collections.length ? (
            <div className="@container">
              <ul className="flex flex-col divide-y @3xl:hidden" aria-label="Your collections">
                {collections.map((collection) => (
                  <li key={collection.id} className="flex flex-col gap-1 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link className="font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline" to={`/collections/${collection.id}`}>{collection.name}</Link>
                      <StateBadge state={listState(collection)} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Your role: {collection.role ? ROLE_LABEL[collection.role] : '–'} · owner {collection.owner.name ?? '–'}{collection.owner.id === me.user.id ? ' (you)' : ''} · {plural(collection.documents, 'document')} · {sharingSummary(collection.sharing)}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="hidden @3xl:block">
                <Table aria-label="Your collections">
                  <TableHeader>
                    <TableRow><TableHead>Collection</TableHead><TableHead>Your role</TableHead><TableHead>Owner</TableHead><TableHead>State</TableHead><TableHead className="text-right">Documents</TableHead><TableHead>Sharing</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {collections.map((collection) => (
                      <TableRow key={collection.id}>
                        <TableCell className="max-w-72 whitespace-normal">
                          <Link className="font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline" to={`/collections/${collection.id}`}>{collection.name}</Link>
                          {collection.purpose ? <div className="line-clamp-1 text-xs text-muted-foreground">{collection.purpose}</div> : null}
                        </TableCell>
                        <TableCell>{collection.role ? ROLE_LABEL[collection.role] : '–'}</TableCell>
                        <TableCell>{collection.owner.name ?? '–'}{collection.owner.id === me.user.id ? ' (you)' : ''}</TableCell>
                        <TableCell><StateBadge state={listState(collection)} /></TableCell>
                        <TableCell className="text-right tabular-nums">{collection.documents}</TableCell>
                        <TableCell className="text-muted-foreground">{sharingSummary(collection.sharing)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : (
            <Note>{canCreate(me) ? 'No collections yet. Start one with New collection.' : 'Nothing is shared with you yet. Ask a colleague who owns a collection to share it with you.'}</Note>
          )}
          {canCreate(me) ? null : (
            <Note>Viewers in Knowledge can ask the collections shared with them, but can't start one. Ask an Editor or Admin of your organization.</Note>
          )}
        </Card>
      )}
      {me.isOrganizationOwner ? (
        <Card title={`Other collections in ${organization}`}
          description={`You see these because you're an owner of ${organization}. You can delete them, but you can't open, ask or change them unless their owner shares them with you.`}>
          {others.loading ? <Loading /> : others.error ? <ErrorState error={others.error} onRetry={() => void others.reload()} /> : others.data?.collections.length ? (
            <div className="@container">
              <ul className="flex flex-col divide-y @4xl:hidden" aria-label={`Other collections in ${organization}`}>
                {others.data.collections.map((collection) => (
                  <li key={collection.id} className="flex flex-col gap-1.5 py-3" data-other-collection="">
                    <span className="font-medium [overflow-wrap:anywhere]">{collection.name}</span>
                    <p className="text-xs text-muted-foreground">
                      Owner {collection.owner.name ?? '–'} · created {formatDay(collection.createdAt)} · last used {formatDay(collection.lastUsedAt)} · {plural(collection.documents, 'document')} · {formatBytes(collection.bytes)} · {sharingSummary(collection.sharing)}{collection.keepReady ? ' · kept ready' : ''}
                    </p>
                    {actions(collection)}
                  </li>
                ))}
              </ul>
              <div className="hidden @4xl:block">
                <Table aria-label={`Other collections in ${organization}`}>
                  <TableHeader>
                    <TableRow><TableHead>Collection</TableHead><TableHead>Owner</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead className="text-right">Documents</TableHead><TableHead className="text-right">Stored</TableHead><TableHead>Sharing</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {others.data.collections.map((collection) => (
                      <TableRow key={collection.id}>
                        <TableCell className="max-w-64 font-medium whitespace-normal [overflow-wrap:anywhere]">{collection.name}</TableCell>
                        <TableCell>{collection.owner.name ?? '–'}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDay(collection.createdAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDay(collection.lastUsedAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{collection.documents}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBytes(collection.bytes)}</TableCell>
                        <TableCell className="text-muted-foreground">{sharingSummary(collection.sharing)}{collection.keepReady ? ' · kept ready' : ''}</TableCell>
                        <TableCell>{actions(collection)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : <Note>There are no other collections in {organization}.</Note>}
        </Card>
      ) : null}
      {deleting ? (
        <DeleteCollectionDialog collection={{ id: deleting.id, name: deleting.name, ownerName: deleting.owner.name }} byOrgOwner open onOpenChange={(open) => { if (!open) setDeleting(null) }}
          onDeleted={(state) => {
            setDeleted(state === 'deleted' ? `“${deleting.name}” was deleted. Its files, facts and backups are gone.` : `“${deleting.name}” is being deleted.`)
            setDeleting(null)
            void others.reload()
          }} />
      ) : null}
    </Page>
  )
}
