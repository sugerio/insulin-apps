import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ActionError, Badge, Banner, ErrorState, Loading, Note } from '../components/Feedback.tsx'
import { Card, Page, PageHead } from '../components/Page.tsx'
import { api } from '../lib/api.ts'
import { formatBytes, formatNumber, formatResetDay } from '../lib/format.ts'
import type { HidingRules, LimitUsage, Rules, Usage } from '../lib/types.ts'
import { useResource } from '../lib/useResource.ts'
import { canManageRules, useMe } from '../session.tsx'
import { NoPermissionPage } from './NotFoundPage.tsx'

// Rules and data (design J11, Admins in Knowledge): what is hidden before Insulin reads anything, with a "Try it" box
// that uses the same detectors the engine does; usage beside each free limit, with "Ask for more"; who writes answers on
// the site; the time zone of keep-ready windows; and that exports are per collection. Being an Admin here gives no
// access to any collection's content.

const RULES: { key: keyof Omit<HidingRules, 'words'>; label: string }[] = [
  { key: 'emails', label: 'E-mail addresses' },
  { key: 'phones', label: 'Phone numbers' },
  { key: 'cards', label: 'Card numbers' },
  { key: 'apiKeys', label: 'API keys and tokens' },
  { key: 'secrets', label: 'Values labelled as passwords or secrets' },
]

// Synthetic sample text; the card number and the key are put together here so no file holds one whole.
const SAMPLE = [
  'Hi team, reach Jordan at jordan.lee@example.com or +1 415 555 0132.',
  `Card on file: ${['4111', '1111', '1111', '1111'].join(' ')}. API token: ${['sk', 'live', '9a8b7c6d5e4f3a2b1c0d'].join('_')}.`,
  'Wi-Fi password: orchard-blue-42',
].join('\n')

const ZONES = ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland']

function zones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ZONES
  return [...new Set([current, ...ZONES, ...all])]
}

export function RulesPage() {
  const me = useMe()
  const allowed = canManageRules(me)
  const rules = useResource<Rules>(allowed ? '/api/rules' : null)
  const usage = useResource<Usage>(allowed ? '/api/usage' : null)
  if (!allowed) return <NoPermissionPage title="Rules and data" message="Rules and data is for Admins in Knowledge. Ask an admin of your organization if something here needs changing." />
  return (
    <Page title="Rules and data" crumbs={[['Admin'], ['Rules and data']]}>
      <PageHead title="Rules and data" sub="Set these once and every collection in your organization follows them. People, roles, integrations and AI connections are in Settings, on insulinapps.com." />
      {rules.loading ? <Loading /> : rules.error || !rules.data ? <ErrorState error={rules.error} onRetry={() => void rules.reload()} /> : (
        <div className="@container"><div className="grid items-start gap-4 @4xl:grid-cols-2">
          <HidingCard rules={rules.data} onSaved={rules.set} />
          <UsageCard usage={usage} supportConfigured={Boolean(rules.data.supportConfigured)} />
          <WriterCard rules={rules.data} onSaved={rules.set} />
          <div className="flex flex-col gap-4">
            <TimeZoneCard rules={rules.data} onSaved={rules.set} />
            <Card title="Your data">
              <p className="text-sm">Exports are per collection: a collection's owner or admins export it from its Sharing tab. Nobody, not even an owner of the organization, can export or delete every collection at once.</p>
              <p className="text-sm">Owners of the organization see every collection's basic information on the Collections page and can delete one at a time.</p>
              <Note>Deleting the whole organization is done in the organization's settings on insulinapps.com; every collection's data is then removed.</Note>
            </Card>
          </div>
        </div></div>
      )}
    </Page>
  )
}

async function saveRules(change: Partial<Pick<Rules, 'timeZone' | 'answerWriter' | 'hiding'>>): Promise<Rules> {
  return api.put<Rules>('/api/rules', change)
}

