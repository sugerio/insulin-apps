// How a signer reaches the signing page (invitations.ts): the host's signers only through the host,
// for the account signed in to it, which must have the signer's email; the signers Esign invites
// through the invitation it emails when their turn comes, which the sender can send again. And the
// sender's message, in the invitation and on the signing page. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { blobStore, identity, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import { mailRelay } from './helpers/mail-relay.ts';
import app from './helpers/gateway.ts';
import { auditTrail } from '../src/app/server/esign/audit.ts';
import { consentDisclosure } from '../src/app/server/esign/disclosure.ts';
import { identification } from '../src/app/server/esign/delivery-pdf.ts';
import { invitationEmail, parseDelivery, parseMessage } from '../src/app/server/esign/invitations.ts';

const ORIGIN = 'https://esign.example.test';
const KEY = 'i'.repeat(64);

async function setup(relayStatus: () => number = () => 202) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY))).toString('hex')).run();
  const relay = mailRelay(relayStatus);
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), TEST_MAIL: await blobStore(mf, 'test-mail'), OTP_KEY: 'invitation-pepper-at-least-32-bytes-long', TEST_SEAL_KEY: 'invitation-seal-key-at-least-32-bytes-long', COMPLETE_AFTER_SIGN: 'true', ...relay.env };
  const auth = { authorization: `Bearer ${KEY}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = await PDFDocument.create(); pdf.addPage();
  async function envelope(recipients: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const form = new FormData(); form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', JSON.stringify(recipients.map(r => r.role)));
    const template = await (await req('/api/templates', { method: 'POST', headers: auth, body: form })).json() as { id: string };
    const created = await req('/api/envelopes', json({ templateId: template.id, documentName: 'Mutual NDA', sender: { name: 'Dana Seller', organization: 'Pigment' }, recipients, ...extra }, { ...auth, 'idempotency-key': crypto.randomUUID() }));
    assert.equal(created.status, 201, await created.clone().text());
    const { id } = await created.json() as { id: string };
    assert.equal((await req(`/api/envelopes/${id}/prepare`, { method: 'POST', headers: auth })).status, 204);
    return id;
  }
  const read = async (id: string) => await (await req(`/api/envelopes/${id}`, { headers: auth })).json() as { message?: unknown; tasks: { id: string; recipientEmail: string; status: string; delivery: string; invitedAt?: string; message?: unknown }[] };
  /** Opens the page with a one-time code, confirms the emailed code, and returns the page's headers. */
  async function open(code: string) {
    const { token } = await (await req('/api/public/page-sessions/exchange', json({ code }, { origin: ORIGIN }))).json() as { token: string };
    const headers = { origin: ORIGIN, 'x-esign-session': token };
    const { messageId } = await (await req('/api/public/signing/otp', json({}, headers))).json() as { messageId: string };
    const { otp } = await (await req(`/api/test-mail/${messageId}`, { headers: auth })).json() as { otp: string };
    assert.equal((await req('/api/public/signing/otp/verify', json({ otp }, headers))).status, 204);
    return headers;
  }
  async function sign(headers: Record<string, string>) {
    const current = await (await req('/api/public/signing/current', { headers })).json() as { id: string; sha256: string };
    const signed = await req('/api/public/signing/sign', json({ artifactId: current.id, artifactHash: current.sha256, consent: true, disclosureVersion: (await consentDisclosure()).version }, headers));
    assert.equal(signed.status, 202, await signed.clone().text());
  }
  const invitations = () => relay.sent.filter(m => m.body.text.includes('/sign#invite='));
  const tokenOf = (text: string) => /#invite=([a-f0-9]{64})/.exec(text)?.[1] ?? '';
  return { mf, db, env, req, json, auth, envelope, read, open, sign, invitations, tokenOf, relay };
}

test('a message and a delivery parse strictly; the certificate says how the signer came', () => {
  assert.equal(parseMessage(undefined), null);
  assert.equal(parseMessage({ subject: ' ', body: '\n' }), null);
  assert.deepEqual(parseMessage({ subject: ' Please sign ', body: 'Hi Ana,\r\nThe NDA.\n' }), { subject: 'Please sign', body: 'Hi Ana,\nThe NDA.' });
  for (const bad of ['text', [], { subject: 'x'.repeat(101) }, { subject: 'two\nlines' }, { body: 'x'.repeat(10001) }, { body: 'bell\u0007' }, { subject: 1 }, { title: 'x' }]) assert.equal(parseMessage(bad), 'invalid', JSON.stringify(bad));
  assert.equal(parseDelivery(undefined), 'host');
  assert.equal(parseDelivery('email'), 'email');
  assert.equal(parseDelivery('sms'), 'invalid');
  assert.equal(identification({ entry: 'EMAIL_INVITATION' }), 'Email invitation link; email one-time code');
  assert.equal(identification({ signedInEmail: 'ana@partner.test' }), "signed in to the sender's system as ana@partner.test; email one-time code");
  assert.equal(identification({}), 'Email one-time code', 'a signature from before stays as it was');
  const mail = invitationEmail({ recipient_name: 'Ana', expires_at: null, documentName: 'Mutual NDA', senderName: 'Dana', senderOrganization: 'Pigment', message: null }, 'https://esign.example.test/sign#invite=x');
  assert.equal(mail.subject, 'Please sign: Mutual NDA');
  assert.match(mail.text, /Dana \(Pigment\) asks you to sign Mutual NDA\./);
});

test("the host opens only its own signers' pages, for the signed-in account with their email; Esign's console opens any", async () => {
  const h = await setup();
  try {
    const id = await h.envelope([{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test' }], { message: { subject: 'Your NDA', body: 'Hi Ana,\nPlease sign by Friday.' } });
    const envelope = await h.read(id), task = envelope.tasks[0];
    assert.equal(task.delivery, 'host');
    assert.deepEqual(envelope.message, { subject: 'Your NDA', body: 'Hi Ana,\nPlease sign by Friday.' });
    assert.equal(h.invitations().length, 0, 'Esign emails the host\'s signers nothing');
    const view = (body: Record<string, unknown>, headers: Record<string, string> = h.auth) => h.req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`, h.json({ origin: ORIGIN, ...body }, headers));
    assert.deepEqual([(await view({})).status, await (await view({})).json()], [422, { error: 'signed_in_email_required' }]);
    assert.deepEqual([(await view({ signedInEmail: 'marcus@seller.test' })).status, await (await view({ signedInEmail: 'marcus@seller.test' })).json()], [403, { error: 'signer_mismatch' }]);
    assert.deepEqual(await (await view({ signedInEmail: 'ana@partner.test', reason: 'x' })).json(), { error: 'unknown_field', fields: ['reason'] });
    const ok = await view({ signedInEmail: ' ANA@Partner.test ' });
    assert.equal(ok.status, 201, 'the same address, whatever its case');
    // A member in Esign's console opens it in person, without a signed-in account to check.
    assert.equal((await view({}, identity('tenant'))).status, 201);
    // The signer sees the sender's message on Review; the code check records the account Esign checked.
    const headers = await h.open((await ok.json() as { code: string }).code);
    const current = await (await h.req('/api/public/signing/current', { headers })).json() as { message?: unknown };
    assert.deepEqual(current.message, { subject: 'Your NDA', body: 'Hi Ana,\nPlease sign by Friday.' });
    const verified = (await auditTrail(h.db, id)).find(e => e.type === 'OTP_VERIFIED');
    assert.equal(verified?.detail?.signedInEmail, 'ana@partner.test');
    assert.equal((await h.req(`/api/envelopes/${id}/tasks/${task.id}/invitation`, { method: 'POST', headers: h.auth })).status, 409, 'nothing to resend to the host\'s signer');
  } finally { await h.mf.dispose(); }
});

