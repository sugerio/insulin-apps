// The platform's five-minute tick to apps that declare `insulin.scheduled` (DESIGN.md §8.5), and the stricter per-IP
// limit on requests to public paths that change something (RL_PUBLIC, DESIGN.md §8.1).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, startGateway } from './helpers/harness.mjs'
import { form } from './helpers/oauth.mjs'

const CAPTABLE = APPS.find((app) => app.name === 'captable')
// The failing apps come first: the tick must reach the apps after them all the same.
const SCHEDULED_APPS = [
  { name: 'crashes', title: 'Crashes', summary: 'Throws on its tick.', binding: 'APP_CRASHES', scheduled: '/api/scheduled-throws' },
  { name: 'fails', title: 'Fails', summary: 'Answers 500 to its tick.', binding: 'APP_FAILS', scheduled: '/api/scheduled-fails' },
  { ...CAPTABLE, scheduled: '/api/scheduled', publicPaths: ['/sign', '/api/public/'] },
  { name: 'quiet', title: 'Quiet', summary: 'Deployed, with no scheduled path.', binding: 'APP_QUIET' },
  { name: 'ledger', title: 'Ledger', summary: 'Declares one, but is not deployed.', binding: 'APP_LEDGER', scheduled: '/api/scheduled' },
  { name: 'later', title: 'Later', summary: 'Listed after the failing ones.', binding: 'APP_LATER', scheduled: '/api/scheduled' },
]
const TICK = '*/5 * * * *'

let h
before(async () => {
  h = await startGateway({ apps: SCHEDULED_APPS, stubBindings: ['APP_CRASHES', 'APP_FAILS', 'APP_QUIET', 'APP_LATER'] })
})
after(async () => { await h?.close() })

/** Fires the gateway's cron trigger and waits until the stub app has `count` ticks in all. */
async function tick(cron, count) {
  const result = await (await h.mf.getWorker('gateway')).scheduled({ cron })
  assert.equal(result.outcome, 'ok')
  let ticks = []
  for (let attempt = 0; attempt < 200; attempt += 1) {
    ticks = await h.ticks()
    if (ticks.length >= count) break
    await new Promise((accept) => setTimeout(accept, 25))
  }
  return ticks
}

/** The gateway's `app_scheduled` log lines, oldest first. */
function scheduledLogs() {
  return h.logs.map((entry) => { try { return JSON.parse(entry.message) } catch { return null } }).filter((line) => line?.event === 'app_scheduled')
}

async function waitForLogs(count) {
  for (let attempt = 0; attempt < 200 && scheduledLogs().length < count; attempt += 1) await new Promise((accept) => setTimeout(accept, 25))
  return scheduledLogs()
}

test('the tick POSTs to each declared path with only the app id and x-suger-access-via: schedule, and skips the others', async () => {
  const start = (await h.ticks()).length
  const ticks = (await tick(TICK, start + 4)).slice(start)
  assert.equal(ticks.length, 4, 'crashes, fails, captable and later; never quiet (no path) or ledger (no binding)')
  const byApp = Object.fromEntries(ticks.map((received) => [received.headers['x-suger-app-id'], received]))
  assert.deepEqual(Object.keys(byApp).sort(), ['insulin-apps-captable', 'insulin-apps-crashes', 'insulin-apps-fails', 'insulin-apps-later'])

  const captable = byApp['insulin-apps-captable']
  assert.equal(captable.method, 'POST')
  assert.equal(captable.url, 'http://captable.insulinapps.localhost/api/scheduled', "the app's own host and its declared path")
  assert.equal(captable.body, '', 'an empty body')
  assert.equal(byApp['insulin-apps-fails'].path, '/api/scheduled-fails')
  for (const received of ticks) {
    const suger = Object.keys(received.headers).filter((name) => name.startsWith('x-suger-')).sort()
    assert.deepEqual(suger, ['x-suger-access-via', 'x-suger-app-id'], 'no user, organization, role or permissions')
    assert.equal(received.headers['x-suger-access-via'], 'schedule')
    for (const name of ['authorization', 'cookie', 'origin', 'user-agent']) assert.equal(received.headers[name], undefined, name)
    const others = Object.keys(received.headers).filter((name) => !name.startsWith('x-suger-') && name !== 'content-length')
    assert.deepEqual(others, [], 'nothing else but the length of the empty body')
  }
})

test("a failing app never stops another's tick; the log names each app and its status, nothing else", async () => {
  const start = (await h.ticks()).length
  const logged = scheduledLogs().length
  const ticks = (await tick(TICK, start + 4)).slice(start)
  const reached = ticks.map((received) => received.headers['x-suger-app-id'])
  assert.ok(reached.includes('insulin-apps-captable') && reached.includes('insulin-apps-later'), 'the apps after the failing ones were ticked')

  const lines = (await waitForLogs(logged + 4)).slice(logged)
  const status = Object.fromEntries(lines.map((line) => [line.app, line.status]))
  assert.equal(status.captable, 200)
  assert.equal(status.later, 200)
  assert.equal(status.fails, 500)
  assert.ok(status.crashes === 500 || status.crashes === 'unreachable', `crashes: ${status.crashes}`)
  for (const line of lines) assert.deepEqual(Object.keys(line).sort(), ['app', 'event', 'status'])
  assert.equal(status.quiet, undefined)
  assert.equal(status.ledger, undefined)
})

