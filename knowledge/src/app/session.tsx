import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './lib/api.ts'
import type { AppRole, CollectionSummary, Me } from './lib/types.ts'

// Who is using Knowledge (`GET /api/me`) and the collections they can ask (`GET /api/collections`), read once for the
// shell and every screen; a screen that changes the list (a new collection, a delete, a rename) reloads it. These only
// decide what to show: the server checks every request again.

export interface Session {
  me: Me | null
  /** The /api/me request failed: Knowledge can't be used (signed out, no role). */
  meError: unknown
  collections: CollectionSummary[] | null
  collectionsError: unknown
  reloadCollections: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children, initial }: { children: ReactNode; initial?: { me?: Me } }) {
  const [me, setMe] = useState<Me | null>(initial?.me ?? null)
  const [meError, setMeError] = useState<unknown>(null)
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null)
  const [collectionsError, setCollectionsError] = useState<unknown>(null)

  const reloadCollections = useCallback(async () => {
    try {
      const body = await api.get<{ collections: CollectionSummary[] }>('/api/collections')
      setCollections(body.collections)
      setCollectionsError(null)
    } catch (error) {
      setCollectionsError(error)
      setCollections((current) => current ?? [])
    }
  }, [])

  useEffect(() => {
    let live = true
    if (!initial?.me) {
      api.get<Me>('/api/me').then((value) => { if (live) setMe(value) }, (error) => { if (live) setMeError(error) })
    }
    return () => { live = false }
  }, [initial?.me])

  useEffect(() => {
    if (me && me.permissions.includes('knowledge.use')) void reloadCollections()
    else if (me) setCollections([])
  }, [me, reloadCollections])

  const value = useMemo(() => ({ me, meError, collections, collectionsError, reloadCollections }), [me, meError, collections, collectionsError, reloadCollections])
  return <SessionContext value={value}>{children}</SessionContext>
}

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used inside SessionProvider')
  return session
}

/** The signed-in person; screens render inside the shell only once it is known. */
export function useMe(): Me {
  const { me } = useSession()
  if (!me) throw new Error('useMe before /api/me answered')
  return me
}

export const hasPermission = (me: Me | null, permission: string) => Boolean(me?.permissions.includes(permission))
export const canCreate = (me: Me | null) => hasPermission(me, 'knowledge.collections.create') && me?.user.kind === 'person'
export const canEdit = (me: Me | null) => hasPermission(me, 'knowledge.collections.edit')
export const canManageRules = (me: Me | null) => hasPermission(me, 'knowledge.rules.manage')

/**
 * The role the navigation manifest is filtered by: what the person's permissions leave them, so a custom role without
 * permission to change content sees a Viewer's sections, and one without Rules and data no Admin group.
 */
export function navigationRole(me: Me | null): AppRole {
  if (!me) return 'VIEWER'
  if (canManageRules(me)) return 'ADMIN'
  if (canEdit(me)) return 'EDITOR'
  return 'VIEWER'
}

/** "Org owner · Admin in Knowledge", for the person at the foot of the navigation. */
export function personRole(me: Me): string {
  const app = { ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' }[me.role]
  return me.isOrganizationOwner ? `Organization owner · ${app} in Knowledge` : `${app} in Knowledge`
}
