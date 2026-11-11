// How many organizations an owner domain may have (DESIGN.md §3.1): two by default, per business domain or per person
// at a public mail provider, counted inside the insert; operators' allowances; asking support for more; and the
// migration that gave existing organizations their owner domain. The harness lets example.test have many, so these
// tests use their own domains.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { COMPATIBILITY_DATE, gatewayDir } from './helpers/bundle.mjs'
import { splitStatements, startGateway } from './helpers/harness.mjs'
import { createOrg, orgAllowance, ownerDomainOf } from '../src/db/orgs.ts'
import { SHARED_DOMAINS } from '../src/db/sso.ts'

let h
before(async () => { h = await startGateway({ vars: { SUPPORT_EMAIL: 'help@example.test' } }) })
after(async () => { await h?.close() })

// A public mail provider from the gateway's own list. Its addresses are built here, never written out: they are
// synthetic, and only ever reach the capture table.
const PROVIDER = 'gmail.com'
let counter = 0
function address(domain, prefix = 'person') {
  counter += 1
  return `${prefix}.${counter}@${domain}`
}

const create = (person, name) => person.client.post(h.url('auth', '/orgs/new'), { name })
const ownerDomainCount = async (domain) => (await h.sql('SELECT COUNT(*) AS n FROM orgs WHERE owner_domain = ?1', domain))[0].n

test('owner domains: the domain in lower case and punycode, or a public provider\'s address without its +tag', () => {
  assert.ok(SHARED_DOMAINS.has(PROVIDER))
  assert.equal(ownerDomainOf('ada@Acme.TEST'), 'acme.test')
  assert.equal(ownerDomainOf('anna@bücher.test'), 'xn--bcher-kva.test')
  assert.equal(ownerDomainOf(`Ada.Lovelace@${PROVIDER}`), `ada.lovelace@${PROVIDER}`)
  assert.equal(ownerDomainOf(`ada+work@${PROVIDER}`), `ada@${PROVIDER}`)
  assert.equal(ownerDomainOf(`+odd@${PROVIDER}`), `+odd@${PROVIDER}`)
})

test('an email domain may have two organizations; the next person there is offered a request instead of the form', async () => {
  const domain = 'two-limit.test'
  const first = await h.user({ email: address(domain) })
  const second = await h.user({ email: address(domain) })
  await h.org(first.client, 'Two One')
  await h.org(second.client, 'Two Two')
  assert.equal(await ownerDomainCount(domain), 2)

  for (const person of [first, second]) {
    const page = await person.client.get(h.url('auth', '/orgs/new'))
    assert.equal(page.status, 200)
    assert.match(page.text, /<h2>Request more organizations<\/h2>/)
    assert.ok(page.text.includes(`People with an address at ${domain} have created 2 organizations, the most allowed for one email domain (2).`))
    assert.doesNotMatch(page.text, /action="\/orgs\/new"/, 'no create form')
    const refused = await create(person, 'One Too Many')
    assert.equal(refused.status, 409)
    assert.match(refused.text, /Your email domain has all the organizations it may create\./)
    assert.match(refused.text, /<h2>Request more organizations<\/h2>/)
  }
  assert.equal(await ownerDomainCount(domain), 2)
  // Another domain, and a subdomain, are counted on their own.
  const neighbour = await h.user({ email: address(`eu.${domain}`) })
  assert.equal((await create(neighbour, 'Neighbour')).status, 303)
})

test('at a public mail provider each address counts on its own, +tags included in it', async () => {
  const ada = await h.user({ email: address(PROVIDER, 'ada') })
  const grace = await h.user({ email: address(PROVIDER, 'grace') })
  await h.org(ada.client, 'Ada One')
  await h.org(ada.client, 'Ada Two')
  assert.equal((await create(ada, 'Ada Three')).status, 409)
  const page = await ada.client.get(h.url('auth', '/orgs/new'))
  assert.ok(page.text.includes(`You&#x27;ve created 2 organizations with ${ada.email}, the most allowed for one address at a public email provider (2).`))
  assert.match((await create(ada, 'Ada Three')).text, /Your email address has all the organizations it may create\./)

  // Others at the same provider aren't held back by Ada.
  await h.org(grace.client, 'Grace One')
  await h.org(grace.client, 'Grace Two')
  assert.equal(await ownerDomainCount(ada.email), 2)
  assert.equal(await ownerDomainCount(grace.email), 2)
  assert.equal(await ownerDomainCount(PROVIDER), 0, 'the provider as a whole is no owner domain')

  // A +tag address of Ada's is another account, but the same person's mailbox: it shares her count.
  const tagged = await h.user({ email: ada.email.replace('@', '+work@') })
  assert.equal((await create(tagged, 'Ada Tagged')).status, 409)
})

