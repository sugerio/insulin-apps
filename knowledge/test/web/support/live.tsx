import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'
import { KnowledgeApp } from '../../../src/app/App.tsx'
import { createApp } from '../../../src/app/server/app.ts'
import { createHarness, headersOf, type Harness, type Person } from '../../support/harness.ts'

// The screens against the real API and the in-memory engine: the server tests' harness (test/support/harness.ts) plays
// the platform, and the page's fetch goes to Knowledge's Hono app with the person's identity headers, as the gateway
// adds them. Nothing is mocked between the screens and the server.

export interface Live {
  h: Harness
  /** Whom the page's requests are from; a test can switch person between renders. */
  as: (person: Person) => void
  /** Every request the page made, as `METHOD /path`. */
  requests: string[]
}

export async function liveApi(person: Person): Promise<Live> {
  const h = await createHarness()
  const app = createApp({ enforceSameOrigin: false })
  let current = person
  const requests: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, 'https://knowledge.insulinapps.test')
    const method = (init.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${url.pathname}`)
    // The platform's account bar endpoints aren't served here: the shell then shows Knowledge on its own.
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    const headers = new Headers(init.headers)
    for (const [name, value] of Object.entries(headersOf(current))) headers.set(name, value)
    let body = init.body ?? undefined
    // jsdom's Blob isn't Node's: send its bytes.
    if (body && typeof body === 'object' && 'arrayBuffer' in body && !(body instanceof ArrayBuffer)) body = new Uint8Array(await (body as Blob).arrayBuffer())
    const response = await app.fetch(new Request(`https://knowledge.insulinapps.test${url.pathname}${url.search}`, { method, headers, body: body as BodyInit | undefined }), h.env)
    h.engine.control.runUntilIdle()
    return response
  })
  return { h, as: (next) => { current = next }, requests }
}

export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <KnowledgeApp />
    </MemoryRouter>,
  )
}
