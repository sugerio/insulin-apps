// The Engine-lane harness Worker: the one public door to a throwaway engine (insulin-apps-knowledge-engine-e2e-<run>),
// which, like the real one, has no address of its own. It checks a bearer token and passes /v1/* requests to the
// engine over a service binding, the way the Knowledge app does. Deployed only for a harness run, deleted after it.

interface HarnessEnv {
  ENGINE: Fetcher
  HARNESS_TOKEN: string
}

function sameToken(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!sameToken(token, env.HARNESS_TOKEN ?? '')) {
      return Response.json({ error: 'unauthorized', message: 'A harness token is required.' }, { status: 401 })
    }
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/v1/')) return Response.json({ error: 'not_found', message: 'Only /v1/ is passed on.' }, { status: 404 })
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    return env.ENGINE.fetch(new Request(`https://engine.internal${url.pathname}${url.search}`, { method: request.method, headers, body: request.body }))
  },
} satisfies ExportedHandler<HarnessEnv>
