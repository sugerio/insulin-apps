// The name a completed envelope's signed PDF is saved under (server/esign/signed-file-name.ts), and how a response
// carries it (Content-Disposition) to the member pages (member/api.ts). Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDisposition, signedFileName } from '../src/app/server/esign/signed-file-name.ts';
import { fileNameOf } from '../src/app/member/api.ts';

const AT = Date.parse('2026-11-13T22:57:00Z'), ID = 'd97b36df-fbca-8f5e-ae12-e057cde409ee';

test('a signed PDF is named by its document and the day it was completed', () => {
  assert.equal(signedFileName('Reseller Agreement 3', AT, ID), 'Reseller Agreement 3 - Signed 2026-11-13.pdf');
  assert.equal(signedFileName('Reseller Agreement 3', AT, ID, true), 'Reseller Agreement 3 - Signed 2026-11-13 (local test).pdf');
  assert.equal(signedFileName(undefined, AT, ID), 'Envelope d97b36df - Signed 2026-11-13.pdf', 'without a name, its short id');
  assert.equal(signedFileName('  ', AT, ID), 'Envelope d97b36df - Signed 2026-11-13.pdf');
  assert.equal(signedFileName('NDA: Acme / Beta "v2"?', AT, ID), 'NDA Acme Beta v2 - Signed 2026-11-13.pdf', 'what no file system takes is dropped');
  assert.equal(signedFileName('..hidden', AT, ID), 'hidden - Signed 2026-11-13.pdf');
  assert.equal(signedFileName('x'.repeat(300), AT, ID).length, 120 + ' - Signed 2026-11-13.pdf'.length);
  assert.equal(signedFileName('Contrat signé', Number.NaN, ID), 'Contrat signé - Signed.pdf');
});

test('the name travels in Content-Disposition, exactly as filename* and in ASCII as filename, and the pages read it', () => {
  const header = contentDisposition('attachment', 'Contrat signé (v2) - Signed 2026-11-13.pdf');
  assert.equal(header, `attachment; filename="Contrat sign_ (v2) - Signed 2026-11-13.pdf"; filename*=UTF-8''Contrat%20sign%C3%A9%20%28v2%29%20-%20Signed%202026-11-13.pdf`);
  const response = (value?: string) => new Response('', value ? { headers: { 'content-disposition': value } } : {});
  assert.equal(fileNameOf(response(header), 'fallback.pdf'), 'Contrat signé (v2) - Signed 2026-11-13.pdf');
  assert.equal(fileNameOf(response('inline; filename="plain.pdf"'), 'fallback.pdf'), 'plain.pdf');
  assert.equal(fileNameOf(response(), 'fallback.pdf'), 'fallback.pdf');
  assert.equal(fileNameOf(response(`inline; filename="ok.pdf"; filename*=UTF-8''%E0%A4%A`), 'fallback.pdf'), 'ok.pdf', 'a malformed escape falls back');
});
