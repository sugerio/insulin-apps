import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { DAYS, keepReadyLabel } from '../lib/format.ts'
import type { CollectionSummary, KeepReadyWindow } from '../lib/types.ts'
import { ActionError, Banner, Note } from './Feedback.tsx'

// A collection's settings, for its owner and admins (design J7, LIM-10): its name and purpose, the one switch for AI
// assistants and API clients, and keeping it ready during a daily window (up to 3 hours, in the organization's time
// zone; one collection at a time by default, paused at 90% of the organization's awake hours).

const WORKING_DAYS = [1, 2, 3, 4, 5]
const STARTS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)

export function NamePurposeForm({ collection, onSaved }: { collection: CollectionSummary; onSaved: (collection: CollectionSummary) => void }) {
  const [name, setName] = useState(collection.name)
  const [purpose, setPurpose] = useState(collection.purpose)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const body = await api.patch<{ collection: CollectionSummary }>(collectionPath(collection.id), { name: name.trim(), purpose: purpose.trim() })
      setSaved(true)
      onSaved(body.collection)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const changed = name.trim() !== collection.name || purpose.trim() !== collection.purpose
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-name">Name</Label>
        <Input id="settings-name" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-purpose">In one sentence, what is it for?</Label>
        <Textarea id="settings-purpose" rows={2} maxLength={500} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
        <Note>AI assistants read this to decide when to ask this collection.</Note>
      </div>
      <ActionError error={error} />
      {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Saved.</p> : null}
      <div><Button type="submit" variant="outline" disabled={busy || !changed || !name.trim()}>Save</Button></div>
    </form>
  )
}

export function AssistantsSwitch({ collection, onSaved }: { collection: CollectionSummary; onSaved: (collection: CollectionSummary) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function set(value: boolean) {
    setBusy(true)
    setError(null)
    try {
      const body = await api.patch<{ collection: CollectionSummary }>(collectionPath(collection.id), { assistants: value })
      onSaved(body.collection)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <Switch id="assistants" checked={collection.assistants} disabled={busy} onCheckedChange={(value) => void set(value)} className="mt-0.5" />
        <Label htmlFor="assistants" className="flex flex-col items-start gap-1 font-normal leading-snug">
          <span className="font-medium">AI assistants and API clients can ask it</span>
          <span className="text-xs text-muted-foreground">
            Claude, ChatGPT and other AI assistants act as their person, with that person's role here. An API client asks only when this collection is shared with it by name.
          </span>
        </Label>
      </div>
      <ActionError error={error} />
    </div>
  )
}

export function KeepReadyForm({ collection, timeZone, onSaved }: { collection: CollectionSummary; timeZone?: string | null; onSaved: (collection: CollectionSummary) => void }) {
  const current = collection.keepReady
  const [mode, setMode] = useState<'asked' | 'window'>(current ? 'window' : 'asked')
  const [days, setDays] = useState<number[]>(current?.days ?? WORKING_DAYS)
  const [start, setStart] = useState(current?.start ?? '09:00')
  const [hours, setHours] = useState(current?.hours ?? 2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const keepReady: KeepReadyWindow | null = mode === 'window' ? { days: [...days].sort(), start, hours } : null
      const body = await api.patch<{ collection: CollectionSummary }>(collectionPath(collection.id), { keepReady })
      setSaved(true)
      onSaved(body.collection)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)} aria-label="Keep it ready">
      <RadioGroup value={mode} onValueChange={(value) => setMode(value as 'asked' | 'window')}>
        <div className="flex items-start gap-2">
          <RadioGroupItem id="keep-asked" value="asked" className="mt-0.5" />
          <Label htmlFor="keep-asked" className="flex flex-col items-start gap-0.5 font-normal">
            <span className="font-medium">Only when asked</span>
            <span className="text-xs text-muted-foreground">Sleeps 10 minutes after the last question. The next question wakes it in about a minute.</span>
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <RadioGroupItem id="keep-window" value="window" className="mt-0.5" />
          <Label htmlFor="keep-window" className="flex flex-col items-start gap-0.5 font-normal">
            <span className="font-medium">A daily window</span>
            <span className="text-xs text-muted-foreground">
              Answers then take a few seconds. Up to 3 hours a day, in your organization's time zone{timeZone ? ` (${timeZone})` : ''}, set by an admin in Rules and data. It uses your organization's awake hours, and pauses at 90% of them. One collection is kept ready at a time unless Insulin Apps raised the limit.
            </span>
          </Label>
        </div>
      </RadioGroup>
      {mode === 'window' ? (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
            <legend className="mb-1 text-sm font-medium">Days</legend>
            {DAYS.map((day, index) => (
              <label key={day} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={days.includes(index)} onCheckedChange={(value) => setDays((list) => (value ? [...list, index] : list.filter((other) => other !== index)))} aria-label={day} />
                {day.slice(0, 3)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="keep-start">From</Label>
              <NativeSelect id="keep-start" value={start} onChange={(event) => setStart(event.target.value)}>
                {STARTS.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="keep-hours">For</Label>
              <NativeSelect id="keep-hours" value={String(hours)} onChange={(event) => setHours(Number(event.target.value))}>
                {[1, 2, 3].map((value) => <NativeSelectOption key={value} value={String(value)}>{value === 1 ? '1 hour' : `${value} hours`}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </div>
          {days.length ? <Note>Kept ready {keepReadyLabel({ days, start, hours })}.</Note> : <Note>Pick at least one day.</Note>}
        </div>
      ) : null}
      {current?.paused ? <Banner kind="warn">Keep-ready is paused: your organization has used 90% of its awake hours this month. It starts again on the 1st.</Banner> : null}
      <ActionError error={error} />
      {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Saved.</p> : null}
      <div><Button type="submit" variant="outline" disabled={busy || (mode === 'window' && days.length === 0)}>Save</Button></div>
    </form>
  )
}
