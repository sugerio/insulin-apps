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
  for (const pattern of [/pull_request:/, /push:[\s\S]*branches: \[main, 'feat\/esign-\*'\]/, /workflow_dispatch:/, /esign\/\*\*/, /\.github\/scripts\/\*\*/, /contents: read/, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/]) assert.match(text, pattern)
  for (const pattern of [/node-version: 24/, /npm ci --ignore-scripts/, /npm run typecheck/, /test-concurrency=1/, /ESIGN_TEST_CHROME/, /check-public-content\.mjs/, /check-app-workflows\.mjs/, /local Wrangler migrations apply once/, /upload-artifact@[a-f0-9]{40}/, /retention-days: 3/, /! -type f ! -type d/]) assert.match(checks, pattern)
  assert.doesNotMatch(checks, /secrets\.|environment:|wrangler (?:deploy(?! --dry-run)|versions|d1)|scripts\/deploy\.ts/)
  // Only the single Worker is built: the candidate/consolidated topology was removed.
  assert.doesNotMatch(text, /candidate|consolidated/)
  assert.doesNotMatch(text, /pull_request_target/)
  for (const match of text.matchAll(/uses:\s*([^\s]+)/g)) assert.match(match[1], /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/)
})

test('esign deploys dev from main or an E-sign branch, prod only by hand from main', async () => {
  const text = await workflow()
  const checks = job(text, 'checks')
  // The target is chosen in the credential-free job: dev on a push once ESIGN_DEV_DEPLOY is true,
  // dev or prod by hand, and prod is refused off main. Inputs reach the script only through env.
  assert.match(text, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*target:[\s\S]*options: \[none, dev, prod\]/)
  assert.match(checks, /DEV_ON_PUSH: \$\{\{ vars\.ESIGN_DEV_DEPLOY \}\}/)
  assert.match(checks, /\[ "\$EVENT" = push \] && \[ "\$DEV_ON_PUSH" = true \]; then target=dev/)
  assert.match(checks, /\[ "\$target" = prod \] && \[ "\$REF" != refs\/heads\/main \]; then echo "::error::prod deploys only from main\."; exit 1/)
  assert.doesNotMatch(checks, /run: \|[^\n]*\n(?:[^\n]*\n)*?[^\n]*\$\{\{ inputs\./)
  assert.match(checks, /if: steps\.target\.outputs\.target != ''[\s\S]*name: esign-build/)
  // The job's default working directory (esign) exists only after the checkout, so every run
  // step comes after it.
  assert.ok(checks.indexOf('actions/checkout@') < checks.indexOf('name: Choose the deployment'), 'checkout first')

  const deploy = job(text, 'deploy')
  assert.match(deploy, /needs: checks/)
  assert.match(deploy, /if: needs\.checks\.outputs\.target != ''/)
  // dev in its own GitHub environment (any branch); prod in `production`, which only main may use.
  assert.match(deploy, /environment: \$\{\{ needs\.checks\.outputs\.target == 'prod' && 'production' \|\| 'esign-dev' \}\}/)
  assert.match(deploy, /group: deploy-esign-\$\{\{ needs\.checks\.outputs\.target \}\}/)
  assert.match(deploy, /cancel-in-progress: false/)
  assert.match(deploy, /download-artifact@[a-f0-9]{40}[\s\S]*name: esign-build/)
  assert.match(deploy, /check-build-archive\.mjs "\$members" esign-build/)
  assert.match(deploy, /--no-same-owner --no-same-permissions/)
  assert.match(deploy, /npm ci --ignore-scripts/)
  assert.match(deploy, /node scripts\/deploy\.ts --target "\$TARGET" --bundle "\$RUNNER_TEMP\/esign-build\/dist"/)
  assert.match(deploy, /TARGET: \$\{\{ needs\.checks\.outputs\.target \}\}/)
  assert.doesNotMatch(deploy, /npm run build|vite build|actions\/cache/)
  // Only the Cloudflare token is a secret; every deployment setting is a variable of the GitHub
  // environment, under the same name in both, and none is in the repository.
  assert.deepEqual([...deploy.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]), ['CLOUDFLARE_API_TOKEN'])
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'ESIGN_MAIL_FROM', 'ESIGN_MAIL_SINK', 'ESIGN_FRAME_ANCESTORS', 'ESIGN_KMS_KEY_ARN', 'ESIGN_KMS_PUBLIC_KEY', 'ESIGN_AWS_ROLE_ARN']) assert.match(deploy, new RegExp(`vars\\.${name}\\b`))
  assert.doesNotMatch(text, /ESIGN_DEV_(?!DEPLOY)\w+|ESIGN_PROD_\w+/)
})
