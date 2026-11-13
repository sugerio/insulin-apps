// Envelopes: those the member owns or that are shared with them, newest first. Each row names its document and whom it
// is to, shows where it stands (out for signature: how many have signed and whose turn it is; else its status), its
// owner and when it last changed, and one action that fits its state (Resend to the signer whose turn it is, Download a
// completed one's signed PDF, else View), with the rest in its ⋯ menu (Void, Tags, Share). Above the list: a search (the
// document, a signer's name or email, an envelope id; while empty, it offers the common filters), Date, Status, Sender
// (theirs, or shared with them), Quick views (waiting for others, expiring soon) and Tags (the member's own, picked from
// those they use), each shown
// as a chip that removes it, and Clear all; below it, pages. Those who manage send new ones and run the due work.
import React, { useEffect, useRef, useState } from 'react'
import { Ban, Download, Ellipsis, Eye, Mail, Plus, RefreshCw, Tag, Users } from 'lucide-react'
import { Button, buttonVariants } from '../components/ui/button.ts'
import { Card, CardContent } from '../components/ui/card.ts'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.ts'
import { DropdownMenu, type MenuItem } from '../components/ui/dropdown-menu.ts'
import { Label } from '../components/ui/label.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { Textarea } from '../components/ui/textarea.ts'
import { allows, api, apiJson, canManage, dateTime, describeError, envelopesPath, listPath, ownerName, statusLabel, taskLabel, type EnvelopeSummary, type Me, type Scope } from './api.ts'
import { dateLabels, DATES, FilterButton, FilterChips, Pager, SearchBox, SENDERS, sinceOf, TagsFilter, toggled, useMyTags, usePages, type Chip, type Suggestion } from './ListFilters.ts'
import { Notice, PageHeader, StatusBadge } from './parts.ts'
import { Link, navigate } from './router.ts'
import { SharePanel } from './SharePanel.ts'
import { TagList, TagsField } from './TagsField.ts'

const h = React.createElement
/** The Status filter, from the address: out for signature includes the seconds an envelope spends finishing. */
const STATUSES: Record<string, { label: string; query: string }> = {
  IN_PROGRESS: { label: 'In progress', query: 'IN_PROGRESS,FINALIZING' }, COMPLETED: { label: 'Completed', query: 'COMPLETED' },
  DECLINED: { label: 'Declined', query: 'DECLINED' }, VOIDED: { label: 'Voided', query: 'VOIDED' }, EXPIRED: { label: 'Expired', query: 'EXPIRED' },
}
const VIEWS: Record<string, string> = { waiting: 'Waiting for others', expiring: 'Expiring soon' }

type Filters = { q: string; date: string; scope: Scope; view: string; tags: string[] }
const NONE: Filters = { q: '', date: '', scope: '', view: '', tags: [] }
type Open = { kind: 'void' | 'tags' | 'share'; envelope: EnvelopeSummary }

