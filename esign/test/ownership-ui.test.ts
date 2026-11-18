// The members' pages for ownership (member/SharePanel.ts, TagsField.ts, ListFilters.ts, OwnershipPage.ts): who sees a
// template and sharing it, the member's own tags and filtering by them, and the Ownership page's
// owners, and an API client's page. In-process, against stubbed API answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, json, me, renderMember, visibleText } from './helpers/member.ts';

const TEMPLATE = { id: 'tpl-1', name: 'Mutual NDA', roles: ['partner'], fields: [], createdAt: Date.parse('2026-11-07T00:00:00Z'), owner: { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' }, myRole: 'owner', tags: ['NDA'] };
// As /api/me says it behind the gateway: an Admin in Esign, and an owner of the organization (x-suger-org-role).
const OWNER = me('ADMIN', ['esign.manage', 'esign.view'], { orgRole: 'OWNER' });
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
    if (c.path.startsWith('/api/tags?')) return json({ tags: [{ tag: 'NDA', uses: 1 }] });
  });
  try {
    assert.match(app.text(), /You/, 'the owner column names the member');
    assert.match(app.text(), /NDA/, 'their tags');
    assert.equal(app.button('Sharing'), undefined, 'sharing is in the row\'s menu');
    await choose(app, 'Mutual NDA', 'Share');
    assert.ok(app.byLabel('Who sees the template'), 'sharing opens in a dialog over the list');
    assert.match(app.text(), /Not shared with anyone by email/);
    assert.match(app.text(), /Only its owner and the people it is shared with see it/);
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
    assert.match(app.text(), /Only you see them\. Tags, above the list, filters it by them\./, 'names the filter as the list shows it');
    await app.click(app.byLabel('Remove tag NDA'), 'remove tag');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/templates/tpl-1/tags')!.body)), { tags: [] });
    await app.click(app.button('Done'), 'Done');
    // Filters: shared with me, with two tags.
    await app.click(app.byLabel('Owner filter'), 'Owner');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitemradio' && visibleText(n.children).trim() === 'Shared with me')[0], 'shared');
    await app.click(app.byLabel('Tags filter'), 'Tags');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitemcheckbox' && visibleText(n.children).trim() === 'NDA')[0], 'NDA');
    assert.ok(app.calls.some((c) => c.path === '/api/templates?status=all&scope=shared&tag=NDA&limit=25'), app.calls.map((c) => c.path).join('\n'));
    assert.ok(app.byLabel('Remove Owner: Shared with me') && app.byLabel('Remove Tag: NDA'), 'each filter as a chip');
  } finally { await app.unmount(); }
});

test('General access: a template\'s admin shares it with everyone in the organization, as viewers or editors, and stops', async () => {
  let organization: { role: string; sharedAt: number } | undefined;
  const sharing = () => json({ id: 'tpl-1', myRole: 'owner', owner: TEMPLATE.owner, ...(organization ? { organization } : {}), shares: [] });
  const app = await renderMember('/templates', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/templates?') || c.path === '/api/templates') return json({ templates: [TEMPLATE] });
    if (c.path === '/api/templates/tpl-1/shares/delete') { organization = undefined; return sharing(); }
    if (c.path === '/api/templates/tpl-1/shares' && c.method === 'POST') { organization = { role: JSON.parse(String(c.body)).role, sharedAt: 1 }; return sharing(); }
    if (c.path === '/api/templates/tpl-1/shares') return sharing();
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
  });
  const posted = (path: string) => app.calls.filter((c) => c.path === path && c.method === 'POST').map((c) => JSON.parse(String(c.body)));
  try {
    await choose(app, 'Mutual NDA', 'Share');
    assert.equal(app.byId('templates-tpl-1-access').props.value, '');
    await app.type(app.byId('templates-tpl-1-access'), 'viewer');
    assert.deepEqual(posted('/api/templates/tpl-1/shares'), [{ organization: true, role: 'viewer' }]);
    assert.match(app.text(), /Everyone in your organization can view it\./);
    assert.match(app.text(), /finds it in their lists/);
    await app.type(app.byId('templates-tpl-1-access'), 'editor');
    assert.deepEqual(posted('/api/templates/tpl-1/shares').at(-1), { organization: true, role: 'editor' });
    assert.equal(app.byId('templates-tpl-1-access').props.value, 'editor');
    await app.type(app.byId('templates-tpl-1-access'), '');
    assert.deepEqual(posted('/api/templates/tpl-1/shares/delete'), [{ organization: true }]);
    assert.match(app.text(), /No longer shared with everyone in your organization/);
  } finally { await app.unmount(); }
});

