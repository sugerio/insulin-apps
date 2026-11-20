import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Framework-owned files are replaced only while byte-identical to the Insulin app template (as in Esign and Cap Table). */
const TEMPLATE_SHA256 = {
  'api.ts': 'de57711bb50efc4c2eb1818308fa771de3e069fa1a8c742687f69009bf1a2029',
  'main.tsx': 'd0fef19e350e76300df0ba63706476f5e09736ef719b2daabce6f94fa9549546',
  'platform.local.ts': '4b8d9c8640bc74f6993cb83907311566f6f991a11ee0b08ff0feaff7897ab816',
  'platform.worker.ts': '36d6744d65f11ee314db966d853b6b322ec187e8fa59a386ceeb078c5a30e3f5',
  'local-d1.ts': '3df89ebc397b911d653008bb021e2efea6ad2e0a2e3313308c83d8852cc5fce8',
  'cloudflare-workers.d.ts': 'b0fc777f37144d5690136e8710f2ee282f6d4e591d96da88eed9aaac437f19e2',
  'suger-app-builder-runtime.tsx': '3725941405ce16f3d4a668ea28d34fcbe061265e55a42dc4eb97609cab9c7686',
} as const

const sha256 = (path: string) => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')

describe('Insulin app template boundary', () => {
  it.each(Object.entries(TEMPLATE_SHA256))('%s remains byte-identical to the pinned template', (filename, expected) => {
    expect(sha256(`../../src/${filename}`)).toBe(expected)
  })

  it('vite.config.ts and drizzle.config.ts stay as the template has them', () => {
    expect(sha256('../../vite.config.ts')).toBe('fbe4c274755130abac1bc673d6dc1ce5826171d2f89228fe7d04b48f5ba8cc5c')
    expect(sha256('../../drizzle.config.ts')).toBe('5c8a33cb314328eec2cb9d33dfc67f2debeca6df273fd39f05e55e40c44ce02e')
  })
})
