#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkBuildArchiveMembers(contents, expectedRoot) {
  if (!expectedRoot || expectedRoot.startsWith('/') || expectedRoot.endsWith('/')) {
    throw new Error('Expected archive root must be a relative path without a trailing slash')
  }
  const members = contents.split('\n').filter(Boolean)
  if (!members.length) throw new Error('Build archive is empty')

  for (const member of members) {
    const path = member.endsWith('/') ? member.slice(0, -1) : member
    if (path !== expectedRoot && !path.startsWith(`${expectedRoot}/`)) {
      throw new Error(`Build archive member is outside ${expectedRoot}: ${member}`)
    }
    const segments = path.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Build archive member has an unsafe path: ${member}`)
    }
  }
}

function main() {
  const [listingPath, expectedRoot] = process.argv.slice(2)
  if (!listingPath || !expectedRoot) {
    throw new Error('usage: node .github/scripts/check-build-archive.mjs <member-list> <expected-root>')
  }
  checkBuildArchiveMembers(readFileSync(listingPath, 'utf8'), expectedRoot)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`check-build-archive: ${error.message}\n`)
    process.exitCode = 1
  }
}
