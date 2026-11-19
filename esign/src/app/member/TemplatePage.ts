// One template, read only: its details (name, id, owner, the member's role in it, when it was uploaded, its signer
// roles with their default signers, its fields, the member's tags and its metadata), and below them its PDF, with the
// box of each placed field over it, named by role and type. Sending from it is a click away for those who manage.
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Send } from 'lucide-react'
import { Badge } from '../components/ui/badge.ts'
import { buttonVariants } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.ts'
import { api, apiJson, canManage, dateTime, describeError, ownerName, ROLE_NAMES, type DefaultSigner, type Me, type Metadata, type Owned, type PrefillDefinition } from './api.ts'
import { Notice, PageHeader } from './parts.ts'
import { Link } from './router.ts'
import { TagList } from './TagsField.ts'
import { loadPart, reloadForUpdate, StaleVersion } from './update.ts'

const h = React.createElement

/** A placed field; a pre-filled one (type Prefill) has no role, and a name and a label instead. */
type PlacedField = { type: string; role: string; page: number; required?: boolean; rect: { x: number; y: number; width: number; height: number }; name?: string; label?: string }
const PREFILL_COLOR = '#a16207'
export type TemplateDetails = Owned & {
  id: string; name?: string; metadata?: Metadata; defaultSigners?: Record<string, DefaultSigner>; roles: string[]
  fields: PlacedField[]; prefill?: PrefillDefinition[]; createdAt?: number; archivedAt?: number; status?: 'active' | 'draft'
}

/**
 * Shows every page of a PDF in `target` (ui/pdf.ts, loaded on first use), each in a box of its own for the fields to
 * sit in, and returns those boxes in page order. Tests replace it.
 */
export const pdfView = {
  render: async (blob: Blob, target: HTMLElement, signal: AbortSignal): Promise<HTMLElement[]> => {
    const { renderPdf } = await loadPart(() => import('../ui/pdf.ts'))
    signal.throwIfAborted()
    const detached = target.ownerDocument.createElement('div')
    await renderPdf(blob, detached, signal, target, true)
    signal.throwIfAborted()
    const pages = Array.from(detached.querySelectorAll('canvas')).map((canvas, index) => {
      const page = detached.ownerDocument.createElement('div')
      page.dataset.templatePage = String(index + 1)
      page.style.cssText = 'position:relative;display:table;max-width:100%;margin:0 auto 24px;line-height:0;box-shadow:0 1px 3px rgb(0 0 0 / 0.15)'
      canvas.replaceWith(page); page.appendChild(canvas); canvas.style.display = 'block'
      return page
    })
    target.replaceChildren(detached)
    return pages
  },
}

/** Each role's colour on the document, in signing order. */
const ROLE_COLORS = ['#135c9b', '#b54708', '#067647', '#6941c6', '#c11574', '#0e7090']
const colorOf = (roles: string[], role: string) => ROLE_COLORS[Math.max(0, roles.indexOf(role)) % ROLE_COLORS.length]!

/** A role's fields in words: "2 Signature (1 optional), 1 Title". */
function fieldsOf(fields: PlacedField[], role: string): string {
  const counts = new Map<string, { all: number; optional: number }>()
  for (const f of fields) {
    if (f.role !== role) continue
    const count = counts.get(f.type) ?? { all: 0, optional: 0 }
    count.all++
    if (f.required === false && f.type !== 'Date signed') count.optional++
    counts.set(f.type, count)
  }
  if (!counts.size) return 'No fields'
  return [...counts].map(([type, c]) => `${c.all} ${type}${c.optional ? ` (${c.optional} optional)` : ''}`).join(', ')
}

function Detail({ term, children }: { term: string; children?: React.ReactNode }) {
  return h(React.Fragment, null,
    h('dt', { className: 'text-sm text-muted-foreground' }, term),
    h('dd', { className: 'min-w-0 text-sm break-words' }, children))
}

