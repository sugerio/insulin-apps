#!/usr/bin/env node
// After `npm run build`: the production build must contain neither the in-memory engine nor its control interface
// (knowledge/engine/src/stub/), which development builds import only inside `import.meta.env.DEV`. Fails the build
// when the stub's marker or its control paths appear anywhere in .output/.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUTPUT = new URL('../.output/', import.meta.url).pathname
const NEEDLES = ['insulin-knowledge-in-memory-engine', '/__control/']

if (!existsSync(OUTPUT)) {
  console.error('check-no-stub: .output/ is missing; run the build first')
  process.exit(1)
}
const found = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(m?js|json|html|map)$/.test(entry)) {
      const text = readFileSync(path, 'utf8')
      for (const needle of NEEDLES) if (text.includes(needle)) found.push(`${path.slice(OUTPUT.length)} holds ${needle}`)
    }
  }
}
walk(OUTPUT)
if (found.length) {
  console.error(`check-no-stub: the build contains the in-memory engine:\n  ${found.join('\n  ')}`)
  process.exit(1)
}
console.log('check-no-stub: ok (no in-memory engine in the build)')
