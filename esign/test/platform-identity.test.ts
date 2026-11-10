import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { applyMigrations, blobStore, identity } from './helpers/platform.ts';
import app from '../src/app/server/esign/app.ts';

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  await applyMigrations(db, { gateway: false });
  const env = { DB: db, ARTIFACTS: await blobStore(mf, 'artifacts'), OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_MAIL: await blobStore(mf, 'test-mail'), TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
  const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }), env as never);
  const upload = async (headers: Record<string, string>) => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const form = new FormData();
    form.set('file', new File([await pdf.save()], 'synthetic.pdf', { type: 'application/pdf' }));
    form.set('roles', '["signer"]');
    return call('/api/templates', headers, { method: 'POST', body: form });
  };
  return { mf, db, env, call, upload };
}

/** What the gateway's five-minute tick sends: the app's id and `x-suger-access-via: schedule`, nothing else. */
const TICK = { 'x-suger-app-id': 'insulin-apps-esign', 'x-suger-access-via': 'schedule' };

test('management routes need the platform identity, and a public request never reaches them', async () => {
  const { mf, call } = await harness();
  try {
    assert.equal((await call('/api/templates')).status, 401, 'no identity');
    assert.equal((await call('/api/templates', identity('org-a', { via: 'public' }))).status, 401, 'the gateway marked it public');
    assert.equal((await call('/api/templates', { ...identity('org-a'), 'x-suger-app-role': 'STAFF' })).status, 401, 'a role the platform contract does not know');
    assert.equal((await call('/api/templates', identity('org-a'))).status, 200);
    assert.equal((await call('/api/health')).status, 200, 'the health check is open');
  } finally { await mf.dispose(); }
});

test('Editors and above send; Viewers see; a custom role only narrows, never widens', async () => {
  const { mf, call, upload } = await harness();
  try {
    assert.equal((await upload(identity('org-a', { role: 'EDITOR' }))).status, 201, 'Editor manages');
    assert.equal((await upload(identity('org-a', { role: 'ADMIN' }))).status, 201, 'Admin manages');
    assert.equal((await upload(identity('org-a', { role: 'OWNER' }))).status, 201, 'the console\'s Owner too');
    assert.equal((await upload(identity('org-a', { role: 'VIEWER' }))).status, 403, 'Viewer reads only');
    assert.equal((await upload(identity('org-a', { role: 'USER' }))).status, 403, 'the console\'s User reads only');
    assert.equal((await call('/api/templates', identity('org-a', { role: 'VIEWER' }))).status, 200);
    assert.equal((await upload(identity('org-a', { role: 'EDITOR', permissions: 'esign.view' }))).status, 403, 'a read-only custom role');
    assert.equal((await call('/api/templates', identity('org-a', { role: 'EDITOR', permissions: 'esign.view' }))).status, 200);
    assert.equal((await upload(identity('org-a', { role: 'VIEWER', permissions: 'esign.manage esign.view' }))).status, 403, 'the header cannot widen a role');
    assert.equal((await call('/api/templates', identity('org-a', { role: 'EDITOR', permissions: '' }))).status, 403, 'no permission at all');
    const me = await (await call('/api/me', identity('org-a', { role: 'EDITOR', permissions: 'esign.view', via: 'mcp' }))).json() as { organizationId: string; permissions: string[]; accessVia: string; role: string };
    assert.deepEqual({ organizationId: me.organizationId, permissions: me.permissions, accessVia: me.accessVia, role: me.role }, { organizationId: 'org-a', permissions: ['esign.view'], accessVia: 'mcp', role: 'EDITOR' });
    assert.equal((await call('/api/me', identity('org-a', { role: 'EDITOR', permissions: '' }))).status, 200, '/api/me answers any identity');
  } finally { await mf.dispose(); }
});

