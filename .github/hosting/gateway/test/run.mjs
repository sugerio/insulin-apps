// npm test: builds the gateway once with wrangler (the production bundler), then runs every test file against that
// bundle in Miniflare. Offline: Turnstile, Google and e-mail are stubbed (see helpers/harness.mjs).
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBundle } from './helpers/bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'gateway-bundle-'))
let code = 1
try {
  const bundle = await buildBundle(outDir)
  const files = (await readdir(here)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => join(here, name))
  const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    stdio: 'inherit',
    env: { ...process.env, GATEWAY_BUNDLE: bundle },
  })
  code = await new Promise((accept) => child.on('exit', (exitCode, signal) => accept(exitCode ?? (signal ? 1 : 0))))
} finally {
  await rm(outDir, { recursive: true, force: true })
}
process.exitCode = code
