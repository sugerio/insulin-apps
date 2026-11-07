import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {HostPage} from '../ui/HostPage.ts';

test('launching from a template loads its roles and binds recipients in order',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const oldFetch=globalThis.fetch,oldStorage=(globalThis as any).localStorage;const calls:{path:string;body?:string}[]=[];let renderer:any;
 try {
  (globalThis as any).localStorage={getItem:()=>null,setItem(){}};
  globalThis.fetch=async(input:any,init:any={})=>{const path=String(input);calls.push({path,body:init.body});
   if(path==='/host/templates/template-1')return Response.json({id:'template-1',roles:['Partner','Seller'],hasPositionedFields:false});
   if(path==='/host/envelopes')return Response.json({id:'env-1',status:'PROCESSING'});
   if(path==='/host/envelopes/env-1/prepare')return new Response(null,{status:204});
   if(path==='/host/envelopes/env-1')return Response.json({id:'env-1',status:'IN_PROGRESS',tasks:[]});
   throw new Error(path);
  };
  await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
  const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
  const idInput=renderer.root.findByProps({'aria-label':'Template ID'});
  await act(async()=>{idInput.props.onChange({target:{value:'template-1'}});});
  await act(async()=>{await button('Load template').props.onClick();});
  assert.match(JSON.stringify(renderer.toJSON()),/Partner/);assert.match(JSON.stringify(renderer.toJSON()),/Seller/);
  const input=(name:string)=>renderer.root.findByProps({'aria-label':name});
  for(const [name,value] of [['Partner name','Ana'],['Partner email','ana@example.com'],['Seller name','Marcus'],['Seller email','marcus@example.com']]) await act(async()=>{input(name).props.onChange({target:{value}});});
  await act(async()=>{await button('Start signing from template').props.onClick();});
  const sent=JSON.parse(calls.find(c=>c.path==='/host/envelopes')!.body!);
  assert.deepEqual(sent,{templateId:'template-1',recipients:[{role:'Partner',name:'Ana',email:'ana@example.com'},{role:'Seller',name:'Marcus',email:'marcus@example.com'}]});
  assert.ok(calls.some(c=>c.path==='/host/envelopes/env-1/prepare'));
 }finally{if(renderer)await act(async()=>renderer.unmount());globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('selecting a listed supported template starts an envelope with its selected roles',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const oldFetch=globalThis.fetch,oldStorage=(globalThis as any).localStorage;let renderer:any,sent:any;
 try{(globalThis as any).localStorage={getItem:()=>null,setItem(){}};globalThis.fetch=async(input:any,init:any={})=>{const path=String(input);
  if(path==='/host/templates?cursor=')return Response.json({templates:[{id:'template-1',createdAt:1}],nextCursor:null});
  if(path==='/host/templates/template-1')return Response.json({id:'template-1',roles:['ana'],hasPositionedFields:true,positionedFieldsSupported:true});
  if(path==='/host/envelopes'){sent=JSON.parse(init.body);return Response.json({id:'env-1',status:'PROCESSING'});}
  if(path.endsWith('/prepare'))return new Response(null,{status:204});if(path==='/host/envelopes/env-1')return Response.json({id:'env-1',status:'IN_PROGRESS',tasks:[]});throw new Error(path);};
  await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});await act(async()=>{renderer.root.findByProps({'aria-label':'Select template template-1'}).props.onClick();});
  for(const [name,value] of [['ana name','Ana'],['ana email','ana@example.com']])await act(async()=>{renderer.root.findByProps({'aria-label':name}).props.onChange({target:{value}});});
  await act(async()=>{await renderer.root.findAllByType('button').find((b:any)=>b.children.includes('Start signing from template')).props.onClick();});assert.deepEqual(sent,{templateId:'template-1',recipients:[{role:'ana',name:'Ana',email:'ana@example.com'}]});
 }finally{if(renderer)await act(async()=>renderer.unmount());globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
