// The Envelopes list (member/EnvelopesPage.ts): where each envelope stands (out for signature, how many have signed and
// whose turn it is), the one action that fits it (Resend, Download, View) and its menu, the search with its suggested
// filters, the filter buttons and their chips, and pages. In-process, against stubbed API answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, json, renderMember, visibleText } from './helpers/member.ts';

const OWNED = { owner: { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' }, myRole: 'owner', tags: [] };
const OUT = {
  id: '11111111-1111-4111-8111-111111111111', templateId: 't', status: 'IN_PROGRESS', createdAt: Date.parse('2026-11-01T00:00:00Z'), lastChangeAt: Date.parse('2026-11-02T00:00:00Z'), documentName: 'Mutual NDA',
  signers: [{ role: 'a', name: 'Ana Signer', email: 'ana@partner.example', status: 'SIGNED' }, { role: 'b', name: 'Bo Signer', email: 'bo@partner.example', status: 'ACTIVE' }],
  progress: { signed: 1, total: 2 }, current: { taskId: 'task-2', name: 'Bo Signer', email: 'bo@partner.example', delivery: 'email' }, ...OWNED,
};
const DONE = { ...OUT, id: '22222222-2222-4222-8222-222222222222', status: 'COMPLETED', documentName: 'Order form', progress: { signed: 2, total: 2 }, current: undefined };
const HOSTED = { ...OUT, id: '33333333-3333-4333-8333-333333333333', documentName: 'Reseller agreement', current: { ...OUT.current, delivery: 'host' } };

test('each envelope says how far along it is and whose turn it is, and offers Resend, Download or View', async () => {
  const app = await renderMember('/envelopes', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/envelopes?')) return json({ envelopes: [OUT, DONE, HOSTED] });
    if (c.path === `/api/envelopes/${OUT.id}/tasks/task-2/invitation`) return new Response(null, { status: 204 });
    if (c.path === `/api/envelopes/${DONE.id}/delivery-pdf`) return new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
  });
  try {
    assert.match(app.text(), /Waiting for Bo Signer/);
    assert.match(app.text(), /1 of 2 signed/);
    assert.match(app.text(), /To: Ana Signer, Bo Signer/);
    assert.equal(app.renderer.root.findAll((n: any) => n.props?.role === 'progressbar').length, 2, 'out for signature has a bar; completed a badge');
    // Resend, for a signer Esign invites; Download, once completed; View, for one the sender's system opens.
    const rowOf = (name: string) => app.renderer.root.findAll((n: any) => n.type === 'tr' && visibleText(n.children).includes(name))[0];
    const buttons = (name: string) => rowOf(name).findAll((n: any) => (n.type === 'button' || n.type === 'a') && visibleText(n.children).trim()).map((n: any) => visibleText(n.children).trim());
    assert.ok(buttons('Mutual NDA').includes('Resend'));
    assert.ok(buttons('Order form').includes('Download'));
    assert.ok(buttons('Reseller agreement').includes('View') && !buttons('Reseller agreement').includes('Resend'));
    await app.click(rowOf('Mutual NDA').findAll((n: any) => n.type === 'button' && visibleText(n.children).trim() === 'Resend')[0], 'Resend');
    assert.ok(app.calls.some((c) => c.path === `/api/envelopes/${OUT.id}/tasks/task-2/invitation` && c.method === 'POST'));
    assert.match(app.text(), /emailed again to bo@partner\.example/);
    await app.click(rowOf('Order form').findAll((n: any) => n.type === 'button' && visibleText(n.children).trim() === 'Download')[0], 'Download');
    assert.ok(app.calls.some((c) => c.path === `/api/envelopes/${DONE.id}/delivery-pdf`));
    // The menu: View, Void (out for signature), Tags, Share.
    await app.click(app.byLabel('More for Mutual NDA'), 'menu');
    assert.deepEqual(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem').map((n: any) => visibleText(n.children).trim()), ['View', 'Void', 'Tags', 'Share']);
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Void')[0], 'Void');
    assert.ok(app.byLabel('Void envelope'), 'voiding asks first');
  } finally { await app.unmount(); }
});

test('the search, its suggested filters, the filter buttons, their chips and Clear all, and pages', async () => {
  const pages: Record<string, unknown> = { '': { envelopes: [OUT], next: 111 }, '111': { envelopes: [DONE] } };
  const app = await renderMember('/envelopes', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/envelopes?')) return json(pages[new URL(c.path, 'https://x.test').searchParams.get('before') ?? ''] ?? { envelopes: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [{ tag: 'NDA', uses: 3 }, { tag: 'partners', uses: 1 }] });
  });
  const listed = () => app.calls.filter((c) => c.path.startsWith('/api/envelopes?')).map((c) => new URL(c.path, 'https://x.test').searchParams)
  const lastQuery = () => listed().at(-1)!;
  try {
    // Pages: next, then back.
    assert.match(app.text(), /Page 1/);
    await app.click(app.byLabel('Next page'), 'next');
    assert.equal(lastQuery().get('before'), '111');
    assert.match(app.text(), /Page 2/);
    assert.match(app.text(), /Order form/);
    assert.equal(app.byLabel('Next page').props.disabled, true, 'the last page');
    await app.click(app.byLabel('Previous page'), 'previous');
    assert.equal(lastQuery().get('before'), null);
    // The empty search offers the common filters; one is a click.
    await app.act(async () => { app.byId('envelope-search').props.onFocus(); });
    assert.ok(app.byLabel('Filter by'));
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'option' && visibleText(n.children).includes('Waiting for others'))[0], 'Waiting for others');
    assert.equal(lastQuery().get('view'), 'waiting');
    // Typing searches, as the member presses Enter.
    await app.type(app.byId('envelope-search'), 'nda');
    await app.keyDown(app.byId('envelope-search'), 'Enter');
    assert.equal(lastQuery().get('q'), 'nda');
    // Date and Sender, from their buttons.
    await app.click(app.byLabel('Date filter'), 'Date');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitemradio' && visibleText(n.children).trim() === 'Last 7 days')[0], '7 days');
    const since = Number(lastQuery().get('since'));
    assert.ok(Math.abs(Date.now() - 7 * 86_400_000 - since) < 60_000, 'created in the last 7 days');
    await app.click(app.byLabel('Sender filter'), 'Sender');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitemradio' && visibleText(n.children).trim() === 'Shared with me')[0], 'shared');
    assert.equal(lastQuery().get('scope'), 'shared');
    // Tags: the member's own, picked by clicking; the menu stays open for another.
    await app.click(app.byLabel('Tags filter'), 'Tags');
    const tagItem = (name: string) => app.renderer.root.findAll((n: any) => n.props?.role === 'menuitemcheckbox' && visibleText(n.children).trim() === name)[0];
    await app.click(tagItem('NDA'), 'NDA');
    await app.click(tagItem('partners'), 'partners');
    assert.deepEqual(lastQuery().getAll('tag'), ['NDA', 'partners']);
    await app.click(tagItem('NDA'), 'NDA again unpicks it');
    assert.deepEqual(lastQuery().getAll('tag'), ['partners']);
    await app.click(app.byLabel('Tags filter'), 'close');
    // Chips: each removes its filter; Clear all removes them all.
    const chips = () => app.renderer.root.findAll((n: any) => typeof n.props?.['aria-label'] === 'string' && n.props['aria-label'].startsWith('Remove ')).map((n: any) => n.props['aria-label']);
    assert.deepEqual(chips(), ['Remove Search: nda', 'Remove Date: Last 7 days', 'Remove Sender: Shared with me', 'Remove Quick view: Waiting for others', 'Remove Tag: partners']);
    await app.click(app.byLabel('Remove Quick view: Waiting for others'), 'chip');
    assert.equal(lastQuery().get('view'), null);
    await app.click(app.button('Clear all'), 'Clear all');
    assert.deepEqual([...lastQuery().keys()], ['limit']);
    // Per page.
    await app.type(app.byId('envelope-page-size'), '50');
    await app.settle();
    assert.equal(lastQuery().get('limit'), '50');
  } finally { await app.unmount(); }
});
