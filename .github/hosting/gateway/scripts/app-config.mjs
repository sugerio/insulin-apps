#!/usr/bin/env node
// Writes the wrangler configs of a local run: the gateway's and one per app Worker it proxies to.
//
//   node scripts/app-config.mjs                           # the stub app (dev/stub-app.mjs) as captable: echoes what the gateway forwards
//   node scripts/app-config.mjs --app captable            # a built Cap Table: NITRO_PRESET=cloudflare_module npm run build first
//   node scripts/app-config.mjs --app captable --app esign  # several built apps, each on its own host
//
// The gateway's config is wrangler.local.jsonc with a service binding (APP_<NAME>) and a SITE_APPS entry per app, the
// entries read from each app's package.json by list-apps.mjs, as the deploy does, and a local GATEWAY_SECRET_KEY. An
// app's config is shaped like the one .github/scripts/workerd-smoke/smoke.mjs writes: Nitro's generated wrangler.json
// plus the name, absolute paths, a local D1 with the app's migrations and SUGER_ACCESS_MODE=console, and what the deploy
// gives every app (deploy-apps.mjs's platformAppBindings): the SUGER_GATEWAY binding with the gateway's URLs on
// http://insulinapps.localhost:<port>, an app token derived from the local key as the deploy derives it, so the mail
// relay, usage reports, limits and the member endpoints work locally, and SUGER_TRUST_ORG_ROLE. An app with an engine
// (DESIGN.md §10.2) also gets its stub engine (<engine>/src/stub/worker.ts) as insulin-apps-<app>-engine, bound as
// SUGER_ENGINE. Every config lands in .dev/.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appToken, gatewayUrls, platformAppBindings, siteAppEntry } from '../../../scripts/deploy-apps.mjs'
import { ENGINE_CONFIG, engineWorkerName, parseJsonc } from '../../../scripts/engine.mjs'
import { listApps } from '../../../scripts/list-apps.mjs'

export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDir = resolve(gatewayDir, '..', '..', '..')
export const COMPATIBILITY_DATE = '2026-10-13'
export const GATEWAY_LOCAL_CONFIG = join(gatewayDir, 'wrangler.local.jsonc')
const DEV_DIR = join(gatewayDir, '.dev')
export const DEV_PORT = '8787'
/**
 * The local gateway's GATEWAY_SECRET_KEY when built apps run: fixed, so what it seals in the local state stays
 * readable from one run to the next, and public, since it only ever seals local, synthetic data.
 */
export const LOCAL_GATEWAY_SECRET_KEY = createHash('sha256').update('insulin-apps local development only').digest('base64')

const workerName = (app) => `insulin-apps-${app}`
const bindingName = (app) => `APP_${app.toUpperCase().replaceAll('-', '_')}`
const localOrigin = (port, https = false) => `${https ? 'https' : 'http'}://insulinapps.localhost:${port}`

/** wrangler.local.jsonc without its comments, which are whole lines starting with //. */
export async function readLocalGatewayConfig() {
  const text = await readFile(GATEWAY_LOCAL_CONFIG, 'utf8')
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
}

/**
 * One app Worker's config: the stub (named after captable, as the local gateway config expects) or a built app, with
 * the platform's variables and bindings for a gateway on `port` whose key is `gatewayKey`. `vars` come last, so a
 * caller can replace any of them.
 */
export async function appConfig(app = 'stub', vars = {}, { port = DEV_PORT, https = false, gatewayKey = LOCAL_GATEWAY_SECRET_KEY, supportEmail = '' } = {}) {
  if (app === 'stub') {
    return { name: workerName('captable'), main: join(gatewayDir, 'dev', 'stub-app.mjs'), compatibility_date: COMPATIBILITY_DATE, workers_dev: false }
  }
  const apps = await listApps(repositoryDir)
  const entry = apps.find(({ name }) => name === app)
  if (!entry) throw new Error(`unknown app ${app}: use stub or one of ${apps.map(({ name }) => name).join(', ')}`)
  const appDir = join(repositoryDir, app)
  const output = join(appDir, '.output')
  const generatedPath = join(output, 'server', 'wrangler.json')
  if (!existsSync(generatedPath)) {
    throw new Error(`${app} is not built: run \`npm ci\` and \`NITRO_PRESET=cloudflare_module npm run build\` in ${app}/ first`)
  }
  const generated = JSON.parse(await readFile(generatedPath, 'utf8'))
  const platform = platformAppBindings({ app: entry, gatewayVars: gatewayUrls(localOrigin(port, https)), supportEmail })
  return {
    ...generated,
    name: workerName(app),
    // Wrangler 4.149.0's workerd supports compatibility dates through 2026-10-13.
    compatibility_date: COMPATIBILITY_DATE,
    main: join(output, 'server', 'index.mjs'),
    assets: { ...generated.assets, directory: join(output, 'public') },
    // Its own local id, so its state never mixes with the gateway's (both bind DB).
    d1_databases: [{ binding: 'DB', database_name: workerName(app), database_id: `local-${workerName(app)}`, migrations_dir: join(appDir, 'src', 'app', 'db', 'migrations') }],
    services: platform.services,
    vars: { SUGER_ACCESS_MODE: 'console', ...platform.vars, SUGER_APP_TOKEN: appToken(gatewayKey, app), ...vars },
    workers_dev: false,
  }
}

