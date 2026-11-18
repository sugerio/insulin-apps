import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx'
import { collectionPath } from '../lib/api.ts'
import { formatDay, isDeck, pagesLabel, pagesOfRange, plural, sourceKind } from '../lib/format.ts'
import type { SourceDetail } from '../lib/types.ts'
import { useResource } from '../lib/useResource.ts'
import { Badge, ErrorState, Loading, Note } from './Feedback.tsx'

// The source viewer (design J2, ASK-03): a source's text opened at the exact words an answer used, highlighted, with
// the pages (or slides) they run over, the collection's owner and when it was added. Values hidden before learning
// show as "hidden", never as what they were (the server never has them). A long text shows the words around the
// highlight first.

export interface SourceTarget {
  collectionId: string
  documentId: string
  /** The cited words: character positions in the source's text. */
  start?: number | null
  end?: number | null
  /** Or a sentence to find (a fact's source sentence). */
  find?: string | null
}

const CONTEXT = 1500

export function SourceViewer({ target, onClose }: { target: SourceTarget | null; onClose: () => void }) {
  return (
    <Sheet open={target !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl" data-source-viewer="">
        {target ? <SourceBody target={target} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function SourceBody({ target }: { target: SourceTarget }) {
  const { data, error, loading, reload } = useResource<SourceDetail>(collectionPath(target.collectionId, `/sources/${encodeURIComponent(target.documentId)}`))
  const [whole, setWhole] = useState(false)
  const mark = useRef<HTMLElement>(null)
  const range = useMemo(() => {
    if (!data) return null
    const text = data.source.text
    if (typeof target.start === 'number' && typeof target.end === 'number' && target.end > target.start && target.end <= text.length) return { start: target.start, end: target.end }
    if (target.find) {
      const at = text.indexOf(target.find)
      if (at >= 0) return { start: at, end: at + target.find.length }
    }
    return null
  }, [data, target.start, target.end, target.find])

  useEffect(() => {
    mark.current?.scrollIntoView?.({ block: 'center' })
  }, [range, whole])

  if (loading) return <div className="p-4"><Loading label="Opening the source…" /></div>
  if (error || !data) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <SheetHeader className="p-0"><SheetTitle>Source</SheetTitle><SheetDescription className="sr-only">The source couldn't be opened.</SheetDescription></SheetHeader>
        <ErrorState error={error} title="Couldn't open this source" onRetry={() => void reload()} />
      </div>
    )
  }
  const { source, owner } = data
  const document = source.document
  // The pages (or slides) the highlighted words run over: "Page 4", "Pages 1–4", "Slides 3–4".
  const pages = range ? pagesOfRange(source.pages, range.start, range.end) : null
  const where = pages ? pagesLabel(pages[0], pages[1], isDeck(document)) : ''
  const [whereLabel, whereValue] = where ? [where.slice(0, where.indexOf(' ')), where.slice(where.indexOf(' ') + 1)] : ['', '']
  const text = source.text
  const from = whole || !range ? 0 : Math.max(0, range.start - CONTEXT)
  const to = whole || !range ? (whole ? text.length : Math.min(text.length, CONTEXT * 2)) : Math.min(text.length, range.end + CONTEXT)
  const shortened = from > 0 || to < text.length
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <SheetHeader className="gap-1 p-0">
        <p className="text-xs text-muted-foreground">{sourceKind(document)}{where ? ` · ${capital(where)}` : ''}</p>
        <SheetTitle className="pr-8 text-lg [overflow-wrap:anywhere]">{document.name}</SheetTitle>
        <SheetDescription className="sr-only">The text of this source, with the words the answer used highlighted.</SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Collection</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{data.collection.name}</dd>
        <dt className="text-muted-foreground">Owner</dt><dd>{owner.name ?? 'Unknown'}</dd>
        <dt className="text-muted-foreground">Last edit</dt><dd>{formatDay(data.lastEdit)}</dd>
        {where ? <><dt className="text-muted-foreground">{capital(whereLabel)}</dt><dd>{whereValue}</dd></> : null}
        <dt className="text-muted-foreground">Status</dt>
        <dd>{document.active ? <Badge tone="green">Used for answers</Badge> : <Badge tone="grey">Not used for answers</Badge>}</dd>
        {source.hidden.length ? (
          <><dt className="text-muted-foreground">Hidden</dt><dd>{plural(source.hidden.length, 'value')} hidden before Insulin read it</dd></>
        ) : null}
      </dl>
      <div className="rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-source-text="">
        {from > 0 ? <span className="text-muted-foreground">…</span> : null}
        {renderText(text, from, to, range, source.hidden, mark)}
        {to < text.length ? <span className="text-muted-foreground">…</span> : null}
      </div>
      {range ? <Note>The highlighted words are what the answer used.</Note> : null}
      {shortened || whole ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setWhole(!whole)}>
          {whole ? 'Show the words around the highlight' : 'Show the whole text'}
        </Button>
      ) : null}
    </div>
  )
}

/** The text from `from` to `to`, with the cited range marked and every hidden value shown as "hidden". */
function renderText(text: string, from: number, to: number, range: { start: number; end: number } | null, hidden: { start: number; end: number }[], mark: React.RefObject<HTMLElement | null>): ReactNode[] {
  const cuts = new Set([from, to])
  if (range) {
    cuts.add(Math.max(from, Math.min(to, range.start)))
    cuts.add(Math.max(from, Math.min(to, range.end)))
  }
  for (const span of hidden) {
    if (span.end <= from || span.start >= to) continue
    cuts.add(Math.max(from, span.start))
    cuts.add(Math.min(to, span.end))
  }
  const points = [...cuts].sort((a, b) => a - b)
  const parts: ReactNode[] = []
  let marked = false
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!
    const end = points[index + 1]!
    if (end <= start) continue
    const isHidden = hidden.some((span) => start >= span.start && end <= span.end)
    const inRange = range !== null && start >= range.start && end <= range.end
    const piece = isHidden
      ? <span key={start} className="rounded bg-foreground/10 px-1 text-xs font-medium text-muted-foreground" title="Hidden before Insulin read the file" data-hidden-value="">hidden</span>
      : text.slice(start, end)
    if (inRange) {
      parts.push(<mark key={`m${start}`} ref={marked ? undefined : (mark as React.RefObject<HTMLElement>)} className="rounded bg-amber-200 px-0.5 text-foreground dark:bg-amber-800/70" data-cited="">{piece}</mark>)
      marked = true
    } else {
      parts.push(typeof piece === 'string' ? <span key={start}>{piece}</span> : piece)
    }
  }
  return parts
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1)
