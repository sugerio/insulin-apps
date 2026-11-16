// Ownership (server/esign/members.ts), for the organization's owners, not in the navigation (an API client's page and
// the Docs link to it): everyone who owns templates or envelopes, and
// taking over everything someone owns, for someone who left or an API client no longer used. Who sees what an API
// client creates is set per OAuth client on the platform's API access page (members.ts, `/api/client-settings`).
import React, { useEffect, useState } from 'react'
import { UserCheck } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { apiJson, canManage, describeError, type Me, type Owner } from './api.ts'
import { Notice, PageHeader } from './parts.ts'

const h = React.createElement
type OwnerRow = Owner & { templates: number; envelopes: number; lastSeenAt?: number }

export function OwnershipPage({ me }: { me: Me }) {
  const manage = canManage(me)
  const orgOwner = me.role === 'OWNER' && manage
  const [owners, setOwners] = useState<OwnerRow[] | null>(null)
  const [confirming, setConfirming] = useState('')
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setOwners((await apiJson<{ owners: OwnerRow[] }>('/api/owners')).owners)
    } catch (error) { setMessage({ text: describeError(error), error: true }) }
  }
  useEffect(() => { if (orgOwner) void load() }, [])
  async function run(work: () => Promise<string>) {
    setBusy(true); setMessage({ text: '', error: false })
    try { const done = await work(); await load(); setMessage({ text: done, error: false }) }
    catch (error) { setMessage({ text: describeError(error), error: true }) }
    finally { setBusy(false) }
  }
  function takeOver(owner: OwnerRow) {
    void run(async () => {
      const moved = await apiJson<{ templates: number; envelopes: number }>(`/api/owners/${encodeURIComponent(owner.id)}/transfer`, { method: 'POST' })
      setConfirming('')
      return `You now own ${moved.templates} ${moved.templates === 1 ? 'template' : 'templates'} and ${moved.envelopes} ${moved.envelopes === 1 ? 'envelope' : 'envelopes'} that were ${owner.name ?? owner.email ?? 'theirs'}'s.`
    })
  }

  // The navigation shows the page to admins too (it can't name owners only): they are told where to look.
  if (!orgOwner) return h('div', { className: 'flex flex-col gap-4' }, h(PageHeader, { title: 'Ownership' }), h(Notice, { message: 'Only your organization\'s owners take over what someone owns. Who sees what an API client creates is set for each OAuth client on API access, in Esign\'s settings.' }))
  const name = (o: { name?: string; email?: string; id: string }) => o.name ?? o.email ?? o.id
  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, { title: 'Ownership', description: 'Every template and envelope is its owner\'s and the people it is shared with. Here, taking over what someone owns. Who sees what an API client creates is set for each OAuth client on API access, in Esign\'s settings.' }),
    h(Notice, { message: message.text, error: message.error }),
    orgOwner ? h(Card, { 'aria-label': 'Owners' },
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Owners')),
        h(CardDescription, null, 'Everyone who owns templates or envelopes. Take over what someone owns when they leave, or when an API client is no longer used: you become its owner, and the people it is shared with keep their roles.')),
      h(CardContent, null, owners === null ? h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading…')
        : h(Table, { 'aria-label': 'Owners' },
          h(TableHeader, null, h(TableRow, null, h(TableHead, null, 'Owner'), h(TableHead, { className: 'text-right' }, 'Templates'), h(TableHead, { className: 'text-right' }, 'Envelopes'), h(TableHead, null, h('span', { className: 'sr-only' }, 'Actions')))),
          h(TableBody, null, ...owners.map((owner) => h(TableRow, { key: owner.id },
            h(TableCell, { className: 'whitespace-normal' }, h('div', { className: 'font-medium' }, owner.id === me.user?.id ? 'You' : name(owner)), h('div', { className: 'text-xs text-muted-foreground' }, owner.kind === 'client' ? 'API client' : owner.email ?? owner.id)),
            h(TableCell, { className: 'text-right tabular-nums' }, String(owner.templates)),
            h(TableCell, { className: 'text-right tabular-nums' }, String(owner.envelopes)),
            h(TableCell, { className: 'text-right' }, owner.id === me.user?.id ? null : confirming === owner.id
              ? h('div', { className: 'flex justify-end gap-2' },
                h(Button, { size: 'sm', variant: 'destructive', disabled: busy, onClick: () => takeOver(owner) }, 'Take over all of it'),
                h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => setConfirming('') }, 'Cancel'))
              : h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => setConfirming(owner.id) }, h(UserCheck, { 'aria-hidden': true }), 'Take over')))))))) : null)
}
