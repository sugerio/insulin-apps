// Runs an app's production build the way Cloudflare does: builds it, applies its migrations to a local D1 database,
// starts it in workerd with `wrangler dev --local`, and runs the app's own checks (apps/<app>.mjs) with synthetic data.
// An app with an engine (.github/hosting/DESIGN.md §8.7) runs with its in-memory stub engine
// (<engine>/src/stub/worker.ts) as a second Worker in the same `wrangler dev`, bound as SUGER_ENGINE, as the deploy
// binds the real one.
//
//   node smoke.mjs [--app captable] [--skip-build]     # --skip-build reuses the last build
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { platformAppBindings } from '../deploy-apps.mjs'
import { ENGINE_CONFIG, engineWorkerName, parseJsonc } from '../engine.mjs'
import { listApps } from '../list-apps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const argument = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const appName = argument('--app', 'captable')
const skipBuild = process.argv.includes('--skip-build')
const wrangler = join(here, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
// Wrangler 4.149.0's bundled workerd supports dates through 2026-10-13. The production bundle itself is unchanged.
const COMPATIBILITY_DATE = '2026-10-13'

let worker
let workerLog = ''
let scratch
const passed = []

function command(program, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let outputText = ''
    child.stdout.on('data', (chunk) => { outputText += chunk })
    child.stderr.on('data', (chunk) => { outputText += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? accept(outputText) : reject(new Error(
      `${program} ${args.join(' ')} exited ${code ?? signal}\n${outputText}`,
    )))
  })
}

function freePort() {
  return new Promise((accept, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Could not reserve a local port'))
      server.close((error) => error ? reject(error) : accept(address.port))
    })
  })
}

async function response(base, path, init = {}, expected = 200, label = `${init.method ?? 'GET'} ${path}`) {
  const answer = await fetch(`${base}${path}`, init)
  const body = new Uint8Array(await answer.arrayBuffer())
  if (answer.status !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${answer.status}: ${new TextDecoder().decode(body).slice(0, 2000)}`)
  }
  passed.push(label)
  return { answer, body }
}

async function json(base, path, init = {}, expected = 200, label) {
  const result = await response(base, path, init, expected, label)
  try { return JSON.parse(new TextDecoder().decode(result.body)) }
  catch { throw new Error(`${label ?? path}: response was not JSON`) }
}

async function waitUntilReady(base, ready) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited before becoming ready (${worker.exitCode})`)
    try {
      const answer = await fetch(`${base}${ready.path}`, { headers: ready.headers ?? {} })
      if (answer.status === ready.status) return
    } catch {}
    await new Promise((accept) => setTimeout(accept, 100))
  }
  throw new Error('wrangler dev did not become ready within 30 seconds')
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return
  worker.kill('SIGTERM')
  await Promise.race([
    new Promise((accept) => worker.once('exit', accept)),
    new Promise((accept) => setTimeout(accept, 5_000)),
  ])
  if (worker.exitCode === null) worker.kill('SIGKILL')
}

/**
 * The app's config, as the deploy writes it in what matters here: Nitro's generated config with absolute paths, a
 * local D1 with the app's migrations, and the platform's variables and bindings (SUGER_ENGINE for an app with an
 * engine; no gateway, so no SUGER_GATEWAY or its URLs).
 */
function appConfig(app, generated, appDirectory) {
  const output = join(appDirectory, '.output')
  const platform = platformAppBindings({ app })
  return {
    ...generated,
    compatibility_date: COMPATIBILITY_DATE,
    main: join(output, 'server', 'index.mjs'),
    assets: { ...generated.assets, directory: join(output, 'public') },
    d1_databases: [{
      binding: 'DB', database_name: `${app.name}-workerd-smoke`,
      database_id: randomUUID(),
      migrations_dir: join(appDirectory, 'src', 'app', 'db', 'migrations'),
    }],
    vars: { SUGER_ACCESS_MODE: 'console', ...platform.vars },
    ...(platform.services.length ? { services: platform.services } : {}),
  }
}

/** The app's stub engine as a Worker named like the real one, with the variables the app's checks ask of it. */
async function stubEngineConfig(app, vars = {}) {
  const engineDirectory = join(root, app.name, app.engine)
  const main = join(engineDirectory, 'src', 'stub', 'worker.ts')
  if (!existsSync(main)) throw new Error(`${app.name}'s engine has no stub Worker at ${main}`)
  const engine = parseJsonc(await readFile(join(engineDirectory, ENGINE_CONFIG), 'utf8'))
  return {
    name: engineWorkerName(app.name),
    main,
    compatibility_date: COMPATIBILITY_DATE,
    ...(engine.compatibility_flags ? { compatibility_flags: engine.compatibility_flags } : {}),
    vars,
    workers_dev: false,
  }
}

async function run() {
  const app = (await listApps(root)).find(({ name }) => name === appName)
  if (!app) throw new Error(`Unknown app ${JSON.stringify(appName)}`)
  const checksPath = join(here, 'apps', `${app.name}.mjs`)
  if (!existsSync(checksPath)) throw new Error(`${app.name} has no smoke checks: add .github/scripts/workerd-smoke/apps/${app.name}.mjs`)
  const checks = await import(pathToFileURL(checksPath).href)
  const appDirectory = join(root, app.name)
  scratch = await mkdtemp(join(tmpdir(), `${app.name}-workerd-smoke-`))
  if (!skipBuild) {
    await command('npm', ['run', 'build'], {
      cwd: appDirectory,
      env: { ...process.env, NODE_ENV: 'production', NITRO_PRESET: 'cloudflare_module' },
    })
    passed.push('production Cloudflare build')
  }

  const generated = JSON.parse(await readFile(join(appDirectory, '.output', 'server', 'wrangler.json'), 'utf8'))
  const configPath = join(scratch, 'wrangler.json')
  const statePath = join(scratch, 'state')
  await writeFile(configPath, `${JSON.stringify(appConfig(app, generated, appDirectory), null, 2)}\n`)
  const configs = ['--config', configPath]
  if (app.engine) {
    const enginePath = join(scratch, 'engine.wrangler.json')
    await writeFile(enginePath, `${JSON.stringify(await stubEngineConfig(app, checks.stubEngineVars ?? {}), null, 2)}\n`)
    configs.push('--config', enginePath)
  }
  await command(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--config', configPath, '--persist-to', statePath])
  passed.push('local D1 migrations')

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  worker = spawn(wrangler, ['dev', '--local', ...configs, '--persist-to', statePath, '--ip', '127.0.0.1', '--port', String(port)], {
    cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  })
  worker.stdout.on('data', (chunk) => { workerLog += chunk })
  worker.stderr.on('data', (chunk) => { workerLog += chunk })
  await waitUntilReady(base, checks.ready)

  await checks.default({ base, response, json })
}

try {
  await run()
  console.log(`workerd smoke of ${appName} passed (${passed.length} checks)\n${passed.map((label) => `  ✓ ${label}`).join('\n')}`)
} catch (error) {
  // Workerd can flush the request log just after fetch resolves; include it in the failure report.
  await new Promise((accept) => setTimeout(accept, 250))
  console.error(`workerd smoke of ${appName} failed after ${passed.length} checks: ${error instanceof Error ? error.stack : error}`)
  if (workerLog) console.error(`\n--- wrangler dev log ---\n${workerLog}`)
  process.exitCode = 1
} finally {
  await stopWorker()
  if (scratch) await rm(scratch, { recursive: true, force: true })
}
