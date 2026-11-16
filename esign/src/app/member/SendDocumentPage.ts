// Upload and send: an envelope whose document is uploaded with it, no template (server/esign/envelope-documents.ts).
// Three steps: the document and its signers (each with a role of the sender's naming, in signing order); the fields,
// placed on the document in the field editor for each signer's role; a review, and Send. It is a draft from the first
// step on: Save draft keeps it, `/envelopes/send?draft=<id>` opens it again, and sending sends that envelope. Send later
// (SendLater.ts) keeps it a draft that Esign sends at the time chosen; saving it as a draft again cancels that.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react'
import { ScheduleNotice, SendButton, SendLaterDialog } from './SendLater.ts'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { checkClass, Input } from '../components/ui/input.ts'
import { Textarea } from '../components/ui/textarea.ts'
import { readSaveResult } from '../ui/editor-save-protocol.ts'
import { api, apiJson, canManage, describeError, EMAIL, envelopeRequest, formFromRequest, MAX_PDF_BYTES, signByTime, type Contact, type Envelope, type Me, type Signer } from './api.ts'
import { ContactField } from './ContactField.ts'
import { Field, Notice, PageHeader } from './parts.ts'
import { Link, navigate } from './router.ts'
import { TagsField } from './TagsField.ts'
import { saveAsTemplate } from './SaveAsTemplateDialog.ts'

const h = React.createElement
const ROLE = /^[A-Za-z0-9_-]{1,64}$/
type Person = { role: string; name: string; email: string; title: string; company: string }
const EMPTY: Person = { role: '', name: '', email: '', title: '', company: '' }
type Editor = { sessionId: string; url: string; ready: boolean; requestId: string; asDraft: boolean }
const STEPS = ['Document and signers', 'Fields', 'Review and send'] as const

/** The problem with the signers as typed, if any: a role of letters, digits, - and _, once each; a name and an email. */
export function checkSigners(people: Person[]): string {
  if (!people.length) return 'Add a signer.'
  for (const [i, p] of people.entries()) {
    const n = `Signer ${i + 1}`
    if (!ROLE.test(p.role.trim())) return `${n}: give a role of letters, digits, - and _ (no spaces), such as partner.`
    if (!p.name.trim()) return `${n}: enter their name.`
    if (!EMAIL.test(p.email.trim())) return `${n}: enter their email address.`
  }
  if (new Set(people.map((p) => p.role.trim().toLowerCase())).size !== people.length) return 'Give each signer a different role.'
  return ''
}

