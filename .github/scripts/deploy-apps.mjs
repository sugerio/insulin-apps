#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listApps } from './list-apps.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..')
const GATEWAY_NAME = 'insulin-apps-gateway'
const COMPATIBILITY_DATE = '2026-10-13'
const GATEWAY_REQUIRED_SETTINGS = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'EMAIL_FROM']
const SECRET_SETTINGS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY']
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const APP_CONFIG_KEYS = new Set(['compatibility_date', 'compatibility_flags', 'rules', 'no_bundle', 'assets'])
const APP_ASSET_KEYS = new Set(['binding', 'html_handling', 'not_found_handling', 'run_worker_first'])
const APP_RULE_KEYS = new Set(['type', 'globs', 'fallthrough'])
const ALLOWED_COMPATIBILITY_FLAGS = new Set(['nodejs_compat'])
// Rate limit namespaces are shared across the account: distinctive ids keep these counters apart from other Workers.
const RATE_LIMITS = [
  { name: 'RL_AUTH', namespace_id: '730101', simple: { limit: 20, period: 60 } },
  { name: 'RL_APP', namespace_id: '730102', simple: { limit: 600, period: 60 } },
]

export function readSettings(environment = process.env, { gateway = true } = {}) {
  const token = environment.CLOUDFLARE_API_TOKEN?.trim() ?? ''
  if (!token) return { skip: true }

  const required = ['CLOUDFLARE_ACCOUNT_ID', ...(gateway ? GATEWAY_REQUIRED_SETTINGS : [])]
  const missing = required.filter((name) => !environment[name]?.trim())
  if (gateway && environment.GOOGLE_CLIENT_ID?.trim() && !environment.GOOGLE_CLIENT_SECRET?.trim()) {
    missing.push('GOOGLE_CLIENT_SECRET')
  }
  if (missing.length) throw new Error(`Missing required deploy settings: ${missing.join(', ')}`)

  const settings = {
    skip: false,
    cloudflareApiToken: token,
    cloudflareAccountId: environment.CLOUDFLARE_ACCOUNT_ID.trim(),
    siteDomain: environment.SITE_DOMAIN?.trim() || 'insulinapps.com',
  }
  if (!gateway) return settings

  Object.assign(settings, {
    googleClientId: environment.GOOGLE_CLIENT_ID?.trim() ?? '',
    googleClientSecret: environment.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    turnstileSiteKey: environment.TURNSTILE_SITE_KEY.trim(),
    turnstileSecretKey: environment.TURNSTILE_SECRET_KEY.trim(),
    emailFrom: environment.EMAIL_FROM.trim(),
    supportEmail: environment.SUPPORT_EMAIL?.trim() ?? '',
  })
  settings.senderAddress = emailAddress(settings.emailFrom)
  return settings
}

export function emailAddress(value) {
  const angle = value.match(/<([^<>]+)>\s*$/)
  const address = (angle ? angle[1] : value).trim()
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw new Error('EMAIL_FROM must be an email address or Name <address>')
  return address
}

export function buildAppConfig({ appDirectory, app, databaseId, baseConfig = {} }) {
  const outputDirectory = join(appDirectory, '.output')
  const { config: generatedConfig, ignoredKeys } = sanitizeAppBaseConfig(baseConfig)
  if (ignoredKeys.length) {
    process.stdout.write(`Ignored generated Wrangler config keys for ${app.name}: ${ignoredKeys.join(', ')}\n`)
  }
  const config = {
    ...generatedConfig,
    name: workerName(app.name),
    main: resolve(outputDirectory, 'server', 'index.mjs'),
    assets: {
      ...(generatedConfig.assets ?? {}),
      directory: resolve(outputDirectory, 'public'),
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: workerName(app.name),
        ...(databaseId ? { database_id: databaseId } : {}),
        migrations_dir: resolve(appDirectory, 'src', 'app', 'db', 'migrations'),
      },
    ],
    vars: { SUGER_ACCESS_MODE: 'console' },
    workers_dev: false,
    preview_urls: false,
  }
  return config
}

