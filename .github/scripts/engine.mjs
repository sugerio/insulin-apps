// An app's engine (.github/hosting/DESIGN.md §12.1): a second Worker in the app's directory, reached only by the app
// over the SUGER_ENGINE service binding. This module holds the rules both the checker (check-insulin-app.mjs) and the
// deploy (deploy-apps.mjs, check-deploy.mjs) apply to it: what its package and Wrangler config may declare, its
// container image's inputs and tag, and the config the deploy writes for it. The deploy never trusts the engine's own
// config: it checks it again and writes the deployed one itself, as it does the app's.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

export const ENGINE_CONFIG = 'wrangler.jsonc'
/** Where the deploy's build puts the engine's bundled Worker, under the engine directory. */
export const ENGINE_OUTPUT = '.output'
export const ENGINE_BUNDLE = join(ENGINE_OUTPUT, 'worker', 'index.js')
/** The variables the deploy sets, so it can read back the versions a deploy put in production (§12.1 "Versions"). */
export const ENGINE_SERVES_VAR = 'SUGER_ENGINE_SERVES'
export const ENGINE_API_VAR = 'SUGER_ENGINE_API'
/** The binding the app reaches its engine through. */
export const ENGINE_BINDING = 'SUGER_ENGINE'
export const REGISTRY = 'registry.cloudflare.com'
/** R2's limit on a bucket name. */
export const BUCKET_NAME_MAX = 63

export const engineWorkerName = (app) => `insulin-apps-${app}-engine`
/** The bucket the deploy creates for an engine's R2 binding: never a name from the repository. */
export const engineBucketName = (app, binding) => `${engineWorkerName(app)}-${binding.toLowerCase()}`
/** The engine image's repository in the account's registry. */
export const engineImageRepository = (app) => engineWorkerName(app)

// Top-level keys an engine's Wrangler config may hold (§12.1). `$schema` is only an editor hint.
const CONFIG_KEYS = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'containers',
  'r2_buckets', 'ai', 'observability', 'workers_dev', 'preview_urls', 'vars',
])
const MIGRATION_KEYS = new Set(['tag', 'new_classes', 'new_sqlite_classes', 'renamed_classes', 'deleted_classes'])
// No remote access into a container (ssh and its keys), and no name of its own: Wrangler names the container
// application after the Worker.
const CONTAINER_KEYS = new Set([
  'class_name', 'image', 'images', 'image_build_context', 'image_vars', 'max_instances', 'instance_type', 'scheduling_policy',
  'observability', 'rollout_step_percentage', 'rollout_active_grace_period', 'constraints',
])
export const R2_BINDING = /^[A-Z][A-Z0-9]*$/
const BINDING = /^[A-Z][A-Z0-9_]*$/
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const FLAG = /^[a-z0-9_]+$/
const SECRET_LOOKING_VAR = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|_KEY$|^KEY$)/
const ACCOUNT_ID_LOOKING = /\b[0-9a-f]{32}\b/
const EXACT = /^(npm:(@?[^@\s]+)@)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const OTHER_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json']
const OTHER_WRANGLER_FILES = ['wrangler.toml', 'wrangler.json']
// Never part of the engine's source: what installs, builds and tools write.
const SKIPPED = new Set(['node_modules', '.output', '.wrangler', '.git', '.dev'])

/** JSON with comments (`//`, `/* *\/`) and trailing commas, as Wrangler reads wrangler.jsonc. */
export function parseJsonc(text) {
  let output = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      output += char
      if (char === '\\') output += text[(index += 1)] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      output += '\n'
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) throw new Error('an unterminated comment')
      index = end + 1
      output += ' '
    } else {
      output += char
    }
  }
  // Trailing commas, outside strings.
  let result = ''
  inString = false
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]
    if (inString) {
      result += char
      if (char === '\\') result += output[(index += 1)] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    if (char === ',') {
      let next = index + 1
      while (next < output.length && /\s/.test(output[next])) next += 1
      if (output[next] === '}' || output[next] === ']') continue
    }
    result += char
  }
  return JSON.parse(result)
}

