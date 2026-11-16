// Send later (server/esign/scheduled-send.ts): the send button with a menu holding Send later…, the dialog that picks
// the day and time (the member's own time zone), and how a scheduled draft says where it stands. A scheduled envelope
// stays a draft until Esign sends it, within a few minutes of that time.
import React, { useEffect, useState } from 'react'
import { CalendarClock, ChevronDown, Send } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.ts'
import { DropdownMenu } from '../components/ui/dropdown-menu.ts'
import { Input } from '../components/ui/input.ts'
import { signByTime } from './api.ts'
import { Field, Notice } from './parts.ts'

const h = React.createElement
const MINUTE = 60_000
/** The soonest a send can be scheduled from the page: the server takes a minute, the tick runs every five. */
const SOONEST_MS = 5 * MINUTE
const LATEST_MS = 400 * 24 * 60 * MINUTE

/** A time to send, as the member reads it: "Nov 20, 2026, 9:00 AM". */
export const sendTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' } }
const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** Why a server refused to send a scheduled draft, in plain words. */
export function sendErrorText(code: string): string {
  if (code === 'not_allowed') return 'whoever scheduled it can no longer send it'
  if (code === 'template_draft') return 'its template is a draft'
  if (code === 'not_found') return 'its template is no longer there'
  if (code === 'fields_not_ready' || code === 'fields_required' || code === 'document_required') return 'its document or fields aren\'t ready'
  if (code === 'invalid_recipient' || code === 'invalid_roles') return 'a signer is missing or doesn\'t match the template'
  return `it was refused (${code})`
}

/** The primary send button, and beside it a menu with Send later…. */
export function SendButton({ busy, label, onSend, onLater }: { busy: boolean; label: string; onSend: () => void; onLater: () => void }) {
  return h('div', { className: 'inline-flex' },
    h(Button, { disabled: busy, onClick: onSend, className: 'rounded-r-none' }, h(Send, { 'aria-hidden': true }), busy ? 'Sending…' : label),
    h(DropdownMenu, {
      label: 'More ways to send', items: [{ label: 'Send later…', icon: CalendarClock, onSelect: onLater }],
      trigger: (props) => h(Button, { ...props, disabled: busy, size: 'icon', className: 'rounded-l-none border-l border-primary-foreground/20' }, h(ChevronDown, { 'aria-hidden': true })),
    }))
}

/** Where a scheduled draft stands, above its form: when it sends, or why it didn't. */
export function ScheduleNotice({ sendAt, sendError }: { sendAt?: string; sendError?: string }) {
  if (sendAt) return h(Notice, { message: `Scheduled to send on ${sendTime(sendAt)}. Send it now, choose another time with Send later, or Save draft to cancel the scheduled send.` })
  if (sendError) return h(Notice, { error: true, message: `It wasn't sent at the scheduled time: ${sendErrorText(sendError)}. Fix it, then send it or schedule it again.` })
  return null
}

/**
 * Picks when to send: a day and a time, at least five minutes and at most 400 days ahead, before the sign-by day
 * (`signBy`, a date) if there is one. `initial` is the time already scheduled, if any; else tomorrow at 9:00.
 */
export function SendLaterDialog({ open, initial, signBy, note, busy, onClose, onSchedule }: { open: boolean; initial?: string; signBy?: string; note?: string; busy: boolean; onClose: () => void; onSchedule: (iso: string) => void }) {
  const [day, setDay] = useState('')
  const [time, setTime] = useState('')
  const [problem, setProblem] = useState('')
  useEffect(() => {
    if (!open) return
    const start = initial ? new Date(initial) : (() => { const d = new Date(Date.now() + 24 * 60 * MINUTE); d.setHours(9, 0, 0, 0); return d })()
    setDay(localDay(start)); setTime(localTime(start)); setProblem('')
  }, [open])
  function schedule() {
    const at = new Date(`${day}T${time}`)
    if (!day || !time || Number.isNaN(at.getTime())) { setProblem('Choose a day and a time.'); return }
    if (at.getTime() < Date.now() + SOONEST_MS) { setProblem('Choose a time at least five minutes from now.'); return }
    if (at.getTime() > Date.now() + LATEST_MS) { setProblem('Choose a time within 400 days.'); return }
    if (signBy && at.getTime() >= Date.parse(signByTime(signBy))) { setProblem('Choose a time before the sign-by day ends, or change the sign-by day.'); return }
    setProblem('')
    onSchedule(at.toISOString())
  }
  return h(Dialog, { open, onOpenChange: (o) => { if (!o) onClose() }, label: 'Send later', dismissible: !busy, className: 'sm:max-w-md' },
    open ? [
      h(DialogHeader, { key: 'header' }, h(DialogTitle, null, 'Send later'),
        h(DialogDescription, null, 'It stays a draft until then, and Esign sends it within a few minutes of this time. You can still change it, send it now or discard it.')),
      h('div', { key: 'form', className: 'flex flex-col gap-4' },
        h(Notice, { message: problem, error: true }),
        h('div', { className: 'grid gap-4 sm:grid-cols-2' },
          h(Field, { label: 'Day', htmlFor: 'send-later-day' }, h(Input, { id: 'send-later-day', type: 'date', value: day, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDay(e.target.value) })),
          h(Field, { label: 'Time', htmlFor: 'send-later-time' }, h(Input, { id: 'send-later-time', type: 'time', value: time, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTime(e.target.value) }))),
        h('p', { className: 'text-xs text-muted-foreground' }, `In your time zone${zone() ? `, ${zone()}` : ''}.`),
        note ? h('p', { className: 'text-sm text-muted-foreground' }, note) : null),
      h(DialogFooter, { key: 'footer' },
        h(Button, { variant: 'outline', disabled: busy, onClick: onClose }, 'Cancel'),
        h(Button, { disabled: busy, onClick: schedule }, h(CalendarClock, { 'aria-hidden': true }), busy ? 'Scheduling…' : 'Schedule')),
    ] : null)
}
