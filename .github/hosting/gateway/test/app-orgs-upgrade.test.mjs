// Where each app is used, for a database an earlier release migrated and used (migration 0012, DESIGN.md §8.9): the
// organizations that already used an app are recorded as it is created, from what the gateway held of the app there,
// so the app's endpoints answer for them before anyone opens the app again. Esign's tick checks whoever scheduled a
// send with member status; an organization that used Esign before the release gets its answer at the first tick.
// Nothing else is recorded. All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, SECRET_KEY, startGateway } from './helpers/harness.mjs'
import { appToken } from '../../../scripts/deploy-apps.mjs'

const ESIGN = {
  name: 'esign', title: 'Esign', summary: 'Electronic signatures.', binding: 'APP_ESIGN',
  permissions: [
    { key: 'esign.manage', label: 'Send and manage envelopes', description: 'Send envelopes.', role: 'EDITOR' },
    { key: 'esign.view', label: 'View envelopes', description: 'See envelopes.', role: 'VIEWER' },
  ],
}
const ESIGN_TOKEN = appToken(SECRET_KEY, 'esign')
const CAPTABLE_TOKEN = appToken(SECRET_KEY, 'captable')
const HOUR = 60 * 60 * 1000
const T = Date.parse('2026-10-01T00:00:00Z')

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORGS = {
  reports: id(101), // Esign's usage reports for it, daily and hourly
  client: id(102), // an API client of Esign (revoked since)
  mail: id(103), // Esign's mail through the relay
  agent: id(104), // an AI agent connected to Cap Table
  credentials: id(105), // a stored credential for Cap Table
  granted: id(106), // a specific-apps member given Esign
  quiet: id(107), // members, no app evidence at all
}
const GONE = id(199) // an organization since deleted, still in the reports
const SCHEDULER = id(201)
const OWNER = id(202)
const APPS_MEMBER = id(203)

/** What a database of the release before 0012 held: organizations, people and their use of the apps. */
async function seed(db) {
  const run = (sql, ...params) => db.prepare(sql).bind(...params).run()
  for (const [n, [user, name]] of [[SCHEDULER, 'Sam Scheduler'], [OWNER, 'Olga Owner'], [APPS_MEMBER, 'Abe Apps']].entries()) {
    await run('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', user, `upgrade.${n}@example.test`, name, T)
  }
  for (const [name, org] of Object.entries(ORGS)) {
    await run('INSERT INTO orgs (id, name, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', org, `Upgrade ${name}`, OWNER, T)
    await run("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'OWNER', ?3, ?3)", org, OWNER, T)
  }
  await run("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'EDITOR', ?3, ?3)", ORGS.reports, SCHEDULER, T)
  await run("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'EDITOR', ?3, ?3)", ORGS.quiet, SCHEDULER, T)
  const metrics = '{"envelopes":2,"templates":1}'
  await run('INSERT INTO app_metrics_daily (app, org_id, day, hour, metrics) VALUES (?1, ?2, ?3, ?4, ?5)', 'esign', ORGS.reports, T + 5 * 24 * HOUR, T + 5 * 24 * HOUR + 23 * HOUR, metrics)
  await run('INSERT INTO app_metrics_hourly (app, org_id, hour, metrics, received_at) VALUES (?1, ?2, ?3, ?4, ?5)', 'esign', ORGS.reports, T + 3 * HOUR, metrics, T + 3 * HOUR + 60_000)
  await run('INSERT INTO app_metrics_hourly (app, org_id, hour, metrics, received_at) VALUES (?1, ?2, ?3, ?4, ?5)', 'esign', GONE, T + 3 * HOUR, metrics, T + 3 * HOUR)
  await run("INSERT INTO app_metrics_hourly (app, org_id, hour, metrics, received_at) VALUES ('esign', '', ?1, '{\"database_bytes\":1}', ?1)", T + 3 * HOUR)
  await run(`INSERT INTO service_accounts (id, org_id, app, name, role, client_id, secret_hash, created_by, created_at, updated_at, revoked_at)
    VALUES (?1, ?2, 'esign', 'Host product', 'EDITOR', 'ia_sa_upgradeclient000000001', 'hash', ?3, ?4, ?4, ?5)`, id(301), ORGS.client, OWNER, T + HOUR, T + 2 * HOUR)
  await run("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES ('h1', 'app:esign', ?1, ?2)", ORGS.mail, T + 4 * HOUR)
  await run("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES ('h2', 'invitation', ?1, ?2)", ORGS.quiet, T + 4 * HOUR)
  await run("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('client-upgrade', 'Synthetic agent', '[]', ?1)", T)
  await run("INSERT INTO oauth_grants (id, client_id, user_id, org_id, app, created_at, expires_at) VALUES ('grant-upgrade', 'client-upgrade', ?1, ?2, 'captable', ?3, ?4)", OWNER, ORGS.agent, T + 6 * HOUR, T + 7 * HOUR)
  await run(`INSERT INTO integrations (id, org_id, app, key, name, base_url, allowed_hosts, auth_scheme, secret_enc, created_by, created_at, updated_at)
    VALUES ('integration-upgrade', ?1, 'captable', 'bank', 'Bank', 'https://bank.example.test', '["bank.example.test"]', 'bearer', 'sealed', ?2, ?3, ?3)`, ORGS.credentials, OWNER, T + 7 * HOUR)
  await run("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'APPS', ?3, ?3)", ORGS.granted, APPS_MEMBER, T)
  await run("INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, 'esign', 'VIEWER', ?3, ?3)", ORGS.granted, APPS_MEMBER, T + 8 * HOUR)
}

