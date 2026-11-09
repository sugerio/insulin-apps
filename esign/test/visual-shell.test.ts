import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldEditor } from '../ui/FieldEditor.ts';
import { RecipientPage } from '../ui/RecipientPage.ts';

test('embedded editor and recipient use scoped visual shells', () => {
  const editor = renderToStaticMarkup(React.createElement(FieldEditor));
  const recipient = renderToStaticMarkup(React.createElement(RecipientPage));
  assert.match(editor, /class="esign-editor"/);
  assert.match(editor, /class="esign-editor-workspace"/);
  assert.match(recipient, /class="esign-recipient"/);
  assert.doesNotMatch(recipient, /local test|synthetic/i);
});
