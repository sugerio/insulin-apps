// One envelope: its signers in order and where each stands, the audit trail, and, for those who manage, voiding it and
// opening the active signer's page here (this page is then the host that embeds it). A completed envelope offers the
// signed PDF with its certificate.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Ban, Download, FileCheck2, Mail, PenLine, X } from 'lucide-react'
import { Button, buttonVariants } from '../components/ui/button.ts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.ts'
import { Label } from '../components/ui/label.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { Textarea } from '../components/ui/textarea.ts'
import { AUDIT_LABELS, CompletionCertificate } from '../ui/CompletionCertificate.ts'
import { readSigningHostMessage } from '../ui/signing-host-protocol.ts'
import { api, apiJson, canManage, dateTime, describeError, taskLabel, type AuditEvent, type Envelope, type Me, type Task } from './api.ts'
import { Notice, PageHeader, StatusBadge } from './parts.ts'
import { Link } from './router.ts'

const h = React.createElement
type Certificate = Parameters<typeof CompletionCertificate>[0]['certificate']
const POLL_MS = 3000
const OPEN = new Set(['IN_PROGRESS', 'FINALIZING'])

export function EnvelopePage({ me, id }: { me: Me; id: string }) {
  const manage = canManage(me)
  const [envelope, setEnvelope] = useState<Envelope | null>(null)
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const [frame, setFrame] = useState<{ url: string; task: Task } | null>(null)
  const [pdf, setPdf] = useState<{ url: string; name: string } | null>(null)
  const [certificate, setCertificate] = useState<Certificate | null>(null)
  const signingFrame = useRef<HTMLIFrameElement | null>(null)

  async function refresh() {
    const [data, trail] = await Promise.all([
      apiJson<Envelope>(`/api/envelopes/${id}`),
      apiJson<{ events: AuditEvent[] }>(`/api/envelopes/${id}/audit`).catch(() => ({ events: [] })),
    ])
    setEnvelope(data)
    setAudit(trail.events)
    return data
  }
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage({ text: '', error: false })
    try { await work() } catch (error) { setMessage({ text: describeError(error), error: true }) } finally { setBusy(false) }
  }
  useEffect(() => { void run(async () => { await refresh() }) }, [id])
  // While the envelope is open, follow it: signing advances it in the background.
  useEffect(() => {
    if (!envelope || !OPEN.has(envelope.status)) return
    const timer = setInterval(() => { refresh().catch(() => {}) }, POLL_MS)
    return () => clearInterval(timer)
  }, [envelope?.id, envelope?.status])
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url) }, [pdf])

  // A new link to the invited signer (the old one stops working).
  function resendInvitation(task: Task) {
    void run(async () => {
      await apiJson(`/api/envelopes/${id}/tasks/${task.id}/invitation`, { method: 'POST' })
      await refresh()
      setMessage({ text: `The invitation was emailed again to ${task.recipientEmail}. The earlier link no longer works.`, error: false })
    })
  }
  function openSigning(task: Task) {
    void run(async () => {
      const origin = window.location.origin
      const { code } = await apiJson<{ code: string }>(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }),
      })
      setFrame({ url: `/sign#code=${encodeURIComponent(code)}&host=${encodeURIComponent(origin)}`, task })
    })
  }
  // The signing page's own messages: Cancel closes it; signing or declining closes it and reads the envelope again.
  useEffect(() => {
    if (!frame) return
    const name = frame.task.recipientName
    const listen = (event: MessageEvent) => {
      const msg = readSigningHostMessage(event, window.location.origin, signingFrame.current?.contentWindow)
      if (!msg) return
      setFrame(null)
      if (msg.type === 'esign.signing.finished') void run(async () => { await refresh(); setMessage({ text: msg.outcome === 'signed' ? `${name} signed.` : `${name} declined.`, error: false }) })
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [frame])

  function voidEnvelope() {
    void run(async () => {
      await api(`/api/envelopes/${id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}) })
      setVoiding(false)
      setReason('')
      await refresh()
      setMessage({ text: 'The envelope is voided. Nobody can sign it any more.', error: false })
    })
  }
  function downloadPdf() {
    void run(async () => {
      const blob = await (await api(`/api/envelopes/${id}/delivery-pdf`)).blob()
      setPdf({ url: URL.createObjectURL(blob), name: 'signed-with-certificate.pdf' })
    })
  }
  function showCertificate() {
    void run(async () => { setCertificate(await apiJson<Certificate>(`/api/envelopes/${id}/certificate`)) })
  }

  const back = h(Link, { to: '/', className: 'inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground' }, h(ArrowLeft, { className: 'size-4', 'aria-hidden': true }), 'All envelopes')
  if (!envelope) return h('div', { className: 'flex flex-col gap-4' }, back, message.text ? h(Notice, { message: message.text, error: message.error }) : h('p', { role: 'status', className: 'text-sm text-muted-foreground' }, 'Loading the envelope…'))

  const completed = envelope.status === 'COMPLETED'
  return h('div', { className: 'flex flex-col gap-6' },
    back,
    h(PageHeader, {
      title: envelope.documentName ?? 'Envelope',
      description: h('span', { className: 'flex flex-wrap items-center gap-2' }, h(StatusBadge, { status: envelope.status }), h('span', { className: 'font-mono text-xs' }, envelope.id), envelope.createdAt ? h('span', null, `Created ${dateTime(envelope.createdAt)}`) : null),
      actions: [
        completed ? h(Button, { key: 'pdf', variant: 'outline', disabled: busy, onClick: downloadPdf }, h(Download, { 'aria-hidden': true }), 'Signed PDF with certificate') : null,
        completed ? h(Button, { key: 'cert', variant: 'outline', disabled: busy, onClick: showCertificate }, h(FileCheck2, { 'aria-hidden': true }), 'Certificate of completion') : null,
        manage && envelope.status === 'IN_PROGRESS' ? h(Button, { key: 'void', variant: 'outline', className: 'text-destructive hover:bg-destructive/10 hover:text-destructive', disabled: busy, onClick: () => setVoiding(true) }, h(Ban, { 'aria-hidden': true }), 'Void envelope') : null,
      ],
    }),
    h(Notice, { message: message.text, error: message.error }),
    voiding ? h(Card, { 'aria-label': 'Void envelope' },
      h(CardHeader, null, h(CardTitle, null, 'Void this envelope?'), h(CardDescription, null, 'Signers who haven\'t signed can no longer open, verify or sign it. This can\'t be undone.')),
      h(CardContent, { className: 'flex flex-col gap-3' },
        h(Label, { htmlFor: 'void-reason' }, 'Reason (optional, kept in the audit trail)'),
        h(Textarea, { id: 'void-reason', maxLength: 500, value: reason, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value) }),
        h('div', { className: 'flex gap-2' },
          h(Button, { variant: 'destructive', disabled: busy, onClick: voidEnvelope }, 'Void envelope'),
          h(Button, { variant: 'outline', disabled: busy, onClick: () => { setVoiding(false); setReason('') } }, 'Keep it')))) : null,
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Signers')), h(CardDescription, null, 'They sign in this order; each one is asked when the one before has signed.')),
      h(CardContent, null, h(Table, { 'aria-label': 'Signers' },
        h(TableHeader, null, h(TableRow, null, h(TableHead, null, '#'), h(TableHead, null, 'Signer'), h(TableHead, null, 'Role'), h(TableHead, null, 'Status'), manage ? h(TableHead, null, h('span', { className: 'sr-only' }, 'Actions')) : null)),
        h(TableBody, null, ...envelope.tasks.map((task) => h(TableRow, { key: task.id },
          h(TableCell, null, String(task.routingOrder)),
          h(TableCell, { className: 'whitespace-normal' }, h('div', { className: 'font-medium' }, task.recipientName), h('div', { className: 'text-xs text-muted-foreground' }, task.recipientEmail)),
          h(TableCell, null, task.role),
          h(TableCell, { className: 'whitespace-normal' }, taskLabel(task.status),
            task.delivery === 'email' ? h('div', { className: 'text-xs text-muted-foreground' }, task.invitedAt ? `Invited by email ${dateTime(task.invitedAt)}` : task.status === 'ACTIVE' ? 'Invitation not sent yet' : 'Invited by email when it is their turn') : null,
            task.openedAt ? h('div', { className: 'text-xs text-muted-foreground' }, `Opened ${dateTime(task.openedAt)}`) : null,
            task.expiresAt && task.status === 'ACTIVE' ? h('div', { className: 'text-xs text-muted-foreground' }, `Deadline ${dateTime(task.expiresAt)}`) : null),
          manage ? h(TableCell, { className: 'text-right' }, task.status === 'ACTIVE' && envelope.status === 'IN_PROGRESS'
            ? h('div', { className: 'flex flex-wrap justify-end gap-2' },
              task.delivery === 'email' ? h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => resendInvitation(task) }, h(Mail, { 'aria-hidden': true }), 'Send the invitation again') : null,
              h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => openSigning(task) }, h(PenLine, { 'aria-hidden': true }), `Open ${task.recipientName}'s signing page`)) : null) : null)))))),
    envelope.metadata && Object.keys(envelope.metadata).length ? h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Metadata')), h(CardDescription, null, 'Labels the sender\'s system gave this envelope. Esign keeps them as given; they are not part of the signed evidence.')),
      h(CardContent, null, h('dl', { 'aria-label': 'Metadata', className: 'grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]' },
        ...Object.entries(envelope.metadata).flatMap(([key, value]) => [
          h('dt', { key: `k-${key}`, className: 'font-mono text-xs text-muted-foreground' }, key),
          h('dd', { key: `v-${key}`, className: 'break-all' }, value)])))) : null,
    h(Card, null,
      h(CardHeader, null, h(CardTitle, null, h('h2', null, 'Audit trail')), h(CardDescription, null, 'What happened, when and from where, as recorded.')),
      h(CardContent, null, audit.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, 'Nothing recorded yet.')
        : h(Table, { 'aria-label': 'Audit trail' },
          h(TableHeader, null, h(TableRow, null, h(TableHead, null, 'Time'), h(TableHead, null, 'Event'), h(TableHead, null, 'Signer'), h(TableHead, null, 'IP address'))),
          h(TableBody, null, ...audit.map((event, i) => h(TableRow, { key: i },
            h(TableCell, { className: 'text-muted-foreground' }, dateTime(event.at)),
            h(TableCell, { className: 'whitespace-normal' }, AUDIT_LABELS[event.type] ?? event.type, typeof event.detail?.reason === 'string' ? h('div', { className: 'text-xs text-muted-foreground' }, `Reason: ${event.detail.reason}`) : null),
            h(TableCell, null, event.recipient?.name ?? ''),
            h(TableCell, { className: 'font-mono text-xs' }, event.ip ?? ''))))))),
    pdf ? h(Card, null, h(CardContent, { className: 'flex flex-col gap-3' },
      h('a', { href: pdf.url, download: pdf.name, className: buttonVariants({ className: 'w-fit' }) }, h(Download, { 'aria-hidden': true }), `Download ${pdf.name}`),
      h('iframe', { title: 'Signed PDF', src: pdf.url, className: 'h-[70vh] w-full rounded-md border' }))) : null,
    certificate && completed ? h(CompletionCertificate, { certificate }) : null,
    // The signing page in a dialog, as a host shows it.
    frame ? h('div', { className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4' },
      h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': 'Signing page', className: 'flex h-[88vh] w-full max-w-[1440px] flex-col gap-3 rounded-xl border bg-background p-5 shadow-lg' },
        h('div', { className: 'flex items-start gap-3' },
          h('div', { className: 'flex-1' }, h('h2', { className: 'text-lg font-semibold' }, `${frame.task.recipientName}'s signing page`),
            h('p', { className: 'text-sm text-muted-foreground' }, 'What the signer sees. Their code goes to their own email address.')),
          h(Button, { variant: 'ghost', size: 'icon', 'aria-label': 'Close the signing page', onClick: () => setFrame(null) }, h(X, { 'aria-hidden': true }))),
        h('iframe', { ref: signingFrame, title: 'Recipient signing page', src: frame.url, className: 'w-full flex-1 rounded-md border', sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads' }))) : null)
}
