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

test('signers need a role of English letters, digits, hyphens and underscores, once each, a name and an email', () => {
  const ok = { role: 'partner', name: 'Pat', email: 'pat@partner.example', title: '', company: '' };
  assert.equal(checkSigners([ok, { ...ok, role: 'seller', email: 'sam@seller.example' }]), '');
  assert.equal(checkSigners([]), 'Add a signer.');
  assert.equal(checkSigners([{ ...ok, role: 'co-signer_2' }]), '');
  assert.match(checkSigners([{ ...ok, role: 'the partner' }]), /Signer 1: give a role of English letters, digits, hyphens \(-\) and underscores \(_\), with no spaces/);
  // A dash that only looks like a hyphen (en dash, full-width hyphen) is not one.
  for (const role of ['co\u2013signer', 'co\uFF0Dsigner']) assert.match(checkSigners([{ ...ok, role }]), /Signer 1: give a role/);
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
    assert.match(app.text(), /English letters, digits, hyphens \(-\) and underscores \(_\), with no spaces, such as co-signer\./, 'the role hint names the hyphen');
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
    // A long name or address with no space wraps inside the review on a phone instead of widening the page.
    assert.match(String(app.byLabel('Review').props.className), /\[&>dd\]:min-w-0/);
    assert.match(String(app.byLabel('Review').props.className), /\[&>dd\]:wrap-anywhere/);
    await app.click(app.button('Send for signature'), 'Send');
    const sent = JSON.parse(String(posts(`/api/envelopes/${ID}`).at(-1)!.body));
    assert.equal(sent.draft, undefined);
    assert.equal(Object.hasOwn(sent, 'templateId'), false);
    assert.equal(app.location.pathname, `/envelopes/${ID}`, app.text().slice(0, 400));
  } finally { await app.unmount(); }
});

test('a signer\'s contact suggestions open only while the field has the focus: an answer after the focus moved on, or after Escape, leaves them closed', async () => {
  // The contacts answer when the test says, as a slow network would.
  const waiting: ((response: Response) => void)[] = [];
  const CONTACT = { id: 'c1', name: 'Signer One', email: 'signer1@partner.example', title: '', company: '' };
  const app = await renderMember('/envelopes/send', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/contacts?')) return new Promise<Response>((resolve) => waiting.push(resolve)) as unknown as Response;
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
  });
  const answer = async () => { for (const resolve of waiting.splice(0)) resolve(json({ contacts: [CONTACT] })); await app.settle(); };
  const name = () => app.byId('send-0-name');
  const shown = () => [name().props['aria-expanded'], Boolean(app.byLabel('Contacts matching name'))];
  try {
    // Answered while the field still has the focus: the suggestions open.
    await app.type(name(), 'Si'); await answer();
    assert.deepEqual(shown(), [true, true], 'open while typing');
    // Typed on, then the focus moves to Email before the answer comes: the list stays closed (it would cover the form).
    await app.type(name(), 'Sig');
    await app.act(async () => { name().props.onBlur(); });
    assert.deepEqual(shown(), [false, false], 'closed on leaving the field');
    await answer();
    assert.deepEqual(shown(), [false, false], 'and an answer after the focus moved on leaves it closed');
    // Escape before the answer comes: closed too, and Escape is left to the page (nothing open to close).
    await app.type(name(), 'Sign');
    let prevented = false;
    await app.act(async () => { name().props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } }); });
    await answer();
    assert.deepEqual(shown(), [false, false], 'an answer after Escape leaves it closed');
    assert.equal(prevented, false);
    // Typing again asks again, and opens them.
    await app.type(name(), 'Signe'); await answer();
    assert.deepEqual(shown(), [true, true], 'open again on typing');
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
    assert.equal(list.link('Continue').props.href, `/envelopes/send?draft=${ID}`);
    await list.click(list.byLabel('New envelope'), 'New envelope');
    await list.click(list.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Upload and send')[0], 'Upload and send');
    assert.equal(list.location.pathname, '/envelopes/send');
  } finally { await list.unmount(); }
});

