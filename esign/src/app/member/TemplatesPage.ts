// Templates: the PDFs envelopes are sent from, each with its signer roles and, when someone placed them, its fields.
// Those who manage upload a PDF and place its fields in the embedded editor (a template signed on an appended signature
// page is the API's alone), which this page hosts exactly as a host product would: a session for this origin, the source staged, then the
// editor's own save, confirmed against the server.
import React, { useEffect, useRef, useState } from 'react'
import { Plus, Send, SquarePen, Trash2 } from 'lucide-react'
import { Button, buttonVariants } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { Input } from '../components/ui/input.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { readSaveResult } from '../ui/editor-save-protocol.ts'
import { api, apiJson, canManage, dateTime, defaultSignersOf, describeError, MAX_PDF_BYTES, type Me, type TemplateSummary } from './api.ts'
import { ContactField } from './ContactPicker.ts'
import { Field, Notice, PageHeader } from './parts.ts'
import { Link, navigate } from './router.ts'

const h = React.createElement
const ROLE = /^[A-Za-z0-9_-]{1,64}$/
/** `defaultSigners`: who usually signs as each role of a new PDF, set on the template once the editor has saved it. */
type Editor = { sessionId: string; url: string; ready: boolean; requestId: string; defaultSigners?: Record<string, { name?: string; email?: string }> | null }

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

  async function load() {
    try { setTemplates((await apiJson<{ templates: TemplateSummary[] }>('/api/templates')).templates) }
    catch (error) { setMessage({ text: describeError(error), error: true }) }
  }
  useEffect(() => { void load() }, [])
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage({ text: '', error: false })
    try { await work() } catch (error) { setMessage({ text: describeError(error), error: true }) } finally { setBusy(false) }
  }
  function problem(): string {
    if (!file) return 'Choose a PDF.'
    if (file.size > MAX_PDF_BYTES) return 'The PDF must be 5 MB or smaller.'
    const signers = defaultSignersOf(roles, people)
    return checkRoles(roles) || (typeof signers === 'string' ? signers : '')
  }
  const defaultSigners = () => defaultSignersOf(roles, people) as Exclude<ReturnType<typeof defaultSignersOf>, string>
  const removeRole = (i: number) => { setRoles((old) => old.filter((_, j) => j !== i)); setPeople((old) => old.filter((_, j) => j !== i)) }
  const setPerson = (i: number, value: Partial<{ name: string; email: string }>) => setPeople((old) => roles.map((_, j) => j === i ? { ...(old[j] ?? { name: '', email: '' }), ...value } : old[j] ?? { name: '', email: '' }))

  /** A session on this origin for the editor: a new PDF (staged as its source) or an existing template's fields. */
  function openEditor(source: { file: File; roles: string[]; defaultSigners: ReturnType<typeof defaultSigners> } | { templateId: string }) {
    void run(async () => {
      const body = 'templateId' in source ? { allowedParentOrigin: window.location.origin, sourceTemplateId: source.templateId } : { allowedParentOrigin: window.location.origin, roles: source.roles }
      const session = await apiJson<{ sessionId: string; url: string }>('/api/template-editing-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const url = new URL(session.url)
      if (url.origin !== window.location.origin || url.pathname !== `/editor/page/${session.sessionId}`) throw new Error('Unexpected editor address.')
      if ('file' in source) await api(`/api/template-editing-sessions/${session.sessionId}/source`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: source.file })
      setEditor({ sessionId: session.sessionId, url: url.href, ready: false, requestId: '', defaultSigners: 'defaultSigners' in source ? source.defaultSigners : null })
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
        setFile(null)
        setPeople((old) => old.map(() => ({ name: '', email: '' })))
        await load()
        setMessage({ text: 'Fields saved as a new template. Send an envelope from it.', error: false })
      })
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [editor])

  return h('div', { className: 'flex flex-col gap-6' },
    h(PageHeader, { title: 'Templates', description: 'The documents your organization sends for signature, with their signer roles and fields.' }),
    h(Notice, { message: message.text, error: message.error }),
    manage && !editor ? h(Card, { 'aria-label': 'New template' },
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'New template')),
        h(CardDescription, null, 'A PDF of up to 5 MB and 100 pages, and the roles that sign it, in signing order. Use synthetic documents until your organization has reviewed Esign for real ones.')),
      h(CardContent, { className: 'flex flex-col gap-4' },
        h(Field, { label: 'PDF', htmlFor: 'template-pdf' },
          h(Input, { id: 'template-pdf', type: 'file', accept: 'application/pdf', disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null) })),
        h('fieldset', { className: 'flex flex-col gap-2' },
          h('legend', { className: 'mb-1 text-sm font-medium' }, 'Signer roles, in signing order'),
          h('p', { className: 'text-xs text-muted-foreground' }, 'A role is required. Its signer\'s name and email are optional: when given, they are filled in each time you send, and can still be changed then.'),
          ...roles.map((role, i) => h('div', { key: i, className: 'grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]' },
            h(Field, { label: `Role ${i + 1}`, htmlFor: `role-${i}` },
              h(Input, { id: `role-${i}`, 'aria-label': `Role ${i + 1}`, value: role, maxLength: 64, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRoles((old) => old.map((r, j) => j === i ? e.target.value : r)) })),
            h(ContactField, { id: `role-${i}-name`, label: 'Signer name (optional)', required: false, value: people[i]?.name ?? '', onChange: (v) => setPerson(i, { name: v }), onChoose: (c) => setPerson(i, { name: c.name, email: c.email }) }),
            h(ContactField, { id: `role-${i}-email`, label: 'Signer email (optional)', type: 'email', required: false, value: people[i]?.email ?? '', onChange: (v) => setPerson(i, { email: v }), onChoose: (c) => setPerson(i, { name: c.name, email: c.email }) }),
            roles.length > 1 ? h(Button, { variant: 'ghost', size: 'icon', 'aria-label': `Remove role ${i + 1}`, onClick: () => removeRole(i) }, h(Trash2, { 'aria-hidden': true })) : h('span'))),
          roles.length < 20 ? h(Button, { variant: 'outline', size: 'sm', className: 'w-fit', onClick: () => { setRoles((old) => [...old, `signer-${old.length + 1}`]); setPeople((old) => [...old, { name: '', email: '' }]) } }, h(Plus, { 'aria-hidden': true }), 'Add a role') : null)),
      h(CardFooter, { className: 'flex-wrap gap-2' },
        h(Button, { disabled: busy, onClick: placeFields }, h(SquarePen, { 'aria-hidden': true }), 'Upload and place fields'))) : null,
    editor ? h(Card, { 'aria-label': 'Field editor' },
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Place the fields')),
        h(CardDescription, null, 'Give each role one Signature field, and Title or Date signed fields where you want them; then save. Saving makes a new template.')),
      h(CardContent, null, h('iframe', { ref: editorFrame, title: 'Signature field editor', src: editor.url, className: 'h-[760px] w-full rounded-md border' })),
      h(CardFooter, { className: 'gap-2' },
        h(Button, { disabled: !editor.ready || !!editor.requestId, onClick: saveFields }, editor.requestId ? 'Saving…' : 'Save fields'),
        h(Button, { variant: 'outline', disabled: !!editor.requestId, onClick: () => setEditor(null) }, 'Close the editor'))) : null,
    h(Card, { className: 'py-0' }, h(CardContent, { className: 'px-0' },
      templates === null ? h('p', { role: 'status', className: 'p-6 text-sm text-muted-foreground' }, 'Loading templates…')
        : templates.length === 0 ? h('p', { className: 'p-6 text-sm text-muted-foreground' }, manage ? 'No templates yet. Upload a PDF above.' : 'No templates yet.')
          : h(Table, { 'aria-label': 'Templates' },
            h(TableHeader, null, h(TableRow, null, h(TableHead, { className: 'pl-6' }, 'Template'), h(TableHead, null, 'Roles'), h(TableHead, null, 'Signed on'), h(TableHead, null, 'Uploaded'), manage ? h(TableHead, { className: 'pr-6' }, h('span', { className: 'sr-only' }, 'Actions')) : null)),
            h(TableBody, null, ...templates.map((t) => h(TableRow, { key: t.id },
              h(TableCell, { className: 'pl-6 whitespace-normal' }, t.name ? h('div', { className: 'font-medium' }, t.name) : null, h('div', { className: t.name ? 'font-mono text-xs text-muted-foreground' : 'font-mono text-xs' }, t.id)),
              h(TableCell, { className: 'whitespace-normal' }, t.roles.map((role) => { const d = t.defaultSigners?.[role]; return d ? `${role} (${d.name ?? d.email})` : role }).join(', ')),
              h(TableCell, null, t.fields.length ? `${t.fields.length} placed ${t.fields.length === 1 ? 'field' : 'fields'}` : 'A signature page'),
              h(TableCell, { className: 'text-muted-foreground' }, dateTime(t.createdAt)),
              manage ? h(TableCell, { className: 'pr-6 text-right' }, h('div', { className: 'flex justify-end gap-2' },
                h(Button, { size: 'sm', variant: 'ghost', disabled: busy || !!editor, onClick: () => openEditor({ templateId: t.id }) }, h(SquarePen, { 'aria-hidden': true }), 'Place fields'),
                h(Link, { to: `/envelopes/new?template=${encodeURIComponent(t.id)}`, className: buttonVariants({ size: 'sm', variant: 'outline' }) }, h(Send, { 'aria-hidden': true }), 'Send'))) : null)))))),
    !manage ? h('p', { className: 'text-sm text-muted-foreground' }, 'Your role can see templates but not change them. ', h('a', { href: '/docs/roles', onClick: (e: React.MouseEvent) => { e.preventDefault(); navigate('/docs/roles') }, className: 'font-medium text-foreground underline underline-offset-4' }, 'Roles and permissions')) : null)
}
