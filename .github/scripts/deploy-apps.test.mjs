import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  appToken,
  assertNoSiteEnvSecret,
  buildAppConfig,
  buildGatewayConfig,
  deployApps,
  emailAddress,
  gatewayUrls,
  parseArguments,
  ensureBucket,
  productionVariable,
  readSettings,
  registryCredential,
  registryDigest,
  removeAppPublicAccess,
  sanitizeAppBaseConfig,
  verifyBuildOutput,
} from './deploy-apps.mjs'
import { engineImageTag } from './engine.mjs'
import { listApps } from './list-apps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'apps')
const engineFixture = join(here, 'fixtures', 'engine')
const temporary = []

after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

async function tempDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

async function fixtureRepository() {
  const root = await tempDirectory('deploy-apps-repo-')
  for (const name of ['alpha-app', 'beta']) {
    await cp(join(fixtures, name), join(root, name), { recursive: true })
    const output = join(root, name, '.output')
    await mkdir(join(output, 'server'), { recursive: true })
    await mkdir(join(output, 'public'), { recursive: true })
    await writeFile(join(output, 'server', 'index.mjs'), 'export default {}\n')
    await writeFile(
      join(output, 'server', 'wrangler.json'),
      JSON.stringify({
        compatibility_date: '2026-09-25',
        compatibility_flags: ['nodejs_compat'],
        rules: [{ type: 'ESModule', globs: ['**/*.mjs'], fallthrough: true }],
        no_bundle: true,
        assets: { binding: 'ASSETS', html_handling: 'none', directory: '/untrusted' },
        build: { command: 'untrusted command' },
        unsafe: { bindings: [] },
        vars: { GENERATED: 'kept' },
        routes: ['must-be-removed.example'],
      }),
    )
  }
  return root
}

function settings(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: 'dummy-api-token-value',
    CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
    SITE_DOMAIN: 'apps.example.com',
    GOOGLE_CLIENT_ID: 'dummy-google-client',
    GOOGLE_CLIENT_SECRET: 'dummy-google-secret-value',
    TURNSTILE_SITE_KEY: 'dummy-turnstile-site',
    TURNSTILE_SECRET_KEY: 'dummy-turnstile-secret-value',
    EMAIL_FROM: 'Example Sender <sender@example.com>',
    ...overrides,
  }
}

