// The members' pages: a header with E-sign's navigation (Envelopes, Templates, Docs) and the page the address names.
// Who the member is comes from /api/me, the platform's identity; the server checks every request again, so what a role
// can't do is hidden here and refused there. The Docs need no identity: they open for every role, and before sign-in.
import React, { useEffect, useState } from 'react'
import { BookOpen, Files, Inbox, Signature } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { apiJson, describeError, RequestError, type Me } from './api.ts'
import { EnvelopePage } from './EnvelopePage.ts'
import { EnvelopesPage } from './EnvelopesPage.ts'
import { NewEnvelopePage } from './NewEnvelopePage.ts'
import { Notice } from './parts.ts'
import { Link, usePath } from './router.ts'
import { TemplatesPage } from './TemplatesPage.ts'
import { Docs } from '../components/Docs.ts'

const h = React.createElement
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Route =
  | { section: 'envelopes'; page: 'list' | 'new' }
  | { section: 'envelopes'; page: 'envelope'; id: string }
  | { section: 'templates'; page: 'list' }
  | { section: 'docs'; page: 'docs'; topic: string | undefined }
  | { section: null; page: 'missing' }

/** The page an address names. */
export function route(path: string): Route {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'envelopes')) return { section: 'envelopes', page: 'list' }
  if (parts[0] === 'envelopes' && parts.length === 2) {
    if (parts[1] === 'new') return { section: 'envelopes', page: 'new' }
    if (UUID.test(parts[1])) return { section: 'envelopes', page: 'envelope', id: parts[1] }
  }
  if (parts.length === 1 && parts[0] === 'templates') return { section: 'templates', page: 'list' }
  if (parts[0] === 'docs' && parts.length <= 2) return { section: 'docs', page: 'docs', topic: parts[1] }
  return { section: null, page: 'missing' }
}

const NAV = [
  { section: 'envelopes', to: '/', label: 'Envelopes', icon: Inbox },
  { section: 'templates', to: '/templates', label: 'Templates', icon: Files },
  { section: 'docs', to: '/docs', label: 'Docs', icon: BookOpen },
] as const

const ROLE_LABELS: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', USER: 'User', VIEWER: 'Viewer' }

export function MemberApp() {
  const path = usePath()
  const current = route(path)
  const [me, setMe] = useState<Me | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  useEffect(() => { apiJson<Me>('/api/me').then(setMe).catch(setFailure) }, [])

  let page: React.ReactNode
  if (current.page === 'docs') page = h(Docs, { topic: current.topic })
  else if (current.page === 'missing') page = h(NotFound)
  else if (failure) page = failure instanceof RequestError && failure.status === 401 ? h(SignIn) : h(Notice, { message: describeError(failure), error: true })
  else if (!me) page = h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading…')
  else if (current.page === 'new') page = h(NewEnvelopePage, { me })
  else if (current.page === 'envelope') page = h(EnvelopePage, { key: current.id, me, id: current.id })
  else if (current.section === 'templates') page = h(TemplatesPage, { me })
  else page = h(EnvelopesPage, { me })

  const who = me ? me.user?.name || me.user?.email || '' : ''
  return h('div', { className: 'min-h-svh bg-background text-foreground' },
    h('header', { className: 'border-b' },
      h('div', { className: 'mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6' },
        h(Link, { to: '/', className: 'flex items-center gap-2 font-semibold' }, h(Signature, { className: 'size-5', 'aria-hidden': true }), 'E-sign'),
        h('nav', { 'aria-label': 'Primary', className: 'flex flex-1 items-center gap-1' },
          ...NAV.map((item) => {
            const active = item.section === current.section
            return h(Link, {
              key: item.section, to: item.to, 'aria-current': active ? 'page' : undefined,
              className: cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground', active && 'bg-accent text-accent-foreground'),
            }, h(item.icon, { className: 'size-4', 'aria-hidden': true }), item.label)
          })),
        me ? h('p', { className: 'text-sm text-muted-foreground' }, who ? `${who} · ` : '', ROLE_LABELS[me.role ?? ''] ?? me.role ?? '') : null)),
    h('main', { className: 'mx-auto max-w-6xl px-4 py-8 sm:px-6' }, page))
}

function SignIn() {
  return h('div', { className: 'flex flex-col gap-2' },
    h('h1', { className: 'text-2xl font-semibold tracking-tight' }, 'Sign in to use E-sign.'),
    h('p', { className: 'text-sm text-muted-foreground' }, 'E-sign is part of your organization\'s Insulin apps; open it from there. ', h(Link, { to: '/docs', className: 'font-medium text-foreground underline underline-offset-4' }, 'Read the Docs')))
}

function NotFound() {
  return h('div', { className: 'flex flex-col gap-2' },
    h('h1', { className: 'text-2xl font-semibold tracking-tight' }, 'Page not found'),
    h('p', { className: 'text-sm text-muted-foreground' }, 'There is no page at this address. ', h(Link, { to: '/', className: 'font-medium text-foreground underline underline-offset-4' }, 'Go to Envelopes')))
}