/** The engine's own Wrangler config, wrangler.jsonc in its directory. */
export function readEngineConfig(engineDirectory) {
  const path = join(engineDirectory, ENGINE_CONFIG)
  if (!existsSync(path)) throw new Error(`the engine has no ${ENGINE_CONFIG}`)
  let config
  try {
    config = parseJsonc(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`the engine's ${ENGINE_CONFIG} is not valid JSON with comments: ${error.message}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`the engine's ${ENGINE_CONFIG} must be an object`)
  return config
}

/** `insulin.serves` of the engine's package.json: the engine API versions it serves, [min, max]. */
export function readServes(manifest) {
  const serves = manifest?.insulin?.serves
  if (!Array.isArray(serves) || serves.length !== 2 || !serves.every((value) => Number.isSafeInteger(value) && value >= 1) || serves[0] > serves[1]) {
    throw new Error('the engine\'s package.json must declare "insulin": { "serves": [min, max] }, positive integers with min <= max')
  }
  return serves
}

export const servesApi = (serves, api) => Number.isSafeInteger(api) && api >= serves[0] && api <= serves[1]
export const formatServes = (serves) => `${serves[0]}-${serves[1]}`
/** A recorded SUGER_ENGINE_SERVES ("1-2"), or null when it isn't one. */
export function parseServes(value) {
  const match = typeof value === 'string' ? value.match(/^(\d+)-(\d+)$/) : null
  if (!match) return null
  const serves = [Number(match[1]), Number(match[2])]
  return serves[0] >= 1 && serves[0] <= serves[1] ? serves : null
}

/** The Durable Object classes an engine's migrations leave it with, in order, or a problem. */
export function migrationClasses(migrations) {
  const classes = new Set()
  const problems = []
  const tags = new Set()
  if (migrations === undefined) return { classes, tags: [], problems }
  if (!Array.isArray(migrations)) return { classes, tags: [], problems: ['migrations must be an array'] }
  migrations.forEach((migration, index) => {
    const at = `migrations[${index}]`
    if (!migration || typeof migration !== 'object' || Array.isArray(migration)) return problems.push(`${at} must be an object`)
    for (const key of Object.keys(migration)) {
      if (key === 'transferred_classes' || key === 'from_script') problems.push(`${at}.${key} would take over another Worker's stored objects`)
      else if (!MIGRATION_KEYS.has(key)) problems.push(`${at}.${key} is not allowed (only tag, new_classes, new_sqlite_classes, renamed_classes, deleted_classes)`)
    }
    if (typeof migration.tag !== 'string' || !migration.tag.trim()) problems.push(`${at}.tag must be a name`)
    else if (tags.has(migration.tag)) problems.push(`${at}.tag ${JSON.stringify(migration.tag)} is used twice`)
    else tags.add(migration.tag)
    const names = (key) => {
      const value = migration[key] ?? []
      if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !CLASS_NAME.test(name))) {
        problems.push(`${at}.${key} must be a list of class names`)
        return []
      }
      return value
    }
    for (const name of [...names('new_classes'), ...names('new_sqlite_classes')]) {
      if (classes.has(name)) problems.push(`${at} creates ${name} again`)
      classes.add(name)
    }
    const renamed = migration.renamed_classes ?? []
    if (!Array.isArray(renamed)) problems.push(`${at}.renamed_classes must be a list`)
    else {
      for (const rename of renamed) {
        const keys = rename && typeof rename === 'object' ? Object.keys(rename) : []
        if (!rename || keys.some((key) => key !== 'from' && key !== 'to') || !CLASS_NAME.test(rename.from ?? '') || !CLASS_NAME.test(rename.to ?? '')) {
          problems.push(`${at}.renamed_classes must hold { from, to } of the engine's own classes`)
          continue
        }
        if (!classes.has(rename.from)) problems.push(`${at} renames ${rename.from}, which isn't one of the engine's classes`)
        classes.delete(rename.from)
        classes.add(rename.to)
      }
    }
    for (const name of names('deleted_classes')) {
      if (!classes.has(name)) problems.push(`${at} deletes ${name}, which isn't one of the engine's classes`)
      classes.delete(name)
    }
  })
  return { classes, tags: [...tags], problems }
}

