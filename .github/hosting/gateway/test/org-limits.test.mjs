// How many organizations an owner domain may have (DESIGN.md §3.1): two by default, per registrable business domain
// (its subdomains included) or per person at a public mail provider (one Gmail mailbox in any form), counted inside
// the insert; operators' allowances; asking support for more, with its caps and the command it suggests; and the
// migrations that gave organizations their owner domain. The harness lets example.test have many, so these tests use
// their own domains.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { COMPATIBILITY_DATE, gatewayDir } from './helpers/bundle.mjs'
import { splitStatements, startGateway } from './helpers/harness.mjs'
import { canonicalAllowanceKey, createOrg, orgAllowance, reconcileOwnerDomains } from '../src/db/orgs.ts'
import { orgRequestMail } from '../src/mail/templates.ts'
import { PUBLIC_MAIL_DOMAINS, checkOwnerDomain, isPublicMailDomain, ownerDomainOf, subdomainPattern } from '../src/owner-domain.ts'

let h
before(async () => { h = await startGateway({ vars: { SUPPORT_EMAIL: 'help@example.test' } }) })
after(async () => { await h?.close() })

// Public mail providers. Their addresses are built here, never written out: they are synthetic, and only ever reach
// the capture table.
const PROVIDER = 'gmail.com'
const GOOGLEMAIL = 'googlemail.com'
const OTHER_PROVIDER = 'outlook.com'
const CO_UK = 'co.uk'
const REGIONAL = ['hotmail.co.uk', 'yahoo.co.uk', 'web.de', 'mail.ru', 'naver.com', 'comcast.net', 'protonmail.ch']
let counter = 0
function address(domain, prefix = 'person') {
  counter += 1
  return `${prefix}.${counter}@${domain}`
}

const create = (person, name) => person.client.post(h.url('auth', '/orgs/new'), { name })
const ownerDomainCount = async (domain) => (await h.sql('SELECT COUNT(*) AS n FROM orgs WHERE owner_domain = ?1', domain))[0].n

test('owner domains: the registrable domain in lower case and punycode, or a public provider\'s address without its +tag', () => {
  assert.equal(ownerDomainOf('ada@Acme.TEST'), 'acme.test')
  assert.equal(ownerDomainOf('anna@bücher.test'), 'xn--bcher-kva.test')
  assert.equal(ownerDomainOf(`Ada.Lovelace@${OTHER_PROVIDER}`), `ada.lovelace@${OTHER_PROVIDER}`, 'dots count elsewhere')
  assert.equal(ownerDomainOf(`ada+work@${OTHER_PROVIDER}`), `ada@${OTHER_PROVIDER}`)
  assert.equal(ownerDomainOf(`+odd@${PROVIDER}`), `+odd@${PROVIDER}`)

  // A subdomain counts as its registrable domain, by the Public Suffix List.
  assert.equal(ownerDomainOf('a@one.example.com'), 'example.com')
  assert.equal(ownerDomainOf(`a@two.example.${CO_UK}`), `example.${CO_UK}`)
  assert.equal(ownerDomainOf('a@deep.eu.Acme.test'), 'acme.test')
  assert.equal(ownerDomainOf('anna@eu.bücher.test'), 'xn--bcher-kva.test')
  assert.equal(ownerDomainOf('a@10.0.0.1'), '10.0.0.1', 'an IP address counts as itself')

  // Gmail ignores dots and answers at googlemail.com: one form for one mailbox.
  assert.equal(ownerDomainOf(`j.doe+x@${GOOGLEMAIL}`), `jdoe@${PROVIDER}`)
  assert.equal(ownerDomainOf(`J.Doe@${PROVIDER}`), `jdoe@${PROVIDER}`)

  // The providers: ours, and a maintained list with regional ones; the reserved example names are nobody's provider.
  for (const domain of [PROVIDER, GOOGLEMAIL, 'fastmail.com', 'tutanota.com', ...REGIONAL]) {
    assert.ok(PUBLIC_MAIL_DOMAINS.has(domain), domain)
    assert.equal(ownerDomainOf(`first.last+tag@${domain}`), domain === PROVIDER || domain === GOOGLEMAIL ? `firstlast@${PROVIDER}` : `first.last@${domain}`)
  }
  assert.ok(isPublicMailDomain(`mx.${REGIONAL[0]}`), 'a provider\'s subdomain too')
  for (const domain of ['example.com', 'example.org', 'example.net', 'acme.test']) assert.ok(!isPublicMailDomain(domain), domain)
  assert.ok([...PUBLIC_MAIL_DOMAINS].every((domain) => /^[a-z0-9.-]+$/.test(domain)), 'lower case and punycode')

  // Older rows count with their domain through a LIKE pattern, escaped; never for an address or a non-registrable name.
  assert.equal(subdomainPattern('example.com'), '%.example.com')
  assert.equal(subdomainPattern('a_b%c.test'), '%.a\\_b\\%c.test')
  for (const owned of [`ada@${OTHER_PROVIDER}`, 'co.uk', '10.0.0.1', 'eu.example.com']) assert.equal(subdomainPattern(owned), null, owned)
})

