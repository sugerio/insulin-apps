// The organization's contacts (contacts.ts): every envelope adds or refreshes its signers, members add, change and
// delete them, and the list searches and pages. A contact is never evidence: changing or deleting one leaves the
// envelopes as they were sent. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

type Contact = { id: string; email: string; name: string; title?: string; company?: string; envelopeCount: number; lastUsedAt?: number; createdAt: number; updatedAt: number };

async function setup() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant'),('other')").run();
  const hash = async (key: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant'),(?,'other')").bind(await hash(KEY), await hash(OTHER)).run();
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts') };
  const as = (key: string) => ({ authorization: `Bearer ${key}` });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const post = (path: string, body: unknown, key = KEY) => req(path, { method: 'POST', headers: { ...as(key), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async <T>(path: string, key = KEY) => { const r = await req(path, { headers: as(key) }); assert.equal(r.status, 200, await r.clone().text()); return await r.json() as T; };
  const pdf = await PDFDocument.create(); pdf.addPage();
  async function envelope(recipients: Record<string, unknown>[], idempotencyKey: string = crypto.randomUUID()) {
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(recipients.map(r => r.role)));
    const template = await (await req('/api/templates', { method: 'POST', headers: as(KEY), body: form })).json() as { id: string };
    const send = () => req('/api/envelopes', { method: 'POST', headers: { ...as(KEY), 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify({ templateId: template.id, documentName: 'Mutual NDA', recipients }) });
    const created = await send();
    assert.equal(created.status, 201, await created.clone().text());
    return { id: (await created.json() as { id: string }).id, retry: send };
  }
  const list = (query = '', key = KEY) => get<{ contacts: Contact[]; next?: string }>(`/api/contacts${query}`, key);
  return { mf, db, req, post, get, envelope, list };
}

test('every envelope adds or refreshes its signers as contacts, once per send, in its own organization', async () => {
  const { mf, db, req, envelope, list, get } = await setup();
  try {
    assert.deepEqual((await list()).contacts, [], 'the address book starts empty');
    const first = await envelope([{ role: 'partner', name: 'Ana Example', email: 'Ana@Partner.example', title: 'Partner Manager', onBehalfOf: 'Partner Co' }, { role: 'seller', name: 'Marcus', email: 'marcus@seller.example' }]);
    const added = (await list()).contacts;
    assert.deepEqual(added.map(c => [c.name, c.email, c.title, c.company, c.envelopeCount]).sort(), [['Ana Example', 'Ana@Partner.example', 'Partner Manager', 'Partner Co', 1], ['Marcus', 'marcus@seller.example', undefined, undefined, 1]]);
    assert.ok(added.every(c => typeof c.lastUsedAt === 'number'));
    // A retry of the same send (the same Idempotency-Key) counts once.
    assert.equal((await first.retry()).status, 201);
    assert.deepEqual((await list()).contacts.map(c => c.envelopeCount), [1, 1]);
    // The same person again, by another spelling of their email: the same contact, with what the sender said last,
    // keeping a title and company this envelope leaves out. Named twice in one envelope, they count once.
    await envelope([{ role: 'a', name: 'Ana E.', email: 'ana@partner.EXAMPLE' }, { role: 'b', name: 'Ana Example', email: 'ana@partner.example' }]);
    const ana = (await list('?q=ana')).contacts;
    assert.equal(ana.length, 1);
    assert.deepEqual([ana[0].name, ana[0].email, ana[0].title, ana[0].company, ana[0].envelopeCount], ['Ana Example', 'ana@partner.example', 'Partner Manager', 'Partner Co', 2]);
    assert.equal((await list()).contacts[0].id, ana[0].id, 'the most recently used first');
    // Their page lists the envelopes that name them, newest first, each with their role and their task's status.
    const page = await get<Contact & { envelopes: { id: string; status: string; documentName?: string; role: string; taskStatus: string }[] }>(`/api/contacts/${ana[0].id}`);
    assert.equal(page.envelopes.length, 3, 'twice in the second envelope, once in the first');
    assert.deepEqual(page.envelopes.map(e => [e.id === first.id, e.documentName, e.status]), [[false, 'Mutual NDA', 'IN_PROGRESS'], [false, 'Mutual NDA', 'IN_PROGRESS'], [true, 'Mutual NDA', 'IN_PROGRESS']]);
    assert.deepEqual(page.envelopes.map(e => e.role).slice(0, 2).sort(), ['a', 'b']);
    // Another organization sees none of them, and can't open one.
    assert.deepEqual((await list('', OTHER)).contacts, []);
    assert.equal((await req(`/api/contacts/${ana[0].id}`, { headers: { authorization: `Bearer ${OTHER}` } })).status, 404);
    // An envelope that fails to be created adds nobody.
    const before = (await db.prepare('SELECT count(*) AS n FROM contacts').first<{ n: number }>())!.n;
    const refused = await req('/api/envelopes', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'idempotency-key': 'missing-template' }, body: JSON.stringify({ templateId: 'missing', recipients: [{ role: 'x', name: 'Nobody', email: 'nobody@example.com' }] }) });
    assert.equal(refused.status, 404);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM contacts').first<{ n: number }>())!.n, before);
  } finally { await mf.dispose(); }
});

test('members add, change and delete contacts; envelopes keep what they were sent with', async () => {
  const { mf, req, post, get, envelope, list } = await setup();
  try {
    const created = await post('/api/contacts', { email: 'lee@buyer.example', name: 'Lee Buyer', title: 'CFO' });
    assert.equal(created.status, 201);
    const lee = await created.json() as Contact;
    assert.deepEqual([lee.name, lee.email, lee.title, lee.company, lee.envelopeCount, lee.lastUsedAt], ['Lee Buyer', 'lee@buyer.example', 'CFO', undefined, 0, undefined]);
    // The same email again changes that contact (200); a title left out is kept, '' clears the company.
    const again = await post('/api/contacts', { email: 'LEE@buyer.example', name: 'Lee B.', company: 'Buyer Inc' });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json().then(c => { const v = c as Contact; return [v.id, v.name, v.email, v.title, v.company]; }), [lee.id, 'Lee B.', 'LEE@buyer.example', 'CFO', 'Buyer Inc']);
    const changed = await post(`/api/contacts/${lee.id}`, { name: 'Lee Buyer', company: '' });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json().then(c => { const v = c as Contact; return [v.name, v.title, v.company]; }), ['Lee Buyer', 'CFO', undefined]);
    // What is refused: an unknown field (the email can't be changed), a bad email, an empty name, a stranger's id.
    assert.equal((await post(`/api/contacts/${lee.id}`, { email: 'other@buyer.example' })).status, 422);
    assert.equal((await post('/api/contacts', { email: 'not-an-email', name: 'X' })).status, 422);
    assert.equal((await post('/api/contacts', { email: 'x@example.com', name: '  ' })).status, 422);
    assert.equal((await post('/api/contacts', { email: 'x@example.com', name: 'X', title: 'T'.repeat(129) })).status, 422);
    assert.equal((await post(`/api/contacts/${lee.id}`, { name: 'Stranger' }, OTHER)).status, 404);
    // An envelope names them: the envelope keeps its name for them, whatever the contact becomes.
    const sent = await envelope([{ role: 'buyer', name: 'Lee Buyer', email: 'lee@buyer.example' }]);
    await post(`/api/contacts/${lee.id}`, { name: 'Someone Else' });
    const read = await get<{ tasks: { recipientName: string; recipientEmail: string }[] }>(`/api/envelopes/${sent.id}`);
    assert.deepEqual(read.tasks.map(t => [t.recipientName, t.recipientEmail]), [['Lee Buyer', 'lee@buyer.example']]);
    // Deleting the contact leaves the envelope; the next envelope that names them adds them again.
    assert.equal((await post(`/api/contacts/${lee.id}/delete`, {}, OTHER)).status, 404, 'not another organization\'s');
    const deleted = await post(`/api/contacts/${lee.id}/delete`, {});
    assert.equal(deleted.status, 200);
    assert.equal((await post(`/api/contacts/${lee.id}/delete`, {})).status, 404);
    assert.equal((await req(`/api/envelopes/${sent.id}`, { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
    assert.deepEqual((await list()).contacts, []);
    await envelope([{ role: 'buyer', name: 'Lee Buyer', email: 'lee@buyer.example' }]);
    assert.deepEqual((await list()).contacts.map(c => [c.name, c.envelopeCount]), [['Lee Buyer', 1]]);
  } finally { await mf.dispose(); }
});

test('the list searches names and emails, and pages by a cursor without skipping or repeating', async () => {
  const { mf, db, req, list } = await setup();
  try {
    // Twelve contacts, four of them used at the same moment (the cursor breaks the tie by id).
    const rows = Array.from({ length: 12 }, (_, i) => [crypto.randomUUID(), `person${i}@example.com`, i < 6 ? `Person ${i}` : `Partner_${i}%`, i < 4 ? 1000 : 1000 + i]);
    for (const [id, email, name, at] of rows) await db.prepare("INSERT INTO contacts (id,tenant_id,email,email_key,name,envelope_count,recent_at,created_at,updated_at) VALUES (?,'tenant',?,?,?,0,?,?,?)").bind(id, email, email, name, at, at, at).run();
    const seen: string[] = [];
    let cursor = '';
    for (let pages = 0; pages < 10; pages++) {
      const page = await list(`?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.contacts.map(c => c.id));
      if (!page.next) break;
      cursor = page.next;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    assert.equal(seen[0], rows[11][0], 'the most recent first');
    // `%` and `_` are matched as themselves; the search ignores case.
    assert.equal((await list('?q=PERSON%25')).contacts.length, 0, 'no name has PERSON then a %');
    assert.deepEqual((await list('?q=PERSON%201')).contacts.map(c => c.name), ['Person 1']);
    assert.deepEqual((await list('?q=_1')).contacts.map(c => c.name).sort(), ['Partner_10%', 'Partner_11%']);
    assert.equal((await list('?q=%25')).contacts.length, 6);
    assert.deepEqual((await list('?q=person3@')).contacts.map(c => c.email), ['person3@example.com']);
    for (const bad of ['?limit=0', '?limit=101', `?q=${'x'.repeat(101)}`, '?cursor=nope']) assert.equal((await req(`/api/contacts${bad}`, { headers: { authorization: `Bearer ${KEY}` } })).status, 400, bad);
  } finally { await mf.dispose(); }
});

test('a contact\'s page lists every envelope that names them, those from before they were added too, through the email index', async () => {
  const { mf, db, envelope, list, get } = await setup();
  try {
    await envelope([{ role: 'a', name: 'Kim', email: 'kim@partner.example' }]);
    await db.prepare('DELETE FROM contacts').run();
    await envelope([{ role: 'a', name: 'Kim', email: 'KIM@partner.example' }]);
    const [kim] = (await list()).contacts;
    assert.equal(kim.envelopeCount, 1, 'counted since they were (re)added');
    const page = await get<{ envelopes: unknown[] }>(`/api/contacts/${kim.id}`);
    assert.equal(page.envelopes.length, 2, 'listed, whatever the spelling of the email');
    const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM tasks t WHERE lower(t.recipient_email) = ?').bind('kim@partner.example').all<{ detail: string }>();
    assert.ok(plan.results.some(r => r.detail.includes('tasks_by_recipient_email')), JSON.stringify(plan.results));
  } finally { await mf.dispose(); }
});