export function sanitizeAppBaseConfig(baseConfig) {
  if (!baseConfig || typeof baseConfig !== 'object' || Array.isArray(baseConfig)) {
    throw new Error('Generated Wrangler config must be a JSON object')
  }

  const config = {}
  const ignoredKeys = Object.keys(baseConfig).filter((key) => !APP_CONFIG_KEYS.has(key))

  if ('compatibility_date' in baseConfig) {
    const value = baseConfig.compatibility_date
    if (!isDate(value)) throw new Error('Generated compatibility_date must use YYYY-MM-DD')
    config.compatibility_date = value
  }

  if ('compatibility_flags' in baseConfig) {
    const flags = baseConfig.compatibility_flags
    if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== 'string')) {
      throw new Error('Generated compatibility_flags must be an array of strings')
    }
    const unsupported = [...new Set(flags.filter((flag) => !ALLOWED_COMPATIBILITY_FLAGS.has(flag)))]
    if (unsupported.length) throw new Error(`Unsupported generated compatibility_flags: ${unsupported.join(', ')}`)
    config.compatibility_flags = [...flags]
  }

  if ('rules' in baseConfig) {
    if (!Array.isArray(baseConfig.rules)) throw new Error('Generated rules must be an array')
    config.rules = baseConfig.rules.map((rule, index) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new Error(`Generated rules[${index}] must be an object`)
      }
      if (typeof rule.type !== 'string' || !Array.isArray(rule.globs) || rule.globs.some((glob) => typeof glob !== 'string')) {
        throw new Error(`Generated rules[${index}] must have a string type and string globs`)
      }
      if ('fallthrough' in rule && typeof rule.fallthrough !== 'boolean') {
        throw new Error(`Generated rules[${index}].fallthrough must be a boolean`)
      }
      for (const key of Object.keys(rule)) {
        if (!APP_RULE_KEYS.has(key)) ignoredKeys.push(`rules[].${key}`)
      }
      return {
        type: rule.type,
        globs: [...rule.globs],
        ...('fallthrough' in rule ? { fallthrough: rule.fallthrough } : {}),
      }
    })
  }

  if ('no_bundle' in baseConfig) {
    if (typeof baseConfig.no_bundle !== 'boolean') throw new Error('Generated no_bundle must be a boolean')
    config.no_bundle = baseConfig.no_bundle
  }

  if ('assets' in baseConfig) {
    const assets = baseConfig.assets
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
      throw new Error('Generated assets must be an object')
    }
    const allowedAssets = {}
    for (const [key, value] of Object.entries(assets)) {
      if (!APP_ASSET_KEYS.has(key)) {
        ignoredKeys.push(`assets.${key}`)
        continue
      }
      const expectedType = key === 'run_worker_first' ? 'boolean' : 'string'
      if (typeof value !== expectedType) throw new Error(`Generated assets.${key} must be a ${expectedType}`)
      allowedAssets[key] = value
    }
    config.assets = allowedAssets
  }

  return { config, ignoredKeys: [...new Set(ignoredKeys)].sort() }
}

export function buildGatewayConfig({ root, apps, settings, databaseId }) {
  const gatewayDirectory = join(root, '.github', 'hosting', 'gateway')
  const siteApps = apps.map((app) => ({
    ...app,
    binding: serviceBinding(app.name),
    source: `https://github.com/sugerio/insulin-apps/tree/main/${app.name}`,
  }))

  return {
    name: GATEWAY_NAME,
    main: resolve(gatewayDirectory, 'src', 'index.ts'),
    compatibility_date: COMPATIBILITY_DATE,
    workers_dev: false,
    preview_urls: false,
    routes: [
      settings.siteDomain,
      `www.${settings.siteDomain}`,
      `auth.${settings.siteDomain}`,
      ...apps.map(({ name }) => `${name}.${settings.siteDomain}`),
    ].map(
      (pattern) => ({ pattern, custom_domain: true }),
    ),
    services: apps.map(({ name }) => ({ binding: serviceBinding(name), service: workerName(name) })),
    d1_databases: [
      {
        binding: 'DB',
        database_name: GATEWAY_NAME,
        ...(databaseId ? { database_id: databaseId } : {}),
        migrations_dir: resolve(gatewayDirectory, 'migrations'),
      },
    ],
    send_email: [{ name: 'EMAIL', allowed_sender_addresses: [settings.senderAddress] }],
    ratelimits: RATE_LIMITS,
    // The daily run of the gateway's cleanup of expired sessions, tokens and mail records, for quiet days.
    triggers: { crons: ['17 3 * * *'] },
    vars: {
      SITE_DOMAIN: settings.siteDomain,
      SITE_APPS: siteApps,
      GOOGLE_CLIENT_ID: settings.googleClientId,
      TURNSTILE_SITE_KEY: settings.turnstileSiteKey,
      EMAIL_FROM: settings.emailFrom,
      SUPPORT_EMAIL: settings.supportEmail,
    },
  }
}

