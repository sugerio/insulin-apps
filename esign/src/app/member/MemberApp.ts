// The members' pages: the two-level navigation (Shell.ts: Envelopes and Templates from package.json
// `insulin.navigation`, Docs and Settings) beside the page the address names. Who the member is comes from /api/me, the
// platform's identity; the server checks every request again, so what a role can't do is hidden here and refused there.
// The Docs need no identity: they open for every role, and before sign-in.
import React, { useEffect, useState } from 'react'
import { apiJson, describeError, RequestError, STATUS_LABELS, statusFilter, type Me } from './api.ts'
import { EnvelopePage } from './EnvelopePage.ts'
import { EnvelopesPage } from './EnvelopesPage.ts'
import { NewEnvelopePage } from './NewEnvelopePage.ts'
import { Notice } from './parts.ts'
import { Link, usePath, useSearch } from './router.ts'
import { Shell } from './Shell.ts'
import { TemplatesPage } from './TemplatesPage.ts'
import { Docs } from '../components/Docs.ts'
import { docTopic } from '../pages/docs/topics.ts'

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

/** The page's name, the breadcrumb's last part. */
export function pageTitle(current: Route, status: string): string {
  if (current.page === 'list' && current.section === 'envelopes') return status ? STATUS_LABELS[status]! : 'All envelopes'
  if (current.page === 'new') return 'New envelope'
  if (current.page === 'envelope') return 'Envelope'
  if (current.page === 'list') return 'Templates'
  if (current.page === 'docs') return docTopic(current.topic)?.title ?? 'Topic not found'
  return 'Page not found'
}

const ROLE_LABELS: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', USER: 'User', VIEWER: 'Viewer' }

export function MemberApp() {
  const path = usePath()
  const search = useSearch()
  const current = route(path)
  const status = statusFilter(search)
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
  else page = h(EnvelopesPage, { me, status })

  return h(Shell, {
    pathname: path, search, role: me?.role, user: me?.user ?? null,
    roleLabel: me ? ROLE_LABELS[me.role ?? ''] ?? me.role : undefined,
    title: pageTitle(current, status),
  }, page)
}

function SignIn() {
  return h('div', { className: 'flex flex-col gap-2' },
    h('h1', { className: 'text-2xl font-semibold tracking-tight' }, 'Sign in to use Esign.'),
    h('p', { className: 'text-sm text-muted-foreground' }, 'Esign is part of your organization\'s Insulin apps; open it from there. ', h(Link, { to: '/docs', className: 'font-medium text-foreground underline underline-offset-4' }, 'Read the Docs')))
}

function NotFound() {
  return h('div', { className: 'flex flex-col gap-2' },
    h('h1', { className: 'text-2xl font-semibold tracking-tight' }, 'Page not found'),
    h('p', { className: 'text-sm text-muted-foreground' }, 'There is no page at this address. ', h(Link, { to: '/', className: 'font-medium text-foreground underline underline-offset-4' }, 'Go to Envelopes')))
}
