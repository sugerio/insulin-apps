// Runs the bundled gateway in Miniflare with real D1 migrations, a stub app Worker that echoes what it receives, the
// capture mail transport (test mode) or a stub Email Service binding (production mode), and Turnstile and Google
// answered by Miniflare's outbound fetch hook. All data is synthetic.
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { COMPATIBILITY_DATE, bundlePath, gatewayDir } from './bundle.mjs'

export const PASSWORD = 'correct horse battery staple'
/** The id format: random (version 4) UUIDs for users, organizations and invitations. */
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const UUID_RE = new RegExp(`^${UUID}$`)
/** What a browser sends for a top-level navigation (send it with `client.raw`: fetch() would change Sec-Fetch-Mode). */
export const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html,application/xhtml+xml' }

/** A Turnstile token the stubbed siteverify accepts for `action` (each form's widget carries its own action). */
export const turnstile = (action) => `turnstile-ok:${action}`
export const TOKENS = { signup: turnstile('signup'), login: turnstile('login'), resend: turnstile('resend'), forgot: turnstile('forgot') }

/** The stubbed siteverify: a token from `turnstile(action)` succeeds, for the auth host and that action. */
export function siteverify(params, harness) {
  const match = /^turnstile-ok:([a-z]+)$/.exec(params.get('response') ?? '')
  return match ? { success: true, hostname: harness.authHost, action: match[1] } : { success: false, 'error-codes': ['invalid-input-response'] }
}
export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'
export const GOOGLE_CLIENT_SECRET = 'test-google-client-secret'
export const TURNSTILE_SECRET = 'test-turnstile-secret'
export const APPS = [
  { name: 'captable', title: 'Cap Table', summary: 'Equity management for startups.', binding: 'APP_CAPTABLE', source: 'https://github.com/example/insulin-apps/tree/main/captable' },
  { name: 'ledger', title: 'Ledger', summary: 'An app that is not deployed in these tests.', binding: 'APP_LEDGER' },
]

let counter = 0
/** A fresh documentation-range address per client, so rate limits only bite where a test means them to. */
export function uniqueIp() {
  counter += 1
  return `2001:db8::${counter.toString(16)}`
}
export function uniqueEmail(prefix = 'person') {
  counter += 1
  return `${prefix}.${counter}@example.test`
}

export function splitStatements(sql) {
  return sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map((statement) => statement.trim()).filter(Boolean)
}