/** A relative path inside the engine directory, resolved, or null for one that leaves it. */
const resolveInside = (engineDirectory, path) => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) return null
  const full = resolve(engineDirectory, path)
  const inside = relative(engineDirectory, full)
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? null : full
}

/**
 * Why an engine's Wrangler config is refused (§12.1), as a list: only the keys an engine may declare, its own Durable
 * Object classes, migrations that never take another Worker's objects, containers built from a Dockerfile in the
 * engine's directory, R2 bindings without bucket names, the Workers AI binding, no address of its own and nothing
 * that names the account or holds a secret.
 */
export function engineConfigProblems({ app, engineDirectory, config }) {
  const problems = []
  const fail = (message) => problems.push(`${ENGINE_CONFIG}: ${message}`)
  for (const key of Object.keys(config)) {
    if (CONFIG_KEYS.has(key)) continue
    if (key === 'routes' || key === 'route') fail(`${key} is not allowed: the engine has no address of its own, only the app's binding reaches it`)
    else if (key === 'account_id') fail('account_id is not allowed: the deploy names the account')
    else fail(`${key} is not allowed (an engine may declare only ${[...CONFIG_KEYS].filter((name) => name !== '$schema').join(', ')})`)
  }
  if (config.name !== engineWorkerName(app)) fail(`name must be ${engineWorkerName(app)}`)
  const main = resolveInside(engineDirectory, config.main)
  if (!main || !existsSync(main)) fail('main must be a file inside the engine directory')
  if (typeof config.compatibility_date !== 'string' || !isDate(config.compatibility_date)) fail('compatibility_date must be a date, YYYY-MM-DD')
  if (config.compatibility_flags !== undefined && (!Array.isArray(config.compatibility_flags) || config.compatibility_flags.some((flag) => typeof flag !== 'string' || !FLAG.test(flag)))) {
    fail('compatibility_flags must be a list of flag names')
  }
  if (config.workers_dev !== false) fail('workers_dev must be false: without routes, Wrangler would give the engine a public workers.dev address')
  if (config.preview_urls !== false) fail('preview_urls must be false')

  const bindings = new Set()
  const binding = (name, where, pattern = BINDING) => {
    if (typeof name !== 'string' || !pattern.test(name)) return fail(`${where} must match ${pattern.source}`)
    if (name === ENGINE_BINDING || name.startsWith('SUGER_')) return fail(`${where} ${name} is the platform's`)
    if (bindings.has(name)) return fail(`${where} ${name} is used twice`)
    bindings.add(name)
  }

  const { classes, problems: migrationProblems } = migrationClasses(config.migrations)
  for (const problem of migrationProblems) fail(problem)
  const objectClasses = new Set()
  if (config.durable_objects !== undefined) {
    const objects = config.durable_objects
    if (!objects || typeof objects !== 'object' || Array.isArray(objects) || Object.keys(objects).some((key) => key !== 'bindings') || !Array.isArray(objects.bindings)) {
      fail('durable_objects must be { bindings: [{ name, class_name }] }')
    } else {
      objects.bindings.forEach((entry, index) => {
        const at = `durable_objects.bindings[${index}]`
        if (!entry || typeof entry !== 'object') return fail(`${at} must be an object`)
        for (const key of Object.keys(entry)) {
          if (key === 'script_name') fail(`${at}.script_name is not allowed: an engine binds only its own classes`)
          else if (key !== 'name' && key !== 'class_name') fail(`${at}.${key} is not allowed`)
        }
        binding(entry.name, `${at}.name`)
        if (!classes.has(entry.class_name)) fail(`${at}.class_name must be one of the engine's own classes, created by its migrations`)
        else objectClasses.add(entry.class_name)
      })
    }
  }

  if (config.containers !== undefined) {
    if (!Array.isArray(config.containers)) fail('containers must be an array')
    else {
      config.containers.forEach((container, index) => {
        const at = `containers[${index}]`
        if (!container || typeof container !== 'object' || Array.isArray(container)) return fail(`${at} must be an object`)
        for (const key of Object.keys(container)) {
          if (!CONTAINER_KEYS.has(key)) fail(`${at}.${key} is not allowed`)
        }
        if (!objectClasses.has(container.class_name)) fail(`${at}.class_name must be a Durable Object class the engine binds`)
        if ((container.image === undefined) === (container.images === undefined)) fail(`${at} must have an image or images, not both`)
        if (container.image !== undefined) {
          dockerfileReference(engineDirectory, container.image, `${at}.image`, fail)
          if (container.image_build_context !== undefined && !directoryInside(engineDirectory, container.image_build_context)) {
            fail(`${at}.image_build_context must be a directory inside the engine directory`)
          }
        }
        if (container.images !== undefined) {
          if (!container.images || typeof container.images !== 'object' || Array.isArray(container.images) || !Object.keys(container.images).length) {
            fail(`${at}.images must be a map of named images`)
          } else {
            for (const [name, image] of Object.entries(container.images)) {
              const where = `${at}.images.${name}`
              if (!image || typeof image !== 'object' || Array.isArray(image)) { fail(`${where} must be an object`); continue }
              if ('image' in image) fail(`${where}.image names an image in a registry: give a dockerfile in the engine directory, and the deploy pushes the image and pins its digest`)
              for (const key of Object.keys(image)) {
                if (!['dockerfile', 'build_context', 'build_vars', 'image'].includes(key)) fail(`${where}.${key} is not allowed`)
              }
              if (!('image' in image)) dockerfileReference(engineDirectory, image.dockerfile, `${where}.dockerfile`, fail)
              if (image.build_context !== undefined && !directoryInside(engineDirectory, image.build_context)) fail(`${where}.build_context must be a directory inside the engine directory`)
            }
          }
        }
      })
      try {
        engineImageSources(engineDirectory, config)
      } catch (error) {
        fail(error.message)
      }
    }
  }

  if (config.r2_buckets !== undefined) {
    if (!Array.isArray(config.r2_buckets)) fail('r2_buckets must be an array')
    else {
      config.r2_buckets.forEach((bucket, index) => {
        const at = `r2_buckets[${index}]`
        if (!bucket || typeof bucket !== 'object') return fail(`${at} must be an object`)
        for (const key of Object.keys(bucket)) {
          if (key === 'bucket_name' || key === 'preview_bucket_name') fail(`${at}.${key} is not allowed: the deploy creates and names the bucket`)
          else if (key !== 'binding') fail(`${at}.${key} is not allowed`)
        }
        const before = problems.length
        binding(bucket.binding, `${at}.binding`, R2_BINDING)
        if (problems.length === before && engineBucketName(app, bucket.binding).length > BUCKET_NAME_MAX) {
          fail(`${at}.binding makes the bucket name ${engineBucketName(app, bucket.binding)}, longer than R2's ${BUCKET_NAME_MAX} characters`)
        }
      })
    }
  }

  if (config.ai !== undefined) {
    if (!config.ai || typeof config.ai !== 'object' || Object.keys(config.ai).some((key) => key !== 'binding')) fail('ai must be { binding }')
    else binding(config.ai.binding, 'ai.binding')
  }
  if (config.observability !== undefined && (!config.observability || typeof config.observability !== 'object' || Array.isArray(config.observability))) {
    fail('observability must be an object')
  }
  if (config.vars !== undefined) {
    if (!config.vars || typeof config.vars !== 'object' || Array.isArray(config.vars)) fail('vars must be an object')
    else {
      for (const [name, value] of Object.entries(config.vars)) {
        binding(name, `vars.${name}`)
        if (SECRET_LOOKING_VAR.test(name)) fail(`vars.${name} looks like a secret: an engine's vars are written in the repository`)
        if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`vars.${name} must be a string, a number or a boolean`)
      }
    }
  }
  if (ACCOUNT_ID_LOOKING.test(JSON.stringify(config))) fail('holds what looks like an account id: the deploy names the account')
  return problems
}

