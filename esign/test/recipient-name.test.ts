import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assertRenderableRecipientNames } from '../src/field-render.ts';

test('recipient-name validation matches the rendered signature page width boundary', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const availableWidth = page.getWidth() - 100;
  let name = '';
  while (font.widthOfTextAtSize(`Name: ${name}W`, 12) <= availableWidth) name += 'W';
  assert.ok(name.length > 0 && name.length < 200);
  assert.ok(font.widthOfTextAtSize(`Name: ${name}`, 12) <= availableWidth);
  assert.ok(font.widthOfTextAtSize(`Name: ${name}W`, 12) > availableWidth);
  await assertRenderableRecipientNames([name]);
  await assert.rejects(() => assertRenderableRecipientNames([`${name}W`]), /unsupported recipient name/i);
});

test('kerning pairs are measured as unadjusted glyph advances used by drawText', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const availableWidth = page.getWidth() - 100;
  const unadjusted = (text: string) => Array.from(text, char => font.widthOfTextAtSize(char, 12)).reduce((a, b) => a + b, 0);
  let pairs = 1;
  while (unadjusted(`Name: ${'AV'.repeat(pairs + 1)}`) <= availableWidth) pairs++;
  const fits = 'AV'.repeat(pairs);
  const overflow = 'AV'.repeat(pairs + 1);
  assert.ok(unadjusted(`Name: ${fits}`) <= availableWidth);
  assert.ok(unadjusted(`Name: ${overflow}`) > availableWidth);
  assert.ok(font.widthOfTextAtSize(`Name: ${overflow}`, 12) <= availableWidth, 'fixture must expose the kerning discrepancy');
  page.drawText(`Name: ${overflow}`, { x: 50, y: 700, size: 12, font });
  const operators = (page as any).getContentStream().getContentsString();
  assert.match(operators, /<[^>]+> Tj/);
  assert.doesNotMatch(operators, /\] TJ/);
  await assertRenderableRecipientNames([fits]);
  await assert.rejects(() => assertRenderableRecipientNames([overflow]), /unsupported recipient name/i);
});