test('Esign invites its signers in turn, by email, with the message; the link opens the page until replaced', async () => {
  const h = await setup();
  try {
    const id = await h.envelope([
      { role: 'partner', name: 'Ana Partner', email: 'ana@partner.test', delivery: 'email' },
      { role: 'seller', name: 'Marcus Seller', email: 'marcus@seller.test', delivery: 'email', message: { body: 'Countersign once Ana has.' } },
    ], { message: { subject: 'Please sign the Mutual NDA', body: 'Hi,\nThe NDA we discussed.' } });
    // The first signer only, at once.
    assert.equal(h.invitations().length, 1);
    const [first] = h.invitations();
    assert.equal(first.body.to, 'ana@partner.test');
    assert.equal(first.body.subject, 'Please sign the Mutual NDA');
    assert.match(first.body.text, /Dana Seller \(Pigment\) asks you to sign Mutual NDA\.\n\nHi,\nThe NDA we discussed\./);
    const [ana, marcus] = (await h.read(id)).tasks;
    assert.deepEqual([ana.delivery, typeof ana.invitedAt, marcus.invitedAt], ['email', 'string', undefined]);
    // The host can't open an invited signer's page.
    assert.deepEqual(await (await h.req(`/api/envelopes/${id}/tasks/${ana.id}/recipient-view`, h.json({ signedInEmail: 'ana@partner.test' }, h.auth))).json(), { error: 'recipient_signs_by_email' });
    const invite = (token: string) => h.req('/api/public/signing/invitation', h.json({ token }, { origin: ORIGIN }));
    assert.equal((await invite('0'.repeat(64))).status, 401);
    // Sent again: a new link, and the old one stops working.
    assert.equal((await h.req(`/api/envelopes/${id}/tasks/${ana.id}/invitation`, { method: 'POST', headers: h.auth })).status, 204);
    assert.equal(h.invitations().length, 2);
    assert.equal((await invite(h.tokenOf(first.body.text))).status, 401, 'the replaced link');
    const opened = await invite(h.tokenOf(h.invitations()[1].body.text));
    assert.equal(opened.status, 201);
    const headers = await h.open((await opened.json() as { code: string }).code);
    const trail = await auditTrail(h.db, id);
    assert.deepEqual(trail.filter(e => e.taskId === ana.id).map(e => e.type).slice(0, 5), ['INVITATION_SENT', 'INVITATION_SENT', 'INVITATION_OPENED', 'SIGNING_SESSION_OPENED', 'OTP_SENT']);
    assert.deepEqual(trail.find(e => e.type === 'OTP_VERIFIED')?.detail, { entry: 'EMAIL_INVITATION' });
    await h.sign(headers);
    // Ana signed: the link no longer opens anything, and it is Marcus's turn, with his own message.
    assert.equal((await invite(h.tokenOf(h.invitations()[1].body.text))).status, 401);
    assert.equal(h.invitations().length, 3);
    const third = h.invitations()[2];
    assert.equal(third.body.to, 'marcus@seller.test');
    assert.equal(third.body.subject, 'Please sign: Mutual NDA', 'his own message has no subject');
    assert.match(third.body.text, /Countersign once Ana has\./);
    assert.doesNotMatch(third.body.text, /The NDA we discussed/);
  } finally { await h.mf.dispose(); }
});