test('deleting an organization frees its place; an allowance raises the limit, or lowers it', async () => {
  const domain = 'freed-limit.test'
  const owner = await h.user({ email: address(domain) })
  const firstId = await h.org(owner.client, 'Freed One')
  await h.org(owner.client, 'Freed Two')
  assert.equal((await create(owner, 'Freed Three')).status, 409)
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${firstId}/delete`), { confirm: 'Freed One' })).status, 303)
  assert.equal((await create(owner, 'Freed Three')).status, 303, 'the deleted one no longer counts')
  assert.equal((await create(owner, 'Freed Four')).status, 409)

  await h.sql("INSERT INTO org_domain_allowances (owner_domain, max_orgs, note, created_at) VALUES (?1, 4, 'synthetic request', 1)", domain)
  assert.equal((await create(owner, 'Freed Four')).status, 303)
  assert.equal((await create(owner, 'Freed Five')).status, 303)
  const full = await create(owner, 'Freed Six')
  assert.equal(full.status, 409)
  assert.ok(full.text.includes(`have created 4 organizations, the most allowed for one email domain (4).`))
  assert.deepEqual(await orgAllowance(h.db, owner.email), { ownerDomain: domain, count: 4, max: 4 })

  // An allowance of 0 closes a domain, an address at a provider can have one of its own, and the column refuses nonsense.
  const closed = await h.user({ email: address('closed-limit.test') })
  await h.sql("INSERT INTO org_domain_allowances (owner_domain, max_orgs, created_at) VALUES ('closed-limit.test', 0, 1)")
  assert.equal((await create(closed, 'Never')).status, 409)
  const person = await h.user({ email: address(PROVIDER, 'allowed') })
  await h.sql('INSERT INTO org_domain_allowances (owner_domain, max_orgs, created_at) VALUES (?1, 3, 1)', person.email)
  for (const name of ['P One', 'P Two', 'P Three']) assert.equal((await create(person, name)).status, 303, name)
  assert.equal((await create(person, 'P Four')).status, 409)
  await assert.rejects(h.sql("INSERT INTO org_domain_allowances (owner_domain, max_orgs, created_at) VALUES ('x.test', 1001, 1)"), /CHECK/)
})

test('the count is inside the insert: concurrent creations never pass the limit', async () => {
  const domain = 'race-limit.test'
  const people = [await h.user({ email: address(domain) }), await h.user({ email: address(domain) })]
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => create(people[i % 2], `Race ${i}`)))
  assert.equal(results.filter((result) => result.status === 303).length, 2)
  assert.equal(results.filter((result) => result.status === 409).length, 6)
  assert.equal(await ownerDomainCount(domain), 2)
  // Every organization that exists has its owner, and nothing half-made is left behind.
  assert.equal((await h.sql(
    "SELECT COUNT(*) AS n FROM orgs o WHERE o.owner_domain = ?1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.role = 'OWNER')", domain,
  ))[0].n, 2)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM memberships WHERE org_id NOT IN (SELECT id FROM orgs)"))[0].n, 0)

  // The same through the data module: of two inserts that both saw room for one, only one lands.
  const other = await h.user({ email: address('race-module.test') })
  await h.org(other.client, 'Module One')
  assert.deepEqual(await orgAllowance(h.db, other.email), { ownerDomain: 'race-module.test', count: 1, max: 2 })
  const now = Date.now()
  const made = await Promise.all(['Module A', 'Module B'].map((name) => createOrg(h.db, { id: crypto.randomUUID(), name, userId: other.id, email: other.email, now })))
  assert.deepEqual(made.sort(), [false, true])
  assert.equal(await ownerDomainCount('race-module.test'), 2)
  assert.equal((await h.sql('SELECT orgs_created FROM users WHERE id = ?1', other.id))[0].orgs_created, 2, 'only what was created is recorded')
})

test('without ORG_REQUEST_EMAIL the page shows the limit and where to ask, and sends nothing', async () => {
  const owner = await h.user({ email: address('no-request.test') })
  await h.org(owner.client, 'No Request One')
  await h.org(owner.client, 'No Request Two')
  const page = await owner.client.get(h.url('auth', '/orgs/new'))
  assert.match(page.text, /<h2>Request more organizations<\/h2>/)
  assert.match(page.text, /To create more, contact Insulin Apps support: <a href="mailto:help@example\.test">help@example\.test<\/a>\./)
  assert.doesNotMatch(page.text, /action="\/orgs\/request"/)
  const posted = await owner.client.post(h.url('auth', '/orgs/request'), { name: 'Wanted', reason: 'Because.' })
  assert.equal(posted.status, 303)
  assert.equal(posted.location, h.url('auth', '/orgs/new'))
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM mail_log WHERE kind = 'org_request'"))[0].n, 0)
})

test('the request emails support once per post, with Reply-To, at most three a day; below the limit there is nothing to ask', async () => {
  const production = await startGateway({ mode: 'production', vars: { ORG_REQUEST_EMAIL: ' Support@Example.test ' } })
  try {
    const support = 'support@example.test'
    const domain = 'request-corp.test'
    const below = await production.user({ email: address(domain) })
    const early = await below.client.post(production.url('auth', '/orgs/request'), { name: 'Early', reason: 'Not yet at the limit.' })
    assert.equal(early.status, 303)
    assert.equal(early.location, production.url('auth', '/orgs/new'))

    const person = await production.user({ name: 'Rita Requester', email: address(domain, 'rita') })
    await production.org(below.client, 'Request One')
    await production.org(person.client, 'Request Two')
    const page = await person.client.get(production.url('auth', '/orgs/new'))
    assert.match(page.text, /To create more, ask Insulin Apps support below\./)
    assert.match(page.text, /<form [^>]*action="\/orgs\/request" method="post"/)
    assert.match(page.text, /<input [^>]*required="" maxLength="80" name="name"\/>/)
    assert.match(page.text, /<textarea(?=[^>]* name="reason")(?=[^>]* required="")(?=[^>]* maxLength="1000")[^>]*>/)

    const request = (fields) => person.client.post(production.url('auth', '/orgs/request'), fields)
    for (const [fields, problem] of [
      [{ name: '', reason: 'A reason.' }, /Enter a name for the organization\./],
      [{ name: 'x'.repeat(81), reason: 'A reason.' }, /Use at most 80 characters\./],
      [{ name: 'Wanted Org', reason: '   ' }, /Say why you need another organization\./],
      [{ name: 'Wanted Org', reason: 'r'.repeat(1001) }, /Use at most 1000 characters for the reason\./],
    ]) {
      const refused = await request(fields)
      assert.equal(refused.status, 400, JSON.stringify(fields).slice(0, 80))
      assert.match(refused.text, problem)
    }
    assert.equal((await production.sentMail()).filter((mail) => mail.to === support).length, 0, 'nothing sent for a refused form')

    const sent = await request({ name: 'Rita <Labs>', reason: 'A second team\nneeds its own workspace.' })
    assert.equal(sent.status, 303)
    assert.equal(sent.location, production.url('auth', '/orgs/new?notice=request-sent'))
    const after = await person.client.get(sent.location)
    assert.match(after.text, /We&#x27;ve sent your request to Insulin Apps support\. They&#x27;ll reply by email\./)
    const mails = (await production.sentMail()).filter((mail) => mail.to === support)
    assert.equal(mails.length, 1)
    const [mail] = mails
    assert.equal(mail.replyTo, person.email, 'support answers the requester directly')
    assert.deepEqual(mail.from, { email: 'no-reply@example.test', name: 'Insulin Apps' })
    assert.equal(mail.subject, `Request for more organizations on Insulin Apps: ${domain}`)
    for (const fact of ['Rita Requester', person.email, `Owner domain: ${domain}`, 'Organizations it has: 2 (limit 2)', 'Name wanted: Rita <Labs>',
      'Why: A second team needs its own workspace.', `allow-orgs.mjs --domain ${domain} --max <number> --remote`]) {
      assert.ok(mail.text.includes(fact), fact)
    }
    assert.ok(mail.html.includes('Rita &lt;Labs&gt;') && !mail.html.includes('<Labs>'), 'the HTML part escapes what the person typed')
    assert.ok(!production.logText().includes(person.email) && !production.logText().includes(support), 'logs carry ids, never an address')
    assert.match(production.logText(), new RegExp(`"event":"org_request_sent","user":"${person.id}"`))

    assert.equal((await request({ name: 'Again', reason: 'Second.' })).status, 303)
    assert.equal((await request({ name: 'Again', reason: 'Third.' })).status, 303)
    const capped = await request({ name: 'Again', reason: 'Fourth.' })
    assert.equal(capped.status, 429)
    assert.match(capped.text, /You&#x27;ve sent the most requests allowed for today\./)
    assert.equal((await production.sentMail()).filter((mail) => mail.to === support).length, 3)
    const [row] = await production.sql("SELECT COUNT(*) AS n FROM mail_log WHERE kind = 'org_request' AND user_id = ?1", person.id)
    assert.equal(row.n, 3)
  } finally {
    await production.close()
  }
})

test('migration 0007 gives existing organizations their creator\'s owner domain, and NULL when the creator is gone', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.WARN),
    workers: [{
      name: 'migration-check', modules: true, script: 'export default { fetch() { return new Response() } }',
      compatibilityDate: COMPATIBILITY_DATE, d1Databases: { DB: 'migration-check' },
    }],
  }))
  try {
    const db = await mf.getD1Database('DB')
    const files = (await readdir(join(gatewayDir, 'migrations'))).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
    const run = async (file) => {
      for (const statement of splitStatements(await readFile(join(gatewayDir, 'migrations', file), 'utf8'))) await db.prepare(statement).run()
    }
    for (const file of files.filter((name) => name < '0007')) await run(file)
    const users = [
      ['u1', 'ada@acme.test'], ['u2', 'Bob@ACME.test'], ['u3', `grace+work@${PROVIDER}`], ['u4', `alan@${PROVIDER}`], ['u5', 'anna@bücher.test'],
    ]
    for (const [id, email] of users) {
      await db.prepare('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1)').bind(id, email, id).run()
    }
    const orgs = [['o1', 'u1'], ['o2', 'u2'], ['o3', 'u3'], ['o4', 'u4'], ['o5', 'u5'], ['o6', null]]
    for (const [id, creator] of orgs) {
      await db.prepare('INSERT INTO orgs (id, name, created_by, created_at, updated_at) VALUES (?1, ?1, ?2, 1, 1)').bind(id, creator).run()
    }
    await db.prepare("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES ('h', 'invitation', 'o1', 1)").run()
    await run('0007_org_limits.sql')

    const { results } = await db.prepare('SELECT id, owner_domain, invite_verified_domains_only AS only FROM orgs ORDER BY id').all()
    assert.deepEqual(results, [
      { id: 'o1', owner_domain: 'acme.test', only: 0 },
      { id: 'o2', owner_domain: 'acme.test', only: 0 },
      { id: 'o3', owner_domain: `grace@${PROVIDER}`, only: 0 },
      { id: 'o4', owner_domain: `alan@${PROVIDER}`, only: 0 },
      { id: 'o5', owner_domain: 'bücher.test', only: 0 },
      { id: 'o6', owner_domain: null, only: 0 },
    ])
    assert.equal((await db.prepare('SELECT user_id FROM mail_log').first()).user_id, null, 'the mail log keeps its rows')
    // The gateway counts these the way it counts new ones: acme.test is full, and the non-ASCII domain written as typed
    // counts with its punycode form.
    assert.deepEqual(await orgAllowance(db, 'carol@acme.test'), { ownerDomain: 'acme.test', count: 2, max: 2 })
    assert.deepEqual(await orgAllowance(db, `grace@${PROVIDER}`), { ownerDomain: `grace@${PROVIDER}`, count: 1, max: 2 })
    assert.deepEqual(await orgAllowance(db, 'otto@bücher.test'), { ownerDomain: 'xn--bcher-kva.test', count: 1, max: 2 })
    assert.equal(await createOrg(db, { id: 'o7', name: 'o7', userId: 'u5', email: 'anna@bücher.test', now: 2 }), true)
    assert.equal(await createOrg(db, { id: 'o8', name: 'o8', userId: 'u5', email: 'anna@bücher.test', now: 2 }), false)
    assert.equal(await createOrg(db, { id: 'o9', name: 'o9', userId: 'u1', email: 'ada@acme.test', now: 2 }), false)
  } finally {
    await mf.dispose()
  }
})