export async function deployApps({
  root = REPOSITORY_ROOT,
  environment = process.env,
  dryRun = false,
  skipBuild = false,
  buildOnly = false,
  gatewayOnly = false,
  only,
  out,
  spawn = spawnSync,
  fetchImpl = globalThis.fetch,
} = {}) {
  root = resolve(root)
  if (buildOnly) {
    // The workflow builds in a job that has no deploy settings, so app build scripts never see a secret.
    const { selectedApps } = await findApps(root, only)
    buildApps(new CommandRunner({ dryRun, spawn, secrets: [] }), root, selectedApps, environment)
    return { skipped: false, built: selectedApps.map(({ name }) => name) }
  }

  const deployGateway = gatewayOnly || !only
  const deployAppWorkers = !gatewayOnly
  const settings = readSettings(environment, { gateway: deployGateway })
  if (settings.skip) {
    process.stdout.write('::notice::Deploy is not configured; skipping\n')
    return { skipped: true }
  }

  const { apps, selectedApps } = await findApps(root, only)
  const appsToDeploy = deployAppWorkers ? selectedApps : []

  const outputDirectory = out ? resolve(out) : mkdtempSync(join(tmpdir(), 'insulin-apps-deploy-'))
  if (appsToDeploy.length) mkdirSync(join(outputDirectory, 'apps'), { recursive: true })

  const wrangler = resolve(root, '.github', 'hosting', 'gateway', 'node_modules', '.bin', 'wrangler')
  const childEnvironment = {
    ...environment,
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_API_TOKEN: settings.cloudflareApiToken,
    CLOUDFLARE_ACCOUNT_ID: settings.cloudflareAccountId,
  }
  delete childEnvironment.GOOGLE_CLIENT_SECRET
  delete childEnvironment.TURNSTILE_SECRET_KEY

  const runner = new CommandRunner({
    dryRun,
    spawn,
    secrets: [settings.cloudflareApiToken, settings.googleClientSecret, settings.turnstileSecretKey].filter(Boolean),
  })

  if (!skipBuild) buildApps(runner, root, appsToDeploy, environment)

  if (!dryRun) {
    requirePath(wrangler, 'the gateway Wrangler executable')
    if (deployGateway) {
      requirePath(join(root, '.github', 'hosting', 'gateway', 'src', 'index.ts'), 'the gateway entry point')
      requirePath(join(root, '.github', 'hosting', 'gateway', 'migrations'), 'the gateway migrations directory')
    }
  }

  const baseConfigs = new Map()
  for (const app of appsToDeploy) {
    const appDirectory = join(root, app.name)
    const outputExists = existsSync(join(appDirectory, '.output'))
    if (outputExists) verifyBuildOutput(appDirectory)
    else if (!dryRun) throw new Error(`Missing ${app.name} build output: ${join(appDirectory, '.output')}`)
    const baseConfig = readNitroConfig(appDirectory, dryRun)
    sanitizeAppBaseConfig(baseConfig)
    baseConfigs.set(app.name, baseConfig)
    if (!dryRun) {
      requirePath(join(appDirectory, 'src', 'app', 'db', 'migrations'), `the ${app.name} migrations directory`)
    }
  }

  for (const app of appsToDeploy) {
    const appDirectory = join(root, app.name)
    const configPath = join(outputDirectory, 'apps', `${app.name}.wrangler.json`)
    const baseConfig = baseConfigs.get(app.name)
    let databaseId

    if (dryRun) {
      recordDatabasePlan(runner, wrangler, workerName(app.name), root, childEnvironment)
    } else {
      databaseId = ensureDatabase(runner, wrangler, workerName(app.name), root, childEnvironment)
    }

    writeJson(configPath, buildAppConfig({ appDirectory, app, databaseId, baseConfig }))
    runner.run(wrangler, ['d1', 'migrations', 'apply', workerName(app.name), '--remote', '--config', configPath], {
      cwd: root,
      env: childEnvironment,
    })
    runner.run(wrangler, ['deploy', '--config', configPath], { cwd: root, env: childEnvironment })
    if (dryRun) {
      runner.record('cloudflare-api', ['remove-and-verify-public-access', workerName(app.name)], {
        environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SITE_DOMAIN'],
      })
    } else {
      await removeAppPublicAccess({
        fetchImpl,
        apiToken: settings.cloudflareApiToken,
        accountId: settings.cloudflareAccountId,
        siteDomain: settings.siteDomain,
        worker: workerName(app.name),
      })
    }
  }

  if (deployGateway) {
    const gatewayConfigPath = join(outputDirectory, 'gateway.wrangler.json')
    let gatewayDatabaseId
    if (dryRun) {
      recordDatabasePlan(runner, wrangler, GATEWAY_NAME, root, childEnvironment)
    } else {
      gatewayDatabaseId = ensureDatabase(runner, wrangler, GATEWAY_NAME, root, childEnvironment)
    }
    writeJson(gatewayConfigPath, buildGatewayConfig({ root, apps, settings, databaseId: gatewayDatabaseId }))
    runner.run(wrangler, ['d1', 'migrations', 'apply', GATEWAY_NAME, '--remote', '--config', gatewayConfigPath], {
      cwd: root,
      env: childEnvironment,
    })

    // The secrets travel with the deploy itself, so no gateway version ever runs without them.
    const secretValues = {
      ...(settings.googleClientId ? { GOOGLE_CLIENT_SECRET: settings.googleClientSecret } : {}),
      TURNSTILE_SECRET_KEY: settings.turnstileSecretKey,
    }
    const gatewayDeploy = (secretFile) => ['deploy', '--config', gatewayConfigPath, '--secrets-file', secretFile]
    if (dryRun) {
      runner.run(wrangler, gatewayDeploy('<redacted-secret-file>'), { cwd: root, env: childEnvironment, sensitive: true })
    } else {
      const secretDirectory = mkdtempSync(join(tmpdir(), 'insulin-apps-secrets-'))
      const secretFile = join(secretDirectory, 'secrets.json')
      try {
        writeFileSync(secretFile, `${JSON.stringify(secretValues)}\n`, { mode: 0o600 })
        chmodSync(secretFile, 0o600)
        runner.run(wrangler, gatewayDeploy(secretFile), {
          cwd: root,
          env: childEnvironment,
          recordArgs: gatewayDeploy('<redacted-secret-file>'),
          sensitive: true,
        })
      } finally {
        rmSync(secretDirectory, { recursive: true, force: true })
      }
    }
    const secretList = runner.run(wrangler, ['secret', 'list', '--config', gatewayConfigPath], {
      cwd: root,
      env: childEnvironment,
      capture: true,
    })
    if (!dryRun) assertNoSiteEnvSecret(secretList.stdout)
  }

  if (dryRun) {
    writeJson(join(outputDirectory, 'plan.json'), {
      dryRun: true,
      apps: appsToDeploy.map(({ name }) => name),
      gateway: deployGateway,
      commands: runner.plan,
    })
  }
  writeSummary(environment.GITHUB_STEP_SUMMARY, settings.siteDomain, deployGateway ? apps : appsToDeploy)

  return { skipped: false, apps, selectedApps: appsToDeploy, gateway: deployGateway, outputDirectory, commands: runner.plan }
}

