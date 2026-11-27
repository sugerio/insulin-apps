// New envelope: a template and one signer per role, in its signing order, with what the signers see about the document
// and who sent it. Sending creates the envelope and asks the first signer; a retry of the same send reuses its
// idempotency key, so a lost response never sends twice. Save draft keeps the form as it is, unfinished even, to send
// later: `/envelopes/new?draft=<id>` opens it again, and sending it sends that envelope. Send later (SendLater.ts)
// checks it as a send and keeps it a draft that Esign sends at the time chosen; Save draft cancels that.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Save } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { ScheduleNotice, SendButton, SendLaterDialog } from './SendLater.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { checkClass, Input } from '../components/ui/input.ts'
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.ts'
import { Textarea } from '../components/ui/textarea.ts'
import { apiJson, canManage, dateTime, defaultDocumentName, describeError, EMAIL, envelopeRequest, formFromRequest, signByTime, type Contact, type DocumentFacts, type Envelope, type EnvelopeMessage, type Me, type Signer, type TemplateSummary } from './api.ts'
import { ContactField } from './ContactField.ts'
import { Field, Notice, PageHeader } from './parts.ts'
import { Link, navigate } from './router.ts'
import { TagsField } from './TagsField.ts'

const h = React.createElement
// Esign emails every signer an invitation when it is their turn: here Esign is the signing product, not a host that
// opens signers' pages itself (POST /api/envelopes' `delivery` 'host' is for host products).
const EMPTY_SIGNER: Signer = { name: '', email: '', title: '', company: '', after: '', delivery: 'email', subject: '', body: '' }
const EMPTY_DOCUMENT: DocumentFacts = { name: '', version: '', published: '', senderName: '', senderCompany: '' }


