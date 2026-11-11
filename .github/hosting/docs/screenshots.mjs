#!/usr/bin/env node
// Captures the docs' screenshots (assets/screenshots/*.png) from a real local run: the gateway with Cap Table and
// Esign, as `npm run dev -- --app captable --app esign` starts them, driven in Chrome through synthetic data only.
//
//   (cd captable && npm ci && NITRO_PRESET=cloudflare_module npm run build)
//   (cd esign && npm ci && NITRO_PRESET=cloudflare_module npm run build)
//   (cd .github/hosting/gateway && npm ci)
//   (cd .github/hosting/docs && npm ci && node screenshots.mjs)
//
// Options: --port <n> (8795), --chrome <path to a Chrome binary> (else the installed Google Chrome), --headed, and
// --only <name,...> to write only those screenshots (every step still runs, since each builds on the one before).
// Then run `npm run build:docs` in the gateway: the pages link each image with its content hash.
//
// What the run does: signs up (confirming through the captured-mail page), creates an organization, adds a custom role,
// invites people with an organization role and with specific apps, accepts an invitation, stores a credential, creates
// two OAuth clients and rotates one's secret, connects an MCP client, imports Cap Table's own spreadsheet template
// filled with a fictional company, opens its dashboard, cap table and holder view, uploads an Esign template, places
// its fields, sends an envelope and signs it, then creates a second organization under the same email domain, which
// reaches the limit of two, so the next one is a request to support. Light mode, a 1280 x 800 viewport.
//
// The run is local and offline except for Cloudflare's Turnstile widget, which the sign-up and sign-in forms load (the
// local config uses Cloudflare's always-passing test keys). It serves the stack over https, with wrangler's
// self-signed certificate: Esign accepts its own origin for the embedded field editor only over https. Esign sends
// signing codes through the gateway's mail relay, which it reaches through a small proxy on 127.0.0.1: the app accepts
// a relay URL over https or plain http on a loopback host, and wrangler's certificate isn't one the Worker trusts.
//
// One screenshot can't be taken here: Esign seals a finished envelope with an AWS KMS signature and an RFC 3161
// timestamp, both outside services, so an envelope never reaches Completed locally. esign-completed.png is a labelled
// placeholder, drawn by this script, until it is captured from a deployment with a KMS key.
//
// Nor can a domain be verified: the gateway checks the DNS TXT record over DNS-over-HTTPS at a fixed address
// (cloudflare-dns.com), and `wrangler dev` has no way to answer the Worker's outbound fetches with a stub (the tests do,
// through Miniflare's outboundService). platform-organization.png therefore shows the Invitations card as an owner sees
// it before any domain is verified.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { chromium } from 'playwright-core'

const docsDir = dirname(fileURLToPath(import.meta.url))
const repositoryDir = resolve(docsDir, '..', '..', '..')
const gatewayDir = join(repositoryDir, '.github', 'hosting', 'gateway')
const OUT = join(docsDir, 'assets', 'screenshots')
const { startDev } = await import(pathToFileURL(join(gatewayDir, 'scripts', 'dev.mjs')).href)
const { appToken } = await import(pathToFileURL(join(repositoryDir, '.github', 'scripts', 'deploy-apps.mjs')).href)

const argument = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = argument('--port', '8795')
const ONLY = argument('--only', null)?.split(',') ?? null
const DOMAIN = 'insulinapps.localhost'
const APEX = `https://${DOMAIN}:${PORT}`
const host = (app) => `https://${app}.${DOMAIN}:${PORT}`
const VIEWPORT = { width: 1280, height: 800 }
const TIMEOUT = 45_000

// Synthetic people, all at reserved example domains.
const OWNER = { name: 'Ana Lima', email: 'ana@example.com', password: 'local screenshots only 1' }
const HOLDER = { name: 'Jordan Park', email: 'jordan@example.test', password: 'local screenshots only 2' }
const DIRECTOR = { name: 'Riley Chen', email: 'riley.chen@example.test' }
const SIGNERS = [{ name: 'Avery Patel', email: 'avery.patel@example.com', title: 'Managing Partner' }, { name: 'Sam Rivera', email: 'sam.rivera@example.com', title: 'Chief Executive Officer' }]
const ORG = 'Northwind Robotics'
// A second organization under the same email domain (example.com) as ORG: two is the limit for one domain.
const SECOND_ORG = 'Northwind Labs'
const COMPANY = 'Northwind Robotics, Inc.'

