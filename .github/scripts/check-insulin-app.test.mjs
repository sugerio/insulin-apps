import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-insulin-app.mjs')
const engineFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'engine')
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

test("an app's navigation manifest is checked as the deploy checks it", async () => {
  const report = await check('signing', { insulin: { navigation: [{ key: 'people', label: 'People', icon: 'users', path: '/settings/users' }] } })
  assert.match(report, /insulin\.navigation\[0\]\.path must not be one of the gateway's paths \(\/settings\)/)
  assert.match(await check('signing', { insulin: { navigation: [{ key: 'a', label: 'A', icon: 'rocket', path: '/a' }] } }), /insulin\.navigation\[0\]\.icon must be one of/)
  const fine = await check('signing', {
    insulin: { navigation: [{ key: 'envelopes', label: 'Envelopes', icon: 'inbox', path: '/envelopes', children: [{ key: 'drafts', label: 'Drafts', icon: 'file-pen', path: '/envelopes?status=draft' }] }] },
  })
  assert.doesNotMatch(fine, /insulin\./)
})

test("an app's scheduled path is checked as the deploy checks it, against its public paths", async () => {
  assert.match(await check('signing', { insulin: { publicPaths: ['/api/public/'], scheduled: '/api/public/tick' } }), /insulin\.scheduled must not be one of the app's public paths/)
  assert.match(await check('signing', { insulin: { scheduled: '/tick' } }), /insulin\.scheduled must be a path under \/api\//)
  assert.match(await check('signing', { insulin: { scheduled: '/api/__suger/tick' } }), /insulin\.scheduled must not reach \/api\/__suger/)
  // Checked against what was declared even when the public paths themselves are refused.
  assert.match(await check('signing', { insulin: { publicPaths: ['/api/public/', 7], scheduled: '/api/public/tick' } }), /insulin\.scheduled must not be one of/)
})

test('PLT-01: a build that declares any binding is refused: apps get only D1 and static assets', async () => {
  const report = await check('signing', {}, {
    compatibility_date: '2026-11-01', main: 'index.mjs', r2_buckets: [{ binding: 'FILES' }], triggers: { crons: ['*/5 * * * *'] }, send_email: [{ name: 'EMAIL' }],
  })
  for (const key of ['r2_buckets', 'triggers', 'send_email']) assert.match(report, new RegExp(`wrangler\\.json declares ${key}`), key)
})

/**
 * Runs the checker on a throwaway app with the synthetic engine (fixtures/engine) in engine/, after `change` alters
 * it, and returns the engine's problems only (the throwaway app lacks the rest of an app, which its own lines report).
 */
async function checkEngine(change = async () => {}, { name = 'alpha', insulin = {}, built = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'check-insulin-app-engine-'))
  temporary.push(root)
  const app = join(root, name)
  const engine = join(app, 'engine')
  await mkdir(app, { recursive: true })
  await cp(engineFixture, engine, { recursive: true })
  await writeFile(join(app, 'package.json'), JSON.stringify({ insulin: { engine: 'engine/', engineApi: 1, ...insulin } }))
  if (name !== 'alpha') await edit(engine, 'wrangler.jsonc', (text) => text.replace('insulin-apps-alpha-engine', `insulin-apps-${name}-engine`))
  await change(engine, app)
  const result = spawnSync(process.execPath, [script, app, ...(built ? ['--built'] : [])], { encoding: 'utf8' })
  return result.stderr.split('\n').filter((line) => /^ {2}- (engine \(|.*insulin\.engine|.*\/\.output\/worker)/.test(line)).join('\n')
}

async function edit(directory, file, change) {
  await writeFile(join(directory, file), change(await readFile(join(directory, file), 'utf8')))
}

const config = (change) => (engine) => edit(engine, 'wrangler.jsonc', change)

test("PLT-01: the synthetic engine passes the engine's own rules", async () => {
  assert.equal(await checkEngine(), '')
})

test("PLT-01: the engine directory is left out of the app's rules: its files, its cloudflare: imports and its wrangler.jsonc", async () => {
  const report = await checkEngine(async (engine) => {
    await writeFile(join(engine, 'src', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0xff))
    await writeFile(join(engine, 'src', 'more.ts'), "import { env } from 'cloudflare:workers'\nexport const value = env\n")
  })
  assert.equal(report, '')
  const root = await mkdtemp(join(tmpdir(), 'check-insulin-app-engine-'))
  temporary.push(root)
  const app = join(root, 'alpha')
  await cp(engineFixture, join(app, 'engine'), { recursive: true })
  await writeFile(join(app, 'engine', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0xff))
  await writeFile(join(app, 'package.json'), JSON.stringify({ insulin: { engine: 'engine/', engineApi: 1 } }))
  const full = spawnSync(process.execPath, [script, app], { encoding: 'utf8' }).stderr
  assert.doesNotMatch(full, /big\.bin|is not UTF-8|imports a cloudflare: module|wrangler\.jsonc must not exist/)
  // Without an engine, the same directory is the app's: its wrangler.jsonc, binary file and Worker imports are refused.
  await writeFile(join(app, 'wrangler.jsonc'), '{}')
  await mkdir(join(app, 'src'), { recursive: true })
  await writeFile(join(app, 'src', 'worker.ts'), "import { DurableObject } from 'cloudflare:workers'\n")
  await writeFile(join(app, 'package.json'), JSON.stringify({}))
  const plain = spawnSync(process.execPath, [script, app], { encoding: 'utf8' }).stderr
  assert.match(plain, /engine\/big\.bin is 2097152 bytes/)
  assert.match(plain, /wrangler\.jsonc must not exist/)
  assert.match(plain, /src\/worker\.ts imports a cloudflare: module/)
})

test('PLT-01: an engine that declares a route, a custom domain or an account is refused', async () => {
  assert.match(await checkEngine(config((text) => text.replace('"workers_dev"', '"routes": [{ "pattern": "engine.example.com", "custom_domain": true }],\n  "workers_dev"'))),
    /wrangler\.jsonc: routes is not allowed: the engine has no address of its own/)
  assert.match(await checkEngine(config((text) => text.replace('"workers_dev"', '"route": "engine.example.com/*",\n  "workers_dev"'))), /route is not allowed/)
  assert.match(await checkEngine(config((text) => text.replace('"workers_dev"', `"account_id": "${'ab'.repeat(16)}",\n  "workers_dev"`))),
    /account_id is not allowed: the deploy names the account/)
  assert.match(await checkEngine(config((text) => text.replace('"@cf/example/model"', `"${'cd'.repeat(16)}"`))), /looks like an account id/)
})

test('PLT-01: an engine that declares a binding outside the list is refused', async () => {
  for (const [key, value] of [
    ['kv_namespaces', '[{ "binding": "CACHE" }]'], ['services', '[{ "binding": "GATEWAY", "service": "insulin-apps-gateway" }]'],
    ['d1_databases', '[{ "binding": "DB" }]'], ['queues', '{}'], ['triggers', '{ "crons": ["* * * * *"] }'], ['send_email', '[]'],
    ['assets', '{ "directory": "public" }'], ['unsafe', '{}'], ['exports', '{}'],
  ]) {
    const report = await checkEngine(config((text) => text.replace('"workers_dev"', `"${key}": ${value},\n  "workers_dev"`)))
    assert.match(report, new RegExp(`wrangler\\.jsonc: ${key} is not allowed \\(an engine may declare only`), key)
  }
})

test('an engine must keep workers.dev and preview URLs off, and carry its own Worker name', async () => {
  assert.match(await checkEngine(config((text) => text.replace('"workers_dev": false', '"workers_dev": true'))), /workers_dev must be false/)
  assert.match(await checkEngine(config((text) => text.replace('"workers_dev": false,', ''))), /workers_dev must be false/)
  assert.match(await checkEngine(config((text) => text.replace('"preview_urls": false,', ''))), /preview_urls must be false/)
  assert.match(await checkEngine(config((text) => text.replace('insulin-apps-alpha-engine', 'another-worker'))), /name must be insulin-apps-alpha-engine/)
  assert.match(await checkEngine(config((text) => text.replace('"src/index.ts"', '"../outside.ts"'))), /main must be a file inside the engine directory/)
  assert.match(await checkEngine(config((text) => text.replace('"2026-10-13"', '"2026-02-30"'))), /compatibility_date must be a date/)
})

test("an engine binds only its own Durable Object classes, and its migrations never take another Worker's", async () => {
  assert.match(await checkEngine(config((text) => text.replace('"class_name": "Capacity" }', '"class_name": "Capacity", "script_name": "insulin-apps-gateway" }'))),
    /durable_objects\.bindings\[1\]\.script_name is not allowed: an engine binds only its own classes/)
  assert.match(await checkEngine(config((text) => text.replace('"class_name": "Capacity" }', '"class_name": "Elsewhere" }'))),
    /durable_objects\.bindings\[1\]\.class_name must be one of the engine's own classes/)
  assert.match(await checkEngine(config((text) => text.replace('{ "tag": "v1",', '{ "tag": "v0", "transferred_classes": [{ "from": "X", "from_script": "other", "to": "Y" }] },\n    { "tag": "v1",'))),
    /migrations\[0\]\.transferred_classes would take over another Worker's stored objects/)
  assert.match(await checkEngine(config((text) => text.replace('{ "tag": "v1",', '{ "tag": "v1", "from_script": "other",'))), /migrations\[0\]\.from_script would take over/)
  assert.match(await checkEngine(config((text) => text.replace('{ "tag": "v1", "new_sqlite_classes": ["CollectionEngine", "Capacity"] },',
    '{ "tag": "v1", "new_sqlite_classes": ["CollectionEngine", "Capacity"] },\n    { "tag": "v1", "deleted_classes": ["Missing"] },'))),
  /migrations\[1\]\.tag "v1" is used twice[\s\S]*migrations\[1\] deletes Missing, which isn't one of the engine's classes/)
  // Renaming keeps the class the engine's own.
  assert.equal(await checkEngine(config((text) => text
    .replace('{ "tag": "v1", "new_sqlite_classes": ["CollectionEngine", "Capacity"] },', '{ "tag": "v1", "new_sqlite_classes": ["CollectionEngine", "Limits"] },\n    { "tag": "v2", "renamed_classes": [{ "from": "Limits", "to": "Capacity" }] },')
  )), '')
})

test('R2 bindings name no bucket, match [A-Z][A-Z0-9]*, and make a bucket name within 63 characters', async () => {
  assert.match(await checkEngine(config((text) => text.replace('{ "binding": "FILES" }', '{ "binding": "FILES", "bucket_name": "my-bucket" }'))),
    /r2_buckets\[0\]\.bucket_name is not allowed: the deploy creates and names the bucket/)
  assert.match(await checkEngine(config((text) => text.replace('{ "binding": "FILES" }', '{ "binding": "FILES", "preview_bucket_name": "x" }'))), /preview_bucket_name is not allowed/)
  for (const binding of ['MY_FILES', 'files', '1FILES', 'FILES-2']) {
    assert.match(await checkEngine(config((text) => text.replace('"binding": "FILES"', `"binding": "${binding}"`))), /r2_buckets\[0\]\.binding must match \^\[A-Z\]\[A-Z0-9\]\*\$/, binding)
  }
  // insulin-apps- (13) + a 32-character app + -engine- (8) + 11 = 64.
  const name = `k${'x'.repeat(31)}`
  assert.match(await checkEngine(config((text) => text.replace('"binding": "FILES"', '"binding": "FILESFILESF"')), { name }),
    /makes the bucket name insulin-apps-kx+-engine-filesfilesf, longer than R2's 63 characters/)
  assert.equal(await checkEngine(config((text) => text.replace('"binding": "FILES"', '"binding": "FILESFILES"')), { name }), '')
})

test('an engine\'s vars hold no secret and no platform name', async () => {
  for (const name of ['API_TOKEN', 'SIGNING_SECRET', 'DB_PASSWORD', 'OPENAI_API_KEY', 'PRIVATE_PEM']) {
    assert.match(await checkEngine(config((text) => text.replace('"ANSWER_MODEL"', `"${name}"`))), new RegExp(`vars\\.${name} looks like a secret`), name)
  }
  assert.match(await checkEngine(config((text) => text.replace('"ANSWER_MODEL"', '"SUGER_ENGINE_SERVES"'))), /vars\.SUGER_ENGINE_SERVES SUGER_ENGINE_SERVES is the platform's/)
  assert.match(await checkEngine(config((text) => text.replace('"ANSWER_MODEL": "@cf/example/model"', '"ANSWER_MODEL": { "nested": true }'))), /must be a string, a number or a boolean/)
  assert.match(await checkEngine(config((text) => text.replace('"ANSWER_MODEL"', '"FILES"'))), /vars\.FILES FILES is used twice/)
})

test("a container's image is a Dockerfile in the engine directory, never an image in a registry", async () => {
  const ref = 'registry.cloudflare.com/example/insulin-apps-alpha-engine:latest'
  const report = await checkEngine(config((text) => text.replace('"./container/Dockerfile"', `"${ref}"`)))
  assert.match(report, /containers\[0\]\.image must point at a Dockerfile in the engine directory/)
  assert.match(report, /wrangler\.jsonc names an image in the registry/)
  assert.match(await checkEngine(config((text) => text.replace('"./container/Dockerfile"', '"../Dockerfile"'))), /containers\[0\]\.image must point at a Dockerfile in the engine directory/)
  assert.match(await checkEngine(config((text) => text.replace('"image": "./container/Dockerfile"', '"images": { "base": { "image": "python@sha256:0" } }'))),
    /containers\[0\]\.images\.base\.image names an image in a registry/)
  assert.equal(await checkEngine(config((text) => text.replace('"image": "./container/Dockerfile"', '"images": { "base": { "dockerfile": "./container/Dockerfile" } }'))), '')
  assert.match(await checkEngine(config((text) => text.replace('"instance_type"', '"ssh": { "enabled": true }, "instance_type"'))), /containers\[0\]\.ssh is not allowed/)
  assert.match(await checkEngine(config((text) => text.replace('"class_name": "CollectionEngine", "image"', '"class_name": "Other", "image"'))), /containers\[0\]\.class_name must be a Durable Object class the engine binds/)
  // A container its Durable Object starts takes no instance type or max_instances: Wrangler refuses them.
  const started = '"scheduling_policy": "durable_object", "images": { "base": { "dockerfile": "./container/Dockerfile" } }'
  assert.equal(await checkEngine(config((text) => text.replace('"image": "./container/Dockerfile", "instance_type": "standard-4", "max_instances": 20', started))), '')
  const refused = await checkEngine(config((text) => text.replace('"image": "./container/Dockerfile", "instance_type": "standard-4", "max_instances": 20', `${started}, "instance_type": "standard-4", "max_instances": 24`)))
  assert.match(refused, /containers\[0\]\.instance_type is not allowed for a container its Durable Object starts/)
  assert.match(refused, /containers\[0\]\.max_instances is not allowed for a container its Durable Object starts \(scheduling_policy "durable_object"\): Wrangler refuses it/)
  // One image an engine: a second Dockerfile is refused.
  const two = await checkEngine(async (engine) => {
    await writeFile(join(engine, 'container', 'Dockerfile.other'), await readFile(join(engine, 'container', 'Dockerfile'), 'utf8'))
    await edit(engine, 'wrangler.jsonc', (text) => text.replace('"r2_buckets"', '"containers_x": 1,\n  "r2_buckets"').replace('"containers_x": 1,\n  ', '')
      .replace('"instance_type": "standard-4", "max_instances": 20 },', '"instance_type": "standard-4", "max_instances": 20 },\n    { "class_name": "Capacity", "image": "./container/Dockerfile.other" },'))
  })
  assert.match(two, /containers must all be built from one Dockerfile/)
  // A registry reference anywhere in the engine directory.
  assert.match(await checkEngine((engine) => writeFile(join(engine, 'README.md'), `Pushed as ${ref}\n`)), /README\.md names an image in the registry/)
  assert.match(await checkEngine((engine) => writeFile(join(engine, 'notes.md'), `insulin-apps-alpha-engine@sha256:${'2'.repeat(64)}\n`)), /notes\.md names an image in the registry/)
})

test("the engine's base image is pinned by digest, and its image takes nothing from outside the engine directory", async () => {
  const dockerfile = (change) => (engine) => edit(engine, join('container', 'Dockerfile'), change)
  assert.match(await checkEngine(dockerfile((text) => text.replace(/@sha256:1+ AS base/, ' AS base'))), /Dockerfile line 3: FROM python:3\.12-slim must be pinned by digest/)
  assert.match(await checkEngine(dockerfile((text) => text.replace('FROM base', 'FROM python:latest'))), /FROM python:latest must be pinned by digest/)
  assert.match(await checkEngine(dockerfile((text) => `ARG BASE=python\n${text.replace(/FROM python\S+/, 'FROM ${BASE}')}`)), /FROM \$\{BASE\} must be pinned by digest/)
  assert.match(await checkEngine(dockerfile((text) => `${text}COPY --from=ghcr.io/example/tools:1 /bin/tool /bin/tool\n`)), /COPY --from ghcr\.io\/example\/tools:1 must be pinned by digest/)
  assert.equal(await checkEngine(dockerfile((text) => `${text}COPY --from=base /app /copy\n`)), '')
  assert.match(await checkEngine(dockerfile((text) => `${text}ADD https://example.com/model.bin /models/\n`)), /ADD https:\/\/example\.com\/model\.bin fetches from outside/)
  assert.match(await checkEngine(dockerfile((text) => `${text}COPY missing.txt /app/\n`)), /Dockerfile line \d+: missing\.txt matches nothing in the build context/)
  assert.match(await checkEngine(dockerfile((text) => `${text}COPY ../src /app/src\n`)), /\.\.\/src is outside the build context/)
})

test("the engine's package: exact versions, the API versions it serves covering the app's, wrangler and its scripts", async () => {
  const manifest = (change) => (engine) => edit(engine, 'package.json', (text) => JSON.stringify(change(JSON.parse(text))))
  assert.match(await checkEngine(manifest((json) => ({ ...json, devDependencies: { wrangler: '^4.149.0' } }))), /devDependencies\.wrangler is "\^4\.149\.0"; pin an exact registry version/)
  assert.match(await checkEngine(manifest((json) => ({ ...json, devDependencies: { typescript: '6.0.3' } }))), /must depend on wrangler/)
  assert.match(await checkEngine(manifest((json) => ({ ...json, scripts: { typecheck: 'tsc' } }))), /missing the "test" script/)
  assert.match(await checkEngine(manifest((json) => ({ ...json, workspaces: ['a'] }))), /must not declare workspaces/)
  assert.match(await checkEngine(manifest((json) => ({ ...json, insulin: {} }))), /must declare "insulin": \{ "serves": \[min, max\] \}/)
  assert.match(await checkEngine(manifest((json) => ({ ...json, insulin: { serves: [2, 1] } }))), /serves/)
  assert.match(await checkEngine(manifest((json) => ({ ...json, insulin: { serves: [2, 3] } }))), /serves engine API 2-3, but the app calls 1 \(insulin\.engineApi\)/)
  assert.equal(await checkEngine(async () => {}, { insulin: { engineApi: 2 } }), '', 'serves [1, 2] covers 2')
  assert.match(await checkEngine(async () => {}, { insulin: { engineApi: 3 } }), /serves engine API 1-2, but the app calls 3/)
})

test("the engine's lockfile is npm's, exact and from the registry only, and it has one Wrangler config", async () => {
  const lock = (change) => (engine) => edit(engine, 'package-lock.json', (text) => JSON.stringify(change(JSON.parse(text))))
  assert.match(await checkEngine(lock((json) => {
    json.packages['node_modules/wrangler'].resolved = 'https://packages.example.com/wrangler.tgz'
    return json
  })), /node_modules\/wrangler resolves outside registry\.npmjs\.org/)
  assert.match(await checkEngine(lock((json) => ({ ...json, packages: { ...json.packages, 'node_modules/local': { link: true, resolved: '../local' } } }))), /node_modules\/local is a linked package/)
  assert.match(await checkEngine(lock((json) => ({ ...json, lockfileVersion: 1 }))), /lockfileVersion is 1/)
  assert.match(await checkEngine((engine) => rm(join(engine, 'package-lock.json'))), /package-lock\.json is missing/)
  for (const file of ['yarn.lock', 'pnpm-lock.yaml', 'wrangler.toml', 'wrangler.json']) {
    assert.match(await checkEngine((engine) => writeFile(join(engine, file), '')), new RegExp(`${file.replace('.', '\\.')} must not exist`), file)
  }
  assert.match(await checkEngine((engine) => rm(join(engine, 'wrangler.jsonc'))), /the engine has no wrangler\.jsonc/)
  assert.match(await checkEngine((engine) => writeFile(join(engine, 'wrangler.jsonc'), '{ "name": ')), /is not valid JSON with comments/)
  assert.match(await checkEngine((engine) => symlink('/etc/hosts', join(engine, 'src', 'linked.ts'))), /src\/linked\.ts is not a regular file/)
})

test("the app's manifest declares its engine and limits as the deploy reads them; the bundle is checked with --built", async () => {
  assert.match(await checkEngine(async () => {}, { insulin: { engine: '../engine' } }), /insulin\.engine must be a directory inside the app/)
  assert.match(await checkEngine(async () => {}, { insulin: { engineApi: undefined } }), /insulin\.engineApi must be a positive integer/)
  assert.match(await checkEngine(async (engine) => rm(engine, { recursive: true })), /engine \(engine\/\): the directory is missing/)
  assert.match(await check('signing', { insulin: { limits: [{ key: 'Bad', label: 'x', unit: 'count', default: 1 }] } }), /insulin\.limits\[0\]\.key must match/)
  assert.doesNotMatch(await check('signing', { insulin: { limits: [{ key: 'documents', label: 'Documents', unit: 'count', default: 500 }] } }), /insulin\./)
  assert.match(await checkEngine(async () => {}, { built: true }), /engine\/\.output\/worker\/index\.js is missing/)
  assert.doesNotMatch(await checkEngine(async (engine) => {
    await mkdir(join(engine, '.output', 'worker'), { recursive: true })
    await writeFile(join(engine, '.output', 'worker', 'index.js'), 'export default {}\n')
  }, { built: true }), /index\.js is missing/)
})

test("the engine's image installs packages pinned with hashes (§8.7), and its Dockerfile says where it doesn't", async () => {
  const dockerfile = (change) => (engine) => edit(engine, join('container', 'Dockerfile'), change)
  assert.match(await checkEngine(dockerfile((text) => text.replace('pip install --no-deps --require-hashes', 'pip install --no-deps'))),
    /container\/Dockerfile: Dockerfile line 7: pip install must use --require-hashes, with a requirements file that pins every package by version and hash/)
  assert.match(await checkEngine(dockerfile((text) => `${text}RUN apt-get update && apt-get install -y --no-install-recommends tini\n`)),
    /apt-get install tini: pin each package's version \(name=version\)/)
  assert.equal(await checkEngine(dockerfile((text) => `${text}RUN apt-get update && apt-get install -y --no-install-recommends tini=0.19.0-1\n`)), '')
  assert.match(await checkEngine(dockerfile((text) => `${text}RUN curl -fsSL https://example.com/model.bin -o /models/model.bin\n`)), /curl downloads must be checked against a hash/)
})

test("the engine's package has the scripts the app's pipeline runs: check (with Wrangler's --config), test:container with a container, test:python with Python", async () => {
  const scripts = (change) => (engine) => edit(engine, 'package.json', (text) => {
    const json = JSON.parse(text)
    json.scripts = change({ ...json.scripts })
    return JSON.stringify(json)
  })
  const without = (name) => scripts((all) => { delete all[name]; return all })
  assert.match(await checkEngine(without('check')), /missing the "check" script, which the app's pipeline runs/)
  assert.match(await checkEngine(scripts((all) => ({ ...all, check: 'wrangler deploy --dry-run' }))), /"check" script must give Wrangler its --config/)
  assert.equal(await checkEngine(scripts((all) => ({ ...all, check: 'tsc --noEmit && wrangler deploy -c wrangler.jsonc --dry-run' }))), '')
  assert.match(await checkEngine(without('test:container')), /missing the "test:container" script: an engine with a container tests it/)
  assert.match(await checkEngine(without('test:python')), /missing the "test:python" script: the image runs Python/)
  // Without Python in the image, no Python tests are asked for.
  assert.equal(await checkEngine(async (engine) => {
    await without('test:python')(engine)
    await rm(join(engine, 'container', 'server', 'main.py'))
    await writeFile(join(engine, 'container', 'server', 'main.sh'), 'echo fixture\n')
  }), '')
  assert.match(await checkEngine((engine) => rm(join(engine, 'test', 'python', 'requirements.lock'))),
    /declares "test:python", so test\/python\/requirements\.lock must list what its Python tests install, each pinned with --hash/)
  assert.match(await checkEngine((engine) => writeFile(join(engine, 'test', 'python', 'requirements.lock'), 'pypdf==6.21.4\n')),
    /test\/python\/requirements\.lock: pypdf==6\.21\.4 must carry --hash=sha256/)
})