test('the strict owner-domain check that allow-orgs.mjs and the request to support apply', () => {
  assert.deepEqual(checkOwnerDomain(' Example.COM. '), { ownerDomain: 'example.com' })
  assert.deepEqual(checkOwnerDomain(`J.Doe@${GOOGLEMAIL}`), { ownerDomain: `jdoe@${PROVIDER}` })
  assert.deepEqual(checkOwnerDomain(`first.last@${REGIONAL[1]}`), { ownerDomain: `first.last@${REGIONAL[1]}` })
  for (const [input, problem] of [
    ['eu.example.com', /counts as its registrable domain example\.com/],
    [PROVIDER, /is a public mail provider/],
    ['co.uk', /public suffix/],
    ['ada@example.com', /isn't at a public mail provider: its owner domain is example\.com/],
    [`ada+x@${PROVIDER}`, /no \+tag/],
    [`o'brien@${PROVIDER}`, /no \+tag/],
    ['$(id).attacker.test', /must be a domain/],
    ["a'b.test", /must be a domain/],
  ]) {
    const checked = checkOwnerDomain(input)
    assert.ok('problem' in checked, input)
    assert.match(checked.problem, problem, input)
  }
})

test('the request to support names the owner domain in its command only when the check takes it as it is, quoted', () => {
  const mail = (ownerDomain) => orgRequestMail({
    name: 'Rita', email: 'rita@example.test', ownerDomain, count: 2, max: 2, wanted: 'More', reason: 'Because.', site: 'example.test',
  })
  const command = (domain) => `node .github/hosting/scripts/allow-orgs.mjs --domain ${domain} --max N --remote`
  let sent = mail('request-corp.test')
  assert.ok(sent.text.includes(command("'request-corp.test'")), sent.text)
  assert.ok(sent.html.includes(`<code>${command('&#x27;request-corp.test&#x27;')}</code>`) || sent.html.includes(`<code>${command('&#39;request-corp.test&#39;')}</code>`))
  assert.ok(!sent.text.includes('<number>') && !sent.text.includes('DOMAIN'))

  // An address whose domain someone wrote with a command substitution counts as the registrable domain after it.
  assert.equal(ownerDomainOf('x@$(id).attacker.test'), 'attacker.test')
  assert.ok(mail(ownerDomainOf('x@$(id).attacker.test')).text.includes(command("'attacker.test'")))
  // Anything the check refuses stays out of the command, to be checked by hand.
  for (const ownerDomain of [ownerDomainOf('x@$(id).test'), ownerDomainOf(`o'brien@${PROVIDER}`), ownerDomainOf("x@a'b.test"), `x$(id)@${PROVIDER}`]) {
    sent = mail(ownerDomain)
    assert.ok(sent.text.includes(command('DOMAIN')), ownerDomain)
    assert.match(sent.text, /in place of DOMAIN the owner domain after you check it by hand/)
    const line = sent.text.split('\n').find((text) => text.includes('allow-orgs.mjs'))
    assert.ok(!line.includes('$(') && !line.includes("'"), line)
  }
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
    assert.ok(page.text.includes(`People with an address at ${domain} or one of its subdomains have created 2 organizations, the most allowed for one email domain (2).`))
    assert.doesNotMatch(page.text, /action="\/orgs\/new"/, 'no create form')
    const refused = await create(person, 'One Too Many')
    assert.equal(refused.status, 409)
    assert.match(refused.text, /Your email domain has all the organizations it may create\./)
    assert.match(refused.text, /<h2>Request more organizations<\/h2>/)
  }
  assert.equal(await ownerDomainCount(domain), 2)
  // A subdomain counts as its domain; another domain counts on its own.
  const sub = await h.user({ email: address(`eu.${domain}`) })
  const refused = await create(sub, 'Subdomain')
  assert.equal(refused.status, 409)
  assert.ok(refused.text.includes(`People with an address at ${domain} or one of its subdomains have created 2 organizations`))
  const neighbour = await h.user({ email: address(`two-limit-neighbour.test`) })
  assert.equal((await create(neighbour, 'Neighbour')).status, 303)
})

