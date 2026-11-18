// A Name or Email field that suggests the organization's contacts as it is typed (the send form's signers, a
// template's default signers); choosing one fills in the person's name and email (and, for a signer, title and
// company).
import React, { useRef, useState } from 'react'
import { Input } from '../components/ui/input.ts'
import { apiJson, contactsPath, type Contact } from './api.ts'
import { Field } from './parts.ts'

const h = React.createElement
/** How many suggestions a field shows, and how much must be typed first. */
const SUGGESTED = 6
const MIN_TYPED = 2

const describe = (contact: Contact) => [contact.email, contact.title, contact.company].filter(Boolean).join(' · ')

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
