import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editorSavedMessage,consumeEditorFragment} from '../src/app/ui/editor-client.ts';

test('editor strips its fragment before exchange and parent accepts only current iframe and exact editor origin',()=>{
 const location={hash:'#'+'a'.repeat(64),pathname:'/editor/page/'+'b'.repeat(64),search:''};let replacement='';
 assert.equal(consumeEditorFragment(location,{replaceState:(_a:unknown,_b:string,url:string)=>{replacement=url;}}),'a'.repeat(64));
 assert.equal(replacement,location.pathname);assert.ok(!replacement.includes('a'.repeat(64)));
 const frame={},other={};const expected={origin:'https://esign.example.com',source:frame,data:{type:'esign.editor.saved'}};
 assert.equal(editorSavedMessage(expected,'https://esign.example.com',frame),true);
 assert.equal(editorSavedMessage({...expected,origin:'https://evil.example.com'},'https://esign.example.com',frame),false);
 assert.equal(editorSavedMessage({...expected,source:other},'https://esign.example.com',frame),false);
 assert.equal(editorSavedMessage({...expected,data:{type:'esign.editor.saved',templateId:'attacker'}},'https://esign.example.com',frame),false);
});

test('an editor link without its code says the session is unavailable, without asking the server or crashing',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 const React=(await import('react')).default;
 const {EditorPage}=await import('../src/app/ui/EditorPage.ts');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldDocument=(globalThis as any).document;
 const pathname='/editor/page/'+'b'.repeat(64);
 // Without a document, reaching the exchange would fail on document.referrer before any request, and look like a refusal.
 (globalThis as any).document={referrer:''};
 const open=async(hash:string)=>{
  const requests:string[]=[];let address='';
  (globalThis as any).window={location:{origin:'https://esign.example.com',hash,pathname,search:''},history:{replaceState(_a:unknown,_b:string,url:string){address=url;}}};
  globalThis.fetch=(async(input:any)=>{requests.push(String(input));return new Response('{}',{status:500});}) as typeof fetch;
  let renderer:any;
  await act(async()=>{renderer=Renderer.create(React.createElement(EditorPage));});
  const alert=renderer.root.findAll((n:any)=>n.type==='p'&&n.props.role==='alert')[0]?.children.join('');
  await act(async()=>{renderer.unmount();});
  return {requests,address,alert};
 };
 try{
  for(const hash of ['','#not-a-code','#'+'a'.repeat(64)+'&x']){
   const {requests,address,alert}=await open(hash);
   assert.equal(alert,'Editor session unavailable. Ask the host to open a new session.',`the alert for ${JSON.stringify(hash)}`);
   assert.deepEqual(requests,[],`no exchange for ${JSON.stringify(hash)}`);
   assert.equal(address,pathname,`${JSON.stringify(hash)} leaves the address`);
  }
  assert.deepEqual((await open('#'+'a'.repeat(64))).requests,['/api/public/editor/exchange'],'a valid code is exchanged');
 }finally{globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).document=oldDocument;}
});