test('a subdomain counts as its registrable domain, organizations recorded with a subdomain before included', async () => {
  const domain = 'sub-limit.test'
  const first = await h.user({ email: address(`one.${domain}`) })
  await h.org(first.client, 'Sub One')
  assert.equal(await ownerDomainCount(domain), 1, 'recorded as the registrable domain')
  // An organization the gateway recorded before migration 0009, with the creator's whole domain.
  await h.sql("INSERT INTO orgs (id, name, owner_domain, created_at, updated_at) VALUES (?1, 'Legacy Sub', ?2, 1, 1)", crypto.randomUUID(), `old.eu.${domain}`)
  const second = await h.user({ email: address(`two.${domain}`) })
  assert.deepEqual(await orgAllowance(h.db, second.email), { ownerDomain: domain, count: 2, max: 2 })
  assert.equal((await create(second, 'Sub Two')).status, 409)
  assert.equal((await create(await h.user({ email: address(domain) }), 'Sub Three')).status, 409)

  // The pattern is escaped: _ and % in a domain match only themselves, and a domain that merely ends the same way
  // (xunder_score.test) or an address isn't a subdomain.
  const underscored = 'under_score.test'
  for (const owner of ['eu.underxscore.test', 'eu.under%score.test', `x${underscored}`, `someone@eu.${underscored}`]) {
    await h.sql("INSERT INTO orgs (id, name, owner_domain, created_at, updated_at) VALUES (?1, 'Not Counted', ?2, 1, 1)", crypto.randomUUID(), owner)
  }
  assert.equal((await orgAllowance(h.db, address(underscored))).count, 0)
  await h.sql("INSERT INTO orgs (id, name, owner_domain, created_at, updated_at) VALUES (?1, 'Counted', ?2, 1, 1)", crypto.randomUUID(), `eu.${underscored}`)
  assert.equal((await orgAllowance(h.db, address(underscored))).count, 1)
})

test('one Gmail mailbox counts once: dots, +tags and googlemail.com included', async () => {
  counter += 1
  const dotted = await h.user({ email: `jo.doe.${counter}@${PROVIDER}` })
  const plain = await h.user({ email: `jodoe${counter}+work@${GOOGLEMAIL}` })
  await h.org(dotted.client, 'Gmail One')
  await h.org(plain.client, 'Gmail Two')
  assert.equal(await ownerDomainCount(`jodoe${counter}@${PROVIDER}`), 2)
  assert.equal((await create(dotted, 'Gmail Three')).status, 409)
  assert.equal((await create(plain, 'Gmail Three')).status, 409)
  // Elsewhere dots make another address: that provider doesn't ignore them.
  const dots = await h.user({ email: `jo.doe.${counter}@${OTHER_PROVIDER}` })
  const noDots = await h.user({ email: `jodoe${counter}@${OTHER_PROVIDER}` })
  await h.org(dots.client, 'Outlook One')
  await h.org(dots.client, 'Outlook Two')
  assert.equal((await create(noDots, 'Outlook Three')).status, 303)
})