let h
before(async () => {
  h = await startGateway({ apps: [...APPS, ESIGN], stubBindings: ['APP_LEDGER', 'APP_ESIGN'], upgrade: { before: '0012_limits_and_members.sql', seed } })
})
after(async () => { await h?.close() })

function status(token, org, ids) {
  return h.client().request(h.url('apex', '/__insulin/members/status'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ org, ids }),
  })
}

test('the upgrade records where each app was already used, from its reports, mail, API clients, agents, credentials and grants; nowhere else', async () => {
  const rows = await h.sql('SELECT app, org_id, first_at FROM app_orgs ORDER BY app, org_id')
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { app: 'captable', org_id: ORGS.agent, first_at: T + 6 * HOUR },
    { app: 'captable', org_id: ORGS.credentials, first_at: T + 7 * HOUR },
    { app: 'esign', org_id: ORGS.reports, first_at: T + 3 * HOUR },
    { app: 'esign', org_id: ORGS.client, first_at: T + HOUR },
    { app: 'esign', org_id: ORGS.mail, first_at: T + 4 * HOUR },
    { app: 'esign', org_id: ORGS.granted, first_at: T + 8 * HOUR },
  ].sort((a, b) => a.app.localeCompare(b.app) || a.org_id.localeCompare(b.org_id)),
  'each app where it left a trace, from the earliest; not the organization with no trace, a deleted one, or the app-wide report')
})

test("Esign's tick gets its answer for an organization that used it before the release, without anyone opening it", async () => {
  // As scheduled-send.ts asks for whoever scheduled a send: a member who may still send, active, so it goes out.
  const answer = await status(ESIGN_TOKEN, ORGS.reports, [SCHEDULER])
  assert.equal(answer.status, 200, answer.text)
  assert.deepEqual(JSON.parse(answer.text).members, [
    { id: SCHEDULER, type: 'person', status: 'member', orgRole: 'EDITOR', appRole: 'EDITOR', permissions: ['esign.manage', 'esign.view'], standing: 'active' },
  ])
  assert.equal(JSON.parse(answer.text).standing, 'active')
  // An organization that never used Esign is still none of its business until someone opens it there.
  const quiet = await status(ESIGN_TOKEN, ORGS.quiet, [SCHEDULER])
  assert.deepEqual([quiet.status, JSON.parse(quiet.text).error], [404, 'unknown_organization'])
  assert.equal((await status(CAPTABLE_TOKEN, ORGS.reports, [SCHEDULER])).status, 404, 'Cap Table was never used where only Esign was')
})
