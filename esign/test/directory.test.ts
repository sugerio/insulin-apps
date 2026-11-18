// Who in the organization can use Esign, as the platform says (directory.ts): the gateway's member lookup, over its
// binding with the app's token and the x-suger-member-lookup header the gateway signed on the browser request Esign is
// serving. People to share with are its; an API client's people must be among them, each address looked up; and
// without it (no header, or when it fails), the people Esign has seen. Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { identity, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const ORIGIN = 'https://esign.example.test';
const LOOKUP = 'v1.tenant.user-signed.1900000000.synthetic-signature';
const DIRECTORY = [
  { type: 'person', id: 'user-ana', name: 'Ana Example', email: 'ana@example.test', appRole: 'EDITOR' },
  { type: 'person', id: 'user-new', name: 'Nina Newcomer', email: 'nina@example.test', appRole: 'EDITOR' },
  { type: 'person', id: 'user-olga', name: 'Olga Owner', email: 'olga@example.test', appRole: 'ADMIN' },
  // The lookup also finds the app's API clients, which are no one to share with.
  { type: 'client', id: 'sa-nightly', name: 'Nina nightly sync' },
];

async function setup(answer: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
  const calls: { url: URL; headers: Headers }[] = [];
  const env = {
    DB: db,
    TRUST_ORG_ROLE: true,
    SUGER_MEMBERS_URL: 'https://apps.example.test/__insulin/members',
    SUGER_APP_TOKEN: 'app-token-for-esign',
    MEMBERS_FETCH: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, headers: new Headers(init.headers) });
      return answer(url, init);
    }) as typeof fetch,
  };
  // A browser request, as the gateway forwards it: with the member lookup header it signed.
  const person = (name: string, role: 'EDITOR' | 'ADMIN' = 'EDITOR', orgRole = role) => ({
    ...identity('tenant', { userId: `user-${name}`, email: `${name}@example.test`, role, orgRole, via: 'browser' }), 'x-suger-member-lookup': LOOKUP,
  });
  const req = (path: string, headers: Record<string, string>, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } }), env);
  return { mf, db, calls, req, ana: person('ana'), owner: person('olga', 'ADMIN', 'OWNER') };
}
// As the gateway answers: only with the header, whose name or email contains q, at most 20.
const directoryAnswer = (url: URL, init: RequestInit) => {
  if (new Headers(init.headers).get('x-suger-member-lookup') !== LOOKUP) return Response.json({ error: 'invalid_member_lookup' }, { status: 403 });
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  if (!q || q.length > 100) return Response.json({ error: 'invalid_request' }, { status: 400 });
  return Response.json({ members: DIRECTORY.filter((m) => ('email' in m && m.email.includes(q)) || m.name.toLowerCase().includes(q)).slice(0, 20) });
};

test('people to share with are those the platform finds for the person asking, someone who never opened Esign included', async () => {
  const h = await setup(directoryAnswer);
  try {
    const found = await (await h.req('/api/members?q=nina&limit=5', h.ana)).json() as { members: unknown[] };
    assert.deepEqual(found.members, [{ id: 'user-new', name: 'Nina Newcomer', email: 'nina@example.test' }], 'who they are, not their roles; no API client');
    const call = h.calls.at(-1)!;
    assert.equal(call.url.pathname, '/__insulin/members');
    assert.deepEqual([...call.url.searchParams], [['q', 'nina']]);
    assert.equal(call.headers.get('authorization'), 'Bearer app-token-for-esign');
    assert.equal(call.headers.get('x-suger-member-lookup'), LOOKUP, 'the header of the request Esign is serving');
    assert.equal(call.headers.get('x-suger-organization-id'), null, 'the platform takes the organization from the header, never from Esign');
    const capped = await (await h.req('/api/members?q=example&limit=2', h.ana)).json() as { members: unknown[] };
    assert.equal(capped.members.length, 2, 'at most the limit asked for');
  } finally { await h.mf.dispose(); }
});

test('without an answer from the platform, or a request it can answer for, the people Esign has seen', async () => {
  const h = await setup(() => new Response('unavailable', { status: 503 }));
  try {
    await h.req('/api/me', h.ana);
    const found = await (await h.req('/api/members?q=ana', h.owner)).json() as { members: { email: string }[] };
    assert.deepEqual(found.members.map((m) => m.email), ['ana@example.test']);
  } finally { await h.mf.dispose(); }
  const quiet = await setup(directoryAnswer);
  try {
    await quiet.req('/api/me', quiet.ana);
    // An API client's request (and an AI agent's) carries no lookup header: the platform isn't asked.
    const client = identity('tenant', { userId: 'sa-host', role: 'EDITOR', via: 'api' });
    const found = await (await quiet.req('/api/members?q=nina', client)).json() as { members: { email: string }[] };
    assert.deepEqual([found.members, quiet.calls.length], [[], 0], 'nobody by that name has used Esign');
    const seen = (await (await quiet.req('/api/members', quiet.owner)).json() as { members: { email: string }[] }).members.map((m) => m.email);
    assert.ok(seen.includes('ana@example.test'), 'without q, those seen');
    assert.equal(quiet.calls.length, 0);
  } finally { await quiet.mf.dispose(); }
});

