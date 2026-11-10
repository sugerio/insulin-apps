#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const APP_NAME_PATTERN = /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/
export const RESERVED_APP_NAMES = new Set([
  'auth',
  'www',
  'api',
  'admin',
  'app',
  'apps',
  'mail',
  'email',
  'cf-bounce',
  'gateway',
  'static',
  'assets',
  'status',
  'docs',
  'help',
  'support',
])

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Discover publishable apps at the top level of a repository. */
export async function listApps(root = repositoryRoot) {
  const entries = await readdir(root, { withFileTypes: true })
  const apps = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    let packageText
    try {
      packageText = await readFile(join(directory, 'package.json'), 'utf8')
      await readFile(join(directory, 'src', 'api.ts'))
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }

    validateAppName(entry.name)

    let manifest
    try {
      manifest = JSON.parse(packageText)
    } catch {
      throw new Error(`App ${JSON.stringify(entry.name)} has an invalid package.json`)
    }

    const title = typeof manifest.displayName === 'string' && manifest.displayName.trim() ? manifest.displayName.trim() : entry.name
    const summary = typeof manifest.description === 'string' ? manifest.description.trim() : ''
    const permissions = readPermissions(entry.name, manifest.insulin?.permissions)
    apps.push({ name: entry.name, title, summary, permissions })
  }

  return apps
}

const PERMISSION_KEY = /^[a-z][a-z0-9_.-]{0,63}$/
const PERMISSION_ROLES = new Set(['ADMIN', 'EDITOR', 'VIEWER'])

/**
 * An app's permission catalog, `insulin.permissions` in its package.json (.github/hosting/DESIGN.md §2.3): at most 50
 * entries of { key, label, description?, role }, where `role` is the least built-in role that has the permission. The
 * gateway checks it again and refuses to start with a malformed one, so a mistake fails here, before a deploy.
 */
export function readPermissions(app, raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 50) throw new Error(`App ${JSON.stringify(app)}: insulin.permissions must be an array of at most 50`)
  const keys = new Set()
  return raw.map((entry, index) => {
    const where = `App ${JSON.stringify(app)}: insulin.permissions[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`)
    const { key, label, description = '', role } = entry
    if (typeof key !== 'string' || !PERMISSION_KEY.test(key)) throw new Error(`${where}.key must match ${PERMISSION_KEY.source}`)
    if (keys.has(key)) throw new Error(`${where}.key ${JSON.stringify(key)} is listed twice`)
    keys.add(key)
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error(`${where}.label must be 1-80 characters`)
    if (typeof description !== 'string' || description.length > 300) throw new Error(`${where}.description must be at most 300 characters`)
    if (!PERMISSION_ROLES.has(role)) throw new Error(`${where}.role must be ADMIN, EDITOR or VIEWER`)
    return { key, label: label.trim(), description: description.trim(), role }
  })
}

export function validateAppName(name) {
  if (!APP_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid app directory name ${JSON.stringify(name)}; use a lower-case name matching ${APP_NAME_PATTERN.source}`,
    )
  }
  if (RESERVED_APP_NAMES.has(name)) {
    throw new Error(`App directory name ${JSON.stringify(name)} is reserved for the hosting gateway`)
  }
}

async function main(args) {
  if (args.some((arg) => arg !== '--json')) {
    throw new Error('usage: node .github/scripts/list-apps.mjs [--json]')
  }
  const apps = await listApps()
  const output = args.includes('--json') ? apps.map(({ name }) => name) : apps
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`list-apps: ${error.message}\n`)
    process.exitCode = 1
  })
}
