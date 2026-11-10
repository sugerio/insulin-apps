import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidOtpEmailAddress } from '../src/app/server/esign/email-address.ts';

test('a mail address must be one plain address, with no header injection or trailing line terminator', () => {
  for (const good of ['sign@example.com', 'ana.lee+test@mail.example.test']) assert.equal(isValidOtpEmailAddress(good), true, good);
  for (const bad of [
    '', 'sign', 'sign@example', '@example.com', 'sign@@example.com',
    'bad\r\nBcc: x@example.com', 'ana@example.com\r\nBcc: x@example.com', 'sign@example.com\n', 'sign@example.com\r\n',
    'Ana <ana@example.com>', '"ana"@example.com', 'ana@example.com, x@example.com', 'ana @example.com',
    `${'a'.repeat(243)}@example.com`,
  ]) assert.equal(isValidOtpEmailAddress(bad), false, JSON.stringify(bad));
});
