import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError, readJson } from '../../src/app/server/lib/http.ts'

function appFor(maxBytes: number) {
  const app = new Hono()
  app.post('/body', async (c) => c.json(await readJson(c, z.strictObject({ value: z.string() }), maxBytes)))
  app.onError((error) => error instanceof ApiError ? error.toResponse() : Response.json({}, { status: 500 }))
  return app
}

describe('JSON transport', () => {
  it('returns payload_too_large with 413', async () => {
    const response = await appFor(8).request('/body', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'too long' }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'payload_too_large' } })
  })

  it('separates invalid JSON, media types, and schema failures', async () => {
    const app = appFor(100)
    const invalid = await app.request('/body', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json',
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'validation_failed' } })
    expect((await app.request('/body', { method: 'POST', body: '{}' })).status).toBe(400)
    const schema = await app.request('/body', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(await schema.json()).toMatchObject({ error: { issues: [{ path: 'value' }] } })
  })
})
