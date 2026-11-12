#!/usr/bin/env node
// Makes a new Esign seal key and puts its private half on the Worker as the ESIGN_SEAL_KEY binding: a Cloudflare
// secret_key, imported as a non-extractable ECDSA P-256 key that can only sign. The private key exists only in this
// process's memory; it is never printed or written to disk, and Cloudflare can't give it back. What is printed is the
// entry to add to src/app/server/esign/seal/keys.ts, the public half the seals are verified against.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node esign/scripts/put-seal-key.mjs [--worker <name>]
//
// The token needs Workers Scripts: Edit on the account. Putting the binding deploys a new version of the Worker with
// the same code; `wrangler deploy` keeps it from then on (it keeps a Worker's secret_key bindings).
//
// Rotating: run this, then add the printed entry to keys.ts, set the old entry's `until` to the printed `from`, and
// deploy. Between the two, the Worker holds the new key while keys.ts still names the old one, so sealing refuses to
// sign (the signature doesn't match the named key) and finished envelopes wait, FINALIZING, for the next five-minute
// tick after the deploy; nothing is sealed with a key keys.ts doesn't name.
import { webcrypto as crypto } from 'node:crypto'
import { parseArgs } from 'node:util'

const BINDING = 'ESIGN_SEAL_KEY'
const P256 = { name: 'ECDSA', namedCurve: 'P-256' }

const { values } = parseArgs({ options: { worker: { type: 'string', default: 'insulin-apps-esign' }, from: { type: 'string' } } })
const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
if (!account || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Scripts: Edit).')
  process.exit(2)
}
const from = values.from ?? new Date().toISOString()
if (!Number.isFinite(Date.parse(from))) {
  console.error(`--from is not an ISO 8601 time: ${from}`)
  process.exit(2)
}

const api = (path, init = {}) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(values.worker)}${path}`, {
  ...init,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
})
const failure = async (response) => {
  const body = await response.json().catch(() => null)
  return `${response.status} ${JSON.stringify(body?.errors ?? body)}`
}

const pair = await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])
const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey))
const put = await api('/secrets', {
  method: 'PUT',
  body: JSON.stringify({
    name: BINDING,
    type: 'secret_key',
    format: 'pkcs8',
    algorithm: P256,
    usages: ['sign'],
    key_base64: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'),
  }),
})
if (!put.ok) {
  console.error(`Putting ${BINDING} on ${values.worker} failed: ${await failure(put)}`)
  process.exit(1)
}

const listed = await api('/secrets')
const binding = listed.ok ? (await listed.json()).result?.find((secret) => secret.name === BINDING) : undefined
if (binding?.type !== 'secret_key') {
  console.error(`${BINDING} was put, but listing the Worker's secrets ${listed.ok ? `shows it as ${binding?.type ?? 'missing'}` : `failed: ${await failure(listed)}`}.`)
  process.exit(1)
}

const id = Buffer.from(await crypto.subtle.digest('SHA-256', spki)).toString('hex')
console.error(`${BINDING} is on ${values.worker}. Add this entry to src/app/server/esign/seal/keys.ts (SEAL_KEYS):`)
console.log(JSON.stringify({ id, spki: spki.toString('base64'), from }, null, 2))
