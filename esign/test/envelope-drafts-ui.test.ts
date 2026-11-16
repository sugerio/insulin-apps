// Envelope drafts in the members' pages (member/NewEnvelopePage.ts, EnvelopesPage.ts, EnvelopePage.ts): Save draft
// keeps the form as it is and the page becomes the draft's; opening a draft fills the form in again; sending it sends
// that envelope. The list shows drafts under Status: Draft, with Edit and Discard. In-process, against stubbed API
// answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, VIEWER, json, renderMember, visibleText } from './helpers/member.ts';
import { envelopeRequest, formFromRequest } from '../src/app/member/api.ts';

const TEMPLATE = { id: 'tpl-1', name: 'Reseller agreement', status: 'active', roles: ['partner', 'seller'], fields: [], createdAt: 0, owner: { id: 'u1', kind: 'person', name: 'Sam Example' }, myRole: 'owner', tags: [] };
const DRAFT_ID = '44444444-4444-4444-8444-444444444444';
const OWNER = { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' };

test('the form\'s request comes back as the form: what a draft keeps is what was typed', () => {
  const signers = [
    { name: 'Pat Partner', email: 'pat@', title: 'CFO', company: 'Partner Inc', after: 'Step one\nStep two', delivery: 'email' as const, subject: 'For you', body: 'Hello Pat' },
    { name: '', email: '', title: '', company: '', after: '', delivery: 'email' as const, subject: '', body: '' },
  ];
  const doc = { name: 'Reseller agreement', version: 'v3', published: '2026-11-01', senderName: 'Sam Example', senderCompany: 'Example Co' };
  const request = { ...envelopeRequest('tpl-1', ['partner', 'seller'], signers, doc, '2026-12-01', { subject: '', body: '' }), tags: ['q4'] };
  const form = formFromRequest(JSON.parse(JSON.stringify(request)), ['partner', 'seller']);
  assert.deepEqual(form.signers, signers);
  assert.deepEqual(form.doc, doc);
  assert.equal(form.signBy, '2026-12-01');
  assert.equal(form.perSigner, true);
  assert.deepEqual(form.tags, ['q4']);
  const everyone = formFromRequest(envelopeRequest('tpl-1', ['partner'], [{ ...signers[1]!, subject: '', body: '' }], doc, '', { subject: 'Please sign', body: 'Thanks' }), ['partner']);
  assert.deepEqual([everyone.perSigner, everyone.note, everyone.signBy], [false, { subject: 'Please sign', body: 'Thanks' }, '']);
  assert.deepEqual(formFromRequest({}, ['partner']).signers[0]!.name, '', 'a request without them leaves them empty');
});

test('Save draft saves the form unfinished, the page becomes the draft\'s, saves again in place, and Send sends it', async () => {
  const app = await renderMember('/envelopes/new?template=tpl-1', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === '/api/templates' || c.path.startsWith('/api/templates?')) return json({ templates: [TEMPLATE] });
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === '/api/envelopes' && c.method === 'POST') return json({ id: DRAFT_ID, status: 'DRAFT' }, 201);
    if (c.path === `/api/envelopes/${DRAFT_ID}` && c.method === 'POST') return json({ id: DRAFT_ID, status: JSON.parse(String(c.body)).draft ? 'DRAFT' : 'IN_PROGRESS' });
    if (c.path === `/api/envelopes/${DRAFT_ID}`) return json({ id: DRAFT_ID, templateId: 'tpl-1', status: 'IN_PROGRESS', tasks: [], owner: OWNER, myRole: 'owner', tags: [] });
    if (c.path.startsWith(`/api/envelopes/${DRAFT_ID}/`)) return json(c.path.endsWith('/audit') ? { events: [] } : { id: DRAFT_ID, myRole: 'owner', owner: OWNER, shares: [] });
  });
  const posts = () => app.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/envelopes'));
  try {
    await app.type(app.byId('signer-0-name'), 'Pat Partner');
    await app.click(app.button('Save draft'), 'Save draft');
    const first = posts()[0]!;
    assert.equal(first.path, '/api/envelopes');
    assert.ok(first.headers['idempotency-key'], 'a new draft, by its key');
    const saved = JSON.parse(String(first.body));
    assert.equal(saved.draft, true);
    assert.deepEqual(saved.recipients.map((r: { name: string; email: string }) => [r.name, r.email]), [['Pat Partner', ''], ['', '']], 'unfinished, as typed');
    assert.equal(`${app.location.pathname}${app.location.search}`, `/envelopes/new?draft=${DRAFT_ID}`, 'the page is the draft\'s now');
    assert.match(app.text(), /Draft saved\. Nobody is asked to sign until you send it/);
    assert.match(app.text(), /Draft envelope/);
    // Again: in place.
    await app.type(app.byId('signer-0-email'), 'pat@partner.example');
    await app.click(app.button('Save draft'), 'Save draft again');
    assert.deepEqual([posts()[1]!.path, JSON.parse(String(posts()[1]!.body)).draft], [`/api/envelopes/${DRAFT_ID}`, true]);
    // Send: the draft itself, checked as any envelope.
    await app.type(app.byId('signer-1-name'), 'Sam Seller');
    await app.type(app.byId('signer-1-email'), 'sam@seller.example');
    await app.click(app.button('Send for signature'), 'Send');
    const sent = posts()[2]!;
    assert.equal(sent.path, `/api/envelopes/${DRAFT_ID}`);
    assert.equal(sent.headers['idempotency-key'], undefined);
    assert.equal(JSON.parse(String(sent.body)).draft, undefined);
    assert.equal(app.location.pathname, `/envelopes/${DRAFT_ID}`);
  } finally { await app.unmount(); }
});

