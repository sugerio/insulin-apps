// Esign's page for one OAuth client (`/client-settings/{service account id}?name=…`, package.json
// `insulin.clientSettings`): who in the organization sees everything the client creates, as admins
// (server/esign/members.ts, ownership.ts). Nothing in Esign links here: the platform's API access page does, under each
// client, for the organization's owners and admins, who alone may change it. For the organization's owners it links to
// Ownership, to take over what a client no longer used owns (Ownership isn't in the navigation).
import React, { useEffect, useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { apiJson, canManage, describeError, EMAIL, type Me } from './api.ts'
import { Notice, PageHeader } from './parts.ts'
import { Link } from './router.ts'
import { MemberEmailField } from './SharePanel.ts'

const h = React.createElement
const MAX_PEOPLE = 50
type Person = { email: string; name?: string }
type ClientSettings = { id: string; name?: string; people: Person[] }

/** The organization's owners and admins, as the server checks them. */
const orgAdmin = (me: Me) => (me.orgRole === 'OWNER' || me.orgRole === 'ADMIN') && canManage(me)

export function ClientSettingsPage({ me, id, name }: { me: Me; id: string; name?: string }) {
  const allowed = orgAdmin(me)
  const [settings, setSettings] = useState<ClientSettings | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)

  function loaded(answer: ClientSettings) { setSettings(answer); setPeople(answer.people) }
  useEffect(() => {
    if (!allowed) return
    apiJson<ClientSettings>(`/api/client-settings/${encodeURIComponent(id)}${name ? `?name=${encodeURIComponent(name)}` : ''}`)
      .then(loaded).catch((error) => setMessage({ text: describeError(error), error: true }))
  }, [id])

  const back = h('a', { href: '/settings/api', className: 'font-medium text-foreground underline underline-offset-4' }, 'API access')
  if (!allowed) {
    return h('div', { className: 'flex flex-col gap-4' }, h(PageHeader, { title: 'API client' }),
      h(Notice, { message: 'Only your organization\'s owners and admins choose who sees what an API client creates.' }))
  }
  const title = settings?.name ?? name ?? 'API client'
  const changed = !!settings && (people.length !== settings.people.length || people.some((p, i) => p.email.toLowerCase() !== settings.people[i]!.email.toLowerCase()))

  function add() {
    const to = email.trim()
    if (!EMAIL.test(to)) { setMessage({ text: 'Enter the email address of someone in your organization.', error: true }); return }
    if (people.some((p) => p.email.toLowerCase() === to.toLowerCase())) { setMessage({ text: `${to} is already on the list.`, error: true }); return }
    if (people.length >= MAX_PEOPLE) { setMessage({ text: `At most ${MAX_PEOPLE} people.`, error: true }); return }
    setPeople([...people, { email: to }]); setEmail(''); setMessage({ text: '', error: false })
  }
  async function save() {
    setBusy(true); setMessage({ text: '', error: false })
    try {
      const answer = await apiJson<ClientSettings>(`/api/client-settings/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people: people.map((p) => p.email) }),
      })
      loaded(answer)
      setMessage({ text: answer.people.length ? `Saved. ${answer.people.length} ${answer.people.length === 1 ? 'person sees' : 'people see'} everything this client creates.` : 'Saved. Only the client sees what it creates.', error: false })
    } catch (error) { setMessage({ text: describeError(error), error: true }) }
    finally { setBusy(false) }
  }

  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, { title, description: h(React.Fragment, null, 'An OAuth client of your organization, from ', back, '. What it creates in Esign is its own.') }),
    h(Notice, { message: message.text, error: message.error }),
    !settings ? (message.error ? null : h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading…'))
      : h(Card, { 'aria-label': 'Who sees what it creates' },
        h(CardHeader, null,
          h(CardTitle, null, h('h2', null, 'Who sees what it creates')),
          h(CardDescription, null, 'These people see every template and envelope this client creates, those it made before included, and manage them as admins, for as long as they are on this list. Without anyone, only the client sees them.')),
        h(CardContent, { className: 'flex flex-col gap-4' },
          people.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, 'Nobody: only the client sees what it creates.')
            : h(Table, { 'aria-label': 'People' },
              h(TableHeader, null, h(TableRow, null, h(TableHead, null, 'Person'), h(TableHead, null, h('span', { className: 'sr-only' }, 'Actions')))),
              h(TableBody, null, ...people.map((p) => h(TableRow, { key: p.email.toLowerCase() },
                h(TableCell, { className: 'whitespace-normal' }, p.name ? h('div', { className: 'font-medium' }, p.name) : null, h('div', { className: p.name ? 'text-xs text-muted-foreground' : '' }, p.email)),
                h(TableCell, { className: 'text-right' }, h(Button, { size: 'sm', variant: 'ghost', disabled: busy, 'aria-label': `Remove ${p.email}`, onClick: () => setPeople(people.filter((q) => q !== p)) }, 'Remove')))))),
          h('div', { className: 'grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]' },
            h(MemberEmailField, { id: 'client-person-email', label: 'Add someone (email)', value: email, onChange: setEmail }),
            h(Button, { variant: 'outline', disabled: busy, onClick: add }, h(UserPlus, { 'aria-hidden': true }), 'Add'))),
        h(CardFooter, { className: 'flex items-center gap-3 border-t' },
          h(Button, { disabled: busy || !changed, onClick: () => void save() }, busy ? 'Saving…' : 'Save'),
          changed ? h(Button, { variant: 'ghost', disabled: busy, onClick: () => { setPeople(settings.people); setMessage({ text: '', error: false }) } }, 'Discard changes') : null)),
    settings && me.orgRole === 'OWNER' ? h('p', { className: 'text-sm text-muted-foreground' }, 'No longer used? Take over everything it owns on ',
      h(Link, { to: '/ownership', className: 'font-medium text-foreground underline underline-offset-4' }, 'Ownership'), '.') : null)
}
