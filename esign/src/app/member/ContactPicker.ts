// Choosing a signer from the organization's contacts, in the send form: a search over names and emails, most
// recently used first, and a button per contact that fills in the signer.
import React, { useEffect, useRef, useState } from 'react'
import { BookUser, X } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Input } from '../components/ui/input.ts'
import { apiJson, contactsPath, describeError, type Contact } from './api.ts'

const h = React.createElement
const SHOWN = 8

export function ContactPicker({ id, label, onChoose }: { id: string; label: string; onChoose: (contact: Contact) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Contact[] | null>(null)
  const [failure, setFailure] = useState('')
  // Only the latest search's answer is shown, however the answers arrive.
  const latest = useRef(0)

  useEffect(() => {
    if (!open) return
    const ask = ++latest.current
    apiJson<{ contacts: Contact[] }>(contactsPath(query, SHOWN))
      .then((page) => { if (ask === latest.current) { setFound(page.contacts); setFailure('') } })
      .catch((error) => { if (ask === latest.current) setFailure(describeError(error)) })
  }, [open, query])

  if (!open) return h(Button, { variant: 'outline', size: 'sm', className: 'w-fit', onClick: () => setOpen(true) }, h(BookUser, { 'aria-hidden': true }), `Choose ${label} from contacts`)

  const close = () => { setOpen(false); setQuery(''); setFound(null) }
  return h('div', { className: 'flex flex-col gap-2 rounded-md border bg-muted/30 p-3' },
    h('div', { className: 'flex items-center gap-2' },
      h(Input, { id, type: 'search', 'aria-label': `Search contacts for ${label}`, placeholder: 'Search by name or email', maxLength: 100, value: query, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value) }),
      h(Button, { variant: 'ghost', size: 'icon', 'aria-label': 'Close contacts', onClick: close }, h(X, { 'aria-hidden': true }))),
    failure ? h('p', { role: 'alert', className: 'text-sm text-destructive' }, failure)
      : found === null ? h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading contacts…')
        : found.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, query.trim() ? 'No contact matches.' : 'No contacts yet. Everyone you send an envelope to is added.')
          : h('ul', { className: 'flex flex-col', 'aria-label': `Contacts for ${label}` }, ...found.map((contact) => h('li', { key: contact.id },
            h('button', {
              type: 'button', 'aria-label': `Choose ${contact.name} (${contact.email})`,
              className: 'flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
              onClick: () => { onChoose(contact); close() },
            },
              h('span', { className: 'font-medium' }, contact.name),
              h('span', { className: 'text-xs text-muted-foreground' }, [contact.email, contact.title, contact.company].filter(Boolean).join(' · ')))))))
}
