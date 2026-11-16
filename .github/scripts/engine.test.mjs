import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  deployedEngineConfig,
  dockerfileAnalysis,
  dockerfileInstructions,
  engineImageSources,
  engineImageTag,
  imageInputs,
  migrationClasses,
  parseJsonc,
  parseServes,
  readEngineConfig,
  servesApi,
} from './engine.mjs'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'engine')
const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

async function engineCopy() {
  const root = await mkdtemp(join(tmpdir(), 'engine-'))
  temporary.push(root)
  const engine = join(root, 'engine')
  await cp(fixture, engine, { recursive: true })
  return engine
}

test('reads wrangler.jsonc as Wrangler does: comments and trailing commas, never inside strings', () => {
  assert.deepEqual(parseJsonc('// a\n{ "a": "x // not a comment", /* b */ "b": [1, 2,], "c": "/* kept */", "d": "q\\"//", }\n'), {
    a: 'x // not a comment', b: [1, 2], c: '/* kept */', d: 'q"//',
  })
  assert.throws(() => parseJsonc('{ /* open'), /unterminated comment/)
  assert.throws(() => parseJsonc('{ "a": }'))
})

test("a Dockerfile's instructions: continuations joined, comments and heredoc bodies skipped", () => {
  const text = [
    '# syntax=docker/dockerfile:1',
    'FROM base@sha256:' + 'a'.repeat(64) + ' AS build',
    'RUN echo one \\',
    '# a comment inside the continuation',
    '    two',
    'COPY <<EOF /etc/config',
    'COPY not-an-instruction /x',
    'EOF',
    'RUN cat <<<"here string"',
    'copy --chown=1000 a.txt b.txt /app/',
  ].join('\n')
  assert.deepEqual(dockerfileInstructions(text).map(({ keyword, args, line }) => [keyword, args, line]), [
    ['FROM', `base@sha256:${'a'.repeat(64)} AS build`, 2],
    ['RUN', 'echo one      two', 3],
    ['COPY', '<<EOF /etc/config', 6],
    ['RUN', 'cat <<<"here string"', 9],
    ['COPY', '--chown=1000 a.txt b.txt /app/', 10],
  ])
  const { problems, sources } = dockerfileAnalysis(text)
  assert.deepEqual(problems, [])
  assert.deepEqual(sources.map(({ source }) => source), ['a.txt', 'b.txt'], 'a heredoc source is the Dockerfile itself')
})

test("what a Dockerfile reads from the context: COPY and ADD sources, JSON lists and RUN's bind mounts", () => {
  const digest = `@sha256:${'b'.repeat(64)}`
  const { problems, sources } = dockerfileAnalysis([
    `FROM --platform=linux/amd64 python${digest} AS base`,
    'COPY ["with space.txt", "/app/"]',
    'ADD archive.tar /opt/',
    'RUN --mount=type=bind,source=wheels,target=/wheels pip install /wheels/*',
    'RUN --mount=type=cache,target=/root/.cache pip --version',
    'RUN --mount=type=bind,target=/ctx ls /ctx',
    'COPY --from=base /app /app',
    'COPY --from=0 /app /app2',
  ].join('\n'))
  assert.deepEqual(problems, [])
  assert.deepEqual(sources.map(({ source }) => source), ['with space.txt', 'archive.tar', 'wheels', '.'])
  const refused = dockerfileAnalysis(['FROM python:3.12', 'FROM scratch', 'ADD git@example.com:repo.git /src', 'RUN --mount=type=bind,from=tools:1,target=/t true'].join('\n'))
  assert.deepEqual(refused.problems.map((problem) => problem.replace(/ must.*| fetches.*/, '')), [
    'Dockerfile line 1: FROM python:3.12', 'Dockerfile line 3: ADD git@example.com:repo.git', 'Dockerfile line 4: RUN --mount from tools:1',
  ])
})

test("PLT-04: the image's tag is a hash of the Dockerfile and what it copies, wherever the engine is", async () => {
  const one = await engineCopy()
  const two = await engineCopy()
  const tag = engineImageTag(one)
  assert.match(tag, /^inputs-[0-9a-f]{64}$/)
  assert.equal(engineImageTag(two), tag, 'the same inputs in another directory: the same tag')
  // What the image doesn't copy leaves the tag alone: the engine's Worker code, notes beside the Dockerfile.
  await writeFile(join(two, 'src', 'index.ts'), 'export default {}\n')
  await writeFile(join(two, 'container', 'notes.txt'), 'changed\n')
  assert.equal(engineImageTag(two), tag, "a change to the engine's Worker alone keeps the image")
  await writeFile(join(two, 'container', 'server', 'main.py'), 'print("changed")\n')
  assert.notEqual(engineImageTag(two), tag, 'a copied file changes it')
  const three = await engineCopy()
  await writeFile(join(three, 'container', 'Dockerfile'), `${await readFile(join(three, 'container', 'Dockerfile'), 'utf8')}ENV MODE=strict\n`)
  assert.notEqual(engineImageTag(three), tag, 'the Dockerfile changes it')
  const four = await engineCopy()
  await writeFile(join(four, 'wrangler.jsonc'), (await readFile(join(four, 'wrangler.jsonc'), 'utf8')).replace('"max_instances": 20 }', '"max_instances": 20, "image_vars": { "MODEL": "small" } }'))
  assert.notEqual(engineImageTag(four), tag, 'build variables change it')
  // What installs and builds write in the context never counts.
  const five = await engineCopy()
  await mkdir(join(five, 'container', 'server', 'node_modules'), { recursive: true })
  await writeFile(join(five, 'container', 'server', 'node_modules', 'installed.py'), 'print("installed")\n')
  assert.equal(engineImageTag(five), tag)
})

