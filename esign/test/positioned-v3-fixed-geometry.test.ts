import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {PDFDocument} from 'pdf-lib';
import {renderTypedSignature} from '../src/typed-signature-image.ts';
import {renderPositionedV3Text} from '../src/positioned-v3-text-render.ts';
import {signatureGeometry} from '../src/positioned-signature-geometry.ts';
import {positionedV3TextGeometry,assertPositionedV3TextFits} from '../src/positioned-v3-text-fit.ts';

function inkHeight(bytes:Uint8Array){const b=Buffer.from(bytes),width=b.readUInt32BE(16),height=b.readUInt32BE(20);let offset=8;const parts:Buffer[]=[];while(offset<b.length){const n=b.readUInt32BE(offset);if(b.toString('ascii',offset+4,offset+8)==='IDAT')parts.push(b.subarray(offset+8,offset+8+n));offset+=n+12;}const raw=inflateSync(Buffer.concat(parts));let first=height,last=-1;for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(raw[y*(width*4+1)+1+4*x+3]){first=Math.min(first,y);last=y;}return (last-first+1)/height;}
test('date and title reference ink is 80% of the signature reference ink',async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]);const field={rect:{x:.1,y:.2,width:.5,height:.1}};
 const sig=await renderTypedSignature('H'),title=await renderPositionedV3Text('H'),date=await renderPositionedV3Text('2026-11-04');
 const s=signatureGeometry(page,field,sig),t=positionedV3TextGeometry(page,field,title),d=positionedV3TextGeometry(page,field,date);
 assert.equal(s.x,60);assert.equal(s.y,160);assert.equal(t.x,60);assert.equal(t.y,160);
 assert.equal(inkHeight(title)*t.height,inkHeight(sig)*s.height*0.8);assert.equal(inkHeight(date)*d.height,inkHeight(sig)*s.height*0.8);
 const larger={rect:{...field.rect,width:.8,height:.2}};assert.equal(positionedV3TextGeometry(page,larger,title).height,t.height);
 assert.throws(()=>assertPositionedV3TextFits(page,{rect:{...field.rect,width:.01}},title));
});

test('rounding a 27-point field to normalized coordinates does not reject a fitting image',async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),image=await renderPositionedV3Text('H');
 assert.doesNotThrow(()=>assertPositionedV3TextFits(page,{rect:{x:.1,y:.1,width:.25,height:.033749999999999995}},image));
 assert.throws(()=>assertPositionedV3TextFits(page,{rect:{x:.1,y:.1,width:.25,height:.03374}},image));
});
