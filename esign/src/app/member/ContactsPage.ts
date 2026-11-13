// Contacts: the organization's address book, everyone its envelopes named and anyone a member added, most recently
// used first, with how many of the organization's envelopes name each. Members who manage add and delete contacts
// here (a delete is asked twice); each contact's page changes or deletes them. A contact only fills
// in a signer: an envelope keeps the name and email it was sent with.
import React, { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { Input } from '../components/ui/input.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { apiJson, canManage, contactsPath, dateTime, describeError, EMAIL, type Contact, type Me } from './api.ts'
import { Field, Notice, PageHeader } from './parts.ts'
import { Link, navigate } from './router.ts'

const h = React.createElement
const PAGE = 50
const EMPTY = { name: '', email: '', title: '', company: '' }

export function ContactsPage({ me }: { me: Me }) {
  const manage = canManage(me)
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [next, setNext] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(EMPTY)
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  // The contact whose delete is being confirmed.
  const [confirming, setConfirming] = useState('')
  // Only the latest search's answer is shown, however the answers arrive.
  const latest = useRef(0)

  async function load(q: string, cursor = '') {
    const ask = ++latest.current
    try {
      const page = await apiJson<{ contacts: Contact[]; next?: string }>(contactsPath(q, PAGE, cursor))
      if (ask !== latest.current) return
      setContacts((old) => cursor ? [...(old ?? []), ...page.contacts] : page.contacts)
      setNext(page.next ?? '')
    } catch (error) { if (ask === latest.current) setMessage({ text: describeError(error), error: true }) }
  }
  useEffect(() => { void load(query) }, [query])

  function add() {
    if (!draft.name.trim() || !EMAIL.test(draft.email.trim())) { setMessage({ text: 'Enter a name and an email address.', error: true }); return }
    setBusy(true)
    setMessage({ text: '', error: false })
    const body = JSON.stringify({ name: draft.name.trim(), email: draft.email.trim(), ...(draft.title.trim() ? { title: draft.title.trim() } : {}), ...(draft.company.trim() ? { company: draft.company.trim() } : {}) })
    apiJson<Contact>('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      .then((contact) => { setDraft(EMPTY); setAdding(false); navigate(`/contacts/${contact.id}`) })
      .catch((error) => setMessage({ text: describeError(error), error: true }))
      .finally(() => setBusy(false))
  }

  function remove(contact: Contact) {
    setBusy(true)
    setMessage({ text: '', error: false })
    apiJson(`/api/contacts/${contact.id}/delete`, { method: 'POST' })
      .then(() => { setContacts((old) => old?.filter((c) => c.id !== contact.id) ?? null); setMessage({ text: `${contact.name} was deleted from your contacts. Their envelopes are kept.`, error: false }) })
      .catch((error) => setMessage({ text: describeError(error), error: true }))
      .finally(() => { setBusy(false); setConfirming('') })
  }

  const input = (key: keyof typeof EMPTY, label: string, type = 'text') =>
    h(Field, { label, htmlFor: `contact-${key}` }, h(Input, { id: `contact-${key}`, type, value: draft[key], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.value })) }))

  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, {
      title: 'Contacts',
      description: 'Everyone your organization\'s envelopes named, and anyone added here, most recently used first. Choose them as signers when you send.',
      actions: manage && !adding ? h(Button, { onClick: () => setAdding(true) }, h(Plus, { 'aria-hidden': true }), 'Add contact') : null,
    }),
    h(Notice, { message: message.text, error: message.error }),
    adding ? h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Add contact')), h(CardDescription, null, 'A contact with this email already? It is changed instead.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' },
        input('name', 'Name'), input('email', 'Email', 'email'), input('title', 'Title (optional)'), input('company', 'Company (optional)')),
      h(CardFooter, { className: 'gap-2' },
        h(Button, { disabled: busy, onClick: add }, busy ? 'Saving…' : 'Save contact'),
        h(Button, { variant: 'outline', disabled: busy, onClick: () => { setAdding(false); setDraft(EMPTY) } }, 'Cancel'))) : null,
    h('div', { className: 'relative max-w-sm' },
      h(Search, { className: 'pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground', 'aria-hidden': true }),
      h(Input, { id: 'contact-search', type: 'search', 'aria-label': 'Search contacts', placeholder: 'Search by name or email', className: 'pl-8', value: query, maxLength: 100, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value) })),
    h(Card, { className: 'py-0' }, h(CardContent, { className: 'px-0' },
      contacts === null ? h('p', { role: 'status', className: 'p-6 text-sm text-muted-foreground' }, 'Loading contacts…')
        : contacts.length === 0 ? h('p', { className: 'p-6 text-sm text-muted-foreground' }, query.trim() ? 'No contact matches.' : 'No contacts yet. Everyone you send an envelope to is added here.')
          : h(Table, { 'aria-label': 'Contacts' },
            h(TableHeader, null, h(TableRow, null,
              h(TableHead, { className: 'pl-6' }, 'Name'), h(TableHead, null, 'Email'), h(TableHead, null, 'Company'), h(TableHead, { className: 'text-right' }, 'Envelopes'), h(TableHead, { className: manage ? undefined : 'pr-6' }, 'Last used'),
              manage ? h(TableHead, { className: 'pr-6' }, h('span', { className: 'sr-only' }, 'Actions')) : null)),
            h(TableBody, null, ...contacts.map((contact) => h(TableRow, { key: contact.id },
              h(TableCell, { className: 'pl-6' }, h(Link, { to: `/contacts/${contact.id}`, className: 'font-medium underline-offset-4 hover:underline' }, contact.name),
                contact.title ? h('div', { className: 'text-xs text-muted-foreground' }, contact.title) : null),
              h(TableCell, null, contact.email),
              h(TableCell, { className: 'text-muted-foreground' }, contact.company ?? ''),
              h(TableCell, { className: 'text-right tabular-nums' }, String(contact.envelopeCount)),
              h(TableCell, { className: manage ? 'text-muted-foreground' : 'pr-6 text-muted-foreground' }, contact.lastUsedAt ? dateTime(contact.lastUsedAt) : 'Not yet'),
              manage ? h(TableCell, { className: 'pr-6 text-right' }, confirming === contact.id
                ? h('div', { className: 'flex justify-end gap-2' },
                  h(Button, { size: 'sm', variant: 'destructive', disabled: busy, onClick: () => remove(contact) }, 'Delete for good'),
                  h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => setConfirming('') }, 'Keep'))
                : h(Button, { size: 'sm', variant: 'ghost', 'aria-label': `Delete ${contact.name}`, disabled: busy, onClick: () => setConfirming(contact.id) }, h(Trash2, { 'aria-hidden': true }), 'Delete')) : null)))))),
    next ? h(Button, { variant: 'outline', className: 'w-fit', onClick: () => void load(query, next) }, 'Show more') : null)
}
