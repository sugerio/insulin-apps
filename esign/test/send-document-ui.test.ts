// Upload and send in the members' pages (member/SendDocumentPage.ts): the document and its signers with their roles,
// the fields in the field editor (Save draft, Next), the review and Send; a draft opened again; the Envelopes page's way
// in and its drafts' Edit. In-process, against stubbed API answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, ORIGIN, json, renderMember, visibleText } from './helpers/member.ts';
import { checkSigners } from '../src/app/member/SendDocumentPage.ts';

const ID = '55555555-5555-4555-8555-555555555555', SESSION = 'c'.repeat(64);
const OWNER = { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' };
const pdf = () => new File(['%PDF-1.7 synthetic'], 'Reseller agreement.pdf', { type: 'application/pdf' });

test('signers need a role of letters, digits, - and _, once each, a name and an email', () => {
  const ok = { role: 'partner', name: 'Pat', email: 'pat@partner.example', title: '', company: '' };
  assert.equal(checkSigners([ok, { ...ok, role: 'seller', email: 'sam@seller.example' }]), '');
  assert.equal(checkSigners([]), 'Add a signer.');
  assert.match(checkSigners([{ ...ok, role: 'the partner' }]), /Signer 1: give a role/);
  assert.match(checkSigners([{ ...ok, name: ' ' }]), /Signer 1: enter their name/);
  assert.match(checkSigners([{ ...ok, email: 'pat@' }]), /Signer 1: enter their email/);
  assert.equal(checkSigners([ok, { ...ok, role: 'Partner' }]), 'Give each signer a different role.');
});

test('upload and send: the document and signers, the fields in the editor, the review, and Send', async () => {
  let fields: { role: string; type: string }[] = [], status = 'DRAFT';
  const app = await renderMember('/envelopes/send', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === '/api/envelopes' && c.method === 'POST') return json({ id: ID, status: 'DRAFT' }, 201);
    if (c.path === `/api/envelopes/${ID}/document`) return json({ id: ID, pages: 1 }, 201);
    if (c.path === `/api/envelopes/${ID}` && c.method === 'POST') { if (!JSON.parse(String(c.body)).draft) status = 'IN_PROGRESS'; return json({ id: ID, status }); }
    if (c.path === `/api/envelopes/${ID}`) return json({ id: ID, templateId: null, status, tasks: [], ...(status === 'DRAFT' ? { upload: { document: true, roles: ['partner', 'seller'], fields } } : {}), owner: OWNER, myRole: 'owner', tags: [] });
    if (c.path === '/api/template-editing-sessions' && c.method === 'POST') return json({ sessionId: SESSION, url: `${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}` }, 201);
    if (c.path.startsWith(`/api/envelopes/${ID}/`)) return json(c.path.endsWith('/audit') ? { events: [] } : { id: ID, myRole: 'owner', owner: OWNER, shares: [] });
  });
  const posts = (path: string) => app.calls.filter((c) => c.method === 'POST' && c.path === path);
  const saves = () => app.posted.filter((m: any) => m?.type === 'esign.editor.save') as { requestId: string; draft?: boolean }[];
  const reply = (requestId: string) => app.dispatch({ origin: ORIGIN, source: app.frameWindow, data: { type: 'esign.editor.saved', requestId, templateId: ID } });
  try {
    assert.equal(app.byLabel('Steps').children.length, 3);
    // Step 1: a PDF and checked signers first.
    await app.click(app.button('Next: place fields'), 'Next');
    assert.match(app.text(), /Choose the PDF to send/);
    await app.act(async () => { app.byId('send-pdf').props.onChange({ target: { files: [pdf()] } }); });
    assert.equal(app.byId('send-doc-name').props.value, 'Reseller agreement', 'named after the file');
    await app.type(app.byId('send-0-role'), 'the partner');
    await app.type(app.byId('send-0-name'), 'Pat Partner');
    await app.type(app.byId('send-0-email'), 'pat@partner.example');
    await app.click(app.button('Next: place fields'), 'Next');
    assert.match(app.text(), /Signer 1: give a role/);
    await app.type(app.byId('send-0-role'), 'partner');
    await app.click(app.button('Add signer'), 'Add signer');
    await app.type(app.byId('send-1-role'), 'seller');
    await app.type(app.byId('send-1-name'), 'Sam Seller');
    await app.type(app.byId('send-1-email'), 'sam@seller.example');
    await app.click(app.button('Next: place fields'), 'Next');
    // Saved as a draft with no template, its PDF uploaded, the editor opened on it.
    const created = JSON.parse(String(posts('/api/envelopes')[0]!.body));
    assert.equal(created.draft, true);
    assert.equal(Object.hasOwn(created, 'templateId'), false);
    assert.deepEqual(created.recipients.map((r: { role: string; name: string; delivery: string }) => [r.role, r.name, r.delivery]), [['partner', 'Pat Partner', 'email'], ['seller', 'Sam Seller', 'email']]);
    assert.equal(posts(`/api/envelopes/${ID}/document`)[0]!.headers['content-type'], 'application/pdf');
    assert.deepEqual(JSON.parse(String(posts('/api/template-editing-sessions')[0]!.body)), { allowedParentOrigin: ORIGIN, envelopeId: ID });
    assert.equal(`${app.location.pathname}${app.location.search}`, `/envelopes/send?draft=${ID}`);
    assert.ok(app.renderer.root.find((n: any) => n.type === 'iframe' && n.props.title === 'Signature field editor'));
    // Step 2: Save draft asks the editor for a draft; Next for the fields, ready.
    await app.dispatch({ origin: ORIGIN, source: app.frameWindow, data: { type: 'esign.editor.ready' } });
    await app.click(app.button('Save draft'), 'Save draft');
    assert.equal(saves()[0]!.draft, true);
    fields = [{ role: 'partner', type: 'Signature' }];
    await reply(saves()[0]!.requestId);
    assert.match(app.text(), /Draft saved, with the fields placed so far/);
    await app.click(app.button('Next: review'), 'Next');
    assert.equal(Object.hasOwn(saves()[1]!, 'draft'), false);
    fields = [{ role: 'partner', type: 'Signature' }, { role: 'partner', type: 'Date signed' }, { role: 'seller', type: 'Signature' }];
    await reply(saves()[1]!.requestId);
    // Step 3: the review, then Send: the draft itself.
    const review = visibleText(app.byLabel('Review').children);
    assert.match(review, /1\. partner — Pat Partner \(pat@partner\.example\): 2 fields/);
    assert.match(review, /2\. seller — Sam Seller \(sam@seller\.example\): 1 field/);
    await app.click(app.button('Send for signature'), 'Send');
    const sent = JSON.parse(String(posts(`/api/envelopes/${ID}`).at(-1)!.body));
    assert.equal(sent.draft, undefined);
    assert.equal(Object.hasOwn(sent, 'templateId'), false);
    assert.equal(app.location.pathname, `/envelopes/${ID}`, app.text().slice(0, 400));
  } finally { await app.unmount(); }
});

