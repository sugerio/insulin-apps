// Choosing a signer from the organization's contacts, in the send form, two ways: suggestions under the Name and Email
// fields as they are typed (ContactField), and a search over the contacts to browse (ContactPicker). Either fills in
// the signer's name, email, title and company.
import React, { useEffect, useRef, useState } from 'react'
import { BookUser, X } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Input } from '../components/ui/input.ts'
import { apiJson, contactsPath, describeError, type Contact } from './api.ts'
import { Field } from './parts.ts'

const h = React.createElement
const SHOWN = 8
/** How many suggestions a field shows, and how much must be typed first. */
const SUGGESTED = 6
const MIN_TYPED = 2

const describe = (contact: Contact) => [contact.email, contact.title, contact.company].filter(Boolean).join(' · ')

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
              h('span', { className: 'text-xs text-muted-foreground' }, describe(contact)))))))
}

/**
 * A signer's Name or Email field that suggests contacts as it is typed (from two characters on, names and emails
 * containing it, most recently used first). Arrow keys move through the suggestions, Enter or a click chooses one,
 * Escape or leaving the field closes them; typing on is never held up.
 */
export function ContactField({ id, label, type = 'text', value, required = true, onChange, onChoose }: { id: string; label: string; type?: string; value: string; required?: boolean; onChange: (value: string) => void; onChoose: (contact: Contact) => void }) {
  const [found, setFound] = useState<Contact[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // Only the latest keystroke's answer is shown, however the answers arrive.
  const latest = useRef(0)
  const listId = `${id}-suggestions`

  function typed(text: string) {
    onChange(text)
    const ask = ++latest.current
    const q = text.trim()
    if (q.length < MIN_TYPED) { setFound([]); setOpen(false); return }
    apiJson<{ contacts: Contact[] }>(contactsPath(q, SUGGESTED))
      .then((page) => {
        if (ask !== latest.current) return
        // Nothing to suggest once the field holds a contact's email exactly.
        const shown = page.contacts.filter((c) => c.email.toLowerCase() !== q.toLowerCase())
        setFound(shown); setOpen(shown.length > 0); setActive(-1)
      })
      .catch(() => { if (ask === latest.current) { setFound([]); setOpen(false) } })
  }
  function choose(contact: Contact) {
    latest.current++
    setOpen(false); setFound([]); setActive(-1)
    onChoose(contact)
  }
  function keyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || !found.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => e.key === 'ArrowDown' ? (i + 1) % found.length : (i <= 0 ? found.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      choose(found[active]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return h(Field, { label, htmlFor: id },
    h('div', { className: 'relative' },
      h(Input, {
        id, type, value, required, autoComplete: 'off',
        role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': open, 'aria-controls': listId,
        ...(open && active >= 0 ? { 'aria-activedescendant': `${listId}-${active}` } : {}),
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => typed(e.target.value),
        onKeyDown: keyDown,
        onBlur: () => setOpen(false),
      }),
      open ? h('ul', { id: listId, role: 'listbox', 'aria-label': `Contacts matching ${label.toLowerCase()}`, className: 'absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md' },
        ...found.map((contact, i) => h('li', {
          key: contact.id, id: `${listId}-${i}`, role: 'option', 'aria-selected': i === active, 'aria-label': `Choose ${contact.name} (${contact.email})`,
          className: `flex cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm ${i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`,
          // Chosen before the field loses focus, which would close the list.
          onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
          onClick: () => choose(contact),
        },
          h('span', { className: 'font-medium' }, contact.name),
          h('span', { className: 'text-xs text-muted-foreground' }, describe(contact))))) : null))
}
