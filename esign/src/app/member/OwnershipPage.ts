// Ownership (server/esign/members.ts), for the organization's owners and admins:
// - API clients: each program that has called Esign, and the one person its templates and envelopes are shared with,
//   as admin. Without one, what it creates is its own: nobody else sees it.
// - Owners (organization owners only): everyone who owns templates or envelopes; an organization owner takes over
//   everything someone owns, for someone who left or an API client no longer used.
import React, { useEffect, useState } from 'react'
import { KeyRound, UserCheck } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.ts'
import { checkClass } from '../components/ui/input.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { apiJson, canManage, dateTime, describeError, EMAIL, type Me, type Owner } from './api.ts'
import { Notice, PageHeader } from './parts.ts'
import { MemberEmailField } from './SharePanel.ts'

const h = React.createElement
type Client = { id: string; name?: string; firstSeenAt: number; lastSeenAt: number; shareWith?: { email: string; name?: string; since: number } }
type OwnerRow = Owner & { templates: number; envelopes: number; lastSeenAt?: number }

export function OwnershipPage({ me }: { me: Me }) {
  const manage = canManage(me)
  const orgOwner = me.role === 'OWNER' && manage
  const allowed = (me.role === 'OWNER' || me.role === 'ADMIN') && manage
  const [clients, setClients] = useState<Client[] | null>(null)
  const [owners, setOwners] = useState<OwnerRow[] | null>(null)
  const [editing, setEditing] = useState<{ id: string; email: string; existing: boolean } | null>(null)
  const [confirming, setConfirming] = useState('')
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setClients((await apiJson<{ clients: Client[] }>('/api/api-clients')).clients)
      if (orgOwner) setOwners((await apiJson<{ owners: OwnerRow[] }>('/api/owners')).owners)
    } catch (error) { setMessage({ text: describeError(error), error: true }) }
  }
  useEffect(() => { if (allowed) void load() }, [])
  async function run(work: () => Promise<string>) {
    setBusy(true); setMessage({ text: '', error: false })
    try { const done = await work(); await load(); setMessage({ text: done, error: false }) }
    catch (error) { setMessage({ text: describeError(error), error: true }) }
    finally { setBusy(false) }
  }
  function saveClient(clear = false) {
    if (!editing) return
    const email = editing.email.trim()
    if (!clear && !EMAIL.test(email)) { setMessage({ text: 'Enter the email address of the person to share with.', error: true }); return }
    const { id, existing } = editing
    void run(async () => {
      const answer = await apiJson<{ shared: number }>(`/api/api-clients/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clear ? { shareEmail: null } : { shareEmail: email, shareExisting: existing }) })
      setEditing(null)
      return clear ? 'What it creates from now on is its own again.' : `What it creates from now on is shared with ${email} as admin.${existing ? ` ${answer.shared} it created before ${answer.shared === 1 ? 'was' : 'were'} shared too.` : ''}`
    })
  }
  function takeOver(owner: OwnerRow) {
    void run(async () => {
      const moved = await apiJson<{ templates: number; envelopes: number }>(`/api/owners/${encodeURIComponent(owner.id)}/transfer`, { method: 'POST' })
      setConfirming('')
      return `You now own ${moved.templates} ${moved.templates === 1 ? 'template' : 'templates'} and ${moved.envelopes} ${moved.envelopes === 1 ? 'envelope' : 'envelopes'} that were ${owner.name ?? owner.email ?? 'theirs'}'s.`
    })
  }

  if (!allowed) return h('div', { className: 'flex flex-col gap-4' }, h(PageHeader, { title: 'Ownership' }), h(Notice, { message: 'Only your organization\'s owners and admins manage ownership.' }))
  const name = (o: { name?: string; email?: string; id: string }) => o.name ?? o.email ?? o.id
  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, { title: 'Ownership', description: 'Every template and envelope is its owner\'s and the people it is shared with. Here, whom API clients share with, and taking over what someone owns.' }),
    h(Notice, { message: message.text, error: message.error }),
    h(Card, { 'aria-label': 'API clients' },
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'API clients')),
        h(CardDescription, null, 'Programs that call Esign with an OAuth client of your organization. What each one creates is shared, as admin, with the person you choose; without one, nobody else sees it. A new client appears here once it has called Esign.')),
      h(CardContent, null, clients === null ? h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading…')
        : clients.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, 'No API client has called Esign yet.')
          : h(Table, { 'aria-label': 'API clients' },
            h(TableHeader, null, h(TableRow, null, h(TableHead, null, 'Client'), h(TableHead, null, 'Shares what it creates with'), h(TableHead, null, 'Last call'), h(TableHead, null, h('span', { className: 'sr-only' }, 'Actions')))),
            h(TableBody, null, ...clients.map((client) => h(TableRow, { key: client.id },
              h(TableCell, { className: 'whitespace-normal' }, h('div', { className: 'font-medium' }, client.name ?? 'API client'), h('div', { className: 'font-mono text-xs text-muted-foreground' }, client.id)),
              h(TableCell, { className: 'whitespace-normal' }, editing?.id === client.id
                ? h('div', { className: 'flex flex-col gap-3' },
                  h(MemberEmailField, { id: `client-${client.id}-share`, label: 'Person (email)', value: editing.email, onChange: (email) => setEditing({ ...editing, email }) }),
                  h('label', { className: 'flex items-center gap-2 text-sm' },
                    h('input', { type: 'checkbox', className: checkClass, checked: editing.existing, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, existing: e.target.checked }) }),
                    'Also share what it has already created'),
                  h('div', { className: 'flex flex-wrap gap-2' },
                    h(Button, { size: 'sm', disabled: busy, onClick: () => saveClient() }, 'Save'),
                    client.shareWith ? h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => saveClient(true) }, 'Share with nobody') : null,
                    h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setEditing(null) }, 'Cancel')))
                : client.shareWith ? h('div', null, h('div', { className: 'font-medium' }, client.shareWith.name ?? client.shareWith.email), client.shareWith.name ? h('div', { className: 'text-xs text-muted-foreground' }, client.shareWith.email) : null)
                  : h('span', { className: 'text-muted-foreground' }, 'Nobody: only the client sees what it creates')),
              h(TableCell, { className: 'text-muted-foreground' }, dateTime(client.lastSeenAt)),
              h(TableCell, { className: 'text-right' }, editing?.id === client.id ? null
                : h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => setEditing({ id: client.id, email: client.shareWith?.email ?? me.user?.email ?? '', existing: true }) }, h(KeyRound, { 'aria-hidden': true }), client.shareWith ? 'Change' : 'Choose someone')))))))),
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