class CommandRunner {
  constructor({ dryRun, spawn, secrets }) {
    this.dryRun = dryRun
    this.spawn = spawn
    this.secrets = secrets
    this.plan = []
  }

  run(command, args, { cwd, env, condition, capture = false, recordArgs = args, sensitive = false } = {}) {
    this.record(command, recordArgs, {
      cwd,
      ...(condition ? { condition } : {}),
      ...(command.endsWith('wrangler') ? { environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] } : {}),
      ...(sensitive ? { input: '<redacted>' } : {}),
    })
    if (this.dryRun || condition) return { stdout: '', stderr: '' }

    const result = this.spawn(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) throw new Error(`Could not run ${basename(command)}: ${result.error.message}`)
    const stdout = redact(result.stdout ?? '', this.secrets)
    const stderr = redact(result.stderr ?? '', this.secrets)
    if (result.status !== 0) {
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      throw new Error(`${basename(command)} ${args.slice(0, 2).join(' ')} failed with exit code ${result.status}`)
    }
    if (!capture) {
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    }
    return { stdout, stderr }
  }

  record(command, args, details = {}) {
    this.plan.push({
      command,
      args,
      ...details,
    })
  }
}

async function findApps(root, only) {
  const apps = await listApps(root)
  if (!apps.length) throw new Error('No apps were found')
  if (only && !apps.some(({ name }) => name === only)) throw new Error(`Unknown app for --only: ${only}`)
  return { apps, selectedApps: only ? apps.filter(({ name }) => name === only) : apps }
}

