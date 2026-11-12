#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHmac, hkdfSync } from 'node:crypto'
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
import { gatewayNavigation, listApps } from './list-apps.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..')
const GATEWAY_NAME = 'insulin-apps-gateway'
// The service binding an app Worker reaches the gateway through (the mail relay, the integration proxy): a Worker can't
// fetch another Worker of the same zone through its public URL, so <app>.<domain> never reaches <domain> that way.
export const GATEWAY_BINDING = 'SUGER_GATEWAY'
const COMPATIBILITY_DATE = '2026-10-13'
const GATEWAY_REQUIRED_SETTINGS = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'EMAIL_FROM']
// The whole GitHub environment, as JSON, from which an app's declared secrets are picked (appSecretValues).
const ENVIRONMENT_JSON_SETTINGS = ['APP_SECRETS_JSON', 'APP_VARS_JSON']
const SECRET_SETTINGS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'GATEWAY_SECRET_KEY', ...ENVIRONMENT_JSON_SETTINGS]
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const APP_CONFIG_KEYS = new Set(['compatibility_date', 'compatibility_flags', 'rules', 'no_bundle', 'assets'])
const APP_ASSET_KEYS = new Set(['binding', 'html_handling', 'not_found_handling', 'run_worker_first'])
const APP_RULE_KEYS = new Set(['type', 'globs', 'fallthrough'])
const ALLOWED_COMPATIBILITY_FLAGS = new Set(['nodejs_compat'])
// Rate limit namespaces are shared across the account: distinctive ids keep these counters apart from other Workers.
const RATE_LIMITS = [
  { name: 'RL_AUTH', namespace_id: '730101', simple: { limit: 20, period: 60 } },
  { name: 'RL_APP', namespace_id: '730102', simple: { limit: 600, period: 60 } },
  // Requests to an app's public paths that change something (anything but GET and HEAD), per app and IP.
  { name: 'RL_PUBLIC', namespace_id: '730103', simple: { limit: 60, period: 60 } },
]
// The apps' five-minute tick (`insulin.scheduled`, DESIGN.md §8.5) and the daily cleanup of expired sessions, tokens
// and mail records, for quiet days. The gateway's scheduled handler tells them apart by the cron.
const GATEWAY_CRONS = ['*/5 * * * *', '17 3 * * *']

export function readSettings(environment = process.env, { gateway = true } = {}) {
  const token = environment.CLOUDFLARE_API_TOKEN?.trim() ?? ''
  if (!token) return { skip: true }

  const required = ['CLOUDFLARE_ACCOUNT_ID', ...(gateway ? GATEWAY_REQUIRED_SETTINGS : [])]
  const missing = required.filter((name) => !environment[name]?.trim())
  if (gateway && environment.GOOGLE_CLIENT_ID?.trim() && !environment.GOOGLE_CLIENT_SECRET?.trim()) {
    missing.push('GOOGLE_CLIENT_SECRET')
  }
  if (missing.length) throw new Error(`Missing required deploy settings: ${missing.join(', ')}`)

  // Optional, for the gateway and the apps alike: the gateway encrypts stored secrets with it, and each app's
  // SUGER_APP_TOKEN (for the integration proxy) is derived from it.
  const gatewaySecretKey = environment.GATEWAY_SECRET_KEY?.trim() ?? ''
  if (gatewaySecretKey && Buffer.from(gatewaySecretKey, 'base64').length !== 32) {
    throw new Error('GATEWAY_SECRET_KEY must be the base64 of 32 random bytes')
  }

  const settings = {
    skip: false,
    cloudflareApiToken: token,
    cloudflareAccountId: environment.CLOUDFLARE_ACCOUNT_ID.trim(),
    siteDomain: environment.SITE_DOMAIN?.trim() || 'insulinapps.com',
    gatewaySecretKey,
  }
  if (!gateway) return settings

  Object.assign(settings, {
    googleClientId: environment.GOOGLE_CLIENT_ID?.trim() ?? '',
    googleClientSecret: environment.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    turnstileSiteKey: environment.TURNSTILE_SITE_KEY.trim(),
    turnstileSecretKey: environment.TURNSTILE_SECRET_KEY.trim(),
    emailFrom: environment.EMAIL_FROM.trim(),
    supportEmail: environment.SUPPORT_EMAIL?.trim() ?? '',
    // Where requests for more organizations go (DESIGN.md §3.1); optional, like SUPPORT_EMAIL.
    orgRequestEmail: environment.ORG_REQUEST_EMAIL?.trim() ?? '',
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

/**
 * An app's SUGER_APP_TOKEN, exactly as the gateway derives it (derivedSecret in src/crypto.ts): HKDF-SHA256 of
 * GATEWAY_SECRET_KEY with the info "insulin-apps:app-token" gives an HMAC-SHA256 key, which signs the app's name.
 */
export function appToken(gatewaySecretKey, app) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(gatewaySecretKey, 'base64'), Buffer.alloc(0), 'insulin-apps:app-token', 32))
  return createHmac('sha256', key).update(app).digest('base64url')
}

