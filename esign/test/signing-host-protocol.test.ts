// What the signing page tells its host (ui/signing-host-protocol.ts), and the facts the page shows
// on its three steps (ui/RecipientPage.ts). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readSigningHostMessage, signingHost } from '../src/app/ui/signing-host-protocol.ts';
import { afterSigningLines, dateText, fingerprintText, hostSignInText, RecipientPage } from '../src/app/ui/RecipientPage.ts';
import { renderToStaticMarkup } from 'react-dom/server';

const CONSOLE = 'https://console.example.test';
const APP = 'https://esign.example.test';

test('the page reports only to a framing host the Worker allows, and that framed it', () => {
  const allowed = `${APP} ${CONSOLE}`;
  assert.equal(signingHost(CONSOLE, allowed, true), CONSOLE);
  assert.equal(signingHost(CONSOLE, allowed, true, CONSOLE), CONSOLE, 'the framing page is that host');
  assert.equal(signingHost(CONSOLE, allowed, true, 'https://other.example.test'), '', 'another page frames it');
  assert.equal(signingHost(CONSOLE, allowed, false), '', 'not framed');
  assert.equal(signingHost(null, allowed, true), '', 'the link names no host');
  assert.equal(signingHost('https://evil.example.test', allowed, true), '', 'not allowed to frame the page');
  assert.equal(signingHost(`${CONSOLE}/path`, `${CONSOLE}/path`, true), '', 'an origin, not a URL');
  assert.equal(signingHost('*', '*', true), '', 'never every origin');
});

test('a host reads only the signing page\'s own messages, from its frame and origin', () => {
  const frame = {};
  const from = (data: unknown, origin = APP, source: unknown = frame) => readSigningHostMessage({ origin, source, data }, APP, frame);
  assert.deepEqual(from({ type: 'esign.signing.cancel' }), { type: 'esign.signing.cancel' });
  assert.deepEqual(from({ type: 'esign.signing.finished', outcome: 'signed' }), { type: 'esign.signing.finished', outcome: 'signed' });
  assert.deepEqual(from({ type: 'esign.signing.finished', outcome: 'declined' }), { type: 'esign.signing.finished', outcome: 'declined' });
  assert.equal(from({ type: 'esign.signing.finished', outcome: 'voided' }), null);
  assert.equal(from({ type: 'esign.signing.cancel', extra: 1 }), null, 'nothing more than the message');
  assert.equal(from({ type: 'esign.signing.cancel' }, 'https://other.example.test'), null, 'another origin');
  assert.equal(from({ type: 'esign.signing.cancel' }, APP, {}), null, 'another frame');
  assert.equal(from('esign.signing.cancel'), null);
  assert.equal(readSigningHostMessage({ origin: APP, source: frame, data: { type: 'esign.signing.cancel' } }, APP, null), null, 'no frame yet');
});

test('the page shows a fingerprint, a date and the host\'s sign-in the way people read them', () => {
  assert.equal(fingerprintText(`9f2c41ae07d3${'0'.repeat(44)}5b19a71e`), '9f2c 41ae 07d3 … 5b19 a71e');
  assert.equal(fingerprintText('not-a-hash'), 'not-a-hash');
  assert.equal(dateText('2026-09-02T00:00:00.000Z'), 'Sep 2, 2026');
  assert.equal(dateText('nope'), '');
  assert.equal(hostSignInText({ method: 'SSO', provider: 'Google Workspace', domain: 'northbeam.test', signedInAt: '2026-10-23T10:31:00.000Z' }), 'Google Workspace · northbeam.test · 10:31 UTC');
  assert.equal(hostSignInText({ method: 'ENTERPRISE_SSO' }), 'Enterprise sso');
});

test('After you sign: the copy, who signs next (or that nobody does), then the host\'s own lines', () => {
  const text = (lines: React.ReactNode[]) => lines.map(line => renderToStaticMarkup(React.createElement(React.Fragment, null, line)).replace(/<[^>]+>/g, ''));
  const sender = { name: 'Bryan Dunn', organization: 'Pigment' };
  assert.deepEqual(text(afterSigningLines({ sender, signers: { before: 0, after: 1, next: { name: 'Marcus Lee', organization: 'Pigment' } }, afterSigning: ['Your onboarding moves on to: Complete your profile.'] })), [
    'You and Pigment get the signed PDF and its certificate of completion.',
    'Pigment countersigns next.',
    'Your onboarding moves on to: Complete your profile.',
  ]);
  assert.deepEqual(text(afterSigningLines({ sender, signers: { before: 0, after: 0 } })), [
    'You and Pigment get the signed PDF and its certificate of completion.',
    'Pigment countersign is not required for this agreement.',
  ]);
  assert.deepEqual(text(afterSigningLines({ sender, signers: { before: 1, after: 0 } }))[1], 'Your signature completes the agreement.');
  assert.deepEqual(text(afterSigningLines({ signers: { before: 0, after: 1, next: { name: 'Marcus Lee' } } })), [
    'You and the sender get the signed PDF and its certificate of completion.',
    'Marcus Lee signs next.',
  ]);
});