export async function applyMigrations(db) {
  const dir = join(gatewayDir, 'migrations')
  const files = (await readdir(dir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  for (const file of files) {
    for (const statement of splitStatements(await readFile(join(dir, file), 'utf8'))) await db.prepare(statement).run()
  }
}

/** Enough of RFC 6265, with Chromium's rule that *.localhost counts as secure, to follow a browser's cookies. */
export class CookieJar {
  cookies = []

  store(url, lines) {
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim())
      const at = pair.indexOf('=')
      if (at < 1) continue
      const cookie = { name: pair.slice(0, at), value: pair.slice(at + 1), domain: url.hostname, hostOnly: true, path: '/', secure: false, maxAge: null }
      let rejected = false
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=')
        const value = rest.join('=')
        switch (key.toLowerCase()) {
          case 'domain': {
            const domain = value.replace(/^\./, '').toLowerCase()
            if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) Object.assign(cookie, { domain, hostOnly: false })
            else rejected = true
            break
          }
          case 'path': cookie.path = value || '/'; break
          case 'secure': cookie.secure = true; break
          case 'max-age': cookie.maxAge = Number(value); break
        }
      }
      if (cookie.secure && !secureContext(url)) rejected = true
      if (cookie.name.startsWith('__Host-') && (!cookie.secure || !cookie.hostOnly || cookie.path !== '/')) rejected = true
      if (rejected) continue
      this.cookies = this.cookies.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path))
      if (cookie.maxAge === null || cookie.maxAge > 0) this.cookies.push(cookie)
    }
  }

  header(url) {
    return this.cookies
      .filter((c) => (c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`)))
      .filter((c) => url.pathname.startsWith(c.path))
      .filter((c) => !c.secure || secureContext(url))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  }

  get(name) {
    return this.cookies.find((c) => c.name === name)
  }
}

function secureContext(url) {
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
}

/** Miniflare's outbound fetch hook: answers Turnstile's siteverify and Google's token endpoint, records every call. */
export class Outbound {
  requests = []
  turnstile = siteverify
  google = () => new Response('no Google response configured', { status: 500 })

  constructor(harness) {
    this.harness = harness
  }

  async handle(request) {
    const url = new URL(request.url)
    const params = new URLSearchParams(request.method === 'POST' ? await request.text() : '')
    this.requests.push({ url: url.href, method: request.method, params })
    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const answer = await this.turnstile(params, this.harness)
      return answer instanceof Response ? answer : Response.json(answer)
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const answer = await this.google(params, this.harness)
      return answer instanceof Response ? answer : Response.json(answer)
    }
    return new Response(`unexpected outbound request to ${url.host}`, { status: 599 })
  }

  to(prefix) {
    return this.requests.filter((request) => request.url.startsWith(prefix))
  }
}

/** A browser-like client: one IP, one cookie jar, no automatic redirects. */
export class Client {
  constructor(harness, { ip = uniqueIp() } = {}) {
    this.harness = harness
    this.ip = ip
    this.jar = new CookieJar()
  }

  async request(href, { method = 'GET', headers = {}, body } = {}) {
    const url = new URL(href)
    const cookie = this.jar.header(url)
    const response = await this.harness.mf.dispatchFetch(url.href, {
      method,
      headers: { 'CF-Connecting-IP': this.ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body,
      redirect: 'manual',
    })
    const cookies = response.headers.getSetCookie()
    this.jar.store(url, cookies)
    const text = await response.text()
    return { status: response.status, headers: response.headers, text, cookies, location: response.headers.get('location') }
  }

  get(href, options = {}) {
    return this.request(href, options)
  }

  /**
   * A request with exactly these headers, straight to Miniflare's socket with the target as the Host header, the way a
   * browser reaches `wrangler dev`. fetch() would replace Sec-Fetch-Mode with `cors`, so browser navigations
   * (`Sec-Fetch-Mode: navigate`) and clients without fetch metadata can only be imitated like this. http:// only.
   */
  async raw(href, { method = 'GET', headers = {} } = {}) {
    const url = new URL(href)
    const server = await this.harness.mf.ready
    const cookie = this.jar.header(url)
    return new Promise((accept, reject) => {
      const outgoing = httpRequest({
        host: server.hostname,
        port: server.port,
        method,
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, 'CF-Connecting-IP': this.ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      }, (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => accept({ status: response.statusCode, location: response.headers.location ?? null, headers: response.headers, text }))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
  }

  /** A form POST from the page's own origin, unless `origin` says otherwise (null leaves it out). */
  post(href, fields = {}, { origin = new URL(href).origin, headers = {}, contentType = 'application/x-www-form-urlencoded', body } = {}) {
    return this.request(href, {
      method: 'POST',
      headers: { ...(contentType ? { 'Content-Type': contentType } : {}), ...(origin ? { Origin: origin } : {}), ...headers },
      body: body ?? new URLSearchParams(fields).toString(),
    })
  }
}

export async function startGateway(options = {}) {
  const harness = new Harness(options)
  await harness.start()
  return harness
}

export class Harness {
  logs = []

  constructor({ mode = 'test', vars = {}, omit = [], authLimit = 1000, appLimit = 1000, apps = APPS, scheme } = {}) {
    this.mode = mode
    this.domain = vars.SITE_DOMAIN ?? (mode === 'test' ? 'insulinapps.localhost' : 'example.test')
    this.scheme = scheme ?? (this.domain.endsWith('.localhost') ? 'http:' : 'https:')
    this.omit = new Set(omit)
    this.outbound = new Outbound(this)
    const base = {
      SITE_DOMAIN: this.domain,
      SITE_APPS: JSON.stringify(apps),
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
      EMAIL_FROM: 'Insulin Apps <no-reply@example.test>',
      ...(mode === 'test' ? { SITE_ENV: 'test' } : {}),
    }
    this.vars = Object.fromEntries(Object.entries({ ...base, ...vars }).filter(([, value]) => value !== undefined))
    this.limits = { authLimit, appLimit }
  }

  get authHost() { return `auth.${this.domain}` }

  url(site, path = '/') {
    const host = site === 'apex' ? this.domain : site === 'auth' ? this.authHost : `${site}.${this.domain}`
    return `${this.scheme}//${host}${path}`
  }

  async start() {
    const bundle = await bundlePath()
    const ratelimits = {}
    if (!this.omit.has('RL_AUTH')) ratelimits.RL_AUTH = { namespace_id: '1001', simple: { limit: this.limits.authLimit, period: 60 } }
    if (!this.omit.has('RL_APP')) ratelimits.RL_APP = { namespace_id: '1002', simple: { limit: this.limits.appLimit, period: 60 } }
    const serviceBindings = { APP_CAPTABLE: 'stub-app' }
    if (this.mode === 'production' && !this.omit.has('EMAIL')) serviceBindings.EMAIL = { name: 'mail-stub', entrypoint: 'Mailer' }
    this.mf = new Miniflare(convertV4MiniflareOptions({
      log: new Log(LogLevel.WARN),
      logRequests: false,
      handleStructuredLogs: (entry) => this.logs.push(entry),
      workers: [
        {
          name: 'gateway',
          modules: true,
          // Module names are paths relative to modulesRoot, and workerd refuses names that climb out of it with '..'.
          modulesRoot: dirname(bundle),
          scriptPath: bundle,
          compatibilityDate: COMPATIBILITY_DATE,
          bindings: this.vars,
          ...(this.omit.has('DB') ? {} : { d1Databases: { DB: 'gateway' } }),
          ratelimits,
          serviceBindings,
          outboundService: (request) => this.outbound.handle(request),
          stripCfConnectingIp: false,
        },
        { name: 'stub-app', modules: true, modulesRoot: join(gatewayDir, 'dev'), scriptPath: join(gatewayDir, 'dev', 'stub-app.mjs'), compatibilityDate: COMPATIBILITY_DATE },
        { name: 'mail-stub', modules: true, modulesRoot: join(gatewayDir, 'test', 'helpers'), scriptPath: join(gatewayDir, 'test', 'helpers', 'mail-stub.mjs'), compatibilityDate: COMPATIBILITY_DATE },
      ],
    }))
    await this.mf.ready
    if (!this.omit.has('DB')) {
      this.db = await this.mf.getD1Database('DB')
      await applyMigrations(this.db)
    }
  }

  async close() {
    await this.mf?.dispose()
  }

  client(options) {
    return new Client(this, options)
  }

  async sql(query, ...params) {
    const { results } = await this.db.prepare(query).bind(...params).all()
    return results
  }

  /** Mail sent to an address, oldest first: the capture table in test mode, the stub binding in production mode. */
  async mails(to) {
    if (this.mode === 'test') {
      const rows = await this.sql('SELECT recipient, subject, body_text, body_html FROM mail_capture WHERE recipient = ?1 ORDER BY id', to)
      return rows.map((row) => ({ to: row.recipient, subject: row.subject, text: row.body_text, html: row.body_html }))
    }
    return (await this.sentMail()).filter((mail) => mail.to === to)
  }

  async sentMail() {
    const stub = await this.mf.getWorker('mail-stub')
    return (await stub.fetch('http://mail-stub/sent')).json()
  }

  async failMail(code) {
    const stub = await this.mf.getWorker('mail-stub')
    await stub.fetch(`http://mail-stub/fail?code=${encodeURIComponent(code ?? '')}`)
  }

  /** Waits for the count-th e-mail to an address (some are sent after the response, with waitUntil). */
  async waitForMail(to, count = 1) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const mails = await this.mails(to)
      if (mails.length >= count) return mails
      await new Promise((accept) => setTimeout(accept, 30))
    }
    assert.fail(`expected ${count} email(s) to ${to}`)
  }

  /** The link to `path` in the newest e-mail to `to` that has one. */
  async link(to, path, count = 1) {
    const mails = await this.waitForMail(to, count)
    for (const mail of [...mails].reverse()) {
      const found = (mail.text.match(/https?:\/\/\S+/g) ?? []).find((href) => new URL(href).pathname.startsWith(path))
      if (found) return found
    }
    assert.fail(`no ${path} link in mail to ${to}`)
  }

  signUp(client, { name = 'Test Person', email, password = PASSWORD, returnTo, turnstile = TOKENS.signup } = {}) {
    const fields = { name, email, password, 'cf-turnstile-response': turnstile }
    if (returnTo) fields.return_to = returnTo
    return client.post(this.url('auth', '/signup'), fields)
  }

  signIn(client, { email, password = PASSWORD, returnTo, turnstile = TOKENS.login } = {}) {
    const fields = { email, password, 'cf-turnstile-response': turnstile }
    if (returnTo) fields.return_to = returnTo
    return client.post(this.url('auth', '/login'), fields)
  }

  /** Opens the newest confirmation link the address received and confirms it. */
  async confirm(client, email, count = 1) {
    const link = await this.link(email, '/verify-email', count)
    const token = new URL(link).searchParams.get('token')
    return client.post(this.url('auth', '/verify-email'), { token })
  }

  /** A signed-in, confirmed user with their own client. */
  async user({ name = 'Test Person', email = uniqueEmail(), ip } = {}) {
    const client = this.client({ ip })
    const signup = await this.signUp(client, { name, email })
    assert.equal(signup.status, 200, signup.text)
    const confirmed = await this.confirm(client, email)
    assert.ok([200, 303].includes(confirmed.status), `confirm: ${confirmed.status}`)
    const [row] = await this.sql('SELECT id FROM users WHERE email = ?1', email)
    return { client, email, name, id: row.id }
  }

  /** Creates an organization as `client`; returns its id. */
  async org(client, name = 'Example Org') {
    const response = await client.post(this.url('auth', '/orgs/new'), { name })
    assert.equal(response.status, 303, response.text)
    return new RegExp(`/orgs/(${UUID})`).exec(response.location)[1]
  }

  /** Invites `email` to `orgId` as `role` and accepts as `invitee` (a user from `user()` with that address). */
  async join(owner, orgId, invitee, role) {
    const invited = await owner.client.post(this.url('auth', `/orgs/${orgId}/invitations`), { email: invitee.email, role })
    assert.equal(invited.status, 303, invited.text)
    const link = await this.link(invitee.email, '/invitations/')
    const accepted = await invitee.client.post(`${link}/accept`, {})
    assert.ok([200, 303].includes(accepted.status), `accept: ${accepted.status} ${accepted.text.slice(0, 300)}`)
  }

  logText() {
    return this.logs.map((entry) => entry.message).join('\n')
  }
}
