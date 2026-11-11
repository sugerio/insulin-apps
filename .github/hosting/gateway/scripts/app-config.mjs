#!/usr/bin/env node
// Writes the wrangler configs of a local run: the gateway's and one per app Worker it proxies to.
//
//   node scripts/app-config.mjs                           # the stub app (dev/stub-app.mjs) as captable: echoes what the gateway forwards
//   node scripts/app-config.mjs --app captable            # a built Cap Table: NITRO_PRESET=cloudflare_module npm run build first
//   node scripts/app-config.mjs --app captable --app esign  # several built apps, each on its own host
//
// The gateway's config is wrangler.local.jsonc with a service binding (APP_<NAME>) and a SITE_APPS entry per app, the
// entries read from each app's package.json by list-apps.mjs, as the deploy does. An app's config is shaped like the
// one .github/scripts/workerd-smoke/smoke.mjs writes: Nitro's generated wrangler.json plus the name, absolute paths, a
// local D1 with the app's migrations and SUGER_ACCESS_MODE=console. Every config lands in .dev/.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listApps } from '../../../scripts/list-apps.mjs'

export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDir = resolve(gatewayDir, '..', '..', '..')
export const COMPATIBILITY_DATE = '2026-10-13'
export const GATEWAY_LOCAL_CONFIG = join(gatewayDir, 'wrangler.local.jsonc')
const DEV_DIR = join(gatewayDir, '.dev')

const workerName = (app) => `insulin-apps-${app}`
const bindingName = (app) => `APP_${app.toUpperCase().replaceAll('-', '_')}`

/** wrangler.local.jsonc without its comments, which are whole lines starting with //. */
export async function readLocalGatewayConfig() {
  const text = await readFile(GATEWAY_LOCAL_CONFIG, 'utf8')
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
}

/** One app Worker's config: the stub (named after captable, as the local gateway config expects) or a built app. */
export async function appConfig(app = 'stub', vars = {}) {
  if (app === 'stub') {
    return { name: workerName('captable'), main: join(gatewayDir, 'dev', 'stub-app.mjs'), compatibility_date: COMPATIBILITY_DATE, workers_dev: false }
  }
  const apps = await listApps(repositoryDir)
  if (!apps.some(({ name }) => name === app)) throw new Error(`unknown app ${app}: use stub or one of ${apps.map(({ name }) => name).join(', ')}`)
  const appDir = join(repositoryDir, app)
  const output = join(appDir, '.output')
  const generatedPath = join(output, 'server', 'wrangler.json')
  if (!existsSync(generatedPath)) {
    throw new Error(`${app} is not built: run \`npm ci\` and \`NITRO_PRESET=cloudflare_module npm run build\` in ${app}/ first`)
  }
  const generated = JSON.parse(await readFile(generatedPath, 'utf8'))
  return {
    ...generated,
    name: workerName(app),
    // Wrangler 4.149.0's workerd supports compatibility dates through 2026-10-13.
    compatibility_date: COMPATIBILITY_DATE,
    main: join(output, 'server', 'index.mjs'),
    assets: { ...generated.assets, directory: join(output, 'public') },
    // Its own local id, so its state never mixes with the gateway's (both bind DB).
    d1_databases: [{ binding: 'DB', database_name: workerName(app), database_id: `local-${workerName(app)}`, migrations_dir: join(appDir, 'src', 'app', 'db', 'migrations') }],
    vars: { SUGER_ACCESS_MODE: 'console', ...vars },
    workers_dev: false,
  }
}

/**
 * The gateway's config for these apps: wrangler.local.jsonc with absolute paths, a binding and a SITE_APPS entry per
 * app. With only the stub it is wrangler.local.jsonc as it stands. `vars` are added to the gateway's vars.
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
  config.vars.SITE_APPS = apps.map((app) => {
    const { secrets: _secrets, ...entry } = known.find(({ name }) => name === app)
    return { ...entry, binding: bindingName(app) }
  })
  return config
}

/**
 * Writes the gateway's config and each app's into .dev/ and returns their paths, the gateway's first (the Worker that
 * `wrangler dev` serves). `appVars` adds variables to an app (`{ esign: { ESIGN_OTP_KEY: ... } }`).
 */
export async function writeDevConfigs(apps = ['stub'], { gatewayVars = {}, appVars = {} } = {}) {
  if (apps.includes('stub') && apps.length > 1) throw new Error('the stub app runs alone')
  await mkdir(DEV_DIR, { recursive: true })
  const write = async (name, config) => {
    const path = join(DEV_DIR, name)
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
    return path
  }
  const gateway = await write('gateway.wrangler.json', await gatewayConfig(apps, gatewayVars))
  const appPaths = []
  for (const app of apps) appPaths.push(await write(app === 'stub' ? 'app.wrangler.json' : `${app}.wrangler.json`, await appConfig(app, appVars[app] ?? {})))
  return { gateway, apps: appPaths }
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
  const { gateway, apps } = await writeDevConfigs(appsFromArgs(process.argv.slice(2)))
  console.log([gateway, ...apps].join('\n'))
}