function buildApps(runner, root, apps, environment) {
  const env = { ...environment, NODE_ENV: 'production', NITRO_PRESET: 'cloudflare_module' }
  for (const name of SECRET_SETTINGS) delete env[name]
  for (const app of apps) {
    const cwd = join(root, app.name)
    runner.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, env })
    runner.run('npm', ['run', 'build'], { cwd, env })
  }
}

function recordDatabasePlan(runner, wrangler, databaseName, cwd, env) {
  runner.run(wrangler, ['d1', 'list', '--json'], { cwd, env })
  const condition = `${databaseName} is absent from d1 list`
  runner.run(wrangler, ['d1', 'create', databaseName], { cwd, env, condition })
  runner.run(wrangler, ['d1', 'list', '--json'], { cwd, env, condition: `after creating ${databaseName}` })
}

function ensureDatabase(runner, wrangler, databaseName, cwd, env) {
  let databases = listDatabases(runner, wrangler, cwd, env)
  let database = databases.find(({ name }) => name === databaseName)
  if (!database) {
    runner.run(wrangler, ['d1', 'create', databaseName], { cwd, env, capture: true })
    process.stdout.write(`Created D1 database ${databaseName}\n`)
    databases = listDatabases(runner, wrangler, cwd, env)
    database = databases.find(({ name }) => name === databaseName)
  }
  if (!database?.uuid) throw new Error(`D1 database ${databaseName} has no UUID after creation`)
  return database.uuid
}

function listDatabases(runner, wrangler, cwd, env) {
  const { stdout } = runner.run(wrangler, ['d1', 'list', '--json'], { cwd, env, capture: true })
  try {
    const databases = JSON.parse(stdout)
    if (!Array.isArray(databases)) throw new Error()
    return databases
  } catch {
    throw new Error('Wrangler returned invalid JSON from d1 list --json')
  }
}

export function verifyBuildOutput(appDirectory) {
  const outputDirectory = join(appDirectory, '.output')
  const files = []
  const pending = [outputDirectory]

  while (pending.length) {
    const path = pending.pop()
    let status
    try {
      status = lstatSync(path)
    } catch {
      throw new Error(`Missing build output path: ${path}`)
    }
    if (status.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name))
    } else if (status.isFile()) {
      files.push({ path, status })
    } else {
      throw new Error(`Unsafe build output path is not a regular file or directory: ${path}`)
    }
  }

  const linksInside = new Map()
  for (const { status } of files) {
    const key = `${status.dev}:${status.ino}`
    linksInside.set(key, (linksInside.get(key) ?? 0) + 1)
  }
  for (const { path, status } of files) {
    const key = `${status.dev}:${status.ino}`
    if (status.nlink !== linksInside.get(key)) {
      throw new Error(`Unsafe build output file has a hard link outside .output: ${path}`)
    }
  }

  requireFile(join(outputDirectory, 'server', 'index.mjs'), 'Worker entry point')
  requireDirectory(join(outputDirectory, 'public'), 'asset directory')
}

