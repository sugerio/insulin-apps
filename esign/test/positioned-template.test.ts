import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFNumber,degrees} from 'pdf-lib';
import {positionedFields,validatePositionedPdf,validatePositionedPlacement} from '../src/positioned-template.ts';

const signature={id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}};
test('positioned templates reject unsupported fields, geometry and PDFs',async()=>{
 const pdf=await PDFDocument.create();const page=pdf.addPage([400,500]);
 const fields=positionedFields(JSON.stringify([signature]),['ana'],1);validatePositionedPdf(pdf);validatePositionedPlacement(pdf,fields);
 for(const bad of [[{...signature,type:'Text box'}],[{...signature,role:'other'}],[{...signature,page:2}],[{...signature,rect:{...signature.rect,x:.9}}]])assert.throws(()=>positionedFields(JSON.stringify(bad),['ana'],1));
 assert.throws(()=>positionedFields(JSON.stringify([signature]),['ana','other'],1));
 assert.throws(()=>validatePositionedPlacement(pdf,positionedFields(JSON.stringify([{...signature,rect:{...signature.rect,width:.001}}]),['ana'],1)));
 page.setRotation(degrees(90));assert.throws(()=>validatePositionedPdf(pdf));page.setRotation(degrees(0));
 page.setCropBox(1,1,300,400);assert.throws(()=>validatePositionedPdf(pdf));page.setCropBox(0,0,400,500);
 page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));assert.throws(()=>validatePositionedPdf(pdf));page.node.delete(PDFName.of('UserUnit'));
 pdf.getForm();assert.throws(()=>validatePositionedPdf(pdf));
});

test('overlap validation rejects same-page intersections for any role, but permits touching edges and other pages',async()=>{
 const {assertNoOverlappingFields}=await import('../src/template-fields.ts');
 const a={id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.1,width:.25,height:.1}};
 for(const role of ['ana','marcus'])assert.throws(()=>assertNoOverlappingFields([a,{...a,id:'b',role,rect:{...a.rect,x:.2}}]));
 assert.doesNotThrow(()=>assertNoOverlappingFields([a,{...a,id:'b',role:'marcus',rect:{...a.rect,x:.35}}]));
 const decimal={...a,rect:{x:.1,y:.1,width:.2,height:.1}};assert.doesNotThrow(()=>assertNoOverlappingFields([decimal,{...a,id:'b',rect:{...a.rect,x:.3}}]));assert.throws(()=>assertNoOverlappingFields([decimal,{...a,id:'b',rect:{...a.rect,x:.2999999999999999}}]));
 assert.doesNotThrow(()=>assertNoOverlappingFields([a,{...a,id:'b',page:2}]));
});

test('previously captured overlapping v2 snapshot remains verifiable without authorizing new use',async()=>{
 const {validatePositionedSnapshot}=await import('../src/positioned-signature-snapshot.ts');const {TYPED_SIGNATURE_FONT,TYPED_SIGNATURE_FONT_HASH}=await import('../src/typed-signature-image.ts');
 const a={id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.1,width:.25,height:.1}},b={...a,id:'b',role:'marcus',rect:{...a.rect,x:.2}};
 const snapshot={role:'ana',font:TYPED_SIGNATURE_FONT,fontHash:TYPED_SIGNATURE_FONT_HASH,templateFields:[a,b],fields:[{id:'a',page:1,rect:a.rect,text:'ANA',imageHash:'a'.repeat(64)}]};
 assert.deepEqual(validatePositionedSnapshot(snapshot,1),snapshot);
});
