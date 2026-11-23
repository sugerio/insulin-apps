import { describe, expect, it } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { PERMISSIONS, rolePermissions } from '../../src/app/server/identity.ts'

// package.json's `insulin` block: what the platform reads to host Knowledge (DESIGN.md §2.3, §3.2, §8).

describe('the insulin manifest', () => {
  const insulin = packageJson.insulin

  it('navigates as design section 07 shows: Home, Collections, Needs attention, then Rules and data and Health for admins', () => {
    expect(insulin.navigation.map(({ key, label, path, group, role }) => ({ key, label, path, group, role }))).toEqual([
      { key: 'home', label: 'Home', path: '/', group: undefined, role: undefined },
      { key: 'collections', label: 'Collections', path: '/collections', group: undefined, role: undefined },
      { key: 'attention', label: 'Needs attention', path: '/attention', group: undefined, role: 'EDITOR' },
      { key: 'rules', label: 'Rules and data', path: '/rules', group: 'Admin', role: 'ADMIN' },
      { key: 'health', label: 'Health', path: '/health', group: 'Admin', role: 'ADMIN' },
    ])
  })

  it('declares the permission catalog the server checks, each at its least role', () => {
    expect(insulin.permissions.map((permission) => permission.key)).toEqual([...PERMISSIONS])
    for (const permission of insulin.permissions) {
      const role = permission.role as 'ADMIN' | 'EDITOR' | 'VIEWER'
      expect(rolePermissions(role)).toContain(permission.key)
      if (role !== 'VIEWER') expect(rolePermissions(role === 'ADMIN' ? 'EDITOR' : 'VIEWER')).not.toContain(permission.key)
      // The app's SITE_APP_KNOWLEDGE variable carries the catalog and is limited to 5 KB: keep the words short.
      expect(permission.label.length).toBeLessThanOrEqual(20)
      expect(permission.description.length).toBeLessThanOrEqual(90)
    }
    expect(packageJson.description.length).toBeLessThanOrEqual(125)
  })

  it('declares the tick, the engine and its API version', () => {
    expect(insulin.scheduled).toBe('/api/scheduled')
    expect(insulin.engine).toBe('engine/')
    expect(insulin.engineApi).toBe(2)
    expect((insulin as Record<string, unknown>).publicPaths).toBeUndefined()
  })
})
