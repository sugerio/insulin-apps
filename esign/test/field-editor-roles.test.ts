import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer, {act} from 'react-test-renderer';
const editor = await import('../ui/FieldEditor.ts').catch(() => ({}));

test('host roles are a labeled selectable list without role creation controls', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let renderer:any;
  try {
    await act(async()=>{renderer=Renderer.create(React.createElement(editor.FieldEditor,{initialRoles:['Partner','Seller']}));});
    const group=renderer.root.findByType('fieldset');
    assert.equal(group.findByType('legend').children.join(''),'Placing fields for');
    const radios=()=>group.findAllByProps({type:'radio'});
    assert.deepEqual(radios().map((r:any)=>r.props.value),['Partner','Seller']);
    assert.deepEqual(radios().map((r:any)=>r.props.checked),[true,false]);
    assert.deepEqual(group.findAllByType('label').map((label:any)=>label.children.filter((c:any)=>typeof c==='string').join('')),['Partner','Seller']);
    await act(async()=>{radios()[1].props.onChange({target:{value:'Seller'}});});
    assert.deepEqual(radios().map((r:any)=>r.props.checked),[false,true]);
    assert.equal(renderer.root.findAllByProps({'aria-label':'New role'}).length,0);
    assert.equal(renderer.root.findAllByProps({'aria-label':'Add role'}).length,0);
  } finally {if(renderer) await act(async()=>renderer.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('existing case-distinct roles are displayed without changing their spelling or count',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let renderer:any;
  try {
    await act(async()=>{renderer=Renderer.create(React.createElement(editor.FieldEditor,{initialRoles:['Signer','signer'],editingSource:true}));});
    assert.deepEqual(renderer.root.findAllByProps({type:'radio'}).map((r:any)=>r.props.value),['Signer','signer']);
  } finally {if(renderer)await act(async()=>renderer.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('editor offers only signature, date and title fields',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const html=renderToStaticMarkup(React.createElement(editor.FieldEditor,{initialRoles:['Partner']}));
 for(const label of ['Add Signature field','Add Date signed field','Add Title field']) assert.ok(html.includes(label), label);
 assert.match(html,/A Title field shows the title the signer confirms before signing/);
 assert.match(html,/not for production/);
 assert.ok(!html.includes('Add Initials field'));
 assert.ok(!html.includes('Horizontal position (%)'));
});

test('role names are rendered as text, not HTML',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const React=(await import('react')).default;
 const {FieldEditor}=await import('../ui/FieldEditor.ts');
 const html=renderToStaticMarkup(React.createElement(FieldEditor,{initialRoles:['<img src=x onerror=alert(1)>']}));
 assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
 assert.ok(!html.includes('<img src=x'));
});