export async function removeAppPublicAccess({ fetchImpl, apiToken, accountId, siteDomain, worker }) {
  if (typeof fetchImpl !== 'function') throw new Error('Cloudflare API fetch is unavailable')
  const account = encodeURIComponent(accountId)
  const script = encodeURIComponent(worker)
  const domainPath = `/accounts/${account}/workers/domains?service=${script}`
  const subdomainPath = `/accounts/${account}/workers/scripts/${script}/subdomain`
  const zones = await listCloudflareResults(fetchImpl, apiToken, `/zones?name=${encodeURIComponent(siteDomain)}`)
  const matchingZones = zones.filter((zone) => zone?.name === siteDomain && typeof zone.id === 'string')
  if (matchingZones.length !== 1) {
    throw new Error(`Cloudflare zone lookup for ${siteDomain} returned ${matchingZones.length} exact matches`)
  }
  const zone = encodeURIComponent(matchingZones[0].id)
  const routePath = `/zones/${zone}/workers/routes`

  const domains = await listCloudflareResults(fetchImpl, apiToken, domainPath)
  for (const domain of domains) {
    if (!domain || typeof domain.id !== 'string' || typeof domain.hostname !== 'string') {
      throw new Error('Cloudflare returned an invalid Worker custom domain')
    }
    await cloudflareRequest(fetchImpl, apiToken, `/accounts/${account}/workers/domains/${encodeURIComponent(domain.id)}`, {
      method: 'DELETE',
    })
    process.stdout.write(`Removed app Worker custom domain: ${domain.hostname}\n`)
  }

  const routes = await listCloudflareResults(fetchImpl, apiToken, routePath)
  for (const route of routes.filter((candidate) => candidate?.script === worker)) {
    if (typeof route.id !== 'string' || typeof route.pattern !== 'string') {
      throw new Error('Cloudflare returned an invalid Worker route')
    }
    await cloudflareRequest(fetchImpl, apiToken, `${routePath}/${encodeURIComponent(route.id)}`, { method: 'DELETE' })
    process.stdout.write(`Removed app Worker route: ${route.pattern}\n`)
  }

  const subdomain = await cloudflareResult(fetchImpl, apiToken, subdomainPath)
  assertSubdomainResult(subdomain)
  if (subdomain.enabled || subdomain.previews_enabled) {
    await cloudflareRequest(fetchImpl, apiToken, subdomainPath, {
      method: 'POST',
      body: { enabled: false, previews_enabled: false },
    })
    process.stdout.write('Disabled app Worker workers.dev and preview URLs\n')
  }

  const remainingDomains = await listCloudflareResults(fetchImpl, apiToken, domainPath)
  const remainingRoutes = (await listCloudflareResults(fetchImpl, apiToken, routePath))
    .filter((candidate) => candidate?.script === worker)
  const remainingSubdomain = await cloudflareResult(fetchImpl, apiToken, subdomainPath)
  assertSubdomainResult(remainingSubdomain)
  if (remainingDomains.length || remainingRoutes.length || remainingSubdomain.enabled || remainingSubdomain.previews_enabled) {
    throw new Error('App Worker still has public access after cleanup')
  }
}

export function assertNoSiteEnvSecret(output) {
  let secrets
  try {
    secrets = JSON.parse(output)
  } catch {
    throw new Error('Wrangler returned invalid JSON from secret list')
  }
  if (!Array.isArray(secrets) || secrets.some((secret) => !secret || typeof secret.name !== 'string')) {
    throw new Error('Wrangler returned an invalid secret list')
  }
  if (secrets.some(({ name }) => name === 'SITE_ENV')) {
    throw new Error('Remote gateway secret SITE_ENV is forbidden; delete it with `wrangler secret delete SITE_ENV`')
  }
}

async function listCloudflareResults(fetchImpl, apiToken, path) {
  const results = []
  let page = 1
  while (true) {
    const separator = path.includes('?') ? '&' : '?'
    const envelope = await cloudflareRequest(fetchImpl, apiToken, `${path}${separator}page=${page}&per_page=100`)
    if (!Array.isArray(envelope.result)) throw new Error(`Cloudflare API returned a non-list result for ${path.split('?')[0]}`)
    results.push(...envelope.result)
    const totalPages = envelope.result_info?.total_pages
    if (totalPages === undefined) break
    if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages < page) {
      throw new Error('Cloudflare API returned invalid pagination')
    }
    if (page >= totalPages) break
    page += 1
  }
  return results
}

async function cloudflareResult(fetchImpl, apiToken, path) {
  return (await cloudflareRequest(fetchImpl, apiToken, path)).result
}

