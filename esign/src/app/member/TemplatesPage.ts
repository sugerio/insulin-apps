// Templates: a list of the PDFs envelopes are sent from that the member owns or that are shared with them, each with its
// signer roles, its owner, whether it is shared with them (and as what), the member's own tags and, when someone placed
// them, its fields. A row sends, and its ⋯ menu opens, in a dialog over the list: Edit (its name and default signers, or
// its fields, saved as a new version that takes its place), Tags (the member's own), Share, and Delete, each for the
// roles in it that may (server/esign/ownership.ts). New template opens in a dialog too.
// Those who manage upload a PDF and place its fields in the embedded editor (a template signed on an appended signature
// page is the API's alone), which this page hosts exactly as a host product would: a session for this origin, the source staged, then the
// editor's own save, confirmed against the server.
import React, { useEffect, useRef, useState } from 'react'
import { Ellipsis, Pencil, Plus, Send, SquarePen, Tag, Trash2, Users } from 'lucide-react'
import { Badge } from '../components/ui/badge.ts'
import { DropdownMenu, type MenuItem } from '../components/ui/dropdown-menu.ts'
import { Button, buttonVariants } from '../components/ui/button.ts'
import { Card, CardContent } from '../components/ui/card.ts'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.ts'
import { Input } from '../components/ui/input.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { readSaveResult } from '../ui/editor-save-protocol.ts'
import { allows, api, apiJson, canManage, dateTime, defaultSignersOf, describeError, listPath, MAX_PDF_BYTES, ownerName, ROLE_NAMES, type Me, type Scope, type TemplateSummary } from './api.ts'
import { ContactField } from './ContactField.ts'
import { dateLabels, DATES, FilterButton, FilterChips, Pager, SearchBox, sinceOf, TagsFilter, toggled, useMyTags, usePages, type Chip, type Suggestion } from './ListFilters.ts'
import { Field, Notice, PageHeader } from './parts.ts'
import { Link, navigate } from './router.ts'
import { SharePanel } from './SharePanel.ts'
import { TagList, TagsField } from './TagsField.ts'

const h = React.createElement
const ROLE = /^[A-Za-z0-9_-]{1,64}$/
/**
 * `defaultSigners`: who usually signs as each role of a new PDF, set on the template once the editor has saved it.
 * `replacing`: the template whose fields are being edited, which the saved version replaces.
 */
type Editor = { sessionId: string; url: string; ready: boolean; requestId: string; defaultSigners?: Record<string, { name?: string; email?: string }> | null; replacing?: string }
/** What a row's menu opened: editing it (its details or its fields), the member's tags on it, its sharing, or deleting it. */
type Open = { kind: 'edit'; id: string; tab: 'details' | 'fields' } | { kind: 'tags' | 'share' | 'delete'; id: string }
type Draft = { name: string; people: { name: string; email: string }[] }

/** The roles a template form names, or the problem with them (the server's rule: letters, digits, - and _, unique). */
export function checkRoles(roles: string[]): string {
  const names = roles.map((r) => r.trim())
  if (!names.length || names.some((r) => !r)) return 'Name every role.'
  if (names.some((r) => !ROLE.test(r))) return 'Use letters, digits, - and _ in role names (no spaces), at most 64 characters.'
  if (new Set(names.map((r) => r.toLowerCase())).size !== names.length) return 'Give each role a different name.'
  return ''
}

