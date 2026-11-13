// A member's own tags on a template or an envelope (server/esign/tags.ts): nobody else sees them. Each tag is a badge
// that can be removed; typing adds one with Enter or a comma, and suggests the member's tags already in use.
import React, { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '../components/ui/badge.ts'
import { Input } from '../components/ui/input.ts'
import { apiJson } from './api.ts'
import { Field } from './parts.ts'

const h = React.createElement
const MAX_TAGS = 20
const MAX_TAG = 50

/** The member's tags as removable badges, and a field that adds more. */
export function TagsField({ id, label = 'Your tags', hint = 'Only you see your tags. Press Enter or type a comma to add one.', value, onChange, disabled = false }: { id: string; label?: string; hint?: string; value: string[]; onChange: (tags: string[]) => void; disabled?: boolean }) {
  const [text, setText] = useState('')
  const [found, setFound] = useState<string[]>([])
  const latest = useRef(0)
  const has = (tag: string) => value.some((t) => t.toLowerCase() === tag.toLowerCase())

  function add(raw: string) {
    const tag = raw.trim().slice(0, MAX_TAG)
    setText(''); setFound([]); latest.current++
    if (tag && !has(tag) && value.length < MAX_TAGS) onChange([...value, tag])
  }
  function typed(next: string) {
    if (next.includes(',')) { for (const part of next.split(',').slice(0, -1)) add(part); setText(next.split(',').at(-1) ?? ''); return }
    setText(next)
    const ask = ++latest.current
    if (!next.trim()) { setFound([]); return }
    apiJson<{ tags: { tag: string }[] }>(`/api/tags?limit=6&q=${encodeURIComponent(next.trim())}`)
      .then((data) => { if (ask === latest.current) setFound(data.tags.map((t) => t.tag).filter((t) => !has(t))) })
      .catch(() => { if (ask === latest.current) setFound([]) })
  }

  return h(Field, { label, htmlFor: id, hint },
    value.length ? h('div', { className: 'flex flex-wrap gap-1.5', 'aria-label': label },
      ...value.map((tag) => h(Badge, { key: tag.toLowerCase(), variant: 'secondary', className: 'gap-1' }, tag,
        disabled ? null : h('button', { type: 'button', 'aria-label': `Remove tag ${tag}`, className: 'rounded-sm opacity-70 hover:opacity-100', onClick: () => onChange(value.filter((t) => t !== tag)) }, h(X, { className: 'size-3', 'aria-hidden': true }))))) : null,
    disabled ? null : h('div', { className: 'relative' },
      h(Input, {
        id, value: text, maxLength: MAX_TAG + 1, autoComplete: 'off', placeholder: value.length >= MAX_TAGS ? 'At most 20 tags' : 'Add a tag',
        disabled: value.length >= MAX_TAGS,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => typed(e.target.value),
        onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); add(text) } },
        onBlur: () => setFound([]),
      }),
      found.length ? h('ul', { role: 'listbox', 'aria-label': 'Your tags', className: 'absolute z-20 mt-1 w-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md' },
        ...found.map((tag) => h('li', { key: tag, role: 'option', 'aria-selected': false, className: 'cursor-pointer rounded-sm px-2 py-1.5 text-sm hover:bg-accent', onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onClick: () => add(tag) }, tag))) : null))
}

/** Tags as small badges, for a list's rows. */
export function TagList({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null
  return h('div', { className: 'mt-1 flex flex-wrap gap-1' }, ...tags.map((tag) => h(Badge, { key: tag, variant: 'secondary', className: 'font-normal' }, tag)))
}