/** The signing page, served by the app and framed by the console, through all three steps. */
async function framedPage(current: Record<string, unknown>, opts: { host?: string; ancestor?: string } = {}) {
  const { default: Renderer, act } = await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const posted: { message: unknown; target: string }[] = [];
  const requests: { path: string; body: any }[] = [];
  const parent = { postMessage: (message: unknown, target: string) => posted.push({ message, target }) };
  (globalThis as any).window = { location: { origin: APP, hash: `#code=test${opts.host ? `&host=${encodeURIComponent(opts.host)}` : ''}`, pathname: '/sign', ...(opts.ancestor ? { ancestorOrigins: { length: 1, 0: opts.ancestor } } : {}) }, history: { replaceState() {} }, parent };
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/public/signing-page') return Response.json({ hosts: [APP, CONSOLE], signingEnabled: true });
    if (path === '/api/public/page-sessions/exchange') return Response.json({ token: 'token' });
    if (path === '/api/public/signing/otp') return Response.json({ messageId: 'm', emailed: true });
    if (path === '/api/public/signing/otp/verify') return new Response(null, { status: 204 });
    if (path === '/api/public/signing/current') return Response.json(current);
    if (path === '/api/public/signing/pdf') return new Response(new Blob(['pdf']));
    if (path === '/api/public/signing/sign') return new Response(null, { status: 202 });
    if (path === '/api/public/signing/decline') return Response.json({ status: 'DECLINED' });
    if (path === '/api/public/signing/preview') return new Response(new Blob(['png'], { type: 'image/png' }), { headers: { 'X-Signature-Preview': 'c'.repeat(64), 'X-Signature-Width': '.5', 'X-Signature-Height': '.5' } });
    throw new Error(path);
  }) as typeof fetch;
  let renderer: any;
  await act(async () => { renderer = Renderer.create(React.createElement(RecipientPage, { renderDocument: async () => {} }), { createNodeMock: () => ({ ownerDocument: { createElement: () => ({}) }, replaceChildren() {} }) }); });
  const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
  await settle();
  const button = (text: string) => renderer.root.findAllByType('button').find((b: any) => b.children.includes(text));
  const labelled = (label: string) => renderer.root.findAll((n: any) => n.props?.['aria-label'] === label && typeof n.type === 'string')[0];
  const text = () => JSON.stringify(renderer.toJSON());
  const toSign = async () => {
    await act(async () => { button('Continue').props.onClick(); });
    await settle();
    await act(async () => { labelled('Digit 1 of 6').props.onChange({ target: { value: '123456' } }); });
    await act(async () => { await button('Verify code').props.onClick(); });
    await settle();
  };
  return { renderer, act, settle, button, labelled, text, toSign, posted, requests };
}

const restore = () => { delete (globalThis as any).window; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; };
const oldFetch = globalThis.fetch;

const CURRENT = {
  id: 'a1', sha256: 'ab'.repeat(32), documentName: 'Mutual NDA', documentVersion: { label: 'v3', publishedAt: '2026-09-02T00:00:00.000Z' },
  signerName: 'Ana Partner', recipientEmail: 'ana@northbeam.test', signer: { title: 'Partner Manager', onBehalfOf: 'Northbeam Consulting' },
  sender: { name: 'Bryan Dunn', organization: 'Pigment' }, hostAuthentication: { method: 'SSO', provider: 'Google Workspace', domain: 'northbeam.test', signedInAt: '2026-10-23T10:31:00.000Z' },
  signers: { before: 0, after: 1, next: { name: 'Marcus Lee', organization: 'Pigment' } }, afterSigning: ['Your onboarding moves on to: Complete your profile.'],
  intent: 'I agree to use electronic records and signatures, and I intend this to be my signature on the Mutual NDA (v3) on behalf of Northbeam Consulting.',
  disclosure: { version: '2026-11-07', text: 'Consent to use electronic records and signatures' },
  fields: [
    { id: 's1', type: 'Signature', page: 1, required: true, rect: { x: .1, y: .1, width: .3, height: .1 } },
    { id: 's2', type: 'Signature', page: 1, required: true, rect: { x: .1, y: .5, width: .3, height: .1 } },
  ],
  role: 'partner', recipientName: 'Ana Partner',
};