test('a draft opens again where it was; the Envelopes page leads to Upload and send, and a draft of one to it', async () => {
  const draft = { recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example', delivery: 'email' }], documentName: 'Reseller agreement', message: { subject: 'Please sign' } };
  const app = await renderMember(`/envelopes/send?draft=${ID}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === `/api/envelopes/${ID}`) return json({ id: ID, templateId: null, status: 'DRAFT', tasks: [], draft, upload: { document: true, roles: ['partner'], fields: [] }, owner: OWNER, myRole: 'owner', tags: [] });
  });
  try {
    assert.equal(app.byId('send-0-role').props.value, 'partner');
    assert.equal(app.byId('send-0-email').props.value, 'pat@partner.example');
    assert.equal(app.byId('send-doc-name').props.value, 'Reseller agreement');
    assert.equal(app.byId('send-subject').props.value, 'Please sign');
    assert.match(app.text(), /PDF \(uploaded; choose another to replace it\)/);
  } finally { await app.unmount(); }
  const list = await renderMember('/envelopes?status=draft', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path.startsWith('/api/envelopes?')) return json({ envelopes: [{ id: ID, templateId: null, status: 'DRAFT', createdAt: 0, documentName: 'Reseller agreement', signers: [], progress: { signed: 0, total: 1 }, owner: OWNER, myRole: 'owner', tags: [] }] });
  });
  try {
    assert.equal(list.link('Upload and send').props.href, '/envelopes/send');
    assert.equal(list.link('Edit').props.href, `/envelopes/send?draft=${ID}`);
  } finally { await list.unmount(); }
});
