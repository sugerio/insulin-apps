import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readCandidateUpload} from '../src/candidate-upload-body.ts';

test('upload deadline covers the entire reader lifetime and cancels a paused source',async()=>{
 let cancelled=0, pulls=0;
 const stream=new ReadableStream<Uint8Array>({pull(c){if(++pulls===1)c.enqueue(new Uint8Array([1]));},cancel(){cancelled++;}},{highWaterMark:0});
 await assert.rejects(readCandidateUpload(stream,30),/deadline/);
 assert.equal(cancelled,1); assert.equal(stream.locked,false);
});

test('upload read errors cancel and release the reader',async()=>{
 let cancelled=0;
 const stream=new ReadableStream<Uint8Array>({pull(){throw Error('source failure');},cancel(){cancelled++;}},{highWaterMark:0});
 await assert.rejects(readCandidateUpload(stream,100),/source failure/);
 assert.equal(stream.locked,false);
});

test('fragmented upload preserves exact bytes and rejects excessive tiny or empty chunks',async()=>{
 const expected=Uint8Array.from({length:20000},(_,i)=>i%251); let index=0;
 const valid=new ReadableStream<Uint8Array>({pull(c){if(index===expected.length)c.close();else {c.enqueue(expected.subarray(index,index+1));index++;}}},{highWaterMark:0});
 assert.deepEqual(await readCandidateUpload(valid,5000),expected);
 for(const byteLength of [0,1]){
  let pulls=0,cancelled=0;
  const stream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array(byteLength));},cancel(){cancelled++;}},{highWaterMark:0});
  await assert.rejects(readCandidateUpload(stream,5000),/chunks/);
  assert.ok(pulls<=65537); assert.equal(cancelled,1); assert.equal(stream.locked,false);
 }
});

test('upload enforces exact byte limit and copies source chunks',async()=>{
 const limit=5*1024*1024+65536;
 const bytes=new Uint8Array(limit); bytes[0]=12;bytes[limit-1]=34;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close();}});
 const result=await readCandidateUpload(stream); bytes[0]=99;
 assert.equal(result.length,limit);assert.equal(result[0],12);assert.equal(result[limit-1],34);
 let cancelled=0;const overflow=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(limit+1));},cancel(){cancelled++;}},{highWaterMark:0});
 await assert.rejects(readCandidateUpload(overflow),/too large/);assert.equal(cancelled,1);assert.equal(overflow.locked,false);
});

test('deadline does not await stalled cancellation or leave an unhandled rejection',async()=>{
 let cancelled=0; const unhandled:unknown[]=[];const onUnhandled=(error:unknown)=>unhandled.push(error);
 process.on('unhandledRejection',onUnhandled);
 const stream=new ReadableStream<Uint8Array>({pull(){},cancel(){cancelled++;return new Promise<void>(()=>{});}},{highWaterMark:0});
 try {
  await assert.rejects(readCandidateUpload(stream,20),/deadline/);
  assert.equal(cancelled,1);assert.equal(stream.locked,false);
  await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(unhandled,[]);
 } finally {process.off('unhandledRejection',onUnhandled);}
});
