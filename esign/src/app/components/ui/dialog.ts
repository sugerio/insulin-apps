// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/dialog.json, with createElement instead of JSX and
// without Radix (none of the project's components use it): an overlay and a centered panel, shown while `open`.
// Escape, the close button and a click on the overlay ask `onOpenChange(false)`, unless `dismissible` is false (while
// something is being saved). The page behind doesn't scroll while it is open; focus moves into the panel, Tab and
// Shift+Tab stay inside it, and closing it gives focus back to what had it before.
import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

type Div = React.ComponentProps<'div'>
const h = React.createElement

export function Dialog({ open, onOpenChange, label, dismissible = true, className, children }: { open: boolean; onOpenChange: (open: boolean) => void; label: string; dismissible?: boolean; className?: string; children?: React.ReactNode }) {
  const panel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const opener = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus?.()
    return () => { document.body.style.overflow = overflow; opener?.focus?.() }
  }, [open])
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    // An Escape something inside used (a list of suggestions closing, which prevents its default) closes only that.
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissible && !e.defaultPrevented) onOpenChange(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open, dismissible])
  // Tab past the last control comes back to the first, Shift+Tab before the first goes to the last.
  function trap(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !panel.current) return
    const controls = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, summary, audio[controls], video[controls], [contenteditable="true"], [tabindex]:not([tabindex="-1"])')]
    if (!controls.length) { e.preventDefault(); return }
    const first = controls[0]!, last = controls[controls.length - 1]!, at = document.activeElement
    if (e.shiftKey ? at === first || at === panel.current : at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
  }
  if (!open) return null
  // display: contents, so that the dialog takes no place in the page's layout.
  return h('div', { 'data-slot': 'dialog-portal', className: 'contents' },
    h('div', { 'data-slot': 'dialog-overlay', className: 'fixed inset-0 z-50 bg-black/50', onClick: () => { if (dismissible) onOpenChange(false) } }),
    h('div', {
      ref: panel, role: 'dialog', 'aria-modal': true, 'aria-label': label, tabIndex: -1, 'data-slot': 'dialog-content', onKeyDown: trap,
      className: cn('fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100vh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg outline-none sm:max-w-lg', className),
    },
      children,
      dismissible ? h('button', { type: 'button', 'data-slot': 'dialog-close', 'aria-label': 'Close', onClick: () => onOpenChange(false), className: 'absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4' }, h(X, { 'aria-hidden': true })) : null))
}

const part = (slot: string, base: string, tag: 'div' | 'h2' | 'p' = 'div') => ({ className, ...props }: Div) =>
  h(tag, { 'data-slot': slot, className: cn(base, className), ...props })

export const DialogHeader = part('dialog-header', 'flex flex-col gap-2 text-center sm:text-left')
export const DialogFooter = part('dialog-footer', 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end')
export const DialogTitle = part('dialog-title', 'text-lg leading-none font-semibold', 'h2')
export const DialogDescription = part('dialog-description', 'text-sm text-muted-foreground', 'p')
