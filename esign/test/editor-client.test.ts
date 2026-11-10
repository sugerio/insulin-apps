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
