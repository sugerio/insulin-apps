import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {V3_TEXT_ATLAS_BASE64} from '../src/positioned-v3-text-atlas.ts';
import {renderPositionedV3Text,V3_TEXT_RENDERER,V3_TEXT_ATLAS_HASH} from '../src/positioned-v3-text-render.ts';

function pixels(png:Uint8Array){
 const data=Buffer.from(png);assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');const width=data.readUInt32BE(16),height=data.readUInt32BE(20);let i=8;const chunks:Buffer[]=[];
 while(i<data.length){const n=data.readUInt32BE(i),type=data.toString('ascii',i+4,i+8);if(type==='IDAT')chunks.push(data.subarray(i+8,i+8+n));i+=n+12;}
 return {width,height,bytes:inflateSync(Buffer.concat(chunks))};
}
test('v3 text artwork has deterministic bounded PNG bytes and distinct visible printable glyphs',async()=>{
 assert.match(V3_TEXT_RENDERER,/v2/);assert.equal(createHash('sha256').update(Buffer.from(V3_TEXT_ATLAS_BASE64,'base64')).digest('hex'),V3_TEXT_ATLAS_HASH);
 for(const text of ['Chief Executive, A/B & Co.','2023-11-14T22:13:20.123Z','x'.repeat(128)]){
  const bytes=await renderPositionedV3Text(text);assert.deepEqual(await renderPositionedV3Text(text),bytes);const image=pixels(bytes);
  assert.ok(image.width<text.length*24);assert.equal(image.height,32);assert.ok(image.bytes.some((v,i)=>i%(image.width*4+1)!==0&&v!==0));
 }
 const glyphs=new Set<string>();for(let c=33;c<=126;c++){const image=pixels(await renderPositionedV3Text(String.fromCharCode(c)));assert.ok(image.bytes.some(v=>v!==0),`invisible glyph ${c}`);glyphs.add(image.bytes.toString('hex'));}assert.equal(glyphs.size,94);
 const a=pixels(await renderPositionedV3Text('A')),span=(y:number)=>{const xs=Array.from({length:a.width},(_,x)=>x).filter(x=>a.bytes[y*(a.width*4+1)+1+x*4+3]);return xs.length?xs[xs.length-1]-xs[0]+1:0;};assert.ok(span(10)<span(25),'A must be upright');
 for(const text of ['', ' '.repeat(4),' leading','trailing ', 'a\nb','é','x'.repeat(129)])await assert.rejects(()=>renderPositionedV3Text(text));
});

test('date digits use compact proportional spacing in upright text',async()=>{const image=pixels(await renderPositionedV3Text('2026-11-04'));assert.ok(image.width<10*18);assert.equal(image.height,32);});
