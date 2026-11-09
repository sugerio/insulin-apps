import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFNumber,degrees} from 'pdf-lib';
import {validateFieldsPdf,validateFieldPlacement} from '../src/fields.ts';
import {validateFields} from '../src/fields.ts';

const signableFields=(raw:string,roles:string[],pages:number)=>validateFields(JSON.parse(raw),roles,pages);

const signature={id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}};
test('positioned templates reject unsupported fields, geometry and PDFs',async()=>{
 const pdf=await PDFDocument.create();const page=pdf.addPage([400,500]);
 const fields=signableFields(JSON.stringify([signature]),['ana'],1);validateFieldsPdf(pdf);validateFieldPlacement(pdf,fields);
 for(const bad of [[{...signature,type:'Text box'}],[{...signature,role:'other'}],[{...signature,page:2}],[{...signature,rect:{...signature.rect,x:.9}}]])assert.throws(()=>signableFields(JSON.stringify(bad),['ana'],1));
 assert.throws(()=>signableFields(JSON.stringify([signature]),['ana','other'],1));
 assert.throws(()=>validateFieldPlacement(pdf,signableFields(JSON.stringify([{...signature,rect:{...signature.rect,width:.001}}]),['ana'],1)));
 page.setRotation(degrees(90));assert.throws(()=>validateFieldsPdf(pdf));page.setRotation(degrees(0));
 page.setCropBox(1,1,300,400);assert.throws(()=>validateFieldsPdf(pdf));page.setCropBox(0,0,400,500);
 page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));assert.throws(()=>validateFieldsPdf(pdf));page.node.delete(PDFName.of('UserUnit'));
 pdf.getForm();assert.throws(()=>validateFieldsPdf(pdf));
});

test('overlap validation rejects same-page intersections for any role, but permits touching edges and other pages',async()=>{
 const {assertNoOverlappingFields}=await import('../src/fields.ts');
 const a={id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.1,width:.25,height:.1}};
 for(const role of ['ana','marcus'])assert.throws(()=>assertNoOverlappingFields([a,{...a,id:'b',role,rect:{...a.rect,x:.2}}]));
 assert.doesNotThrow(()=>assertNoOverlappingFields([a,{...a,id:'b',role:'marcus',rect:{...a.rect,x:.35}}]));
 const decimal={...a,rect:{x:.1,y:.1,width:.2,height:.1}};assert.doesNotThrow(()=>assertNoOverlappingFields([decimal,{...a,id:'b',rect:{...a.rect,x:.3}}]));assert.throws(()=>assertNoOverlappingFields([decimal,{...a,id:'b',rect:{...a.rect,x:.2999999999999999}}]));
 assert.doesNotThrow(()=>assertNoOverlappingFields([a,{...a,id:'b',page:2}]));
});

