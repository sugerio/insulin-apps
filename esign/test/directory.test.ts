// Who in the organization can use Esign, as the platform says (directory.ts): GET /__insulin/members over the
// gateway's binding, with the app's token and the organization. People to share with are its; an API client's people
// must be among them; and without it (or when it fails), the people Esign has seen. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { identity, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const ORIGIN = 'https://esign.example.test';
const DIRECTORY = [
  { id: 'user-ana', name: 'Ana Example', email: 'ana@example.test' },
  { id: 'user-new', name: 'Nina Newcomer', email: 'nina@example.test' },
  { id: 'user-olga', name: 'Olga Owner', email: 'olga@example.test' },
];

async function setup(answer: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  const calls: { url: URL; headers: Headers }[] = [];
  const env = {
    DB: db,
    SUGER_MEMBERS_URL: 'https://apps.example.test/__insulin/members',
    SUGER_APP_TOKEN: 'app-token-for-esign',
    MEMBERS_FETCH: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, headers: new Headers(init.headers) });
      return answer(url, init);
    }) as typeof fetch,
  };
  const person = (name: string, role: 'EDITOR' | 'OWNER' = 'EDITOR') => identity('tenant', { userId: `user-${name}`, email: `${name}@example.test`, role });
  const req = (path: string, headers: Record<string, string>, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } }), env);
  return { mf, db, calls, req, ana: person('ana'), owner: person('olga', 'OWNER') };
}
const directoryAnswer = (url: URL) => {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  return Response.json({ members: DIRECTORY.filter((m) => !q || m.email.includes(q) || m.name.toLowerCase().includes(q)).slice(0, Number(url.searchParams.get('limit'))) });
};

test('people to share with are those the platform says can use Esign, someone who never opened it included', async () => {
  const h = await setup(directoryAnswer);
  try {
    const found = await (await h.req('/api/members?q=nina&limit=5', h.ana)).json() as { members: unknown[] };
    assert.deepEqual(found.members, [{ id: 'user-new', name: 'Nina Newcomer', email: 'nina@example.test' }]);
    const call = h.calls.at(-1)!;
    assert.equal(call.url.pathname, '/__insulin/members');
    assert.deepEqual([call.url.searchParams.get('q'), call.url.searchParams.get('limit')], ['nina', '5']);
    assert.equal(call.headers.get('authorization'), 'Bearer app-token-for-esign');
    assert.equal(call.headers.get('x-suger-organization-id'), 'tenant');
  } finally { await h.mf.dispose(); }
});

test('without an answer from the platform, the people Esign has seen', async () => {
  const h = await setup(() => new Response('unavailable', { status: 503 }));
  try {
    await h.req('/api/me', h.ana);
    const found = await (await h.req('/api/members?q=ana', h.owner)).json() as { members: { email: string }[] };
    assert.deepEqual(found.members.map((m) => m.email), ['ana@example.test']);
  } finally { await h.mf.dispose(); }
});

test("an API client's people must be people who can use Esign", async () => {
  const h = await setup(directoryAnswer);
  try {
    assert.equal((await h.req('/api/client-settings/sa-1?name=Host', h.owner)).status, 200);
    const save = (people: string[]) => h.req('/api/client-settings/sa-1', h.owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people }) });
    const refused = await save(['ana@example.test', 'stranger@example.test']);
    assert.deepEqual([refused.status, await refused.json()], [422, { error: 'not_members', emails: ['stranger@example.test'] }]);
    const saved = await save(['NINA@example.test']);
    assert.equal(saved.status, 200, 'compared without regard to case; someone who never opened Esign is fine');
    assert.equal((await save([])).status, 200, 'nobody: the platform is not asked');
  } finally { await h.mf.dispose(); }
});
