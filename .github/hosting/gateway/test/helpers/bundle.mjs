// Builds the gateway the way production does: wrangler's bundler (`wrangler deploy --dry-run`, no network).
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const COMPATIBILITY_DATE = '2026-10-13'
export const wrangler = join(gatewayDir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')

/** Wrangler without its banner, update check, metrics or error reports: tests stay offline and quiet. */
export const QUIET_WRANGLER = {
  WRANGLER_HIDE_BANNER: 'true',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  CLOUDFLARE_TELEMETRY_DISABLED: '1',
  NO_COLOR: '1',
}

export function run(program, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => (code === 0 ? accept(output) : reject(new Error(`${program} ${args.join(' ')} exited ${code ?? signal}\n${output}`))))
  })
}

export async function buildBundle(outDir) {
  const work = await mkdtemp(join(tmpdir(), 'gateway-build-'))
  try {
    const config = join(work, 'wrangler.json')
    await writeFile(config, JSON.stringify({ name: 'insulin-apps-gateway', main: join(gatewayDir, 'src', 'index.ts'), compatibility_date: COMPATIBILITY_DATE }))
    await run(wrangler, ['deploy', '--dry-run', '--outdir', outDir, '--config', config], { cwd: work, env: { ...process.env, ...QUIET_WRANGLER } })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return join(outDir, 'index.js')
}

let pending

/** The bundle test/run.mjs built (GATEWAY_BUNDLE), or one built now for a test file run on its own. */
export function bundlePath() {
  if (process.env.GATEWAY_BUNDLE) return Promise.resolve(process.env.GATEWAY_BUNDLE)
  pending ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-bundle-'))
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
    return buildBundle(dir)
  })()
  return pending
}
