// A save the server refused (a 422, or a 409 source_changed) saved nothing (ui/EditorPage.ts): the editor says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusal, refusedSave } from '../src/app/ui/EditorPage.ts';

test('a refused save says why, and is marked as refused (not uncertain)', () => {
  assert.equal(refusal({ error: 'invalid_signing_fields', message: 'Role seller: missing Signature field' }).message, 'Role seller: add a Signature field.');
  assert.equal(refusal({ error: 'invalid_signing_fields', message: 'Role seller: no required Signature field' }).message, 'Role seller: make at least one Signature field required.');
  assert.equal(refusal({ error: 'invalid_signing_fields', message: 'At most 20 fields' }).message, 'At most 20 fields.');
  assert.match(refusal({ error: 'invalid_pdf_or_fields' }).message, /overlap/);
  assert.match(refusal({ error: 'invalid_roles' }).message, /open it again/);
  // The draft's document was replaced while this editor was open: nothing saved, and it says to open the editor again.
  assert.equal(refusal({ error: 'source_changed' }).message, 'The document was replaced since the editor opened: open the editor again to place the fields on it.');
  assert.match(refusal({}).message, /weren't accepted/);
  // A PDF chosen in the editor that Esign can't prepare for signing: why, and what to do.
  assert.match(refusal({ error: 'invalid_pdf_or_fields', reason: 'pdf_encrypted' }).message, /password-protected or encrypted/);
  assert.match(refusal({ error: 'invalid_pdf_or_fields', reason: 'pdf_page_size', page: 4 }).message, /^Page 4 is empty or larger than 200 inches/);
  assert.match(refusal({ error: 'invalid_pdf_or_fields', reason: 'something_new' }).message, /overlap/, 'an unknown reason falls back on the error');
  assert.equal(refusal({}).refused, true);
});

test('which failed saves are refusals the editor explains: a 422, but not a draft where none is allowed; a replaced document', () => {
  assert.equal(refusedSave(422, { error: 'invalid_pdf_or_fields' }), true);
  assert.equal(refusedSave(422, { error: 'draft_not_allowed' }), false);
  assert.equal(refusedSave(409, { error: 'source_changed' }), true, 'the draft\'s document was replaced: open the editor again');
  assert.equal(refusedSave(409, { error: 'not_draft' }), false, 'any other conflict leaves the result to be checked');
  assert.equal(refusedSave(500, {}), false);
});