export function NewEnvelopePage({ me }: { me: Me }) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null)
  const [templateId, setTemplateId] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('template') ?? '' } catch { return '' }
  })
  const [signers, setSigners] = useState<Signer[]>([])
  const [doc, setDoc] = useState<DocumentFacts>(EMPTY_DOCUMENT)
  const [signBy, setSignBy] = useState('')
  const [note, setNote] = useState<EnvelopeMessage>({ subject: '', body: '' })
  // One message for every signer, or a message of their own for each.
  const [perSigner, setPerSigner] = useState(false)
  // The sender's own tags for it; theirs on the template are added by Esign.
  const [tags, setTags] = useState<string[]>([])
  // The template's pre-filled fields' values, by name: as typed, else their defaults.
  const [prefill, setPrefill] = useState<Record<string, string>>({})
  const [message, setMessage] = useState({ text: '', error: false })
  // What stopped the last send, said beside the send button.
  const [stopped, setStopped] = useState('')
  const [busy, setBusy] = useState(false)
  const attempt = useRef<{ body: string; key: string } | null>(null)
  // The draft this form is (`?draft=<id>`, or once Save draft has saved it), and its request until the form has it.
  const [draftId, setDraftId] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('draft') ?? '' } catch { return '' }
  })
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null)
  // A scheduled draft: when it sends, or why it didn't (Send later).
  const [schedule, setSchedule] = useState<{ sendAt?: string; sendError?: string; sendWaiting?: string }>({})
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (!draftId || saved) return
    apiJson<Envelope>(`/api/envelopes/${draftId}`).then((envelope) => {
      // Sent meanwhile: its own page.
      if (envelope.status !== 'DRAFT') { navigate(`/envelopes/${envelope.id}`, { replace: true }); return }
      // Its document uploaded with it: the Upload and send page.
      if (!envelope.templateId) { navigate(`/envelopes/send?draft=${envelope.id}`, { replace: true }); return }
      setTemplateId(envelope.templateId)
      setSaved(envelope.draft ?? {})
      setSchedule({ sendAt: envelope.sendAt, sendError: envelope.sendError, sendWaiting: envelope.sendWaiting })
    }).catch((error) => setMessage({ text: describeError(error), error: true }))
  }, [])

  useEffect(() => {
    apiJson<{ templates: TemplateSummary[] }>('/api/templates').then((data) => setTemplates(data.templates)).catch((error) => setMessage({ text: describeError(error), error: true }))
  }, [])
  const template = templates?.find((t) => t.id === templateId) ?? null
  // One signer per role of the chosen template, keeping what was typed; a role nobody was typed for gets the
  // template's default signer, if it has one.
  // The document's name follows the template chosen, until the member types one of their own.
  const autoName = useRef('')
  useEffect(() => {
    if (!template) return
    // Each pre-filled field: what was typed for its name, else its default.
    setPrefill((old) => Object.fromEntries((template.prefill ?? []).map((d) => [d.name, old[d.name] ?? d.default ?? ''])))
    const previous = autoName.current, suggested = defaultDocumentName(template)
    autoName.current = suggested
    setDoc((d) => (!d.name.trim() || d.name === previous ? { ...d, name: suggested } : d))
    setSigners((old) => template.roles.map((role, i) => {
      if (old[i] && !old[i]!.fromTemplate && (old[i]!.name.trim() || old[i]!.email.trim())) return old[i]!
      const d = template.defaultSigners?.[role]
      return { ...(old[i] ?? EMPTY_SIGNER), name: d?.name ?? '', email: d?.email ?? '', fromTemplate: !!d }
    }))
  }, [template?.id])
  // A draft fills the form in, once its template is here.
  const filled = useRef(false)
  useEffect(() => {
    if (!saved || !template || filled.current) return
    filled.current = true
    const form = formFromRequest(saved, template.roles)
    setSigners(form.signers); setDoc(form.doc); setSignBy(form.signBy); setNote(form.note); setPerSigner(form.perSigner); setTags(form.tags)
    const savedPrefill = saved.prefill && typeof saved.prefill === 'object' && !Array.isArray(saved.prefill) ? saved.prefill as Record<string, unknown> : {}
    setPrefill(Object.fromEntries((template.prefill ?? []).map((d) => [d.name, typeof savedPrefill[d.name] === 'string' ? savedPrefill[d.name] as string : d.default ?? ''])))
  }, [saved, template?.id])

  if (!canManage(me)) {
    return h('div', { className: 'flex flex-col gap-4' }, h(PageHeader, { title: 'New envelope' }), h(Notice, { message: 'Your role can see envelopes but not send them. Ask an admin of your organization for the Editor role, or a custom role that sends and manages envelopes.' }))
  }

  const setSigner = (i: number, key: keyof Signer, value: string) => setSigners((old) => old.map((s, j) => j === i ? { ...s, [key]: value, ...(key === 'name' || key === 'email' ? { fromTemplate: false } : {}) } : s))
  // A contact fills in the signer's name, email, title and company.
  const chooseContact = (i: number, c: Contact) => setSigners((old) => old.map((s, j) => j === i ? { ...s, name: c.name, email: c.email, title: c.title ?? '', company: c.company ?? '', fromTemplate: false } : s))
  /** The request the form makes: what is typed, each signer's own message or the one for everybody, never both. */
  function request() {
    const people = perSigner ? signers : signers.map((s) => ({ ...s, subject: '', body: '' }))
    // Never without a name: the template's, when the field was emptied.
    const named = doc.name.trim() || !template ? doc : { ...doc, name: defaultDocumentName(template) }
    // The pre-filled values typed (an empty one is none: its default, or nothing).
    const values = Object.fromEntries((template?.prefill ?? []).map((d) => [d.name, (prefill[d.name] ?? '').trim()]).filter(([, v]) => v))
    return { ...envelopeRequest(templateId, template?.roles ?? [], people, named, signBy, perSigner ? { subject: '', body: '' } : note), ...(tags.length ? { tags } : {}), ...(Object.keys(values).length ? { prefill: values } : {}) }
  }
  /** Saves the form as a draft, as it is: the first time a new one (then this page is its address), later in place. */
  function saveDraft() {
    if (!templateId) { setMessage({ text: 'Choose a template.', error: true }); return }
    setBusy(true)
    setMessage({ text: '', error: false })
    const body = JSON.stringify({ ...request(), draft: true })
    if (!draftId && (!attempt.current || attempt.current.body !== body)) attempt.current = { body, key: crypto.randomUUID() }
    const saving = draftId ? apiJson<{ id: string }>(`/api/envelopes/${draftId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      : apiJson<{ id: string }>('/api/envelopes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': attempt.current!.key }, body })
    saving.then(({ id }) => {
      attempt.current = null
      if (!draftId) { setDraftId(id); navigate(`/envelopes/new?draft=${id}`, { replace: true }) }
      setMessage({ text: schedule.sendAt ? 'Draft saved. It is no longer scheduled: nobody is asked to sign until you send it.' : 'Draft saved. Nobody is asked to sign until you send it.', error: false })
      setSchedule({})
    }).catch((error) => setMessage({ text: describeError(error), error: true })).finally(() => setBusy(false))
  }
  /** What stops the form from being sent, said as the member can fix it, and the field to fix; null when nothing does. */
  function sendProblem(): { text: string; field: string } | null {
    if (!template) return { text: 'Choose a template.', field: 'envelope-template' }
    const missing = (template.prefill ?? []).find((d) => d.required && !(prefill[d.name] ?? '').trim())
    if (missing) return { text: `Fill in ${missing.label}.`, field: `prefill-${missing.name}` }
    const undrawable = (template.prefill ?? []).find((d) => !/^[\x20-\x7e]{0,128}$/.test((prefill[d.name] ?? '').trim()))
    if (undrawable) return { text: `${undrawable.label}: use plain English letters, digits and punctuation, at most 128 characters.`, field: `prefill-${undrawable.name}` }
    const signer = signers.findIndex((s) => !s.name.trim() || !EMAIL.test(s.email.trim()))
    if (signer >= 0) return { text: 'Enter a name and an email address for each signer.', field: `signer-${signer}-${signers[signer]!.name.trim() ? 'email' : 'name'}` }
    const subject = [note.subject, ...signers.map((s) => s.subject ?? '')].findIndex((subject) => subject.trim().length > 100)
    if (subject >= 0) return { text: 'Use at most 100 characters for an email subject.', field: subject ? `signer-${subject - 1}-subject` : 'message-subject' }
    if (signBy.trim()) {
      const at = Date.parse(signByTime(signBy))
      if (!(at > Date.now() && at <= Date.now() + 400 * 86_400_000)) return { text: 'Choose a sign-by day from today up to 400 days ahead.', field: 'sign-by' }
    }
    return null
  }
  /** Whether the form can be sent: if not, says why beside the send button and takes the member to the field to fix. */
  function sendable(): boolean {
    const problem = sendProblem()
    setStopped(problem?.text ?? '')
    if (!problem) return true
    setMessage({ text: '', error: false })
    const field = typeof document === 'undefined' ? null : document.getElementById(problem.field)
    field?.scrollIntoView?.({ block: 'center' })
    field?.focus?.({ preventScroll: true })
    return false
  }
  /** Send later: checked as a send, kept a draft that Esign sends at `sendAt`; this page is then its address. */
  function sendLater() {
    if (!sendable()) return
    setMessage({ text: '', error: false })
    setPicking(true)
  }
  function schedule_(sendAt: string) {
    setBusy(true)
    const body = JSON.stringify({ ...request(), sendAt })
    if (!draftId && (!attempt.current || attempt.current.body !== body)) attempt.current = { body, key: crypto.randomUUID() }
    const saving = draftId ? apiJson<{ id: string; sendAt?: string }>(`/api/envelopes/${draftId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      : apiJson<{ id: string; sendAt?: string }>('/api/envelopes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': attempt.current!.key }, body })
    saving.then(({ id, sendAt: when }) => {
      attempt.current = null
      if (!draftId) { setDraftId(id); navigate(`/envelopes/new?draft=${id}`, { replace: true }) }
      setPicking(false)
      setSchedule({ sendAt: when ?? sendAt })
      // The schedule's own notice says when it sends.
      setMessage({ text: '', error: false })
    }).catch((error) => { setPicking(false); setMessage({ text: describeError(error), error: true }) }).finally(() => setBusy(false))
  }
  function send() {
    if (!sendable()) return
    setBusy(true)
    setMessage({ text: '', error: false })
    const body = JSON.stringify(request())
    if (!attempt.current || attempt.current.body !== body) attempt.current = { body, key: crypto.randomUUID() }
    // A draft is sent as itself; a new envelope by its idempotency key.
    const sent = draftId ? apiJson<{ id: string }>(`/api/envelopes/${draftId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      : apiJson<{ id: string }>('/api/envelopes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': attempt.current.key }, body })
    sent
      .then(({ id }) => { attempt.current = null; navigate(`/envelopes/${id}`) })
      .catch((error) => setMessage({ text: describeError(error), error: true }))
      .finally(() => setBusy(false))
  }

  const text = (id: string, label: string, value: string, onChange: (v: string) => void, opts: { type?: string; hint?: string; required?: boolean } = {}) =>
    h(Field, { label, htmlFor: id, hint: opts.hint }, h(Input, { id, type: opts.type ?? 'text', value, required: opts.required, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value) }))

  return h('div', { className: 'flex flex-col gap-6' },
    h(Link, { to: '/', className: 'inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground' }, h(ArrowLeft, { className: 'size-4', 'aria-hidden': true }), 'All envelopes'),
    h(PageHeader, { title: draftId ? 'Draft envelope' : 'New envelope', description: draftId ? 'Saved, not sent: finish it and send it, or save it again for later. The signers sign in this order, each when the one before has signed.' : 'Send a template for signature. The signers sign in this order, each when the one before has signed. Save draft keeps it to finish later.' }),
    h(Notice, { message: message.text, error: message.error }),
    h(ScheduleNotice, schedule),
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Template'))),
      h(CardContent, null,
        templates === null ? h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading templates…')
          : templates.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, 'There is no template yet. ', h(Link, { to: '/templates', className: 'font-medium text-foreground underline underline-offset-4' }, 'Upload one first.'))
            : h(Field, { label: 'Template', htmlFor: 'envelope-template' },
              h(NativeSelect, { id: 'envelope-template', value: templateId, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setTemplateId(e.target.value) },
                h(NativeSelectOption, { value: '' }, 'Choose a template'),
                ...templates.map((t) => h(NativeSelectOption, { key: t.id, value: t.id }, `${t.name ? `${t.name} · ` : ''}${t.roles.join(', ')} · ${t.fields.some((f) => f.type !== 'Prefill') ? `${t.fields.filter((f) => f.type !== 'Prefill').length} fields` : 'signature page'} · ${dateTime(t.createdAt)}`)))))),
    template ? h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Signers')), h(CardDescription, null, 'One for each role: your contacts are suggested as you type a name or email. Each is emailed an invitation when it is their turn. A title and a company are shown on the signing page and recorded with the signature.')),
      h(CardContent, { className: 'flex flex-col gap-6' }, ...template.roles.map((role, i) => h('fieldset', { key: role, className: 'grid gap-4 rounded-lg border p-4 sm:grid-cols-2' },
        h('legend', { className: 'px-1 text-sm font-medium' }, `${i + 1}. ${role}`),
        h(ContactField, { id: `signer-${i}-name`, label: 'Name', value: signers[i]?.name ?? '', onChange: (v) => setSigner(i, 'name', v), onChoose: (c) => chooseContact(i, c) }),
        h(ContactField, { id: `signer-${i}-email`, label: 'Email', type: 'email', value: signers[i]?.email ?? '', onChange: (v) => setSigner(i, 'email', v), onChoose: (c) => chooseContact(i, c) }),
        text(`signer-${i}-title`, 'Title (optional)', signers[i]?.title ?? '', (v) => setSigner(i, 'title', v)),
        text(`signer-${i}-company`, 'Signs for company (optional)', signers[i]?.company ?? '', (v) => setSigner(i, 'company', v), { hint: 'They confirm they are authorized to sign for it.' }),
        ...(perSigner ? [
          h('div', { key: 'subject', className: 'sm:col-span-2' }, text(`signer-${i}-subject`, 'Email subject (optional)', signers[i]?.subject ?? '', (v) => setSigner(i, 'subject', v))),
          h('div', { key: 'body', className: 'sm:col-span-2' }, h(Field, { label: `Message to ${signers[i]?.name.trim() || 'this signer'} (optional)`, htmlFor: `signer-${i}-body` },
            h(Textarea, { id: `signer-${i}-body`, rows: 3, maxLength: 10000, value: signers[i]?.body ?? '', onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setSigner(i, 'body', e.target.value) }))),
        ] : []))))) : null,
    template?.prefill?.length ? h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Pre-filled fields')), h(CardDescription, null, 'Filled in on the document when it is sent, before anyone signs. Signers see them and can\'t change them.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' }, ...template.prefill.map((d) => h('div', { key: d.name },
        text(`prefill-${d.name}`, `${d.label}${d.required ? '' : ' (optional)'}`, prefill[d.name] ?? '', (v) => setPrefill((old) => ({ ...old, [d.name]: v })), { hint: `${d.name}${d.default ? ` · default: ${d.default}` : ''}`, required: d.required }))))) : null,
    template ? h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Document')), h(CardDescription, null, 'Shown to signers. All optional.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' },
        text('doc-name', 'Document name', doc.name, (v) => setDoc((d) => ({ ...d, name: v })), { hint: 'Shown to signers and names the signed PDF. Filled in with the template\'s name: change it if you like.' }),
        text('doc-version', 'Version', doc.version, (v) => setDoc((d) => ({ ...d, version: v }))),
        text('doc-published', 'Published (YYYY-MM-DD)', doc.published, (v) => setDoc((d) => ({ ...d, published: v }))),
        text('doc-sender', 'Sender name', doc.senderName, (v) => setDoc((d) => ({ ...d, senderName: v }))),
        text('doc-sender-company', 'Sender company', doc.senderCompany, (v) => setDoc((d) => ({ ...d, senderCompany: v }))),
        text('sign-by', 'Sign by (optional)', signBy, setSignBy, { type: 'date', hint: 'If someone hasn\'t signed by the end of this day, the envelope expires and nobody can sign it.' }),
        h('div', { className: 'sm:col-span-2' }, h(TagsField, { id: 'envelope-tags', value: tags, onChange: setTags, hint: 'Only you see your tags. Your tags on the template are added too.' }))),
      h(CardContent, { className: 'grid gap-4 border-t pt-6' },
        h('p', { className: 'text-sm text-muted-foreground' }, 'A message is shown on the signing page, and is the subject and text of the invitations Esign emails. Without a subject: "Please sign: <document name>".'),
        h('label', { className: 'flex items-center gap-2 text-sm' },
          h('input', { id: 'message-per-signer', type: 'checkbox', className: checkClass, checked: perSigner, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPerSigner(e.target.checked) }),
          'Write a different message to each signer (under each signer above)'),
        ...(perSigner ? [] : [
          text('message-subject', 'Email subject (optional)', note.subject, (v) => setNote((m) => ({ ...m, subject: v }))),
          h(Field, { key: 'message-body', label: 'Message to the signers (optional)', htmlFor: 'message-body' },
            h(Textarea, { id: 'message-body', rows: 4, maxLength: 10000, value: note.body, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setNote((m) => ({ ...m, body: e.target.value })) })),
        ])),
      h(CardFooter, { className: 'flex flex-wrap gap-2' },
        h(Button, { variant: 'outline', disabled: busy, onClick: saveDraft }, h(Save, { 'aria-hidden': true }), 'Save draft'),
        h(SendButton, { busy, label: schedule.sendAt ? 'Send now' : 'Send for signature', onSend: send, onLater: sendLater }),
        stopped ? h('p', { role: 'alert', className: 'w-full text-sm text-destructive' }, stopped) : null,
        schedule.sendAt ? h('p', { className: 'w-full text-xs text-muted-foreground' }, 'Saving as a draft cancels the scheduled send.') : null)) : null,
    h(SendLaterDialog, { open: picking, initial: schedule.sendAt, signBy, busy, onClose: () => setPicking(false), onSchedule: schedule_ }))
}
