import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflow = () => readFile('.github/workflows/esign.yml', 'utf8')
/** The text of one job, from its key to the next job (jobs are indented by two spaces). */
const job = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `job ${name} exists`)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n  [\w-]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 2)
}

test('esign workflow is pinned and its checks job is credential-free and runs the intended checks', async () => {
  const text = await workflow()
  const checks = job(text, 'checks')
  for (const pattern of [/pull_request:/, /push:[\s\S]*branches: \[main\]/, /workflow_dispatch:/, /esign\/\*\*/, /\.github\/scripts\/\*\*/, /contents: read/, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/]) assert.match(text, pattern)
  for (const pattern of [/node-version: 24/, /npm ci --ignore-scripts/, /npm run typecheck/, /test-concurrency=1/, /ESIGN_TEST_CHROME/, /build:candidate-assets/, /check-public-content\.mjs/, /check-app-workflows\.mjs/, /local Wrangler migrations apply once/, /check-build-archive\.mjs/, /sha256sum/, /upload-artifact@[a-f0-9]{40}/, /retention-days: 3/, /! -type f ! -type d/]) assert.match(checks, pattern)
  assert.doesNotMatch(checks, /secrets\.|environment:|wrangler (?:deploy(?! --dry-run)|versions|d1)|scripts\/deploy\.ts/)
  assert.doesNotMatch(text, /pull_request_target/)
  for (const match of text.matchAll(/uses:\s*([^\s]+)/g)) assert.match(match[1], /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/)
})

test('esign dev deployment is opt-in, main-only, and deploys only the archive the checks job built', async () => {
  const text = await workflow()
  const deploy = job(text, 'deploy-dev')
  assert.match(deploy, /needs: checks/)
  assert.match(deploy, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main' && vars\.ESIGN_DEV_DEPLOY == 'true'/)
  assert.match(deploy, /environment: production/)
  assert.match(deploy, /cancel-in-progress: false/)
  assert.match(deploy, /download-artifact@[a-f0-9]{40}[\s\S]*name: esign-dev-build/)
  assert.match(deploy, /check-build-archive\.mjs "\$members" esign-build/)
  assert.match(deploy, /--no-same-owner --no-same-permissions/)
  assert.match(deploy, /npm ci --ignore-scripts/)
  assert.match(deploy, /node scripts\/deploy\.ts --target dev --bundle "\$RUNNER_TEMP\/esign-build\/dist"/)
  assert.doesNotMatch(deploy, /npm run build|vite build|actions\/cache/)
  // Only the Cloudflare token is a secret; every deployment setting is a variable, none is in the repository.
  assert.deepEqual([...deploy.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]), ['CLOUDFLARE_API_TOKEN'])
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'ESIGN_DEV_MAIL_FROM', 'ESIGN_DEV_MAIL_SINK', 'ESIGN_DEV_FRAME_ANCESTORS', 'ESIGN_DEV_KMS_KEY_ARN', 'ESIGN_DEV_KMS_PUBLIC_KEY', 'ESIGN_DEV_AWS_ROLE_ARN']) assert.match(deploy, new RegExp(`vars\\.${name}\\b`))
})
