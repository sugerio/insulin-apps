import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {TEXT_ATLAS_BASE64} from '../src/app/server/esign/fonts/text-atlas.ts';
import {TEXT_ATLAS_V3_BASE64} from '../src/app/server/esign/fonts/text-atlas-v3.ts';
import {fieldRenderer,renderText,renderTextV2,storedFieldRenderer,TEXT_RENDERER,TEXT_ATLAS_HASH,TEXT_RENDERER_V2,TEXT_ATLAS_V2_HASH} from '../src/app/server/esign/field-render.ts';

const sha=(bytes:Uint8Array|Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** The coverage index of each pixel of renderText's indexed PNG, row by row (filter bytes dropped). */
function pixels(png:Uint8Array){
 const data=Buffer.from(png);assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
 assert.equal(data[24],8);assert.equal(data[25],3,'indexed colour');let i=8;const chunks:Buffer[]=[],types:string[]=[];
 while(i<data.length){const n=data.readUInt32BE(i),type=data.toString('ascii',i+4,i+8);types.push(type);if(type==='IDAT')chunks.push(data.subarray(i+8,i+8+n));i+=n+12;}
 assert.deepEqual(types,['IHDR','PLTE','tRNS','IDAT','IEND']);
 const raw=inflateSync(Buffer.concat(chunks)),out=Buffer.alloc(width*height);
 for(let y=0;y<height;y++){assert.equal(raw[y*(width+1)],0);raw.copy(out,y*width,y*(width+1)+1,(y+1)*(width+1));}
 return {width,height,bytes:out};
}

test('text artwork is anti-aliased, 96 pixels high, deterministic and bounded, with distinct visible printable glyphs',async()=>{
 assert.match(TEXT_RENDERER,/v3/);assert.equal(sha(Buffer.from(TEXT_ATLAS_V3_BASE64,'base64')),TEXT_ATLAS_HASH);
 for(const text of ['Chief Executive, A/B & Co.','2023-11-14T22:13:20.123Z','x'.repeat(128)]){
  const bytes=await renderText(text);assert.deepEqual(await renderText(text),bytes);const image=pixels(bytes);
  assert.ok(image.width<text.length*72);assert.equal(image.height,96);assert.ok(image.bytes.some(v=>v!==0));
 }
 const shades=new Set(pixels(await renderText('Agreement')).bytes);assert.ok(shades.has(15)&&shades.size>8,'edges are shaded, not just on or off');
 const glyphs=new Set<string>();for(let c=33;c<=126;c++){const image=pixels(await renderText(String.fromCharCode(c)));assert.ok(image.bytes.some(v=>v!==0),`invisible glyph ${c}`);glyphs.add(image.bytes.toString('hex'));}assert.equal(glyphs.size,94);
 const a=pixels(await renderText('A')),span=(y:number)=>{const xs=Array.from({length:a.width},(_,x)=>x).filter(x=>a.bytes[y*a.width+x]>=8);return xs.length?xs[xs.length-1]-xs[0]+1:0;};assert.ok(span(35)<span(75),'A must be upright');
 for(const text of ['', ' '.repeat(4),' leading','trailing ', 'a\nb','é','x'.repeat(129)])await assert.rejects(()=>renderText(text));
});

test('date digits use the font\'s own spacing and fit the default 150-point box',async()=>{
 const image=pixels(await renderText('2026-11-04'));assert.equal(image.height,96);assert.ok(image.width*27/96<100);
 // A space advances the pen: two words are wider than the words alone.
 assert.ok(pixels(await renderText('A B')).width>pixels(await renderText('AB')).width);
});

test('pdf-lib embeds the indexed PNG with its transparency',async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([300,100]),png=await pdf.embedPng(await renderText('Director'));
 page.drawImage(png,{x:10,y:10,width:png.width*27/96,height:27});assert.ok((await pdf.save()).length>0);
});

test('signatures recorded with the v2 renderer still verify and draw with it, unchanged',async()=>{
 assert.equal(sha(Buffer.from(TEXT_ATLAS_BASE64,'base64')),TEXT_ATLAS_V2_HASH);
 // Bytes v2 made before v3 existed: a stored image must still match what its renderer makes of its value.
 assert.equal(sha(await renderTextV2('Director')),'99e45b30afda2c58ad45504828cb9189a223299b3615ce1d8fab71da73859db1');
 assert.equal(sha(await renderTextV2('2026-11-12')),'1c560f23e1de5fcc785f391024fe4e9cf34d0ed02fb408782eaa761f443c68f6');
 assert.equal(sha(await renderTextV2('Chief Executive, A/B & Co.')),'086a0064d23be62d5796e00ffde0da1a0bca23ec996bf4292c76ba11e771ae63');
 for(const type of ['Title','Date signed']){
  assert.equal(storedFieldRenderer(type,{name:TEXT_RENDERER_V2,sha256:TEXT_ATLAS_V2_HASH}).name,TEXT_RENDERER_V2);
  assert.equal(storedFieldRenderer(type,{name:TEXT_RENDERER,sha256:TEXT_ATLAS_HASH}),fieldRenderer(type));
  assert.equal(fieldRenderer(type).name,TEXT_RENDERER,'new signatures use v3');
  for(const named of [{name:TEXT_RENDERER_V2,sha256:TEXT_ATLAS_HASH},{name:'other',sha256:TEXT_ATLAS_HASH},null])assert.throws(()=>storedFieldRenderer(type,named),/Renderer changed/);
 }
 assert.throws(()=>storedFieldRenderer('Signature',{name:TEXT_RENDERER_V2,sha256:TEXT_ATLAS_V2_HASH}),/Renderer changed/);
 const v2=storedFieldRenderer('Title',{name:TEXT_RENDERER_V2,sha256:TEXT_ATLAS_V2_HASH}),pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),image=await renderTextV2('Director');
 assert.equal(v2.geometry(page,{rect:{x:.1,y:.2,width:.5,height:.1}},image).height,27);
});
