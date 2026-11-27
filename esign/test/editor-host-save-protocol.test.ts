import {test} from 'node:test';
import assert from 'node:assert/strict';
const protocol=await import('../src/app/ui/editor-save-protocol.ts').catch(()=>({readSaveRequest:undefined,readSaveResult:undefined}));

test('save messages require exact parent/source origin, request ID and matching response',()=>{
 assert.equal(typeof protocol.readSaveRequest,'function','host-initiated save protocol is not implemented');
 assert.equal(typeof protocol.readSaveResult,'function','host-initiated save results are not implemented');
 const parent={}, iframe={}; const request={type:'esign.editor.save',requestId:'req-123'};
 assert.equal(protocol.readSaveRequest!({origin:'https://host.example.com',source:parent,data:request},'https://host.example.com',parent),'req-123');
 assert.equal(protocol.readSaveRequest!({origin:'https://evil.example.com',source:parent,data:request},'https://host.example.com',parent),null);
 assert.equal(protocol.readSaveRequest!({origin:'https://host.example.com',source:{},data:request},'https://host.example.com',parent),null);
 assert.equal(protocol.readSaveRequest!({origin:'https://host.example.com',source:parent,data:{...request,requestId:'bad id'}},'https://host.example.com',parent),null);
 const reply={type:'esign.editor.saved',requestId:'req-123',templateId:'a0b1c2d3-1111-4444-8888-123456789abc'};
 assert.equal(protocol.readSaveResult!({origin:'https://editor.example.com',source:iframe,data:reply},'https://editor.example.com',iframe,'req-123')?.templateId,reply.templateId);
 assert.equal(protocol.readSaveResult!({origin:'https://editor.example.com',source:iframe,data:reply},'https://editor.example.com',iframe,'other'),null);
 assert.equal(protocol.readSaveResult!({origin:'https://editor.example.com',source:{},data:reply},'https://editor.example.com',iframe,'req-123'),null);
 const invalidReply={...reply,requestId:'bad id'};
 assert.equal(protocol.readSaveResult!({origin:'https://editor.example.com',source:iframe,data:invalidReply},'https://editor.example.com',iframe,'bad id'),null);
 assert.equal(protocol.readSaveRequest!({origin:'https://host.example.com',source:parent,data:{...request,extra:true}},'https://host.example.com',parent),null);
 assert.equal(protocol.readSaveResult!({origin:'https://editor.example.com',source:iframe,data:{...reply,extra:true}},'https://editor.example.com',iframe,'req-123'),null);
});

test('a save-error may say the editor showed it (shown: true); only true, and nothing else extra', async () => {
 const {readSaveResult}=await import('../src/app/ui/editor-save-protocol.ts');
 const iframe={},at=(data:unknown)=>readSaveResult({origin:'https://editor.example.com',source:iframe,data},'https://editor.example.com',iframe,'req-1');
 const error={type:'esign.editor.save-error',requestId:'req-1',message:'Fields overlap.'};
 assert.deepEqual(at(error),{type:'esign.editor.save-error',message:'Fields overlap.',shown:false});
 assert.deepEqual(at({...error,shown:true}),{type:'esign.editor.save-error',message:'Fields overlap.',shown:true});
 for(const shown of [false,'true',1])assert.equal(at({...error,shown}),null,String(shown));
 assert.equal(at({...error,shown:true,extra:1}),null);
});

test('a save request may ask for a draft; without it, it is the save hosts have always sent', async () => {
 const {readSaveCall}=await import('../src/app/ui/editor-save-protocol.ts');
 const parent={},at=(data:unknown)=>readSaveCall({origin:'https://host.example.com',source:parent,data},'https://host.example.com',parent);
 assert.deepEqual(at({type:'esign.editor.save',requestId:'req-1'}),{requestId:'req-1',draft:false});
 assert.deepEqual(at({type:'esign.editor.save',requestId:'req-1',draft:true}),{requestId:'req-1',draft:true});
 assert.deepEqual(at({type:'esign.editor.save',requestId:'req-1',draft:false}),{requestId:'req-1',draft:false});
 for(const draft of ['true',1,null])assert.equal(at({type:'esign.editor.save',requestId:'req-1',draft}),null,String(draft));
 assert.equal(at({type:'esign.editor.save',requestId:'req-1',draft:true,extra:1}),null);
});
