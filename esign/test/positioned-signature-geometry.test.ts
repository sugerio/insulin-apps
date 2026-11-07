import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {renderTypedSignature} from '../src/typed-signature-image.ts';
import {signatureGeometry,assertSignatureGeometrySafe} from '../src/positioned-signature-geometry.ts';
import type {TemplateField} from '../src/template-fields.ts';

const field=(id:string,x:number,role='A'):TemplateField=>({id,type:'Signature',role,page:1,required:true,rect:{x,y:0.1,width:0.05,height:0.1}});
test('fixed-size signatures extend right, avoiding page edges and every role field',async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),a=field('a',0.1),b=field('b',0.5,'B');
 const short=signatureGeometry(page,a,await renderTypedSignature('Al'));
 const long=signatureGeometry(page,a,await renderTypedSignature('Alexander'));
 assert.equal(short.height,long.height);assert.ok(long.width>short.width);assert.ok(long.width>a.rect.width*600);
 assert.doesNotThrow(()=>assertSignatureGeometrySafe(page,a,long,[a,b]));
 assert.throws(()=>assertSignatureGeometrySafe(page,a,long,[a,field('b',0.17,'B')]));
 const edge=field('a',0.95),edgeGeometry=signatureGeometry(page,edge,await renderTypedSignature('Alexander'));assert.throws(()=>assertSignatureGeometrySafe(page,edge,edgeGeometry,[edge]));
});
test('signature bitmap spacing is tighter than fixed 96-pixel cells',async()=>{
 const image=await renderTypedSignature('Alexander');assert.ok(new DataView(image.buffer,image.byteOffset).getUint32(16)<9*70);
});