test('General access: someone who may not share it reads it, on an envelope\'s page', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const app = await renderMember(`/envelopes/${id}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === `/api/envelopes/${id}`) return json({ id, templateId: 'tpl-1', status: 'IN_PROGRESS', createdAt: 1, tasks: [], owner: TEMPLATE.owner, myRole: 'viewer', tags: [] });
    if (c.path === `/api/envelopes/${id}/audit`) return json({ events: [] });
    if (c.path === `/api/envelopes/${id}/shares`) return json({ id, myRole: 'viewer', owner: TEMPLATE.owner, organization: { role: 'viewer', sharedAt: 1 }, shares: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
  });
  try {
    assert.equal(app.byId(`envelopes-${id}-access`), undefined, 'no control');
    assert.match(app.text(), /Everyone in your organization can view\./);
  } finally { await app.unmount(); }
});

test('a template\'s menu: Edit renames it and changes its default signers, or opens its fields as a new version; Delete asks first; shared with you shows', async () => {
  const shared = { ...TEMPLATE, id: 'tpl-2', name: 'Reseller agreement', owner: { id: 'u9', kind: 'person', name: 'Bo Example' }, myRole: 'viewer', tags: [] };
  const SESSION = 'e'.repeat(64);
  const app = await renderMember('/templates', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === '/api/templates' || c.path.startsWith('/api/templates?')) return json({ templates: [TEMPLATE, shared] });
    if (c.path === '/api/templates/tpl-1' && c.method === 'POST') return json({ id: 'tpl-1', name: 'Mutual NDA v2' });
    if (c.path === '/api/templates/tpl-1/default-signers') return json({ id: 'tpl-1', defaultSigners: {} });
    if (c.path === '/api/templates/tpl-1/delete') return json({ id: 'tpl-1', deleted: true });
    if (c.path === '/api/template-editing-sessions' && c.method === 'POST') return json({ sessionId: SESSION, url: `https://esign.example.test/editor/page/${SESSION}#${'f'.repeat(64)}` }, 201);
  });
  try {
    assert.match(app.text(), /Shared with you · Viewer/, 'what someone shared with the member says so');
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    assert.deepEqual(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem').map((n: any) => visibleText(n.children).trim()), ['View', 'Tags'], 'a viewer neither edits, shares nor deletes');
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

test('the Ownership page, for organization owners: taking over what someone owns; API clients\' people are set on API access', async () => {
  const app = await renderMember('/ownership', (c) => {
    if (c.path === '/api/me') return json(OWNER);
    if (c.path === '/api/owners') return json({ owners: [{ id: 'u9', kind: 'person', name: 'Lee Left', email: 'lee@example.com', templates: 2, envelopes: 3 }, { id: 'sa-1', kind: 'client', name: 'Host product', templates: 1, envelopes: 0 }] });
    if (c.path === '/api/owners/u9/transfer') return json({ from: 'u9', to: 'u1', templates: 2, envelopes: 3 });
  });
  try {
    assert.match(app.text(), /set for each OAuth client on API access/);
    assert.equal(app.byLabel('API clients'), undefined, 'no API clients here any more');
    assert.match(app.text(), /Lee Left/);
    await app.click(app.button('Take over'), 'Take over');
    await app.click(app.button('Take over all of it'), 'confirm');
    assert.match(app.text(), /You now own 2 templates and 3 envelopes that were Lee Left's/);
  } finally { await app.unmount(); }
  // An organization admin who isn't an owner is told the page isn't theirs, and asks nothing.
  const admin = await renderMember('/ownership', (c) => c.path === '/api/me' ? json(me('ADMIN', ['esign.manage', 'esign.view'], { orgRole: 'ADMIN' })) : undefined);
  try { assert.match(admin.text(), /Only your organization's owners take over what someone owns\. Who sees what an API client creates is set for each OAuth client on API access/); } finally { await admin.unmount(); }
});

test('Who sees it: a document an API client owns shows the people its settings name, as admins', async () => {
  const ENV = '11111111-1111-4111-8111-111111111111', CLIENT_OWNER = { id: 'sa-1', kind: 'client', name: 'Host product' };
  const app = await renderMember(`/envelopes/${ENV}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === `/api/envelopes/${ENV}`) return json({ id: ENV, templateId: 'tpl-1', status: 'IN_PROGRESS', createdAt: 1, tasks: [], owner: CLIENT_OWNER, myRole: 'admin', tags: [] });
    if (c.path === `/api/envelopes/${ENV}/audit`) return json({ events: [] });
    if (c.path === `/api/envelopes/${ENV}/shares`) return json({ id: ENV, myRole: 'admin', owner: CLIENT_OWNER, client: { people: [{ email: 'sam@example.com', name: 'Sam Example' }, { email: 'pat@example.com' }] }, shares: [] });
  });
  try {
    const section = visibleText(app.byLabel('From the API client\'s settings').children);
    assert.match(section, /Admin: Sam Example \(sam@example\.com\), pat@example\.com/);
    assert.match(section, /Change who on API access/);
  } finally { await app.unmount(); }
});

test("an API client's page, reached from API access: owners and admins choose who sees what it creates, and save", async () => {
  let people: { email: string; name?: string }[] = [{ email: 'sam@example.com', name: 'Sam Example' }];
  const app = await renderMember('/client-settings/sa-1?name=Host%20product', (c) => {
    if (c.path === '/api/me') return json(me('ADMIN', ['esign.manage', 'esign.view'], { orgRole: 'ADMIN' }));
    if (c.path === '/api/client-settings/sa-1?name=Host%20product') return json({ id: 'sa-1', name: 'Host product', people });
    if (c.path === '/api/client-settings/sa-1' && c.method === 'POST') { people = JSON.parse(String(c.body)).people.map((email: string) => ({ email })); return json({ id: 'sa-1', name: 'Host product', people }); }
    if (c.path.startsWith('/api/members?')) return json({ members: [{ id: 'u2', email: 'bo@example.com', name: 'Bo Example' }] });
  });
  try {
    assert.match(app.text(), /Host product/);
    assert.match(app.text(), /Who sees what it creates/);
    assert.match(app.text(), /Sam Example/);
    assert.equal(app.button('Save').props.disabled, true, 'nothing to save yet');
    // Suggestions are chosen with the keyboard too: an arrow key, then Enter; Escape closes them.
    await app.type(app.byId('client-person-email'), 'bo');
    assert.equal(app.byId('client-person-email').props.role, 'combobox');
    await app.keyDown(app.byId('client-person-email'), 'Escape');
    assert.equal(app.byId('client-person-email').props['aria-expanded'], false);
    await app.type(app.byId('client-person-email'), 'bo ');
    await app.type(app.byId('client-person-email'), 'bo');
    await app.keyDown(app.byId('client-person-email'), 'ArrowDown');
    assert.equal(app.byId('client-person-email').props['aria-activedescendant'], 'client-person-email-suggestions-0');
    await app.keyDown(app.byId('client-person-email'), 'Enter');
    assert.equal(app.byId('client-person-email').props.value, 'bo@example.com');
    await app.click(app.button('Add'), 'Add');
    await app.click(app.byLabel('Remove sam@example.com'), 'Remove');
    await app.click(app.button('Save'), 'Save');
    const saved = app.calls.find((c) => c.path === '/api/client-settings/sa-1' && c.method === 'POST')!;
    assert.deepEqual(JSON.parse(String(saved.body)), { people: ['bo@example.com'] });
    assert.match(app.text(), /Saved\. 1 person sees everything this client creates\./);
    assert.equal(app.link('Ownership'), undefined, 'taking over is for owners only');
  } finally { await app.unmount(); }
  // An organization owner also gets the way to take over what the client owns.
  const owner = await renderMember('/client-settings/sa-1', (c) => {
    if (c.path === '/api/me') return json(OWNER);
    if (c.path === '/api/client-settings/sa-1') return json({ id: 'sa-1', name: 'Host product', people: [] });
  });
  try {
    assert.match(owner.text(), /No longer used\? Take over everything it owns on\s+Ownership/);
    await owner.click(owner.link('Ownership'), 'Ownership');
    assert.equal(owner.location.pathname, '/ownership');
  } finally { await owner.unmount(); }
  // Anyone else is told whose it is, and nothing is asked of the server: an Admin of Esign by grant too.
  for (const other of [EDITOR, me('ADMIN', ['esign.manage', 'esign.view'], { orgRole: 'APPS' })]) {
    const editor = await renderMember('/client-settings/sa-1', (c) => c.path === '/api/me' ? json(other) : undefined);
    try {
      assert.match(editor.text(), /Only your organization's owners and admins choose who sees what an API client creates/);
      assert.ok(!editor.calls.some((c) => c.path.startsWith('/api/client-settings')));
    } finally { await editor.unmount(); }
  }
});

test('a tag typed and left (Done, without Enter) is saved; a save that fails says so in the dialog', async () => {
  const ENV = '22222222-2222-4222-8222-222222222222';
  let failing = false;
  const row = { id: ENV, templateId: 'tpl-1', status: 'IN_PROGRESS', createdAt: 0, documentName: 'Reseller agreement', signers: [], progress: { signed: 0, total: 1 }, owner: { id: 'u1', kind: 'person', name: 'Sam Example' }, myRole: 'owner', tags: [] };
  const app = await renderMember('/envelopes', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path.startsWith('/api/envelopes?') || c.path === '/api/envelopes') return json({ envelopes: [row] });
    if (c.path === `/api/envelopes/${ENV}/tags`) return failing ? json({ error: 'forbidden' }, 403) : json({ id: ENV, tags: JSON.parse(String(c.body)).tags });
  });
  try {
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Tags')[0], 'Tags');
    await app.type(app.byId('list-envelope-tags'), 'q4');
    await app.act(async () => { app.byId('list-envelope-tags').props.onBlur(); });
    await app.settle();
    const saved = app.calls.filter((c) => c.path === `/api/envelopes/${ENV}/tags`);
    assert.deepEqual(JSON.parse(String(saved.at(-1)!.body)), { tags: ['q4'] });
    // Typing with an input method: its Enter confirms the composition and adds nothing.
    await app.type(app.byId('list-envelope-tags'), 'ni');
    await app.act(async () => { app.byId('list-envelope-tags').props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} }); });
    assert.equal(app.calls.filter((c) => c.path === `/api/envelopes/${ENV}/tags`).length, 1);
    failing = true;
    await app.type(app.byId('list-envelope-tags'), 'nda');
    await app.keyDown(app.byId('list-envelope-tags'), 'Enter');
    assert.match(visibleText(app.byLabel('Your tags').children), /Your role in Esign doesn't allow that/);
    assert.equal(app.renderer.root.findAll((n: any) => n.props?.['aria-label'] === 'Remove tag nda').length, 0, 'a tag that wasn\'t saved isn\'t shown');
    assert.equal(app.renderer.root.findAll((n: any) => n.props?.['aria-label'] === 'Remove tag q4').length > 0, true);
  } finally { await app.unmount(); }
});

test('tag suggestions are chosen with the keyboard; Escape closes them alone, keeping what was typed', async () => {
  const ENV = '33333333-3333-4333-8333-333333333333';
  const row = { id: ENV, templateId: 'tpl-1', status: 'IN_PROGRESS', createdAt: 0, documentName: 'Reseller agreement', signers: [], progress: { signed: 0, total: 1 }, owner: { id: 'u1', kind: 'person', name: 'Sam Example' }, myRole: 'owner', tags: [] };
  const app = await renderMember('/envelopes', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/tags?')) return json({ tags: [{ tag: 'partners', uses: 2 }, { tag: 'pa-review', uses: 1 }] });
    if (c.path.startsWith('/api/envelopes?') || c.path === '/api/envelopes') return json({ envelopes: [row] });
    if (c.path === `/api/envelopes/${ENV}/tags`) return json({ id: ENV, tags: JSON.parse(String(c.body)).tags });
  });
  try {
    await app.click(app.byLabel('More for Reseller agreement'), 'menu');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Tags')[0], 'Tags');
    const field = () => app.byId('list-envelope-tags');
    await app.type(field(), 'pa');
    assert.equal(field().props.role, 'combobox');
    let prevented = false;
    await app.act(async () => { field().props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() { prevented = true; } }); });
    assert.equal(prevented, true, 'the dialog leaves an Escape that was used alone');
    assert.deepEqual([field().props['aria-expanded'], field().props.value], [false, 'pa']);
    await app.type(field(), 'par');
    await app.keyDown(field(), 'ArrowDown');
    assert.equal(field().props['aria-activedescendant'], 'list-envelope-tags-suggestions-0');
    await app.act(async () => { field().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} }); });
    await app.settle();
    const saved = app.calls.filter((c) => c.path === `/api/envelopes/${ENV}/tags`);
    assert.deepEqual(JSON.parse(String(saved.at(-1)!.body)), { tags: ['partners'] }, 'the suggestion, not what was typed');
  } finally { await app.unmount(); }
});
