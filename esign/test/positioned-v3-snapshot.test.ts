import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePositionedV3, canonicalPositionedV3, validatePositionedV3} from '../src/positioned-v3-snapshot.ts';
import {canonicalSignatureEvent} from '../src/signature-event.ts';
import {V3_TEXT_RENDERER,V3_TEXT_ATLAS_HASH} from '../src/positioned-v3-text-render.ts';
import {TYPED_SIGNATURE_FONT,TYPED_SIGNATURE_FONT_HASH} from '../src/typed-signature-image.ts';
const renderers={textRenderer:V3_TEXT_RENDERER,textAtlasHash:V3_TEXT_ATLAS_HASH,signatureRenderer:TYPED_SIGNATURE_FONT,signatureFontHash:TYPED_SIGNATURE_FONT_HASH};

const rect=(x:number)=>({x,y:.1,width:.2,height:.1});
const template=[{id:'sig-a',type:'Signature',role:'ana',page:1,required:true,rect:rect(.0)},{id:'date-a',type:'Date signed',role:'ana',page:1,required:true,rect:rect(.2)},{id:'title-a',type:'Title',role:'ana',page:1,required:true,rect:rect(.4)},{id:'sig-b',type:'Signature',role:'bob',page:1,required:true,rect:rect(.6)}];
const time=1700000000123, event={envelopeId:'e',sequence:1,previousHash:'',signatureId:'s',taskId:'t',recipientName:'Ana',artifactId:'d0',artifactHash:'a'.repeat(64),otpVerifiedAt:time-1,consentedAt:time};
const input={'sig-a':'ANA','title-a':'Chief Executive'};
test('v3 snapshot captures only role-owned input and server signing time',()=>{
 const snapshot=capturePositionedV3(template,['ana','bob'],1,'ana',time,input);
 assert.deepEqual(snapshot.fields.map(f=>[f.id,f.text]),[['sig-a','ANA'],['date-a','2023-11-14'],['title-a','Chief Executive']]);
 const withHashes={...snapshot,...renderers,fields:snapshot.fields.map(f=>({...f,imageHash:'a'.repeat(64)}))};
 assert.deepEqual(validatePositionedV3(withHashes,1,time),withHashes);
 const canonical=canonicalPositionedV3(event,withHashes);assert.notEqual(canonical,canonicalPositionedV3(event,{...withHashes,fields:withHashes.fields.map((f,i)=>i===2?{...f,text:'Director'}:f)}));
 assert.notEqual(canonical,canonicalPositionedV3({...event,consentedAt:time+1},withHashes));
 const legacy={...withHashes,fields:withHashes.fields.map(f=>f.type==='Date signed'?{...f,text:new Date(time).toISOString()}:f)};assert.deepEqual(validatePositionedV3(legacy,1,time),legacy);const legacyEncoding=JSON.stringify(['esign-signature-event-v3',event.envelopeId,event.sequence,event.previousHash,event.signatureId,event.taskId,event.recipientName,event.artifactId,event.artifactHash,event.otpVerifiedAt,event.consentedAt,legacy.role,legacy.textRenderer,legacy.textAtlasHash,legacy.signatureRenderer,legacy.signatureFontHash,legacy.templateFields.map(f=>[f.id,f.type,f.role,f.page,f.required,f.rect.x,f.rect.y,f.rect.width,f.rect.height]),legacy.fields.map(f=>[f.id,f.type,f.page,f.rect.x,f.rect.y,f.rect.width,f.rect.height,f.text,f.imageHash])]);assert.equal(canonicalPositionedV3(event,legacy),legacyEncoding);
 const bound={...withHashes,fields:withHashes.fields.map(f=>f.type==='Date signed'?{...f,previewId:'12345678-1234-4123-8123-123456789abc'}:f)};assert.notEqual(canonicalPositionedV3(event,bound),canonical);
 assert.match(canonical,/esign-signature-event-v3/);assert.match(canonical,/liberation-sans-bitmap-v2/);assert.match(canonicalSignatureEvent(event),/esign-signature-event-v1/);
 assert.throws(()=>validatePositionedV3({...withHashes,textAtlasHash:'0'.repeat(64)},1,time));
 assert.throws(()=>validatePositionedV3({...withHashes,textRenderer:'unknown'},1,time));
});
test('v3 rejects unauthorized, missing, oversized, duplicated, altered date and geometry',()=>{
 for(const values of [{...input,'sig-b':'BOB'},{...input,'date-a':'client-date'},{'sig-a':'ANA'},{...input,'title-a':'x'.repeat(129)},{...input,'title-a':''}])assert.throws(()=>capturePositionedV3(template,['ana','bob'],1,'ana',time,values));
 assert.throws(()=>capturePositionedV3([...template,template[0]],['ana','bob'],1,'ana',time,input));
 const snapshot=capturePositionedV3(template,['ana','bob'],1,'ana',time,input),good={...snapshot,...renderers,fields:snapshot.fields.map(f=>({...f,imageHash:'a'.repeat(64)}))};
 for(const fields of [[...good.fields,good.fields[0]],good.fields.map(f=>f.id==='date-a'?{...f,text:'wrong'}:f),good.fields.map(f=>f.id==='title-a'?{...f,page:2}:f),good.fields.map(f=>f.id==='title-a'?{...f,imageHash:'bad'}:f)])assert.throws(()=>validatePositionedV3({...good,fields},1,time));
 assert.throws(()=>validatePositionedV3(good,1,time+86400000));
});
test('UTC midnight changes the captured date without changing the consent timestamp protocol',()=>{
 const before=Date.parse('2024-04-30T23:59:59.999Z'),after=before+1;
 const old=capturePositionedV3(template,['ana','bob'],1,'ana',before,input),current=capturePositionedV3(template,['ana','bob'],1,'ana',after,input);
 assert.equal(old.fields.find(f=>f.id==='date-a')!.text,'2024-04-30');assert.equal(current.fields.find(f=>f.id==='date-a')!.text,'2024-05-01');
 const snapshot={...old,...renderers,fields:old.fields.map(f=>({...f,imageHash:'a'.repeat(64),...(f.id==='date-a'?{previewId:'12345678-1234-4123-8123-123456789abc'}:{})}))};
 assert.doesNotThrow(()=>validatePositionedV3(snapshot,1,before));assert.throws(()=>validatePositionedV3(snapshot,1,after));
});
