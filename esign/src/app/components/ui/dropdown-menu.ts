// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/dropdown-menu.json, with createElement instead of
// JSX and without Radix (none of the project's components use it): a trigger, and while open, a menu of items placed
// under it, right-aligned. The menu is `position: fixed`, from the trigger's box, so a table's scrolling container
// doesn't clip it. A click outside, Escape, scrolling or choosing an item closes it.
import React, { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

const h = React.createElement
/** An item; `checked` makes it one of a set of choices (a radio item), shown with a check when it is the one chosen. */
export type MenuItem = { label: string; icon?: React.ComponentType<{ 'aria-hidden'?: boolean }>; onSelect: () => void; destructive?: boolean; disabled?: boolean; checked?: boolean }

/** `multi`: the `checked` items are checkboxes, several of which may be chosen; choosing one leaves the menu open. */
export function DropdownMenu({ label, heading, align = 'end', multi = false, trigger, items }: { label: string; heading?: string; align?: 'start' | 'end'; multi?: boolean; trigger: (props: { ref: React.Ref<HTMLButtonElement>; 'aria-label': string; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; onClick: () => void }) => React.ReactNode; items: MenuItem[] }) {
  const [at, setAt] = useState<{ top: number; left?: number; right?: number } | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!at || typeof document === 'undefined') return
    const outside = (e: Event) => { if (!menu.current?.contains?.(e.target as Node) && !button.current?.contains?.(e.target as Node)) setAt(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }
    const scrolled = () => setAt(null)
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', scrolled, true)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('scroll', scrolled, true) }
  }, [at])
  function toggle() {
    if (at) { setAt(null); return }
    const box = button.current?.getBoundingClientRect?.()
    const width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0
    setAt(align === 'start' ? { top: (box?.bottom ?? 0) + 4, left: box?.left ?? 8 } : { top: (box?.bottom ?? 0) + 4, right: box ? Math.max(8, width - box.right) : 8 })
  }
  const visible = items.filter(Boolean)
  return h(React.Fragment, null,
    trigger({ ref: button, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': !!at, onClick: toggle }),
    at ? h('div', {
      ref: menu, role: 'menu', 'aria-label': label, 'data-slot': 'dropdown-menu-content',
      style: { position: 'fixed', top: at.top, ...(at.left === undefined ? { right: at.right } : { left: at.left }) },
      className: 'z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
    }, heading ? h('div', { 'data-slot': 'dropdown-menu-label', className: 'px-2 py-1.5 text-xs font-medium text-muted-foreground' }, heading) : null,
    ...visible.map((item) => h('button', {
      key: item.label, type: 'button', role: item.checked === undefined ? 'menuitem' : multi ? 'menuitemcheckbox' : 'menuitemradio', 'aria-checked': item.checked, disabled: item.disabled, 'data-slot': 'dropdown-menu-item',
      className: cn('relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4 [&_svg:not([class*=\'text-\'])]:text-muted-foreground',
        item.destructive && 'text-destructive hover:bg-destructive/10 hover:text-destructive [&_svg:not([class*=\'text-\'])]:text-destructive'),
      onClick: () => { if (!multi || item.checked === undefined) setAt(null); item.onSelect() },
    }, item.checked === undefined ? null : h('span', { className: 'flex size-4 items-center justify-center' }, item.checked ? h(Check, { 'aria-hidden': true }) : null),
      item.icon ? h(item.icon, { 'aria-hidden': true }) : null, item.label))) : null)
}
