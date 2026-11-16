// A stand-in app Worker for the gateway's tests and local development (`npm run dev`). It echoes what the gateway
// forwarded: method, URL, headers (the x-suger-* identity headers among them) and cookies. Synthetic data only.
// Named exports of a Worker module are entrypoints, so helpers and constants here stay unexported.

const CAP_TABLE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'"

// Every request that came as the gateway's tick (x-suger-access-via: schedule), oldest first, whatever its path. The
// tests read them at /__stub/ticks, straight from this Worker.
const ticks = []

// The settings this stand-in keeps per OAuth client (insulin.clientSettings, DESIGN.md §5.3.1), and every request the
// gateway made for them, oldest first; the tests read the requests at /__stub/client-settings.
const clientSettings = new Map()
const clientSettingsRequests = []

/** The stand-in's section for one client: who sees what it creates, at most two people (more is refused, for the tests). */
async function answerClientSettings(request, url) {
  const id = decodeURIComponent(url.pathname.slice('/api/client-settings/'.length))
  const body = request.method === 'POST' ? await request.json() : null
  clientSettingsRequests.push({ ...received(request), path: url.pathname, query: url.search, body })
  if (request.method === 'DELETE') { clientSettings.delete(id); return new Response(null, { status: 204 }) }
  if (request.method === 'POST') {
    const people = Array.isArray(body?.values?.people) ? body.values.people : []
    if (people.length > 2) return Response.json({ errors: { people: 'Pick at most two people.' }, message: 'Nothing was saved.' }, { status: 422 })
    clientSettings.set(id, people)
    return Response.json({ notice: `Saved: ${people.length} people see what it creates.` })
  }
  const people = clientSettings.get(id) ?? []
  return Response.json({
    title: 'Who sees what it creates',
    description: 'They see and manage everything this client creates.',
    status: people.length ? `Seen by ${people.length} people` : 'Seen by the client only',
    fields: [{ name: 'people', type: 'members', label: 'Share with', value: people }],
  })
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function received(request) {
  return {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    cookie: request.headers.get('cookie'),
  }
}

async function digest(stream) {
  const reader = stream.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    chunks.push(value)
  }
  const all = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all))
  return { bytes, sha256: [...hash].map((b) => b.toString(16).padStart(2, '0')).join('') }
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get('x-suger-access-via') === 'schedule') {
      ticks.push({ ...received(request), path: url.pathname, body: await request.text() })
    }
    if (url.pathname.startsWith('/api/client-settings/')) return answerClientSettings(request, url)
    // An app whose section isn't what the contract agreed: the gateway shows that it couldn't be loaded.
    if (url.pathname.startsWith('/api/client-settings-broken/')) return Response.json({ title: 'Broken', fields: [{ name: 'people', type: 'html', label: '<b>x</b>' }] })
    switch (url.pathname) {
      case '/api/scheduled':
        return Response.json({ ran: true })
      case '/api/scheduled-fails':
        // An app whose due work failed.
        return Response.json({ error: 'failed' }, { status: 500 })
      case '/api/scheduled-throws':
        // An app that crashes outright.
        throw new Error('synthetic failure')
      case '/__stub/client-settings':
        return Response.json(clientSettingsRequests)
      case '/__stub/ticks':
        return Response.json(ticks)
      case '/api/echo':
      case '/api/public/echo':
        return Response.json(received(request))
      case '/sign':
        // A public page (an Esign recipient's), framed by a host product: the app's own frame-ancestors must survive.
        return new Response(`<!doctype html><html lang="en"><head><title>Sign</title></head><body><pre>${escapeHtml(JSON.stringify(received(request)))}</pre></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors https://host.example.test" },
        })
      case '/api/echo-body':
        return Response.json({ ...received(request), body: await request.text() })
      case '/api/catalog':
        // What an app's catalog looks like (Cap Table's GET /api/catalog), for the MCP server's endpoints tool.
        return Response.json({ endpoints: [{ method: 'GET', path: '/api/echo', summary: 'Echo the request', query: null, body: null, idempotencyKey: false }] })
      case '/api/large':
        return new Response('x'.repeat(300 * 1024), { headers: { 'Content-Type': 'text/plain' } })
      case '/api/__suger/health':
        return Response.json({ platform: true })
      case '/upload':
        return Response.json({ ...received(request), body: request.body ? await digest(request.body) : null })
      case '/style.css':
        return new Response('body { color: rebeccapurple; }\n', { headers: { 'Content-Type': 'text/css' } })
      case '/data.json':
        return Response.json({ html: '<body>not a page</body>' })
      case '/no-body':
        return new Response('<!doctype html><title>No body element</title><p>text</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      case '/redirect':
        return new Response(null, { status: 302, headers: { Location: '/elsewhere' } })
      case '/csp':
        // Cap Table's policy (brief 3.5): the account bar must work under it.
        return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stub app under a strict CSP</title></head><body><h1>Strict CSP page</h1></body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CAP_TABLE_CSP },
        })
      case '/own-hsts':
        return new Response('ok', { headers: { 'Strict-Transport-Security': 'max-age=60' } })
      case '/set-cookies': {
        const headers = new Headers({ 'Content-Type': 'text/plain' })
        headers.append('Set-Cookie', 'insulin_session=app-tried-this; Domain=example.test; Path=/; HttpOnly')
        headers.append('Set-Cookie', 'INSULIN_SESSION=upper-case; Path=/')
        headers.append('Set-Cookie', 'app_pref=dark; Path=/; SameSite=Lax')
        return new Response('cookies', { headers })
      }
      default: {
        const echo = JSON.stringify(received(request), null, 2)
        return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stub app</title></head>
<body>
<h1>Stub app</h1>
<p>What the gateway forwarded:</p>
<pre id="echo">${escapeHtml(echo)}</pre>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
    }
  },
}