function HidingCard({ rules, onSaved }: { rules: Rules; onSaved: (rules: Rules) => void }) {
  const [hiding, setHiding] = useState<HidingRules>(rules.hiding)
  const [text, setText] = useState(SAMPLE)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api.post<{ text: string }>('/api/rules/hiding-preview', { text, hiding }).then(
        (body) => { if (live) { setPreview(body.text); setPreviewError(null) } },
        (failure) => { if (live) setPreviewError(failure) },
      )
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [text, hiding])
  const changed = RULES.some((rule) => hiding[rule.key] !== rules.hiding[rule.key])
  const stricter = RULES.some((rule) => hiding[rule.key] && !rules.hiding[rule.key])
  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      onSaved({ ...rules, ...(await saveRules({ hiding })) })
      setSaved(true)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Hide before learning" description="Insulin removes these from every file, web page and note before it reads them, so no answer can show them.">
      <ul className="flex flex-col gap-3">
        {RULES.map((rule) => (
          <li key={rule.key} className="flex items-center gap-3">
            <Switch id={`hide-${rule.key}`} checked={hiding[rule.key]} onCheckedChange={(value) => setHiding({ ...hiding, [rule.key]: value })} />
            <Label htmlFor={`hide-${rule.key}`} className="font-normal">{rule.label}</Label>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="try-it">Try it</Label>
        <Textarea id="try-it" rows={4} value={text} onChange={(event) => setText(event.target.value)} />
        <div className="min-h-16 rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]" aria-live="polite" data-try-it-result="">
          {previewError ? <ActionError error={previewError} kept={null} /> : preview === null ? <span className="text-muted-foreground">Checking…</span> : renderHidden(preview)}
        </div>
        <Note>The same rules the collections use. Nothing you type here is stored.</Note>
      </div>
      {stricter ? <Banner kind="info">A new or stricter rule also re-reads files learned before, in the background, which counts as learning. Earlier versions that still hold the newly hidden text can't be brought back.</Banner> : null}
      <ActionError error={error} />
      {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Saved. Every collection follows the new rules.</p> : null}
      <div><Button type="button" disabled={busy || !changed} onClick={() => void save()}>{busy ? 'Saving…' : 'Save the rules'}</Button></div>
    </Card>
  )
}

function renderHidden(text: string) {
  return text.split(/(\[hidden\])/).map((part, index) => (part === '[hidden]'
    ? <span key={index} className="rounded bg-foreground/10 px-1 text-xs font-medium text-muted-foreground" data-hidden-value="">hidden</span>
    : <span key={index}>{part}</span>))
}

function show(limit: LimitUsage, value: number | null): string {
  if (value === null) return 'unlimited'
  if (limit.unit === 'bytes') return formatBytes(value)
  if (limit.unit === 'hours') return `${formatNumber(value)} h`
  if (limit.unit === 'days') return `${formatNumber(value)} days`
  return formatNumber(value)
}

function UsageCard({ usage, supportConfigured }: { usage: ReturnType<typeof useResource<Usage>>; supportConfigured: boolean }) {
  const [asking, setAsking] = useState(false)
  const [sent, setSent] = useState(false)
  const data = usage.data
  return (
    <Card title="Usage and limits" description="Insulin Knowledge is free. To keep it free for everyone, each organization has limits, set by Insulin Apps."
      right={<Button type="button" variant="outline" size="sm" onClick={() => { setSent(false); setAsking(true) }}>Ask for more</Button>}>
      {usage.loading ? <Loading /> : usage.error || !data ? <ErrorState error={usage.error} onRetry={() => void usage.reload()} /> : (
        <>
          <ul className="flex flex-col gap-3" aria-label="Usage beside each limit">
            {data.limits.map((limit) => {
              const percent = limit.percent ?? 0
              const tone = percent >= 100 ? 'text-destructive' : percent >= 80 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
              return (
                <li key={limit.key} className="flex flex-col gap-1" data-limit={limit.key}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span>{limit.label}</span>
                    <span className={tone}>{limit.used === null ? show(limit, limit.limit) : `${show(limit, limit.used)} of ${show(limit, limit.limit)}`}{limit.resetsAt && limit.used !== null ? ` · until ${formatResetDay(limit.resetsAt)}` : ''}</span>
                  </div>
                  {limit.used !== null && limit.limit !== null ? <Progress value={percent} aria-label={`${limit.label}: ${percent}%`} /> : null}
                </li>
              )
            })}
          </ul>
          <Note>Awake hours count the time collections are awake: while people ask and 10 minutes after, while learning or exporting, and kept-ready hours. Keep-ready pauses at 90%; at the limit Knowledge stops answering until the 1st. Admins get an e-mail at 80% of a limit.</Note>
          {data.collections.length ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">Awake this month, for the collections you have a role in</h3>
              <ul className="flex flex-col divide-y text-sm">
                {data.collections.map((collection) => (
                  <li key={collection.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{collection.name}{collection.keepReady ? <Badge tone={collection.keepReadyPaused ? 'amber' : 'grey'} className="ml-2">{collection.keepReadyPaused ? 'keep-ready paused' : 'kept ready'}</Badge> : null}</span>
                    <span className="text-muted-foreground tabular-nums">{formatNumber(collection.awakeHours)} h</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Note>Every hour Knowledge sends Insulin Apps counts and sizes only, never names or content. The Docs list them.</Note>
          {sent ? <Banner kind="ok">Sent to Insulin Apps support with your organization's usage. They reply by e-mail; a raised limit shows here within five minutes.</Banner> : null}
        </>
      )}
      {asking && data ? <AskForMoreDialog limits={data.limits} supportConfigured={supportConfigured} onClose={() => setAsking(false)} onSent={() => { setAsking(false); setSent(true) }} /> : null}
    </Card>
  )
}

function AskForMoreDialog({ limits, supportConfigured, onClose, onSent }: { limits: LimitUsage[]; supportConfigured: boolean; onClose: () => void; onSent: () => void }) {
  const [limit, setLimit] = useState(limits.find((entry) => (entry.percent ?? 0) >= 80)?.key ?? limits[0]?.key ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function send(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.create('/api/rules/ask-for-more', { limit, note: note.trim() || undefined })
      onSent()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void send(event)}>
          <DialogHeader>
            <DialogTitle>Ask Insulin Apps for more</DialogTitle>
            <DialogDescription>Insulin Apps support gets an e-mail with your organization's usage beside each limit, and replies by e-mail.</DialogDescription>
          </DialogHeader>
          {supportConfigured ? null : <Banner kind="warn">Insulin Apps support's address isn't set up here, so the request can't be sent. Ask your Insulin Apps operator.</Banner>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="more-limit">Which limit?</Label>
            <NativeSelect id="more-limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
              {limits.map((entry) => <NativeSelectOption key={entry.key} value={entry.key}>{entry.label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="more-note">Why do you need more? (optional)</Label>
            <Textarea id="more-note" rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !supportConfigured}>{busy ? 'Sending…' : 'Send'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WriterCard({ rules, onSaved }: { rules: Rules; onSaved: (rules: Rules) => void }) {
  const own = rules.answerWriter.kind === 'own' ? rules.answerWriter : null
  const [kind, setKind] = useState<'builtin' | 'own'>(rules.answerWriter.kind)
  const [integrationKey, setIntegrationKey] = useState(own?.integrationKey ?? '')
  const [url, setUrl] = useState(own?.url ?? '')
  const [model, setModel] = useState(own?.model ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const answerWriter = kind === 'builtin' ? { kind } : { kind, integrationKey: integrationKey.trim(), url: url.trim(), model: model.trim() }
      onSaved({ ...rules, ...(await saveRules({ answerWriter })) })
      setSaved(true)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Answers on this site" description="Who writes the sentence above the sources. AI assistants always write their own.">
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        <RadioGroup value={kind} onValueChange={(value) => setKind(value as 'builtin' | 'own')}>
          <div className="flex items-start gap-2">
            <RadioGroupItem id="writer-builtin" value="builtin" className="mt-0.5" />
            <Label htmlFor="writer-builtin" className="flex flex-col items-start gap-0.5 font-normal">
              <span className="font-medium">Insulin Knowledge's built-in model: Gemma 4 <span className="text-xs font-normal text-muted-foreground">default</span></span>
              <span className="text-xs text-muted-foreground">Free, up to your organization's written answers a month. It runs inside Insulin Knowledge, so your passages don't leave it.</span>
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem id="writer-own" value="own" className="mt-0.5" />
            <Label htmlFor="writer-own" className="flex flex-col items-start gap-0.5 font-normal">
              <span className="font-medium">Your organization's own model</span>
              <span className="text-xs text-muted-foreground">Uses a key your organization stored in Settings › Integrations. The passages for each answer are sent to that provider. Its answers don't count against the free limit.</span>
            </Label>
          </div>
        </RadioGroup>
        {kind === 'own' ? (
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="writer-key">Integration</Label>
              <Input id="writer-key" required placeholder="The integration's key, as in Settings › Integrations" value={integrationKey} onChange={(event) => setIntegrationKey(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="writer-url">Address of its chat completions endpoint</Label>
              <Input id="writer-url" required type="url" placeholder="https://api.example.com/v1/chat/completions" value={url} onChange={(event) => setUrl(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="writer-model">Model</Label>
              <Input id="writer-model" required value={model} onChange={(event) => setModel(event.target.value)} />
            </div>
          </div>
        ) : null}
        <Note>If the model can't answer, people still get the sources, with a note that there's no written answer.</Note>
        <ActionError error={error} />
        {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Saved.</p> : null}
        <div><Button type="submit" variant="outline" disabled={busy}>Save</Button></div>
      </form>
    </Card>
  )
}

function TimeZoneCard({ rules, onSaved }: { rules: Rules; onSaved: (rules: Rules) => void }) {
  const [zone, setZone] = useState(rules.timeZone)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const options = useMemo(() => zones(rules.timeZone), [rules.timeZone])
  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      onSaved({ ...rules, ...(await saveRules({ timeZone: zone })) })
      setSaved(true)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Time zone" description="Keep-ready windows follow this time zone, until insulinapps.com keeps one for the organization.">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="time-zone">Time zone</Label>
          <NativeSelect id="time-zone" value={zone} onChange={(event) => setZone(event.target.value)}>
            {options.map((value) => <NativeSelectOption key={value} value={value}>{value.replace(/_/g, ' ')}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <Button type="button" variant="outline" disabled={busy || zone === rules.timeZone} onClick={() => void save()}>Save</Button>
      </div>
      <ActionError error={error} />
      {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Saved.</p> : null}
    </Card>
  )
}