/** An app's stub engine, run locally as insulin-apps-<app>-engine in place of the real one, or null without an engine. */
export async function engineConfig(app) {
  const entry = (await listApps(repositoryDir)).find(({ name }) => name === app)
  if (!entry?.engine) return null
  const engineDir = join(repositoryDir, app, entry.engine)
  const main = join(engineDir, 'src', 'stub', 'worker.ts')
  if (!existsSync(main)) throw new Error(`${app}'s engine has no stub Worker at ${main}`)
  const engine = parseJsonc(await readFile(join(engineDir, ENGINE_CONFIG), 'utf8'))
  return {
    name: engineWorkerName(app),
    main,
    compatibility_date: COMPATIBILITY_DATE,
    ...(engine.compatibility_flags ? { compatibility_flags: engine.compatibility_flags } : {}),
    workers_dev: false,
  }
}

/**
 * The gateway's config for these apps: wrangler.local.jsonc with absolute paths, a binding and a SITE_APPS entry per
 * app, and the local GATEWAY_SECRET_KEY the apps' tokens are derived from. With only the stub it is
 * wrangler.local.jsonc as it stands. `vars` are added to the gateway's vars.
 */
export async function gatewayConfig(apps = ['stub'], vars = {}) {
  const local = await readLocalGatewayConfig()
  const config = {
    ...local,
    main: join(gatewayDir, local.main),
    d1_databases: local.d1_databases.map((database) => ({ ...database, migrations_dir: join(gatewayDir, database.migrations_dir) })),
    assets: { ...local.assets, directory: resolve(gatewayDir, local.assets.directory) },
    vars: { ...local.vars, ...vars },
  }
  if (apps.includes('stub')) return config
  const known = await listApps(repositoryDir)
  config.services = apps.map((app) => ({ binding: bindingName(app), service: workerName(app) }))
  // As the deploy's SITE_APPS (siteAppEntry): never an app's secret names, engine or limit catalog (the catalogs go to
  // the local D1).
  config.vars.SITE_APPS = apps.map((app) => siteAppEntry(known.find(({ name }) => name === app)))
  config.vars.GATEWAY_SECRET_KEY ??= LOCAL_GATEWAY_SECRET_KEY
  return config
}

/**
 * The SQL that writes these apps' limit catalogs to the gateway's D1, from the gateway's own module
 * (limits-catalog.mjs, as the deploy uses it), or null with only the stub or without the module.
 */
export async function limitCatalogsSql(apps = ['stub']) {
  if (apps.includes('stub')) return null
  const module = join(gatewayDir, 'scripts', 'limits-catalog.mjs')
  if (!existsSync(module)) return null
  const { limitsCatalogSql } = await import(pathToFileURL(module).href)
  const known = await listApps(repositoryDir)
  return limitsCatalogSql(apps.map((app) => ({ name: app, limits: known.find(({ name }) => name === app).limits })))
}

/**
 * Writes the gateway's config, each app's and each app's stub engine's into .dev/ and returns their paths, the
 * gateway's first (the Worker that `wrangler dev` serves). `appVars` adds variables to an app
 * (`{ esign: { ESIGN_OTP_KEY: ... } }`); `port` and `https` are where and how the local gateway listens, which the
 * apps' URLs name.
 */
export async function writeDevConfigs(apps = ['stub'], { gatewayVars = {}, appVars = {}, port = DEV_PORT, https = false } = {}) {
  if (apps.includes('stub') && apps.length > 1) throw new Error('the stub app runs alone')
  await mkdir(DEV_DIR, { recursive: true })
  const write = async (name, config) => {
    const path = join(DEV_DIR, name)
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
    return path
  }
  const gateway = await gatewayConfig(apps, gatewayVars)
  const gatewayPath = await write('gateway.wrangler.json', gateway)
  const platform = { port: String(port), https, gatewayKey: gateway.vars.GATEWAY_SECRET_KEY, supportEmail: gateway.vars.SUPPORT_EMAIL ?? '' }
  const appPaths = []
  const enginePaths = []
  for (const app of apps) {
    appPaths.push(await write(app === 'stub' ? 'app.wrangler.json' : `${app}.wrangler.json`, await appConfig(app, appVars[app] ?? {}, platform)))
    const engine = app === 'stub' ? null : await engineConfig(app)
    if (engine) enginePaths.push(await write(`${app}-engine.wrangler.json`, engine))
  }
  return { gateway: gatewayPath, apps: appPaths, engines: enginePaths }
}

/** `--app a --app b` or `--app a,b`; the stub when none is given. */
export function appsFromArgs(argv) {
  const apps = []
  argv.forEach((value, index) => {
    if (value === '--app' && argv[index + 1]) apps.push(...argv[index + 1].split(',').filter(Boolean))
  })
  return apps.length ? [...new Set(apps)] : ['stub']
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { gateway, apps, engines } = await writeDevConfigs(appsFromArgs(process.argv.slice(2)))
  console.log([gateway, ...apps, ...engines].join('\n'))
}