function dockerfileReference(engineDirectory, path, where, fail) {
  const full = resolveInside(engineDirectory, path)
  if (!full || !existsSync(full) || !lstatSync(full).isFile()) {
    fail(`${where} must point at a Dockerfile in the engine directory; the deploy builds and pushes the image and pins its digest`)
  }
}

function directoryInside(engineDirectory, path) {
  const full = resolveInside(engineDirectory, path)
  return Boolean(full && existsSync(full) && lstatSync(full).isDirectory())
}

/**
 * The engine's container image: the one Dockerfile its containers are built from, with its build context and build
 * variables, or null when it has no container. An engine builds one image: several containers may share it.
 */
export function engineImageSources(engineDirectory, config) {
  const images = []
  for (const container of Array.isArray(config.containers) ? config.containers : []) {
    if (typeof container?.image === 'string') {
      const dockerfile = resolve(engineDirectory, container.image)
      images.push({ dockerfile, context: container.image_build_context ? resolve(engineDirectory, container.image_build_context) : dirname(dockerfile), vars: container.image_vars ?? {} })
    }
    for (const image of Object.values(container?.images ?? {})) {
      if (typeof image?.dockerfile !== 'string') continue
      const dockerfile = resolve(engineDirectory, image.dockerfile)
      images.push({ dockerfile, context: image.build_context ? resolve(engineDirectory, image.build_context) : dirname(dockerfile), vars: image.build_vars ?? {} })
    }
  }
  if (!images.length) return null
  const key = ({ dockerfile, context, vars }) => JSON.stringify([dockerfile, context, sortedObject(vars)])
  if (new Set(images.map(key)).size > 1) throw new Error('containers must all be built from one Dockerfile, context and build variables: an engine has one image')
  return images[0]
}

