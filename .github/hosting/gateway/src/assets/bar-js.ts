// /__insulin/bar.js: the account bar, appended to every HTML page an app serves. It runs under the app's CSP
// (script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'), so it is a same-origin script that
// builds a closed shadow root with DOM calls only (no innerHTML, no inline styles or style attributes), links its
// stylesheet, and talks to /__insulin/* with same-origin fetch. It navigates with location.assign rather than submitting
// forms, because form-action would block the cross-origin redirects of switching and signing out.
//
// The icons are drawn with createElementNS: the Insulin Apps mark (icon.ts) and a few Lucide icons (ISC licence).
import { MARK_OFFSET, MARK_ORANGE, MARK_PATH, MARK_RADIUS, MARK_SIZE, MARK_TILE } from './icon.ts'

const MARK = JSON.stringify({ size: MARK_SIZE, radius: MARK_RADIUS, tile: MARK_TILE, orange: MARK_ORANGE, offset: MARK_OFFSET, path: MARK_PATH })

export const BAR_JS = String.raw`(() => {
  'use strict'
  if (window.top !== window.self || document.querySelector('insulin-account-bar')) return

  const make = (tag, attributes = {}, children = []) => {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (value === false || value === null || value === undefined) continue
      if (name === 'text') node.textContent = String(value)
      else node.setAttribute(name, value === true ? '' : String(value))
    }
    node.append(...children.filter(Boolean))
    return node
  }

  // SVG: [tag, attributes] pairs inside a decorative <svg>.
  const SVG = 'http://www.w3.org/2000/svg'
  const vector = (attributes, shapes) => {
    const node = document.createElementNS(SVG, 'svg')
    for (const [name, value] of Object.entries({ ...attributes, 'aria-hidden': 'true', focusable: 'false' })) node.setAttribute(name, value)
    for (const [tag, shape] of shapes) {
      const child = document.createElementNS(SVG, tag)
      for (const [name, value] of Object.entries(shape)) child.setAttribute(name, value)
      node.append(child)
    }
    return node
  }
  const icon = (shapes) => vector({
    class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, shapes)
  const ICONS = {
    chevrons: [['path', { d: 'm7 15 5 5 5-5' }], ['path', { d: 'm7 9 5-5 5 5' }]],
    chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['path', { d: 'M16 3.128a4 4 0 0 1 0 7.744' }],
      ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['circle', { cx: '9', cy: '7', r: '4' }]],
    apps: [['rect', { width: '7', height: '7', x: '3', y: '3', rx: '1' }], ['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1' }],
      ['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1' }], ['rect', { width: '7', height: '7', x: '3', y: '14', rx: '1' }]],
    account: [['circle', { cx: '12', cy: '8', r: '5' }], ['path', { d: 'M20 21a8 8 0 0 0-16 0' }]],
    signOut: [['path', { d: 'm16 17 5-5-5-5' }], ['path', { d: 'M21 12H9' }], ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }]],
    close: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  }
  const MARK = ${MARK}
  const mark = () => vector({ class: 'mark', viewBox: '0 0 ' + MARK.size + ' ' + MARK.size }, [
    ['rect', { width: String(MARK.size), height: String(MARK.size), rx: String(MARK.radius), fill: MARK.tile }],
    ['path', { fill: MARK.orange, transform: MARK.offset, d: MARK.path }],
  ])

  // Up to two initials: the first letters of the first two words of the name, else of the address.
  const initials = (name, email) => {
    const words = String(name).trim().split(/\s+/).filter(Boolean)
    return (words.length ? words.slice(0, 2) : [String(email)]).map((word) => Array.from(word)[0] || '').join('').toLocaleUpperCase('en')
  }

  const httpUrl = (value) => {
    try {
      const url = new URL(String(value), location.href)
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
    } catch {
      return null
    }
  }

  // An explicit referrer policy keeps a real Origin header on these POSTs whatever policy the app's page has.
  const post = (path, body, json) => fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    referrerPolicy: 'strict-origin',
    headers: { Accept: 'application/json', 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  })

  // Attached at once (hidden), so a second copy of this script on the same page finds it and stops.
  const host = document.createElement('insulin-account-bar')
  host.hidden = true
  ;(document.body || document.documentElement).append(host)
  const root = host.attachShadow({ mode: 'closed' })
  let styled = false
  let rendered = false
  const reveal = () => { if (styled && rendered) host.hidden = false }
  const sheet = make('link', { rel: 'stylesheet', href: '/__insulin/bar.css' })
  sheet.addEventListener('load', () => { styled = true; reveal() })
  root.append(sheet)

  const render = (me) => {
    const org = me.organization
    const panel = make('section', { class: 'panel', id: 'account-panel', hidden: true, 'aria-label': 'Insulin Apps' })
    const pill = make('button', { class: 'pill', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'account-panel', title: 'Insulin Apps' }, [
      mark(),
      make('span', { class: 'sr-only', text: 'Insulin Apps: ' }),
      make('span', { class: 'label', text: org ? org.name : 'No organization' }),
      org ? make('span', { class: 'badge', text: org.roleLabel }) : null,
      icon(ICONS.chevrons),
    ])
    const status = make('p', { class: 'status', role: 'status', 'aria-live': 'polite' })
    const toggle = (open) => {
      panel.hidden = !open
      pill.setAttribute('aria-expanded', String(open))
      if (!open) status.textContent = ''
    }
    pill.addEventListener('click', () => toggle(panel.hidden))
    const separator = () => make('div', { class: 'separator', role: 'none' })

    panel.append(make('h2', { text: 'Insulin Apps' }))
    panel.append(make('div', { class: 'who' }, [
      make('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(me.user.name, me.user.email) }),
      make('div', { class: 'who-text' }, [
        make('p', { class: 'name' }, [make('span', { class: 'sr-only', text: 'Signed in as ' }), document.createTextNode(me.user.name)]),
        make('p', { class: 'email', text: me.user.email }),
      ]),
    ]))
    panel.append(separator())

    if (me.organizations.length > 1) {
      const select = make('select', { id: 'account-org', name: 'org' }, me.organizations.map((item) =>
        make('option', { value: item.id, selected: item.active, text: item.name + ' (' + item.roleLabel + ')' })))
      const form = make('form', {}, [
        make('label', { for: 'account-org', text: 'Organization' }),
        make('div', { class: 'switch' }, [
          make('span', { class: 'select' }, [select, icon(ICONS.chevron)]),
          make('button', { class: 'button', type: 'submit', text: 'Switch' }),
        ]),
      ])
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        status.textContent = 'Switching…'
        try {
          const response = await post('/__insulin/switch-org', { orgId: select.value }, true)
          if (!response.ok) throw new Error('switch failed')
          location.assign('/')
        } catch {
          status.textContent = 'Couldn’t switch organization. Please try again.'
        }
      })
      panel.append(form)
    } else if (org) {
      panel.append(make('p', { class: 'org' }, [
        make('span', { class: 'sr-only', text: 'Organization: ' }),
        make('span', { class: 'label', text: org.name }),
        make('span', { class: 'badge', text: org.roleLabel }),
      ]))
    }
    if (me.organizations.length || org) panel.append(separator())

    const links = [['Members', me.links.members, ICONS.users], ['All apps', me.links.apps, ICONS.apps], ['Account', me.links.account, ICONS.account]]
      .map(([text, href, shapes]) => [text, httpUrl(href), shapes])
      .filter(([, href]) => href)
    panel.append(make('ul', { class: 'links' }, links.map(([text, href, shapes]) =>
      make('li', {}, [make('a', { class: 'item', href }, [icon(shapes), document.createTextNode(text)])]))))
    panel.append(separator())

    const signOut = make('button', { class: 'item', type: 'button' }, [icon(ICONS.signOut), document.createTextNode('Sign out')])
    signOut.addEventListener('click', async () => {
      status.textContent = 'Signing out…'
      try {
        const response = await post('/__insulin/logout', {}, false)
        const data = response.ok ? await response.json() : null
        location.assign(httpUrl(data && data.next) || '/')
      } catch {
        status.textContent = 'Couldn’t sign out. Please try again.'
      }
    })
    const close = make('button', { class: 'close', type: 'button', 'aria-label': 'Close', title: 'Close' }, [icon(ICONS.close)])
    close.addEventListener('click', () => { toggle(false); pill.focus() })
    panel.append(make('div', { class: 'row' }, [signOut, close]), status)

    // The pill comes first so keyboard focus moves from it into the panel; CSS shows the panel above it.
    const bar = make('div', { class: 'bar' }, [pill, panel])
    root.append(bar)
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || panel.hidden) return
      const inside = event.composedPath().includes(host)
      toggle(false)
      if (inside) pill.focus()
    })
    document.addEventListener('click', (event) => {
      if (!panel.hidden && !event.composedPath().includes(host)) toggle(false)
    })
    rendered = true
    reveal()
  }

  fetch('/__insulin/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((me) => { if (me && me.user) render(me) })
    .catch(() => {})
})()
`