function cloudflareMock({ domains = [], routes = [], subdomain = { enabled: false, previews_enabled: false }, fail } = {}) {
  const state = {
    domains: structuredClone(domains),
    routes: structuredClone(routes),
    subdomain: structuredClone(subdomain),
    requests: [],
  }
  return {
    state,
    fetch: async (input, init = {}) => {
      const url = new URL(input)
      const method = init.method ?? 'GET'
      state.requests.push({ url, method, headers: new Headers(init.headers), body: init.body })
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer dummy-api-token-value')
      assert.ok(!input.includes('dummy-api-token-value'))
      if (fail?.(url, method)) return response({ success: false, errors: [{ code: 1000, message: 'fixture failure' }], result: null }, 403)

      if (method === 'GET' && url.pathname === '/client/v4/zones') {
        return response({ success: true, errors: [], result: [{ id: 'zone-id', name: 'apps.example.com' }], result_info: { total_pages: 1 } })
      }
      if (method === 'GET' && url.pathname === '/client/v4/accounts/dummy-account/workers/domains') {
        return response({ success: true, errors: [], result: structuredClone(state.domains), result_info: { total_pages: 1 } })
      }
      const domainDelete = url.pathname.match(/^\/client\/v4\/accounts\/dummy-account\/workers\/domains\/([^/]+)$/)
      if (method === 'DELETE' && domainDelete) {
        state.domains = state.domains.filter(({ id }) => id !== decodeURIComponent(domainDelete[1]))
        return response({ success: true, errors: [], result: null })
      }
      if (method === 'GET' && url.pathname === '/client/v4/zones/zone-id/workers/routes') {
        return response({ success: true, errors: [], result: structuredClone(state.routes), result_info: { total_pages: 1 } })
      }
      const routeDelete = url.pathname.match(/^\/client\/v4\/zones\/zone-id\/workers\/routes\/([^/]+)$/)
      if (method === 'DELETE' && routeDelete) {
        state.routes = state.routes.filter(({ id }) => id !== decodeURIComponent(routeDelete[1]))
        return response({ success: true, errors: [], result: null })
      }
      if (/^\/client\/v4\/accounts\/dummy-account\/workers\/scripts\/insulin-apps-[a-z-]+\/subdomain$/.test(url.pathname)) {
        if (method === 'GET') return response({ success: true, errors: [], result: structuredClone(state.subdomain) })
        if (method === 'POST') {
          state.subdomain = JSON.parse(init.body)
          return response({ success: true, errors: [], result: structuredClone(state.subdomain) })
        }
      }
      assert.fail(`Unexpected Cloudflare request: ${method} ${url}`)
    },
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function removePublicAccess(mock) {
  return removeAppPublicAccess({
    fetchImpl: mock.fetch,
    apiToken: 'dummy-api-token-value',
    accountId: 'dummy-account',
    siteDomain: 'apps.example.com',
    worker: 'insulin-apps-alpha-app',
  })
}

test('preflight skips without a token and lists every missing setting otherwise', () => {
  assert.deepEqual(readSettings({}), { skip: true })
  assert.throws(
    () => readSettings({ CLOUDFLARE_API_TOKEN: 'set', GOOGLE_CLIENT_ID: 'set' }),
    /CLOUDFLARE_ACCOUNT_ID, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, EMAIL_FROM, GOOGLE_CLIENT_SECRET/,
  )
  assert.doesNotThrow(() => readSettings(settings({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })))
  assert.doesNotThrow(() =>
    readSettings({ CLOUDFLARE_API_TOKEN: 'set', CLOUDFLARE_ACCOUNT_ID: 'set' }, { gateway: false }),
  )
  assert.throws(
    () => readSettings({ CLOUDFLARE_API_TOKEN: 'set' }, { gateway: false }),
    /CLOUDFLARE_ACCOUNT_ID/,
  )
})

test('the optional contact and organization-request addresses go to the gateway as vars, trimmed', () => {
  const read = readSettings(settings({ SUPPORT_EMAIL: ' help@example.com ', ORG_REQUEST_EMAIL: ' requests@example.com ' }))
  assert.equal(read.supportEmail, 'help@example.com')
  assert.equal(read.orgRequestEmail, 'requests@example.com')
  const config = buildGatewayConfig({ root: '/repository', apps: [], settings: read, databaseId: null })
  assert.equal(config.vars.SUPPORT_EMAIL, 'help@example.com')
  assert.equal(config.vars.ORG_REQUEST_EMAIL, 'requests@example.com')
  assert.equal(readSettings(settings()).orgRequestEmail, '', 'unset: the page at the limit points to the contact instead')
  assert.equal('orgRequestEmail' in readSettings(settings(), { gateway: false }), false, 'app deploys never get it')
})

test("the operator console's settings go to the gateway: its SAML app, group and admins as vars, the Cloudflare token as a secret", async () => {
  const console = {
    SUPER_SAML_IDP_ENTITY_ID: ' https://idp.example.com/workspace ',
    SUPER_SAML_IDP_SSO_URL: 'https://idp.example.com/sso',
    SUPER_SAML_IDP_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    SUPER_GOOGLE_GROUP: 'operators@example.com',
    SUPER_ADMIN_EMAILS: 'admin@example.com',
  }
  const read = readSettings(settings(console))
  const config = buildGatewayConfig({ root: '/repository', apps: [], settings: read, databaseId: null })
  assert.equal(config.vars.SUPER_SAML_IDP_ENTITY_ID, 'https://idp.example.com/workspace')
  assert.equal(config.vars.SUPER_GOOGLE_GROUP, 'operators@example.com')
  assert.equal(config.vars.SUPER_ADMIN_EMAILS, 'admin@example.com')
  assert.equal('SUPER_CLOUDFLARE_ACCOUNT_ID' in config.vars, false, 'no token, no account to read')
  assert.equal(buildGatewayConfig({ root: '/repository', apps: [], settings: readSettings(settings()), databaseId: null }).vars.SUPER_GOOGLE_GROUP, '', 'unset: the console is off')
  assert.equal('superGoogleGroup' in readSettings(settings(console), { gateway: false }), false, 'app deploys never get them')

  const token = 'dummy-super-cloudflare-token'
  const withToken = buildGatewayConfig({ root: '/repository', apps: [], settings: readSettings(settings({ ...console, SUPER_CLOUDFLARE_API_TOKEN: token })), databaseId: null })
  assert.equal(withToken.vars.SUPER_CLOUDFLARE_ACCOUNT_ID, 'dummy-account', 'the account the platform deploys to')
  assert.ok(!JSON.stringify(withToken).includes(token), 'the token is never a var')
  const root = await fixtureRepository()
  const out = await tempDirectory('deploy-gateway-super-')
  await deployApps({ root, out, environment: settings({ ...console, SUPER_CLOUDFLARE_API_TOKEN: token }), dryRun: true, gatewayOnly: true })
  const planText = await readFile(join(out, 'plan.json'), 'utf8')
  assert.ok(!planText.includes(token), 'the plan never holds it')
  const deploy = JSON.parse(planText).commands.find(({ args }) => args[0] === 'deploy')
  assert.ok(deploy.secretNames.includes('SUPER_CLOUDFLARE_API_TOKEN'), 'it travels with the deploy as a secret')
})

test("every gateway variable for this repository's apps fits Cloudflare's 5 KB a variable", async () => {
  const config = buildGatewayConfig({ root: '/repository', apps: await listApps(), settings: readSettings(settings()), databaseId: null })
  for (const [name, value] of Object.entries(config.vars)) {
    const bytes = Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
    // Cloudflare says 5 KB; 5,000 bytes is the stricter reading.
    assert.ok(bytes <= 5000, `${name} is ${bytes} bytes`)
  }
})

test('extracts and validates the sender address', () => {
  assert.equal(emailAddress('sender@example.com'), 'sender@example.com')
  assert.equal(emailAddress('Example Sender <sender@example.com>'), 'sender@example.com')
  assert.throws(() => emailAddress('not-an-address'), /EMAIL_FROM/)
})

test('generated app config accepts only validated deployment-safe fields', () => {
  const result = sanitizeAppBaseConfig({
    compatibility_date: '2026-09-25',
    compatibility_flags: ['nodejs_compat'],
    rules: [{ type: 'Text', globs: ['**/*.txt'], extra: 'ignored' }],
    no_bundle: false,
    assets: {
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: false,
      directory: '/untrusted',
    },
    name: 'untrusted',
    main: 'untrusted.mjs',
    build: { command: 'untrusted command' },
    unsafe: { bindings: [] },
    vars: { SECRET: 'untrusted' },
    routes: ['untrusted.example'],
    alias: { module: './untrusted.mjs' },
    define: { VALUE: 'untrusted' },
    tsconfig: './untrusted.json',
  })
  assert.deepEqual(result.config, {
    compatibility_date: '2026-09-25',
    compatibility_flags: ['nodejs_compat'],
    rules: [{ type: 'Text', globs: ['**/*.txt'] }],
    no_bundle: false,
    assets: {
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: false,
    },
  })
  assert.deepEqual(result.ignoredKeys, [
    'alias',
    'assets.directory',
    'build',
    'define',
    'main',
    'name',
    'routes',
    'rules[].extra',
    'tsconfig',
    'unsafe',
    'vars',
  ])
  assert.throws(() => sanitizeAppBaseConfig({ compatibility_date: '2026-02-30' }), /compatibility_date/)
  assert.throws(() => sanitizeAppBaseConfig({ compatibility_flags: ['nodejs_compat', 'untrusted_flag'] }), /untrusted_flag/)
  assert.throws(() => sanitizeAppBaseConfig({ rules: [{ type: 'Text', globs: [false] }] }), /rules\[0\]/)
  assert.throws(() => sanitizeAppBaseConfig({ assets: { run_worker_first: ['**'] } }), /run_worker_first/)
})

test('build output verification rejects links outside the artifact', async () => {
  const root = await fixtureRepository()
  verifyBuildOutput(join(root, 'alpha-app'))
  await symlink('/tmp/outside-build-target', join(root, 'alpha-app', '.output', 'public', 'unsafe-link'))
  assert.throws(() => verifyBuildOutput(join(root, 'alpha-app')), /not a regular file or directory/)
  await assert.rejects(
    () => deployApps({
      root,
      out: join(root, 'plan'),
      environment: {
        CLOUDFLARE_API_TOKEN: 'dummy-api-token-value',
        CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
      },
      dryRun: true,
      skipBuild: true,
      only: 'alpha-app',
    }),
    /not a regular file or directory/,
  )

  const hardLinkRoot = await fixtureRepository()
  const outside = join(hardLinkRoot, 'outside.txt')
  await writeFile(outside, 'outside\n')
  await link(outside, join(hardLinkRoot, 'alpha-app', '.output', 'public', 'unsafe-hard-link'))
  assert.throws(() => verifyBuildOutput(join(hardLinkRoot, 'alpha-app')), /hard link outside/)
})

test('public access cleanup accepts an app Worker with nothing public', async () => {
  const mock = cloudflareMock()
  await removePublicAccess(mock)
  assert.equal(mock.state.requests.filter(({ method }) => method === 'DELETE').length, 0)
  assert.equal(mock.state.requests.filter(({ method }) => method === 'POST').length, 0)
})

test('public access cleanup deletes a stale custom domain and verifies it is gone', async () => {
  const mock = cloudflareMock({ domains: [{ id: 'domain-id', hostname: 'stale.apps.example.com' }] })
  await removePublicAccess(mock)
  assert.deepEqual(mock.state.domains, [])
  assert.equal(mock.state.requests.filter(({ method }) => method === 'DELETE').length, 1)
})

test('public access cleanup deletes only the app Worker stale zone routes', async () => {
  const mock = cloudflareMock({
    routes: [
      { id: 'app-route', pattern: 'stale.apps.example.com/*', script: 'insulin-apps-alpha-app' },
      { id: 'other-route', pattern: 'other.apps.example.com/*', script: 'another-worker' },
    ],
  })
  await removePublicAccess(mock)
  assert.deepEqual(mock.state.routes, [
    { id: 'other-route', pattern: 'other.apps.example.com/*', script: 'another-worker' },
  ])
})

test('public access cleanup disables workers.dev and preview URLs then re-checks', async () => {
  const mock = cloudflareMock({ subdomain: { enabled: true, previews_enabled: true } })
  await removePublicAccess(mock)
  assert.deepEqual(mock.state.subdomain, { enabled: false, previews_enabled: false })
  const post = mock.state.requests.find(({ method }) => method === 'POST')
  assert.deepEqual(JSON.parse(post.body), { enabled: false, previews_enabled: false })
})

test('public access cleanup fails closed on a Cloudflare API error', async () => {
  const mock = cloudflareMock({ fail: (url, method) => method === 'GET' && url.pathname.endsWith('/workers/domains') })
  await assert.rejects(() => removePublicAccess(mock), /Cloudflare API rejected GET.*fixture failure/)
})

test('gateway secret verification rejects retained SITE_ENV and invalid output', () => {
  assert.doesNotThrow(() => assertNoSiteEnvSecret('[{"name":"TURNSTILE_SECRET_KEY","type":"secret_text"}]'))
  assert.throws(() => assertNoSiteEnvSecret('[{"name":"SITE_ENV","type":"secret_text"}]'), /wrangler secret delete SITE_ENV/)
  assert.throws(() => assertNoSiteEnvSecret('not json'), /invalid JSON/)
})

test('dry-run writes private app configs, the complete gateway config, and a redacted plan without spawning', async () => {
  const root = await fixtureRepository()
  const out = await tempDirectory('deploy-apps-out-')
  const summary = join(out, 'summary.md')
  const environment = settings({ GITHUB_STEP_SUMMARY: summary })
  await deployApps({
    root,
    out,
    environment,
    dryRun: true,
    skipBuild: true,
    spawn: () => assert.fail('dry-run spawned a process'),
  })

  const alpha = JSON.parse(await readFile(join(out, 'apps', 'alpha-app.wrangler.json'), 'utf8'))
  assert.equal(alpha.name, 'insulin-apps-alpha-app')
  assert.equal(alpha.main, resolve(root, 'alpha-app', '.output', 'server', 'index.mjs'))
  assert.ok(isAbsolute(alpha.assets.directory))
  assert.deepEqual(alpha.assets, {
    binding: 'ASSETS',
    html_handling: 'none',
    directory: resolve(root, 'alpha-app', '.output', 'public'),
  })
  assert.deepEqual(alpha.compatibility_flags, ['nodejs_compat'])
  assert.deepEqual(alpha.rules, [{ type: 'ESModule', globs: ['**/*.mjs'], fallthrough: true }])
  assert.equal(alpha.no_bundle, true)
  assert.deepEqual(alpha.vars, { SUGER_ACCESS_MODE: 'console', SUGER_TRUST_ORG_ROLE: 'true' }, 'the gateway sets x-suger-org-role (DESIGN.md §2.4)')
  assert.equal(alpha.workers_dev, false)
  assert.equal(alpha.preview_urls, false)
  for (const key of ['build', 'unsafe', 'routes']) assert.ok(!(key in alpha), `${key} leaked from the generated config`)
  assert.ok(!('routes' in alpha) && !('route' in alpha))
  assert.deepEqual(alpha.d1_databases, [
    {
      binding: 'DB',
      database_name: 'insulin-apps-alpha-app',
      migrations_dir: resolve(root, 'alpha-app', 'src', 'app', 'db', 'migrations'),
    },
  ])

  const gateway = JSON.parse(await readFile(join(out, 'gateway.wrangler.json'), 'utf8'))
  assert.equal(gateway.name, 'insulin-apps-gateway')
  assert.equal(gateway.compatibility_date, '2026-10-13')
  assert.deepEqual(gateway.compatibility_flags, ['nodejs_compat'], "SAML's XML signature library needs Node's crypto")
  assert.equal(gateway.workers_dev, false)
  assert.equal(gateway.preview_urls, false)
  assert.deepEqual(gateway.routes, [
    { pattern: 'apps.example.com', custom_domain: true },
    { pattern: 'www.apps.example.com', custom_domain: true },
    { pattern: 'auth.apps.example.com', custom_domain: true },
    { pattern: 'alpha-app.apps.example.com', custom_domain: true },
    { pattern: 'beta.apps.example.com', custom_domain: true },
  ])
  assert.deepEqual(gateway.services, [
    { binding: 'APP_ALPHA_APP', service: 'insulin-apps-alpha-app' },
    { binding: 'APP_BETA', service: 'insulin-apps-beta' },
  ])
  assert.deepEqual(gateway.send_email, [{ name: 'EMAIL', allowed_sender_addresses: ['sender@example.com'] }])
  assert.deepEqual(gateway.triggers, { crons: ['*/5 * * * *', '17 3 * * *'] }, "the apps' five-minute tick and the daily cleanup")
  assert.deepEqual(gateway.ratelimits, [
    { name: 'RL_AUTH', namespace_id: '730101', simple: { limit: 20, period: 60 } },
    { name: 'RL_APP', namespace_id: '730102', simple: { limit: 600, period: 60 } },
    { name: 'RL_PUBLIC', namespace_id: '730103', simple: { limit: 60, period: 60 } },
  ])
  assert.equal(gateway.vars.SITE_APP_ALPHA_APP.source, 'https://github.com/sugerio/insulin-apps/tree/main/alpha-app')
  assert.equal('SITE_APPS' in gateway.vars, false, 'one variable per app, never one list of all of them (5 KB a variable)')
  assert.ok(!('SITE_ENV' in gateway.vars))
  assert.equal(gateway.vars.SUPPORT_EMAIL, '', 'optional settings left unset stay empty')
  assert.equal(gateway.vars.ORG_REQUEST_EMAIL, '')
  assert.deepEqual(gateway.assets, {
    directory: resolve(root, '.github', 'hosting', 'docs', 'assets'),
    binding: 'DOCS_ASSETS',
    run_worker_first: true,
  }, "the docs' images, behind the gateway: every request reaches the Worker first")

  const planText = await readFile(join(out, 'plan.json'), 'utf8')
  for (const secret of [environment.CLOUDFLARE_API_TOKEN, environment.GOOGLE_CLIENT_SECRET, environment.TURNSTILE_SECRET_KEY]) {
    assert.ok(!planText.includes(secret))
  }
  const plan = JSON.parse(planText)
  assert.equal(plan.gateway, true)
  const deploys = plan.commands.filter(({ args }) => args[0] === 'deploy')
  assert.equal(deploys.length, 3)
  assert.match(deploys[0].args[2], /alpha-app\.wrangler\.json$/)
  assert.match(deploys[1].args[2], /beta\.wrangler\.json$/)
  assert.match(deploys[2].args[2], /gateway\.wrangler\.json$/)
  const gatewayDeploy = plan.commands.find(({ args }) => args[0] === 'deploy' && args.includes('--secrets-file'))
  assert.deepEqual(gatewayDeploy.args.slice(3), ['--secrets-file', '<redacted-secret-file>'])
  assert.equal(gatewayDeploy.input, '<redacted>')
  assert.ok(plan.commands.some(({ args }) => args[0] === 'secret' && args[1] === 'list'))
  assert.equal(plan.commands.filter(({ command }) => command === 'cloudflare-api').length, 2)

  const summaryText = await readFile(summary, 'utf8')
  assert.match(summaryText, /https:\/\/alpha-app\.apps\.example\.com/)
  assert.match(summaryText, /^- https:\/\/apps\.example\.com$/m, 'sign-in, accounts and settings live on the apex')
  assert.doesNotMatch(summaryText, /auth\.apps\.example\.com/)
})

test('--only deploys one app and does not plan or validate a gateway deploy', async () => {
  const root = await fixtureRepository()
  const out = await tempDirectory('deploy-apps-only-')
  const appSettings = {
    CLOUDFLARE_API_TOKEN: 'dummy-api-token-value',
    CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  }
  await deployApps({ root, out, environment: appSettings, dryRun: true, skipBuild: true, only: 'beta' })

  const plan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8'))
  assert.deepEqual(plan.apps, ['beta'])
  assert.equal(plan.gateway, false)
  assert.equal(plan.commands.filter(({ args }) => args[0] === 'deploy').length, 1)
  assert.equal(existsSync(join(out, 'gateway.wrangler.json')), false)
  await assert.rejects(
    () => deployApps({ root, out: join(out, 'unknown'), environment: appSettings, dryRun: true, only: 'missing' }),
    /Unknown app for --only/,
  )
})

test('--gateway-only deploys the gateway with every discovered app binding and no app output', async () => {
  const root = await fixtureRepository()
  const out = await tempDirectory('deploy-gateway-only-')
  await deployApps({ root, out, environment: settings(), dryRun: true, gatewayOnly: true })

  const plan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8'))
  assert.deepEqual(plan.apps, [])
  assert.equal(plan.gateway, true)
  assert.equal(plan.commands.filter(({ args }) => args[0] === 'deploy').length, 1)
  assert.equal(existsSync(join(out, 'apps')), false)
  const gateway = JSON.parse(await readFile(join(out, 'gateway.wrangler.json'), 'utf8'))
  assert.deepEqual(gateway.services, [
    { binding: 'APP_ALPHA_APP', service: 'insulin-apps-alpha-app' },
    { binding: 'APP_BETA', service: 'insulin-apps-beta' },
  ])
})

test('a release deploy tags every Worker version with the release and its commit, and takes nothing else', async () => {
  const root = await fixtureRepository()
  const out = await tempDirectory('deploy-apps-release-')
  const commit = 'a1b2c3d4e5'.repeat(4)
  await deployApps({ root, out, environment: settings({ RELEASE_VERSION: 'v0.1.7', RELEASE_COMMIT: commit }), dryRun: true, skipBuild: true })
  const deploys = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8')).commands.filter(({ args }) => args[0] === 'deploy')
  assert.equal(deploys.length, 3)
  for (const { args } of deploys) {
    assert.deepEqual(args.slice(args.indexOf('--tag')), ['--tag', 'v0.1.7', '--message', 'insulin-apps v0.1.7 (a1b2c3d4e5a1)'])
  }

  const plain = await tempDirectory('deploy-apps-plain-')
  await deployApps({ root, out: plain, environment: settings(), dryRun: true, skipBuild: true })
  const untagged = JSON.parse(await readFile(join(plain, 'plan.json'), 'utf8')).commands.filter(({ args }) => args[0] === 'deploy')
  assert.ok(untagged.every(({ args }) => !args.includes('--tag') && !args.includes('--message')), 'outside a release, no tag')

  for (const [name, value, message] of [
    ['RELEASE_VERSION', 'main', /RELEASE_VERSION must be a release/],
    ['RELEASE_VERSION', 'v1.2', /RELEASE_VERSION must be a release/],
    ['RELEASE_COMMIT', '', /RELEASE_COMMIT must be/],
    ['RELEASE_COMMIT', 'abc1234', /RELEASE_COMMIT must be/],
  ]) {
    const environment = settings({ RELEASE_VERSION: 'v0.1.7', RELEASE_COMMIT: commit, [name]: value })
    await assert.rejects(() => deployApps({ root, environment, dryRun: true, skipBuild: true, spawn: () => assert.fail('spawned') }), message)
  }
})

test('a mocked deployment creates missing databases and removes its mode-600 secret file', async () => {
  const root = await fixtureRepository()
  const gateway = join(root, '.github', 'hosting', 'gateway')
  await mkdir(join(gateway, 'node_modules', '.bin'), { recursive: true })
  await mkdir(join(gateway, 'src'), { recursive: true })
  await mkdir(join(gateway, 'migrations'), { recursive: true })
  await writeFile(join(gateway, 'node_modules', '.bin', 'wrangler'), '')
  await writeFile(join(gateway, 'src', 'index.ts'), 'export default {}\n')
  await writeFile(join(gateway, 'migrations', '0001_init.sql'), 'CREATE TABLE fixture (id TEXT PRIMARY KEY);\n')

  const databases = new Map()
  const commands = []
  let secretFile
  const spawn = (command, args, options) => {
    commands.push(args)
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, 'dummy-api-token-value')
    assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, 'dummy-account')
    assert.ok(!('GOOGLE_CLIENT_SECRET' in options.env))
    assert.ok(!('TURNSTILE_SECRET_KEY' in options.env))

    if (args[0] === 'd1' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify([...databases].map(([name, uuid]) => ({ name, uuid }))),
        stderr: '',
      }
    }
    if (args[0] === 'd1' && args[1] === 'create') {
      databases.set(args[2], `fixture-${args[2]}-db`)
      return { status: 0, stdout: `Created ${args[2]}\n`, stderr: '' }
    }
    if (args[0] === 'deploy' && args.includes('--secrets-file')) {
      secretFile = args[args.indexOf('--secrets-file') + 1]
      assert.equal(statSync(secretFile).mode & 0o777, 0o600)
      assert.deepEqual(JSON.parse(readFileSync(secretFile, 'utf8')), {
        GOOGLE_CLIENT_SECRET: 'dummy-google-secret-value',
        TURNSTILE_SECRET_KEY: 'dummy-turnstile-secret-value',
      })
    }
    if (args[0] === 'secret' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }

  const api = cloudflareMock()
  const result = await deployApps({ root, environment: settings(), skipBuild: true, spawn, fetchImpl: api.fetch })
  temporary.push(result.outputDirectory)
  assert.equal(databases.size, 3)
  assert.equal(commands.filter((args) => args[0] === 'deploy').length, 3)
  assert.ok(secretFile)
  assert.equal(existsSync(secretFile), false)

  const gatewayConfig = JSON.parse(readFileSync(join(result.outputDirectory, 'gateway.wrangler.json'), 'utf8'))
  assert.equal(gatewayConfig.d1_databases[0].database_id, 'fixture-insulin-apps-gateway-db')
})

