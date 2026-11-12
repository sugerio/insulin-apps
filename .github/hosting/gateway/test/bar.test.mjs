// The account bar's script (/__insulin/bar.js) in a minimal stand-in for a browser: it stays away from a page that has
// the platform's navigation (DESIGN.md §3.2), even one a single-page app renders after the script ran.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BAR_JS, SHELL_SELECTOR } from '../src/assets/bar-js.ts'

/** A browser of the fewest parts the account bar's script touches: elements record what was made and removed. */
function fakeBrowser({ shell = false, observer = true } = {}) {
  const state = { shell, created: [], fetched: [], observers: [], removed: [] }
  const element = (tag) => ({
    tag, hidden: false, textContent: '',
    setAttribute() {},
    append() {},
    addEventListener() {},
    focus() {},
    attachShadow: () => element('#shadow-root'),
    remove() { state.removed.push(tag) },
  })
  const document = {
    querySelector: (selector) => (selector === SHELL_SELECTOR && state.shell ? element('div') : null),
    createElement: (tag) => { state.created.push(tag); return element(tag) },
    createElementNS: (_namespace, tag) => element(tag),
    createTextNode: (text) => ({ text }),
    addEventListener() {},
    body: element('body'),
    documentElement: element('html'),
  }
  const window = {}
  window.top = window
  window.self = window
  class FakeObserver {
    constructor(callback) { this.callback = callback; state.observers.push(this) }
    observe(target, options) { this.target = target; this.options = options }
    disconnect() { this.disconnected = true }
  }
  let answer
  const fetch = (url) => { state.fetched.push(url); return new Promise((resolve) => { answer = resolve }) }
  const me = { user: { name: 'Bar Person', email: 'bar.person@example.test' }, organization: null, organizations: [], links: {} }
  state.answer = async () => { answer({ ok: true, json: async () => me }); await new Promise((resolve) => setTimeout(resolve, 0)) }
  state.run = () => new Function('window', 'document', 'fetch', 'location', 'MutationObserver', BAR_JS)(
    window, document, fetch, { href: 'http://captable.insulinapps.localhost/' }, observer ? FakeObserver : undefined,
  )
  return state
}

test('the account bar draws nothing on a page with the navigation, and leaves when an app renders it later', async () => {
  assert.equal(SHELL_SELECTOR, '[data-insulin-shell]')
  assert.ok(BAR_JS.includes("document.querySelector('[data-insulin-shell]')"), 'the script looks for the mark')

  const shelled = fakeBrowser({ shell: true })
  shelled.run()
  assert.deepEqual(shelled.created, [], 'nothing drawn')
  assert.deepEqual(shelled.fetched, [], 'not even /__insulin/me asked')

  const plain = fakeBrowser()
  plain.run()
  assert.deepEqual(plain.created.slice(0, 2), ['insulin-account-bar', 'link'], 'a page without it gets the bar')
  assert.deepEqual(plain.fetched, ['/__insulin/me'])
  await plain.answer()
  assert.ok(plain.created.includes('section'), 'and its panel')
  assert.deepEqual(plain.removed, [])

  // A single-page app renders its navigation after the script ran: the observer sends the bar away.
  const later = fakeBrowser()
  later.run()
  const [watcher] = later.observers
  assert.deepEqual(watcher.options, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-insulin-shell'] })
  watcher.callback()
  assert.deepEqual(later.removed, [], 'still no navigation: the bar stays')
  later.shell = true
  watcher.callback()
  assert.deepEqual(later.removed, ['insulin-account-bar'])
  assert.equal(watcher.disconnected, true)
  await later.answer()
  assert.ok(!later.created.includes('section'), 'its panel is never drawn')

  // Without MutationObserver, the answer from /__insulin/me is the last check.
  const unobserved = fakeBrowser({ observer: false })
  unobserved.run()
  unobserved.shell = true
  await unobserved.answer()
  assert.deepEqual(unobserved.removed, ['insulin-account-bar'])
  assert.ok(!unobserved.created.includes('section'))
})