test('the three steps show what the prototype shows', async () => {
  try {
    const p = await framedPage({ ...CURRENT, fields: undefined, role: undefined, recipientName: undefined }, { host: CONSOLE, ancestor: CONSOLE });
    // Review: the document's facts, who signs, and the pages viewed.
    let out = p.text();
    for (const expected of ['Version', 'v3 · published Sep 2, 2026', 'abab abab abab … abab abab', 'ana@northbeam.test', "I'm authorized to sign for ", 'Northbeam Consulting']) assert.ok(out.includes(expected), expected);
    assert.ok(p.button('Decline to sign') && p.button('Cancel') && p.button('Continue'));
    await p.act(async () => { p.labelled('Authorized to sign').props.onChange({ target: { checked: true } }); });
    await p.act(async () => { p.button('Continue').props.onClick(); });
    await p.settle();
    // Confirm it's you: the host's sign-in, then the code.
    out = p.text();
    assert.ok(out.includes('This ties the signature to you. We check two things.'));
    assert.ok(out.includes('Signed in as ana@northbeam.test'));
    assert.ok(out.includes('Google Workspace · northbeam.test · 10:31 UTC'));
    assert.ok(out.includes('Pigment can require stronger checks, such as ID verification, for some documents.'));
    assert.ok(p.button('Back') && p.button('Verify code'));
    await p.act(async () => { p.labelled('Digit 1 of 6').props.onChange({ target: { value: '123456' } }); });
    await p.act(async () => { await p.button('Verify code').props.onClick(); });
    await p.settle();
    // Sign: the adopted name, its preview line, the one consent sentence, and what happens next.
    out = p.text();
    for (const expected of ['Adopt your signature', 'Ana Partner · Partner Manager, Northbeam Consulting · Signed electronically through E-sign', 'Mutual NDA (v3)', 'Pigment countersigns next.', 'Your onboarding moves on to: Complete your profile.', 'Read the electronic records disclosure']) assert.ok(out.includes(expected), expected);
    assert.equal(p.labelled('Full name').props.value, 'Ana Partner');
    await p.act(async () => { p.renderer.unmount(); });
  } finally { globalThis.fetch = oldFetch; restore(); }
});

test('the page tells its host when the signer cancels, signs or declines', async () => {
  try {
    const cancel = await framedPage({ ...CURRENT, fields: undefined }, { host: CONSOLE, ancestor: CONSOLE });
    await cancel.act(async () => { cancel.button('Cancel').props.onClick(); });
    assert.deepEqual(cancel.posted, [{ message: { type: 'esign.signing.cancel' }, target: CONSOLE }]);
    await cancel.act(async () => { cancel.renderer.unmount(); });

    const sign = await framedPage({ ...CURRENT, fields: undefined }, { host: CONSOLE });
    await sign.act(async () => { sign.labelled('Authorized to sign').props.onChange({ target: { checked: true } }); });
    await sign.toSign();
    await sign.act(async () => { sign.labelled('Consent to sign').props.onChange({ target: { checked: true } }); });
    await sign.act(async () => { await sign.button('Sign document').props.onClick(); });
    assert.deepEqual(sign.posted, [{ message: { type: 'esign.signing.finished', outcome: 'signed' }, target: CONSOLE }]);
    await sign.act(async () => { sign.renderer.unmount(); });

    const decline = await framedPage({ ...CURRENT, fields: undefined, verified: true }, { host: CONSOLE });
    await decline.act(async () => { decline.button('Decline to sign').props.onClick(); });
    await decline.act(async () => { decline.labelled('Reason for declining').props.onChange({ target: { value: 'Clause 4 needs changes.' } }); });
    await decline.act(async () => { await decline.button('Decline').props.onClick(); });
    await decline.settle();
    assert.deepEqual(decline.posted, [{ message: { type: 'esign.signing.finished', outcome: 'declined' }, target: CONSOLE }]);
    await decline.act(async () => { decline.renderer.unmount(); });
  } finally { globalThis.fetch = oldFetch; restore(); }
});

test('a host the Worker does not allow, or that does not frame the page, is told nothing', async () => {
  try {
    for (const opts of [{ host: 'https://evil.example.test' }, { host: CONSOLE, ancestor: 'https://evil.example.test' }, {}]) {
      const p = await framedPage({ ...CURRENT, fields: undefined }, opts);
      assert.equal(p.button('Cancel'), undefined, `no Cancel without a host: ${JSON.stringify(opts)}`);
      await p.act(async () => { p.labelled('Authorized to sign').props.onChange({ target: { checked: true } }); });
      await p.toSign();
      await p.act(async () => { p.labelled('Consent to sign').props.onChange({ target: { checked: true } }); });
      await p.act(async () => { await p.button('Sign document').props.onClick(); });
      assert.deepEqual(p.posted, [], JSON.stringify(opts));
      await p.act(async () => { p.renderer.unmount(); });
    }
  } finally { globalThis.fetch = oldFetch; restore(); }
});
