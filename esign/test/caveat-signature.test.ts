import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderTypedSignature,TYPED_SIGNATURE_FONT,TYPED_SIGNATURE_FONT_HASH} from '../src/app/server/esign/field-render.ts';
import {SIGNATURE_ATLAS_BASE64} from '../src/app/server/esign/fonts/signature-atlas.ts';

test('Caveat signature atlas is pinned and renders mixed case deterministically',async()=>{
 const atlas=Uint8Array.from(atob(SIGNATURE_ATLAS_BASE64),c=>c.charCodeAt(0));
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',atlas)).toString('hex');
 assert.equal(hash,TYPED_SIGNATURE_FONT_HASH);assert.equal(TYPED_SIGNATURE_FONT,'caveat-bitmap-v2');
 const image=await renderTypedSignature('Ana Smith');assert.deepEqual(image,await renderTypedSignature('Ana Smith'));
 assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',image)).toString('hex'),'b2f0511abd5367a3b67bafdbf726ebc889622c768f8444f9219e16d2949dc0e8');
 assert.notDeepEqual(image,await renderTypedSignature('ANA SMITH'));
 for(const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'){const offset=(ch.charCodeAt(0)-32)*96*128/8;assert.ok(atlas.subarray(offset,offset+96*128/8).some(v=>v!==0),`missing glyph ${ch}`);}
 for(const value of ['', ' A', 'A  B','A1','A'.repeat(65)])await assert.rejects(()=>renderTypedSignature(value));
});
