import { describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { expectedRouteStatus, isExpectedRouteStatus, retainedRouteIdentity } from './route-status.ts'

describe('route status metadata', () => {
  it.each(api.ROUTE_TABLE)('$id declares a coherent success and error status set', (route) => {
    expect(expectedRouteStatus(route)).toBe(route.response.status)
    expect(isExpectedRouteStatus(route, route.response.status)).toBe(true)
    for (const code of route.errors) expect(isExpectedRouteStatus(route, api.API_ERROR_STATUS[code])).toBe(true)
    expect(retainedRouteIdentity(route)).toBe(`${route.method} ${route.path} (${route.id})`)
  })
})