test('at a public mail provider each address counts on its own, +tags included in it', async () => {
  const ada = await h.user({ email: address(OTHER_PROVIDER, 'ada') })
  const grace = await h.user({ email: address(OTHER_PROVIDER, 'grace') })
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
  assert.equal(await ownerDomainCount(OTHER_PROVIDER), 0, 'the provider as a whole is no owner domain')

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
  const person = await h.user({ email: address(OTHER_PROVIDER, 'allowed') })
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
      'Why: A second team needs its own workspace.', `allow-orgs.mjs --domain '${domain}' --max N --remote`]) {
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

test('requests are also capped at three a day per owner domain and fifty a day from everyone; the command quotes or leaves out the domain', async () => {
  const production = await startGateway({ mode: 'production', vars: { ORG_REQUEST_EMAIL: 'support@example.test' } })
  try {
    const support = 'support@example.test'
    const toSupport = async () => (await production.sentMail()).filter((mail) => mail.to === support)
    const atLimit = async (email) => {
      const person = await production.user({ email })
      await production.org(person.client, 'Capped One')
      await production.org(person.client, 'Capped Two')
      return person
    }
    const request = (person, reason = 'We need another.') => person.client.post(production.url('auth', '/orgs/request'), { name: 'Wanted', reason })
    const sharedCap = /Insulin Apps support can&#x27;t take more requests for more organizations today\. Please try again tomorrow\./

    // Three people at one domain (a subdomain among them) share its three requests a day, each with requests of their own left.
    const domain = 'shared-request.test'
    const [first, second] = [await atLimit(address(domain)), await production.user({ email: address(`eu.${domain}`) })]
    assert.equal((await request(first, 'One.')).status, 303)
    assert.equal((await request(first, 'Two.')).status, 303)
    assert.equal((await request(second, 'Three.')).status, 303)
    const refused = await request(second, 'Four.')
    assert.equal(refused.status, 429)
    assert.match(refused.text, sharedCap)
    assert.equal((await request(await production.user({ email: address(domain) }), 'Five.')).status, 429)
    assert.equal((await toSupport()).length, 3)
    const hashes = await production.sql("SELECT DISTINCT owner_domain_hash AS hash FROM mail_log WHERE kind = 'org_request'")
    assert.deepEqual(hashes.map((entry) => entry.hash), [createHash('sha256').update(domain).digest('hex')], 'the owner domain, hashed')

    // An address someone chose with a quote in it reaches support, but its owner domain stays out of the command.
    counter += 1
    const quoted = await atLimit(`o'neil.${counter}@${PROVIDER}`)
    assert.equal((await request(quoted)).status, 303)
    const quotedMail = (await toSupport()).at(-1)
    assert.ok(quotedMail.text.includes(`Owner domain: o'neil${counter}@${PROVIDER}`))
    assert.ok(quotedMail.text.includes('allow-orgs.mjs --domain DOMAIN --max N --remote'), quotedMail.text)
    assert.match(quotedMail.text, /check it by hand/)
    // A command substitution in the domain: the owner domain is the registrable domain after it, quoted.
    const substituted = await atLimit(`x.${counter}@$(id).attacker.test`)
    assert.equal((await request(substituted)).status, 303)
    const substitutedMail = (await toSupport()).at(-1)
    assert.ok(substitutedMail.text.includes("allow-orgs.mjs --domain 'attacker.test' --max N --remote"), substitutedMail.text)
    assert.ok(!substitutedMail.text.split('\n').find((line) => line.includes('allow-orgs.mjs')).includes('$('))

    // Fifty a day from everyone: the rest of today's are taken, so someone with requests of their own left is refused.
    const now = Date.now()
    const taken = (await production.sql("SELECT COUNT(*) AS n FROM mail_log WHERE kind = 'org_request'"))[0].n
    for (let i = taken; i < 50; i += 1) {
      await production.sql("INSERT INTO mail_log (recipient_hash, kind, user_id, owner_domain_hash, created_at) VALUES ('h', 'org_request', ?1, ?2, ?3)", `u${i}`, `d${i}`, now - 1000)
    }
    const late = await atLimit(address('late-request.test'))
    const full = await request(late)
    assert.equal(full.status, 429)
    assert.match(full.text, sharedCap)
    // A day later there is room again.
    await production.sql("UPDATE mail_log SET created_at = created_at - ?1 WHERE kind = 'org_request'", 24 * 60 * 60 * 1000)
    assert.equal((await request(late)).status, 303)
  } finally {
    await production.close()
  }
})

/** A database of its own with the migrations before `before` applied; `run` applies one more. */
async function migratedTo(before) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.WARN),
    workers: [{
      name: 'migration-check', modules: true, script: 'export default { fetch() { return new Response() } }',
      compatibilityDate: COMPATIBILITY_DATE, d1Databases: { DB: 'migration-check' },
    }],
  }))
  const db = await mf.getD1Database('DB')
  const files = (await readdir(join(gatewayDir, 'migrations'))).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  const run = async (file) => {
    for (const statement of splitStatements(await readFile(join(gatewayDir, 'migrations', file), 'utf8'))) await db.prepare(statement).run()
  }
  for (const file of files.filter((name) => name < before)) await run(file)
  return { mf, db, run }
}

