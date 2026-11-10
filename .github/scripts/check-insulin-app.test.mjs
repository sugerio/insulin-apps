import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-insulin-app.mjs')
const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

/** Runs the checker on a throwaway app directory and returns its report (the problems, one per line). */
async function check(name, manifest, builtWrangler) {
  const root = await mkdtemp(join(tmpdir(), 'check-insulin-app-'))
  temporary.push(root)
  const app = join(root, name)
  await mkdir(join(app, '.output', 'server'), { recursive: true })
  await writeFile(join(app, 'package.json'), JSON.stringify(manifest))
  if (builtWrangler) await writeFile(join(app, '.output', 'server', 'wrangler.json'), JSON.stringify(builtWrangler))
  const result = spawnSync(process.execPath, [script, app, ...(builtWrangler ? ['--built'] : [])], { encoding: 'utf8' })
  return result.stderr
}

test('the manifest fields the gateway reads are checked as the deploy checks them', async () => {
  const report = await check('signing', { insulin: { publicPaths: ['/api/'], secrets: ['OTHER_KEY'], permissions: [{ key: 'Bad Key' }] } })
  assert.match(report, /insulin\.publicPaths\[0\] must not cover every path or the whole API/)
  assert.match(report, /insulin\.secrets\[0\] must match \^SIGNING_/)
  assert.match(report, /insulin\.permissions\[0\]\.key must match/)
  const fine = await check('signing', { insulin: { publicPaths: ['/sign'], secrets: ['SIGNING_KEY'], scheduled: '/api/scheduled' } })
  assert.doesNotMatch(fine, /insulin\./)
})

test("an app's scheduled path is checked as the deploy checks it, against its public paths", async () => {
  assert.match(await check('signing', { insulin: { publicPaths: ['/api/public/'], scheduled: '/api/public/tick' } }), /insulin\.scheduled must not be one of the app's public paths/)
  assert.match(await check('signing', { insulin: { scheduled: '/tick' } }), /insulin\.scheduled must be a path under \/api\//)
  assert.match(await check('signing', { insulin: { scheduled: '/api/__suger/tick' } }), /insulin\.scheduled must not reach \/api\/__suger/)
  // Checked against what was declared even when the public paths themselves are refused.
  assert.match(await check('signing', { insulin: { publicPaths: ['/api/public/', 7], scheduled: '/api/public/tick' } }), /insulin\.scheduled must not be one of/)
})

test('a build that declares any binding is refused: apps get only D1 and static assets', async () => {
  const report = await check('signing', {}, {
    compatibility_date: '2026-11-01', main: 'index.mjs', r2_buckets: [{ binding: 'FILES' }], triggers: { crons: ['*/5 * * * *'] }, send_email: [{ name: 'EMAIL' }],
  })
  for (const key of ['r2_buckets', 'triggers', 'send_email']) assert.match(report, new RegExp(`wrangler\\.json declares ${key}`), key)
})
