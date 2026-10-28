#!/usr/bin/env node
// Checks that an app directory keeps the shape Insulin's AppBuilder expects, so the
// console can seed, preview and publish it. Run it from the repository root:
//
//   node .github/scripts/check-insulin-app.mjs captable           # source checks
//   node .github/scripts/check-insulin-app.mjs captable --built   # also check `npm run build` output
//
// The limits mirror the platform's: at most 2,000 stored files of 1 MiB each and
// 10 MiB in total, text files only, one npm package with an exact, registry-only
// lockfile, and only the D1 binding and static assets at runtime.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const [appArg, ...flags] = process.argv.slice(2)
if (!appArg) {
  console.error('usage: node .github/scripts/check-insulin-app.mjs <app-dir> [--built]')
  process.exit(64)
}
const app = appArg.replace(/\/+$/, '')
const built = flags.includes('--built')
const problems = []
const fail = (message) => problems.push(message)

const MAX_FILES = 2000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_PATH = 512
// Never stored by the platform, so never counted.
const SKIPPED_DIRS = new Set(['node_modules', '.output', '.nitro', '.wrangler', 'dist', '.tanstack', '.git'])
const SKIPPED_PATHS = new Set(['.suger/data', '.suger/runtime'])

const REQUIRED_FILES = [
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'drizzle.config.ts',
  'src/main.tsx',
  'src/api.ts',
  'src/platform.local.ts',
  'src/platform.worker.ts',
  'src/local-d1.ts',
  'src/suger-app-builder-runtime.tsx',
  'src/app/App.tsx',
  'src/app/server/router.ts',
  'src/app/db/schema.ts',
  'src/app/db/client.ts',
  'src/app/db/migrations/meta/_journal.json',
]
const FORBIDDEN_FILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'wrangler.toml',
  'wrangler.json',
  'wrangler.jsonc',
  'src/routeTree.gen.ts',
  'public/sandbox-bundle.js',
]

const read = (path) => readFileSync(join(app, path), 'utf8')

for (const file of REQUIRED_FILES) {
  if (!existsSync(join(app, file))) fail(`missing required file ${file}`)
}
for (const file of FORBIDDEN_FILES) {
  if (existsSync(join(app, file))) fail(`${file} must not exist: the platform owns it or cannot use it`)
}
if (existsSync(join(app, 'public/vendor'))) fail('public/vendor/ is reserved for the console runtime')

// Files: count, size, text-only, no links.
let fileCount = 0
let totalBytes = 0
const sourceFiles = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(app, full).split(sep).join('/')
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || SKIPPED_PATHS.has(rel)) continue
      walk(full)
      continue
    }
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`${rel} is not a regular file (links and special files are removed by the platform)`)
      continue
    }
    fileCount += 1
    totalBytes += stat.size
    if (rel.length > MAX_PATH) fail(`${rel} has a path longer than ${MAX_PATH} characters`)
    if (stat.size > MAX_FILE_BYTES) fail(`${rel} is ${stat.size} bytes; the limit is ${MAX_FILE_BYTES}`)
    const bytes = readFileSync(full)
    if (bytes.includes(0) || !isUtf8(bytes)) fail(`${rel} is not UTF-8 text; the template seed stores text only`)
    if (/\.(ts|tsx|mts|js|mjs)$/.test(rel)) sourceFiles.push(rel)
  }
}
walk(app)
if (fileCount > MAX_FILES) fail(`${fileCount} files; the limit is ${MAX_FILES}`)
if (totalBytes > MAX_TOTAL_BYTES) fail(`${totalBytes} bytes in total; the limit is ${MAX_TOTAL_BYTES}`)

