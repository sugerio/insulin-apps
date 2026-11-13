// Envelopes: those the member owns or that are shared with them, newest first, with their status, owner and the
// member's own tags, filtered by either. Those who manage send new ones and run the due work (expiring envelopes past
// a deadline, finishing ones whose signing request didn't).
import React, { useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { Button, buttonVariants } from '../components/ui/button.ts'
import { Card, CardContent } from '../components/ui/card.ts'
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { apiJson, canManage, dateTime, describeError, envelopesPath, listPath, ownerName, STATUS_LABELS, type EnvelopeSummary, type Me, type Scope } from './api.ts'
import { ListFilters } from './ListFilters.ts'
import { Notice, PageHeader, StatusBadge } from './parts.ts'
import { TagList } from './TagsField.ts'
import { Link, navigate } from './router.ts'

const h = React.createElement

/** `status` comes from the address (`/envelopes?status=completed`), so the navigation's status items and the filter agree. */
export function EnvelopesPage({ me, status = '' }: { me: Me; status?: string }) {
  const [envelopes, setEnvelopes] = useState<EnvelopeSummary[] | null>(null)
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<Scope>('')
  const [tags, setTags] = useState<string[]>([])
  const manage = canManage(me)
  const filtered = !!scope || tags.length > 0

  async function load(filter: string) {
    try {
      const data = await apiJson<{ envelopes: EnvelopeSummary[] }>(listPath('/api/envelopes', { status: filter, scope, tags }))
      setEnvelopes(data.envelopes)
    } catch (error) { setMessage({ text: describeError(error), error: true }) }
  }
  useEffect(() => { setEnvelopes(null); void load(status) }, [status, scope, tags.join('\n')])

  async function processDue() {
    setBusy(true)
    setMessage({ text: '', error: false })
    try {
      const counts = await apiJson<{ expired?: number; completed?: number; waiting?: number; failed?: number }>('/api/process-due', { method: 'POST' })
      const parts = [
        counts.expired ? `${counts.expired} expired` : '',
        counts.completed ? `${counts.completed} completed` : '',
        counts.waiting ? `${counts.waiting} still waiting` : '',
        counts.failed ? `${counts.failed} couldn't be finished yet` : '',
      ].filter(Boolean)
      setMessage({ text: parts.length ? `Due work done: ${parts.join(', ')}.` : 'Nothing was due.', error: !!counts.failed })
      await load(status)
    } catch (error) { setMessage({ text: describeError(error), error: true }) }
    finally { setBusy(false) }
  }

  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, {
      title: 'Envelopes',
      description: 'Documents sent for signature that are yours or shared with you, newest first.',
      actions: manage ? [
        h(Button, { key: 'due', variant: 'outline', disabled: busy, onClick: () => void processDue() }, h(RefreshCw, { 'aria-hidden': true }), 'Process due work'),
        h(Link, { key: 'new', to: '/envelopes/new', className: buttonVariants() }, h(Plus, { 'aria-hidden': true }), 'New envelope'),
      ] : null,
    }),
    me.signingEnabled === false ? h(Notice, { message: 'Signing isn\'t set up on this deployment yet, so envelopes can\'t be signed. An administrator of the deployment adds its settings.' }) : null,
    h(Notice, { message: message.text, error: message.error }),
    h('div', { className: 'flex flex-wrap items-end gap-4' },
      h('div', { className: 'flex w-56 flex-col gap-2' },
        h('label', { htmlFor: 'envelope-status', className: 'text-sm font-medium' }, 'Status'),
        h(NativeSelect, { id: 'envelope-status', value: status, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => navigate(envelopesPath(e.target.value)) },
          h(NativeSelectOption, { value: '' }, 'All'),
          ...Object.entries(STATUS_LABELS).map(([value, label]) => h(NativeSelectOption, { key: value, value }, label)))),
      h(ListFilters, { id: 'envelopes', scope, onScope: setScope, onTags: setTags })),
    h(Card, { className: 'py-0' }, h(CardContent, { className: 'px-0' },
      envelopes === null ? h('p', { role: 'status', className: 'p-6 text-sm text-muted-foreground' }, 'Loading envelopes…')
        : envelopes.length === 0 ? h('div', { className: 'flex flex-col items-start gap-2 p-6' },
          h('p', { className: 'text-sm text-muted-foreground' }, status ? 'No envelopes with this status.' : filtered ? 'No envelopes match.' : 'No envelopes yet.'),
          !status && !filtered ? h('p', { className: 'text-sm text-muted-foreground' }, manage ? 'Upload a template, then send an envelope from it. ' : 'Envelopes shared with you appear here. ', h(Link, { to: '/docs/getting-started', className: 'font-medium text-foreground underline underline-offset-4' }, 'How Esign works')) : null)
          : h(Table, { 'aria-label': 'Envelopes' },
            h(TableHeader, null, h(TableRow, null,
              h(TableHead, { className: 'pl-6' }, 'Document'), h(TableHead, null, 'Status'), h(TableHead, null, 'Owner'), h(TableHead, { className: 'pr-6' }, 'Created'))),
            h(TableBody, null, ...envelopes.map((envelope) => h(TableRow, { key: envelope.id },
              h(TableCell, { className: 'pl-6' }, h(Link, { to: `/envelopes/${envelope.id}`, className: 'font-medium underline-offset-4 hover:underline' }, envelope.documentName || 'Untitled document'),
                h('div', { className: 'font-mono text-xs text-muted-foreground' }, envelope.id), h(TagList, { tags: envelope.tags })),
              h(TableCell, null, h(StatusBadge, { status: envelope.status })),
              h(TableCell, { className: 'text-muted-foreground' }, ownerName(envelope.owner, me)),
              h(TableCell, { className: 'pr-6 text-muted-foreground' }, dateTime(envelope.createdAt)))))))))
}
