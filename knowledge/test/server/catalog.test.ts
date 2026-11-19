import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app/server/app.ts'
import { CATALOG_ROUTES } from '../../src/app/server/catalog.ts'
import { createHarness, PEOPLE, type Harness } from '../support/harness.ts'

// GET /api/catalog stays in step with the routes: every route is listed (but the tick's), and every listed route exists.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

describe('the API catalog', () => {
  it('lists every route the app serves, except the platform\'s tick', () => {
    const served = new Set(createApp().routes
      .filter((route) => route.method !== 'ALL' && route.path !== '/api/*' && route.path !== '/api/scheduled')
      .map((route) => `${route.method} ${route.path.replace(/:([A-Za-z]+)/g, '{$1}')}`))
    expect([...served].filter((route) => !CATALOG_ROUTES.includes(route)).sort()).toEqual([])
    expect(CATALOG_ROUTES.filter((route) => !served.has(route)).sort()).toEqual([])
  })

  it('every listed route answers, rather than "no such route"', async () => {
    const id = await h.collection(PEOPLE.maya)
    for (const route of CATALOG_ROUTES) {
      const [method, template] = route.split(' ') as [string, string]
      const path = template.replace('{id}', id).replace('{type}', 'person').replace(/\{[A-Za-z]+\}/g, 'x1234567890')
      const response = await h.call(PEOPLE.maya, method, path, method === 'GET' || method === 'DELETE' ? undefined : {})
      const body = await response.text()
      expect({ route, unknown: body.includes('There is no such API route') }).toEqual({ route, unknown: false })
    }
  })
})
