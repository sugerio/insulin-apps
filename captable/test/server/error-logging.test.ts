import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app/server/app.ts'
import { consoleHeaders } from '../support/server-harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.SUGER_ACCESS_MODE
})

describe('internal error logging', () => {
  it('logs the stack before the generic API error is returned', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const database = {
      prepare() { throw new Error('synthetic database failure') },
    } as unknown as D1Database
    const response = await createApp({ enforceSameOrigin: true }).fetch(
      new Request('http://app.test/api/me', { headers: consoleHeaders() }),
      { DB: database },
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'internal', message: 'Something went wrong' } })
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"event":"unhandled_error"'))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('synthetic database failure'))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('error-logging.test.ts'))
  })
})
