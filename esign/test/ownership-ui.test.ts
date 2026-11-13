// The members' pages for ownership (member/SharePanel.ts, TagsField.ts, ListFilters.ts, OwnershipPage.ts): who sees a
// template and sharing it, the member's own tags and filtering by them, and the Ownership page's API clients and
// owners. In-process, against stubbed API answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, json, me, renderMember, visibleText } from './helpers/member.ts';

const TEMPLATE = { id: 'tpl-1', name: 'Mutual NDA', roles: ['partner'], fields: [], createdAt: Date.parse('2026-11-07T00:00:00Z'), owner: { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' }, myRole: 'owner', tags: ['NDA'] };
const OWNER = me('OWNER', ['esign.manage', 'esign.view']);
/** Opens a row's ⋯ menu and chooses an item. */
async function choose(app: Awaited<ReturnType<typeof renderMember>>, row: string, item: string) {
  await app.click(app.byLabel(`More for ${row}`), 'the row\'s menu');
  await app.click(app.renderer.root.findAll((n: any) => n.type === 'button' && n.props.role === 'menuitem' && visibleText(n.children).trim() === item)[0], item);
}

test('a template\'s menu: its owner shares it by email and role, and tags it; the list filters by scope and tag', async () => {
  let shares: { email: string; role: string; sharedAt: number }[] = [];
  const app = await renderMember('/templates', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/templates?') || c.path === '/api/templates') return json({ templates: [TEMPLATE] });
    if (c.path === '/api/templates/tpl-1/shares' && c.method === 'POST') { const body = JSON.parse(String(c.body)); shares = [{ ...body, sharedAt: 1 }]; return json({ id: 'tpl-1', myRole: 'owner', owner: TEMPLATE.owner, shares }); }
    if (c.path === '/api/templates/tpl-1/shares') return json({ id: 'tpl-1', myRole: 'owner', owner: TEMPLATE.owner, shares });
    if (c.path === '/api/templates/tpl-1/tags') return json({ id: 'tpl-1', tags: JSON.parse(String(c.body)).tags });
    if (c.path.startsWith('/api/members?')) return json({ members: [{ id: 'u2', email: 'bo@example.com', name: 'Bo Example' }] });
  });
  try {
    assert.match(app.text(), /You/, 'the owner column names the member');
    assert.match(app.text(), /NDA/, 'their tags');
    assert.equal(app.button('Sharing'), undefined, 'sharing is in the row\'s menu');
    await choose(app, 'Mutual NDA', 'Share');
    assert.ok(app.byLabel('Who sees the template'), 'sharing opens in a dialog over the list');
    assert.match(app.text(), /Not shared with anyone else/);
    await app.type(app.byId('templates-tpl-1-share-email'), 'bo');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.['aria-label'] === 'Choose Bo Example (bo@example.com)')[0], 'suggestion');
    await app.type(app.byId('templates-tpl-1-share-role'), 'editor');
    await app.click(app.button('Share'), 'Share');
    const shared = app.calls.find((c) => c.path === '/api/templates/tpl-1/shares' && c.method === 'POST')!;
    assert.deepEqual(JSON.parse(String(shared.body)), { email: 'bo@example.com', role: 'editor' });
    assert.match(app.text(), /Shared with bo@example.com as editor/);
    await app.click(app.button('Close'), 'Close');
    assert.equal(app.byLabel('Who sees the template'), undefined, 'and closes');
    // Tags: removing one saves the member's tags at once.
    await choose(app, 'Mutual NDA', 'Tags');
    await app.click(app.byLabel('Remove tag NDA'), 'remove tag');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/templates/tpl-1/tags')!.body)), { tags: [] });
    await app.click(app.button('Done'), 'Done');
    // Filters: shared with me, with two tags.
    await app.type(app.byId('templates-scope'), 'shared');
    await app.settle();
    await app.type(app.byId('templates-tags'), 'nda, Partners');
    await app.keyDown(app.byId('templates-tags'), 'Enter');
    assert.ok(app.calls.some((c) => c.path === '/api/templates?scope=shared&tag=nda&tag=Partners'), app.calls.map((c) => c.path).join('\n'));
  } finally { await app.unmount(); }
});

