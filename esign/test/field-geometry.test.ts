import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {PDFDocument} from 'pdf-lib';
import {renderTypedSignature} from '../src/app/server/esign/field-render.ts';
import {renderText} from '../src/app/server/esign/field-render.ts';
import {signatureGeometry} from '../src/app/server/esign/field-render.ts';
import {textGeometry,assertTextFits} from '../src/app/server/esign/field-render.ts';

function inkHeight(bytes:Uint8Array){const b=Buffer.from(bytes),width=b.readUInt32BE(16),height=b.readUInt32BE(20),indexed=b[25]===3;let offset=8;const parts:Buffer[]=[];while(offset<b.length){const n=b.readUInt32BE(offset);if(b.toString('ascii',offset+4,offset+8)==='IDAT')parts.push(b.subarray(offset+8,offset+8+n));offset+=n+12;}const raw=inflateSync(Buffer.concat(parts));let first=height,last=-1;for(let y=0;y<height;y++)for(let x=0;x<width;x++)if((indexed?raw[y*(width+1)+1+x]:raw[y*(width*4+1)+1+4*x+3])){first=Math.min(first,y);last=y;}return (last-first+1)/height;}
test('date and title reference ink is 80% of the signature reference ink',async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]);const field={rect:{x:.1,y:.2,width:.5,height:.1}};
 const sig=await renderTypedSignature('H'),title=await renderText('H'),date=await renderText('2026-11-04');
 const s=signatureGeometry(page,field,sig),t=textGeometry(page,field,title),d=textGeometry(page,field,date);
 assert.equal(s.x,60);assert.equal(s.y,160);assert.equal(t.x,60);
 // v4 text is 18 points high, its ink half the signature's 16.9 (9 points), on v3's baseline: 27 points
 // high from the box's top, the baseline 78 of 96 rows down, so 9 × 78/96 points lower.
 assert.equal(t.height,18);assert.equal(t.y,160+9*78/96);assert.equal(t.y+t.height*78/96,160+27*78/96);
 assert.equal(inkHeight(title)*t.height,9);assert.ok(Math.abs(inkHeight(title)*t.height/(inkHeight(sig)*s.height)-0.533)<.001);
 // Round digits overshoot the cap height by a pixel at the top and bottom.
 assert.ok(Math.abs(inkHeight(date)*d.height-9)<=2*t.height/96+1e-9);
 const larger={rect:{...field.rect,width:.8,height:.2}};assert.equal(textGeometry(page,larger,title).height,t.height);
 assert.throws(()=>assertTextFits(page,{rect:{...field.rect,width:.01}},title));
});

test('rounding the smallest fitting field to normalized coordinates does not reject a fitting image',async()=>{
 // v4 text ends 9 × 78/96 + 18 = 25.3125 points below the box's top: the box must be that high.
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),image=await renderText('H'),fits=(9*78/96+18)/800;
 for(const height of [fits,fits*(1-1e-15)])assert.doesNotThrow(()=>assertTextFits(page,{rect:{x:.1,y:.1,width:.25,height}},image));
 assert.throws(()=>assertTextFits(page,{rect:{x:.1,y:.1,width:.25,height:fits-1e-5}},image));
});