async function cloudflareRequest(fetchImpl, apiToken, path, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new Error(`Cloudflare API request failed for ${method} ${path.split('?')[0]}: ${error.message}`)
  }

  let envelope
  try {
    envelope = await response.json()
  } catch {
    throw new Error(`Cloudflare API returned invalid JSON for ${method} ${path.split('?')[0]}`)
  }
  if (!response.ok || !envelope || envelope.success !== true || !Object.hasOwn(envelope, 'result')) {
    const errors = Array.isArray(envelope?.errors)
      ? envelope.errors.map((error) => error?.message || error?.code).filter(Boolean).join('; ')
      : ''
    throw new Error(`Cloudflare API rejected ${method} ${path.split('?')[0]}${errors ? `: ${errors}` : ''}`)
  }
  return envelope
}

function assertSubdomainResult(result) {
  if (!result || typeof result.enabled !== 'boolean' || typeof result.previews_enabled !== 'boolean') {
    throw new Error('Cloudflare returned an invalid Worker subdomain status')
  }
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function readNitroConfig(appDirectory, dryRun) {
  const path = join(appDirectory, '.output', 'server', 'wrangler.json')
  if (!existsSync(path)) {
    if (dryRun) return {}
    throw new Error(`Missing Nitro Wrangler config for ${basename(appDirectory)}; build the app or omit --skip-build`)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`Invalid Nitro Wrangler config for ${basename(appDirectory)}`)
  }
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`Missing ${description}: ${path}`)
}

function requireFile(path, description) {
  let status
  try {
    status = lstatSync(path)
  } catch {
    throw new Error(`Missing ${description}: ${path}`)
  }
  if (!status.isFile()) throw new Error(`${description} is not a regular file: ${path}`)
}

function requireDirectory(path, description) {
  let status
  try {
    status = lstatSync(path)
  } catch {
    throw new Error(`Missing ${description}: ${path}`)
  }
  if (!status.isDirectory()) throw new Error(`${description} is not a directory: ${path}`)
}

function workerName(appName) {
  return `insulin-apps-${appName}`
}

function serviceBinding(appName) {
  return `APP_${appName.toUpperCase().replaceAll('-', '_')}`
}

function writeJson(path, value) {
  if (!isAbsolute(path)) throw new Error(`Generated config path must be absolute: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeSummary(path, domain, apps) {
  if (!path) return
  const urls = [`https://${domain}`, `https://auth.${domain}`, ...apps.map(({ name }) => `https://${name}.${domain}`)]
  appendFileSync(path, `## Deployed apps\n\n${urls.map((url) => `- ${url}`).join('\n')}\n`)
}

function redact(value, secrets) {
  let output = value
  for (const secret of secrets) output = output.replaceAll(secret, '<redacted>')
  return output
}

export function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--skip-build') options.skipBuild = true
    else if (argument === '--build-only') options.buildOnly = true
    else if (argument === '--gateway-only') options.gatewayOnly = true
    else if (argument === '--out' && args[index + 1]) options.out = args[(index += 1)]
    else if (argument.startsWith('--out=') && argument.length > 6) options.out = argument.slice(6)
    else if (argument === '--only' && args[index + 1]) options.only = args[(index += 1)]
    else if (argument.startsWith('--only=') && argument.length > 7) options.only = argument.slice(7)
    else throw new Error('usage: node .github/scripts/deploy-apps.mjs [--build-only | --gateway-only | --skip-build] [--dry-run] [--out <dir>] [--only <app>]')
  }
  if (options.out && !options.dryRun) throw new Error('--out is only available with --dry-run')
  if (options.buildOnly && options.skipBuild) throw new Error('--build-only and --skip-build cannot be combined')
  if (options.gatewayOnly && options.only) throw new Error('--gateway-only and --only cannot be combined')
  if (options.gatewayOnly && options.buildOnly) throw new Error('--gateway-only and --build-only cannot be combined')
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = await deployApps(options)
  if (result.built) return
  if (!result.skipped && options.dryRun) process.stdout.write(`Dry-run plan written to ${join(result.outputDirectory, 'plan.json')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`deploy-apps: ${redact(error.message, [process.env.CLOUDFLARE_API_TOKEN, process.env.GOOGLE_CLIENT_SECRET, process.env.TURNSTILE_SECRET_KEY].filter(Boolean))}\n`)
    process.exitCode = 1
  })
}
