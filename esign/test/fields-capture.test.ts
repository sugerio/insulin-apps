import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureFields} from '../src/fields.ts';
import {parseFacts,parseRender,signatureEventHash,type FieldsRender} from '../src/signatures.ts';
import {fieldRenderer} from '../src/field-render.ts';

const rect=(x:number)=>({x,y:.1,width:.2,height:.1});
const template=[{id:'sig-a',type:'Signature',role:'ana',page:1,required:true,rect:rect(.0)},{id:'date-a',type:'Date signed',role:'ana',page:1,required:true,rect:rect(.2)},{id:'title-a',type:'Title',role:'ana',page:1,required:true,rect:rect(.4)},{id:'sig-b',type:'Signature',role:'bob',page:1,required:true,rect:rect(.6)}];
const time=1700000000123;
const input={'sig-a':'ANA','title-a':'Chief Executive'};
const facts=(at:number)=>parseFacts({version:1,signatureId:'s',taskId:'t',role:'ana',recipientName:'Ana',recipientEmail:'ana@example.com',sessionHash:'b'.repeat(64),otpVerifiedAt:at-1,consentedAt:at,inputArtifactId:'d0'});
/** The render document recordSignature stores for a capture (image hashes and geometry are placeholders here). */
const rendered=(snapshot:ReturnType<typeof captureFields>):FieldsRender=>({version:1,kind:'fields',inputPageCount:1,role:snapshot.role,template:snapshot.templateFields,fields:snapshot.fields.map(f=>({id:f.id,type:f.type,role:snapshot.role,page:f.page,rect:f.rect,value:f.text,renderer:{name:fieldRenderer(f.type).name,sha256:fieldRenderer(f.type).sha256},imageSha256:'a'.repeat(64),geometry:{x:1,y:2,width:3,height:4}}))});
const link={previousHash:null,envelopeId:'e',sequence:1,inputSha256:'c'.repeat(64)};

test('captured fields hold only role-owned input and the server signing date',async()=>{
 const snapshot=captureFields(template,['ana','bob'],1,'ana',time,input);
 assert.deepEqual(snapshot.fields.map(f=>[f.id,f.text]),[['sig-a','ANA'],['date-a','2023-11-14'],['title-a','Chief Executive']]);
 const render=rendered(snapshot);
 assert.deepEqual(parseRender(render,facts(time)),render);
 // The event hash binds every value and the signing time.
 const hash=await signatureEventHash(link,facts(time),render);
 assert.notEqual(hash,await signatureEventHash(link,facts(time),{...render,fields:render.fields.map((f,i)=>i===2?{...f,value:'Director'}:f)}));
 assert.notEqual(hash,await signatureEventHash(link,facts(time+1),render));
 assert.notEqual(hash,await signatureEventHash({...link,inputSha256:'d'.repeat(64)},facts(time),render));
 // A renderer that changed since signing fails closed.
 assert.throws(()=>parseRender({...render,fields:render.fields.map(f=>f.type==='Title'?{...f,renderer:{...f.renderer,sha256:'0'.repeat(64)}}:f)},facts(time)));
 assert.throws(()=>parseRender({...render,fields:render.fields.map(f=>f.type==='Title'?{...f,renderer:{...f.renderer,name:'unknown'}}:f)},facts(time)));
 assert.throws(()=>parseRender({...render,version:2},facts(time)));
 assert.throws(()=>parseRender({...render,kind:'unknown'},facts(time)));
});

test('captured fields reject unauthorized, missing, oversized, duplicated, altered date and geometry',()=>{
 for(const values of [{...input,'sig-b':'BOB'},{...input,'date-a':'client-date'},{'sig-a':'ANA'},{...input,'title-a':'x'.repeat(129)},{...input,'title-a':''}])assert.throws(()=>captureFields(template,['ana','bob'],1,'ana',time,values));
 assert.throws(()=>captureFields([...template,template[0]],['ana','bob'],1,'ana',time,input));
 const good=rendered(captureFields(template,['ana','bob'],1,'ana',time,input));
 for(const fields of [[...good.fields,good.fields[0]],good.fields.map(f=>f.id==='date-a'?{...f,value:'wrong'}:f),good.fields.map(f=>f.id==='title-a'?{...f,page:2}:f),good.fields.map(f=>f.id==='title-a'?{...f,imageSha256:'bad'}:f),good.fields.map(f=>f.id==='title-a'?{...f,rect:rect(.5)}:f),good.fields.filter(f=>f.id!=='date-a')])assert.throws(()=>parseRender({...good,fields},facts(time)));
 assert.throws(()=>parseRender({...good,role:'bob'},facts(time)));
 assert.throws(()=>parseRender({...good,template:[...good.template,{...template[0],id:'extra',rect:rect(.8)}]},facts(time)));
 assert.throws(()=>parseRender(good,facts(time+86400000)));
});

test('UTC midnight changes the captured date',()=>{
 const before=Date.parse('2024-04-30T23:59:59.999Z'),after=before+1;
 const old=captureFields(template,['ana','bob'],1,'ana',before,input),current=captureFields(template,['ana','bob'],1,'ana',after,input);
 assert.equal(old.fields.find(f=>f.id==='date-a')!.text,'2024-04-30');assert.equal(current.fields.find(f=>f.id==='date-a')!.text,'2024-05-01');
 assert.doesNotThrow(()=>parseRender(rendered(old),facts(before)));assert.throws(()=>parseRender(rendered(old),facts(after)));
});
