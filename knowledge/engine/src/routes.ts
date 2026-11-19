// The engine's route table: every route of the contract (BUILD.md, "The engine contract"), in one place, so the
// Worker's router and the collection's Durable Object match requests the same way and a test can hold it against
// the contract.

export type RouteScope = 'collection' | 'service' | 'org'

export interface Route {
  name: string
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'
  path: string // with :params
  scope: RouteScope
  orgHeader: boolean // the request must name its organization
}

export const ROUTES: Route[] = [
  { name: 'putCollection', method: 'PUT', path: '/v1/collections/:cid', scope: 'collection', orgHeader: true },
  { name: 'getCollection', method: 'GET', path: '/v1/collections/:cid', scope: 'collection', orgHeader: true },
  { name: 'wake', method: 'POST', path: '/v1/collections/:cid/wake', scope: 'collection', orgHeader: true },
  { name: 'stageFile', method: 'PUT', path: '/v1/collections/:cid/inbox/:fileId', scope: 'collection', orgHeader: true },
  { name: 'keepStaged', method: 'POST', path: '/v1/collections/:cid/inbox/keep', scope: 'collection', orgHeader: true },
  { name: 'startImport', method: 'POST', path: '/v1/collections/:cid/imports', scope: 'collection', orgHeader: true },
  { name: 'getImport', method: 'GET', path: '/v1/collections/:cid/imports/:importId', scope: 'collection', orgHeader: true },
  { name: 'cancelImport', method: 'DELETE', path: '/v1/collections/:cid/imports/:importId', scope: 'collection', orgHeader: true },
  { name: 'search', method: 'POST', path: '/v1/collections/:cid/search', scope: 'collection', orgHeader: true },
  { name: 'answer', method: 'POST', path: '/v1/answer', scope: 'service', orgHeader: true },
  { name: 'listDocuments', method: 'GET', path: '/v1/collections/:cid/documents', scope: 'collection', orgHeader: true },
  { name: 'getDocument', method: 'GET', path: '/v1/collections/:cid/documents/:docId', scope: 'collection', orgHeader: true },
  { name: 'setDocumentActive', method: 'PATCH', path: '/v1/collections/:cid/documents/:docId', scope: 'collection', orgHeader: true },
  { name: 'removeDocument', method: 'DELETE', path: '/v1/collections/:cid/documents/:docId', scope: 'collection', orgHeader: true },
  { name: 'listFacts', method: 'GET', path: '/v1/collections/:cid/facts', scope: 'collection', orgHeader: true },
  { name: 'correct', method: 'POST', path: '/v1/collections/:cid/corrections', scope: 'collection', orgHeader: true },
  { name: 'listRestorePoints', method: 'GET', path: '/v1/collections/:cid/restore-points', scope: 'collection', orgHeader: true },
  { name: 'previewGoBack', method: 'GET', path: '/v1/collections/:cid/restore-points/:version/preview', scope: 'collection', orgHeader: true },
  { name: 'goBack', method: 'POST', path: '/v1/collections/:cid/restore-points/:version/go-back', scope: 'collection', orgHeader: true },
  { name: 'undo', method: 'POST', path: '/v1/collections/:cid/undo', scope: 'collection', orgHeader: true },
  { name: 'startExport', method: 'POST', path: '/v1/collections/:cid/exports', scope: 'collection', orgHeader: true },
  { name: 'importExport', method: 'POST', path: '/v1/collections/:cid/import-export', scope: 'collection', orgHeader: true },
  { name: 'getExport', method: 'GET', path: '/v1/collections/:cid/exports/:exportId', scope: 'collection', orgHeader: true },
  { name: 'deleteCollection', method: 'DELETE', path: '/v1/collections/:cid', scope: 'collection', orgHeader: true },
  { name: 'purgeOrg', method: 'POST', path: '/v1/orgs/:org/purge', scope: 'org', orgHeader: true },
  { name: 'holdOrg', method: 'POST', path: '/v1/orgs/:org/hold', scope: 'org', orgHeader: true },
  // Service-wide: the app's tick pulls every organization's events, and health counts every collection.
  { name: 'outbox', method: 'GET', path: '/v1/outbox', scope: 'service', orgHeader: false },
  { name: 'health', method: 'GET', path: '/v1/health', scope: 'service', orgHeader: false },
]

// Test controls for the Engine-lane harness. They exist only when the deployment sets ENGINE_TEST_CONTROLS=1,
// which the throwaway e2e engine does and production never does.
export const TEST_ROUTES: Route[] = [
  { name: 'testControl', method: 'POST', path: '/v1/collections/:cid/__test/:action', scope: 'collection', orgHeader: true },
  { name: 'testState', method: 'GET', path: '/v1/collections/:cid/__test/state', scope: 'collection', orgHeader: true },
  // What R2 still holds for the organization: DEL-01, DEL-05 and HID-03 check prefixes are empty.
  { name: 'testObjects', method: 'GET', path: '/v1/__test/objects', scope: 'service', orgHeader: true },
]

export interface Match {
  route: Route
  params: Record<string, string>
}

export function matchRoute(method: string, pathname: string, routes: Route[] = ROUTES): Match | 'method_not_allowed' | null {
  const parts = pathname.split('/').filter(Boolean)
  let pathMatched = false
  for (const route of routes) {
    const pattern = route.path.split('/').filter(Boolean)
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) {
        let value: string
        try {
          value = decodeURIComponent(parts[i])
        } catch {
          ok = false
          break
        }
        params[pattern[i].slice(1)] = value
      } else if (pattern[i] !== parts[i]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    pathMatched = true
    if (route.method === method) return { route, params }
  }
  return pathMatched ? 'method_not_allowed' : null
}