test('with GATEWAY_SECRET_KEY, the gateway gets it and each app its own integration token, both as deploy secrets', async () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  const root = await fixtureRepository()
  const gateway = join(root, '.github', 'hosting', 'gateway')
  await mkdir(join(gateway, 'node_modules', '.bin'), { recursive: true })
  await mkdir(join(gateway, 'src'), { recursive: true })
  await mkdir(join(gateway, 'migrations'), { recursive: true })
  await writeFile(join(gateway, 'node_modules', '.bin', 'wrangler'), '')
  await writeFile(join(gateway, 'src', 'index.ts'), 'export default {}\n')
  await writeFile(join(gateway, 'migrations', '0001_init.sql'), 'CREATE TABLE fixture (id TEXT PRIMARY KEY);\n')
  const secretFiles = []
  const databases = new Map()
  const spawn = (command, args, options) => {
    assert.ok(!('GATEWAY_SECRET_KEY' in options.env), 'the key never reaches a command\'s environment')
    if (args[0] === 'd1' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify([...databases].map(([name, uuid]) => ({ name, uuid }))), stderr: '' }
    }
    if (args[0] === 'd1' && args[1] === 'create') {
      databases.set(args[2], `fixture-${args[2]}-db`)
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'deploy') {
      assert.ok(args.includes('--secrets-file'), `${args[2]}: deployed with its secrets`)
      const file = args[args.indexOf('--secrets-file') + 1]
      secretFiles.push({ config: basename(args[2]), values: JSON.parse(readFileSync(file, 'utf8')) })
    }
    if (args[0] === 'secret' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = await deployApps({ root, environment: settings({ GATEWAY_SECRET_KEY: key }), skipBuild: true, spawn, fetchImpl: cloudflareMock().fetch })
  temporary.push(result.outputDirectory)
  assert.deepEqual(secretFiles.map(({ config }) => config), ['alpha-app.wrangler.json', 'beta.wrangler.json', 'gateway.wrangler.json'])
  assert.deepEqual(secretFiles[0].values, { SUGER_APP_TOKEN: appToken(key, 'alpha-app') })
  assert.deepEqual(secretFiles[1].values, { SUGER_APP_TOKEN: appToken(key, 'beta') })
  assert.notEqual(secretFiles[0].values.SUGER_APP_TOKEN, secretFiles[1].values.SUGER_APP_TOKEN)
  assert.equal(secretFiles[2].values.GATEWAY_SECRET_KEY, key)
  const alpha = JSON.parse(readFileSync(join(result.outputDirectory, 'apps', 'alpha-app.wrangler.json'), 'utf8'))
  assert.equal(alpha.vars.SUGER_INTEGRATIONS_URL, 'https://apps.example.com/__insulin/integrations')

  const out = await tempDirectory('deploy-apps-key-plan-')
  await deployApps({ root, out, environment: settings({ GATEWAY_SECRET_KEY: key }), dryRun: true, skipBuild: true, spawn: () => assert.fail('spawned') })
  const planText = await readFile(join(out, 'plan.json'), 'utf8')
  for (const secret of [key, appToken(key, 'alpha-app'), appToken(key, 'beta')]) assert.ok(!planText.includes(secret), 'the plan redacts the key and tokens')
  assert.throws(() => readSettings(settings({ GATEWAY_SECRET_KEY: Buffer.alloc(16).toString('base64') })), /GATEWAY_SECRET_KEY/)
})

