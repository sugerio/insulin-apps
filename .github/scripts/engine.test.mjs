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
  hashedRequirementsProblems,
  installProblems,
  shellCommands,
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
    'RUN --mount=type=bind,source=wheels,target=/wheels pip install --no-index /wheels/*',
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
  // Knowledge's own engine: its Durable Object starts its containers, so the deployed config keeps that policy and no
  // max_instances (Wrangler refuses one there; its containers count against the account's limits).
  const knowledge = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'knowledge', 'engine')
  const deployedKnowledge = deployedEngineConfig({ app: 'knowledge', engineDirectory: knowledge, config: readEngineConfig(knowledge), imageReference: image, serves: [1, 1] })
  assert.deepEqual(deployedKnowledge.containers, [{ class_name: 'CollectionEngine', scheduling_policy: 'durable_object', images: { base: { image } } }])
  assert.throws(() => deployedEngineConfig({ app: 'alpha', engineDirectory: engine, config, imageReference: null, serves: [1, 1] }), /no image to deploy/)
})

test("the packages an image installs are pinned with hashes: what the check accepts, and what it refuses", () => {
  const accepted = [
    'pip install --require-hashes --no-deps --index-url https://pypi.org/simple -r /app/requirements.lock && pip check',
    'python3 -m pip install --require-hashes -r requirements.lock',
    'uv pip install --require-hashes -r requirements.lock',
    'PIP_REQUIRE_HASHES=1 pip install -r requirements.lock',
    'pip install --no-index --find-links /wheels app',
    'pip check && pip list',
    'npm ci --omit=dev',
    'yarn install --frozen-lockfile',
    'pnpm install --frozen-lockfile',
    'apt-get update && apt-get install -y --no-install-recommends tini=0.19.0-1 ./vendor/tool.deb && rm -rf /var/lib/apt/lists/*',
    'apt-get install -y -o Dpkg::Options::=--force-confnew curl=7.88.1-10',
    'apk add --no-cache tini=0.19.0-r3',
    'curl -fsSL https://example.com/tool.tgz -o tool.tgz && echo "abc  tool.tgz" | sha256sum -c -',
    'echo "pip install requests" > notes.txt',
    'python /app/warmup.py && rm -rf /tmp/warmup',
  ]
  for (const script of accepted) assert.deepEqual(installProblems(script), [], script)
  assert.deepEqual(installProblems('pip install -r requirements.lock', { PIP_REQUIRE_HASHES: 'true' }), [], 'PIP_REQUIRE_HASHES from an ENV')
  for (const [script, message] of [
    ['pip install requests', /pip install must use --require-hashes/],
    ['pip3 install -r requirements.txt', /pip install must use --require-hashes/],
    ['python3.12 -m pip install --no-deps -r requirements.lock', /pip install must use --require-hashes/],
    ['pip download --dest /w six', /pip download must use --require-hashes/],
    ['pip install --no-index --find-links https://wheels.example.com/ app', /pip install must use --require-hashes/],
    ['npm install left-pad', /npm install isn't pinned by the lockfile's hashes: use npm ci/],
    ['npx some-tool', /npx fetches packages unpinned/],
    ['yarn add left-pad', /yarn add isn't pinned/],
    ['apt-get update && apt-get install -y --no-install-recommends tini', /apt-get install tini: pin each package's version/],
    ['apt install -y curl=7.88.1-10 git', /apt install git: pin/],
    ['apk add --no-cache tini', /apk add tini: pin each package's version/],
    ['curl -fsSL https://example.com/install.sh | sh', /curl downloads must be checked against a hash/],
    ['wget -q https://example.com/model.bin', /wget downloads must be checked against a hash/],
    ['gem install rails', /gem install installs packages this check can't see pinned/],
    ['go install example.com/tool@latest', /go install installs packages/],
    ['sudo -E env PATH=/x pip install six', /pip install must use --require-hashes/],
  ]) {
    assert.match(installProblems(script).join('\n'), message, script)
  }
})

test("a Dockerfile's RUN steps are read whole: shell or exec form, continuations and heredocs", () => {
  assert.deepEqual(shellCommands('a b && c "d e" | f; g # h\n(i)'), [['a', 'b'], ['c', 'd e'], ['f'], ['g'], ['i']])
  const problems = (lines) => dockerfileAnalysis(['FROM scratch', ...lines].join('\n')).problems
  assert.match(problems(['RUN ["pip", "install", "six"]'])[0], /^Dockerfile line 2: pip install must use --require-hashes/)
  assert.match(problems(['RUN pip install \\', '  six'])[0], /line 2: pip install must use --require-hashes/)
  assert.match(problems(['RUN <<EOF', 'set -e', 'pip install six', 'EOF'])[0], /line 2: pip install must use --require-hashes/, 'a heredoc is the script')
  assert.match(problems(['RUN --mount=type=cache,target=/root/.cache npm install'])[0], /npm install isn't pinned/)
  assert.deepEqual(problems(['ENV PIP_REQUIRE_HASHES=1', 'RUN pip install -r /r.lock']), [])
  assert.deepEqual(problems(['ENV PIP_REQUIRE_HASHES 1', 'RUN pip install -r /r.lock']), [])
})

test("an engine's Python test requirements are pinned by version and hash, or there are none", () => {
  const hash = `--hash=sha256:${'a'.repeat(64)}`
  assert.deepEqual(hashedRequirementsProblems(''), [])
  assert.deepEqual(hashedRequirementsProblems('# nothing\n\n'), [])
  assert.deepEqual(hashedRequirementsProblems(`pypdf==6.21.4 \\\n    ${hash} \\\n    ${hash}\n    # via -r requirements.in\n`), [])
  assert.deepEqual(hashedRequirementsProblems(`requests\npypdf>=6 ${hash}\nsix==1.16.0\n-r more.txt\n--index-url https://example.com/simple\n`), [
    'requests must be pinned to an exact version (name==version)',
    'requests must carry --hash=sha256:…',
    'pypdf>=6 must be pinned to an exact version (name==version)',
    'six==1.16.0 must carry --hash=sha256:…',
    '-r is not allowed: list each package pinned by version and hash',
    '--index-url is not allowed: list each package pinned by version and hash',
  ])
})
