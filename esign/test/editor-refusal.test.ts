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
  assert.equal(refusal({}).refused, true);
});
