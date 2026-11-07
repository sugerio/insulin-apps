import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SyntheticHostPage} from '../ui/SyntheticHostPage.ts';

test('synthetic host identifies generated-only opt-in and cannot upload content',()=>{
 const html=renderToStaticMarkup(React.createElement(SyntheticHostPage));
 assert.match(html,/server-generated synthetic/i);assert.match(html,/not.*production/i);assert.match(html,/Create synthetic envelope/);assert.doesNotMatch(html,/type="file"/);assert.doesNotMatch(html,/credential/i);
});

test('synthetic host opens same envelope signing view and explicitly requests its seal',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window;
 const calls:string[]=[];let completed=false;
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'}};
  globalThis.fetch=async(input:any)=>{const path=String(input);calls.push(path);
   if(path==='/host/synthetic/create')return Response.json({id:'envelope'});
   if(path==='/host/synthetic/envelopes/envelope')return Response.json({id:'envelope',status:completed?'COMPLETED':'ACTIVE',tasks:[{id:'task',recipientName:'Ana',status:'ACTIVE'}]});
   if(path.endsWith('/recipient-view'))return Response.json({code:'synthetic-code'});
   if(path.endsWith('/finalize')){completed=true;return new Response(null,{status:204});}
   if(path.endsWith('/seal'))return Response.json({workspace:'/tmp/example',envelopeId:'envelope'});
   throw new Error(path);
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(SyntheticHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>{await button('Create synthetic envelope').props.onClick();});
  await act(async()=>{await button('Open signing view').props.onClick();});
  assert.equal(r.root.findByType('iframe').props.src,'/#code=synthetic-code&synthetic=1');
  await act(async()=>{await button('Finalize mock completion').props.onClick();});
  await act(async()=>{await button('Seal this synthetic envelope with KMS and TSA').props.onClick();});
  assert.ok(calls.includes('/host/synthetic/envelopes/envelope/seal'));assert.match(JSON.stringify(r.toJSON()),/independent/i);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