/**
 * An app's declared secrets (`insulin.secrets`, DESIGN.md §8.3), taken from the GitHub environment: each name from its
 * secrets (APP_SECRETS_JSON, `toJSON(secrets)`), else its variables (APP_VARS_JSON). Only declared names are read;
 * names that aren't set are returned in `missing`. The JSON is never logged, and a malformed one is reported without
 * its contents.
 */
export function appSecretValues(app, environment) {
  const read = (name) => {
    const text = environment[name]?.trim()
    if (!text) return {}
    let value
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error(`${name} is not valid JSON`)
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  const secrets = read('APP_SECRETS_JSON')
  const vars = read('APP_VARS_JSON')
  const values = {}
  const missing = []
  for (const name of app.secrets ?? []) {
    const value = [secrets[name], vars[name]].find((candidate) => typeof candidate === 'string' && candidate !== '')
    if (value === undefined) missing.push(name)
    else values[name] = value
  }
  return { values, missing }
}

export function buildAppConfig({ appDirectory, app, databaseId, baseConfig = {}, integrationsUrl = null, mailUrl = null }) {
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
    vars: {
      SUGER_ACCESS_MODE: 'console',
      ...(integrationsUrl ? { SUGER_INTEGRATIONS_URL: integrationsUrl } : {}),
      ...(mailUrl ? { SUGER_MAIL_URL: mailUrl } : {}),
    },
    // With the gateway's URLs, the binding to call them through: the app keeps the URL (the gateway routes by it) and
    // sends the request over the binding instead of the internet.
    ...(integrationsUrl || mailUrl ? { services: [{ binding: GATEWAY_BINDING, service: GATEWAY_NAME }] } : {}),
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
  // The gateway needs the permissions, public paths, scheduled path and navigation, never the names of an app's secrets.
  const siteApps = apps.map(({ secrets: _secrets, ...app }) => ({
    ...app,
    navigation: gatewayNavigation(app.navigation),
    binding: serviceBinding(app.name),
    source: `https://github.com/sugerio/insulin-apps/tree/main/${app.name}`,
  }))

  return {
    name: GATEWAY_NAME,
    main: resolve(gatewayDirectory, 'src', 'index.ts'),
    compatibility_date: COMPATIBILITY_DATE,
    // SAML's XML signature library (xml-crypto) needs Node's crypto module.
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    routes: [
      settings.siteDomain,
      `www.${settings.siteDomain}`,
      // Sign-in moved to the apex; the old host stays attached so links in e-mails already sent redirect.
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
    triggers: { crons: GATEWAY_CRONS },
    // The public docs' images (Workers Static Assets). run_worker_first sends every request to the gateway first, so
    // the directory is reachable only through the binding, which the gateway serves at /docs/assets/* alone.
    assets: { directory: resolve(root, '.github', 'hosting', 'docs', 'assets'), binding: 'DOCS_ASSETS', run_worker_first: true },
    vars: {
      SITE_DOMAIN: settings.siteDomain,
      SITE_APPS: siteApps,
      GOOGLE_CLIENT_ID: settings.googleClientId,
      TURNSTILE_SITE_KEY: settings.turnstileSiteKey,
      EMAIL_FROM: settings.emailFrom,
      SUPPORT_EMAIL: settings.supportEmail,
      ORG_REQUEST_EMAIL: settings.orgRequestEmail,
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

  const release = releaseArguments(environment)
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
  delete childEnvironment.GATEWAY_SECRET_KEY
  for (const name of ENVIRONMENT_JSON_SETTINGS) delete childEnvironment[name]

  const appTokens = new Map(settings.gatewaySecretKey ? apps.map(({ name }) => [name, appToken(settings.gatewaySecretKey, name)]) : [])
  const appSecrets = new Map(appsToDeploy.map((app) => [app.name, appSecretValues(app, environment)]))
  for (const [name, { missing }] of appSecrets) {
    if (missing.length) process.stdout.write(`::notice::${name}: not set in the environment, skipped: ${missing.join(', ')}\n`)
  }
  const runner = new CommandRunner({
    dryRun,
    spawn,
    secrets: [
      settings.cloudflareApiToken, settings.googleClientSecret, settings.turnstileSecretKey, settings.gatewaySecretKey, ...appTokens.values(),
      ...[...appSecrets.values()].flatMap(({ values }) => Object.values(values)),
    ].filter(Boolean),
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

    const integrationsUrl = appTokens.size ? `https://${settings.siteDomain}/__insulin/integrations` : null
    const mailUrl = appTokens.size ? `https://${settings.siteDomain}/__insulin/mail` : null
    writeJson(configPath, buildAppConfig({ appDirectory, app, databaseId, baseConfig, integrationsUrl, mailUrl }))
    runner.run(wrangler, ['d1', 'migrations', 'apply', workerName(app.name), '--remote', '--config', configPath], {
      cwd: root,
      env: childEnvironment,
    })
    const secretValues = {
      ...appSecrets.get(app.name).values,
      ...(appTokens.size ? { SUGER_APP_TOKEN: appTokens.get(app.name) } : {}),
    }
    if (Object.keys(secretValues).length) {
      // The secrets travel with the deploy itself, so no version of the app runs without them.
      deployWithSecrets(runner, wrangler, configPath, secretValues, { cwd: root, env: childEnvironment, dryRun, release })
    } else {
      runner.run(wrangler, ['deploy', '--config', configPath, ...release], { cwd: root, env: childEnvironment })
    }
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
      ...(settings.gatewaySecretKey ? { GATEWAY_SECRET_KEY: settings.gatewaySecretKey } : {}),
    }
    deployWithSecrets(runner, wrangler, gatewayConfigPath, secretValues, { cwd: root, env: childEnvironment, dryRun, release })
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

  run(command, args, { cwd, env, condition, capture = false, recordArgs = args, sensitive = false, secretNames } = {}) {
    this.record(command, recordArgs, {
      cwd,
      ...(condition ? { condition } : {}),
      ...(command.endsWith('wrangler') ? { environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] } : {}),
      ...(sensitive ? { input: '<redacted>' } : {}),
      ...(secretNames ? { secretNames } : {}),
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

/**
 * The release a deploy installs, which deploy-release.yml passes as RELEASE_VERSION and RELEASE_COMMIT: `wrangler deploy` tags
 * each Worker version with it, so Cloudflare shows which release runs. Nothing outside a release deploy.
 */
export function releaseArguments(environment = process.env) {
  const version = environment.RELEASE_VERSION?.trim() ?? ''
  const commit = environment.RELEASE_COMMIT?.trim() ?? ''
  if (!version) return []
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('RELEASE_VERSION must be a release such as v0.1.2')
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('RELEASE_COMMIT must be the release\'s full commit id')
  return ['--tag', version, '--message', `insulin-apps ${version} (${commit.slice(0, 12)})`]
}

async function findApps(root, only) {
  const apps = await listApps(root)
  if (!apps.length) throw new Error('No apps were found')
  if (only && !apps.some(({ name }) => name === only)) throw new Error(`Unknown app for --only: ${only}`)
  return { apps, selectedApps: only ? apps.filter(({ name }) => name === only) : apps }
}

/**
 * `wrangler deploy --secrets-file`, from a mode-600 file in a fresh directory removed right after; redacted in plans,
 * which list the secrets' names only.
 */
function deployWithSecrets(runner, wrangler, configPath, secretValues, { cwd, env, dryRun, release = [] }) {
  const args = (secretFile) => ['deploy', '--config', configPath, '--secrets-file', secretFile, ...release]
  const secretNames = Object.keys(secretValues).sort()
  if (dryRun) {
    runner.run(wrangler, args('<redacted-secret-file>'), { cwd, env, sensitive: true, secretNames })
    return
  }
  const secretDirectory = mkdtempSync(join(tmpdir(), 'insulin-apps-secrets-'))
  const secretFile = join(secretDirectory, 'secrets.json')
  try {
    writeFileSync(secretFile, `${JSON.stringify(secretValues)}\n`, { mode: 0o600 })
    chmodSync(secretFile, 0o600)
    runner.run(wrangler, args(secretFile), { cwd, env, recordArgs: args('<redacted-secret-file>'), sensitive: true, secretNames })
  } finally {
    rmSync(secretDirectory, { recursive: true, force: true })
  }
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
  const urls = [`https://${domain}`, ...apps.map(({ name }) => `https://${name}.${domain}`)]
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
    const secrets = [process.env.CLOUDFLARE_API_TOKEN, process.env.GOOGLE_CLIENT_SECRET, process.env.TURNSTILE_SECRET_KEY, process.env.GATEWAY_SECRET_KEY]
    process.stderr.write(`deploy-apps: ${redact(error.message, secrets.filter(Boolean))}\n`)
    process.exitCode = 1
  })
}
