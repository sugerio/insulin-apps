// What protects the pages: each page's security headers (page-policy.ts), the embedder check at the code exchange
// (every ancestor, not only the nearest), and the header a page session travels in (x-esign-session, never
// Authorization, which the gateway drops on public paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pageHeaders, pageKind, originsIn } from '../src/app/server/page-policy.ts';
import { embedderAllowed } from '../src/app/server/esign/signing-page.ts';
import { SESSION_HEADER, sessionToken } from '../src/app/server/esign/session-header.ts';
import { embedding } from '../src/app/ui/RecipientPage.ts';
import { isPublicPath } from './helpers/gateway.ts';
import { waitUntilOf } from '../src/app/server/wait-until.ts';

const HTML = 'text/html; charset=utf-8';
const PAGE_ID = 'a'.repeat(64);
const context = (over: Partial<Parameters<typeof pageHeaders>[2]> = {}) => ({
  frameAncestors: 'https://host.example.test https://second.example.test',
  editorParent: async () => null,
  viaGateway: true,
  ...over,
});
const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

test('each path is the page its audience opens; the API and built assets are no page', () => {
  assert.equal(pageKind('/sign'), 'signing');
  assert.equal(pageKind(`/editor/page/${PAGE_ID}`), 'editor');
  assert.equal(pageKind('/copy'), 'copy');
  for (const path of ['/', '/envelopes/x', '/templates', '/docs/glossary']) assert.equal(pageKind(path), 'member', path);
  for (const path of ['/api/me', '/api/public/signing/current', '/assets/index.js']) assert.equal(pageKind(path), null, path);
});