test('migration 0007 gives existing organizations their creator\'s owner domain, and NULL when the creator is gone', async () => {
  const { mf, db, run } = await migratedTo('0007')
  try {
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

test('migration 0009 fills missing owner domains from the creator or the earliest owner, and writes Gmail addresses in one form', async () => {
  const { mf, db, run } = await migratedTo('0009')
  try {
    const users = [
      ['u1', 'ada@acme.test'], ['u2', `grace.hopper+work@${GOOGLEMAIL}`], ['u3', 'otto@eu.bücher.test'], ['u4', 'late@later-owner.test'],
      ['u5', 'carol@sub.acme.test'], ['u6', `alan+x@${OTHER_PROVIDER}`],
    ]
    for (const [id, email] of users) {
      await db.prepare('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1)').bind(id, email, id).run()
    }
    // o1, o2, o6 and o9: created by the Worker from before 0007 while it rolled out (no owner domain). o3: its creator's
    // account is gone; its earliest current OWNER decides (not the earlier ADMIN, nor the later OWNER). o4: nobody left.
    // o5 to o8: recorded by the gateway before this change.
    const orgs = [
      ['o1', 'u1', null], ['o2', 'u2', null], ['o3', null, null], ['o4', null, null], ['o5', null, `j.doe@${PROVIDER}`],
      ['o6', 'u6', null], ['o7', null, `j.d.oe@${GOOGLEMAIL}`], ['o8', null, `ada.l@${OTHER_PROVIDER}`], ['o9', 'u5', null], ['o10', null, 'acme.test'],
    ]
    for (const [id, creator, ownerDomain] of orgs) {
      await db.prepare('INSERT INTO orgs (id, name, created_by, owner_domain, created_at, updated_at) VALUES (?1, ?1, ?2, ?3, 1, 1)')
        .bind(id, creator, ownerDomain).run()
    }
    for (const [user, role, at] of [['u1', 'ADMIN', 1], ['u4', 'OWNER', 5], ['u3', 'OWNER', 3]]) {
      await db.prepare('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)').bind('o3', user, role, at).run()
    }
    for (const [ownerDomain, max] of [[`j.doe@${GOOGLEMAIL}`, 5], [`a.b@${PROVIDER}`, 3], [`ab@${PROVIDER}`, 4], ['acme.test', 6]]) {
      await db.prepare('INSERT INTO org_domain_allowances (owner_domain, max_orgs, created_at) VALUES (?1, ?2, 1)').bind(ownerDomain, max).run()
    }
    await run('0009_owner_domains.sql')

    const { results } = await db.prepare("SELECT id, owner_domain FROM orgs ORDER BY CAST(substr(id, 2) AS INTEGER)").all()
    assert.deepEqual(results.map((row) => [row.id, row.owner_domain]), [
      ['o1', 'acme.test'],
      ['o2', `gracehopper@${PROVIDER}`],
      ['o3', 'eu.bücher.test'],
      ['o4', null],
      ['o5', `jdoe@${PROVIDER}`],
      ['o6', `alan@${OTHER_PROVIDER}`],
      ['o7', `jdoe@${PROVIDER}`],
      ['o8', `ada.l@${OTHER_PROVIDER}`],
      ['o9', 'sub.acme.test'],
      ['o10', 'acme.test'],
    ])
    const allowances = (await db.prepare('SELECT owner_domain, max_orgs FROM org_domain_allowances ORDER BY owner_domain').all()).results
    assert.deepEqual(allowances.map((row) => [row.owner_domain, row.max_orgs]), [
      [`a.b@${PROVIDER}`, 3], [`ab@${PROVIDER}`, 4], ['acme.test', 6], [`jdoe@${PROVIDER}`, 5],
    ], 'moved to the Gmail form, unless that one existed already')
    await db.prepare("INSERT INTO mail_log (recipient_hash, kind, user_id, owner_domain_hash, created_at) VALUES ('h', 'org_request', 'u1', 'd', 1)").run()

    // The gateway counts these with the new ones: acme.test has its own two and its subdomain's, the Gmail mailbox
    // its two in any form, and the non-ASCII subdomain counts with its domain's punycode form.
    assert.deepEqual(await orgAllowance(db, 'dan@acme.test'), { ownerDomain: 'acme.test', count: 3, max: 6 })
    assert.deepEqual(await orgAllowance(db, `J.Doe+x@${GOOGLEMAIL}`), { ownerDomain: `jdoe@${PROVIDER}`, count: 2, max: 5 })
    assert.deepEqual(await orgAllowance(db, 'anna@bücher.test'), { ownerDomain: 'xn--bcher-kva.test', count: 1, max: 2 })
    assert.deepEqual(await orgAllowance(db, 'otto@eu.bücher.test'), { ownerDomain: 'xn--bcher-kva.test', count: 1, max: 2 })
    assert.equal(await createOrg(db, { id: 'o11', name: 'o11', userId: 'u3', email: 'otto@eu.bücher.test', now: 2 }), true)
    assert.equal(await createOrg(db, { id: 'o12', name: 'o12', userId: 'u3', email: 'otto@eu.bücher.test', now: 2 }), false)
    assert.equal((await db.prepare("SELECT owner_domain FROM orgs WHERE id = 'o11'").first()).owner_domain, 'xn--bcher-kva.test')
  } finally {
    await mf.dispose()
  }
})

test('the daily reconcile puts owner domains and allowance keys in the form the limit counts by', async () => {
  const now = Date.now()
  // Provider domains as constants, so no literal address of a real provider sits in the source (check-public-content).
  const regional = 'yahoo.co.uk'
  const googlemail = 'googlemail.com'
  const user = async (id, email) => h.sql('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', id, email, 'Reconcile Person', now)
  await user('11111111-1111-4111-8111-111111111111', `alice@${regional}`)
  await user('22222222-2222-4222-8222-222222222222', `j.doe+x@${googlemail}`)
  await user('33333333-3333-4333-8333-333333333333', 'bea@team.reconcile.test')
  const org = (id, by, domain) => h.sql('INSERT INTO orgs (id, name, created_by, owner_domain, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)', id, 'Reconcile Org', by, domain, now)
  // As migrations left them: the provider as a whole, a dotted Gmail address, and none at all (creator gone).
  await org('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', regional)
  await org('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222', `j.doe@${PROVIDER}`)
  await org('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', null, null)
  await h.sql("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '33333333-3333-4333-8333-333333333333', 'OWNER', ?1, ?1)", now)
  await h.sql("INSERT INTO org_domain_allowances (owner_domain, max_orgs, note, created_at) VALUES (?1, 7, 'old', 1), (?2, 3, NULL, 2), ('one.reconcile.test', 4, NULL, 3)", `j.doe@${PROVIDER}`, `jdoe@${PROVIDER}`)

  assert.equal(canonicalAllowanceKey(`J.Doe@${googlemail.toUpperCase()}`), `jdoe@${PROVIDER}`)
  assert.equal(canonicalAllowanceKey('one.reconcile.test'), 'reconcile.test')
  const changed = await reconcileOwnerDomains(h.db)
  assert.ok(changed.orgs >= 3 && changed.allowances >= 2, JSON.stringify(changed))
  const domains = Object.fromEntries((await h.sql("SELECT id, owner_domain FROM orgs WHERE id LIKE 'aaaaaaaa-%'")).map((row) => [row.id.slice(-1), row.owner_domain]))
  assert.deepEqual(domains, { 1: `alice@${regional}`, 2: `jdoe@${PROVIDER}`, 3: 'reconcile.test' }, 'counted by address at a provider, in the Gmail form, from the earliest owner')
  const allowances = Object.fromEntries((await h.sql("SELECT owner_domain, max_orgs, note FROM org_domain_allowances WHERE owner_domain LIKE ?1 OR owner_domain LIKE '%reconcile.test'", `%${PROVIDER}`)).map((row) => [row.owner_domain, [row.max_orgs, row.note]]))
  assert.deepEqual(allowances, { [`jdoe@${PROVIDER}`]: [7, 'old'], 'reconcile.test': [4, null] }, 'colliding allowances keep the larger number, and none is left behind')
  assert.deepEqual(await reconcileOwnerDomains(h.db), { orgs: 0, allowances: 0 }, 'a second run changes nothing')
})