export function TemplatePage({ me, id }: { me: Me; id: string }) {
  const [template, setTemplate] = useState<TemplateDetails | null>(null)
  const [message, setMessage] = useState({ text: '', error: false })
  useEffect(() => {
    apiJson<TemplateDetails>(`/api/templates/${id}`).then(setTemplate)
      .catch((error) => setMessage({ text: describeError(error), error: true }))
  }, [id])

  const back = h(Link, { to: '/templates', className: 'inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground' }, h(ArrowLeft, { className: 'size-4', 'aria-hidden': true }), 'All templates')
  if (!template) return h('div', { className: 'flex flex-col gap-4' }, back, message.text ? h(Notice, { message: message.text, error: message.error }) : h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading the template…'))

  const archived = template.archivedAt !== undefined, draft = template.status === 'draft'
  const metadata = Object.entries(template.metadata ?? {})
  // What signers sign: every placed field but the pre-filled ones.
  const signing = template.fields.filter((f) => f.type !== 'Prefill').length
  return h('div', { className: 'flex flex-col gap-6' },
    back,
    h(PageHeader, {
      title: template.name ?? 'Template',
      description: h('span', { className: 'flex flex-wrap items-center gap-2' },
        archived ? h(Badge, { variant: 'secondary' }, 'Archived') : null,
        draft ? h(Badge, { variant: 'outline' }, 'Draft') : null,
        template.myRole && template.myRole !== 'owner' ? h(Badge, { variant: 'secondary' }, `Shared with you · ${ROLE_NAMES[template.myRole]}`) : null,
        h('span', { className: 'font-mono text-xs' }, template.id)),
      actions: canManage(me) && !archived && !draft ? h(Link, { to: `/envelopes/new?template=${encodeURIComponent(template.id)}`, className: buttonVariants({ variant: 'default' }) }, h(Send, { 'aria-hidden': true }), 'Use') : null,
    }),
    draft && !archived ? h(Notice, { message: 'A draft: it can\'t be used to send envelopes until its owner or an editor saves it as ready in the field editor (Edit in the Templates list).' }) : null,
    archived ? h(Notice, { message: `Archived ${dateTime(template.archivedAt)}: deleted, or replaced by a new version. It is no longer listed and starts no envelope; envelopes sent from it are signed as before.` }) : null,
    h(Card, { 'aria-label': 'Details' },
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Details')), h(CardDescription, null, 'Read only. Its owner and editors change it from the Templates list.')),
      h(CardContent, null,
        h('dl', { className: 'grid gap-x-8 gap-y-3 sm:grid-cols-[max-content_1fr]' },
          h(Detail, { term: 'Name' }, template.name ?? h('span', { className: 'text-muted-foreground' }, 'None')),
          h(Detail, { term: 'Template ID' }, h('span', { className: 'font-mono text-xs' }, template.id)),
          h(Detail, { term: 'Owner' }, ownerName(template.owner, me)),
          template.myRole ? h(Detail, { term: 'Your role' }, ROLE_NAMES[template.myRole]) : null,
          template.createdAt ? h(Detail, { term: 'Uploaded' }, dateTime(template.createdAt)) : null,
          h(Detail, { term: 'Signer roles' },
            h('ol', { 'aria-label': 'Signer roles', className: 'flex flex-col gap-2' }, ...template.roles.map((role, i) => {
              const d = template.defaultSigners?.[role]
              return h('li', { key: role, className: 'flex items-start gap-2' },
                h('span', { className: 'mt-1.5 size-2.5 shrink-0 rounded-full', style: { background: colorOf(template.roles, role) }, 'aria-hidden': true }),
                h('span', { className: 'flex flex-col' },
                  h('span', { className: 'font-medium' }, `${i + 1}. ${role}`),
                  h('span', { className: 'text-xs text-muted-foreground' }, d ? `Usually ${[d.name, d.email].filter(Boolean).join(', ')}` : 'No default signer'),
                  template.fields.length ? h('span', { className: 'text-xs text-muted-foreground' }, fieldsOf(template.fields, role)) : null))
            }))),
          h(Detail, { term: 'Signed on' }, signing ? `${signing} placed ${signing === 1 ? 'field' : 'fields'}` : draft ? 'No fields yet' : 'A signature page added at the end'),
          template.prefill?.length ? h(Detail, { term: 'Pre-filled fields' },
            h('ul', { 'aria-label': 'Pre-filled fields', className: 'flex flex-col gap-1' }, ...template.prefill.map((d) => h('li', { key: d.name, className: 'flex flex-col' },
              h('span', { className: 'font-medium' }, `${d.label}${d.required ? '' : ' (optional)'}`),
              h('span', { className: 'text-xs text-muted-foreground' }, h('code', null, d.name), d.default ? ` · default: ${d.default}` : ''))))) : null,
          h(Detail, { term: 'Your tags' }, template.tags?.length ? h(TagList, { tags: template.tags }) : h('span', { className: 'text-muted-foreground' }, 'None')),
          ...metadata.map(([key, value]) => h(Detail, { key, term: key }, value))))),
    h(Card, { 'aria-label': 'Document' },
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Document')),
        h(CardDescription, null, template.fields.length ? 'The PDF as Esign stores it, read only, with where each role signs or fills in.' : draft ? 'The PDF as Esign stores it, read only. No fields are placed yet.' : 'The PDF as Esign stores it, read only. Each signer signs on a page added at the end.')),
      h(CardContent, null, h(DocumentView, { id: template.id, roles: template.roles, fields: template.fields }))))
}

