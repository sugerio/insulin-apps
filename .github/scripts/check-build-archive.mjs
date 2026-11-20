#!/usr/bin/env node
// Checks the member list of a build archive before it is extracted: every member is under one of the expected roots
// (an app's .output, and its engine's .output when it has one), with no empty, `.` or `..` segment.
//
//   node .github/scripts/check-build-archive.mjs <member-list> <expected-root> [<expected-root> ...]
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkBuildArchiveMembers(contents, expectedRoots) {
  const roots = Array.isArray(expectedRoots) ? expectedRoots : [expectedRoots]
  if (!roots.length || roots.some((root) => !root || root.startsWith('/') || root.endsWith('/'))) {
    throw new Error('Expected archive roots must be relative paths without a trailing slash')
  }
  const members = contents.split('\n').filter(Boolean)
  if (!members.length) throw new Error('Build archive is empty')

  for (const member of members) {
    const path = member.endsWith('/') ? member.slice(0, -1) : member
    if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      throw new Error(`Build archive member is outside ${roots.join(' and ')}: ${member}`)
    }
    const segments = path.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Build archive member has an unsafe path: ${member}`)
    }
  }
}

function main() {
  const [listingPath, ...expectedRoots] = process.argv.slice(2)
  if (!listingPath || !expectedRoots.length) {
    throw new Error('usage: node .github/scripts/check-build-archive.mjs <member-list> <expected-root> [<expected-root> ...]')
  }
  checkBuildArchiveMembers(readFileSync(listingPath, 'utf8'), expectedRoots)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`check-build-archive: ${error.message}\n`)
    process.exitCode = 1
  }
}
