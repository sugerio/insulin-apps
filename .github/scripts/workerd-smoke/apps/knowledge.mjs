// Knowledge's workerd smoke checks (smoke.mjs --app knowledge): its production build in workerd with the in-memory
// engine (knowledge/engine/src/stub/worker.ts) bound as SUGER_ENGINE, as the deploy binds the real one. The basics only:
// no identity, the runtime, the engine reached over its binding, cross-origin writes, one organization kept from
// another, and the whole loop of creating a collection, adding a note and asking it. Synthetic data only.
import { randomUUID } from 'node:crypto'

/** The stub finishes imports and wakes at once, so the checks never wait on its timers. */
export const stubEngineVars = { KNOWLEDGE_STUB_TIMING: 'instant' }

/** The harness waits for the uptime check, which answers without identity. */
export const ready = { path: '/api/health', status: 200 }

const NOTE = 'Example Corp gives every employee 25 days of paid leave a year. Five more days come after five years of service.'

function identity({ role = 'ADMIN', orgRole = 'OWNER', userId = 'smoke-owner', organizationId = 'smoke-org-1', email = 'owner@example.test' } = {}) {
  return {
    'x-suger-user-id': userId,
    'x-suger-organization-id': organizationId,
    'x-suger-app-id': 'insulin-apps-knowledge',
    'x-suger-app-role': role,
    'x-suger-org-role': orgRole,
    'x-suger-user-email': email,
    'x-suger-user-name': 'Smoke Test User',
    'x-suger-access-via': 'browser',
  }
}

/** A change from the app's own pages: same origin, JSON, an idempotency key. */
function write(base, body, who = {}, headers = {}) {
  return {
    method: 'POST',
    headers: { ...identity(who), Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    body: JSON.stringify(body),
  }
}

export default async function checks({ base, response, json }) {
  const owner = { headers: identity() }
  const uptime = await json(base, '/api/health', {}, 200, 'health without identity')
  if (uptime.status !== 'ok') throw new Error(`health without identity: ${JSON.stringify(uptime)}`)
  await response(base, '/api/me', {}, 401, 'missing identity')
  const me = await json(base, '/api/me', owner, 200, 'signed-in owner')
  if (me.engine !== true) throw new Error('signed-in owner: the app has no engine, so SUGER_ENGINE is not bound')
  await response(base, '/api/__suger/version', owner, 200, 'runtime version')
  const health = await json(base, '/api/health', owner, 200, 'health for an admin')
  if (health.engine?.reachable !== true || typeof health.engine.label !== 'string') {
    throw new Error(`health for an admin: the engine isn't reachable over SUGER_ENGINE: ${JSON.stringify(health.engine)}`)
  }
  await response(base, '/collections', {}, 200, 'SPA deep link')

  await response(base, '/api/collections', write(base, { name: 'Blocked', purpose: 'Should not exist.' }, {}, {
    Origin: 'https://outside.example.test', 'Sec-Fetch-Site': 'cross-site',
  }), 403, 'cross-origin write refused')

  const created = await json(base, '/api/collections', write(base, { name: 'Smoke handbook', purpose: 'Synthetic policies for the workerd smoke test.' }), 201, 'create a collection')
  const collection = created.collection?.id
  if (typeof collection !== 'string') throw new Error(`create a collection: no id in ${JSON.stringify(created).slice(0, 500)}`)
  await json(base, `/api/collections/${collection}/notes`, write(base, { title: 'Paid leave', text: NOTE }), 202, 'add a note')

  // The stub learns at once; a question asked while it still works answers `waiting` with the collection's status.
  let answer
  const deadline = Date.now() + 20_000
  do {
    answer = await json(base, '/api/ask', write(base, { collections: [collection], question: 'How many days of paid leave does an employee get?' }), 200, 'ask')
    if (answer.outcome !== 'waiting') break
    await new Promise((accept) => setTimeout(accept, 200))
  } while (Date.now() < deadline)
  if (answer.outcome !== 'answered' || !/25 days/.test(answer.text ?? '')) throw new Error(`ask: expected an answer from the note: ${JSON.stringify(answer).slice(0, 1000)}`)
  if (!answer.citations?.length || answer.citations.some((citation) => citation.collectionId !== collection)) {
    throw new Error(`ask: expected citations of the note: ${JSON.stringify(answer.citations)}`)
  }

  const stranger = { userId: 'smoke-stranger', organizationId: 'smoke-org-2', email: 'stranger@example.test' }
  await response(base, `/api/collections/${collection}`, { headers: identity(stranger) }, 404, "another organization can't open the collection")
  await response(base, '/api/ask', write(base, { collections: [collection], question: 'How many days of paid leave?' }, stranger), 404, "another organization can't ask it")
}