// Local-only settings: a gateway key made of synthetic bytes, Esign's code pepper, and a KMS key name in AWS's
// documentation account. None of them is a secret; nothing here ever reaches a deployment.
const GATEWAY_SECRET_KEY = Buffer.alloc(32, 0x42).toString('base64')
const ESIGN_OTP_KEY = 'local-screenshots-code-pepper-0123456789abcdef'
const ESIGN_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/local-screenshots'

const log = (message) => process.stdout.write(`${message}\n`)

/** Forwards POST /__insulin/mail to the local gateway over https, as the apex. */
function startRelayProxy() {
  const server = createServer((incoming, answer) => {
    if (incoming.method !== 'POST' || incoming.url !== '/__insulin/mail') {
      answer.writeHead(404).end()
      return
    }
    const outgoing = httpsRequest({
      host: '127.0.0.1', port: PORT, method: 'POST', path: incoming.url, rejectUnauthorized: false,
      headers: { ...incoming.headers, host: `${DOMAIN}:${PORT}` },
    }, (response) => {
      answer.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(answer)
    })
    outgoing.on('error', () => answer.writeHead(502).end())
    incoming.pipe(outgoing)
  })
  return new Promise((accept) => server.listen(0, '127.0.0.1', () => accept(server)))
}

/** GET on the local stack, as `hostname`, ignoring the self-signed certificate. */
function probe(path, hostname = DOMAIN) {
  return new Promise((accept) => {
    const req = httpsRequest({ host: '127.0.0.1', port: PORT, path, rejectUnauthorized: false, headers: { host: `${hostname}:${PORT}` } }, (response) => {
      response.resume()
      accept(response.statusCode)
    })
    req.on('error', () => accept(0))
    req.end()
  })
}

async function waitForStack(child) {
  let exited = false
  child.once('exit', () => { exited = true })
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (exited) throw new Error('wrangler dev exited before the stack was ready')
    if (await probe('/docs/') === 200) return
    await new Promise((accept) => setTimeout(accept, 1000))
  }
  throw new Error('the local stack did not answer within four minutes')
}

let saved = 0
/** Saves a PNG of the viewport (or of `locator`), unless --only leaves it out. */
async function shot(page, name, { locator, fullPage = false } = {}) {
  if (ONLY && !ONLY.includes(name)) return
  await page.waitForLoadState('networkidle').catch(() => {})
  // The apps show "Loading…" (or "Loading the company…") while they fetch; wait for the page itself.
  await page.waitForFunction(() => !/Loading[^\n]{0,40}(?:…|\.\.\.)/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {})
  await page.evaluate(() => document.fonts?.ready).catch(() => {})
  const path = join(OUT, `${name}.png`)
  if (locator) await locator.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, fullPage, animations: 'disabled' })
  const { size } = await stat(path)
  saved += 1
  log(`  ${name}.png  ${Math.round(size / 1024)} KB`)
  if (size > 300 * 1024) log(`  ! ${name}.png is over 300 KB`)
}

/** The newest captured message to `to` whose text has a link to `path`: the captured-mail page lists them. */
async function mailLink(page, to, path) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await page.request.get(`${APEX}/__insulin/dev/mail?format=json`)
    const { mails } = await response.json()
    const mail = mails.find((candidate) => candidate.to === to && candidate.links.some((link) => new URL(link).pathname.startsWith(path)))
    if (mail) return mail.links.find((link) => new URL(link).pathname.startsWith(path))
    await page.waitForTimeout(500)
  }
  throw new Error(`no ${path} link in mail to ${to}`)
}

/** The six-digit signing code in the newest captured message to `to`. */
async function mailCode(page, to, after) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { mails } = await (await page.request.get(`${APEX}/__insulin/dev/mail?format=json`)).json()
    const mail = mails.find((candidate) => candidate.to === to && candidate.id > after && /\b\d{6}\b/.test(candidate.text))
    if (mail) return /\b(\d{6})\b/.exec(mail.text)[1]
    await page.waitForTimeout(500)
  }
  throw new Error(`no signing code in mail to ${to}`)
}

async function newestMailId(page) {
  const { mails } = await (await page.request.get(`${APEX}/__insulin/dev/mail?format=json`)).json()
  return mails.reduce((max, mail) => Math.max(max, mail.id), 0)
}

