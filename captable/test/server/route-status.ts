import { api } from '../../src/app/shared/index.ts'

export function expectedRouteStatus(route: api.AnyRoute): number {
  return route.response.status
}

export function isExpectedRouteStatus(route: api.AnyRoute, status: number): boolean {
  if (status === route.response.status) return true
  return route.errors.some((code) => api.API_ERROR_STATUS[code] === status)
}

export function retainedRouteIdentity(route: api.AnyRoute): string {
  return `${route.method} ${route.path} (${route.id})`
}