/** Where an envelope stands: out for signature, a bar of how many have signed and whose turn it is; else its status. */
function Progress({ envelope }: { envelope: EnvelopeSummary }) {
  if (envelope.status !== 'IN_PROGRESS' && envelope.status !== 'FINALIZING') return h(StatusBadge, { status: envelope.status })
  const finishing = envelope.status === 'FINALIZING'
  const { signed, total } = envelope.progress ?? { signed: 0, total: 0 }
  const percent = finishing ? 100 : total ? Math.max(3, Math.round((signed / total) * 100)) : 3
  const order = (envelope.signers ?? []).map((s, i) => `${i + 1}. ${s.name} (${s.email}): ${taskLabel(s.status)}`).join('\n')
  return h('div', { className: 'flex w-48 flex-col gap-1.5' },
    h('div', { role: 'progressbar', 'aria-label': 'Signed', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': finishing ? total : signed, className: 'h-1.5 w-full overflow-hidden rounded-full bg-muted' },
      h('div', { className: 'h-full rounded-full bg-primary', style: { width: `${percent}%` } })),
    h('span', { title: order, className: 'w-fit cursor-help text-sm underline decoration-dotted underline-offset-4' },
      finishing ? 'Finishing' : envelope.current ? `Waiting for ${envelope.current.name}` : statusLabel(envelope.status)),
    h('span', { className: 'text-xs text-muted-foreground' }, `${finishing ? total : signed} of ${total} signed`))
}

/** `status` comes from the address (`/envelopes?status=completed`), so the navigation's status items and the filter agree. */
export function EnvelopesPage({ me, status = '' }: { me: Me; status?: string }) {
  const manage = canManage(me)
  const [envelopes, setEnvelopes] = useState<EnvelopeSummary[] | null>(null)
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const [filters, setFilters] = useState<Filters>(NONE)
  const [myTags, reloadTags] = useMyTags()
  const [pageSize, setPageSize] = useState(25)
  const pager = usePages()
  const [opened, setOpened] = useState<Open | null>(null)
  const [reason, setReason] = useState('')
  const latest = useRef(0)
  const statusKey = status === 'FINALIZING' ? 'IN_PROGRESS' : status

  /** Loads a page: `at.before`, else (no argument) the page being shown again. */
  async function load(at: { before: number | undefined } = { before: pager.before }) {
    const ask = ++latest.current
    try {
      const data = await apiJson<{ envelopes: EnvelopeSummary[]; next?: number }>(listPath('/api/envelopes', {
        status: STATUSES[statusKey]?.query, scope: filters.scope, tags: filters.tags, q: filters.q, view: filters.view,
        ...sinceOf(filters.date), limit: pageSize, before: at.before,
      }))
      if (ask !== latest.current) return
      setEnvelopes(data.envelopes)
      pager.setNext(data.next)
    } catch (error) { if (ask === latest.current) setMessage({ text: describeError(error), error: true }) }
  }
  // A new filter or page size starts again on page 1.
  useEffect(() => { pager.reset(); setEnvelopes(null); void load({ before: undefined }) }, [statusKey, filters.q, filters.date, filters.scope, filters.view, filters.tags.join('\n'), pageSize])

  function set(change: Partial<Filters>) { setFilters((f) => ({ ...f, ...change })) }
  function clearAll() { setFilters(NONE); if (status) navigate(envelopesPath('')) }
  function turn(to: 'next' | 'previous') {
    const at = pager.turn(to)
    if (!at) return
    setEnvelopes(null)
    void load(at)
  }
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage({ text: '', error: false })
    try { await work() } catch (error) { setMessage({ text: describeError(error), error: true }) } finally { setBusy(false) }
  }

  function processDue() {
    void run(async () => {
      const counts = await apiJson<{ expired?: number; completed?: number; waiting?: number; failed?: number }>('/api/process-due', { method: 'POST' })
      const parts = [
        counts.expired ? `${counts.expired} expired` : '',
        counts.completed ? `${counts.completed} completed` : '',
        counts.waiting ? `${counts.waiting} still waiting` : '',
        counts.failed ? `${counts.failed} couldn't be finished yet` : '',
      ].filter(Boolean)
      await load()
      setMessage({ text: parts.length ? `Due work done: ${parts.join(', ')}.` : 'Nothing was due.', error: !!counts.failed })
    })
  }
  const name = (e: EnvelopeSummary) => e.documentName || 'Untitled document'
  function resend(e: EnvelopeSummary) {
    if (!e.current) return
    const to = e.current
    void run(async () => {
      // 204, no body.
      await api(`/api/envelopes/${e.id}/tasks/${to.taskId}/invitation`, { method: 'POST' })
      await load()
      setMessage({ text: `The invitation was emailed again to ${to.email}. The earlier link no longer works.`, error: false })
    })
  }
  function download(e: EnvelopeSummary) {
    void run(async () => {
      const blob = await (await api(`/api/envelopes/${e.id}/delivery-pdf`)).blob()
      if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${name(e).replace(/[^\w.-]+/g, '-')}-signed.pdf`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    })
  }
  function voidEnvelope(e: EnvelopeSummary) {
    void run(async () => {
      await api(`/api/envelopes/${e.id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}) })
      setOpened(null)
      setReason('')
      await load()
      setMessage({ text: `${name(e)} is voided. Nobody can sign it any more.`, error: false })
    })
  }
  function saveTags(e: EnvelopeSummary, tags: string[]) {
    setEnvelopes((old) => old?.map((x) => x.id === e.id ? { ...x, tags } : x) ?? null)
    setOpened((o) => o && { ...o, envelope: { ...o.envelope, tags } })
    void run(async () => { await apiJson(`/api/envelopes/${e.id}/tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags }) }); reloadTags() })
  }

  /** The one action that fits the envelope's state, for those its role allows. */
  const canResend = (e: EnvelopeSummary) => manage && allows(e.myRole, 'editor') && e.status === 'IN_PROGRESS' && e.current?.delivery === 'email'
  function primary(e: EnvelopeSummary) {
    if (canResend(e)) return h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => resend(e) }, h(Mail, { 'aria-hidden': true }), 'Resend')
    if (e.status === 'COMPLETED') return h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => download(e) }, h(Download, { 'aria-hidden': true }), 'Download')
    return h(Link, { to: `/envelopes/${e.id}`, className: buttonVariants({ size: 'sm', variant: 'outline' }) }, h(Eye, { 'aria-hidden': true }), 'View')
  }
  function menu(e: EnvelopeSummary): MenuItem[] {
    const items: (MenuItem | false)[] = [
      { label: 'View', icon: Eye, onSelect: () => navigate(`/envelopes/${e.id}`) },
      manage && allows(e.myRole, 'editor') && e.status === 'IN_PROGRESS' && { label: 'Void', icon: Ban, destructive: true, onSelect: () => { setReason(''); setOpened({ kind: 'void', envelope: e }) } },
      { label: 'Tags', icon: Tag, onSelect: () => setOpened({ kind: 'tags', envelope: e }) },
      manage && allows(e.myRole, 'admin') && { label: 'Share', icon: Users, onSelect: () => setOpened({ kind: 'share', envelope: e }) },
    ]
    return items.filter((item): item is MenuItem => !!item)
  }

  // While the search is empty and focused, the common filters, one click each.
  const suggestions: Suggestion[] = [
    ...Object.entries(STATUSES).map(([key, s]) => ({ label: s.label, kind: 'Status', apply: () => navigate(envelopesPath(key)) })),
    ...Object.entries(SENDERS).map(([key, label]) => ({ label, kind: 'Sender', apply: () => set({ scope: key as Scope }) })),
    ...Object.entries(VIEWS).map(([key, label]) => ({ label, kind: 'Quick view', apply: () => set({ view: key }) })),
  ]
  const chips: Chip[] = [
    ...(filters.q ? [{ label: `Search: ${filters.q}`, clear: () => set({ q: '' }) }] : []),
    ...(filters.date ? [{ label: `Date: ${DATES[filters.date]!.label}`, clear: () => set({ date: '' }) }] : []),
    ...(STATUSES[statusKey] ? [{ label: `Status: ${STATUSES[statusKey]!.label}`, clear: () => navigate(envelopesPath('')) }] : []),
    ...(filters.scope ? [{ label: `Sender: ${SENDERS[filters.scope]}`, clear: () => set({ scope: '' }) }] : []),
    ...(filters.view ? [{ label: `Quick view: ${VIEWS[filters.view]}`, clear: () => set({ view: '' }) }] : []),
    ...filters.tags.map((tag) => ({ label: `Tag: ${tag}`, clear: () => set({ tags: toggled(filters.tags, tag) }) })),
  ]
  const current = opened?.envelope

  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, {
      title: 'Envelopes',
      description: 'Documents sent for signature that are yours or shared with you, newest first.',
      actions: manage ? [
        h(Button, { key: 'due', variant: 'outline', disabled: busy, onClick: processDue }, h(RefreshCw, { 'aria-hidden': true }), 'Process due work'),
        h(Link, { key: 'new', to: '/envelopes/new', className: buttonVariants() }, h(Plus, { 'aria-hidden': true }), 'New envelope'),
      ] : null,
    }),
    me.signingEnabled === false ? h(Notice, { message: 'Signing isn\'t set up on this deployment yet, so envelopes can\'t be signed. An administrator of the deployment adds its settings.' }) : null,
    h(Notice, { message: opened ? '' : message.text, error: message.error }),
    h('div', { className: 'flex flex-col gap-3' },
      h('div', { className: 'flex flex-wrap items-center gap-2' },
        h(SearchBox, { id: 'envelope-search', label: 'Search envelopes', value: filters.q, onSearch: (q) => set({ q }), suggestions }),
        h(FilterButton, { name: 'Date', value: filters.date, options: dateLabels, onChange: (date) => set({ date }) }),
        h(FilterButton, { name: 'Status', value: STATUSES[statusKey] ? statusKey : '', options: Object.fromEntries(Object.entries(STATUSES).map(([k, s]) => [k, s.label])), onChange: (key) => navigate(envelopesPath(key)) }),
        h(FilterButton, { name: 'Sender', value: filters.scope, options: SENDERS, onChange: (scope) => set({ scope: scope as Scope }) }),
        h(FilterButton, { name: 'Quick views', value: filters.view, options: VIEWS, onChange: (view) => set({ view }) }),
        h(TagsFilter, { picked: filters.tags, mine: myTags, what: 'envelopes', onChange: (tags) => set({ tags }) }),
        chips.length ? h(Button, { variant: 'ghost', onClick: clearAll }, 'Clear all') : null),
      h(FilterChips, { chips })),
    h(Card, { className: 'py-0' }, h(CardContent, { className: 'px-0' },
      envelopes === null ? h('p', { role: 'status', className: 'p-6 text-sm text-muted-foreground' }, 'Loading envelopes…')
        : envelopes.length === 0 ? h('div', { className: 'flex flex-col items-start gap-2 p-6' },
          h('p', { className: 'text-sm text-muted-foreground' }, chips.length ? 'No envelopes match.' : 'No envelopes yet.'),
          !chips.length ? h('p', { className: 'text-sm text-muted-foreground' }, manage ? 'Upload a template, then send an envelope from it. ' : 'Envelopes shared with you appear here. ', h(Link, { to: '/docs/getting-started', className: 'font-medium text-foreground underline underline-offset-4' }, 'How Esign works')) : null)
          : h(Table, { 'aria-label': 'Envelopes' },
            h(TableHeader, null, h(TableRow, null,
              h(TableHead, { className: 'pl-6' }, 'Name'), h(TableHead, null, 'Status'), h(TableHead, null, 'Owner'), h(TableHead, null, 'Last change'), h(TableHead, { className: 'pr-6' }, h('span', { className: 'sr-only' }, 'Actions')))),
            h(TableBody, null, ...envelopes.map((e) => h(TableRow, { key: e.id },
              h(TableCell, { className: 'pl-6 whitespace-normal' },
                h(Link, { to: `/envelopes/${e.id}`, className: 'font-medium underline-offset-4 hover:underline' }, name(e)),
                e.signers?.length ? h('div', { className: 'text-sm text-muted-foreground' }, `To: ${e.signers.map((s) => s.name).join(', ')}`) : null,
                h(TagList, { tags: e.tags })),
              h(TableCell, null, h(Progress, { envelope: e })),
              h(TableCell, { className: 'text-muted-foreground' }, ownerName(e.owner, me)),
              h(TableCell, { className: 'text-muted-foreground' }, dateTime(e.lastChangeAt ?? e.createdAt)),
              h(TableCell, { className: 'pr-6 text-right' }, h('div', { className: 'flex items-center justify-end gap-2' },
                primary(e),
                h(DropdownMenu, { label: `More for ${name(e)}`, items: menu(e), trigger: (props) => h(Button, { ...props, variant: 'ghost', size: 'icon-sm' }, h(Ellipsis, { 'aria-hidden': true })) }))))))))),
    h(Pager, { id: 'envelope', page: pager.page, pageSize, hasNext: pager.next !== undefined, busy: envelopes === null, onPageSize: setPageSize, onTurn: turn }),
    h(Dialog, { open: opened?.kind === 'void', onOpenChange: (o) => { if (!o) setOpened(null) }, label: 'Void envelope', dismissible: !busy },
      current && opened?.kind === 'void' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Void ${name(current)}?`), h(DialogDescription, null, 'Signers who haven\'t signed can no longer open, verify or sign it. This can\'t be undone.')),
        h(Notice, { key: 'notice', message: message.text, error: message.error }),
        h('div', { key: 'reason', className: 'flex flex-col gap-2' },
          h(Label, { htmlFor: 'list-void-reason' }, 'Reason (optional, kept in the audit trail)'),
          h(Textarea, { id: 'list-void-reason', maxLength: 500, value: reason, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value) })),
        h(DialogFooter, { key: 'footer' },
          h(Button, { variant: 'outline', disabled: busy, onClick: () => setOpened(null) }, 'Keep it'),
          h(Button, { variant: 'destructive', disabled: busy, onClick: () => voidEnvelope(current) }, busy ? 'Voiding…' : 'Void envelope')),
      ] : null),
    h(Dialog, { open: opened?.kind === 'tags', onOpenChange: (o) => { if (!o) setOpened(null) }, label: 'Your tags' },
      current && opened?.kind === 'tags' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Your tags on ${name(current)}`), h(DialogDescription, null, 'Only you see them. Tags, above the list, filters it by them.')),
        h(TagsField, { key: 'tags', id: 'list-envelope-tags', value: current.tags ?? [], onChange: (tags) => saveTags(current, tags) }),
        h(DialogFooter, { key: 'footer' }, h(Button, { variant: 'outline', onClick: () => setOpened(null) }, 'Done')),
      ] : null),
    h(Dialog, { open: opened?.kind === 'share', onOpenChange: (o) => { if (!o) setOpened(null) }, label: 'Who sees the envelope', className: 'sm:max-w-2xl' },
      current && opened?.kind === 'share' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Who sees ${name(current)}`), h(DialogDescription, null, 'Its owner and the people it is shared with. Viewers see it; editors also void it and resend invitations; admins also share it.')),
        h(SharePanel, { key: current.id, kind: 'envelopes', id: current.id, me, onLeft: () => { setOpened(null); void load() } }),
        h(DialogFooter, { key: 'footer' }, h(Button, { variant: 'outline', onClick: () => setOpened(null) }, 'Close')),
      ] : null))
}
