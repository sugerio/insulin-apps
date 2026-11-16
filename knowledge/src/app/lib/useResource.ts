import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'

export interface Resource<T> {
  data: T | null
  error: unknown
  loading: boolean
  reload: () => Promise<void>
  /** Replaces the data without asking the server (after a change answered with the new value). */
  set: (value: T) => void
}

/**
 * A GET of the API for a screen: loaded when the path is set and again when it changes; `pollMs` reloads it while the
 * screen is open (a collection that is learning, waking or going back), quietly, keeping what it showed.
 */
export function useResource<T>(path: string | null, options: { pollMs?: number | null } = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(path !== null)
  const current = useRef(path)
  current.current = path

  const load = useCallback(async (quiet: boolean) => {
    const wanted = current.current
    if (!wanted) return
    if (!quiet) setLoading(true)
    try {
      const value = await api.get<T>(wanted)
      if (current.current !== wanted) return
      setData(value)
      setError(null)
    } catch (failure) {
      if (current.current !== wanted) return
      if (!quiet) setData(null)
      setError(failure)
    } finally {
      if (current.current === wanted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setData(null)
    setError(null)
    if (path) void load(false)
    else setLoading(false)
  }, [path, load])

  useEffect(() => {
    if (!path || !options.pollMs) return
    const timer = setInterval(() => void load(true), options.pollMs)
    return () => clearInterval(timer)
  }, [path, options.pollMs, load])

  const reload = useCallback(() => load(true), [load])
  return { data, error, loading, reload, set: setData }
}