// The manifest and its lockfile.
let manifest = {}
try {
  manifest = JSON.parse(read('package.json'))
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`)
}
if (manifest.workspaces) fail('package.json must not declare workspaces: one package per app')
const scripts = manifest.scripts ?? {}
for (const name of ['dev', 'build', 'db:generate', 'typecheck']) {
  if (!scripts[name]) fail(`package.json is missing the "${name}" script`)
}
if (scripts.dev && !(scripts.dev.includes('--port 3000') && scripts.dev.includes('--configLoader native'))) {
  fail('the "dev" script must keep "vite --configLoader native --host 0.0.0.0 --port 3000"')
}
const EXACT = /^(npm:(@?[^@\s]+)@)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
    if (!EXACT.test(spec)) fail(`${field}.${name} is "${spec}"; pin an exact registry version`)
  }
}
let lock = { packages: {} }
try {
  lock = JSON.parse(read('package-lock.json'))
} catch (error) {
  fail(`package-lock.json is not valid JSON: ${error.message}`)
}
if (![2, 3].includes(lock.lockfileVersion)) fail(`package-lock.json lockfileVersion is ${lock.lockfileVersion}; use 2 or 3`)
const lockBytes = existsSync(join(app, 'package-lock.json')) ? lstatSync(join(app, 'package-lock.json')).size : 0
if (lockBytes > MAX_FILE_BYTES) fail(`package-lock.json is ${lockBytes} bytes; the limit is ${MAX_FILE_BYTES}`)
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path) continue
  if (entry.link) fail(`${path} is a linked package`)
  if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
    fail(`${path} resolves outside registry.npmjs.org: ${entry.resolved}`)
  }
}
const rolldown = lock.packages?.['node_modules/rolldown']?.version
const binding = lock.packages?.['node_modules/@rolldown/binding-wasm32-wasi']?.version
if (rolldown && binding !== rolldown) {
  fail(`@rolldown/binding-wasm32-wasi is ${binding ?? 'missing'} but rolldown is ${rolldown}; the browser preview needs them equal`)
}
if (manifest.devDependencies?.lightningcss && !String(manifest.devDependencies.lightningcss).startsWith('npm:lightningcss-wasm@')) {
  fail('lightningcss must stay aliased to lightningcss-wasm for the browser preview')
}

// Entry points the platform relies on.
if (existsSync(join(app, 'src/main.tsx'))) {
  const main = read('src/main.tsx')
  const bridge = main.indexOf('./suger-app-builder-runtime')
  const root = main.indexOf('./app/App')
  if (bridge < 0 || root < 0 || bridge > root) fail('src/main.tsx must import ./suger-app-builder-runtime before ./app/App')
}
if (existsSync(join(app, 'src/api.ts')) && !read('src/api.ts').includes('withSuger(')) {
  fail('src/api.ts must wrap the router with withSuger from @fours/app/server')
}
if (existsSync(join(app, 'src/app/server/router.ts')) && !/export\s+(async\s+)?(function|const)\s+handleAppRequest\b/.test(read('src/app/server/router.ts'))) {
  fail('src/app/server/router.ts must export handleAppRequest')
}

// Imports: no retired SDKs, no Cloudflare-only modules, platform helpers on the server only.
const SERVER_ONLY = /^src\/(api\.ts|platform\.(local|worker)\.ts|local-d1\.ts|app\/server\/|app\/db\/)/
for (const rel of sourceFiles) {
  const text = read(rel)
  if (/from\s+['"](@sugerinc\/app|@suger\/sdk)/.test(text)) fail(`${rel} imports a retired Suger SDK`)
  if (/from\s+['"]cloudflare:/.test(text) && rel !== 'src/platform.worker.ts' && !rel.endsWith('.d.ts')) {
    fail(`${rel} imports a cloudflare: module; apps get only the D1 binding and static assets`)
  }
  if (rel.startsWith('src/') && !SERVER_ONLY.test(rel) && /from\s+['"]@fours\/app\/server['"]/.test(text)) {
    fail(`${rel} imports @fours/app/server outside server code`)
  }
}

// Build output, when asked.
if (built) {
  const wranglerPath = join(app, '.output/server/wrangler.json')
  if (!existsSync(wranglerPath)) {
    fail('.output/server/wrangler.json is missing: build with NITRO_PRESET=cloudflare_module')
  } else {
    const wrangler = JSON.parse(readFileSync(wranglerPath, 'utf8'))
    const flagsUsed = wrangler.compatibility_flags ?? []
    for (const flag of flagsUsed) {
      if (flag !== 'nodejs_compat') fail(`compatibility flag ${flag} is not allowed (only nodejs_compat)`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wrangler.compatibility_date ?? '')) fail('wrangler.json has no valid compatibility_date')
    if (!wrangler.main || !existsSync(join(app, '.output/server', wrangler.main))) fail('wrangler.json main module is missing')
    if (!existsSync(join(app, '.output/public'))) fail('.output/public is missing')
  }
}

function isUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

if (problems.length) {
  console.error(`${app}: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`${app}: ok (${fileCount} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB${built ? ', build output checked' : ''})`)
