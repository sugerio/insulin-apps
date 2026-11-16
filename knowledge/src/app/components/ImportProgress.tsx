import { useEffect, useState } from 'react'
import { Progress } from '@/components/ui/progress.tsx'
import { api, collectionPath, describeError } from '../lib/api.ts'
import { plural, startsIn, timeLeft } from '../lib/format.ts'
import type { ImportStatus } from '../lib/types.ts'
import { Badge, Banner } from './Feedback.tsx'

// Learning progress (design J1 step 3, J9 and section 10): each file Waiting → Reading → Understanding → learned, with
// the time left the engine measures; waiting behind other imports; interrupted and trying again; failed after three
// tries, naming the file; already here. The import is polled until it is final.

export const FINAL = new Set(['committed', 'duplicate', 'failed', 'cancelled'])

/** The 1st of next month (UTC), when an import waiting for the month's documents learned starts by itself. */
export function nextMonth(now = Date.now()): string {
  const date = new Date(now)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** How often an import waiting for the 1st is checked again while the page stays open (it can start sooner: a raised limit). */
const WAITING_CHECK_MS = 10 * 60 * 1000
/** setTimeout's longest wait. */
const LONGEST_TIMER_MS = 2 ** 31 - 1

/**
 * Follows an import until it is final; `onFinal` runs once when it is. A newer status the caller hands over for the
 * same import is followed too. One waiting for the 1st is checked again at the reset, every ten minutes, and whenever
 * the page comes back into view (the limit may have been raised, or the month turned while the tab slept).
 */
export function useImportWatch(collectionId: string, initial: ImportStatus | null, onFinal?: (status: ImportStatus) => void): { status: ImportStatus | null; error: unknown } {
  const [status, setStatus] = useState<ImportStatus | null>(initial)
  const [error, setError] = useState<unknown>(null)
  const id = initial?.importId ?? null
  useEffect(() => {
    setStatus(initial)
    if (!id || !initial) return
    if (FINAL.has(initial.state)) {
      onFinal?.(initial)
      return
    }
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let state = initial.state
    const schedule = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => void poll(), Math.min(ms, LONGEST_TIMER_MS))
    }
    const later = () => (state === 'waiting' ? Math.min(WAITING_CHECK_MS, Math.max(1000, Date.parse(resetDate()) - Date.now() + 5000)) : 1500)
    const poll = async () => {
      try {
        const body = await api.get<{ import: ImportStatus }>(collectionPath(collectionId, `/imports/${encodeURIComponent(id)}`))
        if (!live) return
        setStatus(body.import)
        setError(null)
        state = body.import.state
        if (FINAL.has(body.import.state)) {
          onFinal?.(body.import)
          return
        }
      } catch (failure) {
        if (!live) return
        setError(failure)
      }
      schedule(later())
    }
    // Back into view: a waiting import is asked about at once.
    const back = () => {
      if (state === 'waiting' && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) schedule(0)
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    schedule(initial.state === 'waiting' ? later() : 600)
    return () => {
      live = false
      clearTimeout(timer)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
    // The import is followed from its id, and from a newer status handed over for it; onFinal is read when it ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, id, initial])
  return { status, error }
}

/** The 1st of next month (UTC), as an ISO time. */
function resetDate(now = Date.now()): string {
  const date = new Date(now)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString()
}

const FILE_STATE: Record<string, string> = {
  waiting: 'Waiting',
  reading: 'Reading…',
  understanding: 'Understanding…',
  learned: 'Learned',
  already_here: 'Already here',
  failed: "Couldn't read",
}

export function ImportProgress({ status, collectionName, title, error }: { status: ImportStatus; collectionName: string; title?: string; error?: unknown }) {
  const files = status.files
  const n = files.length
  const learned = files.filter((file) => file.state === 'learned').length
  const done = files.filter((file) => file.state === 'learned' || file.state === 'already_here' || file.state === 'failed').length
  const what = n ? plural(n, 'file') : status.notes === 1 ? 'a note' : plural(status.notes, 'note')
  const final = FINAL.has(status.state)
  const percent = status.state === 'committed' || status.state === 'duplicate' ? 100
    : status.state === 'waiting' ? 0
    : status.state === 'saving' ? 95
      : n ? Math.round(((done + (status.state === 'learning' ? 0.5 : 0)) / n) * 90) : status.state === 'learning' ? 50 : 10
  const left = !final ? timeLeft(status.etaSeconds) : null
  const retrying = !final && status.attempt > 1

  let message: { kind: 'info' | 'warn' | 'ok' | 'danger'; text: string }
  if (status.state === 'committed') {
    const already = files.filter((file) => file.state === 'already_here').length
    const facts = status.newFacts ?? 0
    message = { kind: 'ok', text: `Done. ${collectionName} learned ${n ? plural(learned, 'file') : what} (${plural(facts, 'new fact')}). New questions use ${learned === 1 || !n ? 'it' : 'them'} now. A restore point was saved.${already ? ` ${plural(already, 'file')} ${already === 1 ? 'was' : 'were'} already here.` : ''}` }
  } else if (status.state === 'duplicate') {
    message = { kind: 'info', text: `Already here. ${n === 1 ? 'This file has' : `These ${n} files have`} the same content as files ${collectionName} has already learned, so nothing changed.` }
  } else if (status.state === 'failed') {
    const failed = files.find((file) => file.fileId === status.failedFileId) ?? files.find((file) => file.state === 'failed')
    const reason = failed?.reason ?? status.error?.message ?? 'The import failed.'
    message = { kind: 'danger', text: `${reason} Nothing from this import was kept, so ${collectionName} is exactly as it was.${n > 1 ? ` The other ${plural(n - 1, 'file')} can be learned without it: add them again.` : ''}` }
  } else if (status.state === 'cancelled') {
    message = { kind: 'warn', text: `This import was stopped. Nothing from it was kept, so ${collectionName} is exactly as it was.` }
  } else if (status.state === 'waiting') {
    // Files the engine couldn't keep until the 1st are listed as failed: they are to be added again.
    const waits = files.filter((file) => file.state !== 'failed').length
    const lost = files.filter((file) => file.state === 'failed')
    const gone = lost.length ? ` Insulin couldn't keep ${lost.length === 1 ? `“${lost[0]!.name}”` : plural(lost.length, 'file')} until then: add ${lost.length === 1 ? 'it' : 'them'} again.` : ''
    message = { kind: 'info', text: `Your organization has learned this month's documents, so ${waits ? (waits === 1 ? 'this file waits' : 'these files wait') : 'this waits'} and ${collectionName} learns ${waits === 1 || !waits ? 'it' : 'them'} on ${nextMonth()}, by itself. Everything already learned keeps answering.${gone} You can leave this page; Insulin e-mails you when it's done.` }
  } else if (retrying) {
    message = { kind: 'warn', text: `The import was interrupted. Nothing from it was kept, so ${collectionName} is exactly as it was before. Trying again (${status.attempt} of 3).` }
  } else if (status.state === 'queued' && status.waitingFor === 'organization') {
    message = { kind: 'info', text: `Your organization already has imports running. This one starts after them, ${startsIn(status.etaSeconds)}.` }
  } else if (status.state === 'queued' && status.waitingFor === 'service') {
    message = { kind: 'info', text: `Insulin Knowledge is busy. Your files start ${startsIn(status.etaSeconds)}.` }
  } else if (status.state === 'saving') {
    message = { kind: 'info', text: 'Saving a restore point so you can always come back to this version.' }
  } else {
    message = { kind: 'info', text: `Reading and understanding ${what}. Questions to ${collectionName} wait until this finishes. You can leave this page; Insulin e-mails you when it's done.` }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10" aria-label="Learning" data-import={status.state}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{title ?? `Adding ${what} to ${collectionName}`}</h3>
        {retrying ? <Badge tone="amber">Try {status.attempt} of 3</Badge> : null}
        <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">{final ? '' : status.state === 'waiting' ? `Starts ${nextMonth()}` : left ?? 'Starting…'}</span>
      </div>
      <Progress value={percent} aria-label={`Learning: ${percent}%`} />
      <Banner kind={message.kind}>{message.text}</Banner>
      {n ? (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {files.map((file) => (
            <li key={file.fileId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{file.name}</span>
              <span className={file.state === 'failed' ? 'text-destructive' : file.state === 'learned' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}>
                {file.state === 'learned' ? '✓ Learned' : status.state === 'waiting' && file.state === 'failed' ? 'Not kept' : FILE_STATE[file.state] ?? file.state}
              </span>
              {file.reason ? <span className="basis-full text-xs text-muted-foreground">{file.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-sm text-muted-foreground">Couldn't check on it just now ({describeError(error)}). It keeps going; this page tries again.</p> : null}
    </section>
  )
}
