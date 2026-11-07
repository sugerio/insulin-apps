import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalSignatureEvent} from '../src/signature-event.ts';

const base={envelopeId:'env',sequence:1,previousHash:'',signatureId:'sig',taskId:'task',recipientName:'Ana',artifactId:'d0',artifactHash:'a'.repeat(64),otpVerifiedAt:100,consentedAt:101};
test('v1 event bytes stay exactly compatible with historical signatures',()=>{
 const expected=JSON.stringify(['esign-signature-event-v1','env',1,'','sig','task','Ana','d0','a'.repeat(64),100,101]);
 assert.equal(canonicalSignatureEvent(base),expected);
 assert.equal(createHash('sha256').update(canonicalSignatureEvent(base)).digest('hex'),createHash('sha256').update(expected).digest('hex'));
});
test('v2 event binds persisted signature, geometry, identity and image hashes in fixed order',()=>{
 const payload={role:'ana',font:'local-stroke-v1',fontHash:'b'.repeat(64),templateFields:[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.2,width:.3,height:.1}}],fields:[{id:'a',page:1,rect:{x:.1,y:.2,width:.3,height:.1},text:'Ana',imageHash:'c'.repeat(64)}]};
 const expected=JSON.stringify(['esign-signature-event-v2','env',1,'','sig','task','Ana','d0','a'.repeat(64),100,101,'ana','local-stroke-v1','b'.repeat(64),[['a','Signature','ana',1,true,.1,.2,.3,.1]],[['a',1,.1,.2,.3,.1,'Ana','c'.repeat(64)]]]);
 assert.equal(canonicalSignatureEvent(base,payload),expected);
 for(const changed of [
  {...payload,templateFields:[{...payload.templateFields[0],required:false}]}, {...payload,role:'other'}, {...payload,font:'other'}, {...payload,fontHash:'d'.repeat(64)},
  {...payload,fields:[{...payload.fields[0],text:'Other'}]},
  {...payload,fields:[{...payload.fields[0],imageHash:'d'.repeat(64)}]},
  {...payload,fields:[{...payload.fields[0],page:2}]},
  {...payload,fields:[{...payload.fields[0],rect:{...payload.fields[0].rect,x:.2}}]},
 ]) assert.notEqual(canonicalSignatureEvent(base,changed),expected);
 assert.notEqual(canonicalSignatureEvent({...base,artifactHash:'d'.repeat(64)},payload),expected);
});
