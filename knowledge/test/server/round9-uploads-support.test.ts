import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, PEOPLE, SUPPORT, type Harness } from '../support/harness.ts'

// The screens' limit messages name Insulin Apps support (design line 497) with the address the server's own limit
// messages use: the deploy's SUGER_SUPPORT_EMAIL, sent with who is calling, never one written in the source.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

describe('Insulin Apps support, for the screens', () => {
  it('/api/me carries the deploy\'s support address, to every role, and null when there is none', async () => {
    for (const person of [PEOPLE.maya, PEOPLE.leo]) {
      const me = await h.json<{ supportEmail: string | null; supportConfigured: boolean }>(person, 'GET', '/api/me')
      expect(me.status).toBe(200)
      // Must catch: the screens can't name the address the 429s name.
      expect(me.body).toMatchObject({ supportEmail: SUPPORT, supportConfigured: true })
    }
    h.env.SUPPORT_EMAIL = '  '
    expect((await h.json<{ supportEmail: string | null }>(PEOPLE.maya, 'GET', '/api/me')).body).toMatchObject({ supportEmail: null, supportConfigured: false })
    h.env.SUPPORT_EMAIL = undefined
    expect((await h.json<{ supportEmail: string | null }>(PEOPLE.maya, 'GET', '/api/me')).body).toMatchObject({ supportEmail: null, supportConfigured: false })
  })
})
