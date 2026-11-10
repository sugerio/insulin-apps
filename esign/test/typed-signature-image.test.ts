import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderTypedSignature, TYPED_SIGNATURE_FONT, TYPED_SIGNATURE_FONT_HASH} from '../src/app/server/esign/field-render.ts';

test('controlled signature text renders a deterministic bounded PNG',async()=>{
 const first=await renderTypedSignature('ANA SMITH');const again=await renderTypedSignature('ANA SMITH');
 assert.deepEqual(first,again);assert.deepEqual([...first.slice(0,8)],[137,80,78,71,13,10,26,10]);
 assert.equal(TYPED_SIGNATURE_FONT,'caveat-bitmap-v2');assert.match(TYPED_SIGNATURE_FONT_HASH,/^[a-f0-9]{64}$/);
 assert.notDeepEqual(first,await renderTypedSignature('MARCUS'));
 for(const invalid of ['', ' ', 'A'.repeat(65), 'A\nB', '<script>', '张']) await assert.rejects(()=>renderTypedSignature(invalid));
});
