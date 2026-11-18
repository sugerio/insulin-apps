import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateTemplateFields} from '../src/app/server/esign/fields.ts';

test('template fields must reference a role and fit a real PDF page',()=>{
  const field={id:'field-1',type:'Signature',role:'Partner',page:1,required:true,rect:{x:0.1,y:0.2,width:0.3,height:0.1}};
  assert.deepEqual(validateTemplateFields([field],['Partner'],2),[field]);
  for(const invalid of [{...field,role:'Other'},{...field,page:3},{...field,rect:{...field.rect,x:0.9}},{...field,rect:{...field.rect,width:0}},{...field,type:'Unknown'}]) assert.throws(()=>validateTemplateFields([invalid],['Partner'],2));
  assert.throws(()=>validateTemplateFields([field,field],['Partner'],2));
});


test('new template fields need at least one Signature per exact role, and at most 20 fields',async()=>{
  const {assertEditorSigningFields}=await import('../src/app/server/esign/fields.ts');
  const field={id:'a',type:'Signature',role:'Partner',page:1,required:true,rect:{x:0,y:0,width:.3,height:.1}};
  assert.doesNotThrow(()=>assertEditorSigningFields([field],['Partner']));
  assert.doesNotThrow(()=>assertEditorSigningFields([field,{...field,id:'date',type:'Date signed'}, {...field,id:'title',type:'Title'}],['Partner']));
  assert.throws(()=>assertEditorSigningFields([],['Partner']),/Partner/);
  // A role may sign in several places.
  assert.doesNotThrow(()=>assertEditorSigningFields([field, {...field,id:'b'}],['Partner']));
  // Optional fields are fine, as long as one Signature is required.
  assert.doesNotThrow(()=>assertEditorSigningFields([field, {...field,id:'b',required:false}],['Partner']));
  assert.throws(()=>assertEditorSigningFields([{...field,required:false}],['Partner']),/Partner: no required Signature field/);
  assert.throws(()=>assertEditorSigningFields(Array.from({length:21},(_,i)=>({...field,id:`s${i}`})),['Partner']),/At most 20 fields/);
  assert.throws(()=>assertEditorSigningFields([{...field,type:'Text box'}],['Partner']));
  assert.throws(()=>assertEditorSigningFields([field],['partner']),/partner/);
});
