// The members' pages for ownership (member/SharePanel.ts, TagsField.ts, ListFilters.ts, OwnershipPage.ts): who sees a
// template and sharing it, the member's own tags and filtering by them, and the Ownership page's API clients and
// owners. In-process, against stubbed API answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, json, me, renderMember } from './helpers/member.ts';

const TEMPLATE = { id: 'tpl-1', name: 'Mutual NDA', roles: ['partner'], fields: [], createdAt: Date.parse('2026-11-07T00:00:00Z'), owner: { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' }, myRole: 'owner', tags: ['NDA'] };
const OWNER = me('OWNER', ['esign.manage', 'esign.view']);

test('a template\'s sharing: its owner shares it by email and role, and tags it; the list filters by scope and tag', async () => {
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
    await app.click(app.byLabel('Who sees Mutual NDA'), 'Sharing');
    assert.match(app.text(), /Not shared with anyone else/);
    await app.type(app.byId('templates-tpl-1-share-email'), 'bo');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.['aria-label'] === 'Choose Bo Example (bo@example.com)')[0], 'suggestion');
    await app.type(app.byId('templates-tpl-1-share-role'), 'editor');
    await app.click(app.button('Share'), 'Share');
    const shared = app.calls.find((c) => c.path === '/api/templates/tpl-1/shares' && c.method === 'POST')!;
    assert.deepEqual(JSON.parse(String(shared.body)), { email: 'bo@example.com', role: 'editor' });
    assert.match(app.text(), /Shared with bo@example.com as editor/);
    // Removing a tag saves the member's tags at once.
    await app.click(app.byLabel('Remove tag NDA'), 'remove tag');
    assert.deepEqual(JSON.parse(String(app.calls.find((c) => c.path === '/api/templates/tpl-1/tags')!.body)), { tags: [] });
    // Filters: shared with me, with two tags.
    await app.type(app.byId('templates-scope'), 'shared');
    await app.settle();
    await app.type(app.byId('templates-tags'), 'nda, Partners');
    await app.keyDown(app.byId('templates-tags'), 'Enter');
    assert.ok(app.calls.some((c) => c.path === '/api/templates?scope=shared&tag=nda&tag=Partners'), app.calls.map((c) => c.path).join('\n'));
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
