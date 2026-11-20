import { Link } from 'react-router'
import { listState, ROLE_LABEL, plural, sharingSummary, stateLabel } from '../lib/format.ts'
import type { CollectionRole, CollectionSummary, Me } from '../lib/types.ts'
import { Badge } from './Feedback.tsx'

// Small pieces every collection screen shows: its state, the person's role in it and why, and a card for lists.

export function StateBadge({ state }: { state: string }) {
  const { label, tone } = stateLabel(state)
  return <Badge tone={tone}>{label}</Badge>
}

/** Why the person has the role they have here, in the words the sharing dialog uses. */
export function roleWhy(me: Me, collection: CollectionSummary): string {
  if (!collection.role) return ''
  if (collection.grantedRole === 'OWNER') return 'you own it'
  if (collection.grantedRole && collection.grantedRole !== collection.role) {
    return `shared as ${ROLE_LABEL[collection.grantedRole]}, but your role in Knowledge can only read, so you act as Viewer`
  }
  return collection.sharing.general && collection.grantedRole === collection.sharing.general ? `shared with everyone in your organization` : 'shared with you'
}

export function RoleBadge({ me, collection }: { me: Me; collection: CollectionSummary }) {
  if (!collection.role) return null
  return <Badge tone="grey" title={roleWhy(me, collection)}>Your role: {ROLE_LABEL[collection.role]}</Badge>
}

export const canChange = (role: CollectionRole | null | undefined) => role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR'

export function CollectionCard({ me, collection }: { me: Me; collection: CollectionSummary }) {
  const mine = collection.owner.id === me.user.id
  return (
    <Link to={`/collections/${collection.id}`}
      className="flex min-w-0 flex-col gap-2 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      data-collection-card="">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 font-semibold [overflow-wrap:anywhere]">{collection.name}</h3>
        <StateBadge state={listState(collection)} />
      </div>
      {collection.purpose ? <p className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">{collection.purpose}</p> : null}
      <p className="text-xs text-muted-foreground">
        {plural(collection.documents, 'document')} · {plural(collection.facts, 'fact')} · owner {collection.owner.name ?? 'unknown'}{mine ? ' (you)' : ''}
      </p>
      <p className="text-xs text-muted-foreground">
        {collection.role ? `Your role: ${ROLE_LABEL[collection.role]}` : ''} · {sharingSummary(collection.sharing)}
      </p>
    </Link>
  )
}