test("an app's declared secrets come from the environment's secrets, then its variables, and nothing else does", async () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  const root = await fixtureRepository()
  const manifest = JSON.parse(await readFile(join(root, 'alpha-app', 'package.json'), 'utf8'))
  const navigation = [{ key: 'envelopes', label: 'Envelopes', icon: 'inbox', path: '/envelopes', children: [{ key: 'drafts', label: 'Drafts', icon: 'file-pen', path: '/envelopes?status=draft' }] }]
  manifest.insulin = { publicPaths: ['/sign', '/api/public/'], scheduled: '/api/scheduled', navigation, secrets: ['ALPHA_APP_KMS_KEY', 'ALPHA_APP_REGION', 'ALPHA_APP_MISSING'] }
  await writeFile(join(root, 'alpha-app', 'package.json'), JSON.stringify(manifest))
  const gateway = join(root, '.github', 'hosting', 'gateway')
  await mkdir(join(gateway, 'node_modules', '.bin'), { recursive: true })
  await mkdir(join(gateway, 'src'), { recursive: true })
  await mkdir(join(gateway, 'migrations'), { recursive: true })
  await writeFile(join(gateway, 'node_modules', '.bin', 'wrangler'), '')
  await writeFile(join(gateway, 'src', 'index.ts'), 'export default {}\n')
  await writeFile(join(gateway, 'migrations', '0001_init.sql'), 'CREATE TABLE fixture (id TEXT PRIMARY KEY);\n')
  const environment = settings({
    GATEWAY_SECRET_KEY: key,
    APP_SECRETS_JSON: JSON.stringify({ ALPHA_APP_KMS_KEY: 'kms-secret-value-1234', CLOUDFLARE_API_TOKEN: 'dummy-api-token-value', BETA_TOKEN: 'not-declared-anywhere' }),
    APP_VARS_JSON: JSON.stringify({ ALPHA_APP_REGION: 'region-value-5678', ALPHA_APP_KMS_KEY: 'loses-to-the-secret' }),
  })
  const secretFiles = new Map()
  const databases = new Map()
  const spawn = (command, args, options) => {
    for (const name of ['APP_SECRETS_JSON', 'APP_VARS_JSON']) assert.ok(!(name in options.env), `${name} never reaches a command`)
    if (args[0] === 'd1' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify([...databases].map(([name, uuid]) => ({ name, uuid }))), stderr: '' }
    }
    if (args[0] === 'd1' && args[1] === 'create') {
      databases.set(args[2], `fixture-${args[2]}-db`)
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'deploy') secretFiles.set(basename(args[2]), JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1], 'utf8')))
    if (args[0] === 'secret' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = await deployApps({ root, environment, skipBuild: true, spawn, fetchImpl: cloudflareMock().fetch })
  temporary.push(result.outputDirectory)
  assert.deepEqual(secretFiles.get('alpha-app.wrangler.json'), {
    ALPHA_APP_KMS_KEY: 'kms-secret-value-1234',
    ALPHA_APP_REGION: 'region-value-5678',
    SUGER_APP_TOKEN: appToken(key, 'alpha-app'),
  }, 'declared names only, a secret before a variable, a missing one skipped')
  assert.deepEqual(secretFiles.get('beta.wrangler.json'), { SUGER_APP_TOKEN: appToken(key, 'beta') }, 'another app gets none of them')
  const alpha = JSON.parse(readFileSync(join(result.outputDirectory, 'apps', 'alpha-app.wrangler.json'), 'utf8'))
  assert.equal(alpha.vars.SUGER_MAIL_URL, 'https://apps.example.com/__insulin/mail')
  assert.equal(alpha.vars.SUGER_METRICS_URL, 'https://apps.example.com/__insulin/metrics', 'where the app reports its usage every hour')
  assert.equal(alpha.vars.SUGER_MEMBERS_URL, 'https://apps.example.com/__insulin/members', 'where the app looks up members for a sharing dialog (DESIGN.md §8.9)')
  assert.equal(alpha.vars.SUGER_TRUST_ORG_ROLE, 'true', 'the gateway sends x-suger-org-role, so the app may honour it')
  assert.deepEqual(alpha.services, [{ binding: 'SUGER_GATEWAY', service: 'insulin-apps-gateway' }], 'the app calls the gateway over a service binding, not its public URL')
  const gatewayConfig = JSON.parse(readFileSync(join(result.outputDirectory, 'gateway.wrangler.json'), 'utf8'))
  const site = gatewayConfig.vars.SITE_APP_ALPHA_APP
  assert.deepEqual(site.publicPaths, ['/sign', '/api/public/'])
  assert.equal(site.scheduled, '/api/scheduled', 'the path the gateway ticks')
  assert.equal('scheduled' in gatewayConfig.vars.SITE_APP_BETA, false, 'an app without one has none (its variable leaves it out)')
  assert.equal('binding' in site, false, 'the gateway works the binding out from the name')
  assert.deepEqual(site.navigation, [{
    key: 'envelopes', label: 'Envelopes', icon: 'inbox', path: '/envelopes',
  }], "the gateway renders the app's level 1 on its settings pages (DESIGN.md §3.2), never its level 2, and fills in the defaults")
  assert.equal('navigation' in gatewayConfig.vars.SITE_APP_BETA, false, 'an app without a manifest has none')
  assert.equal('secrets' in site, false, "the gateway never learns an app's secret names")

  const out = await tempDirectory('deploy-apps-app-secrets-plan-')
  await deployApps({ root, out, environment, dryRun: true, skipBuild: true, only: 'alpha-app', spawn: () => assert.fail('spawned') })
  const planText = await readFile(join(out, 'plan.json'), 'utf8')
  for (const secret of ['kms-secret-value-1234', 'region-value-5678']) assert.ok(!planText.includes(secret), 'the plan never holds a value')
  const deploy = JSON.parse(planText).commands.find(({ args }) => args[0] === 'deploy')
  assert.deepEqual(deploy.secretNames, ['ALPHA_APP_KMS_KEY', 'ALPHA_APP_REGION', 'SUGER_APP_TOKEN'], 'it lists their names')

  const withoutKey = new Map()
  const plain = await deployApps({
    root, environment: { ...environment, GATEWAY_SECRET_KEY: '' }, skipBuild: true, only: 'alpha-app', fetchImpl: cloudflareMock().fetch,
    spawn: (command, args) => {
      if (args[0] === 'deploy') withoutKey.set(basename(args[2]), JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1], 'utf8')))
      if (args[0] === 'd1' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ name: 'insulin-apps-alpha-app', uuid: 'fixture-db' }]), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  temporary.push(plain.outputDirectory)
  assert.deepEqual(Object.keys(withoutKey.get('alpha-app.wrangler.json')).sort(), ['ALPHA_APP_KMS_KEY', 'ALPHA_APP_REGION'], 'secrets need no gateway key')
  const plainAlpha = JSON.parse(readFileSync(join(plain.outputDirectory, 'apps', 'alpha-app.wrangler.json'), 'utf8'))
  assert.equal(plainAlpha.services, undefined, 'without the gateway key there is no relay or proxy to bind')
  assert.equal(plainAlpha.vars.SUGER_METRICS_URL, undefined, 'nor anywhere to report usage')
  assert.equal(plainAlpha.vars.SUGER_MEMBERS_URL, undefined, 'nor anywhere to look up members')
  await assert.rejects(
    () => deployApps({ root, environment: { ...environment, APP_SECRETS_JSON: '{"ALPHA_APP_KMS_KEY": "kms-secret-value-1234"' }, dryRun: true, skipBuild: true, only: 'alpha-app' }),
    (error) => /APP_SECRETS_JSON is not valid JSON/.test(error.message) && !error.message.includes('kms-secret-value-1234'),
  )
})

test('the app token is a stable HMAC of the app name under the key, as the gateway derives it', () => {
  const key = Buffer.alloc(32, 0x5a).toString('base64')
  assert.equal(appToken(key, 'captable'), appToken(key, 'captable'))
  assert.match(appToken(key, 'captable'), /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(appToken(key, 'captable'), appToken(Buffer.alloc(32, 1).toString('base64'), 'captable'))
})

test('--build-only builds every app without any deploy setting reaching the build', async () => {
  const root = await fixtureRepository()
  const commands = []
  const spawn = (command, args, options) => {
    commands.push([command, ...args])
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'APP_SECRETS_JSON', 'APP_VARS_JSON']) {
      assert.ok(!(name in options.env), `${name} reached the build`)
    }
    assert.equal(options.env.NITRO_PRESET, 'cloudflare_module')
    return { status: 0, stdout: '', stderr: '' }
  }

  const result = await deployApps({ root, environment: settings({ APP_SECRETS_JSON: '{"ALPHA_APP_X":"secret"}', APP_VARS_JSON: '{}' }), buildOnly: true, spawn })
  assert.deepEqual(result.built, ['alpha-app', 'beta'])
  assert.deepEqual(commands, [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npm', 'run', 'build'],
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npm', 'run', 'build'],
  ])
  const unconfigured = await deployApps({ root, environment: {}, buildOnly: true, spawn: () => ({ status: 0 }) })
  assert.deepEqual(unconfigured.built, ['alpha-app', 'beta'])
  const selected = await deployApps({ root, environment: {}, buildOnly: true, only: 'beta', spawn })
  assert.deepEqual(selected.built, ['beta'])
})

test('argument parsing keeps mutating output restricted to dry-run', () => {
  assert.deepEqual(parseArguments(['--dry-run', '--skip-build', '--out', 'build', '--only=beta']), {
    dryRun: true,
    skipBuild: true,
    out: 'build',
    only: 'beta',
  })
  assert.throws(() => parseArguments(['--out', 'build']), /only available with --dry-run/)
  assert.deepEqual(parseArguments(['--build-only']), { buildOnly: true })
  assert.deepEqual(parseArguments(['--gateway-only', '--skip-build']), { gatewayOnly: true, skipBuild: true })
  assert.throws(() => parseArguments(['--build-only', '--skip-build']), /cannot be combined/)
  assert.throws(() => parseArguments(['--gateway-only', '--only', 'beta']), /cannot be combined/)
  assert.throws(() => parseArguments(['--gateway-only', '--build-only']), /cannot be combined/)
  assert.throws(() => parseArguments(['--unknown']), /usage:/)
  assert.deepEqual(parseArguments(['--build-engine', '--only', 'alpha', '--engine-image', 'image.tar']), { buildEngine: true, only: 'alpha', engineImage: 'image.tar' })
  assert.deepEqual(parseArguments(['--skip-build', '--only=alpha', '--engine-image=image.tar']), { skipBuild: true, only: 'alpha', engineImage: 'image.tar' })
  assert.throws(() => parseArguments(['--build-engine', '--build-only']), /--build-engine builds engines alone/)
  assert.throws(() => parseArguments(['--engine-image', 'image.tar']), /--engine-image needs --only/)
  assert.throws(() => parseArguments(['--gateway-only', '--engine-image', 'image.tar']), /--engine-image needs --only/)
})

// --- Engines (DESIGN.md §8.7), app platform variables and limit catalogs (§8.8) ------------------------------------

const DIGEST = `sha256:${'d'.repeat(64)}`
const PUSHED_DIGEST = `sha256:${'e'.repeat(64)}`

/**
 * The fixture repository plus `alpha`, an app with the synthetic engine (fixtures/engine) built: its app output, its
 * engine's bundle, and the gateway's tooling the deploy expects.
 */
async function engineRepository({ engineApi = 1, limits = [{ key: 'documents', label: 'Documents', unit: 'count', default: 500 }] } = {}) {
  const root = await fixtureRepository()
  const alpha = join(root, 'alpha')
  await cp(join(root, 'alpha-app'), alpha, { recursive: true })
  const manifest = JSON.parse(await readFile(join(alpha, 'package.json'), 'utf8'))
  manifest.insulin = { engine: 'engine/', engineApi, limits }
  await writeFile(join(alpha, 'package.json'), JSON.stringify(manifest))
  await cp(engineFixture, join(alpha, 'engine'), { recursive: true })
  await mkdir(join(alpha, 'engine', '.output', 'worker'), { recursive: true })
  await writeFile(join(alpha, 'engine', '.output', 'worker', 'index.js'), 'export default {}\n')
  const gateway = join(root, '.github', 'hosting', 'gateway')
  await mkdir(join(gateway, 'node_modules', '.bin'), { recursive: true })
  await mkdir(join(gateway, 'src'), { recursive: true })
  await mkdir(join(gateway, 'migrations'), { recursive: true })
  await writeFile(join(gateway, 'node_modules', '.bin', 'wrangler'), '')
  await writeFile(join(gateway, 'src', 'index.ts'), 'export default {}\n')
  await writeFile(join(gateway, 'migrations', '0001_init.sql'), 'CREATE TABLE fixture (id TEXT PRIMARY KEY);\n')
  return root
}

/** A stand-in for the gateway's module that turns a limit catalog into SQL (gateway scripts/limits-catalog.mjs). */
async function limitCatalogModule(root) {
  const scripts = join(root, '.github', 'hosting', 'gateway', 'scripts')
  await mkdir(scripts, { recursive: true })
  await writeFile(join(scripts, 'limits-catalog.mjs'), [
    'export function limitsCatalogSql(apps) {',
    "  return apps.map(({ name, limits }) => `-- catalog of ${name}: ${limits.map(({ key, default: value }) => `${key}=${value}`).join(', ') || 'none'}\\n`).join('')",
    '}',
    '',
  ].join('\n'))
}

/**
 * Cloudflare as the engine's deploy sees it: Workers with the variables their production version holds, R2 buckets,
 * the registry credential, the registry itself (with its token step) and public access, as cloudflareMock has it.
 */