// --- Dockerfiles ---------------------------------------------------------------------------------------------------

/** A Dockerfile's instructions: continuation lines joined, comments and heredoc bodies left out. */
export function dockerfileInstructions(text) {
  const lines = text.split(/\r?\n/)
  const instructions = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim() || /^\s*#/.test(lines[index])) {
      index += 1
      continue
    }
    const line = index + 1
    let full = ''
    for (;;) {
      const current = lines[index++]
      if (/\\\s*$/.test(current)) {
        full += `${current.replace(/\\\s*$/, '')} `
        // Docker drops comment lines inside a continuation.
        while (index < lines.length && /^\s*#/.test(lines[index])) index += 1
        if (index >= lines.length) break
        continue
      }
      full += current
      break
    }
    for (const heredoc of full.matchAll(/(?<!<)<<(?!<)(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      while (index < lines.length) {
        const body = lines[index++]
        if ((heredoc[1] ? body.replace(/^\t+/, '') : body) === heredoc[3]) break
      }
    }
    const match = full.match(/^\s*([A-Za-z]+)\s*([\s\S]*)$/)
    if (match) instructions.push({ keyword: match[1].toUpperCase(), args: match[2].trim(), line })
  }
  return instructions
}

const DIGEST_PINNED = /^[^\s@$]+@sha256:[0-9a-f]{64}$/

/**
 * What a Dockerfile takes from outside, and why it is refused: `FROM` (and `COPY --from` of an image) pinned by
 * digest, no `ADD` from a URL, and the context files `COPY`, `ADD` and `RUN --mount=type=bind` read, which are the
 * image's inputs with the Dockerfile itself.
 */
export function dockerfileAnalysis(text) {
  const problems = []
  const sources = []
  const stages = new Set()
  const pinned = (image, where, line) => {
    if (!DIGEST_PINNED.test(image)) problems.push(`Dockerfile line ${line}: ${where} ${image} must be pinned by digest (name@sha256:…)`)
  }
  for (const { keyword, args, line } of dockerfileInstructions(text)) {
    const tokens = args.split(/\s+/).filter(Boolean)
    if (keyword === 'FROM') {
      const words = tokens.filter((token) => !token.startsWith('--'))
      const image = words[0] ?? ''
      if (!stages.has(image.toLowerCase()) && image.toLowerCase() !== 'scratch') pinned(image, 'FROM', line)
      if (words[1]?.toUpperCase() === 'AS' && words[2]) stages.add(words[2].toLowerCase())
      continue
    }
    if (keyword === 'COPY' || keyword === 'ADD') {
      const flags = []
      let rest = args
      while (rest.startsWith('--')) {
        const flag = rest.match(/^--\S+/)[0]
        flags.push(flag)
        rest = rest.slice(flag.length).trimStart()
      }
      const from = flags.find((flag) => flag.startsWith('--from='))?.slice(7)
      if (from !== undefined) {
        if (!stages.has(from.toLowerCase()) && !/^\d+$/.test(from)) pinned(from, `${keyword} --from`, line)
        continue
      }
      let parts
      if (rest.startsWith('[')) {
        try {
          parts = JSON.parse(rest)
        } catch {
          problems.push(`Dockerfile line ${line}: ${keyword} has an invalid JSON list`)
          continue
        }
      } else {
        parts = rest.split(/\s+/).filter(Boolean)
      }
      for (const source of parts.slice(0, -1)) {
        if (typeof source !== 'string' || source.startsWith('<<')) continue
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith('git@')) {
          problems.push(`Dockerfile line ${line}: ${keyword} ${source} fetches from outside: copy files from the engine directory, or download in a RUN step pinned by hash`)
          continue
        }
        sources.push({ source, line })
      }
      continue
    }
    if (keyword === 'RUN') {
      for (const flag of tokens.filter((token) => token.startsWith('--mount='))) {
        const options = Object.fromEntries(flag.slice(8).split(',').map((option) => {
          const [key, ...value] = option.split('=')
          return [key, value.join('=') || 'true']
        }))
        if ((options.type ?? 'bind') !== 'bind') continue
        if (options.from !== undefined) {
          if (!stages.has(options.from.toLowerCase())) pinned(options.from, 'RUN --mount from', line)
          continue
        }
        sources.push({ source: options.source ?? options.src ?? '.', line })
      }
    }
  }
  return { problems, sources }
}

