// One contact: their details, which members who manage change or delete, and the envelopes that name them as a
// signer. The email can't change (another email is another contact). Neither changing nor deleting a contact touches
// an envelope: each keeps the name and email it was sent with.
import React, { useEffect, useState } from 'react'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { Input } from '../components/ui/input.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { apiJson, canManage, dateTime, describeError, taskLabel, type Contact, type ContactEnvelope, type Me } from './api.ts'
import { Field, Notice, PageHeader, StatusBadge } from './parts.ts'
import { Link, navigate } from './router.ts'

const h = React.createElement
type Detail = Contact & { envelopes: ContactEnvelope[] }

export function ContactPage({ me, id }: { me: Me; id: string }) {
  const manage = canManage(me)
  const [contact, setContact] = useState<Detail | null>(null)
  const [draft, setDraft] = useState({ name: '', title: '', company: '' })
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)

  const show = (data: Detail) => { setContact(data); setDraft({ name: data.name, title: data.title ?? '', company: data.company ?? '' }) }
  useEffect(() => { apiJson<Detail>(`/api/contacts/${id}`).then(show).catch((error) => setMessage({ text: describeError(error), error: true })) }, [id])

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage({ text: '', error: false })
    try { await work() } catch (error) { setMessage({ text: describeError(error), error: true }) } finally { setBusy(false) }
  }
  function save() {
    if (!draft.name.trim()) { setMessage({ text: 'Enter a name.', error: true }); return }
    void run(async () => {
      const saved = await apiJson<Contact>(`/api/contacts/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: draft.name.trim(), title: draft.title.trim(), company: draft.company.trim() }) })
      show({ ...saved, envelopes: contact?.envelopes ?? [] })
      setMessage({ text: 'Contact saved.', error: false })
    })
  }
  function remove() {
    void run(async () => {
      await apiJson(`/api/contacts/${id}/delete`, { method: 'POST' })
      navigate('/contacts')
    })
  }

  const back = h(Link, { to: '/contacts', className: 'inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground' }, h(ArrowLeft, { className: 'size-4', 'aria-hidden': true }), 'Contacts')
  if (!contact) return h('div', { className: 'flex flex-col gap-6' }, back, message.text ? h(Notice, { message: message.text, error: message.error }) : h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading contact…'))

  const input = (key: keyof typeof draft, label: string) =>
    h(Field, { label, htmlFor: `contact-${key}` }, h(Input, { id: `contact-${key}`, value: draft[key], disabled: !manage, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.value })) }))

  return h('div', { className: 'flex flex-col gap-6' },
    back,
    h(PageHeader, {
      title: contact.name,
      description: `${contact.email} · ${contact.envelopeCount === 1 ? '1 envelope' : `${contact.envelopeCount} envelopes`}${contact.lastUsedAt ? `, last on ${dateTime(contact.lastUsedAt)}` : ''}`,
    }),
    h(Notice, { message: message.text, error: message.error }),
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Details')), h(CardDescription, null, 'They fill in a signer when you choose this contact. Envelopes already sent keep what they were sent with.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' },
        input('name', 'Name'),
        h(Field, { label: 'Email', htmlFor: 'contact-email', hint: 'Another email is another contact.' }, h(Input, { id: 'contact-email', value: contact.email, disabled: true, readOnly: true })),
        input('title', 'Title (optional)'), input('company', 'Company (optional)')),
      manage ? h(CardFooter, { className: 'flex-wrap gap-2' },
        h(Button, { disabled: busy, onClick: save }, busy ? 'Saving…' : 'Save contact'),
        confirming
          ? [h(Button, { key: 'confirm', variant: 'destructive', disabled: busy, onClick: remove }, h(Trash2, { 'aria-hidden': true }), 'Delete for good'),
            h(Button, { key: 'keep', variant: 'outline', disabled: busy, onClick: () => setConfirming(false) }, 'Keep it')]
          : h(Button, { variant: 'outline', disabled: busy, onClick: () => setConfirming(true) }, h(Trash2, { 'aria-hidden': true }), 'Delete contact')) : null),
    h(Card, { className: 'py-0' },
      h(CardHeader, { className: 'px-6 pt-6' }, h(CardTitle, null, h('h2', null, 'Envelopes')), h(CardDescription, null, 'The envelopes that name them as a signer, newest first.')),
      h(CardContent, { className: 'px-0 pb-2' },
        contact.envelopes.length === 0 ? h('p', { className: 'px-6 pb-4 text-sm text-muted-foreground' }, 'No envelope names them yet.')
          : h(Table, { 'aria-label': 'Their envelopes' },
            h(TableHeader, null, h(TableRow, null,
              h(TableHead, { className: 'pl-6' }, 'Document'), h(TableHead, null, 'Role'), h(TableHead, null, 'Their part'), h(TableHead, null, 'Status'), h(TableHead, { className: 'pr-6' }, 'Created'))),
            h(TableBody, null, ...contact.envelopes.map((envelope, i) => h(TableRow, { key: `${envelope.id}-${i}` },
              h(TableCell, { className: 'pl-6' }, h(Link, { to: `/envelopes/${envelope.id}`, className: 'font-medium underline-offset-4 hover:underline' }, envelope.documentName || 'Untitled document')),
              h(TableCell, null, envelope.role),
              h(TableCell, { className: 'text-muted-foreground' }, taskLabel(envelope.taskStatus)),
              h(TableCell, null, h(StatusBadge, { status: envelope.status })),
              h(TableCell, { className: 'pr-6 text-muted-foreground' }, dateTime(envelope.createdAt)))))))))
}
