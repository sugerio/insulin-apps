// Knowledge's screenshots (assets/screenshots/knowledge-*.png), the Knowledge step of screenshots.mjs: run against the
// local stack with the in-memory engine beside the app, as `npm run dev -- --app knowledge` starts it, driven in Chrome
// through synthetic data only (Northwind Robotics' partner program, support handbook and field service guide, with
// people at example.test).
//
// What it does: opens Home before any collection; invites two colleagues (an Editor and a Viewer in the organization)
// and signs them up; starts a collection with the New collection wizard (its learning slowed down so the progress
// shows, then "Here's what Insulin learned"); starts two more through the API; shares the first; adds a note and more
// files (one a scanned PDF and one a workbook with macros, named before learning); asks questions with an answer and
// one without; the Viewer reports an answer; marks facts as checked; goes back to an earlier restore point and undoes
// it; and opens Needs attention, Health, Rules and data, Knowledge's Connect AI page and Home again, asking across two
// collections. With reduced motion emulated, so Home's moving dots are still. Its screenshots are knowledge-*.png.
//
// The in-memory engine keeps restore points in its own clock, and changes within 5 minutes share one. So the step
// reaches the engine's control interface (knowledge/engine/src/stub/control.ts), which the local stack serves only
// over a service binding, through a relay Worker of its own: a second `wrangler dev` on the next port, bound to the
// stack's insulin-apps-knowledge-engine through wrangler's dev registry. It moves that clock forward between changes
// (so they get restore points of their own), slows one import down, records an afternoon's awake time and keeps the
// collections awake for the last question; nothing else. The engine's state lives in memory, so a reload of the stack
// (wrangler reloads it when a file it watches changes, such as a rebuilt app) empties it and fails the step.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Synthetic people at a reserved domain, invited by the organization's owner.
const EDITOR = { name: 'Mei Tanaka', email: 'mei.tanaka@example.test', password: 'local screenshots only 3', role: 'EDITOR' }
const VIEWER = { name: 'Sam Okafor', email: 'sam.okafor@example.test', password: 'local screenshots only 4', role: 'VIEWER' }

const MINUTE = 60_000
// A minute past the 5 minutes within which changes share one restore point.
const NEXT_RESTORE_POINT = 6 * MINUTE

/**
 * A PDF of one page per entry, each page a few sentences of Helvetica. Each page's content stream follows its page
 * object, as the in-memory engine reads a page's text from what comes after it.
 */
function textPdf(pages) {
  const text = (value) => value.replace(/[\\()]/g, (character) => `\\${character}`)
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (const lines of pages) {
    const stream = `BT /F1 11 Tf 72 708 Td 16 TL ${lines.map((line) => `(${text(line)}) Tj T*`).join(' ')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`)
    kids.push(`${objects.length} 0 R`)
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(pdf)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// A PDF whose one page draws only an image: a scanned page with no text, which Knowledge names at upload.
const SCANNED_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page /Resources << /XObject << /Im1 2 0 R >> >> >>\nendobj\n2 0 obj << /Type /XObject /Subtype /Image /Width 10 /Height 10 >>\nstream\n\u0001\u0002\u0003\nendstream\nendobj\n%%EOF\n', 'latin1')

const file = (name, text, mimeType = 'text/markdown') => ({ name, mimeType, buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) })

// The files: paragraphs, each a passage the in-memory engine finds facts in. All of it is fictional.
const PARTNER_FILES = [
  file('partner-program-guide.pdf', textPdf([
    ['Northwind Robotics sells through reseller partners at three tiers: Registered, Silver and Gold.',
      'Silver partners need $250,000 in annual sales, and Gold partners need $1,000,000.',
      'A partner moves up a tier after two quarters above the next tier\'s target.'],
    ['Registered partners get a 10% discount on list price, Silver partners 20% and Gold partners 30%.',
      'A deal registered first in the partner portal earns an extra 5% for 90 days.',
      'A bigger discount than the tier allows goes to the deal desk.'],
    ['Gold partners can ask for market development funds of up to 3% of last year\'s sales.',
      'Requests go through the partner portal at least 30 days before the event.',
      'Funds are paid once the partner sends proof of the activity.'],
  ]), 'application/pdf'),
  file('deal-desk-faq.md', [
    'The deal desk reviews every partner quote with an extra discount, and answers within one business day.',
    'An extra discount worth more than $25,000 needs sign-off from the alliance lead before the quote goes to the partner. Smaller ones are approved by the partner manager.',
    'Multi-year deals keep the first year\'s discount for every year. A price lock longer than three years needs the chief revenue officer\'s approval.',
  ].join('\n\n')),
  file('partner-desk-contacts.md', [
    'The partner desk answers questions about tiers, discounts and payments on weekdays, from 8:00 to 17:00 Pacific time.',
    'Partners reach the desk at partners@northwind.example.test or +1 415 555 0142.',
    'Urgent deal questions go to the deal desk channel in the partner portal.',
  ].join('\n\n')),
]