function engineCloudflareMock({ workers = {}, buckets = [], registry = {}, domains = [] } = {}) {
  const state = { workers: structuredClone(workers), buckets: new Set(buckets), registry: new Map(Object.entries(registry)), domains: structuredClone(domains), requests: [] }
  const account = '/client/v4/accounts/dummy-account'
  return {
    state,
    fetch: async (input, init = {}) => {
      const url = new URL(input)
      const method = init.method ?? 'GET'
      const headers = new Headers(init.headers)
      state.requests.push({ url, method, headers, body: init.body })
      if (url.hostname === 'registry.cloudflare.com') {
        if (url.pathname === '/token') {
          assert.equal(headers.get('Authorization'), `Basic ${Buffer.from('v1:dummy-registry-password').toString('base64')}`)
          return Response.json({ token: 'dummy-registry-token' })
        }
        const manifest = url.pathname.match(/^\/v2\/dummy-account\/insulin-apps-alpha-engine\/manifests\/([^/]+)$/)
        assert.ok(manifest, `Unexpected registry request: ${url}`)
        if (headers.get('Authorization') !== 'Bearer dummy-registry-token') {
          return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://registry.cloudflare.com/token",service="registry.cloudflare.com",scope="repository:dummy-account/insulin-apps-alpha-engine:pull"' } })
        }
        const digest = state.registry.get(decodeURIComponent(manifest[1]))
        return digest ? new Response(null, { status: 200, headers: { 'Docker-Content-Digest': digest } }) : new Response(null, { status: 404 })
      }
      assert.equal(headers.get('Authorization'), 'Bearer dummy-api-token-value')
      if (method === 'GET' && url.pathname === '/client/v4/zones') {
        return response({ success: true, errors: [], result: [{ id: 'zone-id', name: 'apps.example.com' }], result_info: { total_pages: 1 } })
      }
      if (method === 'GET' && url.pathname === `${account}/workers/domains`) {
        const service = url.searchParams.get('service')
        return response({ success: true, errors: [], result: state.domains.filter((domain) => domain.service === service), result_info: { total_pages: 1 } })
      }
      if (method === 'DELETE' && url.pathname.startsWith(`${account}/workers/domains/`)) {
        // A domain marked `stuck` stays, as when a removal didn't take.
        state.domains = state.domains.filter(({ id, stuck }) => stuck || id !== decodeURIComponent(url.pathname.split('/').pop()))
        return response({ success: true, errors: [], result: null })
      }
      if (method === 'GET' && url.pathname === '/client/v4/zones/zone-id/workers/routes') return response({ success: true, errors: [], result: [], result_info: { total_pages: 1 } })
      if (/\/workers\/scripts\/insulin-apps-[a-z-]+\/subdomain$/.test(url.pathname)) {
        return response({ success: true, errors: [], result: { enabled: false, previews_enabled: false } })
      }
      const script = url.pathname.match(/\/workers\/scripts\/([^/]+)\/(deployments|versions\/([^/]+))$/)
      if (method === 'GET' && script) {
        // A Worker's variables: one version at 100%, or a list of { percentage, vars } sharing its latest deployment.
        const entry = state.workers[decodeURIComponent(script[1])]
        if (!entry) return response({ success: false, errors: [{ code: 10007, message: 'This Worker does not exist on your account.' }], result: null }, 404)
        const versions = Array.isArray(entry) ? entry : [{ percentage: 100, vars: entry }]
        if (script[2] === 'deployments') {
          return response({ success: true, errors: [], result: { deployments: [
            { id: 'older', created_on: '2026-10-01T00:00:00Z', versions: [{ version_id: `${script[1]}-retired`, percentage: 100 }] },
            { id: 'latest', created_on: '2026-11-01T00:00:00Z', versions: versions.map(({ percentage }, index) => ({ version_id: `${script[1]}-version-${index}`, percentage })) },
          ] } })
        }
        const { vars } = versions[Number(script[3].split('-').pop())]
        return response({ success: true, errors: [], result: { id: script[3], resources: { bindings: Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })) } } })
      }
      const bucket = url.pathname.match(/^\/client\/v4\/accounts\/dummy-account\/r2\/buckets(?:\/([^/]+))?$/)
      if (bucket && method === 'GET') {
        return state.buckets.has(decodeURIComponent(bucket[1])) ? response({ success: true, errors: [], result: { name: bucket[1] } }) : response({ success: false, errors: [{ code: 10006, message: 'The specified bucket does not exist.' }], result: null }, 404)
      }
      if (bucket && method === 'POST' && !bucket[1]) {
        state.buckets.add(JSON.parse(init.body).name)
        return response({ success: true, errors: [], result: {} })
      }
      if (method === 'POST' && url.pathname === `${account}/containers/registries/registry.cloudflare.com/credentials`) {
        assert.deepEqual(JSON.parse(init.body), { expiration_minutes: 240, permissions: ['push', 'pull'] }, 'a credential that outlasts a long upload')
        return response({ success: true, errors: [], result: { account_id: 'dummy-account', registry_host: 'registry.cloudflare.com', username: 'v1', password: 'dummy-registry-password' } })
      }
      assert.fail(`Unexpected Cloudflare request: ${method} ${url}`)
    },
  }
}

/**
 * Wrangler, npm and Docker for a deploy: databases, deploys that put their config's variables in production (so the
 * mock reads back what the deploy recorded) and a docker push that lands in the registry. Every call is kept.
 */
function engineSpawn(api, { databases = new Map(), onDeploy, catalogTable = true } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command: basename(command), args, env: options.env })
    if (basename(command) === 'docker') {
      if (args[0] === 'push') api.state.registry.set(args[1].split(':').pop(), PUSHED_DIGEST)
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'd1' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify([...databases].map(([name, uuid]) => ({ name, uuid }))), stderr: '' }
    }
    if (args[0] === 'd1' && args[1] === 'create') {
      databases.set(args[2], `fixture-${args[2]}-db`)
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'd1' && args[1] === 'execute' && args.includes('--json')) {
      return { status: 0, stdout: JSON.stringify([{ results: catalogTable ? [{ name: 'app_limit_catalog' }] : [], success: true }]), stderr: '' }
    }
    if (args[0] === 'deploy') {
      const config = JSON.parse(readFileSync(args[2], 'utf8'))
      onDeploy?.(config)
      api.state.workers[config.name] = Object.fromEntries(Object.entries(config.vars ?? {}).filter(([name]) => name.startsWith('SUGER_ENGINE')))
    }
    if (args[0] === 'secret' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { spawn, calls }
}

const deploys = (calls) => calls.filter(({ args }) => args[0] === 'deploy').map(({ args }) => basename(args[2]))

test("an app's platform variables and bindings: the gateway's URLs, the support address, the organization role and its engine", () => {
  const plain = { name: 'beta', engine: null, engineApi: null }
  const withEngine = { name: 'knowledge', engine: 'engine', engineApi: 3 }
  const config = (app, options) => buildAppConfig({ appDirectory: '/repository/app', app, databaseId: 'db', ...options })
  assert.deepEqual(config(plain).vars, { SUGER_ACCESS_MODE: 'console', SUGER_TRUST_ORG_ROLE: 'true' })
  assert.equal(config(plain).services, undefined, 'no gateway key, no engine: no binding')
  // PLT-04: the engine is bound as SUGER_ENGINE, with or without the gateway's key.
  assert.deepEqual(config(withEngine).services, [{ binding: 'SUGER_ENGINE', service: 'insulin-apps-knowledge-engine' }])
  assert.equal(config(withEngine).vars.SUGER_ENGINE_API, '3', 'the engine API it calls, for the next deploy to read back')
  const urls = gatewayUrls('https://apps.example.com')
  const full = config(withEngine, { gatewayVars: urls, supportEmail: 'help@example.com' })
  assert.deepEqual(full.vars, {
    SUGER_ACCESS_MODE: 'console',
    SUGER_INTEGRATIONS_URL: 'https://apps.example.com/__insulin/integrations',
    SUGER_MAIL_URL: 'https://apps.example.com/__insulin/mail',
    SUGER_METRICS_URL: 'https://apps.example.com/__insulin/metrics',
    SUGER_LIMITS_URL: 'https://apps.example.com/__insulin/limits',
    SUGER_MEMBERS_URL: 'https://apps.example.com/__insulin/members',
    SUGER_MEMBER_STATUS_URL: 'https://apps.example.com/__insulin/members/status',
    SUGER_MEMBER_EVENTS_URL: 'https://apps.example.com/__insulin/member-events',
    SUGER_SUPPORT_EMAIL: 'help@example.com',
    SUGER_TRUST_ORG_ROLE: 'true',
    SUGER_ENGINE_API: '3',
  })
  assert.deepEqual(full.services, [
    { binding: 'SUGER_GATEWAY', service: 'insulin-apps-gateway' },
    { binding: 'SUGER_ENGINE', service: 'insulin-apps-knowledge-engine' },
  ])
  assert.equal(readSettings({ CLOUDFLARE_API_TOKEN: 'set', CLOUDFLARE_ACCOUNT_ID: 'set', SUPPORT_EMAIL: ' help@example.com ' }, { gateway: false }).supportEmail, 'help@example.com', 'app deploys read the support address')
})

test("an app's engine, API version and limit catalog stay out of its gateway variable", async () => {
  const root = await engineRepository()
  const gateway = buildGatewayConfig({ root, apps: await listApps(root), settings: readSettings(settings()), databaseId: null })
  const alpha = gateway.vars.SITE_APP_ALPHA
  for (const field of ['engine', 'engineApi', 'limits', 'secrets']) assert.equal(field in alpha, false, field)
  assert.deepEqual(gateway.services.map(({ service }) => service), ['insulin-apps-alpha', 'insulin-apps-alpha-app', 'insulin-apps-beta'], 'the gateway never binds an engine')
})

