// The gateway's static files: the favicon set (built from the mark in src/assets/icon.ts) and the committed stylesheet
// and icon modules, which must match a fresh build.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { startGateway } from './helpers/harness.mjs'
import { cssIsCurrent } from '../scripts/build-css.mjs'
import { ICONS_MODULE, iconsModule } from '../scripts/build-icons.mjs'
import { LICENSES_FILE, bundledPackages, licencesDocument } from '../scripts/third-party-licenses.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

// The "l" of the Insulin wordmark, exactly as the brand draws it.
const MARK_PATH = 'M598.67 0 L632.04 0 L564.19 229.04 L530.82 229.04 Z'
const ICON_CACHE = 'public, max-age=86400'

/** A response's raw bytes (the harness client decodes bodies as text). */
async function fetchBytes(href, init = {}) {
  const response = await h.mf.dispatchFetch(href, { redirect: 'manual', ...init })
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) }
}

function pngSize(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

test('the SVG favicon is the wordmark\'s orange "l" on a near-black tile, on every host', async () => {
  for (const site of ['apex', 'auth', 'captable']) {
    const icon = await fetchBytes(h.url(site, '/__insulin/icon.svg'))
    assert.equal(icon.status, 200, site)
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml')
    assert.equal(icon.headers.get('cache-control'), ICON_CACHE)
    const svg = icon.bytes.toString('utf8')
    assert.ok(svg.includes(`d="${MARK_PATH}"`), 'the exact path')
    assert.match(svg, /<path fill="#FF6B35"/)
    assert.match(svg, /<rect width="327\.2" height="327\.2" rx="71\.98" fill="#0A0A0A"\/>/, 'a tile with 22% corners; the bar is 70% of its height')
    assert.doesNotMatch(svg, /<script|on[a-z]+=/i)
  }
})

test('/favicon.ico holds 32 and 48 px PNGs, and /apple-touch-icon.png is 180 px, on the apex and auth hosts', async () => {
  for (const site of ['apex', 'auth']) {
    const ico = await fetchBytes(h.url(site, '/favicon.ico'))
    assert.equal(ico.status, 200, site)
    assert.equal(ico.headers.get('content-type'), 'image/x-icon')
    assert.equal(ico.headers.get('cache-control'), ICON_CACHE)
    const bytes = ico.bytes
    assert.deepEqual([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)], [0, 1, 2], 'an icon directory with two images')
    for (const [index, size] of [[0, 32], [1, 48]]) {
      const entry = 6 + 16 * index
      assert.deepEqual([bytes[entry], bytes[entry + 1], bytes.readUInt16LE(entry + 6)], [size, size, 32])
      const length = bytes.readUInt32LE(entry + 8)
      const offset = bytes.readUInt32LE(entry + 12)
      assert.ok(offset + length <= bytes.length)
      assert.deepEqual(pngSize(bytes.subarray(offset, offset + length)), [size, size])
    }

    const touch = await fetchBytes(h.url(site, '/apple-touch-icon.png'))
    assert.equal(touch.status, 200, site)
    assert.equal(touch.headers.get('content-type'), 'image/png')
    assert.equal(touch.headers.get('cache-control'), ICON_CACHE)
    assert.deepEqual(pngSize(touch.bytes), [180, 180])
  }
  const head = await fetchBytes(h.url('auth', '/favicon.ico'), { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.bytes.length, 0)
  const post = await h.client().post(h.url('auth', '/favicon.ico'), {})
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  assert.equal((await fetchBytes(h.url('auth', '/faviconXico'))).status, 404, 'the dot is literal')
})

test('app hosts keep their own icons: /favicon.ico and /apple-touch-icon.png there go to the app', async () => {
  for (const path of ['/favicon.ico', '/apple-touch-icon.png']) {
    const icon = await h.client().get(h.url('captable', path))
    assert.ok(!/^image\//.test(icon.headers.get('content-type') ?? ''), path)
    assert.equal(icon.status, 401, `${path}: the app proxy answered, not signed in`)
  }
})

test('THIRD_PARTY_LICENSES lists every bundled package with its licence text (npm run build:licenses)', async () => {
  assert.equal(await readFile(LICENSES_FILE, 'utf8'), licencesDocument(), 'THIRD_PARTY_LICENSES is stale: run `npm run build:licenses`')
  for (const name of bundledPackages()) assert.match(licencesDocument(), new RegExp(`^${name} `, 'm'), name)
})

test('the committed stylesheet matches a fresh Tailwind build (npm run build:css)', async () => {
  assert.ok(await cssIsCurrent(), 'src/assets/gateway-css.ts is stale: run `npm run build:css`')
})

test('the committed favicon images match a fresh rendering of the mark (npm run build:icons)', async () => {
  assert.equal(await readFile(ICONS_MODULE, 'utf8'), iconsModule(), 'src/assets/icons.ts is stale: run `npm run build:icons`')
})
