// Send later in the members' pages (member/SendLater.ts, NewEnvelopePage.ts, EnvelopesPage.ts): the send button's
// menu opens a day and a time, checked before anything is asked of the server; a scheduled draft says when it sends,
// and Send now or a new time from it; the list says when each sends, or why one wasn't. In-process, against stubbed
// API answers; synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR, json, renderMember, visibleText } from './helpers/member.ts';

const TEMPLATE = { id: 'tpl-1', name: 'Reseller agreement', status: 'active', roles: ['partner'], fields: [], createdAt: 0, owner: { id: 'u1', kind: 'person', name: 'Sam Example' }, myRole: 'owner', tags: [] };
const DRAFT_ID = '55555555-5555-4555-8555-555555555555';
const OWNER = { id: 'u1', kind: 'person', name: 'Sam Example', email: 'sam@example.com' };
const REQUEST = { templateId: 'tpl-1', recipients: [{ role: 'partner', name: 'Pat Partner', email: 'pat@partner.example', delivery: 'email' }] };
const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

test('a scheduled draft says when it sends; Send later picks another time, checked first; Send now sends it', async () => {
  const sendAt = new Date(Date.now() + 2 * 24 * 3_600_000); sendAt.setSeconds(0, 0);
  let scheduled = sendAt.toISOString(), sent = false;
  const app = await renderMember(`/envelopes/new?draft=${DRAFT_ID}`, (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path === '/api/templates' || c.path.startsWith('/api/templates?')) return json({ templates: [TEMPLATE] });
    if (c.path.startsWith('/api/contacts')) return json({ contacts: [] });
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path === `/api/envelopes/${DRAFT_ID}` && c.method === 'POST') {
      const body = JSON.parse(String(c.body));
      if (body.sendAt) { scheduled = body.sendAt; return json({ id: DRAFT_ID, status: 'DRAFT', sendAt: body.sendAt }); }
      sent = true;
      return json({ id: DRAFT_ID, status: 'IN_PROGRESS' });
    }
    if (c.path === `/api/envelopes/${DRAFT_ID}`) return json(sent ? { id: DRAFT_ID, templateId: 'tpl-1', status: 'IN_PROGRESS', tasks: [], owner: OWNER, myRole: 'owner', tags: [] } : { id: DRAFT_ID, templateId: 'tpl-1', status: 'DRAFT', tasks: [], draft: REQUEST, sendAt: scheduled, owner: OWNER, myRole: 'owner', tags: [] });
    if (c.path.startsWith(`/api/envelopes/${DRAFT_ID}/`)) return json(c.path.endsWith('/audit') ? { events: [] } : { id: DRAFT_ID, myRole: 'owner', owner: OWNER, shares: [] });
  });
  const posts = () => app.calls.filter((c) => c.method === 'POST' && c.path === `/api/envelopes/${DRAFT_ID}`);
  try {
    assert.match(app.text(), /Scheduled to send on .+\. Send it now, choose another time with Send later, or Save draft to cancel the scheduled send\./);
    assert.match(app.text(), /Saving as a draft cancels the scheduled send\./);
    assert.ok(app.button('Send now'), 'its send button sends now');
    // Send later: the time already chosen, then a time too soon is refused here.
    await app.click(app.byLabel('More ways to send'), 'menu');
    await app.click(app.renderer.root.findAll((n: any) => n.props?.role === 'menuitem' && visibleText(n.children).trim() === 'Send later…')[0], 'Send later…');
    assert.ok(app.byLabel('Send later'), 'the dialog');
    assert.deepEqual([app.byId('send-later-day').props.value, app.byId('send-later-time').props.value], [localDay(sendAt), localTime(sendAt)]);
    const soon = new Date(Date.now() + 60_000);
    await app.type(app.byId('send-later-day'), localDay(soon));
    await app.type(app.byId('send-later-time'), localTime(soon));
    await app.click(app.button('Schedule'), 'Schedule');
    assert.match(app.text(), /Choose a time at least five minutes from now\./);
    assert.equal(posts().length, 0, 'nothing asked of the server');
    // Another time: the request with sendAt.
    const next = new Date(Date.now() + 3 * 24 * 3_600_000); next.setHours(9, 30, 0, 0);
    await app.type(app.byId('send-later-day'), localDay(next));
    await app.type(app.byId('send-later-time'), '09:30');
    await app.click(app.button('Schedule'), 'Schedule');
    const body = JSON.parse(String(posts()[0]!.body));
    assert.equal(body.sendAt, next.toISOString());
    assert.equal(body.draft, undefined);
    assert.equal(body.recipients[0].email, 'pat@partner.example');
    assert.equal((app.text().match(/Scheduled to send on/g) ?? []).length, 1, 'said once, by the schedule\'s notice');
    // Send now.
    await app.click(app.button('Send now'), 'Send now');
    assert.equal(JSON.parse(String(posts()[1]!.body)).sendAt, undefined);
    assert.equal(app.location.pathname, `/envelopes/${DRAFT_ID}`);
  } finally { await app.unmount(); }
});

test('the list: a scheduled draft says when it sends, one not sent says why; drafts are continued', async () => {
  const base = { templateId: 'tpl-1', status: 'DRAFT', createdAt: 0, signers: [], progress: { signed: 0, total: 1 }, owner: OWNER, myRole: 'owner', tags: [] };
  const app = await renderMember('/envelopes?status=draft', (c) => {
    if (c.path === '/api/me') return json(EDITOR);
    if (c.path.startsWith('/api/tags?')) return json({ tags: [] });
    if (c.path.startsWith('/api/envelopes?')) return json({ envelopes: [
      { ...base, id: DRAFT_ID, documentName: 'Later agreement', sendAt: '2030-01-02T03:04:00.000Z' },
      { ...base, id: '66666666-6666-4666-8666-666666666666', documentName: 'Failed agreement', sendError: 'template_draft' },
    ] });
  });
  try {
    assert.match(app.text(), /Sends .*2030/);
    assert.match(app.text(), /Not sent: its template is a draft/);
    assert.equal(app.renderer.root.findAll((n: any) => n.type === 'a' && visibleText(n.children).trim() === 'Continue').length, 2);
  } finally { await app.unmount(); }
});
