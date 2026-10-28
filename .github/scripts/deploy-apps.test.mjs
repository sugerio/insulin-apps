import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNoSiteEnvSecret,
  deployApps,
  emailAddress,
  parseArguments,
  readSettings,
  removeAppPublicAccess,
  sanitizeAppBaseConfig,
  verifyBuildOutput,
} from './deploy-apps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'apps')
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
  assert.deepEqual(alpha.vars, { SUGER_ACCESS_MODE: 'console' })
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
  assert.deepEqual(gateway.triggers, { crons: ['17 3 * * *'] })
  assert.deepEqual(gateway.ratelimits, [
    { name: 'RL_AUTH', namespace_id: '730101', simple: { limit: 20, period: 60 } },
    { name: 'RL_APP', namespace_id: '730102', simple: { limit: 600, period: 60 } },
  ])
  assert.equal(gateway.vars.SITE_APPS[0].source, 'https://github.com/sugerio/insulin-apps/tree/main/alpha-app')
  assert.ok(!('SITE_ENV' in gateway.vars))

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
  assert.match(summaryText, /https:\/\/auth\.apps\.example\.com/)
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

test('--build-only builds every app without any deploy setting reaching the build', async () => {
  const root = await fixtureRepository()
  const commands = []
  const spawn = (command, args, options) => {
    commands.push([command, ...args])
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY']) {
      assert.ok(!(name in options.env), `${name} reached the build`)
    }
    assert.equal(options.env.NITRO_PRESET, 'cloudflare_module')
    return { status: 0, stdout: '', stderr: '' }
  }

  const result = await deployApps({ root, environment: settings(), buildOnly: true, spawn })
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
})
