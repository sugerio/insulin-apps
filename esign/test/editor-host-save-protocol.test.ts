import {test} from 'node:test';
import assert from 'node:assert/strict';
const protocol=await import('../ui/editor-save-protocol.ts').catch(()=>({readSaveRequest:undefined,readSaveResult:undefined}));

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
