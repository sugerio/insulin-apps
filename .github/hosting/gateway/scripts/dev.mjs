#!/usr/bin/env node
// npm run dev [-- --app captable [--app esign]] [-- --port 8787]: the gateway and its app Workers together in one
// local `wrangler dev`, with local D1 databases (state in .dev/state). No Cloudflare account or network access needed.
// Without --app it runs the stub app (dev/stub-app.mjs) as captable; each --app is a built app on its own host.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { appsFromArgs, gatewayDir, writeDevConfigs } from './app-config.mjs'

export const wrangler = join(gatewayDir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
export const DEV_STATE = join(gatewayDir, '.dev', 'state')
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_TELEMETRY_DISABLED: '1' }

function run(args, { stdio = 'inherit', state }) {
  return new Promise((accept, reject) => {
    const child = spawn(wrangler, [...args, '--persist-to', state], { cwd: gatewayDir, stdio, env })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? accept() : reject(new Error(`wrangler ${args.join(' ')} exited ${code}`))))
  })
}

/**
 * Writes the configs, applies every D1 migration and starts `wrangler dev`; resolves with the running child. Used by
 * `npm run dev` and by the docs' screenshots (.github/hosting/docs/screenshots.mjs), which pass their own state
 * directory, variables and stdio.
 */
export async function startDev({ apps = ['stub'], port = '8787', state = DEV_STATE, gatewayVars, appVars, stdio = 'inherit', https = false } = {}) {
  const configs = await writeDevConfigs(apps, { gatewayVars, appVars })
  await run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', configs.gateway], { stdio, state })
  for (const [index, app] of apps.entries()) {
    if (app !== 'stub') await run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', configs.apps[index]], { stdio, state })
  }
  const args = ['dev', '--config', configs.gateway, ...configs.apps.flatMap((config) => ['--config', config]), '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', port]
  // https (wrangler's self-signed certificate): what E-sign needs to accept its own origin for the embedded editor.
  if (https) args.push('--local-protocol', 'https')
  return spawn(wrangler, args, { cwd: gatewayDir, stdio, env })
}

if (process.argv[1] && process.argv[1].endsWith('dev.mjs')) {
  const argument = (name, fallback) => {
    const at = process.argv.indexOf(name)
    return at === -1 ? fallback : process.argv[at + 1]
  }
  const apps = appsFromArgs(process.argv.slice(2))
  const port = argument('--port', '8787')
  const hosts = apps.map((app) => `  ${(app === 'stub' ? 'Stub app (as captable)' : app).padEnd(32)}http://${app === 'stub' ? 'captable' : app}.insulinapps.localhost:${port}/`)
  console.log(`
  Sign-in, accounts and settings  http://insulinapps.localhost:${port}/
  Docs                            http://insulinapps.localhost:${port}/docs/
${hosts.join('\n')}
  Captured mail                   http://insulinapps.localhost:${port}/__insulin/dev/mail
`)
  const child = await startDev({ apps, port })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}
