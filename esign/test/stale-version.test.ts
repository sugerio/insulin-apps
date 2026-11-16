// A page still running the version before a deploy (member/update.ts): a lazily loaded part that can't be loaded is a
// StaleVersion; the page reloads once to take the new version, and then says so instead of reloading again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPart, reloadForUpdate, StaleVersion } from '../src/app/member/update.ts';
import { EDITOR, json, renderMember } from './helpers/member.ts';
import { pdfView } from '../src/app/member/TemplatePage.ts';

test('a part that can\'t be loaded is a stale version; the page reloads once a minute at most', async () => {
  assert.equal(await loadPart(async () => 'pdf'), 'pdf');
  await assert.rejects(() => loadPart(async () => { throw new TypeError('Failed to fetch dynamically imported module') }), StaleVersion);
  const stored = new Map<string, string>();
  let reloads = 0;
  (globalThis as any).window = { sessionStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) }, location: { reload: () => { reloads++; } } };
  try {
    assert.equal(reloadForUpdate(1_000_000), true);
    assert.equal(reloads, 1);
    assert.equal(reloadForUpdate(1_030_000), false, 'not again within a minute: a loop');
    assert.equal(reloads, 1);
    assert.equal(reloadForUpdate(1_070_000), true, 'later, a new deploy may reload again');
  } finally { delete (globalThis as any).window; }
});

test('a template\'s document that can\'t load its viewer says Esign was updated, when reloading didn\'t help', async () => {
  const ID = '22222222-2222-4222-8222-222222222222';
  const render = pdfView.render;
  pdfView.render = async () => { throw new StaleVersion(); };
  const app = await renderMember(`/templates/${ID}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === `/api/templates/${ID}`) return json({ id: ID, name: 'NDA', roles: ['partner'], fields: [], owner: { id: 'u1', kind: 'person' }, myRole: 'owner', tags: [] });
    if (c.path === `/api/templates/${ID}/pdf`) return new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
  });
  try {
    // The test window can't reload: as when a reload just happened.
    assert.match(app.text(), /Esign was updated since this page opened: reload the page to see the document/);
    assert.doesNotMatch(app.text(), /The document could not be shown/);
  } finally { pdfView.render = render; await app.unmount(); }
});