test('a template\'s menu: Edit renames it and changes its default signers, or opens its fields as a new version; Delete asks first; shared with you shows', async () => {
  const shared = { ...TEMPLATE, id: 'tpl-2', name: 'Reseller agreement', owner: { id: 'u9', kind: 'person', name: 'Bo Example' }, myRole: 'viewer', tags: [] };
  const SESSION = 'e'.repeat(64);
  const app = await renderMember('/templates', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === '/api/templates') return json({ templates: [TEMPLATE, shared] });
    if (c.path === '/api/templates/tpl-1' && c.method === 'POST') return json({ id: 'tpl-1', name: 'Mutual NDA v2' });
    if (c.path === '/api/templates/tpl-1/default-signers') return json({ id: 'tpl-1', defaultSigners: {} });
    if (c.path === '/api/templates/tpl-1/delete') return json({ id: 'tpl-1', deleted: true });
    if (c.path === '/api/template-editing-sessions' && c.method === 'POST') return json({ sessionId: SESSION, url: `https://esign.example.test/editor/page/${SESSION}#${'f'.repeat(64)}` }, 201);
  });
  try {
    assert.match(app.text(), /Shared with you · Viewer/, 'what someone shared with the member says so');
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    assert.deepEqual(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem').map((n: any) => visibleText(n.children).trim()), ['Tags'], 'a viewer neither edits, shares nor deletes');
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    // Edit › Details: the name and the default signers, saved together.
    await choose(app, 'Mutual NDA', 'Edit');
    assert.ok(app.byLabel('Edit template'));
    assert.equal(app.byId('edit-template-name').props.value, 'Mutual NDA');
    await app.type(app.byId('edit-template-name'), 'Mutual NDA v2');
    await app.type(app.byId('edit-0-email'), 'pat@partner.example');
    await app.click(app.button('Save'), 'Save');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/templates/tpl-1' && c.method === 'POST')!.body)), { name: 'Mutual NDA v2' });
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/templates/tpl-1/default-signers')!.body)), { defaultSigners: { partner: { email: 'pat@partner.example' } } });
    assert.match(app.text(), /Mutual NDA v2 is saved/);
    // Edit › Fields: the editor, on a new version that replaces it.
    await choose(app, 'Mutual NDA', 'Edit');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'tab' && visibleText(n.children).trim() === 'Fields')[0], 'Fields');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/template-editing-sessions')!.body)), { allowedParentOrigin: 'https://esign.example.test', sourceTemplateId: 'tpl-1', replace: true });
    assert.ok(app.renderer.root.findAll((n: any) => n.type === 'iframe').length === 1, 'the editor opens in the dialog');
    await app.click(app.button('Cancel'), 'Cancel');
    // Delete asks first.
    await choose(app, 'Mutual NDA', 'Delete');
    assert.ok(app.byLabel('Delete template'));
    assert.equal(app.calls.some((c) => c.path.endsWith('/delete')), false);
    await app.click(app.button('Delete template'), 'confirm');
    assert.ok(app.calls.some((c) => c.path === '/api/templates/tpl-1/delete' && c.method === 'POST'));
    assert.match(app.text(), /is deleted\. Envelopes already sent from it are kept/);
  } finally { await app.unmount(); }
});

test('the Ownership page: an API client is given a person, existing documents too; an organization owner takes over someone\'s', async () => {
  let clients: unknown[] = [{ id: 'sa-1', name: 'Host product', firstSeenAt: 1, lastSeenAt: 2 }];
  const app = await renderMember('/ownership', (c) => {
    if (c.path === '/api/me') return json(OWNER);
    if (c.path === '/api/api-clients') return json({ clients });
    if (c.path === '/api/api-clients/sa-1') { clients = [{ id: 'sa-1', name: 'Host product', firstSeenAt: 1, lastSeenAt: 2, shareWith: { email: 'sam@example.com', name: 'Sam Example', since: 3 } }]; return json({ id: 'sa-1', shareWith: { email: 'sam@example.com' }, shared: 4 }); }
    if (c.path === '/api/owners') return json({ owners: [{ id: 'u9', kind: 'person', name: 'Lee Left', email: 'lee@example.com', templates: 2, envelopes: 3 }, { id: 'sa-1', kind: 'client', name: 'Host product', templates: 1, envelopes: 0 }] });
    if (c.path === '/api/owners/u9/transfer') return json({ from: 'u9', to: 'u1', templates: 2, envelopes: 3 });
  });
  try {
    assert.match(app.text(), /Nobody: only the client sees what it creates/);
    await app.click(app.button('Choose someone'), 'Choose someone');
    assert.equal(app.byId('client-sa-1-share').props.value, 'sam@example.com', 'the member is suggested first');
    await app.click(app.button('Save'), 'Save');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/api-clients/sa-1')!.body)), { shareEmail: 'sam@example.com', shareExisting: true });
    assert.match(app.text(), /4 it created before were shared too/);
    assert.match(app.text(), /Lee Left/);
    await app.click(app.button('Take over'), 'Take over');
    await app.click(app.button('Take over all of it'), 'confirm');
    assert.match(app.text(), /You now own 2 templates and 3 envelopes that were Lee Left's/);
  } finally { await app.unmount(); }
  // An editor is told the page isn't theirs, and asks nothing.
  const editor = await renderMember('/ownership', (c) => c.path === '/api/me' ? json(EDITOR) : undefined);
  try { assert.match(editor.text(), /Only your organization's owners and admins manage ownership/); } finally { await editor.unmount(); }
});
