// /__insulin/bar.js: the account bar, appended to every HTML page an app serves. It runs under the app's CSP
// (script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'), so it is a same-origin script that
// builds a closed shadow root with DOM calls only (no innerHTML, no inline styles or style attributes), links its
// stylesheet, and talks to /__insulin/* with same-origin fetch. It navigates with location.assign rather than submitting
// forms, because form-action would block the cross-origin redirects of switching and signing out.
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
    const label = org ? org.name + ' · ' + org.roleLabel : 'No organization'
    const panel = make('section', { class: 'panel', id: 'account-panel', hidden: true, 'aria-label': 'Insulin Apps' })
    const pill = make('button', { class: 'pill', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'account-panel', title: 'Insulin Apps' }, [
      make('span', { class: 'mark', text: 'Insulin' }),
      make('span', { class: 'label', text: label }),
    ])
    const status = make('p', { class: 'status', role: 'status', 'aria-live': 'polite' })
    const toggle = (open) => {
      panel.hidden = !open
      pill.setAttribute('aria-expanded', String(open))
      if (!open) status.textContent = ''
    }
    pill.addEventListener('click', () => toggle(panel.hidden))

    panel.append(make('h2', { text: 'Insulin Apps' }))
    panel.append(make('p', {}, [
      document.createTextNode('Signed in as '), make('strong', { text: me.user.name }), make('br'),
      make('span', { class: 'muted', text: me.user.email }),
    ]))

    if (me.organizations.length > 1) {
      const select = make('select', { id: 'account-org', name: 'org' }, me.organizations.map((item) =>
        make('option', { value: item.id, selected: item.active, text: item.name + ' (' + item.roleLabel + ')' })))
      const form = make('form', {}, [
        make('label', { for: 'account-org', text: 'Organization' }),
        make('div', { class: 'switch' }, [select, make('button', { class: 'button', type: 'submit', text: 'Switch' })]),
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
      panel.append(make('p', {}, [
        document.createTextNode('Organization: '), make('strong', { text: org.name }), document.createTextNode(' (' + org.roleLabel + ')'),
      ]))
    }

    const links = [['Members', me.links.members], ['All apps', me.links.apps], ['Account', me.links.account]]
      .map(([text, href]) => [text, httpUrl(href)])
      .filter(([, href]) => href)
    panel.append(make('ul', { class: 'links' }, links.map(([text, href]) => make('li', {}, [make('a', { href, text })]))))

    const signOut = make('button', { class: 'button secondary', type: 'button', text: 'Sign out' })
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
    const close = make('button', { class: 'button secondary', type: 'button', text: 'Close' })
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