/** The template's PDF, every page, with each placed field's box over it. */
function DocumentView({ id, roles, fields }: { id: string; roles: string[]; fields: PlacedField[] }) {
  const container = useRef<HTMLDivElement | null>(null)
  const [pages, setPages] = useState<HTMLElement[]>([])
  const [state, setState] = useState<'loading' | 'shown' | 'failed' | 'stale'>('loading')
  useEffect(() => {
    const target = container.current
    if (!target) return
    const controller = new AbortController()
    setState('loading'); setPages([])
    void (async () => {
      try {
        const blob = await (await api(`/api/templates/${id}/pdf`, { signal: controller.signal })).blob()
        const shown = await pdfView.render(blob, target, controller.signal)
        if (controller.signal.aborted) return
        setPages(shown); setState('shown')
      } catch (error) {
        if (controller.signal.aborted) return
        // Esign was updated since the page opened: once, the page reloads to take the new version.
        if (error instanceof StaleVersion) { if (!reloadForUpdate()) setState('stale'); return }
        setState('failed')
      }
    })()
    return () => { controller.abort(); target.replaceChildren?.() }
  }, [id])
  return h('div', { className: 'flex flex-col gap-3' },
    fields.length ? h('ul', { 'aria-label': 'Roles on the document', className: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground' }, ...roles.map((role) =>
      h('li', { key: role, className: 'flex items-center gap-1.5' }, h('span', { className: 'size-2.5 rounded-sm border-2', style: { borderColor: colorOf(roles, role) }, 'aria-hidden': true }), role))) : null,
    state === 'loading' ? h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading the document…') : null,
    state === 'failed' ? h(Notice, { message: 'The document could not be shown. Reload the page to try again.', error: true }) : null,
    state === 'stale' ? h(Notice, { message: 'Esign was updated since this page opened: reload the page to see the document.', error: true }) : null,
    h('div', { ref: container, 'aria-label': 'Template document', className: 'max-h-[80vh] overflow-auto rounded-md bg-muted/40 p-4' }),
    ...fields.map((field, i) => {
      const page = pages[field.page - 1]
      if (!page) return null
      const prefilled = field.type === 'Prefill'
      const color = prefilled ? PREFILL_COLOR : colorOf(roles, field.role)
      const optional = !prefilled && field.required === false && field.type !== 'Date signed'
      return createPortal(h('div', {
        key: i, role: 'note', 'data-template-field': i, 'aria-label': prefilled ? `Pre-filled: ${field.label}, page ${field.page}` : `${field.role}: ${field.type}${optional ? ', optional' : ''}, page ${field.page}`,
        style: { position: 'absolute', boxSizing: 'border-box', left: `${field.rect.x * 100}%`, top: `${field.rect.y * 100}%`, width: `${field.rect.width * 100}%`, height: `${field.rect.height * 100}%`, border: `2px ${optional || prefilled ? 'dashed' : 'solid'} ${color}`, background: `${color}14`, borderRadius: 2, lineHeight: 'normal' },
      }, h('span', { style: { position: 'absolute', left: -2, bottom: '100%', whiteSpace: 'nowrap', background: color, color: '#fff', fontSize: 11, padding: '1px 6px', borderRadius: '3px 3px 0 0' } },
        prefilled ? `Pre-filled · ${field.label}` : `${field.role} · ${field.type}${optional ? ' (optional)' : ''}`)), page, `field-${i}`)
    }))
}
