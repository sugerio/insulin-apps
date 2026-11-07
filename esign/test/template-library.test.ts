import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {TemplateLibrary} from '../ui/TemplateLibrary.ts';

test('template library lists, selects and offers template creation',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;let renderer:any,selected='';const calls:string[]=[];
 try{const request=async(path:string)=>{calls.push(path);if(path==='/templates?cursor=')return Response.json({templates:[{id:'template-1',createdAt:1}],nextCursor:null});throw new Error(path);};
 await act(async()=>{renderer=Renderer.create(React.createElement(TemplateLibrary,{request,onSelect:(id:string)=>{selected=id;}}));});
 assert.ok(renderer.root.findAllByType('a').some((a:any)=>a.props.href==='/editor-host.html'));
 await act(async()=>{renderer.root.findByProps({'aria-label':'Select template template-1'}).props.onClick();});assert.equal(selected,'template-1');assert.deepEqual(calls,['/templates?cursor=']);
 }finally{if(renderer)await act(async()=>renderer.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('template library reports empty and errors and navigates pages',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;let renderer:any,fail=true;const calls:string[]=[];
 try{const request=async(path:string)=>{calls.push(path);if(fail)throw new Error('offline');if(path==='/templates?cursor=')return Response.json({templates:[{id:'first',createdAt:2}],nextCursor:'first'});return Response.json({templates:[],nextCursor:null});};
 await act(async()=>{renderer=Renderer.create(React.createElement(TemplateLibrary,{request,onSelect:()=>{}}));});assert.match(JSON.stringify(renderer.toJSON()),/Could not load/);fail=false;
 const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));await act(async()=>{await button('Refresh templates').props.onClick();});assert.ok(renderer.root.findByProps({'aria-label':'Select template first'}));
 await act(async()=>{await button('Next templates').props.onClick();});assert.match(JSON.stringify(renderer.toJSON()),/No templates yet/);await act(async()=>{await button('Previous templates').props.onClick();});assert.ok(renderer.root.findByProps({'aria-label':'Select template first'}));assert.deepEqual(calls,['/templates?cursor=','/templates?cursor=','/templates?cursor=first','/templates?cursor=']);
 }finally{if(renderer)await act(async()=>renderer.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
