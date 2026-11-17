// The engine's router: every route of the contract, checked for its organization header, sent to the collection's
// Durable Object, the registry, the outbox or the answer model.

import { ORG_HEADER } from './contract.ts'
import type { CollectionStatus } from './contract.ts'
import { answer } from './answer.ts'
import { collectionName, type Env, OUTBOX_NAME, REGISTRY_NAME, callObject, stub, testControls } from './env.ts'
import { errorResponse, fail, json, readJson, requireId, SAFE_ORG } from './http.ts'
import type { RegistryEntry } from './registry.ts'
import { matchRoute, ROUTES, TEST_ROUTES } from './routes.ts'
import { DEFAULT_SETTINGS, ENGINE_LABEL } from './settings.ts'

export async function handle(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url)
    const match = matchRoute(request.method, url.pathname, testControls(env) ? [...TEST_ROUTES, ...ROUTES] : ROUTES)
    if (!match || match === 'method_not_allowed') return fail('not_found', 'No such route.')
    const { route, params } = match
    let org = ''
    if (route.orgHeader) {
      org = request.headers.get(ORG_HEADER) ?? ''
      if (!org) return fail('bad_request', `Every request must name its organization in ${ORG_HEADER}.`)
      if (!SAFE_ORG.test(org)) return fail('bad_request', `${ORG_HEADER} is not an organization id.`)
    }
    switch (route.scope) {
      case 'collection':
        return await collection(env, request, route.name, org, requireId(params.cid, 'The collection id'))
      case 'org': {
        if (params.org !== org) return fail('not_found', 'No such organization.')
        if (route.name === 'holdOrg') {
          const { until, version } = await readJson<{ until?: unknown; version?: unknown }>(request)
          if (until !== null && (typeof until !== 'string' || !Number.isFinite(Date.parse(until)))) {
            return fail('bad_request', 'until must be a date and time, or null to lift the hold.')
          }
          if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
            return fail('bad_request', "version must be the app's version of the hold, a whole number.")
          }
          return json(await callObject(env.REGISTRY, REGISTRY_NAME, '/hold', { body: { org, until, version } }))
        }
        const result = await callObject<{ collections: number }>(env.REGISTRY, REGISTRY_NAME, '/purge', { body: { org } })
        return json({ state: 'deleting', collections: result.collections }, 202)
      }
      case 'service':
        if (route.name === 'answer') return json(await answer(env, request))
        if (route.name === 'outbox') {
          const query = new URLSearchParams()
          for (const key of ['since', 'limit']) {
            const value = url.searchParams.get(key)
            if (value) query.set(key, value)
          }
          return json(await callObject(env.OUTBOX, OUTBOX_NAME, `/events?${query}`))
        }
        if (route.name === 'testObjects') return json(await objectCounts(env, org))
        if (route.name === 'health') {
          const { collections } = await callObject<{ collections: number }>(env.REGISTRY, REGISTRY_NAME, '/count')
          return json({ engine: ENGINE_LABEL, collections })
        }
    }
    return fail('not_found', 'No such route.')
  } catch (error) {
    return errorResponse(error)
  }
}

async function collection(env: Env, request: Request, name: string, org: string, collectionId: string): Promise<Response> {
  const response = await stub(env.COLLECTIONS, collectionName(org, collectionId)).fetch(request)
  if (response.status !== 404 || (name !== 'getCollection' && name !== 'deleteCollection')) return response
  // A deleted collection's own storage is gone; the registry remembers that it was deleted.
  const entry = await registryEntry(env, org, collectionId)
  if (entry?.state !== 'deleted') return response
  if (name === 'deleteCollection') return json({ state: 'deleted' }, 202)
  const deleted: CollectionStatus = {
    collectionId,
    state: 'deleted',
    version: 0,
    counts: { documents: 0, activeDocuments: 0, passages: 0, facts: 0, textBytes: 0 },
    currentImport: null,
    queuedImports: 0,
    wake: null,
    lastRestorePointAt: null,
    lastBackupAt: null,
    lastQuestionAt: null,
    settings: DEFAULT_SETTINGS,
  }
  return json(deleted)
}

async function registryEntry(env: Env, org: string, collectionId: string): Promise<RegistryEntry | null> {
  const response = await stub(env.REGISTRY, REGISTRY_NAME).fetch(
    `https://engine.internal/entry?org=${encodeURIComponent(org)}&collectionId=${encodeURIComponent(collectionId)}`,
  )
  return response.ok ? ((await response.json()) as RegistryEntry) : null
}


/** Test controls only: how many objects each of the organization's R2 prefixes holds. */
async function objectCounts(env: Env, org: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [bucket, area] of [
    [env.FILES, 'inbox'],
    [env.FILES, 'text'],
    [env.FILES, 'exports'],
    [env.BACKUPS, 'backups'],
  ] as const) {
    let count = 0
    let cursor: string | undefined
    do {
      const listed = await bucket.list({ prefix: `${area}/${org}/`, cursor })
      count += listed.objects.length
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
    out[area] = count
  }
  return out
}
