// Small pieces the member pages share: a page heading, a status badge, a notice, a field with its label.
import React from 'react'
import { Alert, AlertDescription } from '../components/ui/alert.ts'
import { Badge } from '../components/ui/badge.ts'
import { Label } from '../components/ui/label.ts'
import { statusLabel } from './api.ts'

const h = React.createElement

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return h('div', { className: 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between' },
    h('div', { className: 'flex min-w-0 flex-col gap-1' },
      h('h1', { className: 'text-2xl font-semibold tracking-tight' }, title),
      description ? h('p', { className: 'text-sm text-muted-foreground' }, description) : null),
    actions ? h('div', { className: 'flex shrink-0 flex-wrap gap-2' }, actions) : null)
}

/** An envelope's status as a badge: finished ones solid, open ones outlined, ended ones muted. */
export function StatusBadge({ status }: { status: string }) {
  const variant = status === 'COMPLETED' ? 'default' : status === 'IN_PROGRESS' || status === 'FINALIZING' ? 'outline' : status === 'DECLINED' ? 'destructive' : 'secondary'
  return h(Badge, { variant }, statusLabel(status))
}

/** A message for the member: an error is an alert, anything else a polite status. */
export function Notice({ message, error = false }: { message: string; error?: boolean }) {
  if (!message) return h('p', { role: 'status', className: 'sr-only' })
  return h(Alert, { variant: error ? 'destructive' : 'default', role: error ? 'alert' : 'status' }, h(AlertDescription, null, message))
}

/** A labelled control: the label above it, an optional hint below. */
export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children?: React.ReactNode }) {
  return h('div', { className: 'flex flex-col gap-2' },
    h(Label, { htmlFor }, label),
    children,
    hint ? h('p', { className: 'text-xs text-muted-foreground' }, hint) : null)
}
