#!/usr/bin/env node
// npm run dev [-- --app captable] [-- --port 8787]: the gateway and an app Worker together in one local
// `wrangler dev`, with local D1 databases (state in .dev/state). No Cloudflare account or network access needed.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { gatewayDir, writeAppConfig } from './app-config.mjs'

const argument = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const app = argument('--app', 'stub')
const port = argument('--port', '8787')
const wrangler = join(gatewayDir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
const state = join(gatewayDir, '.dev', 'state')
const gatewayConfig = join(gatewayDir, 'wrangler.local.jsonc')
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_TELEMETRY_DISABLED: '1' }

function run(args, stdio = 'inherit') {
  return new Promise((accept, reject) => {
    const child = spawn(wrangler, args, { cwd: gatewayDir, stdio, env })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? accept() : reject(new Error(`wrangler ${args.join(' ')} exited ${code}`))))
  })
}

const appConfig = await writeAppConfig(app)
await run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', gatewayConfig, '--persist-to', state])
if (app === 'captable') await run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', appConfig, '--persist-to', state])

console.log(`
  Landing       http://insulinapps.localhost:${port}/
  Accounts      http://auth.insulinapps.localhost:${port}/
  App           http://captable.insulinapps.localhost:${port}/
  Captured mail http://auth.insulinapps.localhost:${port}/__insulin/dev/mail
`)
await run(['dev', '--config', gatewayConfig, '--config', appConfig, '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', port])