test('PLT-04: a dry run deploys the engine before its app, with its buckets, its image by tag and no address of its own', async () => {
  const root = await engineRepository()
  const out = await tempDirectory('deploy-apps-engine-plan-')
  await deployApps({ root, out, environment: settings({ GATEWAY_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') }), dryRun: true, skipBuild: true, only: 'alpha', spawn: () => assert.fail('spawned') })
  const plan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8'))
  const steps = plan.commands.map(({ command, args }) => `${basename(command)} ${args.slice(0, 2).join(' ')}`)
  const at = (step) => steps.indexOf(step)
  assert.ok(at('cloudflare-api check-engine-api-in-production insulin-apps-alpha') < at('cloudflare-api ensure-r2-bucket insulin-apps-alpha-engine-files'), 'the versions first')
  assert.ok(at('cloudflare-api ensure-r2-bucket insulin-apps-alpha-engine-backups') > 0)
  const engineDeploy = plan.commands.findIndex(({ args }) => args[0] === 'deploy' && args[2].endsWith('alpha-engine.wrangler.json'))
  const appDeploy = plan.commands.findIndex(({ args }) => args[0] === 'deploy' && args[2].endsWith('/alpha.wrangler.json'))
  assert.ok(engineDeploy > 0 && engineDeploy < appDeploy, 'the engine deploys before its app')
  assert.deepEqual(plan.commands[engineDeploy + 1].args, ['remove-and-verify-public-access', 'insulin-apps-alpha-engine'], "the engine's public access is removed right after its deploy")
  assert.ok(at('cloudflare-api check-engine-in-production insulin-apps-alpha-engine') < appDeploy, "the app goes out only once the engine in production serves it")
  assert.deepEqual(plan.commands.filter(({ command }) => command === 'docker'), [], 'no image archive: nothing to push')
  assert.ok(plan.commands.some(({ command, condition }) => command === 'fail' && /the registry lacks insulin-apps-alpha-engine:inputs-/.test(condition)))

  const engine = JSON.parse(await readFile(join(out, 'apps', 'alpha-engine.wrangler.json'), 'utf8'))
  assert.equal(engine.name, 'insulin-apps-alpha-engine')
  assert.equal(engine.main, join(root, 'alpha', 'engine', '.output', 'worker', 'index.js'))
  assert.equal(engine.no_bundle, true)
  assert.deepEqual([engine.workers_dev, engine.preview_urls], [false, false])
  assert.deepEqual(engine.r2_buckets, [
    { binding: 'FILES', bucket_name: 'insulin-apps-alpha-engine-files' },
    { binding: 'BACKUPS', bucket_name: 'insulin-apps-alpha-engine-backups' },
  ])
  assert.equal(engine.containers[0].image, `registry.cloudflare.com/dummy-account/insulin-apps-alpha-engine:${engineImageTag(join(root, 'alpha', 'engine'))}`)
  assert.equal(engine.vars.SUGER_ENGINE_SERVES, '1-2')
  for (const key of ['routes', 'route', 'account_id', 'services']) assert.equal(key in engine, false, key)
  const app = JSON.parse(await readFile(join(out, 'apps', 'alpha.wrangler.json'), 'utf8'))
  assert.deepEqual(app.services, [{ binding: 'SUGER_GATEWAY', service: 'insulin-apps-gateway' }, { binding: 'SUGER_ENGINE', service: 'insulin-apps-alpha-engine' }])
  assert.equal(app.vars.SUGER_LIMITS_URL, 'https://apps.example.com/__insulin/limits')
})

test('PLT-04: an unchanged engine keeps its digest: the registry has the tag, so nothing is pushed and the deploy pins that digest', async () => {
  const root = await engineRepository()
  const tag = engineImageTag(join(root, 'alpha', 'engine'))
  const api = engineCloudflareMock({ workers: { 'insulin-apps-alpha': { SUGER_ENGINE_API: '1' } }, buckets: ['insulin-apps-alpha-engine-files'], registry: { [tag]: DIGEST } })
  const { spawn, calls } = engineSpawn(api)
  const result = await deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn, fetchImpl: api.fetch })
  temporary.push(result.outputDirectory)
  assert.deepEqual(deploys(calls), ['alpha-engine.wrangler.json', 'alpha.wrangler.json'])
  assert.equal(calls.filter(({ command }) => command === 'docker').length, 0, 'nothing pushed')
  const engine = JSON.parse(readFileSync(join(result.outputDirectory, 'apps', 'alpha-engine.wrangler.json'), 'utf8'))
  assert.equal(engine.containers[0].image, `registry.cloudflare.com/dummy-account/insulin-apps-alpha-engine@${DIGEST}`)
  assert.deepEqual([...api.state.buckets].sort(), ['insulin-apps-alpha-engine-backups', 'insulin-apps-alpha-engine-files'], 'the missing bucket was created')
  assert.ok(api.state.requests.some(({ method, url }) => method === 'POST' && url.pathname.endsWith('/r2/buckets')))
  assert.deepEqual(api.state.workers['insulin-apps-alpha-engine'], { SUGER_ENGINE_SERVES: '1-2' }, 'the deploy recorded what the engine serves')
  assert.deepEqual(api.state.workers['insulin-apps-alpha'], { SUGER_ENGINE_API: '1' })
  assert.ok(api.state.requests.some(({ url }) => url.pathname.endsWith('/workers/scripts/insulin-apps-alpha-engine/subdomain')), "the engine's public access was checked")
})

test("a changed image is pushed from the release's own build, with a credential of its own, then deployed by the digest it resolves to", async () => {
  const root = await engineRepository()
  const archive = join(await tempDirectory('deploy-apps-image-'), 'alpha-engine-image.tar')
  await writeFile(archive, 'a docker archive')
  const tag = engineImageTag(join(root, 'alpha', 'engine'))
  const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'] })
  let dockerConfig
  const { spawn, calls } = engineSpawn(api)
  const watched = (command, args, options) => {
    if (basename(command) === 'docker') {
      dockerConfig = options.env.DOCKER_CONFIG
      const auth = JSON.parse(readFileSync(join(dockerConfig, 'config.json'), 'utf8')).auths['registry.cloudflare.com'].auth
      assert.equal(Buffer.from(auth, 'base64').toString(), 'v1:dummy-registry-password')
      assert.equal(statSync(join(dockerConfig, 'config.json')).mode & 0o777, 0o600)
      assert.ok(!('CLOUDFLARE_API_TOKEN' in options.env), 'Docker never sees the API token')
    }
    return spawn(command, args, options)
  }
  const result = await deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', engineImage: archive, spawn: watched, fetchImpl: api.fetch })
  temporary.push(result.outputDirectory)
  assert.deepEqual(calls.filter(({ command }) => command === 'docker').map(({ args }) => args.join(' ')), [
    `load --input ${archive}`,
    `image inspect --format {{.Id}} insulin-apps-alpha-engine:${tag}`,
    `tag insulin-apps-alpha-engine:${tag} registry.cloudflare.com/dummy-account/insulin-apps-alpha-engine:${tag}`,
    `push registry.cloudflare.com/dummy-account/insulin-apps-alpha-engine:${tag}`,
  ])
  assert.equal(existsSync(dockerConfig), false, 'the credential is removed after the push')
  const engine = JSON.parse(readFileSync(join(result.outputDirectory, 'apps', 'alpha-engine.wrangler.json'), 'utf8'))
  assert.equal(engine.containers[0].image, `registry.cloudflare.com/dummy-account/insulin-apps-alpha-engine@${PUSHED_DIGEST}`)
  assert.deepEqual(deploys(calls), ['alpha-engine.wrangler.json', 'alpha.wrangler.json'])
  const tokenRequest = api.state.requests.find(({ url }) => url.pathname === '/token')
  assert.equal(tokenRequest.url.searchParams.get('scope'), 'repository:dummy-account/insulin-apps-alpha-engine:pull')
})

test('when the registry lacks the tag and this release built no image, the deploy stops before any Worker and asks for a deploy by hand', async () => {
  const root = await engineRepository()
  const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'] })
  const { spawn, calls } = engineSpawn(api)
  await assert.rejects(
    () => deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn, fetchImpl: api.fetch }),
    /The registry has no insulin-apps-alpha-engine:inputs-[0-9a-f]+, and this release built no image for it.*Run Actions → Deploy by hand/,
  )
  assert.deepEqual(deploys(calls), [])
})

