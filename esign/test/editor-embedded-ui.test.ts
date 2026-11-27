import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FieldEditor} from '../src/app/ui/FieldEditor.ts';
import {readFile} from 'node:fs/promises';

test('embedded editor has no upload or save buttons; host owns both',async()=>{
 const editor=renderToStaticMarkup(React.createElement(FieldEditor,{embedded:true,onSave:async()=>{}}));
 assert.doesNotMatch(editor,/type="file"|Save template/);
 const host=await readFile(new URL('./fixtures/editor-host.html',import.meta.url),'utf8');
 assert.match(host,/type="file"/);assert.match(host,/>Save template<\/button>/);
});

test('a save that fails is shown in the editor, embedded too, and its answer says so (shown), for a host to say it once',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const alertText=(renderer:any)=>renderer.root.findAll((n:any)=>n.type==='p'&&n.props.role==='alert').map((n:any)=>n.children.join('')).join('');
 for(const embedded of [true,false]){
  const ref=React.createRef<any>();let renderer:any;
  try{
   await act(async()=>{renderer=Renderer.create(React.createElement(FieldEditor,{ref,embedded,onSave:async()=>'unused'}));});
   let result:any;await act(async()=>{result=await ref.current.save();});
   assert.deepEqual(result,{ok:false,message:'Upload a PDF and wait for the preview before saving.',shown:true});
   // Shown here, embedded or not: a host that doesn't show esign.editor.save-error still lets its user see it.
   assert.equal(alertText(renderer),'Upload a PDF and wait for the preview before saving.');
  }finally{if(renderer)await act(async()=>renderer.unmount());}
 }
 delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
