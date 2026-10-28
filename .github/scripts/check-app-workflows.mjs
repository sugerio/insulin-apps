#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listApps } from './list-apps.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_TEMPLATE = './.github/workflows/app.yml'

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

  if (errors.length) throw new Error(errors.join('\n'))
  return { apps: [...appNames], workflows: workflowFiles }
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
  process.stdout.write(`App workflows are complete for ${result.apps.length} app(s).\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`check-app-workflows: ${error.message}\n`)
    process.exitCode = 1
  })
}
