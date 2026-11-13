// What the Envelopes and Templates lists share above and below them: a search that, while empty, offers the common
// filters; filter buttons, each a menu of choices (Date, Sender and the page's own); Tags, the member's own, picked by
// clicking; a chip for each filter in use, which removes it, and Clear all; and pages (Per page, previous, next).
import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, Tag, X } from 'lucide-react'
import { Badge } from '../components/ui/badge.ts'
import { Button } from '../components/ui/button.ts'
import { DropdownMenu } from '../components/ui/dropdown-menu.ts'
import { Input } from '../components/ui/input.ts'
import { Label } from '../components/ui/label.ts'
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.ts'
import { apiJson, type Scope } from './api.ts'

const h = React.createElement
const DAY = 86_400_000
/** The Date filter: created within the last … */
export const DATES: Record<string, { label: string; ms: number }> = {
  '24h': { label: 'Last 24 hours', ms: DAY }, '7d': { label: 'Last 7 days', ms: 7 * DAY }, '30d': { label: 'Last 30 days', ms: 30 * DAY },
  '6m': { label: 'Last 6 months', ms: 183 * DAY }, '12m': { label: 'Last 12 months', ms: 365 * DAY },
}
export const dateLabels = Object.fromEntries(Object.entries(DATES).map(([key, d]) => [key, d.label]))
/** The `since` a Date filter asks for, now. */
export const sinceOf = (date: string) => (DATES[date] ? { since: Date.now() - DATES[date]!.ms } : {})
export const SENDERS: Record<Exclude<Scope, ''>, string> = { mine: 'Sent by me', shared: 'Shared with me' }
export const MAX_TAG_FILTER = 5
export const PAGE_SIZES = [10, 25, 50, 100]

/** A filter button: its name, or the choice made, and a menu of choices (the first, "Any", clears it). */
export function FilterButton({ name, value, options, onChange }: { name: string; value: string; options: Record<string, string>; onChange: (value: string) => void }) {
  return h(DropdownMenu, {
    label: `${name} filter`, heading: name, align: 'start',
    items: [{ label: 'Any', checked: !value, onSelect: () => onChange('') }, ...Object.entries(options).map(([key, label]) => ({ label, checked: value === key, onSelect: () => onChange(key) }))],
    trigger: (props) => h(Button, { ...props, variant: value ? 'secondary' : 'outline' }, value ? `${name}: ${options[value]}` : name, h(ChevronDown, { 'aria-hidden': true })),
  })
}

/** The member's own tags, for the Tags filter; `reload` after they change some. */
export function useMyTags(): [string[], () => void] {
  const [tags, setTags] = useState<string[]>([])
  const reload = () => { apiJson<{ tags: { tag: string }[] }>('/api/tags?limit=50').then((data) => setTags(data.tags.map((t) => t.tag))).catch(() => {}) }
  useEffect(reload, [])
  return [tags, reload]
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** Picks or unpicks a tag: a list shows what has all those picked, at most 5. */
export const toggled = (picked: string[], tag: string) => picked.some((t) => same(t, tag)) ? picked.filter((t) => !same(t, tag)) : [...picked, tag].slice(0, MAX_TAG_FILTER)

/** Tags: the member's own, picked by clicking; the menu stays open for another. `what`: what they tag, for the empty menu. */
export function TagsFilter({ picked, mine, what, onChange }: { picked: string[]; mine: string[]; what: string; onChange: (tags: string[]) => void }) {
  return h(DropdownMenu, {
    label: 'Tags filter', heading: `Your tags: ${what} with all of those picked`, align: 'start', multi: true,
    items: mine.length
      ? mine.map((tag) => {
        const on = picked.some((t) => same(t, tag))
        return { label: tag, checked: on, disabled: !on && picked.length >= MAX_TAG_FILTER, onSelect: () => onChange(toggled(picked, tag)) }
      })
      : [{ label: `No tags yet: tag ${what} from their ⋯ menu`, disabled: true, onSelect: () => {} }],
    trigger: (props) => h(Button, { ...props, variant: picked.length ? 'secondary' : 'outline' }, h(Tag, { 'aria-hidden': true }), picked.length ? `Tags: ${picked.join(', ')}` : 'Tags', h(ChevronDown, { 'aria-hidden': true })),
  })
}

export type Suggestion = { label: string; kind: string; apply: () => void }
/** The search: applied as the member pauses typing or presses Enter; while empty and focused, the common filters. */
export function SearchBox({ id, label, value, onSearch, suggestions }: { id: string; label: string; value: string; onSearch: (q: string) => void; suggestions: Suggestion[] }) {
  const [typed, setTyped] = useState(value)
  const [open, setOpen] = useState(false)
  // Cleared from outside (a chip, Clear all): the field follows.
  useEffect(() => { if (!value) setTyped('') }, [value])
  useEffect(() => {
    if (typed.trim() === value) return
    const timer = setTimeout(() => onSearch(typed.trim()), 300)
    return () => clearTimeout(timer)
  }, [typed])
  return h('div', { className: 'relative w-full sm:w-64' },
    h(Search, { className: 'pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground', 'aria-hidden': true }),
    h(Input, {
      id, type: 'search', 'aria-label': label, placeholder: label, className: 'pl-8', value: typed, maxLength: 100, autoComplete: 'off',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { onSearch(typed.trim()); setOpen(false) } if (e.key === 'Escape') setOpen(false) },
      onFocus: () => setOpen(true), onBlur: () => setOpen(false),
    }),
    open && !typed && suggestions.length ? h('div', { role: 'listbox', 'aria-label': 'Filter by', className: 'absolute z-30 mt-1 w-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md' },
      h('div', { className: 'px-2 py-1.5 text-xs font-medium text-muted-foreground' }, 'Filter by'),
      ...suggestions.map((s) => h('button', {
        key: `${s.kind}-${s.label}`, type: 'button', role: 'option', 'aria-selected': false, className: 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
        onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onClick: () => { setOpen(false); s.apply() },
      }, h(SlidersHorizontal, { className: 'size-4 text-muted-foreground', 'aria-hidden': true }), h('span', { className: 'flex flex-col' }, s.label, h('span', { className: 'text-xs text-muted-foreground' }, s.kind))))) : null)
}

