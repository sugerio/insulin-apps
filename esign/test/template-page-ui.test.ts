// A template's own page (member/TemplatePage.ts): reached from the list by its name or View, it shows its details,
// read only, and its PDF below them, with the boxes of its placed fields. In-process, against stubbed API answers;
// synthetic data. The PDF is drawn in a real browser; here the drawing is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, VIEWER, json, renderMember, visibleText } from './helpers/member.ts';
import { pdfView } from '../src/app/member/TemplatePage.ts';

const ID = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: 'u9', kind: 'person', name: 'Ana Owner', email: 'ana@example.com' };
const TEMPLATE = {
  id: ID, name: 'Mutual NDA', metadata: { department: 'Legal' }, defaultSigners: { partner: { name: 'Pat Partner', email: 'pat@partner.example' } }, roles: ['partner', 'seller'],
  fields: [
    { type: 'Signature', role: 'partner', page: 1, required: true, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05 } },
    { type: 'Signature', role: 'partner', page: 2, required: false, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05 } },
    { type: 'Signature', role: 'seller', page: 2, required: true, rect: { x: 0.5, y: 0.7, width: 0.3, height: 0.05 } },
    { type: 'Date signed', role: 'seller', page: 2, required: true, rect: { x: 0.5, y: 0.8, width: 0.3, height: 0.04 } },
  ],
  createdAt: Date.parse('2026-11-01T00:00:00Z'), owner: OWNER, myRole: 'viewer', tags: ['NDA'],
};
const PDF = '%PDF-1.7 synthetic';

function routes(template: Record<string, unknown>, me = EDITOR) {
  return (c: { path: string }) => {
    if (c.path === '/api/me') return json(me);
    if (c.path.startsWith('/api/templates?')) return json({ templates: [{ ...template, fields: (template.fields as object[]).map(({ required, ...f }: any) => f) }] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === `/api/templates/${ID}`) return json(template);
    if (c.path === `/api/templates/${ID}/pdf`) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
  };
}

test('a template\'s page: its details, read only, and its PDF below them; its name in the list leads there', async () => {
  const drawn: string[] = [];
  const render = pdfView.render;
  pdfView.render = async (blob) => { drawn.push(await blob.text()); return []; };
  const app = await renderMember('/templates', routes(TEMPLATE));
  try {
    await app.click(app.byLabel('View Mutual NDA'), 'the template\'s name');
    assert.equal(app.location.pathname, `/templates/${ID}`);
    const details = visibleText(app.byLabel('Details').children);
    for (const shown of ['Mutual NDA', ID, 'Ana Owner', 'Viewer', 'Nov 1, 2026', '1. partner', 'Usually Pat Partner, pat@partner.example', '2 Signature (1 optional)', '2. seller', 'No default signer', '1 Signature, 1 Date signed', '4 placed fields', 'NDA', 'department', 'Legal'])
      assert.ok(details.includes(shown), `${shown} in: ${details}`);
    assert.match(app.text(), /Shared with you · Viewer/);
    assert.ok(app.byLabel('Document'), 'the document below the details');
    assert.deepEqual(drawn, [PDF], 'its PDF, drawn once');
    assert.ok(app.byLabel('Roles on the document'), 'a key to the roles\' colours');
    assert.equal(app.renderer.root.findAll((n: any) => n.type === 'input' || n.type === 'textarea' || n.type === 'select').length, 0, 'nothing to change');
    assert.ok(app.link('Send'), 'those who manage send from it');
    await app.click(app.link('All templates'), 'back');
    assert.equal(app.location.pathname, '/templates');
  } finally { pdfView.render = render; await app.unmount(); }
});

test('a template\'s page: View in its menu; without placed fields, a signature page; archived, said so and not sent; for a viewer, no Send', async () => {
  const render = pdfView.render;
  pdfView.render = async () => [];
  const app = await renderMember('/templates', routes({ ...TEMPLATE, fields: [], archivedAt: Date.parse('2026-11-05T00:00:00Z') }, VIEWER));
  try {
    await app.click(app.byLabel('More for Mutual NDA'), 'the row\'s menu');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'View')[0], 'View');
    assert.equal(app.location.pathname, `/templates/${ID}`);
    assert.match(app.text(), /A signature page added at the end/);
    assert.match(app.text(), /Each signer signs on a page added at the end/);
    assert.equal(app.byLabel('Roles on the document'), undefined);
    assert.match(app.text(), /Archived Nov 5, 2026/);
    assert.equal(app.link('Send'), undefined);
  } finally { pdfView.render = render; await app.unmount(); }
});

test('a template\'s page: one the member doesn\'t see is not found; a document that can\'t be drawn says so', async () => {
  const missing = await renderMember(`/templates/${ID}`, (c) => c.path === '/api/me' ? json(EDITOR) : c.path === `/api/templates/${ID}` ? json({ error: 'not_found' }, 404) : undefined);
  try {
    assert.ok(missing.link('All templates'));
    assert.equal(missing.byLabel('Details'), undefined);
    assert.match(missing.text(), /not found|isn't|doesn't|no longer/i);
  } finally { await missing.unmount(); }
  const render = pdfView.render;
  pdfView.render = async () => { throw new Error('unreadable'); };
  const broken = await renderMember(`/templates/${ID}`, routes(TEMPLATE));
  try {
    assert.ok(broken.byLabel('Details'));
    assert.match(broken.text(), /The document could not be shown/);
  } finally { pdfView.render = render; await broken.unmount(); }
});
