import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {timestampQuery} from '../src/worker-tsa-transport.ts';

test('the timestamp query is parseable by OpenSSL and binds the imprint and nonce', ()=>{
 const imprint=new Uint8Array(32).fill(0x2a),nonce=Uint8Array.from({length:16},(_,i)=>i===0?1:i);
 const query=timestampQuery(imprint,nonce);
 const output=execFileSync('openssl',['ts','-query','-text','-in','/dev/stdin'],{input:query,stdio:['pipe','pipe','pipe']}).toString();
 assert.match(output,/Hash Algorithm: sha256/);assert.match(output,/Certificate required: yes/);
 assert.ok(output.includes(Buffer.from(nonce).toString('hex').toUpperCase()));assert.ok(Buffer.from(query).includes(Buffer.from(imprint)));
});

test('the timestamp query refuses an imprint that is not a SHA-256 digest and a nonce that is not 16 bytes starting with 1', ()=>{
 const nonce=new Uint8Array(16);nonce[0]=1;
 assert.throws(()=>timestampQuery(new Uint8Array(31),nonce),/Invalid timestamp query/);
 assert.throws(()=>timestampQuery(new Uint8Array(32),nonce.subarray(1)),/Invalid timestamp query/);
 assert.throws(()=>timestampQuery(new Uint8Array(32),new Uint8Array(16)),/Invalid timestamp query/);
});