/** The files under a directory, relative and with `/`, leaving out what installs and builds write. */
function contextEntries(context) {
  const files = []
  const directories = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const full = join(directory, entry.name)
      const rel = relative(context, full).split(sep).join('/')
      if (entry.isDirectory()) {
        directories.push(rel)
        walk(full)
      } else {
        const status = lstatSync(full)
        if (!status.isFile()) throw new Error(`the image's build context holds ${rel}, which is not a regular file`)
        files.push(rel)
      }
    }
  }
  walk(context)
  return { files: files.sort(), directories }
}

function globPattern(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 1
      if (pattern[index + 1] === '/') index += 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const end = pattern.indexOf(']', index)
      if (end < 0) source += '\\['
      else {
        source += `[${pattern.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        index = end
      }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * The engine image's inputs: its Dockerfile, its build variables and every file of the build context the Dockerfile
 * reads (a directory copies all it holds), with `.dockerignore` when there is one. Throws when a source escapes the
 * context or matches nothing (the build would fail too).
 */
export function imageInputs(image) {
  const text = readFileSync(image.dockerfile, 'utf8')
  const { problems, sources } = dockerfileAnalysis(text)
  if (problems.length) throw new Error(problems.join('; '))
  const { files, directories } = contextEntries(image.context)
  const chosen = new Set()
  for (const { source, line } of sources) {
    const path = posix.normalize(source.replace(/^\/+/, '') || '.').replace(/\/+$/, '') || '.'
    if (path === '..' || path.startsWith('../')) throw new Error(`Dockerfile line ${line}: ${source} is outside the build context`)
    let matched = false
    const take = (entry) => {
      matched = true
      if (files.includes(entry)) chosen.add(entry)
      for (const file of files) if (entry === '.' || file.startsWith(`${entry}/`)) chosen.add(file)
    }
    if (path === '.') take('.')
    else if (/[*?[]/.test(path)) {
      const pattern = globPattern(path)
      for (const entry of [...files, ...directories]) if (pattern.test(entry)) take(entry)
    } else if (files.includes(path) || directories.includes(path)) take(path)
    if (!matched) throw new Error(`Dockerfile line ${line}: ${source} matches nothing in the build context`)
  }
  if (files.includes('.dockerignore')) chosen.add('.dockerignore')
  return { dockerfile: image.dockerfile, context: image.context, vars: sortedObject(image.vars), files: [...chosen].sort() }
}

/**
 * The image's tag: a hash of its inputs (§12.1 "Images"). The same Dockerfile, build variables and copied files give
 * the same tag wherever the engine directory is, so a release that doesn't change them keeps the image.
 */
export function imageTag(engineDirectory, inputs) {
  const hash = createHash('sha256')
  const field = (...parts) => {
    for (const part of parts) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
      hash.update(`${bytes.length}:`)
      hash.update(bytes)
    }
  }
  field('insulin-apps engine image 1')
  field('dockerfile', relative(engineDirectory, inputs.dockerfile).split(sep).join('/'), readFileSync(inputs.dockerfile))
  field('vars', JSON.stringify(inputs.vars))
  for (const file of inputs.files) field('file', file, readFileSync(join(inputs.context, file)))
  return `inputs-${hash.digest('hex')}`
}

/** The tag of the engine's image at this engine directory, or null when it has no container. */
export function engineImageTag(engineDirectory, config = readEngineConfig(engineDirectory)) {
  const image = engineImageSources(engineDirectory, config)
  return image ? imageTag(engineDirectory, imageInputs(image)) : null
}

// --- Checks of the engine directory ----------------------------------------------------------------------------------

/**
 * Every problem with an app's engine directory (§12.1), for check-insulin-app.mjs: its own package with exact versions,
 * `insulin.serves` covering the app's `engineApi` and the scripts the pipeline runs; an exact, registry-only lockfile;
 * its Wrangler config (engineConfigProblems); a base image pinned by digest; and no reference to the engine's own
 * image in a registry, anywhere in it.
 */
export function engineProblems({ app, appDirectory, engine, engineApi }) {
  const problems = []
  const engineDirectory = join(appDirectory, engine)
  const at = (message) => problems.push(`engine (${engine}/): ${message}`)
  if (!existsSync(engineDirectory) || !lstatSync(engineDirectory).isDirectory()) {
    at('the directory is missing')
    return problems
  }
  for (const file of [...OTHER_LOCKFILES, ...OTHER_WRANGLER_FILES]) {
    if (existsSync(join(engineDirectory, file))) at(`${file} must not exist (npm's package-lock.json and ${ENGINE_CONFIG} only)`)
  }

  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(join(engineDirectory, 'package.json'), 'utf8'))
  } catch (error) {
    at(`package.json is missing or not valid JSON: ${error.message}`)
  }
  if (manifest.workspaces) at('package.json must not declare workspaces')
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!EXACT.test(spec)) at(`package.json ${field}.${name} is "${spec}"; pin an exact registry version`)
    }
  }
  if (!manifest.devDependencies?.wrangler && !manifest.dependencies?.wrangler) at('package.json must depend on wrangler (an exact version): the release bundles the engine with it')
  for (const script of ['typecheck', 'test']) {
    if (!manifest.scripts?.[script]) at(`package.json is missing the "${script}" script, which the app's pipeline runs`)
  }
  try {
    const serves = readServes(manifest)
    if (!servesApi(serves, engineApi)) at(`serves engine API ${formatServes(serves)}, but the app calls ${engineApi} (insulin.engineApi)`)
  } catch (error) {
    at(error.message)
  }

  let lock = null
  try {
    lock = JSON.parse(readFileSync(join(engineDirectory, 'package-lock.json'), 'utf8'))
  } catch (error) {
    at(`package-lock.json is missing or not valid JSON: ${error.message}`)
  }
  if (lock) {
    if (![2, 3].includes(lock.lockfileVersion)) at(`package-lock.json lockfileVersion is ${lock.lockfileVersion}; use 2 or 3`)
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (!path) continue
      if (entry.link) at(`package-lock.json: ${path} is a linked package`)
      if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) at(`package-lock.json: ${path} resolves outside registry.npmjs.org: ${entry.resolved}`)
    }
  }

  let config = null
  try {
    config = readEngineConfig(engineDirectory)
  } catch (error) {
    at(error.message)
  }
  if (config) for (const problem of engineConfigProblems({ app, engineDirectory, config })) at(problem)
  try {
    const image = config ? engineImageSources(engineDirectory, config) : null
    if (image && existsSync(image.dockerfile)) {
      const { problems: dockerProblems } = dockerfileAnalysis(readFileSync(image.dockerfile, 'utf8'))
      for (const problem of dockerProblems) at(`${relative(engineDirectory, image.dockerfile)}: ${problem}`)
      if (!dockerProblems.length && existsSync(image.context)) imageInputs(image)
    }
  } catch (error) {
    at(error.message)
  }

  // Files: no links (the deploy reads them), and nowhere a reference to the engine's own image in a registry.
  const ownImage = `${engineImageRepository(app)}@sha256:`
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const full = join(directory, entry.name)
      const rel = relative(engineDirectory, full).split(sep).join('/')
      const status = lstatSync(full)
      if (status.isDirectory()) {
        walk(full)
        continue
      }
      if (!status.isFile()) {
        at(`${rel} is not a regular file`)
        continue
      }
      if (status.size > 8 * 1024 * 1024) continue
      const text = readFileSync(full, 'latin1')
      if (text.includes(REGISTRY) || text.includes(ownImage)) {
        at(`${rel} names an image in the registry: the deploy pushes the engine's image and pins its digest, the repository never names it`)
      }
    }
  }
  walk(engineDirectory)
  return problems
}