test('the signing page: scripts only from this origin, framed only by this origin and ESIGN_FRAME_ANCESTORS, never cached', async () => {
  const headers = (await pageHeaders('/sign', HTML, context()))!;
  const csp = headers['Content-Security-Policy']!;
  assert.equal(directive(csp, 'script-src'), "script-src 'self'");
  assert.equal(directive(csp, 'connect-src'), "connect-src 'self'");
  assert.equal(directive(csp, 'object-src'), "object-src 'none'");
  assert.equal(directive(csp, 'base-uri'), "base-uri 'none'");
  assert.equal(directive(csp, 'frame-ancestors'), "frame-ancestors 'self' https://host.example.test https://second.example.test");
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('the editor is framed by its session\'s parent, the copy page and the member pages by nobody', async () => {
  const editor = (await pageHeaders(`/editor/page/${PAGE_ID}`, HTML, context({ editorParent: async (id) => (id === PAGE_ID ? 'https://parent.example.test' : null) })))!;
  assert.equal(directive(editor['Content-Security-Policy']!, 'frame-ancestors'), "frame-ancestors 'self' https://parent.example.test");
  const unknown = (await pageHeaders(`/editor/page/${'b'.repeat(64)}`, HTML, context()))!;
  assert.equal(directive(unknown['Content-Security-Policy']!, 'frame-ancestors'), "frame-ancestors 'self' https://host.example.test https://second.example.test", 'no session: the deployment\'s hosts');
  const copy = (await pageHeaders('/copy', HTML, context()))!;
  assert.equal(directive(copy['Content-Security-Policy']!, 'frame-ancestors'), "frame-ancestors 'none'");
  const member = (await pageHeaders('/envelopes/1', HTML, context()))!;
  assert.equal(directive(member['Content-Security-Policy']!, 'frame-ancestors'), "frame-ancestors 'none'", 'a member page can\'t be framed to clickjack a send or a void');
  assert.equal(directive(member['Content-Security-Policy']!, 'frame-src'), "frame-src 'self' blob:", 'it frames the signing page and the editor itself');
});

test('frame-ancestors only behind the gateway (the console frames its own preview), and never anything that isn\'t an origin', async () => {
  const consoleHeaders = (await pageHeaders('/envelopes', HTML, context({ viaGateway: false })))!;
  assert.equal(directive(consoleHeaders['Content-Security-Policy']!, 'frame-ancestors'), '');
  assert.match(consoleHeaders['Content-Security-Policy']!, /script-src 'self'/, 'the rest of the policy stays');
  assert.deepEqual(originsIn("https://ok.example.test 'unsafe-inline' https://x.example.test/path javascript:alert(1) http://local.test:8080"), ['https://ok.example.test', 'http://local.test:8080']);
  const injected = (await pageHeaders('/sign', HTML, context({ frameAncestors: "https://ok.example.test; script-src *" })))!;
  assert.equal(directive(injected['Content-Security-Policy']!, 'frame-ancestors'), "frame-ancestors 'self'");
  assert.equal(await pageHeaders('/sign', 'application/json', context()), null, 'only HTML is a page');
});

test('the exchange checks every ancestor the browser lists, and the nearest one matches the embedder', () => {
  const own = 'https://esign.example.test', allowed = ['https://host.example.test'];
  assert.equal(embedderAllowed({ embedded: false }, own, allowed), true);
  assert.equal(embedderAllowed({ embedded: true, embedder: 'https://host.example.test' }, own, allowed), true);
  assert.equal(embedderAllowed({ embedded: true, embedder: '' }, own, allowed), false, 'a hidden embedder');
  assert.equal(embedderAllowed({ embedded: true, embedder: own, embedders: [own, 'https://host.example.test'] }, own, allowed), true);
  assert.equal(embedderAllowed({ embedded: true, embedder: 'https://host.example.test', embedders: ['https://host.example.test', 'https://evil.example.test'] }, own, allowed), false, 'an allowed host framed by a stranger');
  assert.equal(embedderAllowed({ embedded: true, embedder: own, embedders: ['https://host.example.test'] }, own, allowed), false, 'the embedder must be the nearest ancestor');
  assert.equal(embedderAllowed({ embedded: true, embedders: 'https://host.example.test' }, own, allowed), false);
  assert.equal(embedderAllowed({ embedded: true, embedders: [] }, own, allowed), false);
  const framed = { parent: {}, location: { ancestorOrigins: { length: 2, 0: 'https://host.example.test', 1: 'https://top.example.test' } } };
  assert.deepEqual(embedding(framed, ''), { embedded: true, embedder: 'https://host.example.test', embedders: ['https://host.example.test', 'https://top.example.test'] });
  const firefox = { parent: {}, location: {} };
  assert.deepEqual(embedding(firefox, 'https://host.example.test/page?x=1'), { embedded: true, embedder: 'https://host.example.test' });
});

test('a page session travels in x-esign-session, which is no Authorization and no x-suger-* header', () => {
  assert.equal(SESSION_HEADER, 'x-esign-session');
  assert.doesNotMatch(SESSION_HEADER, /^(authorization|x-suger-)/i);
  const token = 'c'.repeat(64);
  assert.equal(sessionToken(new Headers({ [SESSION_HEADER]: token })), token);
  assert.equal(sessionToken(new Headers({ authorization: `Bearer ${token}` })), '', 'Authorization never counts');
  assert.equal(sessionToken(new Headers({ [SESSION_HEADER]: 'short' })), '');
  for (const path of ['/sign', '/copy', `/editor/page/${PAGE_ID}`, '/api/public/signing/current', '/assets/x.js']) assert.ok(isPublicPath(path), path);
  for (const path of ['/', '/api/me', '/api/envelopes', '/signature', '/copyright', '/editor']) assert.equal(isPublicPath(path), false, path);
});

test('finishing an envelope runs after the signer\'s response when the runtime gives waitUntil, else in the request', async () => {
  const handed: Promise<unknown>[] = [];
  const request = Object.assign(new Request('https://esign.example.test/api/public/signing/sign'), { waitUntil(work: Promise<unknown>) { handed.push(work); } });
  const waitUntil = waitUntilOf(request)!;
  const work = Promise.resolve('sealed');
  waitUntil(work);
  assert.deepEqual(handed, [work]);
  assert.equal(waitUntilOf(new Request('https://esign.example.test/')), undefined, 'no waitUntil: the caller does the work in the request');
  const routes = await readFile(new URL('../src/app/server/esign/signing-routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /if \(c\.env\.WAIT_UNTIL\) c\.env\.WAIT_UNTIL\(work\);\s*else await work;/, 'the signing route hands the finishing work over');
});

test('the pages and the server use the session header, and its CORS allow-list names it', async () => {
  const root = new URL('../src/app/', import.meta.url);
  for (const file of ['ui/RecipientPage.ts', 'ui/EditorPage.ts', 'server/esign/signing-routes.ts', 'server/esign/editor-routes.ts']) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, /authorization\s*:\s*`Bearer/i, `${file}: no page session in Authorization`);
    assert.doesNotMatch(source, /header\('authorization'\)/, `${file}: never reads Authorization for a page session`);
  }
  const routes = await readFile(new URL('server/esign/signing-routes.ts', root), 'utf8');
  assert.match(routes, /Access-Control-Allow-Headers',`\$\{SESSION_HEADER\}, content-type`/);
});