export function SendDocumentPage({ me }: { me: Me }) {
  const [draftId, setDraftId] = useState(() => { try { return new URLSearchParams(window.location.search).get('draft') ?? '' } catch { return '' } })
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [hasDocument, setHasDocument] = useState(false)
  const [docName, setDocName] = useState('')
  const [people, setPeople] = useState<Person[]>([{ ...EMPTY }])
  const [note, setNote] = useState({ subject: '', body: '' })
  const [signBy, setSignBy] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [placed, setPlaced] = useState<{ role: string; type: string; required?: boolean }[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(!draftId)
  // Also save as a template, once sent: its document, fields and roles, named as the document.
  const [alsoTemplate, setAlsoTemplate] = useState(false)
  // A scheduled draft: when it sends, or why it didn't (Send later).
  const [schedule, setSchedule] = useState<{ sendAt?: string; sendError?: string }>({})
  const [picking, setPicking] = useState(false)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const draftKey = useRef<string>(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))

  // A draft opens with what it was saved with.
  useEffect(() => {
    if (!draftId) return
    apiJson<Envelope>(`/api/envelopes/${draftId}`).then((envelope) => {
      if (envelope.status !== 'DRAFT') { navigate(`/envelopes/${envelope.id}`, { replace: true }); return }
      if (envelope.templateId) { navigate(`/envelopes/new?draft=${envelope.id}`, { replace: true }); return }
      const request = envelope.draft ?? {}
      const roles = Array.isArray(request.recipients) ? (request.recipients as { role?: unknown }[]).map((r) => (typeof r?.role === 'string' ? r.role : '')) : []
      const form = formFromRequest(request, roles)
      setPeople(roles.length ? form.signers.map((s, i) => ({ role: roles[i] ?? '', name: s.name, email: s.email, title: s.title, company: s.company })) : [{ ...EMPTY }])
      setDocName(form.doc.name); setNote(form.note); setSignBy(form.signBy); setTags(form.tags)
      setHasDocument(!!envelope.upload?.document); setPlaced(envelope.upload?.fields ?? [])
      setSchedule({ sendAt: envelope.sendAt, sendError: envelope.sendError })
      setLoaded(true)
    }).catch((error) => { setMessage({ text: describeError(error), error: true }); setLoaded(true) })
  }, [])

  // The field editor's messages: ready, and the answer to a save.
  useEffect(() => {
    if (!editor) return
    const listen = (event: MessageEvent) => {
      const source = frame.current?.contentWindow
      if (!source || event.source !== source || event.origin !== window.location.origin) return
      if (event.data?.type === 'esign.editor.ready') { setEditor((old) => old && { ...old, ready: true }); return }
      if (!editor.requestId) return
      const result = readSaveResult(event, window.location.origin, source, editor.requestId)
      if (!result) return
      if (result.type === 'esign.editor.save-error') { setEditor((old) => old && { ...old, requestId: '' }); setMessage({ text: result.message, error: true }); return }
      void run(async () => {
        const envelope = await apiJson<Envelope>(`/api/envelopes/${draftId}`)
        setPlaced(envelope.upload?.fields ?? [])
        if (editor.asDraft) { setEditor((old) => old && { ...old, requestId: '' }); setMessage({ text: 'Draft saved, with the fields placed so far.', error: false }); return }
        setEditor(null)
        setStep(2)
      })
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [editor, draftId])

  if (!canManage(me)) return h('div', { className: 'flex flex-col gap-4' }, h(PageHeader, { title: 'Upload and send' }), h(Notice, { message: 'Your role can see envelopes but not send them.', error: true }))

  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage({ text: '', error: false })
    try { await work() } catch (error) { setMessage({ text: describeError(error), error: true }) } finally { setBusy(false) }
  }
  const setPerson = (i: number, change: Partial<Person>) => setPeople((old) => old.map((p, j) => (j === i ? { ...p, ...change } : p)))
  const move = (i: number, by: number) => setPeople((old) => { const next = [...old]; const [p] = next.splice(i, 1); next.splice(i + by, 0, p!); return next })
  /** The request the form makes: the signers in order, each invited by email, with what the signers see. */
  function request() {
    const signers: Signer[] = people.map((p) => ({ name: p.name, email: p.email, title: p.title, company: p.company, after: '', delivery: 'email', subject: '', body: '' }))
    const { templateId: _none, ...rest } = envelopeRequest('', people.map((p) => p.role.trim()), signers, { name: docName, version: '', published: '', senderName: '', senderCompany: '' }, signBy, note)
    return { ...rest, ...(tags.length ? { tags } : {}) }
  }
  /** Saves the draft as it is (the first time, a new one; this page is then its address), and the document chosen. */
  async function saveDraft(): Promise<string> {
    const body = JSON.stringify({ ...request(), draft: true })
    let id = draftId
    if (id) await apiJson(`/api/envelopes/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    else {
      id = (await apiJson<{ id: string }>('/api/envelopes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': draftKey.current }, body })).id
      setDraftId(id)
      navigate(`/envelopes/send?draft=${id}`, { replace: true })
    }
    if (file) {
      await api(`/api/envelopes/${id}/document`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file })
      setFile(null); setHasDocument(true); setPlaced([])
    }
    // Saved as a draft, it is no longer scheduled (the server keeps no time for a draft saved so).
    if (schedule.sendAt) setMessage({ text: 'The scheduled send was cancelled: saving the draft unschedules it. Schedule it again from Review.', error: false })
    setSchedule({})
    return id
  }
  function save() {
    if (step === 1) { askEditor(true); return }
    void run(async () => { await saveDraft(); setMessage({ text: 'Draft saved. Nobody is asked to sign until you send it.', error: false }) })
  }
  /** Step 1 to 2: the signers checked, the draft saved, the editor opened on its document. */
  function toFields() {
    const problem = (!file && !hasDocument ? 'Choose the PDF to send.' : '') || checkSigners(people)
    if (problem) { setMessage({ text: problem, error: true }); return }
    void run(async () => {
      const id = await saveDraft()
      const session = await apiJson<{ sessionId: string; url: string }>('/api/template-editing-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowedParentOrigin: window.location.origin, envelopeId: id }) })
      const url = new URL(session.url)
      if (url.origin !== window.location.origin || url.pathname !== `/editor/page/${session.sessionId}`) throw new Error('Unexpected editor address.')
      setEditor({ sessionId: session.sessionId, url: url.href, ready: false, requestId: '', asDraft: false })
      setStep(1)
    })
  }
  /** Asks the editor to save the fields: as a draft, or ready (every signer has a required Signature) to go on. */
  function askEditor(asDraft: boolean) {
    if (!editor || !editor.ready || editor.requestId || !frame.current?.contentWindow) return
    const requestId = crypto.randomUUID()
    setEditor({ ...editor, requestId, asDraft })
    setMessage({ text: asDraft ? 'Saving the draft…' : 'Saving the fields…', error: false })
    frame.current.contentWindow.postMessage({ type: 'esign.editor.save', requestId, ...(asDraft ? { draft: true } : {}) }, window.location.origin)
  }
  /** Send later: the review's request, checked as a send and kept a draft that Esign sends at `sendAt`. */
  function scheduleAt(sendAt: string) {
    void run(async () => {
      try {
        const answer = await apiJson<{ sendAt?: string }>(`/api/envelopes/${draftId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request(), sendAt }) })
        setSchedule({ sendAt: answer.sendAt ?? sendAt })
        // The schedule's own notice says when it sends.
        setMessage({ text: '', error: false })
      } finally { setPicking(false) }
    })
  }
  function send() {
    void run(async () => {
      await apiJson(`/api/envelopes/${draftId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) })
      // Sent: the template is extra, and its failure is said on the envelope's page.
      let saved = ''
      if (alsoTemplate) saved = await saveAsTemplate(draftId, docName.trim() ? { name: docName.trim() } : {}).then((t) => t.id, () => 'failed')
      navigate(`/envelopes/${draftId}${saved ? `?savedAsTemplate=${saved}` : ''}`)
    })
  }

  const header = h('div', { className: 'flex flex-col gap-4' },
    h(Link, { to: '/envelopes', className: 'inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground' }, h(ArrowLeft, { className: 'size-4', 'aria-hidden': true }), 'All envelopes'),
    h(PageHeader, { title: draftId ? 'Draft: upload and send' : 'Upload and send', description: 'Send a PDF of your own for signature: name its signers, place where each one signs, and send. Save draft keeps it to finish later.' }),
    h('ol', { 'aria-label': 'Steps', className: 'flex flex-wrap gap-2 text-sm' }, ...STEPS.map((label, i) => h('li', {
      key: label, 'aria-current': i === step ? 'step' : undefined,
      className: `rounded-full border px-3 py-1 ${i === step ? 'border-primary bg-primary text-primary-foreground' : i < step ? 'text-foreground' : 'text-muted-foreground'}`,
    }, `${i + 1}. ${label}`))),
    h(Notice, { message: message.text, error: message.error }),
    h(ScheduleNotice, schedule))
  if (!loaded) return h('div', { className: 'flex flex-col gap-6' }, header, h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading the draft…'))
  const saveButton = h(Button, { key: 'save', variant: 'outline', disabled: busy || (step === 1 && (!editor?.ready || !!editor?.requestId)), onClick: save }, h(Save, { 'aria-hidden': true }), 'Save draft')

  if (step === 0) return h('div', { className: 'flex flex-col gap-6' }, header,
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Document')), h(CardDescription, null, 'A PDF of up to 5 MiB and 100 pages, with no form fields or annotations, pages not rotated.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' },
        h(Field, { label: hasDocument ? 'PDF (uploaded; choose another to replace it)' : 'PDF', htmlFor: 'send-pdf' },
          h(Input, { id: 'send-pdf', type: 'file', accept: 'application/pdf', onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const chosen = e.target.files?.[0] ?? null
            if (chosen && chosen.size > MAX_PDF_BYTES) { setMessage({ text: 'Choose a PDF of at most 5 MiB.', error: true }); return }
            setFile(chosen)
            if (chosen && !docName.trim()) setDocName(chosen.name.replace(/\.pdf$/i, '').slice(0, 200))
          } })),
        h(Field, { label: 'Document name', htmlFor: 'send-doc-name', hint: 'Shown to signers, and the name of the signed PDF.' },
          h(Input, { id: 'send-doc-name', value: docName, maxLength: 200, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDocName(e.target.value) })),
        hasDocument && placed.length && file ? h('p', { className: 'text-sm text-muted-foreground sm:col-span-2' }, 'Replacing the PDF clears the fields placed on it.') : null)),
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Signers')), h(CardDescription, null, 'In signing order: each is emailed an invitation when the one before has signed. A role names what each signs as, such as partner or seller; it is shown in the editor, on the signing page and on the certificate.')),
      h(CardContent, { className: 'flex flex-col gap-4' },
        ...people.map((p, i) => h('fieldset', { key: i, className: 'grid gap-4 rounded-lg border p-4 sm:grid-cols-2' },
          h('legend', { className: 'flex items-center gap-1 px-1 text-sm font-medium' }, `Signer ${i + 1}`,
            h(Button, { type: 'button', size: 'icon-sm', variant: 'ghost', 'aria-label': `Move signer ${i + 1} up`, disabled: i === 0, onClick: () => move(i, -1) }, h(ArrowUp, { 'aria-hidden': true })),
            h(Button, { type: 'button', size: 'icon-sm', variant: 'ghost', 'aria-label': `Move signer ${i + 1} down`, disabled: i === people.length - 1, onClick: () => move(i, 1) }, h(ArrowDown, { 'aria-hidden': true })),
            h(Button, { type: 'button', size: 'icon-sm', variant: 'ghost', 'aria-label': `Remove signer ${i + 1}`, disabled: people.length === 1, onClick: () => setPeople((old) => old.filter((_, j) => j !== i)) }, h(Trash2, { 'aria-hidden': true }))),
          h(Field, { label: 'Role', htmlFor: `send-${i}-role`, hint: 'Letters, digits, - and _, such as partner.' },
            h(Input, { id: `send-${i}-role`, value: p.role, maxLength: 64, placeholder: 'partner', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPerson(i, { role: e.target.value }) })),
          h('div', { className: 'hidden sm:block' }),
          h(ContactField, { id: `send-${i}-name`, label: 'Name', value: p.name, onChange: (v) => setPerson(i, { name: v }), onChoose: (c: Contact) => setPerson(i, { name: c.name, email: c.email, title: c.title ?? '', company: c.company ?? '' }) }),
          h(ContactField, { id: `send-${i}-email`, label: 'Email', type: 'email', value: p.email, onChange: (v) => setPerson(i, { email: v }), onChoose: (c: Contact) => setPerson(i, { name: c.name, email: c.email, title: c.title ?? '', company: c.company ?? '' }) }),
          h(Field, { label: 'Title (optional)', htmlFor: `send-${i}-title` }, h(Input, { id: `send-${i}-title`, value: p.title, maxLength: 128, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPerson(i, { title: e.target.value }) })),
          h(Field, { label: 'Signs for company (optional)', htmlFor: `send-${i}-company` }, h(Input, { id: `send-${i}-company`, value: p.company, maxLength: 200, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPerson(i, { company: e.target.value }) })))),
        h(Button, { type: 'button', variant: 'outline', className: 'w-fit', disabled: people.length >= 20, onClick: () => setPeople((old) => [...old, { ...EMPTY }]) }, h(Plus, { 'aria-hidden': true }), 'Add signer'))),
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Message and deadline')), h(CardDescription, null, 'Optional. The message is the invitations\' subject and text, and is shown on the signing page.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' },
        h(Field, { label: 'Email subject', htmlFor: 'send-subject' }, h(Input, { id: 'send-subject', value: note.subject, maxLength: 100, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNote((n) => ({ ...n, subject: e.target.value })) })),
        h(Field, { label: 'Sign by', htmlFor: 'send-sign-by', hint: 'If someone hasn\'t signed by the end of this day, the envelope expires.' }, h(Input, { id: 'send-sign-by', type: 'date', value: signBy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSignBy(e.target.value) })),
        h('div', { className: 'sm:col-span-2' }, h(Field, { label: 'Message to the signers', htmlFor: 'send-body' }, h(Textarea, { id: 'send-body', rows: 3, maxLength: 10000, value: note.body, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setNote((n) => ({ ...n, body: e.target.value })) }))),
        h('div', { className: 'sm:col-span-2' }, h(TagsField, { id: 'send-tags', value: tags, onChange: setTags, hint: 'Only you see your tags.' }))),
      h(CardFooter, { className: 'flex flex-wrap gap-2' }, saveButton,
        h(Button, { key: 'next', disabled: busy, onClick: toFields }, 'Next: place fields', h(ArrowRight, { 'aria-hidden': true })))))

  if (step === 1) return h('div', { className: 'flex flex-col gap-6' }, header,
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Fields')), h(CardDescription, null, 'For each signer, choose their role under Placing fields for, and drag a Signature field (at least one required each), and Title or Date signed fields, where they sign.')),
      h(CardContent, null, editor ? h('iframe', { ref: frame, title: 'Signature field editor', src: editor.url, className: 'h-[70vh] w-full rounded-md border' }) : h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Opening the field editor…')),
      h(CardFooter, { className: 'flex flex-wrap gap-2' },
        h(Button, { key: 'back', variant: 'ghost', disabled: !!editor?.requestId, onClick: () => { setEditor(null); setStep(0) } }, h(ArrowLeft, { 'aria-hidden': true }), 'Back'),
        saveButton,
        h(Button, { key: 'next', disabled: !editor?.ready || !!editor?.requestId, onClick: () => askEditor(false) }, editor?.requestId && !editor.asDraft ? 'Saving…' : 'Next: review', h(ArrowRight, { 'aria-hidden': true })))))

  const count = (role: string) => placed.filter((f) => f.role === role).length
  return h('div', { className: 'flex flex-col gap-6' }, header,
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Review')), h(CardDescription, null, 'Check what is sent. Once sent, the first signer is invited at once.')),
      h(CardContent, null, h('dl', { 'aria-label': 'Review', className: 'grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]' },
        h('dt', { className: 'text-muted-foreground' }, 'Document'), h('dd', null, docName.trim() || 'Untitled document'),
        h('dt', { className: 'text-muted-foreground' }, 'Signers'),
        h('dd', null, h('ol', { className: 'flex flex-col gap-1' }, ...people.map((p, i) => h('li', { key: i }, `${i + 1}. ${p.role} — ${p.name} (${p.email}): ${count(p.role.trim())} ${count(p.role.trim()) === 1 ? 'field' : 'fields'}`)))),
        h('dt', { className: 'text-muted-foreground' }, 'Message'), h('dd', null, note.subject.trim() || note.body.trim() ? [note.subject.trim(), note.body.trim()].filter(Boolean).join(' — ') : 'None'),
        h('dt', { className: 'text-muted-foreground' }, 'Sign by'), h('dd', null, signBy ? new Date(signByTime(signBy)).toLocaleString() : 'No deadline')),
        h('label', { className: 'mt-4 flex items-center gap-2 text-sm' },
          h('input', { id: 'send-also-template', type: 'checkbox', className: checkClass, checked: alsoTemplate, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAlsoTemplate(e.target.checked) }),
          'Also save as a template, to send this document again (its fields and roles, named as the document)')),
      h(CardFooter, { className: 'flex flex-wrap gap-2' },
        h(Button, { key: 'back', variant: 'ghost', disabled: busy, onClick: toFields }, h(ArrowLeft, { 'aria-hidden': true }), 'Back to fields'),
        saveButton,
        h(SendButton, { key: 'send', busy, label: schedule.sendAt ? 'Send now' : 'Send for signature', onSend: send, onLater: () => setPicking(true) })),
      h(SendLaterDialog, { open: picking, initial: schedule.sendAt, signBy, busy, onClose: () => setPicking(false), onSchedule: scheduleAt,
        note: alsoTemplate ? 'Also save as a template is done only when you send it now: save it as a template from the envelope\'s page once it is sent.' : undefined })))
}