test('copied directories and globs take every file they reach; .dockerignore counts too', async () => {
  const engine = await engineCopy()
  const dockerfile = join(engine, 'container', 'Dockerfile')
  await writeFile(dockerfile, `FROM scratch\nCOPY server /s\nCOPY *.lock /l/\nCOPY ./server/**/*.py /p/\n`)
  await writeFile(join(engine, 'container', '.dockerignore'), 'notes.txt\n')
  const inputs = imageInputs(engineImageSources(engine, readEngineConfig(engine)))
  assert.deepEqual(inputs.files, ['.dockerignore', 'requirements.lock', 'server/main.py'])
  await writeFile(dockerfile, 'FROM scratch\nCOPY . /all\n')
  assert.deepEqual(imageInputs(engineImageSources(engine, readEngineConfig(engine))).files, ['.dockerignore', 'Dockerfile', 'notes.txt', 'requirements.lock', 'server/main.py'])
  await writeFile(dockerfile, 'FROM scratch\nCOPY *.md /docs/\n')
  assert.throws(() => imageInputs(engineImageSources(engine, readEngineConfig(engine))), /\*\.md matches nothing in the build context/)
})

test("migrations leave the engine its own classes: created, renamed and deleted, never another Worker's", () => {
  const { classes, tags, problems } = migrationClasses([
    { tag: 'v1', new_sqlite_classes: ['A', 'B'] },
    { tag: 'v2', renamed_classes: [{ from: 'B', to: 'C' }], new_classes: ['D'] },
    { tag: 'v3', deleted_classes: ['D'] },
  ])
  assert.deepEqual([[...classes].sort(), tags, problems], [['A', 'C'], ['v1', 'v2', 'v3'], []])
  assert.match(migrationClasses([{ tag: 'v1', transferred_classes: [] }]).problems[0], /would take over another Worker's stored objects/)
  assert.match(migrationClasses([{ new_classes: ['A'] }]).problems[0], /tag must be a name/)
  assert.match(migrationClasses({}).problems[0], /must be an array/)
})

test('the API versions an engine serves, and the ones the deploy records', () => {
  assert.deepEqual(parseServes('1-2'), [1, 2])
  for (const bad of ['2-1', '0-1', '1', 'a-b', null, undefined, '1-2-3']) assert.equal(parseServes(bad), null, String(bad))
  assert.ok(servesApi([1, 2], 1) && servesApi([1, 2], 2))
  assert.ok(!servesApi([1, 2], 3) && !servesApi([2, 3], 1) && !servesApi([1, 2], null))
})

test("the deployed config takes only the engine's classes and bindings, names the buckets, pins the image and closes every address", async () => {
  const engine = await engineCopy()
  const config = readEngineConfig(engine)
  const image = `registry.cloudflare.com/account/insulin-apps-alpha-engine@sha256:${'c'.repeat(64)}`
  const deployed = deployedEngineConfig({ app: 'alpha', engineDirectory: engine, config: { ...config, $schema: 'x' }, imageReference: image, serves: [1, 2] })
  assert.deepEqual(deployed, {
    name: 'insulin-apps-alpha-engine',
    main: join(engine, '.output', 'worker', 'index.js'),
    no_bundle: true,
    compatibility_date: '2026-10-13',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    containers: [{ class_name: 'CollectionEngine', image, instance_type: 'standard-4', max_instances: 20 }],
    r2_buckets: [
      { binding: 'FILES', bucket_name: 'insulin-apps-alpha-engine-files' },
      { binding: 'BACKUPS', bucket_name: 'insulin-apps-alpha-engine-backups' },
    ],
    ai: { binding: 'AI' },
    observability: { enabled: true },
    vars: { ANSWER_MODEL: '@cf/example/model', SUGER_ENGINE_SERVES: '1-2' },
    workers_dev: false,
    preview_urls: false,
  })
  const named = deployedEngineConfig({
    app: 'alpha', engineDirectory: engine, imageReference: image, serves: [1, 1],
    config: { ...config, containers: [{ class_name: 'CollectionEngine', images: { base: { dockerfile: './container/Dockerfile', build_vars: { A: 'b' } } } }] },
  })
  assert.deepEqual(named.containers, [{ class_name: 'CollectionEngine', images: { base: { image } } }])
  assert.throws(() => deployedEngineConfig({ app: 'alpha', engineDirectory: engine, config, imageReference: null, serves: [1, 1] }), /no image to deploy/)
})