test('an organization never sees another\'s templates or envelopes', async () => {
  const { mf, call, upload } = await harness();
  try {
    const created = await (await upload(identity('org-a'))).json() as { id: string };
    assert.equal((await call(`/api/templates/${created.id}`, identity('org-a'))).status, 200);
    assert.equal((await call(`/api/templates/${created.id}`, identity('org-b'))).status, 404);
    const listed = await (await call('/api/templates', identity('org-b'))).json() as { templates: unknown[] };
    assert.deepEqual(listed.templates, []);
    const send = (org: string) => call('/api/envelopes', { ...identity(org), 'content-type': 'application/json', 'idempotency-key': `send-${org}` }, { method: 'POST', body: JSON.stringify({ templateId: created.id, recipients: [{ role: 'signer', name: 'Ana Example', email: 'ana@example.com' }] }) });
    assert.equal((await send('org-b')).status, 404, 'another organization\'s template');
    const envelope = await (await send('org-a')).json() as { id: string };
    assert.equal((await call(`/api/envelopes/${envelope.id}`, identity('org-b'))).status, 404);
    assert.equal((await call(`/api/envelopes/${envelope.id}/audit`, identity('org-b'))).status, 404);
    assert.equal((await call(`/api/envelopes/${envelope.id}/void`, { ...identity('org-b'), 'content-type': 'application/json' }, { method: 'POST', body: '{}' })).status, 404);
    const mine = await (await call('/api/envelopes', identity('org-a'))).json() as { envelopes: { id: string; status: string }[] };
    assert.deepEqual(mine.envelopes.map((e) => [e.id, e.status]), [[envelope.id, 'IN_PROGRESS']]);
    assert.deepEqual((await (await call('/api/envelopes', identity('org-b'))).json() as { envelopes: unknown[] }).envelopes, []);
    assert.equal((await call('/api/envelopes?status=NOPE', identity('org-a'))).status, 400);
  } finally { await mf.dispose(); }
});

test('the catalog lists what the caller may use, and process-due needs the manage permission', async () => {
  const { mf, call } = await harness();
  try {
    const endpoints = async (headers: Record<string, string>) => ((await (await call('/api/catalog', headers)).json()) as { endpoints: { method: string; path: string }[] }).endpoints;
    const viewer = await endpoints(identity('org-a', { role: 'VIEWER' }));
    assert.ok(viewer.some((e) => e.method === 'GET' && e.path === '/api/envelopes/{id}'));
    assert.equal(viewer.some((e) => e.method === 'POST'), false, 'a Viewer is offered no change');
    const editor = await endpoints(identity('org-a', { role: 'EDITOR' }));
    assert.ok(editor.some((e) => e.method === 'POST' && e.path === '/api/envelopes'));
    assert.ok(editor.every((e) => e.path.startsWith('/api/') && !e.path.startsWith('/api/public/')), 'the signer pages\' API is left out');
    assert.equal((await call('/api/process-due', identity('org-a', { role: 'VIEWER' }), { method: 'POST' })).status, 403);
    const due = await call('/api/process-due', identity('org-a', { role: 'EDITOR' }), { method: 'POST' });
    assert.equal(due.status, 200);
    assert.deepEqual(await due.json(), { expired: 0, completed: 0, waiting: 0, failed: 0 });
  } finally { await mf.dispose(); }
});

test("process-due touches only the caller's organization, FINALIZING envelopes included", async () => {
  const { mf, db, call } = await harness();
  try {
    await db.prepare("INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) VALUES ('tpl-b', 'org-b', 'templates/org-b/tpl-b.pdf', '[\"signer\"]', 1)").run();
    await db.prepare("INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256) VALUES ('env-b', 'org-b', 'tpl-b', 'FINALIZING', 1, 'x')").run();
    const due = await call('/api/process-due', identity('org-a', { role: 'EDITOR' }), { method: 'POST' });
    assert.equal(due.status, 200);
    assert.deepEqual(await due.json(), { expired: 0, completed: 0, waiting: 0, failed: 0 }, "another organization's envelope is not picked up");
    assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id = 'env-b'").first<{ status: string }>())?.status, 'FINALIZING');
  } finally { await mf.dispose(); }
});