test('an invitation whose email failed is sent by due work, once', async () => {
  let status = 503;
  const h = await setup(() => status);
  try {
    const id = await h.envelope([{ role: 'partner', name: 'Ana Partner', email: 'ana@partner.test', delivery: 'email' }]);
    assert.equal((await h.read(id)).tasks[0].invitedAt, undefined, 'not sent');
    status = 202;
    // A reservation blocks a retry for a while; then due work sends it.
    await h.db.prepare('UPDATE invitations SET reserved_at=0').run();
    assert.equal((await h.req('/api/process-due', { method: 'POST', headers: h.auth })).status, 200);
    assert.equal(typeof (await h.read(id)).tasks[0].invitedAt, 'string');
    const sent = h.invitations().filter(m => m.body.to === 'ana@partner.test').length;
    assert.equal((await h.req('/api/process-due', { method: 'POST', headers: h.auth })).status, 200);
    assert.equal(h.invitations().filter(m => m.body.to === 'ana@partner.test').length, sent, 'sent once');
  } finally { await h.mf.dispose(); }
});

test('a delivery or message E-sign does not know is refused', async () => {
  const h = await setup();
  try {
    const form = new FormData(); form.set('file', new File([await (await PDFDocument.create().then(async p => { p.addPage(); return p; })).save()], 'synthetic.pdf', { type: 'application/pdf' })); form.set('roles', '["partner"]');
    const template = await (await h.req('/api/templates', { method: 'POST', headers: h.auth, body: form })).json() as { id: string };
    const send = (extra: Record<string, unknown>, recipient: Record<string, unknown> = {}) => h.req('/api/envelopes', h.json({ templateId: template.id, recipients: [{ role: 'partner', name: 'Ana', email: 'ana@partner.test', ...recipient }], ...extra }, { ...h.auth, 'idempotency-key': crypto.randomUUID() }));
    assert.equal((await send({}, { delivery: 'sms' })).status, 422);
    assert.deepEqual(await (await send({ message: { subject: 'x', cc: 'y' } })).json(), { error: 'unknown_field', fields: ['message.cc'] });
    assert.deepEqual(await (await send({}, { message: { title: 'x' } })).json(), { error: 'unknown_field', fields: ['recipients[].message.title'] });
    assert.equal((await send({ message: { subject: 'x'.repeat(101) } })).status, 422);
  } finally { await h.mf.dispose(); }
});
