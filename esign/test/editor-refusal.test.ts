// A save the server refused (422) saved nothing (ui/EditorPage.ts): the editor says why, and the fields stay editable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusal } from '../src/app/ui/EditorPage.ts';

test('a refused save says why, and is marked as refused (not uncertain)', () => {
  assert.equal(refusal({ error: 'invalid_signing_fields', message: 'Role seller: missing Signature field' }).message, 'Role seller: add a Signature field.');
  assert.equal(refusal({ error: 'invalid_signing_fields', message: 'Role seller: no required Signature field' }).message, 'Role seller: make at least one Signature field required.');
  assert.equal(refusal({ error: 'invalid_signing_fields', message: 'At most 20 fields' }).message, 'At most 20 fields.');
  assert.match(refusal({ error: 'invalid_pdf_or_fields' }).message, /overlap/);
  assert.match(refusal({ error: 'invalid_roles' }).message, /open it again/);
  assert.match(refusal({}).message, /weren't accepted/);
  // A PDF chosen in the editor that Esign can't prepare for signing: why, and what to do.
  assert.match(refusal({ error: 'invalid_pdf_or_fields', reason: 'pdf_encrypted' }).message, /password-protected or encrypted/);
  assert.match(refusal({ error: 'invalid_pdf_or_fields', reason: 'pdf_page_size', page: 4 }).message, /^Page 4 is empty or larger than 200 inches/);
  assert.match(refusal({ error: 'invalid_pdf_or_fields', reason: 'something_new' }).message, /overlap/, 'an unknown reason falls back on the error');
  assert.equal(refusal({}).refused, true);
});