test('POST /api/scheduled answers only the platform tick: schedule and no identity at all', async () => {
  const { mf, env, call } = await harness();
  try {
    const tick = (headers: Record<string, string>) => call('/api/scheduled', headers, { method: 'POST' });
    assert.equal((await tick({})).status, 403, 'nothing marks it as the tick');
    for (const via of ['browser', 'api', 'mcp', 'public', 'Schedule', 'schedule,schedule'])
      assert.equal((await tick({ ...TICK, 'x-suger-access-via': via })).status, 403, via);
    assert.equal((await tick(identity('org-a', { via: 'schedule' }))).status, 403, "a member's identity, even marked schedule");
    assert.equal((await tick(identity('org-a', { role: 'OWNER', via: 'schedule' }))).status, 403, 'an owner too');
    assert.equal((await tick(identity('org-a', { via: 'api', userId: 'service-account-1' }))).status, 403, "a service account's");
    assert.equal((await tick({ ...TICK, 'x-suger-organization-id': 'org-a' })).status, 403, 'an organization alone');
    assert.equal((await tick({ ...TICK, 'x-suger-user-id': 'user-1' })).status, 403, 'a person alone');
    assert.equal((await tick({ ...TICK, 'x-suger-app-permissions': 'esign.manage' })).status, 403, 'permissions alone');
    const ran = await tick(TICK);
    assert.equal(ran.status, 200);
    assert.deepEqual(await ran.json(), { expired: 0, completed: 0, waiting: 0, failed: 0 });
    assert.equal((await call('/api/scheduled', TICK)).status, 404, 'a POST only');

    // The tick reaches nothing else: a request marked schedule is nobody to the management routes.
    assert.equal((await call('/api/templates', TICK)).status, 401);
    assert.equal((await call('/api/templates', identity('org-a', { via: 'schedule' }))).status, 401, 'whatever identity it carries');
    assert.equal((await call('/api/process-due', identity('org-a', { via: 'schedule' }), { method: 'POST' })).status, 401);
    const preview = await app.fetch(new Request('http://localhost/api/templates', { headers: TICK }), { ...env, IDENTITY_PREVIEW: true } as never);
    assert.equal(preview.status, 401, "not even the local preview's stand-in owner");

    const catalog = await (await call('/api/catalog', identity('org-a', { role: 'OWNER' }))).json() as { endpoints: { path: string }[] };
    assert.equal(catalog.endpoints.some((e) => e.path === '/api/scheduled'), false, 'never in the catalog');
    const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { insulin: { scheduled: string; publicPaths: string[] } };
    assert.equal(declared.insulin.scheduled, '/api/scheduled', 'the path the platform ticks');
    assert.equal(declared.insulin.publicPaths.some((entry) => entry === '/api/scheduled' || '/api/scheduled'.startsWith(entry.endsWith('/') ? entry : `${entry}/`)), false, 'never public');
  } finally { await mf.dispose(); }
});

test('the tick finishes due work for every organization at once; process-due stays with its own', async () => {
  const { mf, db, call } = await harness();
  try {
    for (const org of ['org-a', 'org-b']) {
      await db.prepare("INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) VALUES (?1, ?2, ?3, '[\"signer\"]', 1)").bind(`tpl-${org}`, org, `templates/${org}.pdf`).run();
      for (const kind of ['late', 'stuck'])
        await db.prepare("INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256) VALUES (?1, ?2, ?3, 'IN_PROGRESS', 1, 'x')").bind(`${kind}-${org}`, org, `tpl-${org}`).run();
      // Past its signer's deadline: expired by due work.
      await db.prepare("INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status, expires_at) VALUES (?1, ?2, 'signer', 'Ana Example', 'ana@example.com', 1, 'ACTIVE', 1)").bind(`late-task-${org}`, `late-${org}`).run();
      // A signer a lost write never activated: due work activates them.
      await db.prepare("INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status) VALUES (?1, ?2, 'signer', 'Marcus Example', 'marcus@example.com', 1, 'PENDING')").bind(`stuck-task-${org}`, `stuck-${org}`).run();
    }
    const ran = await call('/api/scheduled', TICK, { method: 'POST' });
    assert.equal(ran.status, 200);
    assert.deepEqual(await ran.json(), { expired: 2, completed: 0, waiting: 2, failed: 0 }, 'both organizations, in one tick');
    const statuses = Object.fromEntries((await db.prepare('SELECT id, status FROM envelopes ORDER BY id').all<{ id: string; status: string }>()).results.map((row) => [row.id, row.status]));
    assert.deepEqual(statuses, { 'late-org-a': 'EXPIRED', 'late-org-b': 'EXPIRED', 'stuck-org-a': 'IN_PROGRESS', 'stuck-org-b': 'IN_PROGRESS' });
    const tasks = (await db.prepare("SELECT status FROM tasks WHERE id LIKE 'stuck-task-%'").all<{ status: string }>()).results.map((row) => row.status);
    assert.deepEqual(tasks, ['ACTIVE', 'ACTIVE']);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'EXPIRED'").first<{ n: number }>())?.n, 2, 'one audit event each');
    assert.deepEqual(await (await call('/api/scheduled', TICK, { method: 'POST' })).json(), { expired: 0, completed: 0, waiting: 0, failed: 0 }, 'nothing is left for the next tick');

    await db.prepare("UPDATE tasks SET expires_at = 1 WHERE id IN ('stuck-task-org-a', 'stuck-task-org-b')").run();
    const due = await call('/api/process-due', identity('org-a', { role: 'EDITOR' }), { method: 'POST' });
    assert.deepEqual(await due.json(), { expired: 1, completed: 0, waiting: 0, failed: 0 }, "a manager's process-due is their organization's only");
    assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id = 'stuck-org-b'").first<{ status: string }>())?.status, 'IN_PROGRESS');
  } finally { await mf.dispose(); }
});
