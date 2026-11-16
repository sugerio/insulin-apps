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

/** Follows an import until it is final; `onFinal` runs once when it is. */
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
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const body = await api.get<{ import: ImportStatus }>(collectionPath(collectionId, `/imports/${encodeURIComponent(id)}`))
        if (!live) return
        setStatus(body.import)
        setError(null)
        if (FINAL.has(body.import.state)) {
          onFinal?.(body.import)
          return
        }
      } catch (failure) {
        if (!live) return
        setError(failure)
      }
      timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 600)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // The import is followed from its id; onFinal is read when it ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, id])
  return { status, error }
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
        <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">{final ? '' : left ?? 'Starting…'}</span>
      </div>
      <Progress value={percent} aria-label={`Learning: ${percent}%`} />
      <Banner kind={message.kind}>{message.text}</Banner>
      {n ? (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {files.map((file) => (
            <li key={file.fileId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{file.name}</span>
              <span className={file.state === 'failed' ? 'text-destructive' : file.state === 'learned' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}>
                {file.state === 'learned' ? '✓ Learned' : FILE_STATE[file.state] ?? file.state}
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