test('save as template: from an uploaded envelope\'s page, its roles renamed; also when it is sent; and in the list\'s menu for uploaded ones only', async () => {
  const TEMPLATE = '66666666-6666-4666-8666-666666666666';
  const envelope = { id: ID, templateId: null, status: 'IN_PROGRESS', documentName: 'Reseller agreement', tasks: [
    { id: 't1', role: 'partner', recipientName: 'Pat Partner', recipientEmail: 'pat@partner.example', routingOrder: 1, status: 'ACTIVE' },
    { id: 't2', role: 'seller', recipientName: 'Sam Seller', recipientEmail: 'sam@seller.example', routingOrder: 2, status: 'PENDING' }], owner: OWNER, myRole: 'owner', tags: [] };
  const routes = (one: Record<string, unknown>) => (c: { path: string; method: string }) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === '/api/templates' && c.method === 'POST') return json({ id: TEMPLATE, name: 'Reseller template' }, 201);
    if (c.path === `/api/envelopes/${ID}`) return json(one);
    if (c.path === `/api/envelopes/${ID}/audit`) return json({ events: [] });
    if (c.path === `/api/envelopes/${ID}/shares`) return json({ id: ID, myRole: 'owner', owner: OWNER, shares: [] });
    if (c.path.startsWith('/api/envelopes?')) return json({ envelopes: [{ ...one, signers: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example', status: 'ACTIVE' }], progress: { signed: 0, total: 1 }, createdAt: 0 }] });
  };
  const page = await renderMember(`/envelopes/${ID}`, routes(envelope));
  try {
    await page.click(page.button('Save as template'), 'Save as template');
    assert.ok(page.byLabel('Save as template'), 'a dialog');
    assert.equal(page.byId('save-template-name').props.value, 'Reseller agreement');
    assert.deepEqual([page.byId('save-template-role-0').props.value, page.byId('save-template-role-1').props.value], ['partner', 'seller']);
    await page.type(page.byId('save-template-name'), 'Reseller template');
    await page.type(page.byId('save-template-role-0'), 'customer');
    await page.act(async () => { page.byId('save-template-signers').props.onChange({ target: { checked: true } }); });
    const dialog = () => page.renderer.root.find((n: any) => n.props?.role === 'dialog');
    await page.click(dialog().findAll((n: any) => n.type === 'button' && visibleText(n.children).trim() === 'Save as template')[0], 'Save');
    assert.deepEqual(JSON.parse(String(page.calls.find((c) => c.path === '/api/templates')!.body)), { fromEnvelope: ID, name: 'Reseller template', roles: ['customer', 'seller'], defaultSigners: true });
    assert.match(visibleText(dialog().children), /Saved as the template\s+Reseller template/);
  } finally { await page.unmount(); }
  // After Upload and send with "Also save as a template": said on the envelope's page.
  const after = await renderMember(`/envelopes/${ID}?savedAsTemplate=${TEMPLATE}`, routes(envelope));
  try { assert.equal(after.link('template').props.href, `/templates/${TEMPLATE}`); } finally { await after.unmount(); }
  // Sent from a template: nothing to save; the list's menu has it for uploaded ones only.
  const fromTemplate = await renderMember(`/envelopes/${ID}`, routes({ ...envelope, templateId: 'tpl-1' }));
  try { assert.equal(fromTemplate.button('Save as template'), undefined); } finally { await fromTemplate.unmount(); }
  const list = await renderMember('/envelopes', routes(envelope));
  try {
    await list.click(list.byLabel('More for Reseller agreement'), 'menu');
    assert.ok(list.renderer.root.findAll((n: any) => n.props?.role === 'menuitem').map((n: any) => visibleText(n.children).trim()).includes('Save as template'));
  } finally { await list.unmount(); }
});

test('Upload and send: "Also save as a template" saves one once sent, and the envelope\'s page says so', async () => {
  let status = 'DRAFT';
  const app = await renderMember(`/envelopes/send?draft=${ID}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === '/api/templates' && c.method === 'POST') return json({ id: '77777777-7777-4777-8777-777777777777' }, 201);
    if (c.path === `/api/envelopes/${ID}/document`) return json({ id: ID, pages: 1 }, 201);
    if (c.path === '/api/template-editing-sessions' && c.method === 'POST') return json({ sessionId: SESSION, url: `${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}` }, 201);
    if (c.path === `/api/envelopes/${ID}` && c.method === 'POST') { if (!JSON.parse(String(c.body)).draft) status = 'IN_PROGRESS'; return json({ id: ID, status }); }
    if (c.path === `/api/envelopes/${ID}`) return json({ id: ID, templateId: null, status, tasks: [], draft: { recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example' }], documentName: 'Reseller agreement' }, upload: { document: true, roles: ['partner'], fields: [{ role: 'partner', type: 'Signature' }] }, owner: OWNER, myRole: 'owner', tags: [] });
    if (c.path.startsWith(`/api/envelopes/${ID}/`)) return json(c.path.endsWith('/audit') ? { events: [] } : { id: ID, myRole: 'owner', owner: OWNER, shares: [] });
  });
  try {
    await app.click(app.button('Next: place fields'), 'Next');
    await app.dispatch({ origin: ORIGIN, source: app.frameWindow, data: { type: 'esign.editor.ready' } });
    await app.click(app.button('Next: review'), 'Next');
    const request = app.posted.filter((m: any) => m?.type === 'esign.editor.save')[0] as { requestId: string };
    await app.dispatch({ origin: ORIGIN, source: app.frameWindow, data: { type: 'esign.editor.saved', requestId: request.requestId, templateId: ID } });
    await app.act(async () => { app.byId('send-also-template').props.onChange({ target: { checked: true } }); });
    await app.click(app.button('Send for signature'), 'Send');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/templates')!.body)), { fromEnvelope: ID, name: 'Reseller agreement' });
    assert.equal(`${app.location.pathname}${app.location.search}`, `/envelopes/${ID}?savedAsTemplate=77777777-7777-4777-8777-777777777777`);
  } finally { await app.unmount(); }
});

test('a PDF Esign prepared says what changed, where it is chosen; a PDF it can\'t prepare says why and what to do', async () => {
  const draft = { recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example', delivery: 'email' }], documentName: 'Reseller agreement' };
  const app = await renderMember(`/envelopes/send?draft=${ID}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === `/api/envelopes/${ID}/document`) return json({ error: 'unsupported_pdf', reason: 'pdf_annotation_without_appearance', page: 3 }, 422);
    if (c.path === `/api/envelopes/${ID}` && c.method === 'POST') return json({ id: ID, status: 'DRAFT' });
    if (c.path === `/api/envelopes/${ID}`) return json({ id: ID, templateId: null, status: 'DRAFT', tasks: [], draft, upload: { document: true, changes: { formFields: 2, annotations: 0, links: 1, pages: 1 }, roles: ['partner'], fields: [] }, owner: OWNER, myRole: 'owner', tags: [] });
  });
  try {
    assert.match(app.text(), /Esign prepared this PDF for signing: 2 form fields flattened into the page: the values stay, they can't be edited; 1 link removed: the text stays, it no longer opens anything; 1 page redrawn upright, at the size shown \(it was rotated or cropped\)\. Signers see and sign it as it is now/);
    // Another PDF chosen: the notice was about the one before.
    await app.act(async () => { app.byId('send-pdf').props.onChange({ target: { files: [pdf()] } }); });
    assert.doesNotMatch(app.text(), /Esign prepared this PDF/);
    await app.click(app.button('Next: place fields'), 'Next');
    assert.match(app.text(), /A comment or mark on page 3 doesn't say how it looks, so Esign can't flatten it as you see it\. Remove it, or open it, print it to PDF \(Save as PDF\), and upload the new file\./);
  } finally { await app.unmount(); }
});
