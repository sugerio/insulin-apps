// Template drafts on the Templates page (member/TemplatesPage.ts): the field editor's Save draft and Save, a draft's
// badge and Edit in the list where a ready template has Use, and the Status filter. In-process, against stubbed API
// answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, ORIGIN, json, renderMember, visibleText } from './helpers/member.ts';

const SESSION = 'a'.repeat(64), SAVED = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' };
const pdf = () => new File(['%PDF-1.7 synthetic'], 'synthetic.pdf', { type: 'application/pdf' });
const row = (status: 'draft' | 'active', id = SAVED, name = 'Reseller agreement') => ({ id, name, status, roles: ['partner'], fields: [], createdAt: 0, owner: OWNER, myRole: 'owner', tags: [] });

test('the field editor saves a draft and stays open, then saves it as ready; the default signers are set once', async () => {
  let templates: unknown[] = [];
  const app = await renderMember('/templates', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/templates?')) return json({ templates });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === '/api/template-editing-sessions' && c.method === 'POST') return json({ sessionId: SESSION, url: `${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}` }, 201);
    if (c.path === `/api/template-editing-sessions/${SESSION}/source`) return json({}, 201);
    if (c.path === `/api/template-editing-sessions/${SESSION}`) return json({ templateId: SAVED });
    if (c.path === `/api/templates/${SAVED}`) return json(row('draft'));
    if (c.path === `/api/templates/${SAVED}/default-signers`) return json({ id: SAVED });
  });
  const saveRequests = () => app.posted.filter((m: any) => m?.type === 'esign.editor.save') as { requestId: string; draft?: boolean }[];
  const reply = (requestId: string) => app.dispatch({ origin: ORIGIN, source: app.frameWindow, data: { type: 'esign.editor.saved', requestId, templateId: SAVED } });
  try {
    await app.click(app.button('New template'), 'New template');
    await app.act(async () => { app.byId('template-pdf').props.onChange({ target: { files: [pdf()] } }); });
    await app.type(app.byLabel('Role 1'), 'partner');
    await app.type(app.byId('role-0-email'), 'pat@partner.example');
    await app.click(app.button('Upload and place fields'), 'Place fields');
    assert.equal(app.button('Save draft').props.disabled, true, 'until the editor is ready');
    await app.dispatch({ origin: ORIGIN, source: app.frameWindow, data: { type: 'esign.editor.ready' } });
    // Save draft: the editor is asked for a draft, stays open, and the list shows it.
    await app.click(app.button('Save draft'), 'Save draft');
    assert.equal(saveRequests()[0]!.draft, true);
    templates = [row('draft')];
    await reply(saveRequests()[0]!.requestId);
    assert.match(app.text(), /Draft saved\. It can't be used to send envelopes until you save it as ready/);
    assert.equal(app.renderer.root.findAll((n: any) => n.type === 'iframe').length, 1, 'the editor stays open');
    assert.equal(app.calls.filter((c) => c.path === `/api/templates/${SAVED}/default-signers`).length, 1, 'default signers set at the first save');
    // Again as a draft: the default signers aren't set again.
    await app.click(app.button('Save draft'), 'Save draft again');
    await reply(saveRequests()[1]!.requestId);
    assert.equal(app.calls.filter((c) => c.path === `/api/templates/${SAVED}/default-signers`).length, 1);
    // Save: ready to use, and the editor closes.
    await app.click(app.button('Save'), 'Save');
    assert.equal(Object.hasOwn(saveRequests()[2]!, 'draft'), false, 'the save hosts have always sent');
    templates = [row('active')];
    await reply(saveRequests()[2]!.requestId);
    assert.match(app.text(), /Saved: the template is ready to use/);
    assert.equal(app.renderer.root.findAll((n: any) => n.type === 'iframe').length, 0, 'the editor closes');
  } finally { await app.unmount(); }
});

test('the list: a draft has a Draft badge and Edit, which opens its fields with Save draft and Save; a ready one has Use; Status filters', async () => {
  const DRAFT = row('draft', '33333333-3333-4333-8333-333333333333', 'NDA draft'), READY = row('active');
  const app = await renderMember('/templates', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/templates?')) return json({ templates: [DRAFT, READY] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === '/api/template-editing-sessions' && c.method === 'POST') return json({ sessionId: SESSION, url: `${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}` }, 201);
  });
  const rowOf = (name: string) => app.renderer.root.findAll((n: any) => n.type === 'tr' && visibleText(n.children).includes(name))[0];
  const actions = (name: string) => rowOf(name).findAll((n: any) => (n.type === 'button' || n.type === 'a') && visibleText(n.children).trim()).map((n: any) => visibleText(n.children).trim());
  try {
    assert.ok(app.calls.some((c) => c.path.startsWith('/api/templates?status=all&')), 'the page lists drafts too');
    assert.match(visibleText(rowOf('NDA draft').children), /Draft/);
    assert.ok(actions('NDA draft').includes('Edit') && !actions('NDA draft').includes('Use'));
    assert.ok(actions('Reseller agreement').includes('Use') && !visibleText(rowOf('Reseller agreement').children).includes('Draft'));
    // Edit opens the draft's fields, replacing it, with Save draft and Save.
    await app.click(rowOf('NDA draft').findAll((n: any) => n.type === 'button' && visibleText(n.children).trim() === 'Edit')[0], 'Edit');
    const session = app.calls.find((c) => c.path === '/api/template-editing-sessions')!;
    assert.deepEqual(JSON.parse(String(session.body)), { allowedParentOrigin: ORIGIN, sourceTemplateId: DRAFT.id, replace: true });
    assert.ok(app.button('Save draft') && app.button('Save'));
    assert.match(app.text(), /A draft: Save draft keeps your changes/);
    await app.click(app.button('Cancel'), 'Cancel');
    // A ready template's fields: Save only, a new version.
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Edit')[0], 'Edit');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'tab' && visibleText(n.children).trim() === 'Fields')[0], 'Fields');
    assert.equal(app.button('Save draft'), undefined);
    assert.ok(app.button('Save'));
    await app.click(app.button('Cancel'), 'Cancel');
    // Status: drafts only, as a chip.
    await app.click(app.byLabel('Status filter'), 'Status');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitemradio' && visibleText(n.children).trim() === 'Draft')[0], 'Draft');
    assert.ok(app.calls.some((c) => c.path.startsWith('/api/templates?status=draft&')));
    assert.ok(app.byLabel('Remove Status: Draft'));
  } finally { await app.unmount(); }
});