export type Chip = { label: string; clear: () => void }
/** A chip for each filter in use, which removes it. */
export function FilterChips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null
  return h('div', { className: 'flex flex-wrap gap-2', 'aria-label': 'Filters' },
    ...chips.map((chip) => h(Badge, { key: chip.label, variant: 'secondary', className: 'gap-1 py-1' }, chip.label,
      h('button', { type: 'button', 'aria-label': `Remove ${chip.label}`, className: 'rounded-sm opacity-70 hover:opacity-100', onClick: chip.clear }, h(X, { className: 'size-3', 'aria-hidden': true })))))
}

/** Pages: Per page, which page, previous and next. */
export function Pager({ id, page, pageSize, hasNext, busy, onPageSize, onTurn }: { id: string; page: number; pageSize: number; hasNext: boolean; busy: boolean; onPageSize: (size: number) => void; onTurn: (to: 'next' | 'previous') => void }) {
  return h('div', { className: 'flex flex-wrap items-center justify-between gap-2' },
    h('div', { className: 'flex items-center gap-2' },
      h(Label, { htmlFor: `${id}-page-size`, className: 'whitespace-nowrap text-sm text-muted-foreground' }, 'Per page'),
      h(NativeSelect, { id: `${id}-page-size`, value: String(pageSize), onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onPageSize(Number(e.target.value)) },
        ...PAGE_SIZES.map((n) => h(NativeSelectOption, { key: n, value: String(n) }, String(n))))),
    h('div', { className: 'flex items-center gap-2' },
      h('span', { className: 'text-sm' }, `Page ${page}`),
      h(Button, { variant: 'ghost', size: 'icon-sm', 'aria-label': 'Previous page', disabled: page === 1 || busy, onClick: () => onTurn('previous') }, h(ChevronLeft, { 'aria-hidden': true })),
      h(Button, { variant: 'ghost', size: 'icon-sm', 'aria-label': 'Next page', disabled: !hasNext || busy, onClick: () => onTurn('next') }, h(ChevronRight, { 'aria-hidden': true }))))
}

/**
 * A list's pages: the `before` of each page seen so far (the first has none) and the next page's, when there is one.
 * `reset` starts again on page 1; `turn` moves, returning the `before` to load (or undefined when it can't move).
 */
export function usePages() {
  const [pages, setPages] = useState<(number | undefined)[]>([undefined])
  const [next, setNext] = useState<number | undefined>(undefined)
  return {
    page: pages.length, before: pages[pages.length - 1], next, setNext,
    reset: () => setPages([undefined]),
    turn: (to: 'next' | 'previous'): { before: number | undefined } | null => {
      const stack = to === 'next' && next !== undefined ? [...pages, next] : pages.slice(0, -1)
      if (!stack.length || (to === 'next' && next === undefined)) return null
      setPages(stack)
      return { before: stack[stack.length - 1] }
    },
  }
}