test("an API client's people must be people who can use Esign, each address looked up", async () => {
  const h = await setup(directoryAnswer);
  try {
    assert.equal((await h.req('/api/client-settings/sa-1?name=Host', h.owner)).status, 200);
    const save = (people: string[]) => h.req('/api/client-settings/sa-1', h.owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people }) });
    const refused = await save(['ana@example.test', 'stranger@example.test']);
    assert.deepEqual([refused.status, await refused.json()], [422, { error: 'not_members', emails: ['stranger@example.test'] }]);
    h.calls.length = 0;
    const saved = await save(['NINA@example.test', 'nina@example.test']);
    assert.equal(saved.status, 200, 'compared without regard to case; someone who never opened Esign is fine');
    assert.deepEqual(h.calls.map((call) => call.url.searchParams.get('q')), ['NINA@example.test'], 'each address once');
    h.calls.length = 0;
    assert.equal((await save([])).status, 200, 'nobody: the platform is not asked');
    assert.equal(h.calls.length, 0);
    // An address the lookup finds only inside a longer one is no match.
    assert.equal((await save(['na@example.test'])).status, 422);
  } finally { await h.mf.dispose(); }
  // A lookup the platform doesn't answer (too many at once, say) is no answer: the people Esign has seen, instead.
  const busy = await setup((url, init) => url.searchParams.get('q') === 'nina@example.test' ? new Response('slow down', { status: 429 }) : directoryAnswer(url, init));
  try {
    await busy.req('/api/client-settings/sa-1?name=Host', busy.owner);
    const unchecked = await busy.req('/api/client-settings/sa-1', busy.owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people: ['ana@example.test', 'nina@example.test'] }) });
    assert.deepEqual([unchecked.status, await unchecked.json()], [422, { error: 'not_members', emails: ['ana@example.test', 'nina@example.test'] }], 'neither has been seen');
  } finally { await busy.mf.dispose(); }
});

test("an API client's person is found by address however many others' addresses contain theirs", async () => {
  // As the gateway answers (db/members.ts): an address that is the text itself first, then by name, at most 20.
  const crowd = Array.from({ length: 20 }, (_, i) => ({ type: 'person', id: `user-crowd-${i}`, name: `Aaron Crowd ${String(i).padStart(2, '0')}`, email: `person${i}+eva@example.test` }));
  const people = [...crowd, { type: 'person', id: 'user-eva', name: 'Zed Target', email: 'eva@example.test' }];
  const h = await setup((url, init) => {
    if (new Headers(init.headers).get('x-suger-member-lookup') !== LOOKUP) return Response.json({ error: 'invalid_member_lookup' }, { status: 403 });
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const found = people.filter((m) => m.email.includes(q) || m.name.toLowerCase().includes(q));
    found.sort((a, b) => Number(b.email === q) - Number(a.email === q) || a.name.localeCompare(b.name));
    return Response.json({ members: found.slice(0, 20) });
  });
  try {
    await h.req('/api/client-settings/sa-1?name=Host', h.owner);
    const saved = await h.req('/api/client-settings/sa-1', h.owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people: ['eva@example.test'] }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual((await saved.json() as { people: { email: string }[] }).people.map((p) => p.email), ['eva@example.test']);
  } finally { await h.mf.dispose(); }
});

test("without an answer from the platform, an API client's people must be people Esign has seen", async () => {
  const h = await setup(() => new Response('unavailable', { status: 503 }));
  try {
    await h.req('/api/me', h.ana);
    await h.req('/api/client-settings/sa-1?name=Host', h.owner);
    const save = (people: string[]) => h.req('/api/client-settings/sa-1', h.owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people }) });
    const refused = await save(['ana@example.test', 'nina@example.test']);
    assert.deepEqual([refused.status, await refused.json()], [422, { error: 'not_members', emails: ['nina@example.test'] }], 'never seen');
    assert.equal((await save(['ANA@example.test'])).status, 200);
  } finally { await h.mf.dispose(); }
});
