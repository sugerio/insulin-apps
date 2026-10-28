#!/usr/bin/env node
// Writes the wrangler config of the app Worker the local gateway proxies to (service `insulin-apps-captable`):
//
//   node scripts/app-config.mjs                 # the stub app (dev/stub-app.mjs): echoes what the gateway forwards
//   node scripts/app-config.mjs --app captable  # a built Cap Table: NITRO_PRESET=cloudflare_module npm run build first
//
// The Cap Table config is shaped like the one .github/scripts/workerd-smoke/smoke.mjs writes: Nitro's generated
// wrangler.json plus the name, absolute paths, a local D1 with the app's migrations and SUGER_ACCESS_MODE=console.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDir = resolve(gatewayDir, '..', '..', '..')
export const COMPATIBILITY_DATE = '2026-10-13'
export const APP_SERVICE = 'insulin-apps-captable'

export async function appConfig(app = 'stub') {
  if (app === 'stub') {
    return { name: APP_SERVICE, main: join(gatewayDir, 'dev', 'stub-app.mjs'), compatibility_date: COMPATIBILITY_DATE, workers_dev: false }
  }
  if (app !== 'captable') throw new Error(`unknown app ${app}: use stub or captable`)
  const appDir = join(repositoryDir, 'captable')
  const output = join(appDir, '.output')
  const generatedPath = join(output, 'server', 'wrangler.json')
  if (!existsSync(generatedPath)) {
    throw new Error('captable is not built: run `npm ci` and `NITRO_PRESET=cloudflare_module npm run build` in captable/ first')
  }
  const generated = JSON.parse(await readFile(generatedPath, 'utf8'))
  return {
    ...generated,
    name: APP_SERVICE,
    // Wrangler 4.149.0's workerd supports compatibility dates through 2026-10-13.
    compatibility_date: COMPATIBILITY_DATE,
    main: join(output, 'server', 'index.mjs'),
    assets: { ...generated.assets, directory: join(output, 'public') },
    // Its own local id, so its state never mixes with the gateway's (both bind DB).
    d1_databases: [{ binding: 'DB', database_name: APP_SERVICE, database_id: `local-${APP_SERVICE}`, migrations_dir: join(appDir, 'src', 'app', 'db', 'migrations') }],
    vars: { SUGER_ACCESS_MODE: 'console' },
    workers_dev: false,
  }
}

export async function writeAppConfig(app, out = join(gatewayDir, '.dev', 'app.wrangler.json')) {
  const config = await appConfig(app)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(config, null, 2)}\n`)
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--app')
  const outAt = process.argv.indexOf('--out')
  const out = await writeAppConfig(at === -1 ? 'stub' : process.argv[at + 1], outAt === -1 ? undefined : resolve(process.argv[outAt + 1]))
  console.log(out)
}