test("versions: a deploy refuses an engine that doesn't serve the app version in production, before deploying either Worker, rollbacks included", async () => {
  // The app in production calls engine API 1; this release's engine serves only 2 (the app moved to 2 in the same release).
  const root = await engineRepository({ engineApi: 2 })
  await writeFile(join(root, 'alpha', 'engine', 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(engineFixture, 'package.json'), 'utf8')), insulin: { serves: [2, 2] } }))
  const api = engineCloudflareMock({ workers: { 'insulin-apps-alpha': { SUGER_ENGINE_API: '1' } } })
  const { spawn, calls } = engineSpawn(api)
  await assert.rejects(
    () => deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn, fetchImpl: api.fetch }),
    /The new alpha engine serves engine API 2-2, but the alpha version in production calls 1\. Deploy an engine that serves both first/,
  )
  assert.deepEqual(deploys(calls), [], 'neither Worker deployed')
  assert.deepEqual(calls.filter(({ args }) => args[0] === 'd1'), [], 'and no migration applied')

  // A rollback: an older release whose engine serves 1 only, while production's app (a newer one) calls 2.
  const older = await engineRepository({ engineApi: 1 })
  await writeFile(join(older, 'alpha', 'engine', 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(engineFixture, 'package.json'), 'utf8')), insulin: { serves: [1, 1] } }))
  const newer = engineCloudflareMock({ workers: { 'insulin-apps-alpha': { SUGER_ENGINE_API: '2' }, 'insulin-apps-alpha-engine': { SUGER_ENGINE_SERVES: '1-2' } } })
  const rollback = engineSpawn(newer)
  await assert.rejects(() => deployApps({ root: older, environment: settings(), skipBuild: true, only: 'alpha', spawn: rollback.spawn, fetchImpl: newer.fetch }), /serves engine API 1-1, but the alpha version in production calls 2/)
  assert.deepEqual(deploys(rollback.calls), [])

  // The pair after the engine's deploy: if the engine in production then doesn't serve the app (here its deploy didn't
  // take), the app isn't deployed.
  const stale = await engineRepository({ engineApi: 2 })
  const tag = engineImageTag(join(stale, 'alpha', 'engine'))
  const held = engineCloudflareMock({ workers: { 'insulin-apps-alpha-engine': { SUGER_ENGINE_SERVES: '1-1' } }, buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'], registry: { [tag]: DIGEST } })
  const keep = engineSpawn(held, { onDeploy: (config) => { if (config.name === 'insulin-apps-alpha-engine') config.vars = { SUGER_ENGINE_SERVES: '1-1' } } })
  await assert.rejects(() => deployApps({ root: stale, environment: settings(), skipBuild: true, only: 'alpha', spawn: keep.spawn, fetchImpl: held.fetch }),
    /The alpha engine in production serves engine API 1-1, but this alpha calls 2, so it isn't deployed/)
  assert.deepEqual(deploys(keep.calls), ['alpha-engine.wrangler.json'], 'the engine went, the app did not')
  assert.deepEqual(keep.calls.filter(({ args }) => args[0] === 'd1' && args.includes('insulin-apps-alpha')), [], "nor its database or migrations: a refused app changes nothing")

  // A first deploy: nothing in production yet, and the app version before its engine (no variable) calls none.
  const first = await engineRepository()
  const fresh = engineCloudflareMock({ workers: { 'insulin-apps-alpha': {} }, buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'], registry: { [engineImageTag(join(first, 'alpha', 'engine'))]: DIGEST } })
  const ok = engineSpawn(fresh)
  const result = await deployApps({ root: first, environment: settings(), skipBuild: true, only: 'alpha', spawn: ok.spawn, fetchImpl: fresh.fetch })
  temporary.push(result.outputDirectory)
  assert.deepEqual(deploys(ok.calls), ['alpha-engine.wrangler.json', 'alpha.wrangler.json'])
})

test("an engine that keeps any public access fails the release, and the app isn't deployed", async () => {
  const root = await engineRepository()
  const tag = engineImageTag(join(root, 'alpha', 'engine'))
  const api = engineCloudflareMock({
    buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'], registry: { [tag]: DIGEST },
    domains: [{ id: 'engine-domain', hostname: 'engine.apps.example.com', service: 'insulin-apps-alpha-engine', stuck: true }],
  })
  const { spawn, calls } = engineSpawn(api)
  await assert.rejects(() => deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn, fetchImpl: api.fetch }), /Worker insulin-apps-alpha-engine still has public access after cleanup/)
  assert.deepEqual(deploys(calls), ['alpha-engine.wrangler.json'])
})

test("the deploy checks the engine's config again and needs its bundle: it never trusts the repository's", async () => {
  const root = await engineRepository()
  const engine = join(root, 'alpha', 'engine')
  await writeFile(join(engine, 'wrangler.jsonc'), readFileSync(join(engineFixture, 'wrangler.jsonc'), 'utf8').replace('"workers_dev": false', '"routes": ["engine.example.com/*"],\n  "workers_dev": false'))
  await assert.rejects(() => deployApps({ root, environment: settings(), dryRun: true, skipBuild: true, only: 'alpha' }), /alpha's engine: wrangler\.jsonc: routes is not allowed/)
  const unbuilt = await engineRepository()
  await rm(join(unbuilt, 'alpha', 'engine', '.output'), { recursive: true })
  await assert.rejects(() => deployApps({ root: unbuilt, environment: settings(), skipBuild: true, only: 'alpha', spawn: engineSpawn(engineCloudflareMock()).spawn, fetchImpl: engineCloudflareMock().fetch }), /Missing alpha's engine build output/)
  const linked = await engineRepository()
  await symlink('/etc/hosts', join(linked, 'alpha', 'engine', '.output', 'worker', 'linked.js'))
  await assert.rejects(() => deployApps({ root: linked, environment: settings(), dryRun: true, skipBuild: true, only: 'alpha' }), /not a regular file or directory/)
  await assert.rejects(() => deployApps({ root, environment: settings(), dryRun: true, skipBuild: true, only: 'beta', engineImage: '/x.tar' }), /--engine-image needs --only and an app with an engine/)
})

test("limit catalogs: the gateway step writes those of the apps it deployed after the gateway's migrations; a deploy of apps alone once the tables exist", async () => {
  const root = await engineRepository()
  await limitCatalogModule(root)
  const key = Buffer.alloc(32, 7).toString('base64')
  const tag = engineImageTag(join(root, 'alpha', 'engine'))
  const run = async (options, mockOptions = {}, spawnOptions = {}) => {
    const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'], registry: { [tag]: DIGEST }, ...mockOptions })
    const { spawn, calls } = engineSpawn(api, spawnOptions)
    const sql = []
    const watched = (command, args, options) => {
      if (args[0] === 'd1' && args[1] === 'execute' && !args.includes('--json')) {
        // D1's query path: an import (--file) leaves the database unavailable while it runs, and imports can overlap.
        assert.ok(!args.includes('--file'), 'the catalog is written through a query, never an import')
        assert.ok(args.includes('--remote'))
        sql.push(args[args.indexOf('--command') + 1])
      }
      return spawn(command, args, options)
    }
    const result = await deployApps({ root, skipBuild: true, spawn: watched, fetchImpl: api.fetch, ...options })
    temporary.push(result.outputDirectory)
    return { calls, sql, steps: calls.map(({ args }) => args.slice(0, 2).join(' ')) }
  }

  // A full deploy: every app, then the gateway, which writes their catalogs after its migrations.
  const full = await run({ environment: settings({ GATEWAY_SECRET_KEY: key }) })
  assert.deepEqual(full.sql, ['-- catalog of alpha: documents=500\n-- catalog of alpha-app: none\n-- catalog of beta: none\n'])
  const migrate = full.calls.findIndex(({ args }) => args[0] === 'd1' && args[1] === 'migrations' && args[3] === 'insulin-apps-gateway')
  const write = full.calls.findIndex(({ args }) => args[1] === 'execute' && args.includes('--command') && !args.includes('--json'))
  assert.ok(migrate >= 0 && migrate < write, "after the gateway's migrations")
  assert.equal(full.calls[write].args[2], 'insulin-apps-gateway')

  // The gateway's own job: the apps its run deployed, from DEPLOYED_APPS, and nothing without it.
  assert.deepEqual((await run({ gatewayOnly: true, environment: settings({ DEPLOYED_APPS: '["alpha"]' }) })).sql, ['-- catalog of alpha: documents=500\n'])
  assert.deepEqual((await run({ gatewayOnly: true, environment: settings() })).sql, [], 'a held-back app keeps the catalog of the version it runs')
  await assert.rejects(() => run({ gatewayOnly: true, environment: settings({ DEPLOYED_APPS: '["delta"]' }) }), /DEPLOYED_APPS names unknown apps: delta/)

  // A deploy of the app alone, after its deploy: when the gateway's tables exist, and not before.
  const databases = new Map([['insulin-apps-gateway', 'fixture-gateway-db']])
  const alone = await run({ only: 'alpha', environment: settings() }, {}, { databases })
  assert.deepEqual(alone.sql, ['-- catalog of alpha: documents=500\n'])
  assert.ok(alone.steps.lastIndexOf('deploy --config') < alone.steps.indexOf('d1 execute'), "after the app's deploy")
  assert.deepEqual((await run({ only: 'alpha', environment: settings() }, {}, { databases, catalogTable: false })).sql, [], 'no tables yet: the gateway step writes it')
  assert.deepEqual((await run({ only: 'alpha', environment: settings() }, {}, { databases: new Map() })).sql, [], 'no gateway database yet')
  assert.deepEqual((await run({ only: 'beta', environment: settings() }, {}, { databases })).sql, ['-- catalog of beta: none\n'], 'an app without limits writes an empty catalog, so one that dropped its limits keeps none')

  // The gateway's own module (in another repository: a module is imported once a path): each app's whole catalog
  // replaced, an app without limits emptied.
  const realRoot = await engineRepository()
  await mkdir(join(realRoot, '.github', 'hosting', 'gateway', 'scripts'), { recursive: true })
  await cp(join(here, '..', 'hosting', 'gateway', 'scripts', 'limits-catalog.mjs'), join(realRoot, '.github', 'hosting', 'gateway', 'scripts', 'limits-catalog.mjs'))
  const [real] = (await run({ root: realRoot, environment: settings({ GATEWAY_SECRET_KEY: key }) })).sql
  assert.match(real, /DELETE FROM app_limit_catalog WHERE app = 'alpha' AND key NOT IN \('documents'\);/)
  assert.match(real, /INSERT INTO app_limit_catalog \(app, key, label, unit, default_value, position, updated_at\) VALUES \('alpha', 'documents', 'Documents', 'count', 500, 0, \d+\)/)
  assert.match(real, /DELETE FROM app_limit_catalog WHERE app = 'beta';/)

  // An older gateway without the module: the catalogs wait.
  await rm(join(root, '.github', 'hosting', 'gateway', 'scripts', 'limits-catalog.mjs'))
  assert.deepEqual((await run({ environment: settings({ GATEWAY_SECRET_KEY: key }) })).sql, [])
})

test('--build-only builds an engine where its app is built: its exact lockfile without scripts, then its Worker bundled by its own Wrangler', async () => {
  const root = await engineRepository()
  const engine = join(root, 'alpha', 'engine')
  const calls = []
  let bundleConfig
  const spawn = (command, args, options) => {
    calls.push([command, ...args, `@${options.cwd}`])
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GATEWAY_SECRET_KEY', 'APP_SECRETS_JSON']) assert.ok(!(name in options.env), `${name} reached the build`)
    if (options.cwd === engine) assert.equal(options.env.NODE_ENV, undefined, "the engine's install keeps its development dependencies")
    if (args[0] === 'deploy') bundleConfig = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'))
    return { status: 0, stdout: '', stderr: '' }
  }
  await deployApps({ root, environment: settings({ GATEWAY_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), APP_SECRETS_JSON: '{}' }), buildOnly: true, only: 'alpha', spawn })
  assert.deepEqual(calls.map((call) => call.join(' ')), [
    `npm ci --ignore-scripts --no-audit --no-fund @${join(root, 'alpha')}`,
    `npm run build @${join(root, 'alpha')}`,
    `npm ci --ignore-scripts --no-audit --no-fund @${engine}`,
    `${join(engine, 'node_modules', '.bin', 'wrangler')} deploy --dry-run --outdir ${join(engine, '.output', 'worker')} --config ${calls[3][6]} @${engine}`,
  ])
  assert.deepEqual(bundleConfig, { name: 'insulin-apps-alpha-engine', main: join(engine, 'src', 'index.ts'), compatibility_date: '2026-10-13', compatibility_flags: ['nodejs_compat'] }, 'bundled without its bindings, containers or anything that deploys')
  assert.equal(existsSync(join(engine, '.output')), false, 'an earlier bundle is removed first')

  // --build-engine: the engine alone, with its own build script when it has one.
  const manifest = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8'))
  await writeFile(join(engine, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, build: 'node build.mjs' } }))
  calls.length = 0
  await deployApps({ root, environment: {}, buildEngine: true, only: 'alpha', spawn })
  assert.deepEqual(calls.map(([command, ...args]) => `${basename(command)} ${args.slice(0, 2).join(' ')}`), ['npm ci --ignore-scripts', 'npm run build', 'wrangler deploy --dry-run'])
})

test("PLT-04: the release's build job builds the image from exactly the files its tag covers, for linux/amd64, and saves it for the deploy", async () => {
  const root = await engineRepository()
  const engine = join(root, 'alpha', 'engine')
  const archive = join(await tempDirectory('deploy-apps-built-image-'), 'image.tar')
  const docker = []
  const spawn = (command, args, options) => {
    if (command === 'docker' && args[0] === 'build') {
      const context = args.at(-1)
      const files = []
      const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(directory, entry.name))
          else files.push(join(directory, entry.name).slice(context.length + 1))
        }
      }
      walk(context)
      docker.push({ args, files: files.sort() })
      assert.ok(!('CLOUDFLARE_API_TOKEN' in options.env))
    } else if (command === 'docker') docker.push({ args })
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = await deployApps({ root, environment: settings(), buildEngine: true, only: 'alpha', engineImage: archive, spawn })
  const tag = engineImageTag(engine)
  assert.equal(result.image.tag, tag)
  assert.deepEqual(docker[0].args.slice(0, 7), ['build', '--platform', 'linux/amd64', '--file', join(engine, 'container', 'Dockerfile'), '--tag', `insulin-apps-alpha-engine:${tag}`])
  assert.deepEqual(docker[0].files, ['requirements.lock', 'server/main.py'], 'the context holds what the Dockerfile copies, not notes.txt or the Worker')
  assert.deepEqual(docker[1].args, ['save', '--output', archive, `insulin-apps-alpha-engine:${tag}`])
  await assert.rejects(() => deployApps({ root, environment: {}, buildEngine: true, only: 'beta', engineImage: archive, spawn }), /--engine-image needs --only and an app with an engine/)
})

test("reads what production runs: a Worker's variable in each live version of its latest deployment, or nothing for a Worker that doesn't exist", async () => {
  const api = engineCloudflareMock({
    workers: {
      'insulin-apps-alpha': { SUGER_ENGINE_API: '2' },
      'insulin-apps-beta': {},
      // A gradual deployment: two versions share the traffic, and one that no longer gets any is left out.
      'insulin-apps-gamma': [{ percentage: 60, vars: { SUGER_ENGINE_API: '1' } }, { percentage: 40, vars: {} }, { percentage: 0, vars: { SUGER_ENGINE_API: '9' } }],
    },
  })
  const read = (worker) => productionVariable({ fetchImpl: api.fetch, apiToken: 'dummy-api-token-value', accountId: 'dummy-account', worker, name: 'SUGER_ENGINE_API' })
  assert.deepEqual(await read('insulin-apps-alpha'), ['2'])
  assert.deepEqual(await read('insulin-apps-beta'), [null])
  assert.deepEqual(await read('insulin-apps-gamma'), ['1', null], 'every live version of the latest deployment, in order')
  assert.equal(await read('insulin-apps-missing'), null)
})

test('versions: every live version in production counts, not the first alone: a second one the pair can\'t serve stops the deploy before any migration', async () => {
  // Before the engine: the app runs two versions, one calling engine API 1 and one calling 2; the new engine serves
  // only 1, so the second would break.
  const root = await engineRepository({ engineApi: 1 })
  await writeFile(join(root, 'alpha', 'engine', 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(engineFixture, 'package.json'), 'utf8')), insulin: { serves: [1, 1] } }))
  const split = engineCloudflareMock({
    workers: { 'insulin-apps-alpha': [{ percentage: 50, vars: { SUGER_ENGINE_API: '1' } }, { percentage: 50, vars: { SUGER_ENGINE_API: '2' } }] },
    buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'],
  })
  const before = engineSpawn(split)
  await assert.rejects(() => deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn: before.spawn, fetchImpl: split.fetch }),
    /The new alpha engine serves engine API 1-1, but the alpha version in production calls 2/)
  assert.deepEqual(before.calls.filter(({ args }) => args[0] === 'deploy' || args[0] === 'd1'), [], 'neither Worker deployed, no database touched')

  // Before the app: once the engine is out, two engine versions share the traffic, one serving 1-2 and one only 1;
  // the app calls 2, so it isn't deployed, and its migrations aren't applied.
  const app = await engineRepository({ engineApi: 2 })
  const tag = engineImageTag(join(app, 'alpha', 'engine'))
  const engines = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'], registry: { [tag]: DIGEST } })
  const { spawn, calls } = engineSpawn(engines)
  const sharing = (command, args, options) => {
    const result = spawn(command, args, options)
    if (args[0] === 'deploy' && basename(args[2]) === 'alpha-engine.wrangler.json') {
      engines.state.workers['insulin-apps-alpha-engine'] = [{ percentage: 90, vars: { SUGER_ENGINE_SERVES: '1-2' } }, { percentage: 10, vars: { SUGER_ENGINE_SERVES: '1-1' } }]
    }
    return result
  }
  await assert.rejects(() => deployApps({ root: app, environment: settings(), skipBuild: true, only: 'alpha', spawn: sharing, fetchImpl: engines.fetch }),
    /The alpha engine in production serves engine API 1-1, but this alpha calls 2, so it isn't deployed/)
  assert.deepEqual(deploys(calls), ['alpha-engine.wrangler.json'], 'the engine went, the app did not')
  assert.deepEqual(calls.filter(({ args }) => args[0] === 'd1' && args.includes('insulin-apps-alpha')), [], "nor the app's database or migrations")
})