test('the daily cron runs the cleanup only; the five-minute one ticks the apps', async () => {
  const start = (await h.ticks()).length
  const daily = await (await h.mf.getWorker('gateway')).scheduled({ cron: '17 3 * * *' })
  assert.equal(daily.outcome, 'ok')
  const ticks = await tick(TICK, start + 4)
  await new Promise((accept) => setTimeout(accept, 100))
  assert.equal((await h.ticks()).length, start + 4, 'one round of ticks, from the five-minute trigger alone')
  assert.equal(ticks.length, start + 4)
})

/** Creates a service account (an OAuth client) on the API access page and returns a token for it. */
async function serviceToken(owner, orgId) {
  const created = await owner.client.post(h.url('apex', '/apps/captable/settings/api/clients'), { org_id: orgId, name: 'Nightly job', role: 'ADMIN' })
  assert.equal(created.status, 200, created.text.slice(0, 300))
  const clientId = /(ia_sa_[A-Za-z0-9_-]{22})/.exec(created.text)[1]
  const secret = /(ia_sk_[A-Za-z0-9_-]{43})/.exec(created.text)[1]
  const token = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'client_credentials' }, {
    Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
  })
  assert.equal(token.status, 200, token.text)
  return token.json.access_token
}

test('nobody outside can forge the tick: x-suger-access-via: schedule from a browser or a token never reaches the app as such', async () => {
  const start = (await h.ticks()).length

  const anonymous = await h.client().request(h.url('captable', '/api/scheduled'), { method: 'POST', headers: { 'X-Suger-Access-Via': 'schedule', 'x-suger-app-id': 'insulin-apps-captable' } })
  assert.equal(anonymous.status, 401, 'without a session it goes nowhere')

  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Forged Tick Org')
  const asMember = await owner.client.request(h.url('captable', '/api/scheduled'), { method: 'POST', headers: { 'x-suger-access-via': 'schedule' } })
  assert.equal(asMember.status, 200)
  const echoed = JSON.parse((await owner.client.get(h.url('captable', '/api/echo'), { headers: { 'x-suger-access-via': 'schedule' } })).text)
  assert.equal(echoed.headers['x-suger-access-via'], 'browser', 'a person in the browser stays a person in the browser')
  assert.equal(echoed.headers['x-suger-user-id'], owner.id)

  const publicEcho = JSON.parse((await h.client().request(h.url('captable', '/api/public/echo'), { method: 'POST', headers: { 'x-suger-access-via': 'schedule' } })).text)
  assert.equal(publicEcho.headers['x-suger-access-via'], 'public', 'a public path stays public')

  const token = await serviceToken(owner, orgId)
  const viaToken = await h.client().request(h.url('captable', '/api/scheduled'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-suger-access-via': 'schedule' } })
  assert.equal(viaToken.status, 200)
  const apiEcho = JSON.parse((await h.client().get(h.url('captable', '/api/echo'), { headers: { Authorization: `Bearer ${token}`, 'x-suger-access-via': 'schedule' } })).text)
  assert.equal(apiEcho.headers['x-suger-access-via'], 'api', 'a service account stays a service account')

  assert.equal((await h.ticks()).length, start, 'the app never saw a request marked schedule')
})

test('RL_PUBLIC: public requests that change something are limited per app and IP, while reading goes on', async () => {
  const apps = [
    { ...CAPTABLE, publicPaths: ['/sign', '/api/public/'] },
    { name: 'later', title: 'Later', binding: 'APP_LATER', publicPaths: ['/api/public/'] },
  ]
  const limited = await startGateway({ apps, stubBindings: ['APP_LATER'], publicLimit: 2 })
  try {
    const client = limited.client()
    // No body: a request refused before its body is read can reset the connection to workerd, which made this flaky.
    const post = (app = 'captable', who = client) => who.request(limited.url(app, '/api/public/echo'), { method: 'POST' })
    assert.equal((await post()).status, 200)
    assert.equal((await post()).status, 200)
    const over = await post()
    assert.equal(over.status, 429)
    assert.deepEqual(JSON.parse(over.text), { error: 'rate_limited' })
    assert.equal(over.headers.get('retry-after'), '60')
    assert.equal((await client.request(limited.url('captable', '/api/public/echo'), { method: 'PUT' })).status, 429, 'any method but GET and HEAD')
    assert.equal((await client.get(limited.url('captable', '/api/public/echo'))).status, 200, 'GET keeps working')
    assert.equal((await client.request(limited.url('captable', '/sign'), { method: 'HEAD' })).status, 200, 'and HEAD')
    assert.equal((await post('later')).status, 200, 'another app has its own allowance')
    assert.equal((await post('captable', limited.client())).status, 200, 'another address has its own allowance')
    assert.match(limited.logText(), /"event":"rate_limited","action":"public_post","app":"captable"/)
  } finally {
    await limited.close()
  }
})
