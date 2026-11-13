// New envelope: a template and one signer per role, in its signing order, with what the signers see about the document
// and who sent it. Sending creates the envelope and asks the first signer; a retry of the same send reuses its
// idempotency key, so a lost response never sends twice.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Send } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.ts'
import { checkClass, Input } from '../components/ui/input.ts'
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.ts'
import { Textarea } from '../components/ui/textarea.ts'
import { apiJson, canManage, dateTime, describeError, EMAIL, envelopeRequest, signByTime, type Contact, type DocumentFacts, type EnvelopeMessage, type Me, type Signer, type TemplateSummary } from './api.ts'
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
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const attempt = useRef<{ body: string; key: string } | null>(null)

  useEffect(() => {
    apiJson<{ templates: TemplateSummary[] }>('/api/templates').then((data) => setTemplates(data.templates)).catch((error) => setMessage({ text: describeError(error), error: true }))
  }, [])
  const template = templates?.find((t) => t.id === templateId) ?? null
  // One signer per role of the chosen template, keeping what was typed; a role nobody was typed for gets the
  // template's default signer, if it has one.
  useEffect(() => {
    if (!template) return
    setSigners((old) => template.roles.map((role, i) => {
      if (old[i] && !old[i]!.fromTemplate && (old[i]!.name.trim() || old[i]!.email.trim())) return old[i]!
      const d = template.defaultSigners?.[role]
      return { ...(old[i] ?? EMPTY_SIGNER), name: d?.name ?? '', email: d?.email ?? '', fromTemplate: !!d }
    }))
  }, [template?.id])

  if (!canManage(me)) {
    return h('div', { className: 'flex flex-col gap-4' }, h(PageHeader, { title: 'New envelope' }), h(Notice, { message: 'Your role can see envelopes but not send them. Ask an admin of your organization for the Editor role, or a custom role that sends and manages envelopes.' }))
  }

  const setSigner = (i: number, key: keyof Signer, value: string) => setSigners((old) => old.map((s, j) => j === i ? { ...s, [key]: value, ...(key === 'name' || key === 'email' ? { fromTemplate: false } : {}) } : s))
  // A contact fills in the signer's name, email, title and company.
  const chooseContact = (i: number, c: Contact) => setSigners((old) => old.map((s, j) => j === i ? { ...s, name: c.name, email: c.email, title: c.title ?? '', company: c.company ?? '', fromTemplate: false } : s))
  function send() {
    if (!template) { setMessage({ text: 'Choose a template.', error: true }); return }
    if (signers.some((s) => !s.name.trim() || !EMAIL.test(s.email.trim()))) { setMessage({ text: 'Enter a name and an email address for each signer.', error: true }); return }
    if ([note.subject, ...signers.map((s) => s.subject ?? '')].some((subject) => subject.trim().length > 100)) { setMessage({ text: 'Use at most 100 characters for an email subject.', error: true }); return }
    if (signBy.trim()) {
      const at = Date.parse(signByTime(signBy))
      if (!(at > Date.now() && at <= Date.now() + 400 * 86_400_000)) { setMessage({ text: 'Choose a sign-by day from today up to 400 days ahead.', error: true }); return }
    }
    setBusy(true)
    setMessage({ text: '', error: false })
    // Each signer's own message, or the one for everybody: never both.
    const people = perSigner ? signers : signers.map((s) => ({ ...s, subject: '', body: '' }))
    const body = JSON.stringify({ ...envelopeRequest(template.id, template.roles, people, doc, signBy, perSigner ? { subject: '', body: '' } : note), ...(tags.length ? { tags } : {}) })
    if (!attempt.current || attempt.current.body !== body) attempt.current = { body, key: crypto.randomUUID() }
    apiJson<{ id: string }>('/api/envelopes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': attempt.current.key }, body })
      .then(({ id }) => { attempt.current = null; navigate(`/envelopes/${id}`) })
      .catch((error) => setMessage({ text: describeError(error), error: true }))
      .finally(() => setBusy(false))
  }

  const text = (id: string, label: string, value: string, onChange: (v: string) => void, opts: { type?: string; hint?: string; required?: boolean } = {}) =>
    h(Field, { label, htmlFor: id, hint: opts.hint }, h(Input, { id, type: opts.type ?? 'text', value, required: opts.required, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value) }))

  return h('div', { className: 'flex flex-col gap-6' },
    h(Link, { to: '/', className: 'inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground' }, h(ArrowLeft, { className: 'size-4', 'aria-hidden': true }), 'All envelopes'),
    h(PageHeader, { title: 'New envelope', description: 'Send a template for signature. The signers sign in this order, each when the one before has signed.' }),
    h(Notice, { message: message.text, error: message.error }),
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Template'))),
      h(CardContent, null,
        templates === null ? h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading templates…')
          : templates.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, 'There is no template yet. ', h(Link, { to: '/templates', className: 'font-medium text-foreground underline underline-offset-4' }, 'Upload one first.'))
            : h(Field, { label: 'Template', htmlFor: 'envelope-template' },
              h(NativeSelect, { id: 'envelope-template', value: templateId, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setTemplateId(e.target.value) },
                h(NativeSelectOption, { value: '' }, 'Choose a template'),
                ...templates.map((t) => h(NativeSelectOption, { key: t.id, value: t.id }, `${t.name ? `${t.name} · ` : ''}${t.roles.join(', ')} · ${t.fields.length ? `${t.fields.length} fields` : 'signature page'} · ${dateTime(t.createdAt)}`)))))),
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
    template ? h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Document')), h(CardDescription, null, 'Shown to signers. All optional.')),
      h(CardContent, { className: 'grid gap-4 sm:grid-cols-2' },
        text('doc-name', 'Document name', doc.name, (v) => setDoc((d) => ({ ...d, name: v }))),
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
      h(CardFooter, null, h(Button, { disabled: busy, onClick: send }, h(Send, { 'aria-hidden': true }), busy ? 'Sending…' : 'Send for signature'))) : null)
}
