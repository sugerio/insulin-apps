import { useCallback, useRef, useState } from 'react'
import { useLimitStop } from '../components/LimitDialog.tsx'
import { api } from './api.ts'
import type { AskAnswer } from './types.ts'

/** Asking the named collections on the site (`POST /api/ask`): the last question, its answer, or what went wrong. */
export function useAsk() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const { stopIfAwakeHours } = useLimitStop()
  const latest = useRef(0)

  const ask = useCallback(async (collections: string[], text: string) => {
    const call = (latest.current += 1)
    // The previous answer goes with the previous question: a new question never shows it (or lets it be reported).
    setQuestion(text)
    setAnswer(null)
    setBusy(true)
    setError(null)
    try {
      const body = await api.post<AskAnswer>('/api/ask', { collections, question: text })
      if (call !== latest.current) return
      setAnswer(body)
    } catch (failure) {
      if (call !== latest.current) return
      setAnswer(null)
      setError(failure)
      stopIfAwakeHours(failure)
    } finally {
      if (call === latest.current) setBusy(false)
    }
  }, [stopIfAwakeHours])

  const reset = useCallback(() => {
    latest.current += 1
    setAnswer(null)
    setError(null)
    setQuestion('')
    setBusy(false)
  }, [])

  return { question, answer, error, busy, ask, reset }
}