test('a draft opens in the form again, filled in as saved; its envelope page sends its editors there', async () => {
  const request = { ...envelopeRequest('tpl-1', ['partner', 'seller'], [
    { name: 'Pat Partner', email: 'pat@partner.example', title: '', company: '', after: '', delivery: 'email', subject: '', body: '' },
    { name: '', email: '', title: '', company: '', after: '', delivery: 'email', subject: '', body: '' },
  ], { name: 'Reseller agreement', version: '', published: '', senderName: '', senderCompany: '' }, '', { subject: 'Please sign', body: 'Thanks' }), tags: ['q4'] };
  const draft = { id: DRAFT_ID, templateId: 'tpl-1', status: 'DRAFT', documentName: 'Reseller agreement', tasks: [], draft: request, owner: OWNER, myRole: 'owner', tags: ['q4'] };
  const routes = (me = EDITOR) => (c: { path: string }) => {
    if (c.path === '/api/me') return json(me);
    if (c.path === '/api/templates' || c.path.startsWith('/api/templates?')) return json({ templates: [TEMPLATE] });
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === `/api/envelopes/${DRAFT_ID}`) return json(draft);
    if (c.path === `/api/envelopes/${DRAFT_ID}/audit`) return json({ events: [] });
    if (c.path === `/api/envelopes/${DRAFT_ID}/shares`) return json({ id: DRAFT_ID, myRole: 'viewer', owner: OWNER, shares: [] });
  };
  const app = await renderMember(`/envelopes/${DRAFT_ID}`, routes());
  try {
    assert.equal(`${app.location.pathname}${app.location.search}`, `/envelopes/new?draft=${DRAFT_ID}`, 'its editors finish it in the form');
    await app.settle();
    assert.equal(app.byId('envelope-template').props.value, 'tpl-1');
    assert.equal(app.byId('signer-0-email').props.value, 'pat@partner.example');
    assert.equal(app.byId('signer-1-name').props.value, '');
    assert.equal(app.byId('doc-name').props.value, 'Reseller agreement');
    assert.equal(app.byId('message-subject').props.value, 'Please sign');
    assert.match(app.text(), /q4/);
  } finally { await app.unmount(); }
  // Someone who may only view it sees it on its page, not yet sent.
  const viewer = await renderMember(`/envelopes/${DRAFT_ID}`, routes(VIEWER));
  try {
    assert.equal(viewer.location.pathname, `/envelopes/${DRAFT_ID}`);
    assert.match(viewer.text(), /Draft/);
  } finally { await viewer.unmount(); }
});

test('the list: Status Draft shows drafts, each with Edit and Discard, which asks first', async () => {
  const draft = { id: DRAFT_ID, templateId: 'tpl-1', status: 'DRAFT', createdAt: 0, documentName: 'Reseller agreement', signers: [{ role: 'partner', name: 'Pat Partner', email: 'pat@', status: 'DRAFT' }], progress: { signed: 0, total: 2 }, owner: OWNER, myRole: 'owner', tags: [] };
  let listed = [draft];
  const app = await renderMember('/envelopes?status=draft', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/envelopes?')) return json({ envelopes: listed });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === `/api/envelopes/${DRAFT_ID}/void`) { listed = []; return json({ id: DRAFT_ID, status: 'DISCARDED' }); }
  });
  try {
    assert.equal(new URL(app.calls.find((c) => c.path.startsWith('/api/envelopes?'))!.path, 'https://x.test').searchParams.get('status'), 'DRAFT');
    assert.ok(app.byLabel('Remove Status: Draft'), 'as a chip');
    const edit = app.link('Edit');
    assert.equal(edit.props.href, `/envelopes/new?draft=${DRAFT_ID}`);
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    assert.deepEqual(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem').map((n: any) => visibleText(n.children).trim()), ['View', 'Discard', 'Tags', 'Share']);
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Discard')[0], 'Discard');
    assert.ok(app.byLabel('Discard draft'), 'asks first');
    assert.equal(app.calls.some((c) => c.path.endsWith('/void')), false);
    await app.click(app.button('Discard draft'), 'Discard draft');
    assert.ok(app.calls.some((c) => c.path === `/api/envelopes/${DRAFT_ID}/void` && c.method === 'POST'));
    assert.match(app.text(), /The draft Reseller agreement is discarded/);
  } finally { await app.unmount(); }
});
