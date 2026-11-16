#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHmac, hkdfSync } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
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
import {
  ENGINE_API_VAR,
  ENGINE_BINDING,
  ENGINE_BUNDLE,
  ENGINE_OUTPUT,
  ENGINE_SERVES_VAR,
  REGISTRY,
  deployedEngineConfig,
  engineBucketName,
  engineConfigProblems,
  engineImageRepository,
  engineImageSources,
  engineWorkerName,
  formatServes,
  imageInputs,
  imageTag,
  parseServes,
  readEngineConfig,
  readServes,
  servesApi,
} from './engine.mjs'
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
const SECRET_SETTINGS = [
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'GATEWAY_SECRET_KEY', 'SUPER_CLOUDFLARE_API_TOKEN',
  ...ENVIRONMENT_JSON_SETTINGS,
]
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
// How long the registry credential for pushing an engine's image lasts: longer than the deploy job may run, so a large
// dependency layer finishes uploading (Wrangler's own credential lasts 15 minutes). deploy-release.yml's deploy job
// times out before it.
export const REGISTRY_CREDENTIAL_MINUTES = 240
// The gateway's module that writes an app's limit catalog to its D1 (DESIGN.md §12.2).
const LIMIT_CATALOG_MODULE = join('.github', 'hosting', 'gateway', 'scripts', 'limits-catalog.mjs')
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
    // The contact the landing pages show, and the support address an app's limit messages name (SUGER_SUPPORT_EMAIL,
    // DESIGN.md §12.2). Optional.
    supportEmail: environment.SUPPORT_EMAIL?.trim() ?? '',
  }
  if (!gateway) return settings

  Object.assign(settings, {
    googleClientId: environment.GOOGLE_CLIENT_ID?.trim() ?? '',
    googleClientSecret: environment.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    turnstileSiteKey: environment.TURNSTILE_SITE_KEY.trim(),
    turnstileSecretKey: environment.TURNSTILE_SECRET_KEY.trim(),
    emailFrom: environment.EMAIL_FROM.trim(),
    // Where requests for more organizations go (DESIGN.md §3.1); optional, like SUPPORT_EMAIL.
    orgRequestEmail: environment.ORG_REQUEST_EMAIL?.trim() ?? '',
    // The operator console (DESIGN.md §11): its Google Workspace SAML app, the operators' group and the admins, all
    // GitHub variables (the gateway turns the console off unless the first four are set), and a read-only Cloudflare
    // API token, a secret, for its resource snapshot. All optional.
    superSamlIdpEntityId: environment.SUPER_SAML_IDP_ENTITY_ID?.trim() ?? '',
    superSamlIdpSsoUrl: environment.SUPER_SAML_IDP_SSO_URL?.trim() ?? '',
    superSamlIdpCert: environment.SUPER_SAML_IDP_CERT?.trim() ?? '',
    superGoogleGroup: environment.SUPER_GOOGLE_GROUP?.trim() ?? '',
    superAdminEmails: environment.SUPER_ADMIN_EMAILS?.trim() ?? '',
    superCloudflareApiToken: environment.SUPER_CLOUDFLARE_API_TOKEN?.trim() ?? '',
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

/**
 * The gateway's endpoints an app calls, by the variable that holds each URL (DESIGN.md §6, §8.2, §8.6, §12.2, §12.3),
 * all on the apex and sent over the SUGER_GATEWAY binding with SUGER_APP_TOKEN. `origin` is
 * http://insulinapps.localhost:<port> in a local run.
 */
export function gatewayUrls(origin) {
  return {
    SUGER_INTEGRATIONS_URL: `${origin}/__insulin/integrations`,
    SUGER_MAIL_URL: `${origin}/__insulin/mail`,
    // Where the app reports its usage every hour (§8.6).
    SUGER_METRICS_URL: `${origin}/__insulin/metrics`,
    // Its organizations' limits, set in the operator console (§12.2).
    SUGER_LIMITS_URL: `${origin}/__insulin/limits`,
    // The member lookup, member status and member events of §12.3.
    SUGER_MEMBERS_URL: `${origin}/__insulin/members`,
    SUGER_MEMBER_STATUS_URL: `${origin}/__insulin/members/status`,
    SUGER_MEMBER_EVENTS_URL: `${origin}/__insulin/member-events`,
  }
}

/**
 * The variables and service bindings the platform gives an app Worker, in production and in a local run alike:
 * the gateway's URLs with the binding to call them through (when there is an app token to call them with), the
 * support address, the organization role trusted (the gateway sets x-suger-org-role, §12.3) and, for an app with an
 * engine, the binding to it and the engine API version it calls, recorded so a later deploy can read it back (§12.1).
 */
export function platformAppBindings({ app, gatewayVars = null, supportEmail = '' }) {
  const vars = {
    ...(gatewayVars ?? {}),
    ...(supportEmail ? { SUGER_SUPPORT_EMAIL: supportEmail } : {}),
    SUGER_TRUST_ORG_ROLE: '1',
    ...(app.engine ? { [ENGINE_API_VAR]: String(app.engineApi) } : {}),
  }
  const services = [
    // With the gateway's URLs, the binding to call them through: the app keeps the URL (the gateway routes by it) and
    // sends the request over the binding instead of the internet.
    ...(gatewayVars ? [{ binding: GATEWAY_BINDING, service: GATEWAY_NAME }] : []),
    ...(app.engine ? [{ binding: ENGINE_BINDING, service: engineWorkerName(app.name) }] : []),
  ]
  return { vars, services }
}

export function buildAppConfig({ appDirectory, app, databaseId, baseConfig = {}, gatewayVars = null, supportEmail = '' }) {
  const outputDirectory = join(appDirectory, '.output')
  const platform = platformAppBindings({ app, gatewayVars, supportEmail })
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
    vars: { SUGER_ACCESS_MODE: 'console', ...platform.vars },
    ...(platform.services.length ? { services: platform.services } : {}),
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
  // An app's limit catalog goes to the gateway's D1 instead (writeLimitCatalogs): SITE_APPS holds at most 5 KB.
  const siteApps = apps.map(({ secrets: _secrets, engine: _engine, engineApi: _engineApi, limits: _limits, ...app }) => ({
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
      SUPER_SAML_IDP_ENTITY_ID: settings.superSamlIdpEntityId,
      SUPER_SAML_IDP_SSO_URL: settings.superSamlIdpSsoUrl,
      SUPER_SAML_IDP_CERT: settings.superSamlIdpCert,
      SUPER_GOOGLE_GROUP: settings.superGoogleGroup,
      SUPER_ADMIN_EMAILS: settings.superAdminEmails,
      // The account the console's token reads: the one the platform deploys to.
      ...(settings.superCloudflareApiToken ? { SUPER_CLOUDFLARE_ACCOUNT_ID: settings.cloudflareAccountId } : {}),
    },
  }
}

export async function deployApps({
  root = REPOSITORY_ROOT,
  environment = process.env,
  dryRun = false,
  skipBuild = false,
  buildOnly = false,
  buildEngine = false,
  gatewayOnly = false,
  engineImage,
  only,
  out,
  spawn = spawnSync,
  fetchImpl = globalThis.fetch,
} = {}) {
  root = resolve(root)
  if (buildOnly || buildEngine) {
    // The workflow builds in a job that has no deploy settings, so app build scripts never see a secret.
    const { selectedApps } = await findApps(root, only)
    const runner = new CommandRunner({ dryRun, spawn, secrets: [] })
    if (buildOnly) buildApps(runner, root, selectedApps, environment)
    else for (const app of selectedApps.filter(({ engine }) => engine)) buildAppEngine(runner, root, app, environment)
    // The engine's image, when the release needs it (DESIGN.md §12.1 "Images"): built here, pushed by the deploy.
    const image = engineImage ? buildEngineImage({ runner, root, app: requireEngineApp(selectedApps, only), archive: resolve(engineImage), environment }) : null
    return { skipped: false, built: selectedApps.map(({ name }) => name), ...(image ? { image } : {}), commands: runner.plan }
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
  if (engineImage && !(only && appsToDeploy[0]?.engine)) throw new Error('--engine-image needs --only and an app with an engine')
  // The apps whose limit catalogs the gateway step writes: those this deploy put in production. A deploy of the
  // gateway alone (deploy-release.yml's gateway job) is told which apps its run deployed.
  const catalogApps = deployGateway ? (deployAppWorkers ? appsToDeploy : deployedApps(environment, apps)) : []

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
  delete childEnvironment.SUPER_CLOUDFLARE_API_TOKEN
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
      settings.cloudflareApiToken, settings.googleClientSecret, settings.turnstileSecretKey, settings.gatewaySecretKey, settings.superCloudflareApiToken,
      ...appTokens.values(),
      ...[...appSecrets.values()].flatMap(({ values }) => Object.values(values)),
    ].filter(Boolean),
  })
  const cloudflare = { fetchImpl, apiToken: settings.cloudflareApiToken, accountId: settings.cloudflareAccountId, siteDomain: settings.siteDomain }

  if (!skipBuild) buildApps(runner, root, appsToDeploy, environment)

  if (!dryRun) {
    requirePath(wrangler, 'the gateway Wrangler executable')
    if (deployGateway) {
      requirePath(join(root, '.github', 'hosting', 'gateway', 'src', 'index.ts'), 'the gateway entry point')
      requirePath(join(root, '.github', 'hosting', 'gateway', 'migrations'), 'the gateway migrations directory')
    }
  }

  const baseConfigs = new Map()
  const engines = new Map()
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
    if (app.engine) engines.set(app.name, prepareEngine(root, app, dryRun))
  }

  const gatewayVars = appTokens.size ? gatewayUrls(`https://${settings.siteDomain}`) : null
  for (const app of appsToDeploy) {
    const appDirectory = join(root, app.name)
    const configPath = join(outputDirectory, 'apps', `${app.name}.wrangler.json`)
    const baseConfig = baseConfigs.get(app.name)
    let databaseId

    // An app's engine goes first, so the app never runs against an engine that can't serve it (DESIGN.md §12.1).
    if (app.engine) {
      await deployEngine({
        runner, wrangler, root, app, engine: engines.get(app.name), cloudflare, outputDirectory, release, dryRun,
        env: childEnvironment, engineImage: engineImage ? resolve(engineImage) : null,
      })
    }

    if (dryRun) {
      recordDatabasePlan(runner, wrangler, workerName(app.name), root, childEnvironment)
    } else {
      databaseId = ensureDatabase(runner, wrangler, workerName(app.name), root, childEnvironment)
    }

    writeJson(configPath, buildAppConfig({ appDirectory, app, databaseId, baseConfig, gatewayVars, supportEmail: settings.supportEmail }))
    runner.run(wrangler, ['d1', 'migrations', 'apply', workerName(app.name), '--remote', '--config', configPath], {
      cwd: root,
      env: childEnvironment,
    })
    if (app.engine) await requireEngineServes({ runner, cloudflare, app, dryRun })
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
    await removePublicAccess(runner, cloudflare, workerName(app.name), dryRun)

    // A deploy of apps alone writes the catalog of the version it just put in production, once the gateway's tables
    // exist (the first release that adds them writes it in the gateway step, after the gateway's migrations).
    if (!deployGateway && app.limits.length) {
      await writeLimitCatalogs({ runner, wrangler, root, outputDirectory, apps: [app], env: childEnvironment, dryRun, onlyIfReady: true })
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
    // What SITE_APPS can't hold (5 KB): the limit catalogs of the apps this deploy put in production (DESIGN.md §12.2).
    if (catalogApps.length) {
      await writeLimitCatalogs({ runner, wrangler, root, outputDirectory, apps: catalogApps, env: childEnvironment, dryRun, configPath: gatewayConfigPath })
    }

    // The secrets travel with the deploy itself, so no gateway version ever runs without them.
    const secretValues = {
      ...(settings.googleClientId ? { GOOGLE_CLIENT_SECRET: settings.googleClientSecret } : {}),
      TURNSTILE_SECRET_KEY: settings.turnstileSecretKey,
      ...(settings.gatewaySecretKey ? { GATEWAY_SECRET_KEY: settings.gatewaySecretKey } : {}),
      ...(settings.superCloudflareApiToken ? { SUPER_CLOUDFLARE_API_TOKEN: settings.superCloudflareApiToken } : {}),
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

/** DEPLOYED_APPS, the JSON list of apps a release's run deployed (deploy-release.yml passes check-deploy's), or none. */
function deployedApps(environment, apps) {
  const text = environment.DEPLOYED_APPS?.trim()
  if (!text) return []
  let names
  try {
    names = JSON.parse(text)
  } catch {
    throw new Error('DEPLOYED_APPS must be a JSON list of app names')
  }
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error('DEPLOYED_APPS must be a JSON list of app names')
  const unknown = names.filter((name) => !apps.some((app) => app.name === name))
  if (unknown.length) throw new Error(`DEPLOYED_APPS names unknown apps: ${unknown.join(', ')}`)
  return apps.filter(({ name }) => names.includes(name))
}

function requireEngineApp(apps, only) {
  const app = only && apps.length === 1 ? apps[0] : null
  if (!app?.engine) throw new Error('--engine-image needs --only and an app with an engine')
  return app
}

async function removePublicAccess(runner, cloudflare, worker, dryRun) {
  if (dryRun) {
    runner.record('cloudflare-api', ['remove-and-verify-public-access', worker], {
      environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SITE_DOMAIN'],
    })
    return
  }
  await removeAppPublicAccess({ ...cloudflare, worker })
}

// --- The engine (DESIGN.md §12.1) ----------------------------------------------------------------------------------

/**
 * What the deploy needs of an app's engine, read from the release's checkout and checked again, never trusted: its
 * Wrangler config (engine.mjs's rules), the API versions it serves (which must cover the app's), the bundle the build
 * job made, and its image's tag.
 */
function prepareEngine(root, app, dryRun) {
  const directory = join(root, app.name, app.engine)
  const config = readEngineConfig(directory)
  const problems = engineConfigProblems({ app: app.name, engineDirectory: directory, config })
  if (problems.length) throw new Error(`${app.name}'s engine: ${problems.join('; ')}`)
  const serves = readServes(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')))
  if (!servesApi(serves, app.engineApi)) {
    throw new Error(`${app.name}'s engine serves engine API ${formatServes(serves)}, but the app calls ${app.engineApi} (insulin.engineApi)`)
  }
  if (existsSync(join(directory, ENGINE_OUTPUT))) {
    verifyOutputTree(join(directory, ENGINE_OUTPUT))
    requireFile(join(directory, ENGINE_BUNDLE), "the engine's bundled Worker")
  } else if (!dryRun) {
    throw new Error(`Missing ${app.name}'s engine build output: ${join(directory, ENGINE_OUTPUT)}`)
  }
  const image = engineImageSources(directory, config)
  return { directory, config, serves, tag: image ? imageTag(directory, imageInputs(image)) : null }
}

/**
 * Deploys an app's engine Worker, before the app: refuses an engine that can't serve the app version in production
 * (the pair it would leave running until the app follows), creates its R2 buckets, pushes its image when the registry
 * lacks it, writes its deployed config, deploys it as insulin-apps-<app>-engine and removes any public access.
 */
async function deployEngine({ runner, wrangler, root, app, engine, cloudflare, outputDirectory, release, dryRun, env, engineImage }) {
  const worker = engineWorkerName(app.name)
  if (dryRun) {
    runner.record('cloudflare-api', ['check-engine-api-in-production', workerName(app.name), `the engine serves ${formatServes(engine.serves)}`], {
      environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    })
  } else {
    await requireAppApiServed({ cloudflare, app, serves: engine.serves })
  }
  for (const { binding } of engine.config.r2_buckets ?? []) {
    const name = engineBucketName(app.name, binding)
    if (dryRun) runner.record('cloudflare-api', ['ensure-r2-bucket', name], { environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] })
    else if (await ensureBucket({ ...cloudflare, name })) process.stdout.write(`Created R2 bucket ${name}\n`)
  }
  const imageReference = engine.tag ? await engineImageReference({ runner, cloudflare, app, tag: engine.tag, archive: engineImage, dryRun, env }) : null
  const configPath = join(outputDirectory, 'apps', `${app.name}-engine.wrangler.json`)
  writeJson(configPath, deployedEngineConfig({ app: app.name, engineDirectory: engine.directory, config: engine.config, imageReference, serves: engine.serves }))
  runner.run(wrangler, ['deploy', '--config', configPath, ...release], { cwd: root, env })
  await removePublicAccess(runner, cloudflare, worker, dryRun)
}

/** The engine about to be deployed must serve the engine API of every version of the app in production. */
async function requireAppApiServed({ cloudflare, app, serves }) {
  const running = await productionVariable({ ...cloudflare, worker: workerName(app.name), name: ENGINE_API_VAR })
  for (const value of running ?? []) {
    // An app version from before its engine never calls one.
    if (value === null) continue
    if (!/^\d+$/.test(value) || !servesApi(serves, Number(value))) {
      throw new Error(
        `The new ${app.name} engine serves engine API ${formatServes(serves)}, but the ${app.name} version in production calls ${value}. ` +
          'Deploy an engine that serves both first: a breaking change ships in steps (.github/hosting/DESIGN.md §12.1).',
      )
    }
  }
}

/** Before the app goes out: the engine in production, now, must serve the engine API this app calls. */
async function requireEngineServes({ runner, cloudflare, app, dryRun }) {
  const worker = engineWorkerName(app.name)
  if (dryRun) {
    runner.record('cloudflare-api', ['check-engine-in-production', worker, `serves ${app.engineApi}`], { environment: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] })
    return
  }
  const running = await productionVariable({ ...cloudflare, worker, name: ENGINE_SERVES_VAR })
  if (!running?.length) throw new Error(`${worker} isn't in production, so ${app.name}, which calls it, isn't deployed`)
  for (const value of running) {
    const serves = parseServes(value)
    if (!serves || !servesApi(serves, app.engineApi)) {
      throw new Error(`The ${app.name} engine in production serves engine API ${value ?? '(not recorded)'}, but this ${app.name} calls ${app.engineApi}, so it isn't deployed`)
    }
  }
}

/**
 * The value of a variable in every version of a Worker that production runs (its latest deployment), from the
 * Cloudflare API: null for a Worker that doesn't exist, and null in the list for a version without the variable. This
 * is how a deploy reads the engine API versions an earlier deploy recorded (ENGINE_API_VAR, ENGINE_SERVES_VAR).
 */
export async function productionVariable({ fetchImpl, apiToken, accountId, worker, name }) {
  const base = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}`
  const listed = await cloudflareRequest(fetchImpl, apiToken, `${base}/deployments`, { allowNotFound: true })
  if (!listed) return null
  const deployments = listed.result?.deployments
  if (!Array.isArray(deployments)) throw new Error(`Cloudflare returned an invalid deployment list for ${worker}`)
  if (!deployments.length) return null
  const latest = [...deployments].sort((left, right) => String(right.created_on).localeCompare(String(left.created_on)))[0]
  const versions = Array.isArray(latest?.versions) ? latest.versions.filter((version) => version?.percentage > 0) : null
  if (!versions?.length || versions.some(({ version_id: id }) => typeof id !== 'string')) throw new Error(`Cloudflare returned an invalid deployment for ${worker}`)
  const values = []
  for (const { version_id: id } of versions) {
    const bindings = (await cloudflareResult(fetchImpl, apiToken, `${base}/versions/${encodeURIComponent(id)}`))?.resources?.bindings
    if (!Array.isArray(bindings)) throw new Error(`Cloudflare returned a version of ${worker} without its bindings`)
    const binding = bindings.find((candidate) => candidate?.name === name)
    values.push(binding?.type === 'plain_text' && typeof binding.text === 'string' ? binding.text : null)
  }
  return values
}

/** Creates an engine's R2 bucket unless it exists, and checks that it does; true when it was created. */
export async function ensureBucket({ fetchImpl, apiToken, accountId, name }) {
  const buckets = `/accounts/${encodeURIComponent(accountId)}/r2/buckets`
  const path = `${buckets}/${encodeURIComponent(name)}`
  if (await cloudflareRequest(fetchImpl, apiToken, path, { allowNotFound: true })) return false
  await cloudflareRequest(fetchImpl, apiToken, buckets, { method: 'POST', body: { name } })
  if (!(await cloudflareRequest(fetchImpl, apiToken, path, { allowNotFound: true }))) throw new Error(`R2 bucket ${name} is missing after its creation`)
  return true
}

/**
 * The engine image to deploy, by digest (§12.1 "Images"): the digest its tag resolves to in the account's registry.
 * When the registry lacks the tag, the image this release's build job made is pushed first, with a credential that
 * outlasts the upload; without one (the build job didn't build it, so an earlier push must have failed) the deploy
 * stops and asks for a deploy by hand, which always builds the image.
 */
async function engineImageReference({ runner, cloudflare, app, tag, archive, dryRun, env }) {
  const repository = engineImageRepository(app.name)
  const local = `${repository}:${tag}`
  const remote = `${REGISTRY}/${cloudflare.accountId}/${repository}`
  if (dryRun) {
    const environment = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
    runner.record('cloudflare-api', ['registry-credential', REGISTRY, `${REGISTRY_CREDENTIAL_MINUTES} minutes`, 'push', 'pull'], { environment })
    runner.record('registry', ['resolve', local])
    const condition = `the registry lacks ${local}`
    if (archive) {
      for (const args of [['load', '--input', archive], ['tag', local, `${remote}:${tag}`], ['push', `${remote}:${tag}`]]) runner.record('docker', args, { condition })
    } else {
      runner.record('fail', ['ask for a deploy by hand, which builds the image'], { condition })
    }
    // The real deploy pins the digest the tag resolves to.
    return `${remote}:${tag}`
  }
  const credential = await registryCredential(cloudflare)
  runner.secrets.push(credential.password, Buffer.from(`${credential.username}:${credential.password}`).toString('base64'))
  const lookup = { fetchImpl: cloudflare.fetchImpl, credential, accountId: cloudflare.accountId, repository, tag }
  let digest = await registryDigest(lookup)
  if (digest) {
    process.stdout.write(`The registry has ${local}: deploying it without a push\n`)
  } else {
    if (!archive || !existsSync(archive)) {
      throw new Error(
        `The registry has no ${local}, and this release built no image for it (an earlier push must have failed). ` +
          'Run Actions → Deploy by hand with this release: a deploy by hand always builds the image.',
      )
    }
    pushImage({ runner, archive, local, remote: `${remote}:${tag}`, credential, env })
    digest = await registryDigest(lookup)
    if (!digest) throw new Error(`The registry still has no ${local} after the push`)
  }
  process.stdout.write(`Engine image ${local} is ${digest}\n`)
  return `${remote}@${digest}`
}

/** A push and pull credential for the account's registry, from the Cloudflare API, lasting REGISTRY_CREDENTIAL_MINUTES. */
export async function registryCredential({ fetchImpl, apiToken, accountId }) {
  const { result } = await cloudflareRequest(fetchImpl, apiToken, `/accounts/${encodeURIComponent(accountId)}/containers/registries/${REGISTRY}/credentials`, {
    method: 'POST',
    body: { expiration_minutes: REGISTRY_CREDENTIAL_MINUTES, permissions: ['push', 'pull'] },
  })
  if (!result || typeof result.password !== 'string' || !result.password) throw new Error('Cloudflare returned no registry credential')
  return { username: typeof result.username === 'string' && result.username ? result.username : 'v1', password: result.password }
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/**
 * The digest a tag resolves to in the account's registry, or null when the registry lacks it (Docker's registry API:
 * HEAD on the manifest). The credential goes only to the registry and to the token service it names on Cloudflare.
 */
export async function registryDigest({ fetchImpl, credential, accountId, repository, tag }) {
  const url = `https://${REGISTRY}/v2/${encodeURIComponent(accountId)}/${repository}/manifests/${encodeURIComponent(tag)}`
  const basic = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`
  const head = (authorization) => fetchImpl(url, { method: 'HEAD', headers: { Authorization: authorization, Accept: MANIFEST_TYPES }, redirect: 'error' })
  let response = await head(basic)
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? ''
    const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]))
    let realm
    try {
      realm = new URL(fields.realm)
    } catch {
      throw new Error('The registry asked for a token without saying where to get it')
    }
    if (!/^bearer\s/i.test(challenge) || realm.protocol !== 'https:' || !(realm.hostname === 'cloudflare.com' || realm.hostname.endsWith('.cloudflare.com'))) {
      throw new Error('The registry asked for a token from somewhere other than Cloudflare')
    }
    for (const key of ['service', 'scope']) if (fields[key]) realm.searchParams.set(key, fields[key])
    const tokenResponse = await fetchImpl(realm.href, { headers: { Authorization: basic }, redirect: 'error' })
    const body = tokenResponse.ok ? await tokenResponse.json().catch(() => null) : null
    const token = body?.token ?? body?.access_token
    if (typeof token !== 'string' || !token) throw new Error(`The registry refused a token (${tokenResponse.status})`)
    response = await head(`Bearer ${token}`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`The registry answered ${response.status} for ${repository}:${tag}`)
  const digest = response.headers.get('docker-content-digest')
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`The registry gave no digest for ${repository}:${tag}`)
  return digest
}

/**
 * Pushes the image this release's build job saved, without running it: loaded from the archive, checked to be the
 * image this release's inputs name, tagged for the registry and pushed, with the credential in a Docker config of its
 * own that is removed right after.
 */
function pushImage({ runner, archive, local, remote, credential, env }) {
  const dockerConfig = mkdtempSync(join(tmpdir(), 'insulin-apps-docker-'))
  try {
    const auth = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
    writeFileSync(join(dockerConfig, 'config.json'), `${JSON.stringify({ auths: { [REGISTRY]: { auth } } })}\n`, { mode: 0o600 })
    const dockerEnv = { ...env, DOCKER_CONFIG: dockerConfig }
    delete dockerEnv.CLOUDFLARE_API_TOKEN
    runner.run('docker', ['load', '--input', archive], { env: dockerEnv })
    runner.run('docker', ['image', 'inspect', '--format', '{{.Id}}', local], { env: dockerEnv, capture: true })
    runner.run('docker', ['tag', local, remote], { env: dockerEnv })
    runner.run('docker', ['push', remote], { env: dockerEnv })
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true })
  }
}

/**
 * Builds an app's engine where the app is built, without deploy settings: installs its exact lockfile without
 * scripts, runs its build if it has one, and bundles its Worker with its own Wrangler (a dry run, from a config of
 * its name, entry and compatibility settings only) into <engine>/.output/worker, which the deploy uploads unchanged.
 */
export function buildAppEngine(runner, root, app, environment) {
  const env = { ...buildEnvironment(environment), WRANGLER_SEND_METRICS: 'false' }
  // Its development dependencies (Wrangler among them) are what builds it: NODE_ENV=production would leave them out.
  delete env.NODE_ENV
  delete env.NITRO_PRESET
  const directory = join(root, app.name, app.engine)
  runner.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, env })
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.scripts?.build) runner.run('npm', ['run', 'build'], { cwd: directory, env })
  const config = readEngineConfig(directory)
  const problems = engineConfigProblems({ app: app.name, engineDirectory: directory, config })
  if (problems.length) throw new Error(`${app.name}'s engine: ${problems.join('; ')}`)
  const output = join(directory, ENGINE_OUTPUT)
  if (!runner.dryRun) rmSync(output, { recursive: true, force: true })
  const scratch = mkdtempSync(join(tmpdir(), 'insulin-apps-engine-bundle-'))
  try {
    const bundleConfig = join(scratch, 'wrangler.json')
    writeFileSync(bundleConfig, `${JSON.stringify({
      name: engineWorkerName(app.name),
      main: resolve(directory, config.main),
      compatibility_date: config.compatibility_date,
      ...(config.compatibility_flags ? { compatibility_flags: config.compatibility_flags } : {}),
    }, null, 2)}\n`)
    runner.run(join(directory, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--outdir', join(output, 'worker'), '--config', bundleConfig], {
      cwd: directory,
      env,
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Builds an app's engine image for linux/amd64 and saves it to `archive`, for the release's build job when its tag
 * changed (§12.1 "Images"). The build context holds exactly the files the tag covers, so the image is what its tag
 * names; it is tagged insulin-apps-<app>-engine:<tag> locally, and the deploy pushes it.
 */
export function buildEngineImage({ runner, root, app, archive, environment }) {
  const directory = join(root, app.name, app.engine)
  const image = engineImageSources(directory, readEngineConfig(directory))
  if (!image) throw new Error(`${app.name}'s engine has no container image to build`)
  const inputs = imageInputs(image)
  const tag = imageTag(directory, inputs)
  const local = `${engineImageRepository(app.name)}:${tag}`
  const env = buildEnvironment(environment)
  delete env.NITRO_PRESET
  const context = mkdtempSync(join(tmpdir(), 'insulin-apps-engine-image-'))
  try {
    for (const file of inputs.files) {
      mkdirSync(dirname(join(context, file)), { recursive: true })
      copyFileSync(join(inputs.context, file), join(context, file))
    }
    const buildArgs = Object.entries(inputs.vars).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`])
    runner.run('docker', ['build', '--platform', 'linux/amd64', '--file', inputs.dockerfile, '--tag', local, ...buildArgs, context], { cwd: directory, env })
    if (!runner.dryRun) mkdirSync(dirname(archive), { recursive: true })
    runner.run('docker', ['save', '--output', archive, local], { cwd: directory, env })
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
  process.stdout.write(`Built ${local} into ${archive}\n`)
  return { tag, local, archive }
}

// --- Limit catalogs (DESIGN.md §12.2) --------------------------------------------------------------------------------

/**
 * Writes apps' limit catalogs to the gateway's D1 with the SQL the gateway's own module makes (gateway
 * scripts/limits-catalog.mjs), so the operator console manages the limits the running apps enforce. The gateway step
 * calls it after the gateway's migrations; a deploy of apps alone (`onlyIfReady`) first checks that the gateway's
 * database and tables exist, and leaves the catalog to the gateway step otherwise.
 */
async function writeLimitCatalogs({ runner, wrangler, root, outputDirectory, apps, env, dryRun, configPath, onlyIfReady = false }) {
  const modulePath = join(root, LIMIT_CATALOG_MODULE)
  if (!existsSync(modulePath)) {
    process.stdout.write(`::notice::${LIMIT_CATALOG_MODULE} is missing: limit catalogs not written\n`)
    return
  }
  const catalog = await import(pathToFileURL(modulePath).href)
  if (typeof catalog.limitsCatalogSql !== 'function') throw new Error(`${LIMIT_CATALOG_MODULE} exports no limitsCatalogSql(apps)`)
  const table = typeof catalog.LIMIT_CATALOG_TABLE === 'string' ? catalog.LIMIT_CATALOG_TABLE : 'app_limit_catalog'
  if (!/^[a-z_]+$/.test(table)) throw new Error(`${LIMIT_CATALOG_MODULE}'s LIMIT_CATALOG_TABLE isn't a table name`)
  if (onlyIfReady) {
    configPath = join(outputDirectory, 'gateway-d1.wrangler.json')
    if (dryRun) {
      writeJson(configPath, gatewayDatabaseConfig(null))
      runner.run(wrangler, ['d1', 'list', '--json'], { cwd: root, env })
      runner.run(wrangler, ['d1', 'execute', GATEWAY_NAME, '--remote', '--json', '--command', tableQuery(table), '--config', configPath], { cwd: root, env, condition: `${GATEWAY_NAME} exists` })
    } else {
      const database = listDatabases(runner, wrangler, root, env).find(({ name }) => name === GATEWAY_NAME)
      if (!database?.uuid) {
        process.stdout.write(`::notice::${GATEWAY_NAME} has no database yet: the gateway's deploy writes the limit catalogs\n`)
        return
      }
      writeJson(configPath, gatewayDatabaseConfig(database.uuid))
      const { stdout } = runner.run(wrangler, ['d1', 'execute', GATEWAY_NAME, '--remote', '--json', '--command', tableQuery(table), '--config', configPath], { cwd: root, env, capture: true })
      if (!tableExists(stdout, table)) {
        process.stdout.write(`::notice::${GATEWAY_NAME} has no ${table} table yet: the gateway's deploy writes the limit catalogs after its migrations\n`)
        return
      }
    }
  }
  // The gateway's module replaces each named app's whole catalog, and refuses a malformed one before anything is written.
  const sql = catalog.limitsCatalogSql(apps.map(({ name, limits }) => ({ name, limits })))
  const file = join(outputDirectory, 'limit-catalogs.sql')
  writeFileSync(file, sql)
  runner.run(wrangler, ['d1', 'execute', GATEWAY_NAME, '--remote', '--file', file, '--config', configPath], { cwd: root, env })
  process.stdout.write(`Wrote the limit catalogs of ${apps.map(({ name }) => name).join(', ')} to ${GATEWAY_NAME}\n`)
}

const tableQuery = (table) => `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`

function tableExists(output, table) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('Wrangler returned invalid JSON from d1 execute --json')
  }
  const results = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => (Array.isArray(entry?.results) ? entry.results : []))
  return results.some((row) => row?.name === table)
}

function gatewayDatabaseConfig(databaseId) {
  return {
    name: GATEWAY_NAME,
    compatibility_date: COMPATIBILITY_DATE,
    d1_databases: [{ binding: 'DB', database_name: GATEWAY_NAME, ...(databaseId ? { database_id: databaseId } : {}) }],
  }
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

/** What a build sees of the environment: none of the deploy's settings or secrets. */
function buildEnvironment(environment) {
  const env = { ...environment, NODE_ENV: 'production', NITRO_PRESET: 'cloudflare_module' }
  for (const name of SECRET_SETTINGS) delete env[name]
  return env
}

function buildApps(runner, root, apps, environment) {
  const env = buildEnvironment(environment)
  for (const app of apps) {
    const cwd = join(root, app.name)
    runner.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, env })
    runner.run('npm', ['run', 'build'], { cwd, env })
    if (app.engine) buildAppEngine(runner, root, app, environment)
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
  verifyOutputTree(outputDirectory)
  requireFile(join(outputDirectory, 'server', 'index.mjs'), 'Worker entry point')
  requireDirectory(join(outputDirectory, 'public'), 'asset directory')
}

/** A build output holds only regular files and directories, and no file hard-linked from outside it. */
export function verifyOutputTree(outputDirectory) {
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
    throw new Error(`Worker ${worker} still has public access after cleanup`)
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

/** One Cloudflare API call; the envelope on success, or null on a 404 when `allowNotFound`. */
async function cloudflareRequest(fetchImpl, apiToken, path, { method = 'GET', body, allowNotFound = false } = {}) {
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

  if (allowNotFound && response.status === 404) return null
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
    else if (argument === '--build-engine') options.buildEngine = true
    else if (argument === '--engine-image' && args[index + 1]) options.engineImage = args[(index += 1)]
    else if (argument.startsWith('--engine-image=') && argument.length > 15) options.engineImage = argument.slice(15)
    else if (argument === '--out' && args[index + 1]) options.out = args[(index += 1)]
    else if (argument.startsWith('--out=') && argument.length > 6) options.out = argument.slice(6)
    else if (argument === '--only' && args[index + 1]) options.only = args[(index += 1)]
    else if (argument.startsWith('--only=') && argument.length > 7) options.only = argument.slice(7)
    else throw new Error('usage: node .github/scripts/deploy-apps.mjs [--build-only | --build-engine | --gateway-only | --skip-build] [--dry-run] [--out <dir>] [--only <app>] [--engine-image <archive>]')
  }
  if (options.out && !options.dryRun) throw new Error('--out is only available with --dry-run')
  if (options.buildOnly && options.skipBuild) throw new Error('--build-only and --skip-build cannot be combined')
  if (options.gatewayOnly && options.only) throw new Error('--gateway-only and --only cannot be combined')
  if (options.gatewayOnly && options.buildOnly) throw new Error('--gateway-only and --build-only cannot be combined')
  if (options.buildEngine && (options.buildOnly || options.skipBuild || options.gatewayOnly)) {
    throw new Error('--build-engine builds engines alone: it cannot be combined with --build-only, --skip-build or --gateway-only')
  }
  // The image to push from (a deploy) or to build into (a build): one app's.
  if (options.engineImage && (!options.only || options.gatewayOnly)) throw new Error('--engine-image needs --only <app>')
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
    const secrets = [
      process.env.CLOUDFLARE_API_TOKEN, process.env.GOOGLE_CLIENT_SECRET, process.env.TURNSTILE_SECRET_KEY, process.env.GATEWAY_SECRET_KEY,
      process.env.SUPER_CLOUDFLARE_API_TOKEN,
    ]
    process.stderr.write(`deploy-apps: ${redact(error.message, secrets.filter(Boolean))}\n`)
    process.exitCode = 1
  })
}