// --- The deployed config -------------------------------------------------------------------------------------------

/**
 * The engine's config as the deploy writes it (§12.1 "Deploy"): its own name, the bundle the build made, its classes,
 * migrations and bindings, each R2 binding pointed at the bucket the deploy created, the container image by digest,
 * the API versions it serves recorded in a var, and both public switches off. Nothing else from the repository's
 * config reaches it.
 */
export function deployedEngineConfig({ app, engineDirectory, config, imageReference, serves }) {
  const containers = (config.containers ?? []).map((container) => {
    const { image, images, image_build_context: _context, image_vars: _vars, ...rest } = container
    if (image !== undefined) {
      if (!imageReference) throw new Error('the engine has a container but no image to deploy')
      return { ...structuredClone(rest), image: imageReference }
    }
    if (!imageReference) throw new Error('the engine has a container but no image to deploy')
    return { ...structuredClone(rest), images: Object.fromEntries(Object.keys(images).map((name) => [name, { image: imageReference }])) }
  })
  return {
    name: engineWorkerName(app),
    main: resolve(engineDirectory, ENGINE_BUNDLE),
    // Bundled by the release's build job, which has no deploy settings; the deploy uploads it as it is.
    no_bundle: true,
    compatibility_date: config.compatibility_date,
    ...(config.compatibility_flags ? { compatibility_flags: [...config.compatibility_flags] } : {}),
    ...(config.durable_objects ? { durable_objects: structuredClone(config.durable_objects) } : {}),
    ...(config.migrations ? { migrations: structuredClone(config.migrations) } : {}),
    ...(containers.length ? { containers } : {}),
    ...(config.r2_buckets ? { r2_buckets: config.r2_buckets.map(({ binding }) => ({ binding, bucket_name: engineBucketName(app, binding) })) } : {}),
    ...(config.ai ? { ai: { binding: config.ai.binding } } : {}),
    ...(config.observability ? { observability: structuredClone(config.observability) } : {}),
    vars: { ...(config.vars ?? {}), [ENGINE_SERVES_VAR]: formatServes(serves) },
    workers_dev: false,
    preview_urls: false,
  }
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)))
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
