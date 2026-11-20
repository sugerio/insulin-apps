import { describe, expect, it } from 'vitest'
import { applyHiding as appHiding, DEFAULT_HIDING } from '../../src/app/server/hiding.ts'
import { applyHiding as stubHiding } from '../../engine/src/stub/hiding.ts'

// Hiding runs on every text before anything is learned, and on what Knowledge keeps: hostile text must take time in
// proportion to its length, never its square (a stuck detector holds the import, or the request, for minutes).

const timed = (run: () => unknown) => {
  const started = performance.now()
  run()
  return performance.now() - started
}

describe('hiding takes time in proportion to the text', () => {
  for (const [name, applyHiding] of [['the app', appHiding], ['the in-memory engine', stubHiding]] as const) {
    it(`${name}: a phone label followed by a long run of spaces`, () => {
      const text = 'phone' + '\u0085'.repeat(40_000) + '!'
      expect(timed(() => applyHiding(text, DEFAULT_HIDING))).toBeLessThan(250)
      expect(applyHiding('Phone 　 : \u0085 +49 30 1234 5678', DEFAULT_HIDING).text).toBe('Phone 　 : \u0085 [hidden]')
    }, 30_000)

    it(`${name}: private-key headers without an end`, () => {
      // Spelled in parts, so that no scanner for leaked keys mistakes this file for one.
      const dashes = '-'.repeat(5)
      const begin = `${dashes}BEGIN RSA PRIVATE KEY${dashes} `
      const text = begin.repeat(10_000)
      expect(timed(() => applyHiding(text, DEFAULT_HIDING))).toBeLessThan(250)
      expect(applyHiding(`${begin}x\n${begin.trim()}\nMIIB\n${dashes}END RSA PRIVATE KEY${dashes} after`, DEFAULT_HIDING).text).toBe('[hidden] after')
    }, 30_000)
  }
})
