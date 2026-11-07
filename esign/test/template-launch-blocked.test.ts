import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {TemplateLaunch} from '../ui/TemplateLaunch.ts';

test('positioned field templates cannot start signing',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;let renderer:any;const calls:string[]=[];
 try{
  await act(async()=>{renderer=Renderer.create(React.createElement(TemplateLaunch,{request:async(path)=>{calls.push(path);return Response.json({id:'with-fields',roles:['Partner'],hasPositionedFields:true});},onCreated:async()=>{throw new Error('must not create');}}));});
  await act(async()=>{renderer.root.findByProps({'aria-label':'Template ID'}).props.onChange({target:{value:'with-fields'}});});
  await act(async()=>{await renderer.root.findAllByType('button').find((b:any)=>b.children.includes('Load template')).props.onClick();});
  const start=renderer.root.findAllByType('button').find((b:any)=>b.children.includes('Start signing from template'));
  assert.equal(start.props.disabled,true);assert.match(JSON.stringify(renderer.toJSON()),/not supported/i);
  assert.deepEqual(calls,['/templates/with-fields']);
 }finally{if(renderer)await act(async()=>renderer.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