export function TemplatesPage({ me }: { me: Me }) {
  const manage = canManage(me)
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [roles, setRoles] = useState<string[]>(['signer-1'])
  // Who usually signs as each role, optional: the send form fills them in.
  const [people, setPeople] = useState<{ name: string; email: string }[]>([{ name: '', email: '' }])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const editorFrame = useRef<HTMLIFrameElement | null>(null)
  // The new template's tags; the list's filters; the template whose sharing and tags are open.
  const [newTags, setNewTags] = useState<string[]>([])
  // The list's search and filters (Owner: the member's own, or shared with them), its pages, the member's own tags.
  const [filters, setFilters] = useState<{ q: string; date: string; scope: Scope; tags: string[] }>({ q: '', date: '', scope: '', tags: [] })
  const [pageSize, setPageSize] = useState(25)
  const pager = usePages()
  const [myTags, reloadTags] = useMyTags()
  const latest = useRef(0)
  const [opened, setOpened] = useState<Open | null>(null)
  // The Edit dialog's Details, as typed.
  const [draft, setDraft] = useState<Draft>({ name: '', people: [] })
  // The New template dialog, and the new template's name (the PDF's file name until one is typed).
  const [creating, setCreating] = useState(false)
  const [templateName, setTemplateName] = useState('')

  /** Loads a page: `at.before`, else (no argument) the page being shown again. */
  async function load(at: { before: number | undefined } = { before: pager.before }) {
    const ask = ++latest.current
    try {
      const data = await apiJson<{ templates: TemplateSummary[]; next?: number }>(listPath('/api/templates', { q: filters.q, scope: filters.scope, tags: filters.tags, ...sinceOf(filters.date), limit: pageSize, before: at.before }))
      if (ask !== latest.current) return
      setTemplates(data.templates)
      pager.setNext(data.next)
    } catch (error) { if (ask === latest.current) setMessage({ text: describeError(error), error: true }) }
  }
  // A new filter or page size starts again on page 1.
  useEffect(() => { pager.reset(); setTemplates(null); void load({ before: undefined }) }, [filters.q, filters.date, filters.scope, filters.tags.join('\n'), pageSize])
  const set = (change: Partial<typeof filters>) => setFilters((f) => ({ ...f, ...change }))
  const OWNERS: Record<Exclude<Scope, ''>, string> = { mine: 'Mine', shared: 'Shared with me' }
  const suggestions: Suggestion[] = Object.entries(OWNERS).map(([key, label]) => ({ label, kind: 'Owner', apply: () => set({ scope: key as Scope }) }))
  const chips: Chip[] = [
    ...(filters.q ? [{ label: `Search: ${filters.q}`, clear: () => set({ q: '' }) }] : []),
    ...(filters.date ? [{ label: `Date: ${DATES[filters.date]!.label}`, clear: () => set({ date: '' }) }] : []),
    ...(filters.scope ? [{ label: `Owner: ${OWNERS[filters.scope]}`, clear: () => set({ scope: '' }) }] : []),
    ...filters.tags.map((tag) => ({ label: `Tag: ${tag}`, clear: () => set({ tags: toggled(filters.tags, tag) }) })),
  ]
  function turn(to: 'next' | 'previous') {
    const at = pager.turn(to)
    if (!at) return
    setTemplates(null)
    void load(at)
  }
  function saveTags(id: string, tags: string[]) {
    setTemplates((old) => old?.map((t) => t.id === id ? { ...t, tags } : t) ?? null)
    void run(async () => { await apiJson(`/api/templates/${id}/tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags }) }); reloadTags() })
  }
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage({ text: '', error: false })
    try { await work() } catch (error) { setMessage({ text: describeError(error), error: true }) } finally { setBusy(false) }
  }
  function problem(): string {
    if (!file) return 'Choose a PDF.'
    if (file.size > MAX_PDF_BYTES) return 'The PDF must be 5 MB or smaller.'
    if (!templateName.trim()) return 'Name the template.'
    if (templateName.trim().length > 200) return 'Use at most 200 characters for the name.'
    const signers = defaultSignersOf(roles, people)
    return checkRoles(roles) || (typeof signers === 'string' ? signers : '')
  }
  const defaultSigners = () => defaultSignersOf(roles, people) as Exclude<ReturnType<typeof defaultSignersOf>, string>
  const removeRole = (i: number) => { setRoles((old) => old.filter((_, j) => j !== i)); setPeople((old) => old.filter((_, j) => j !== i)) }
  const setPerson = (i: number, value: Partial<{ name: string; email: string }>) => setPeople((old) => roles.map((_, j) => j === i ? { ...(old[j] ?? { name: '', email: '' }), ...value } : old[j] ?? { name: '', email: '' }))

  /** A session on this origin for the editor: a new PDF (staged as its source), or a new version of a template's fields. */
  function openEditor(source: { file: File; roles: string[]; defaultSigners: ReturnType<typeof defaultSigners> } | { templateId: string }) {
    void run(async () => {
      const body = 'templateId' in source ? { allowedParentOrigin: window.location.origin, sourceTemplateId: source.templateId, replace: true } : { allowedParentOrigin: window.location.origin, roles: source.roles, name: templateName.trim(), ...(newTags.length ? { tags: newTags } : {}) }
      const session = await apiJson<{ sessionId: string; url: string }>('/api/template-editing-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const url = new URL(session.url)
      if (url.origin !== window.location.origin || url.pathname !== `/editor/page/${session.sessionId}`) throw new Error('Unexpected editor address.')
      if ('file' in source) await api(`/api/template-editing-sessions/${session.sessionId}/source`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: source.file })
      setEditor({ sessionId: session.sessionId, url: url.href, ready: false, requestId: '', defaultSigners: 'defaultSigners' in source ? source.defaultSigners : null, ...('templateId' in source ? { replacing: source.templateId } : {}) })
      setCreating(false)
    })
  }
  function placeFields() {
    const invalid = problem()
    if (invalid) { setMessage({ text: invalid, error: true }); return }
    openEditor({ file: file!, roles: roles.map((r) => r.trim()), defaultSigners: defaultSigners() })
  }
  function saveFields() {
    if (!editor || !editor.ready || editor.requestId || !editorFrame.current?.contentWindow) return
    const requestId = crypto.randomUUID()
    setEditor({ ...editor, requestId })
    setMessage({ text: 'Saving the fields…', error: false })
    editorFrame.current.contentWindow.postMessage({ type: 'esign.editor.save', requestId }, window.location.origin)
  }
  useEffect(() => {
    if (!editor) return
    const listen = (event: MessageEvent) => {
      const source = editorFrame.current?.contentWindow
      if (!source || event.source !== source || event.origin !== window.location.origin) return
      if (event.data?.type === 'esign.editor.ready') { setEditor((old) => old && { ...old, ready: true }); return }
      if (!editor.requestId) return
      const result = readSaveResult(event, window.location.origin, source, editor.requestId)
      if (!result) return
      if (result.type === 'esign.editor.save-error') { setEditor((old) => old && { ...old, requestId: '' }); setMessage({ text: result.message, error: true }); return }
      void run(async () => {
        const saved = await apiJson<{ templateId: string | null }>(`/api/template-editing-sessions/${editor.sessionId}`)
        if (saved.templateId !== result.templateId) throw new Error('The editor and the server disagree on the saved template; open the editor again.')
        // A new PDF's default signers, for the roles the editor kept.
        const savedRoles = editor.defaultSigners ? (await apiJson<TemplateSummary>(`/api/templates/${saved.templateId}`)).roles : []
        const kept = Object.fromEntries(Object.entries(editor.defaultSigners ?? {}).filter(([role]) => savedRoles.includes(role)))
        if (Object.keys(kept).length) await apiJson(`/api/templates/${saved.templateId}/default-signers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultSigners: kept }) })
        setEditor(null)
        await load()
        if (editor.replacing) {
          setOpened(null)
          setMessage({ text: 'The fields are saved: the template is a new version now. Envelopes already sent keep the earlier one.', error: false })
          return
        }
        setFile(null)
        setTemplateName('')
        setNewTags([])
        setPeople((old) => old.map(() => ({ name: '', email: '' })))
        setMessage({ text: 'Fields saved as a new template. Send an envelope from it.', error: false })
      })
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [editor])

  /** Opens a row's dialog; Edit starts on its Details, from the template as it is. */
  function open(next: Open) {
    setMessage({ text: '', error: false })
    setEditor(null)
    if (next.kind === 'edit') {
      const t = templates?.find((x) => x.id === next.id)
      setDraft({ name: t?.name ?? '', people: (t?.roles ?? []).map((role) => ({ name: t?.defaultSigners?.[role]?.name ?? '', email: t?.defaultSigners?.[role]?.email ?? '' })) })
    }
    setOpened(next)
  }
  function close() { if (!editor?.requestId) { setEditor(null); setOpened(null) } }
  /** Edit's tabs: Fields opens the editor on a new version; Details closes it. */
  function tab(t: TemplateSummary, next: 'details' | 'fields') {
    setOpened({ kind: 'edit', id: t.id, tab: next })
    if (next === 'fields' && editor?.replacing !== t.id) openEditor({ templateId: t.id })
    if (next === 'details') setEditor(null)
  }
  function saveDetails(t: TemplateSummary) {
    const name = draft.name.trim()
    if (!name) { setMessage({ text: 'Name the template.', error: true }); return }
    const signers = defaultSignersOf(t.roles, draft.people)
    if (typeof signers === 'string') { setMessage({ text: signers, error: true }); return }
    void run(async () => {
      const post = (path: string, body: unknown) => apiJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (name !== (t.name ?? '')) await post(`/api/templates/${t.id}`, { name })
      if (JSON.stringify(signers ?? {}) !== JSON.stringify(t.defaultSigners ?? {})) await post(`/api/templates/${t.id}/default-signers`, { defaultSigners: signers ?? {} })
      await load()
      setOpened(null)
      setMessage({ text: `${name} is saved.`, error: false })
    })
  }
  function remove(t: TemplateSummary) {
    void run(async () => {
      await apiJson(`/api/templates/${t.id}/delete`, { method: 'POST' })
      setOpened(null)
      await load()
      setMessage({ text: `${t.name ?? 'The template'} is deleted. Envelopes already sent from it are kept.`, error: false })
    })
  }
  /** A row's menu: what the member's role in the template, and in Esign, allows. */
  function menu(t: TemplateSummary): MenuItem[] {
    const items: (MenuItem | false)[] = [
      manage && allows(t.myRole, 'editor') && { label: 'Edit', icon: Pencil, onSelect: () => open({ kind: 'edit', id: t.id, tab: 'details' }) },
      { label: 'Tags', icon: Tag, onSelect: () => open({ kind: 'tags', id: t.id }) },
      manage && allows(t.myRole, 'admin') && { label: 'Share', icon: Users, onSelect: () => open({ kind: 'share', id: t.id }) },
      manage && allows(t.myRole, 'admin') && { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => open({ kind: 'delete', id: t.id }) },
    ]
    return items.filter((item): item is MenuItem => !!item)
  }

  const notice = h(Notice, { message: message.text, error: message.error })
  const current = opened ? templates?.find((t) => t.id === opened.id) ?? null : null
  const label = (t: TemplateSummary) => t.name ?? 'this template'
  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, {
      title: 'Templates', description: 'The documents you send for signature, yours or shared with you, with their signer roles and fields.',
      actions: manage ? h(Button, { disabled: !!editor, onClick: () => { setMessage({ text: '', error: false }); setCreating(true) } }, h(Plus, { 'aria-hidden': true }), 'New template') : null,
    }),
    // A message shows where it was asked: in the open dialog, else on the page.
    h(Notice, { message: creating || editor || current ? '' : message.text, error: message.error }),
    h(Dialog, { open: creating, onOpenChange: setCreating, label: 'New template', dismissible: !busy, className: 'sm:max-w-3xl' },
      h(DialogHeader, null, h(DialogTitle, null, 'New template'),
        h(DialogDescription, null, 'A PDF of up to 5 MB and 100 pages, and the roles that sign it, in signing order. Use synthetic documents until your organization has reviewed Esign for real ones.')),
      notice,
      h('div', { className: 'flex flex-col gap-4' },
        h(Field, { label: 'PDF', htmlFor: 'template-pdf' },
          h(Input, { id: 'template-pdf', type: 'file', accept: 'application/pdf', disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const chosen = e.target.files?.[0] ?? null
            setFile(chosen)
            // The file's name, without .pdf, until the member types one.
            if (chosen && !templateName.trim()) setTemplateName(chosen.name.replace(/\.pdf$/i, '').slice(0, 200))
          } })),
        h(Field, { label: 'Name', htmlFor: 'template-name', hint: 'Shown in the list and when you send. The PDF\'s file name until you type one.' },
          h(Input, { id: 'template-name', value: templateName, maxLength: 200, required: true, disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTemplateName(e.target.value) })),
        h('fieldset', { className: 'flex flex-col gap-2' },
          h('legend', { className: 'mb-1 text-sm font-medium' }, 'Signer roles, in signing order'),
          h('p', { className: 'text-xs text-muted-foreground' }, 'A role is required. Its signer\'s name and email are optional: when given, they are filled in each time you send, and can still be changed then.'),
          ...roles.map((role, i) => h('div', { key: i, className: 'grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]' },
            h(Field, { label: `Role ${i + 1}`, htmlFor: `role-${i}` },
              h(Input, { id: `role-${i}`, 'aria-label': `Role ${i + 1}`, value: role, maxLength: 64, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRoles((old) => old.map((r, j) => j === i ? e.target.value : r)) })),
            h(ContactField, { id: `role-${i}-name`, label: 'Signer name (optional)', required: false, value: people[i]?.name ?? '', onChange: (v) => setPerson(i, { name: v }), onChoose: (c) => setPerson(i, { name: c.name, email: c.email }) }),
            h(ContactField, { id: `role-${i}-email`, label: 'Signer email (optional)', type: 'email', required: false, value: people[i]?.email ?? '', onChange: (v) => setPerson(i, { email: v }), onChoose: (c) => setPerson(i, { name: c.name, email: c.email }) }),
            roles.length > 1 ? h(Button, { variant: 'ghost', size: 'icon', 'aria-label': `Remove role ${i + 1}`, onClick: () => removeRole(i) }, h(Trash2, { 'aria-hidden': true })) : h('span'))),
          roles.length < 20 ? h(Button, { variant: 'outline', size: 'sm', className: 'w-fit', onClick: () => { setRoles((old) => [...old, `signer-${old.length + 1}`]); setPeople((old) => [...old, { name: '', email: '' }]) } }, h(Plus, { 'aria-hidden': true }), 'Add a role') : null),
        h(TagsField, { id: 'template-tags', value: newTags, onChange: setNewTags })),
      h(DialogFooter, null,
        h(Button, { variant: 'outline', disabled: busy, onClick: () => setCreating(false) }, 'Cancel'),
        h(Button, { disabled: busy, onClick: placeFields }, h(SquarePen, { 'aria-hidden': true }), 'Upload and place fields'))),
    h(Dialog, { open: !!editor && !editor.replacing, onOpenChange: (open) => { if (!open) setEditor(null) }, label: 'Field editor', dismissible: !editor?.requestId, className: 'sm:max-w-6xl' },
      h(DialogHeader, null, h(DialogTitle, null, 'Place the fields'),
        h(DialogDescription, null, 'Give each role one Signature field, and Title or Date signed fields where you want them; then save. Saving makes a new template.')),
      notice,
      editor && !editor.replacing ? h('iframe', { ref: editorFrame, title: 'Signature field editor', src: editor.url, className: 'h-[70vh] w-full rounded-md border' }) : null,
      h(DialogFooter, null,
        h(Button, { variant: 'outline', disabled: !!editor?.requestId, onClick: () => setEditor(null) }, 'Close the editor'),
        h(Button, { disabled: !editor?.ready || !!editor?.requestId, onClick: saveFields }, editor?.requestId ? 'Saving…' : 'Save fields'))),
    // Edit: Details (name, default signers) or Fields (a new version, in the editor).
    h(Dialog, { open: opened?.kind === 'edit' && !!current, onOpenChange: (o) => { if (!o) close() }, label: 'Edit template', dismissible: !busy && !editor?.requestId, className: opened?.kind === 'edit' && opened.tab === 'fields' ? 'sm:max-w-6xl' : 'sm:max-w-3xl' },
      current && opened?.kind === 'edit' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Edit ${label(current)}`),
          h(DialogDescription, null, opened.tab === 'fields' ? 'Saving the fields makes a new version of the template, which takes its place with the same name, people and tags. Envelopes already sent keep the earlier one.' : 'Its name and who usually signs as each role. Envelopes already sent keep what they were sent with.')),
        h('div', { key: 'tabs', role: 'tablist', 'aria-label': 'Edit', className: 'inline-flex w-fit items-center rounded-lg bg-muted p-[3px] text-muted-foreground' },
          ...(['details', 'fields'] as const).map((t) => h('button', {
            key: t, type: 'button', role: 'tab', 'aria-selected': opened.tab === t, disabled: !!editor?.requestId,
            className: `inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-[color,box-shadow] ${opened.tab === t ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}`,
            onClick: () => tab(current, t),
          }, t === 'details' ? 'Details' : 'Fields'))),
        h('div', { key: 'notice' }, notice),
        opened.tab === 'details' ? h('div', { key: 'details', role: 'tabpanel', className: 'flex flex-col gap-4' },
          h(Field, { label: 'Name', htmlFor: 'edit-template-name' },
            h(Input, { id: 'edit-template-name', value: draft.name, maxLength: 200, disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, name: e.target.value })) })),
          h('fieldset', { className: 'flex flex-col gap-2' },
            h('legend', { className: 'mb-1 text-sm font-medium' }, 'Default signers'),
            h('p', { className: 'text-xs text-muted-foreground' }, 'Optional: filled in each time someone sends it, and can still be changed then. Its roles are part of its fields.'),
            ...current.roles.map((role, i) => h('div', { key: role, className: 'grid items-end gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]' },
              h('div', { className: 'pb-2 text-sm font-medium' }, role),
              h(ContactField, { id: `edit-${i}-name`, label: 'Signer name', required: false, value: draft.people[i]?.name ?? '', onChange: (v) => setDraft((d) => ({ ...d, people: d.people.map((p, j) => j === i ? { ...p, name: v } : p) })), onChoose: (c) => setDraft((d) => ({ ...d, people: d.people.map((p, j) => j === i ? { name: c.name, email: c.email } : p) })) }),
              h(ContactField, { id: `edit-${i}-email`, label: 'Signer email', type: 'email', required: false, value: draft.people[i]?.email ?? '', onChange: (v) => setDraft((d) => ({ ...d, people: d.people.map((p, j) => j === i ? { ...p, email: v } : p) })), onChoose: (c) => setDraft((d) => ({ ...d, people: d.people.map((p, j) => j === i ? { name: c.name, email: c.email } : p) })) }))))) 
          : h('div', { key: 'fields', role: 'tabpanel' }, editor?.replacing === current.id ? h('iframe', { ref: editorFrame, title: 'Signature field editor', src: editor.url, className: 'h-[65vh] w-full rounded-md border' }) : h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Opening the field editor…')),
        h(DialogFooter, { key: 'footer' },
          h(Button, { variant: 'outline', disabled: busy || !!editor?.requestId, onClick: close }, 'Cancel'),
          opened.tab === 'details'
            ? h(Button, { disabled: busy, onClick: () => saveDetails(current) }, busy ? 'Saving…' : 'Save')
            : h(Button, { disabled: !editor?.ready || !!editor?.requestId, onClick: saveFields }, editor?.requestId ? 'Saving…' : 'Save fields')),
      ] : null),
    h(Dialog, { open: opened?.kind === 'tags' && !!current, onOpenChange: (o) => { if (!o) close() }, label: 'Your tags', className: 'sm:max-w-lg' },
      current && opened?.kind === 'tags' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Your tags on ${label(current)}`), h(DialogDescription, null, 'Only you see them. Filter the list by them with With your tags.')),
        h('div', { key: 'notice' }, notice),
        h(TagsField, { key: 'tags', id: 'opened-template-tags', value: current.tags ?? [], onChange: (tags) => saveTags(current.id, tags) }),
        h(DialogFooter, { key: 'footer' }, h(Button, { variant: 'outline', onClick: close }, 'Done')),
      ] : null),
    h(Dialog, { open: opened?.kind === 'share' && !!current, onOpenChange: (o) => { if (!o) close() }, label: 'Who sees the template', className: 'sm:max-w-2xl' },
      current && opened?.kind === 'share' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Who sees ${label(current)}`),
          h(DialogDescription, null, 'Its owner and the people it is shared with. Viewers send envelopes from it; editors also edit it; admins also share and delete it.')),
        h(SharePanel, { key: current.id, kind: 'templates', id: current.id, me, onLeft: () => { setOpened(null); void load() } }),
        h(DialogFooter, { key: 'footer' }, h(Button, { variant: 'outline', onClick: close }, 'Close')),
      ] : null),
    h(Dialog, { open: opened?.kind === 'delete' && !!current, onOpenChange: (o) => { if (!o) close() }, label: 'Delete template', dismissible: !busy },
      current && opened?.kind === 'delete' ? [
        h(DialogHeader, { key: 'header' }, h(DialogTitle, null, `Delete ${label(current)}?`),
          h(DialogDescription, null, 'It will no longer appear in Esign, for you or the people it is shared with. Envelopes already sent from it are kept and can still be signed, and a system that sends with its id goes on working. This can\'t be undone here.')),
        h('div', { key: 'notice' }, notice),
        h(DialogFooter, { key: 'footer' },
          h(Button, { variant: 'outline', disabled: busy, onClick: close }, 'Keep it'),
          h(Button, { variant: 'destructive', disabled: busy, onClick: () => remove(current) }, busy ? 'Deleting…' : 'Delete template')),
      ] : null),
    h('div', { className: 'flex flex-col gap-3' },
      h('div', { className: 'flex flex-wrap items-center gap-2' },
        h(SearchBox, { id: 'template-search', label: 'Search templates', value: filters.q, onSearch: (q) => set({ q }), suggestions }),
        h(FilterButton, { name: 'Date', value: filters.date, options: dateLabels, onChange: (date) => set({ date }) }),
        h(FilterButton, { name: 'Owner', value: filters.scope, options: OWNERS, onChange: (scope) => set({ scope: scope as Scope }) }),
        h(TagsFilter, { picked: filters.tags, mine: myTags, what: 'templates', onChange: (tags) => set({ tags }) }),
        chips.length ? h(Button, { variant: 'ghost', onClick: () => setFilters({ q: '', date: '', scope: '', tags: [] }) }, 'Clear all') : null),
      h(FilterChips, { chips })),
    h(Card, { className: 'py-0' }, h(CardContent, { className: 'px-0' },
      templates === null ? h('p', { role: 'status', className: 'p-6 text-sm text-muted-foreground' }, 'Loading templates…')
        : templates.length === 0 ? h('p', { className: 'p-6 text-sm text-muted-foreground' }, chips.length ? 'No templates match.' : manage ? 'No templates yet. Choose New template to upload a PDF.' : 'No templates shared with you yet.')
          : h(Table, { 'aria-label': 'Templates' },
            h(TableHeader, null, h(TableRow, null, h(TableHead, { className: 'pl-6' }, 'Template'), h(TableHead, null, 'Roles'), h(TableHead, null, 'Signed on'), h(TableHead, null, 'Owner'), h(TableHead, null, 'Access'), h(TableHead, null, 'Uploaded'), h(TableHead, { className: 'pr-6' }, h('span', { className: 'sr-only' }, 'Actions')))),
            h(TableBody, null, ...templates.map((t) => h(TableRow, { key: t.id },
              h(TableCell, { className: 'pl-6 whitespace-normal' }, t.name ? h('div', { className: 'font-medium' }, t.name) : null, h('div', { className: t.name ? 'font-mono text-xs text-muted-foreground' : 'font-mono text-xs' }, t.id), h(TagList, { tags: t.tags })),
              h(TableCell, { className: 'whitespace-normal' }, t.roles.map((role) => { const d = t.defaultSigners?.[role]; return d ? `${role} (${d.name ?? d.email})` : role }).join(', ')),
              h(TableCell, null, t.fields.length ? `${t.fields.length} placed ${t.fields.length === 1 ? 'field' : 'fields'}` : 'A signature page'),
              h(TableCell, { className: 'text-muted-foreground' }, ownerName(t.owner, me)),
              // Whether someone shared it with the member, and as what; theirs says nothing.
              h(TableCell, null, t.myRole && t.myRole !== 'owner' ? h(Badge, { variant: 'secondary' }, `Shared with you · ${ROLE_NAMES[t.myRole]}`) : null),
              h(TableCell, { className: 'text-muted-foreground' }, dateTime(t.createdAt)),
              h(TableCell, { className: 'pr-6 text-right' }, h('div', { className: 'flex items-center justify-end gap-2' },
                manage ? h(Link, { to: `/envelopes/new?template=${encodeURIComponent(t.id)}`, className: buttonVariants({ size: 'sm', variant: 'outline' }) }, h(Send, { 'aria-hidden': true }), 'Send') : null,
                h(DropdownMenu, { label: `More for ${t.name ?? t.id}`, items: menu(t), trigger: (props) => h(Button, { ...props, variant: 'ghost', size: 'icon-sm', disabled: !!editor }, h(Ellipsis, { 'aria-hidden': true })) }))))))))),
    h(Pager, { id: 'template', page: pager.page, pageSize, hasNext: pager.next !== undefined, busy: templates === null, onPageSize: setPageSize, onTurn: turn }),
    !manage ? h('p', { className: 'text-sm text-muted-foreground' }, 'Your role can see templates but not change them. ', h('a', { href: '/docs/roles', onClick: (e: React.MouseEvent) => { e.preventDefault(); navigate('/docs/roles') }, className: 'font-medium text-foreground underline underline-offset-4' }, 'Roles and permissions')) : null)
}