/** Waits for the Turnstile widget (Cloudflare's test keys always pass) to fill in its token. */
async function turnstile(page) {
  await page.waitForFunction(() => document.querySelector('input[name="cf-turnstile-response"]')?.value, null, { timeout: 30_000 })
}

/** Sign-up, then the confirmation link from the captured-mail page. */
async function signUp(page, person, { shotName } = {}) {
  await page.goto(`${APEX}/signup`)
  await page.fill('input[name="name"]', person.name)
  await page.fill('input[name="email"]', person.email)
  await page.fill('input[name="password"]', person.password)
  await turnstile(page)
  if (shotName) await shot(page, shotName)
  await page.click('button[type="submit"]')
  await page.waitForLoadState()
  const link = await mailLink(page, person.email, '/verify-email')
  await page.goto(`${APEX}/__insulin/dev/mail`)
  await page.click(`a[href="${link}"]`)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => url.pathname === '/' || url.pathname.startsWith('/invitations/') || url.pathname.startsWith('/orgs/'), { timeout: TIMEOUT })
}

// A small PDF, built by hand: one Letter page of fictional text in Helvetica, which Esign accepts as a template.
function agreementPdf(title, lines) {
  const text = (value) => value.replace(/[\\()]/g, (character) => `\\${character}`)
  const stream = [
    `BT /F2 20 Tf 72 708 Td (${text(title)}) Tj ET`,
    `BT /F1 11 Tf 72 676 Td 16 TL ${lines.map((line) => `(${text(line)}) Tj T*`).join(' ')} ET`,
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
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

const AGREEMENT = agreementPdf('Supply Agreement', [
  `This Supply Agreement is made between ${COMPANY} (the "Buyer") and`,
  'Fabrikam Parts Co. (the "Supplier"), both fictional companies.',
  '',
  '1. Supply. The Supplier will deliver the parts listed in each purchase order.',
  '2. Price. Prices are those in the purchase order the Buyer accepts.',
  '3. Delivery. Parts are delivered to the Buyer\'s address within 30 days.',
  '4. Term. This agreement lasts one year and renews unless either party ends it.',
  '',
  'This document is synthetic. It exists only to show how Esign works.',
])

// The Cap Table spreadsheet: a fictional company, its holders and holdings, as of a fixed date.
const AS_OF = '2026-06-30'
const ROWS = {
  Company: [{ 'Company name': COMPANY, 'As-of date': AS_OF, Currency: 'USD' }],
  Stakeholders: [
    ['S1', OWNER.name, 'Founder', OWNER.email], ['S2', 'Sam Okafor', 'Founder', 'sam.okafor@example.test'],
    ['S3', HOLDER.name, 'Employee', HOLDER.email], ['S4', 'Mei Tanaka', 'Employee', 'mei.tanaka@example.test'],
    ['S5', 'Luis Romero', 'Employee', 'luis.romero@example.test'], ['S6', 'Priya Nair', 'Advisor', 'priya.nair@example.test'],
    ['S7', DIRECTOR.name, 'Board member', DIRECTOR.email],
  ].map(([id, name, relationship, email]) => ({ 'Stakeholder ID': id, Name: name, Type: 'Individual', Relationship: relationship, Email: email }))
    .concat([{ 'Stakeholder ID': 'S8', Name: 'Fabrikam Ventures', Type: 'Organization', Relationship: 'Investor', Email: 'team@fabrikam.example.com' }]),
  'Share classes': [
    { 'Class ID': 'common', Name: 'Common Stock', Type: 'Common', 'Authorized shares': '10000000', 'Conversion ratio': '', 'Original issue price': '0.0001' },
    { 'Class ID': 'seed', Name: 'Series Seed Preferred', Type: 'Preferred', 'Authorized shares': '2000000', 'Conversion ratio': '1', 'Original issue price': '1.25' },
  ],
  'Equity plans': [{ 'Plan ID': 'plan_2024', Name: '2024 Equity Incentive Plan', 'Share class ID': 'common', 'Pool size': '1500000', 'Effective date': '2024-01-15', 'Exercise window after termination (days)': '90' }],
  Shares: [
    ['CS-1', 'S1', 'common', '4000000', '2023-03-01', '0.0001'], ['CS-2', 'S2', 'common', '3000000', '2023-03-01', '0.0001'],
    ['PS-1', 'S8', 'seed', '1200000', '2024-06-14', '1.25'],
  ].map(([id, holder, klass, shares, date, price]) => ({ 'Certificate ID': id, 'Stakeholder ID': holder, 'Share class ID': klass, 'Plan ID': '', Shares: shares, 'Issue date': date, 'Price per share': price })),
  Options: [
    ['OPT-1', 'S3', 'ISO', '48000', '0.35', '2024-02-01'], ['OPT-2', 'S4', 'ISO', '36000', '0.35', '2024-05-01'],
    ['OPT-3', 'S5', 'NSO', '24000', '0.42', '2025-01-15'], ['OPT-4', 'S6', 'NSO', '12000', '0.42', '2025-03-01'],
  ].map(([id, holder, type, granted, price, date]) => ({
    'Grant ID': id, 'Stakeholder ID': holder, 'Plan ID': 'plan_2024', Type: type, 'Options granted': granted, 'Exercise price': price, 'Grant date': date,
    'Expiration date': `${Number(date.slice(0, 4)) + 10}${date.slice(4)}`, 'Vesting start date': date, 'Vesting months': id === 'OPT-4' ? '24' : '48',
    'Cliff months': id === 'OPT-4' ? '0' : '12', 'Vest every (months)': '1', 'Early exercise': 'No', 'FMV at grant': price, Exercised: '0', Cancelled: '0',
  })),
  Warrants: [],
  SAFEs: [{ 'SAFE ID': 'SAFE-1', 'Stakeholder ID': 'S8', Principal: '500000', 'Issue date': '2025-09-01', 'Valuation cap': '12000000', 'Discount %': '20', Type: 'Post-money' }],
}

const xmlEscape = (raw) => raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const column = (index) => { let out = ''; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out; return out }

/**
 * The template Cap Table built, with ROWS added under each sheet's headings: the headings are read from the template
 * itself, so the rows follow whatever columns the app asks for.
 */
function fillTemplate(bytes) {
  const files = unzipSync(new Uint8Array(bytes))
  const workbook = strFromU8(files['xl/workbook.xml'])
  const sheets = [...workbook.matchAll(/<sheet name="([^"]+)" sheetId="\d+" r:id="rId(\d+)"\/>/g)].map(([, name, id]) => ({ name: name.replace(/&amp;/g, '&'), path: `xl/worksheets/sheet${id}.xml` }))
  for (const sheet of sheets) {
    const rows = ROWS[sheet.name]
    if (!rows?.length) continue
    const xml = strFromU8(files[sheet.path])
    const headings = [...xml.matchAll(/<c r="[A-Z]+1"[^>]*><is><t[^>]*>([^<]*)<\/t><\/is><\/c>/g)].map(([, text]) => text.replace(/&amp;/g, '&'))
    for (const row of rows) for (const key of Object.keys(row)) if (!headings.includes(key)) throw new Error(`the template's ${sheet.name} sheet has no column "${key}"`)
    const added = rows.map((row, r) => `<row r="${r + 2}">${headings.map((heading, c) => `<c r="${column(c + 1)}${r + 2}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(row[heading] ?? '')}</t></is></c>`).join('')}</row>`).join('')
    files[sheet.path] = strToU8(xml.replace('</sheetData>', `${added}</sheetData>`))
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

/** A PNG that says, in words, that a screenshot isn't available here and why. Rendered by Chrome from local HTML. */
async function placeholder(context, name, title, lines) {
  const page = await context.newPage()
  await page.setContent(`<!doctype html><html><body style="margin:0;font:16px system-ui,sans-serif;background:#f5f5f5;color:#262626">
    <div style="box-sizing:border-box;height:800px;padding:64px;display:flex;flex-direction:column;justify-content:center;gap:16px;border:2px dashed #a3a3a3">
    <p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#737373">Placeholder · not a screenshot</p>
    <h1 style="margin:0;font-size:32px">${title}</h1>${lines.map((line) => `<p style="margin:0;max-width:60ch;line-height:1.6">${line}</p>`).join('')}</div></body></html>`)
  await shot(page, name)
  await page.close()
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const relay = await startRelayProxy()
  const state = await mkdtemp(join(tmpdir(), 'insulin-docs-screenshots-'))
  log(`Starting the gateway, Cap Table and Esign at ${APEX} (state in ${state})`)
  const child = await startDev({
    apps: ['captable', 'esign'],
    port: PORT,
    state,
    https: true,
    stdio: ['ignore', 'ignore', 'inherit'],
    // A Google client id only to show "Continue with Google", as production does; nobody signs in with it here.
    // ORG_REQUEST_EMAIL shows the "Request more organizations" form at the limit; local mail is captured, never sent.
    gatewayVars: {
      GATEWAY_SECRET_KEY, GOOGLE_CLIENT_ID: 'local-screenshots.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'local-screenshots-only',
      ORG_REQUEST_EMAIL: 'support@example.com',
    },
    appVars: {
      esign: {
        ESIGN_OTP_KEY,
        ESIGN_KMS_KEY_ARN,
        ESIGN_FRAME_ANCESTORS: host('esign'),
        SUGER_APP_TOKEN: appToken(GATEWAY_SECRET_KEY, 'esign'),
        SUGER_MAIL_URL: `http://127.0.0.1:${relay.address().port}/__insulin/mail`,
      },
    },
  })
  const stop = async () => {
    child.kill('SIGINT')
    relay.close()
    await new Promise((accept) => setTimeout(accept, 1500))
    await rm(state, { recursive: true, force: true })
  }
  let browser
  try {
    await waitForStack(child)
    log('Ready. Capturing:')
    browser = await chromium.launch({ headless: !process.argv.includes('--headed'), ...(argument('--chrome', null) ? { executablePath: argument('--chrome', null) } : { channel: 'chrome' }) })
    const options = { viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light', ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'America/Los_Angeles', acceptDownloads: true }
    const owner = await browser.newContext(options)
    owner.setDefaultTimeout(TIMEOUT)
    const page = await owner.newPage()

    // The platform: landing, sign-in, sign-up confirmed through the captured mail, a new organization.
    await page.goto(`${APEX}/`)
    await shot(page, 'platform-landing')
    await page.goto(`${APEX}/login`)
    await turnstile(page)
    await shot(page, 'platform-sign-in')
    await signUp(page, OWNER, { shotName: 'platform-sign-up' })
    await page.goto(`${APEX}/orgs/new`)
    await page.fill('input[name="name"]', ORG)
    await shot(page, 'platform-new-organization')
    await page.click('button:has-text("Create organization")')
    await page.waitForURL((url) => url.searchParams.has('org'))
    const orgId = new URL(page.url()).searchParams.get('org')

    // A custom role for Cap Table, built from its permission catalog.
    await page.goto(`${APEX}/settings/roles?org=${orgId}`)
    const roleForm = page.locator('form:has(input[name="app"][value="captable"])')
    await roleForm.locator('input[name="name"]').fill('Board observer')
    await roleForm.locator('input[name="description"]').fill('Sees the whole cap table, changes nothing.')
    await roleForm.locator('input[name="permission"][value="captable.view"]').check()
    await roleForm.locator('button:has-text("Create role")').click()
    await page.waitForLoadState()
    await page.locator('h2', { hasText: 'Cap Table' }).first().scrollIntoViewIfNeeded()
    await shot(page, 'platform-roles')

    // Invitations: Jordan with an organization role, Riley to specific apps with the custom role in Cap Table.
    await page.goto(`${APEX}/settings/users?org=${orgId}`)
    await page.fill('form[action$="/invitations"] input[name="email"]', HOLDER.email)
    await page.selectOption('form[action$="/invitations"] select[name="role"]', 'VIEWER')
    await page.click('button:has-text("Send invitation")')
    await page.waitForLoadState()
    await page.fill('form[action$="/invitations"] input[name="email"]', DIRECTOR.email)
    await page.selectOption('form[action$="/invitations"] select[name="role"]', 'APPS')
    const custom = await page.locator('form[action$="/invitations"] select[name="app:captable"] option', { hasText: 'Board observer' }).getAttribute('value')
    await page.selectOption('form[action$="/invitations"] select[name="app:captable"]', custom)
    await page.selectOption('form[action$="/invitations"] select[name="app:esign"]', 'VIEWER')
    await page.click('button:has-text("Send invitation")')
    await page.waitForLoadState()
    await shot(page, 'platform-people', { fullPage: true })

    // Jordan signs up, confirms, and opens the invitation.
    const holder = await browser.newContext(options)
    holder.setDefaultTimeout(TIMEOUT)
    const holderPage = await holder.newPage()
    await signUp(holderPage, HOLDER)
    await holderPage.goto(await mailLink(holderPage, HOLDER.email, '/invitations/'))
    await shot(holderPage, 'platform-invitation')
    await holderPage.click('button:has-text("Accept")')
    await holderPage.waitForLoadState()

    // The signed-in home page, an app's people, its integrations with a stored credential, and its API access.
    await page.goto(`${APEX}/`)
    await shot(page, 'platform-home')
    await page.goto(`${APEX}/apps/captable/settings/users`)
    await shot(page, 'platform-app-people')
    await page.goto(`${APEX}/apps/captable/settings/integrations`)
    await page.fill('#new-credential-key', 'payroll')
    await page.fill('#new-credential-name', 'Payroll provider')
    await page.fill('#new-credential-base', 'https://api.payroll.example.com')
    await page.selectOption('#new-credential-scheme', 'bearer')
    // A synthetic value, encrypted by the local gateway and never shown again.
    await page.fill('#new-credential-secret', 'local-screenshots-not-a-secret')
    await page.click('button:has-text("Save credential")')
    await page.waitForLoadState()
    await page.goto(`${APEX}/apps/captable/settings/integrations`)
    await shot(page, 'platform-integrations')

    // API access: two OAuth clients, one of them just rotated. A secret is shown only in the answer to the POST that
    // made it; the screenshot is of the page loaded afresh, which never shows one.
    const api = `${APEX}/apps/captable/settings/api`
    for (const [name, role] of [['Payroll sync', 'VIEWER'], ['Back office', 'EDITOR']]) {
      await page.goto(api)
      await page.fill('#new-client-name', name)
      await page.selectOption('#new-client-role', role)
      await page.click('form[action$="/settings/api/clients"] button[type="submit"]')
      await page.getByText(`${name} is ready`).waitFor()
    }
    await page.goto(api)
    await page.locator('tr', { hasText: 'Back office' }).locator('button', { hasText: 'Rotate secret' }).click()
    await page.getByText('Back office has a new secret').waitFor()
    await page.goto(api)
    await page.getByText('The previous secret works until').waitFor()
    await shot(page, 'platform-api-access', { fullPage: true })

    await page.goto(`${APEX}/account/security`)
    await shot(page, 'platform-security')
    await page.goto(`${APEX}/settings/sso?org=${orgId}`)
    await shot(page, 'platform-sso')
    // The Organization tab, with the Invitations card as it is before a domain is verified (see the top of the file).
    await page.goto(`${APEX}/settings/organization?org=${orgId}`)
    await shot(page, 'platform-organization')

    // An MCP client: dynamic registration, then the consent page in the browser, then Account → AI agents.
    const callback = 'http://127.0.0.1:33418/callback'
    const registered = await (await page.request.post(`${APEX}/oauth/register`, {
      data: { client_name: 'Claude Code', redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    })).json()
    if (!registered.client_id) throw new Error(`registration failed: ${JSON.stringify(registered)}`)
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = new URL(`${APEX}/oauth/authorize`)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: registered.client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 'docs', resource: `${host('captable')}/mcp` })) {
      authorize.searchParams.set(key, value)
    }
    await page.route('http://127.0.0.1:33418/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Connected. You can close this tab.' }))
    await page.goto(authorize.href)
    await shot(page, 'platform-agent-consent')
    await page.click('button[value="allow"]')
    await page.waitForURL((url) => url.host === '127.0.0.1:33418')
    await page.goto(`${APEX}/account/agents`)
    await shot(page, 'platform-agents')
    await page.goto(`${APEX}/apps/captable/settings/connect-ai`)
    await shot(page, 'platform-connect-ai', { fullPage: true })

    // Cap Table: the setup page, its own template filled with the fictional company, the preview, the import.
    const captable = host('captable')
    await page.goto(`${captable}/`)
    await page.waitForURL((url) => url.pathname === '/setup')
    await page.getByRole('heading', { name: 'Set up your company' }).waitFor()
    await shot(page, 'captable-setup')
    await page.click('a:has-text("Import from a spreadsheet")')
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download the template")')])
    const template = await (await import('node:fs/promises')).readFile(await download.path())
    await page.setInputFiles('input[type="file"]', { name: 'northwind-cap-table.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fillTemplate(template) })
    await page.click('button:has-text("Check the files")')
    await page.getByRole('heading', { name: 'Review the import' }).waitFor()
    await shot(page, 'captable-import-preview')
    await page.click('.wiz-foot button:has-text("Import")')
    await page.click('a:has-text("Go to the dashboard"), button:has-text("Go to the dashboard")')
    await page.waitForURL((url) => url.pathname.endsWith('/dashboard'))
    const company = new URL(page.url()).pathname.replace(/\/dashboard$/, '')
    // A fresh load: the wizard's own navigation can leave the dashboard waiting on the company it just created.
    await page.goto(`${captable}${company}/dashboard`)
    await shot(page, 'captable-dashboard')
    await page.goto(`${captable}${company}/captable`)
    await shot(page, 'captable-cap-table')
    await page.goto(`${captable}${company}/stakeholders`)
    await shot(page, 'captable-stakeholders')
    await page.goto(`${captable}${company}/issue/options`)
    await shot(page, 'captable-record-grant')
    await page.goto(`${captable}${company}/docs`)
    await shot(page, 'captable-docs')

    // Jordan, a Viewer whose address matches a stakeholder, sees their own holdings.
    await holderPage.goto(`${captable}/`)
    await holderPage.waitForLoadState('networkidle')
    await shot(holderPage, 'captable-holder-view')

    // Esign: a template with an added signature page, one with placed fields, an envelope, and its signing page.
    const esign = host('esign')
    await page.goto(`${esign}/templates`)
    await page.setInputFiles('#template-pdf', { name: 'supply-agreement.pdf', mimeType: 'application/pdf', buffer: AGREEMENT })
    await page.getByLabel('Role 1', { exact: true }).fill('buyer')
    await page.click('button:has-text("Add a role")')
    await page.getByLabel('Role 2', { exact: true }).fill('supplier')
    await page.click('button:has-text("Upload with a signature page")')
    await page.getByText('Template uploaded.').waitFor()
    await shot(page, 'esign-templates')
    await page.setInputFiles('#template-pdf', { name: 'supply-agreement-fields.pdf', mimeType: 'application/pdf', buffer: AGREEMENT })
    await page.getByLabel('Role 1', { exact: true }).fill('buyer')
    // The form keeps the roles of the last upload.
    if (!await page.getByLabel('Role 2', { exact: true }).count()) await page.click('button:has-text("Add a role")')
    await page.getByLabel('Role 2', { exact: true }).fill('supplier')
    await page.click('button:has-text("Upload and place fields")')
    const editor = page.frameLocator('iframe[title="Signature field editor"]')
    // Each field starts at the page's top left; arrow keys move it by 1% of the page.
    const place = async (role, type, down, right) => {
      await editor.getByRole('radio', { name: role }).check()
      await editor.getByRole('button', { name: `Add ${type} field` }).click()
      const field = editor.getByRole('button', { name: `${role} — ${type}`, exact: true })
      await field.focus()
      for (let i = 0; i < down; i += 1) await field.press('ArrowDown')
      for (let i = 0; i < right; i += 1) await field.press('ArrowRight')
    }
    await place('buyer', 'Signature', 40, 6)
    await place('buyer', 'Date signed', 40, 52)
    await place('supplier', 'Signature', 52, 6)
    await place('supplier', 'Date signed', 52, 52)
    await page.locator('iframe[title="Signature field editor"]').evaluate((frame) => frame.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(300)
    await shot(page, 'esign-template-editor')
    await page.click('button:has-text("Save fields")')
    await page.getByText(/saved/i).first().waitFor().catch(() => page.waitForTimeout(2000))

    await page.goto(`${esign}/envelopes/new`)
    // The template with placed fields, once the list has loaded.
    await page.locator('#envelope-template option:not([value=""])').first().waitFor({ state: 'attached' })
    const templateOptions = await page.locator('#envelope-template option:not([value=""])').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent ?? '' })))
    await page.selectOption('#envelope-template', (templateOptions.find((option) => !option.text.includes('signature page')) ?? templateOptions[0]).value)
    for (const [index, signer] of SIGNERS.entries()) {
      await page.fill(`#signer-${index}-name`, signer.name)
      await page.fill(`#signer-${index}-email`, signer.email)
    }
    await page.fill('#doc-name', 'Supply Agreement')
    await shot(page, 'esign-new-envelope')
    await page.click('button:has-text("Send for signature")')
    await page.waitForURL((url) => /^\/envelopes\/[0-9a-f-]{36}$/.test(url.pathname))
    const envelopeUrl = page.url()

    {
      // The first signer's page, opened the way the envelope page's "Open … signing page" does.
      const tasks = await page.evaluate(async (id) => (await (await fetch(`/api/envelopes/${id}`)).json()), envelopeUrl.split('/').pop())
      const task = (tasks.envelope?.tasks ?? tasks.tasks ?? []).find((candidate) => candidate.status === 'ACTIVE')
      const view = await page.evaluate(async ([id, taskId, origin]) => (await fetch(`/api/envelopes/${id}/tasks/${taskId}/recipient-view`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }),
      })).json(), [envelopeUrl.split('/').pop(), task.id, esign])
      if (!view.code) throw new Error(`no signing code for the page: ${JSON.stringify(view)}`)
      const { code } = view
      const signer = await browser.newContext(options)
      signer.setDefaultTimeout(TIMEOUT)
      const signing = await signer.newPage()
      const before = await newestMailId(page)
      await signing.goto(`${esign}/sign#code=${encodeURIComponent(code)}&host=${encodeURIComponent(esign)}`)
      await signing.click('button:has-text("Continue")')
      await signing.getByRole('button', { name: 'Verify code' }).waitFor()
      await shot(signing, 'esign-signing-code')
      const otp = await mailCode(page, SIGNERS[0].email, before)
      const boxes = signing.locator('input[inputmode="numeric"]')
      for (const [index, digit] of [...otp].entries()) await boxes.nth(index).fill(digit)
      await signing.click('button:has-text("Verify code")')
      await signing.getByRole('heading', { name: 'Adopt your signature' }).waitFor()
      await signing.getByLabel('Full name').fill(SIGNERS[0].name)
      await signing.locator('input[type="checkbox"]').first().check()
      await shot(signing, 'esign-signing-review')
      await signing.click('button:has-text("Sign document")')
      await signing.getByText('Signature recorded.').waitFor()
      await signer.close()
    }
    await page.goto(envelopeUrl)
    await page.getByRole('heading').first().waitFor()
    await shot(page, 'esign-envelope', { fullPage: true })
    await placeholder(owner, 'esign-completed', 'A completed envelope', [
      'This image is a placeholder. A completed envelope can\'t be captured on a local run: Esign seals a finished envelope with an AWS KMS signature and an RFC 3161 timestamp from outside services, so locally it stays Finishing.',
      'When an envelope is completed, its page shows the status Completed and two downloads: Signed PDF with certificate, and Certificate of completion.',
    ])

    // A second organization under example.com reaches the limit of two. The organization menu, back in the first one,
    // lists both; then Create an organization asks support for more instead.
    await page.goto(`${APEX}/orgs/new`)
    await page.fill('input[name="name"]', SECOND_ORG)
    await page.click('button:has-text("Create organization")')
    await page.waitForURL((url) => url.searchParams.has('org') && url.searchParams.get('org') !== orgId)
    await page.goto(`${APEX}/`)
    const orgMenu = page.locator('header summary', { hasText: 'Organization:' })
    await orgMenu.click()
    await page.locator('header form button', { hasText: ORG }).click()
    await page.getByRole('heading', { name: `Apps in ${ORG}` }).waitFor()
    await orgMenu.click()
    await page.locator('header a', { hasText: 'Create an organization' }).waitFor()
    await shot(page, 'platform-org-menu')
    await page.goto(`${APEX}/orgs/new`)
    await page.getByRole('heading', { name: 'Request more organizations' }).waitFor()
    await page.fill('input[name="name"]', 'Northwind Europe')
    await page.fill('#field-reason', 'A separate workspace for our European subsidiary, with its own cap table and its own people.')
    await shot(page, 'platform-request-organizations')

    await holder.close()
    await owner.close()
    log(`${saved} screenshot(s) in ${OUT}. Now run \`npm run build:docs\` in .github/hosting/gateway.`)
  } catch (error) {
    // --debug <dir>: what every open page showed when a step failed.
    const debug = argument('--debug', null)
    if (debug && browser) {
      await mkdir(debug, { recursive: true })
      for (const [c, context] of browser.contexts().entries()) {
        for (const [p, open] of context.pages().entries()) {
          await open.screenshot({ path: join(debug, `failed-${c}-${p}.png`), fullPage: true }).catch(() => {})
          await writeFile(join(debug, `failed-${c}-${p}.txt`), `${open.url()}\n\n${await open.innerText('body').catch(() => '')}`)
        }
      }
      log(`The pages at the failure are in ${debug}`)
    }
    throw error
  } finally {
    await browser?.close()
    await stop()
  }
}

await main()
