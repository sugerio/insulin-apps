#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listApps } from './list-apps.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_TEMPLATE = './.github/workflows/app.yml'
const RELEASE = 'release.yml'

export async function checkAppWorkflows(root = repositoryRoot) {
  root = resolve(root)
  const apps = await listApps(root)
  const appNames = new Set(apps.map(({ name }) => name))
  const workflowDirectory = join(root, '.github', 'workflows')
  const workflowFiles = (await readdir(workflowDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const workflows = new Map(
    await Promise.all(
      workflowFiles.map(async (file) => [file, await readFile(join(workflowDirectory, file), 'utf8')]),
    ),
  )
  const errors = []

  for (const { name } of apps) {
    const file = `${name}.yml`
    const text = workflows.get(file)
    if (text === undefined) {
      errors.push(`Missing workflow for app ${JSON.stringify(name)}: .github/workflows/${file}`)
      continue
    }
    if (!usesAppTemplate(text)) {
      errors.push(`App workflow .github/workflows/${file} must call ${APP_TEMPLATE}`)
    }
    const configuredApp = appInput(text)
    if (configuredApp !== name) {
      errors.push(
        `App workflow .github/workflows/${file} must set app: ${name}; found ${configuredApp ? JSON.stringify(configuredApp) : 'no literal app input'}`,
      )
    }
    if (!hasPathFilter(text, `${name}/**`)) {
      errors.push(`App workflow .github/workflows/${file} must include the path filter ${name}/**`)
    }
  }

  for (const [file, text] of workflows) {
    if (!usesAppTemplate(text)) continue
    const configuredApp = appInput(text)
    if (!configuredApp) {
      errors.push(`Workflow .github/workflows/${file} calls ${APP_TEMPLATE} without a literal app input`)
    } else if (!appNames.has(configuredApp)) {
      errors.push(
        `Workflow .github/workflows/${file} points at missing app ${JSON.stringify(configuredApp)}`,
      )
    }
  }

  errors.push(...checkReleaseTriggers(workflows))

  if (errors.length) throw new Error(errors.join('\n'))
  return { apps: [...appNames], workflows: workflowFiles }
}

// release.yml numbers a push to main once every run the push started has passed, and it starts when one of those runs
// completes. So its workflow_run trigger must name every workflow that runs on a push (each app's, CI and Gateway),
// or a push whose last run is an unlisted workflow waits for the hourly run.
function checkReleaseTriggers(workflows) {
  const release = workflows.get(RELEASE)
  if (release === undefined) return [`Missing .github/workflows/${RELEASE}, which numbers each green push to main`]
  const listed = releaseTriggers(release)
  if (!listed?.length) return [`.github/workflows/${RELEASE} must list workflows under on.workflow_run.workflows`]
  const errors = []
  const names = new Set()
  for (const [file, text] of workflows) {
    const name = workflowName(text)
    if (name) names.add(name)
    if (file === RELEASE || !triggers(text).has('push')) continue
    if (!name) {
      errors.push(`Workflow .github/workflows/${file} runs on a push, so it needs a name for ${RELEASE} to list`)
    } else if (!listed.includes(name)) {
      errors.push(
        `Workflow .github/workflows/${file} runs on a push, so ${RELEASE} must start after it: add ${JSON.stringify(name)} to its workflow_run workflows`,
      )
    }
  }
  for (const name of listed) {
    if (!names.has(name)) {
      errors.push(`${RELEASE} starts after ${JSON.stringify(name)}, but no workflow has that name`)
    }
  }
  return errors
}

// A workflow's top-level name.
function workflowName(text) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^name:\s*(.*?)\s*(?:#.*)?$/)
    if (match) return unquote(match[1]) || undefined
  }
  return undefined
}

// The events a workflow runs on: the keys or items of its top-level `on:` block, or an inline `on: push` or
// `on: [push, pull_request]`.
function triggers(text) {
  const lines = text.split(/\r?\n/)
  const events = new Set()
  const start = lines.findIndex((line) => /^["']?on["']?:/.test(line))
  if (start < 0) return events
  const inline = lines[start].replace(/^["']?on["']?:/, '').replace(/(?:^|\s)#.*$/, '').trim()
  if (inline) {
    for (const event of inline.replace(/^\[|\]$/g, '').split(',')) events.add(unquote(event.trim()))
    return events
  }
  let indent
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break
    const match = line.match(/^(\s+)(?:-\s*)?["']?([\w-]+)["']?\s*(?::|$|\s#)/)
    if (!match) continue
    indent ??= match[1].length
    if (match[1].length === indent) events.add(match[2])
  }
  return events
}

// The workflows release.yml's workflow_run trigger names: `workflows: [a, b]` or a block list under `workflows:`.
function releaseTriggers(text) {
  const lines = text.split(/\r?\n/)
  const trigger = lines.findIndex((line) => /^\s+workflow_run:/.test(line))
  const start = lines.findIndex((line, index) => index > trigger && /^\s+workflows:/.test(line))
  if (trigger < 0 || start < 0) return undefined
  const indent = lines[start].match(/^\s*/)[0].length
  const inline = lines[start].replace(/^\s+workflows:/, '').replace(/(?:^|\s)#.*$/, '').trim()
  if (inline) {
    const list = inline.match(/^\[(.*)\]$/)
    return (list ? list[1].split(',') : [inline]).map((name) => unquote(name.trim())).filter(Boolean)
  }
  const names = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const item = line.match(/^(\s*)-\s*(.*?)\s*(?:#.*)?$/)
    if (!item || item[1].length < indent) break
    names.push(unquote(item[2]))
  }
  return names
}

function usesAppTemplate(text) {
  return scalarLines(text, 'uses').includes(APP_TEMPLATE)
}

function appInput(text) {
  const values = scalarLines(text, 'app')
  return values.length === 1 ? values[0] : undefined
}

function hasPathFilter(text, path) {
  return text.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*-\s*(.*?)\s*(?:#.*)?$/)
    return match && unquote(match[1]) === path
  })
}

function scalarLines(text, key) {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.*?)\\s*(?:#.*)?$`)
  return text
    .split(/\r?\n/)
    .map((line) => line.match(pattern)?.[1])
    .filter((value) => value)
    .map(unquote)
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1)
  }
  return value
}

async function main() {
  const result = await checkAppWorkflows()
  process.stdout.write(
    `App workflows are complete for ${result.apps.length} app(s), and ${RELEASE} starts after every workflow a push runs.\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`check-app-workflows: ${error.message}\n`)
    process.exitCode = 1
  })
}