test('the registry: a tag resolves to its digest through the token step, a missing one is null, and credentials go only to Cloudflare', async () => {
  const api = engineCloudflareMock({ registry: { 'inputs-a': DIGEST } })
  const lookup = (tag, fetchImpl = api.fetch) => registryDigest({ fetchImpl, credential: { username: 'v1', password: 'dummy-registry-password' }, accountId: 'dummy-account', repository: 'insulin-apps-alpha-engine', tag })
  assert.equal(await lookup('inputs-a'), DIGEST)
  assert.equal(await lookup('inputs-b'), null)
  const elsewhere = async (input) => {
    if (new URL(input).hostname !== 'registry.cloudflare.com') assert.fail('the credential left Cloudflare')
    return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://tokens.example.com/token",service="x"' } })
  }
  await assert.rejects(() => lookup('inputs-a', elsewhere), /a token from somewhere other than Cloudflare/)
  const noDigest = async () => new Response(null, { status: 200 })
  await assert.rejects(() => lookup('inputs-a', noDigest), /gave no digest/)
})

test("an engine's bucket is created only when missing and must exist after; a registry credential must come back", async () => {
  const cloudflare = (api) => ({ fetchImpl: api.fetch, apiToken: 'dummy-api-token-value', accountId: 'dummy-account' })
  const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files'] })
  assert.equal(await ensureBucket({ ...cloudflare(api), name: 'insulin-apps-alpha-engine-files' }), false, 'already there')
  assert.equal(await ensureBucket({ ...cloudflare(api), name: 'insulin-apps-alpha-engine-backups' }), true, 'created')
  assert.ok(api.state.buckets.has('insulin-apps-alpha-engine-backups'))
  // A creation Cloudflare accepts but that doesn't show: the deploy stops.
  const forgetful = async (input, init = {}) => (init.method === 'POST' ? response({ success: true, errors: [], result: {} }) : response({ success: false, errors: [], result: null }, 404))
  await assert.rejects(() => ensureBucket({ fetchImpl: forgetful, apiToken: 'dummy-api-token-value', accountId: 'dummy-account', name: 'insulin-apps-alpha-engine-files' }), /missing after its creation/)
  const credential = await registryCredential(cloudflare(engineCloudflareMock()))
  assert.deepEqual(credential, { username: 'v1', password: 'dummy-registry-password' })
  const empty = async () => response({ success: true, errors: [], result: {} })
  await assert.rejects(() => registryCredential({ fetchImpl: empty, apiToken: 'dummy-api-token-value', accountId: 'dummy-account' }), /no registry credential/)
})

test('an engine without a container has no image: nothing to build or push, and the deployed config has no containers', async () => {
  const root = await engineRepository()
  const engine = join(root, 'alpha', 'engine')
  const text = readFileSync(join(engine, 'wrangler.jsonc'), 'utf8')
  await writeFile(join(engine, 'wrangler.jsonc'), text.replace(/"containers": \[[\s\S]*?\],\n/, ''))
  const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'] })
  const { spawn, calls } = engineSpawn(api)
  const result = await deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn, fetchImpl: api.fetch })
  temporary.push(result.outputDirectory)
  assert.equal(api.state.requests.some(({ url }) => url.pathname.includes('/containers/registries/')), false, 'no registry credential asked for')
  assert.equal('containers' in JSON.parse(readFileSync(join(result.outputDirectory, 'apps', 'alpha-engine.wrangler.json'), 'utf8')), false)
  assert.deepEqual(deploys(calls), ['alpha-engine.wrangler.json', 'alpha.wrangler.json'])
  await assert.rejects(() => deployApps({ root, environment: {}, buildEngine: true, only: 'alpha', engineImage: join(root, 'image.tar'), spawn: () => ({ status: 0, stdout: '', stderr: '' }) }), /has no container image to build/)
})

test("every Wrangler command for an engine names its config: inside the app, Wrangler would follow the app's generated .wrangler/deploy/config.json", async () => {
  const root = await engineRepository()
  // What `npm run build` leaves in the app: a redirect to Nitro's config, which Wrangler follows when given no --config.
  await mkdir(join(root, 'alpha', '.wrangler', 'deploy'), { recursive: true })
  await writeFile(join(root, 'alpha', '.wrangler', 'deploy', 'config.json'), '{"configPath":"../../.output/server/wrangler.json"}')
  const engine = join(root, 'alpha', 'engine')
  const wranglerCalls = []
  const watch = (spawn) => (command, args, options) => {
    if (basename(command) === 'wrangler') wranglerCalls.push({ command, args, cwd: options.cwd })
    return spawn(command, args, options)
  }
  const named = ({ args }) => {
    const at = args.indexOf('--config')
    return at > 0 && isAbsolute(args[at + 1]) && !args[at + 1].includes(`${join('alpha', '.wrangler')}`)
  }

  // The build: the engine bundled by its own Wrangler, from inside the engine directory.
  await deployApps({ root, environment: {}, buildEngine: true, only: 'alpha', spawn: watch(() => ({ status: 0, stdout: '', stderr: '' })) })
  assert.equal(wranglerCalls.length, 1)
  assert.equal(wranglerCalls[0].cwd, engine)
  assert.ok(named(wranglerCalls[0]), wranglerCalls[0].args.join(' '))

  // The deploy: the engine's Worker, and everything else the app's job runs.
  await mkdir(join(engine, '.output', 'worker'), { recursive: true })
  await writeFile(join(engine, '.output', 'worker', 'index.js'), 'export default {}\n')
  wranglerCalls.length = 0
  const tag = engineImageTag(engine)
  const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'], registry: { [tag]: DIGEST } })
  const result = await deployApps({ root, environment: settings(), skipBuild: true, only: 'alpha', spawn: watch(engineSpawn(api).spawn), fetchImpl: api.fetch })
  temporary.push(result.outputDirectory)
  const engineDeploy = wranglerCalls.find(({ args }) => args[0] === 'deploy' && args.includes(join(result.outputDirectory, 'apps', 'alpha-engine.wrangler.json')))
  assert.ok(engineDeploy, 'the engine was deployed from the config the deploy wrote')
  for (const call of wranglerCalls) {
    // Listing and creating databases read no Worker config, and run from the repository's root, outside every app.
    if (call.args[0] === 'd1' && ['list', 'create'].includes(call.args[1])) assert.equal(call.cwd, root, call.args.join(' '))
    else assert.ok(named(call), call.args.join(' '))
  }
})

test("a deploy of the app alone writes its catalog right after its Worker, before the public-access check, which may then fail", async () => {
  const root = await engineRepository()
  await limitCatalogModule(root)
  const events = []
  const api = engineCloudflareMock({ domains: [{ id: 'beta-domain', hostname: 'beta.apps.example.com', service: 'insulin-apps-beta', stuck: true }] })
  const fetchImpl = async (input, init) => {
    if (new URL(input).pathname.endsWith('/workers/domains')) events.push('public access')
    return api.fetch(input, init)
  }
  const { spawn } = engineSpawn(api, { databases: new Map([['insulin-apps-gateway', 'fixture-gateway-db'], ['insulin-apps-beta', 'fixture-beta-db']]) })
  const watched = (command, args, options) => {
    if (args[0] === 'deploy') events.push('deploy')
    if (args[1] === 'execute' && !args.includes('--json')) events.push(`catalog: ${args[args.indexOf('--command') + 1].trim()}`)
    return spawn(command, args, options)
  }
  await assert.rejects(() => deployApps({ root, environment: settings(), skipBuild: true, only: 'beta', spawn: watched, fetchImpl }), /Worker insulin-apps-beta still has public access/)
  assert.deepEqual(events.slice(0, 3), ['deploy', 'catalog: -- catalog of beta: none', 'public access'], 'the version that now runs has its catalog')
})

test("the app's public access is removed whatever happens to its catalog, and both failures are reported", async () => {
  const root = await engineRepository()
  await limitCatalogModule(root)
  const databases = new Map([['insulin-apps-gateway', 'fixture-gateway-db'], ['insulin-apps-beta', 'fixture-beta-db']])
  const attempt = async (domains) => {
    const api = engineCloudflareMock({ domains })
    const { spawn } = engineSpawn(api, { databases })
    // The catalog's write fails, as when D1 refuses it.
    const failing = (command, args, options) => (args[1] === 'execute' && !args.includes('--json') ? { status: 1, stdout: '', stderr: 'D1 refused the query' } : spawn(command, args, options))
    const outcome = await deployApps({ root, environment: settings(), skipBuild: true, only: 'beta', spawn: failing, fetchImpl: api.fetch }).then(() => null, (error) => error)
    return { outcome, checked: api.state.requests.some(({ url }) => url.pathname.endsWith('/workers/scripts/insulin-apps-beta/subdomain')) }
  }
  const quiet = await attempt([])
  assert.ok(quiet.checked, "the Worker's public access was checked after the catalog failed")
  assert.match(quiet.outcome?.message ?? '', /wrangler d1 execute failed/, 'and the catalog failure fails the deploy')
  const exposed = await attempt([{ id: 'beta-domain', hostname: 'beta.apps.example.com', service: 'insulin-apps-beta', stuck: true }])
  assert.match(exposed.outcome?.message ?? '', /Worker insulin-apps-beta still has public access after cleanup/)
  assert.match(exposed.outcome.message, /wrangler d1 execute failed/, 'naming the catalog failure too')
})

test("a catalog the gateway's module refuses stops the deploy before any Worker or migration", async () => {
  const root = await engineRepository()
  const scripts = join(root, '.github', 'hosting', 'gateway', 'scripts')
  await mkdir(scripts, { recursive: true })
  await writeFile(join(scripts, 'limits-catalog.mjs'), [
    'export function limitsCatalogSql(apps) {',
    "  if (apps.some(({ name }) => name === 'alpha')) throw new Error('Malformed limit catalog:\\nalpha: insulin.limits[0].label must be 1 to 80 characters on one line')",
    "  return ''",
    '}',
    '',
  ].join('\n'))
  for (const options of [{ only: 'alpha', environment: settings() }, { environment: settings({ GATEWAY_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') }) }, { gatewayOnly: true, environment: settings({ DEPLOYED_APPS: '["alpha"]' }) }]) {
    const api = engineCloudflareMock({ buckets: ['insulin-apps-alpha-engine-files', 'insulin-apps-alpha-engine-backups'] })
    const { spawn, calls } = engineSpawn(api, { databases: new Map([['insulin-apps-gateway', 'fixture-gateway-db']]) })
    await assert.rejects(() => deployApps({ root, skipBuild: true, spawn, fetchImpl: api.fetch, ...options }), /Malformed limit catalog/, JSON.stringify(options).slice(0, 60))
    assert.deepEqual(calls.filter(({ args }) => args[0] === 'deploy' || args[1] === 'migrations'), [], 'nothing deployed or migrated')
  }
})