const MORE_PARTNER_FILES = [
  file('co-marketing-checklist.md', [
    'Every co-marketing event needs a signed plan, a budget and a named contact at the partner.',
    'Northwind\'s logo is used only in the versions on the partner portal.',
  ].join('\n\n')),
  file('signed-reseller-agreement.pdf', SCANNED_PDF, 'application/pdf'),
  file('price-list-2027.xlsm', 'A workbook with macros, which Insulin does not read.', 'application/vnd.ms-excel.sheet.macroEnabled.12'),
]

const COLLECTIONS = [
  {
    name: 'Support Handbook',
    purpose: 'How support answers customers: response times, urgent tickets and refunds.',
    files: [file('support-handbook.md', [
      'Support answers every customer e-mail within one business day, and urgent tickets within two hours.',
      'A ticket is urgent when a customer\'s robots are stopped on a production line.',
      'The support lead approves refunds up to $500; larger refunds need the finance team.',
    ].join('\n\n'))],
  },
  {
    name: 'Field Service Guide',
    purpose: 'How field engineers install, service and replace robot arms at customer sites.',
    files: [file('field-service-guide.md', [
      'Every robot arm gets a service visit every six months, or every 2,000 hours of running, whichever comes first.',
      'Field engineers replace the gripper pads at each visit and record the arm\'s serial number.',
      'An arm still under warranty is replaced within five business days.',
    ].join('\n\n'))],
  },
]

// Answered from a note and a page of the PDF; from one paragraph of a Markdown file; from nothing; across collections.
const QUESTION = 'How do partners request market development funds?'
const CITED = 'Who approves an extra discount worth more than $25,000?'
const UNCOVERED = 'What is the parking policy at the Austin office?'
const ACROSS = 'Who approves refunds up to $500?'

/**
 * The relay to the in-memory engine's control interface: a Worker that passes /__control/* to the stack's
 * insulin-apps-knowledge-engine over a service binding, on 127.0.0.1:`port`. Resolves once the engine answers through
 * it; returns its address and a stop function.
 */
export async function startControlRelay({ wrangler, port, state, engine, compatibilityDate }) {
  const dir = join(state, 'knowledge-control')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'relay.mjs'), `export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/__control/')) return new Response('Only /__control/*.', { status: 404 })
    return env.ENGINE.fetch(new Request(\`https://engine.local\${url.pathname}\`, request))
  },
}
`)
  const config = join(dir, 'wrangler.json')
  await writeFile(config, `${JSON.stringify({ name: 'insulin-docs-screenshots-control', main: 'relay.mjs', compatibility_date: compatibilityDate, workers_dev: false, services: [{ binding: 'ENGINE', service: engine }] }, null, 2)}\n`)
  const child = spawn(wrangler, ['dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(dir, 'state')], {
    cwd: dir, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_TELEMETRY_DISABLED: '1' },
  })
  let exited = false
  child.once('exit', () => { exited = true })
  const url = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (exited) return
    child.kill('SIGINT')
    await new Promise((accept) => setTimeout(accept, 1000))
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exited) throw new Error('the control relay\'s wrangler dev exited before it was ready')
    const status = await fetch(`${url}/__control/state`).then((response) => response.status, () => 0)
    if (status === 200) return { url, stop }
    await new Promise((accept) => setTimeout(accept, 1000))
  }
  await stop()
  throw new Error('the in-memory engine did not answer through the control relay within two minutes')
}

