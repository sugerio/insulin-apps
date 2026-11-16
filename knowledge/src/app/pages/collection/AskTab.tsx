import { useCallback } from 'react'
import { AnswerView, AskBox } from '../../components/Answer.tsx'
import { Banner, Loading, Note } from '../../components/Feedback.tsx'
import { describeError, quotaOf } from '../../lib/api.ts'
import { stateMessage } from '../../lib/format.ts'
import { useAsk } from '../../lib/useAsk.ts'
import type { TabProps } from './CollectionPage.tsx'

// Ask (design J2, J4, J5, J10): a question to this collection only, answered with numbered sources or "I won't guess".

export function AskTab({ detail, openSource }: TabProps) {
  const { collection, engine } = detail
  const state = engine?.state ?? collection.state
  const { question, answer, error, busy, ask } = useAsk()
  const again = useCallback(() => { if (question) void ask([collection.id], question) }, [ask, collection.id, question])
  const quota = quotaOf(error)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground" data-state-message={state}>{stateMessage(state, collection.name)}</p>
      <AskBox busy={busy} placeholder={`Ask a question about ${collection.name}…`} onAsk={(text) => void ask([collection.id], text)} initial={question} />
      {busy && !answer ? <Loading label={`Looking in ${collection.name}…`} /> : null}
      {error ? (
        quota ? <Banner kind="warn" title="Knowledge can't answer right now">{quota.message}</Banner> : <Banner kind="danger" title="Couldn't ask">{describeError(error)}</Banner>
      ) : null}
      {answer ? (
        <AnswerView question={question} answer={answer} collections={[collection]} onAskAgain={again}
          onOpenSource={(target) => openSource({ documentId: target.documentId, start: target.start, end: target.end })} />
      ) : (
        <Note>Answers come only from {collection.name}, never from the internet, and always show their sources. If nothing in it covers a question, Insulin says it won't guess.</Note>
      )}
    </div>
  )
}