/**
 * Takes Knowledge's screenshots. `page` is the organization's owner's, signed in; `shot`, `signUp` and `mailLink` are
 * screenshots.mjs's; `control` is the relay's address.
 */
export async function captureKnowledge({ browser, options, page, orgId, apex, knowledge, control, shot, signUp, mailLink, log, timeout }) {
  const K = knowledge

  /** POSTs to the in-memory engine's control interface. */
  async function engine(path, body = {}) {
    const response = await fetch(`${control}/__control/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`control ${path}: ${response.status} ${await response.text()}`)
  }

  /** Knowledge's API from inside `on` (a page on Knowledge, signed in), as the site calls it. */
  async function call(on, method, path, body, upload) {
    const result = await on.evaluate(async ({ method, path, body, upload }) => {
      const headers = { accept: 'application/json' }
      let payload
      if (upload) {
        payload = new Blob([Uint8Array.from(atob(upload.base64), (character) => character.charCodeAt(0))], { type: upload.type })
        headers['content-type'] = upload.type
        headers['x-file-name'] = encodeURIComponent(upload.name)
      } else if (body !== undefined) {
        headers['content-type'] = 'application/json'
        payload = JSON.stringify(body)
      }
      if (method === 'POST') headers['idempotency-key'] = crypto.randomUUID()
      const response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' })
      const text = await response.text()
      return { status: response.status, text }
    }, { method, path, body, upload })
    const parsed = result.text ? JSON.parse(result.text) : null
    if (result.status >= 400) throw new Error(`${method} ${path}: ${result.status} ${result.text}`)
    return parsed
  }

  /** A screenshot of the whole page, its navigation running the full height (a full-page one would stop it at 800 px). */
  async function tall(on, name) {
    const viewport = on.viewportSize()
    const height = await on.evaluate(() => document.documentElement.scrollHeight)
    await on.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height) })
    await shot(on, name)
    await on.setViewportSize(viewport)
  }

  /** Waits until an import is learned. */
  async function learned(on, collectionId, importId) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const { import: status } = await call(on, 'GET', `/api/collections/${collectionId}/imports/${importId}`)
      if (status.state === 'committed' || status.state === 'duplicate') return
      if (['failed', 'cancelled'].includes(status.state)) throw new Error(`import ${importId}: ${status.state}`)
      await on.waitForTimeout(500)
    }
    throw new Error(`import ${importId} wasn't learned within a minute`)
  }

  /** Preflight, upload and learn files through the API, as the site does. */
  async function addFiles(on, collectionId, files) {
    const preflight = await call(on, 'POST', `/api/collections/${collectionId}/preflight`, { files: files.map((entry) => ({ name: entry.name, bytes: entry.buffer.length })) })
    const fileIds = []
    for (const entry of preflight.files) {
      if (!entry.accepted) continue
      const source = files.find((candidate) => candidate.name === entry.name)
      const uploaded = await call(on, 'PUT', `/api/collections/${collectionId}/uploads/${entry.fileId}`, undefined, { base64: source.buffer.toString('base64'), type: source.mimeType, name: source.name })
      if (uploaded.accepted) fileIds.push(entry.fileId)
    }
    const { import: started } = await call(on, 'POST', `/api/collections/${collectionId}/imports`, { fileIds })
    await learned(on, collectionId, started.importId)
  }

  // The home page's motion (its flow's dots) stays still, so every screenshot is the same from one run to the next.
  await page.emulateMedia({ reducedMotion: 'reduce' })

  // Home on a first visit: no collection yet.
  await page.goto(`${K}/`)
  await page.getByRole('heading', { name: 'How it works' }).waitFor()
  await tall(page, 'knowledge-home-first-visit')

  // Two colleagues: invited with an organization role, signed up through the captured mail, invitation accepted.
  const people = {}
  for (const person of [EDITOR, VIEWER]) {
    await page.goto(`${apex}/settings/users?org=${orgId}`)
    await page.fill('form[action$="/invitations"] input[name="email"]', person.email)
    await page.selectOption('form[action$="/invitations"] select[name="role"]', person.role)
    await page.click('button:has-text("Send invitation")')
    await page.waitForLoadState()
    const context = await browser.newContext(options)
    context.setDefaultTimeout(timeout)
    const theirs = await context.newPage()
    await signUp(theirs, person)
    await theirs.goto(await mailLink(theirs, person.email, '/invitations/'))
    await theirs.click('button:has-text("Accept")')
    await theirs.waitForLoadState()
    await theirs.goto(`${K}/`)
    await theirs.getByRole('heading').first().waitFor()
    people[person.role] = { ...person, context, page: theirs }
  }

  // The New collection wizard: what it is for, the files, learning (slowed down to show its progress), what it learned.
  await page.goto(`${K}/collections/new`)
  await page.fill('#new-name', 'Partner Program')
  await page.fill('#new-purpose', 'How our reseller partner program works: tiers, discounts, deal approvals and marketing funds.')
  await page.click('button:has-text("Next")')
  await page.locator('#upload-files').waitFor()
  await engine('timing', { importMs: 100_000 })
  await page.setInputFiles('#upload-files', PARTNER_FILES)
  await page.getByRole('heading', { name: 'Learning your files' }).waitFor()
  await page.getByText('Understanding…').first().waitFor()
  await shot(page, 'knowledge-learning')
  await engine('timing', { importMs: 2000 })
  await engine('advance', { ms: 2 * MINUTE })
  await page.getByText("Here's what Insulin learned").waitFor({ timeout: 60_000 })
  await page.getByText(/now has \d+ documents? and \d+ facts?/).waitFor()
  const collectionId = (await call(page, 'GET', '/api/collections')).collections.find((entry) => entry.name === 'Partner Program').id
  await page.getByRole('button', { name: 'Looks right' }).first().click()
  await page.getByText(/Checked by/).first().waitFor()
  await page.getByRole('heading', { name: 'Try a question' }).waitFor()
  await tall(page, 'knowledge-learned')
  await page.click('button:has-text("Next: share it")')
  await page.click('button:has-text("Finish")')
  await page.waitForURL((url) => url.pathname === `/collections/${collectionId}`)

  // Two more collections, and the first shared with both colleagues and, as Viewer, with everyone.
  for (const collection of COLLECTIONS) {
    const { collection: made } = await call(page, 'POST', '/api/collections', { name: collection.name, purpose: collection.purpose })
    await addFiles(page, made.id, collection.files)
  }
  for (const [role, person] of [['EDITOR', people.EDITOR], ['VIEWER', people.VIEWER]]) {
    const { members } = await call(page, 'GET', `/api/members?q=${encodeURIComponent(person.email)}`)
    const member = members.find((entry) => entry.email === person.email)
    if (!member) throw new Error(`the member lookup didn't find ${person.email}`)
    await call(page, 'PUT', `/api/collections/${collectionId}/sharing/person/${encodeURIComponent(member.id)}`, { role })
  }
  await call(page, 'PUT', `/api/collections/${collectionId}/sharing/general`, { role: 'VIEWER' })

  // A note, in a restore point of its own.
  await engine('advance', { ms: NEXT_RESTORE_POINT })
  const { import: note } = await call(page, 'POST', `/api/collections/${collectionId}/notes`, {
    title: 'Who approves marketing funds?',
    text: 'Since October, partner managers approve requests for market development funds up to $50,000. Larger requests need the alliance lead.',
  })
  await learned(page, collectionId, note.importId)

  // Sources: three more files, two named before learning (a scanned PDF, a workbook with macros); then the third.
  await engine('advance', { ms: NEXT_RESTORE_POINT })
  await page.goto(`${K}/collections/${collectionId}/sources`)
  await page.getByRole('button', { name: /^Upload files/ }).click()
  await page.setInputFiles('#upload-files', MORE_PARTNER_FILES)
  await page.getByText(/2 of 3 files can't be learned/).waitFor()
  await tall(page, 'knowledge-sources')
  await page.click('button:has-text("Learn 1 file")')
  await page.getByText(/Done\. Partner Program learned 1 file/).waitFor()

  // Ask: an answer with its numbered sources, the source at the cited words, and a question nothing covers.
  await page.goto(`${K}/collections/${collectionId}/ask`)
  const ask = async (question) => {
    const box = page.getByRole('search', { name: 'Ask' }).getByRole('textbox')
    await box.fill(question)
    await box.press('Enter')
  }
  await ask(QUESTION)
  await page.locator('section[data-outcome="answered"] [data-source="2"]').waitFor()
  await shot(page, 'knowledge-answer')
  await ask(CITED)
  await page.locator('section[data-outcome="answered"]').getByText('You asked: Who approves').waitFor()
  await page.locator('[data-citation="1"]').first().click()
  await page.locator('[data-source-viewer] [data-cited]').first().waitFor()
  await page.waitForTimeout(500)
  await shot(page, 'knowledge-source-viewer')
  await page.keyboard.press('Escape')
  await page.locator('[data-source-viewer]').waitFor({ state: 'detached' })
  await ask(UNCOVERED)
  await page.locator('[data-wont-guess]').waitFor()
  await shot(page, 'knowledge-wont-guess')

  // The Viewer reports an answer; the owner checks two facts.
  await call(people.VIEWER.page, 'POST', `/api/collections/${collectionId}/reports`, {
    question: 'What discount do Silver partners get?',
    answer: 'Registered partners get a 10% discount on list price, Silver partners 20% and Gold partners 30% [1].',
    note: 'Silver partners get 25% since the new price list.',
  })
  const { facts } = await call(page, 'GET', `/api/collections/${collectionId}/facts`)
  for (const fact of facts.filter((entry) => !entry.checked).slice(1, 3)) await call(page, 'POST', `/api/collections/${collectionId}/facts/${fact.factId}/check`)
  await page.goto(`${K}/collections/${collectionId}/knows`)
  await page.getByText(/Checked by/).first().waitFor()
  await shot(page, 'knowledge-what-it-knows')

  await page.goto(`${K}/collections/${collectionId}/sharing`)
  await page.getByText(people.VIEWER.email).waitFor()
  await tall(page, 'knowledge-sharing')

  await page.goto(`${K}/attention`)
  await page.locator('[data-attention="reported"]').first().waitFor()
  await tall(page, 'knowledge-attention')

  // History: go back to the version before the last files, then undo it.
  await page.goto(`${K}/collections/${collectionId}/history`)
  const points = page.locator('li[data-restore-point]')
  await points.nth(2).waitFor()
  await points.nth(1).getByRole('button', { name: 'Go back to this version' }).click()
  await page.locator('[data-go-back-preview]').waitFor()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Undo' }).waitFor()
  await tall(page, 'knowledge-history')
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByText('Undone.').waitFor()

  // Health and Rules and data (an Admin's), with an afternoon's awake time recorded.
  await engine('usage', { org: orgId, collectionId, kind: 'awake', seconds: 3 * 3600 })
  await page.goto(`${K}/health`)
  await page.getByRole('table', { name: "Your collections' health" }).waitFor()
  await shot(page, 'knowledge-health')
  await page.goto(`${K}/rules`)
  await page.locator('[data-try-it-result] [data-hidden-value]').first().waitFor()
  await shot(page, 'knowledge-rules')

  await page.goto(`${apex}/apps/knowledge/settings/connect-ai`)
  await shot(page, 'knowledge-connect-ai')

  // Home with collections: a question asked across two of them, both awake.
  await page.goto(`${K}/`)
  const all = (await call(page, 'GET', '/api/collections')).collections
  for (const collection of all) await engine('state', { org: orgId, collectionId: collection.id, state: 'ready', seconds: 600 })
  await page.reload()
  await page.getByRole('heading', { name: 'Ask your collections' }).waitFor()
  for (const collection of all) {
    const chip = page.getByRole('group', { name: 'Search in' }).getByRole('button', { name: collection.name })
    const wanted = ['Partner Program', 'Support Handbook'].includes(collection.name)
    if ((await chip.getAttribute('aria-pressed') === 'true') !== wanted) await chip.click()
  }
  const box = page.getByRole('search', { name: 'Ask' }).getByRole('textbox')
  await box.fill(ACROSS)
  await box.press('Enter')
  await page.locator('section[data-outcome="answered"]').waitFor()
  await tall(page, 'knowledge-home')
  await page.emulateMedia({ reducedMotion: null })

  for (const person of Object.values(people)) await person.context.close()
  log('  Knowledge done.')
}
