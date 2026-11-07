import {test} from 'node:test';
import assert from 'node:assert/strict';
const placement = await import('../ui/field-placement.ts').catch(() => ({placeField: undefined}));

test('field placement uses normalized coordinates and stays within the PDF page', () => {
  assert.equal(typeof placement.placeField, 'function', 'field placement is not implemented');
  assert.deepEqual(placement.placeField!({x: 100, y: 200, width: 200, height: 100}, {x: 150, y: 225}, {width: 0.2, height: 0.1}), {x: 0.25, y: 0.25, width: 0.2, height: 0.1});
  assert.deepEqual(placement.placeField!({x: 100, y: 200, width: 200, height: 100}, {x: 299, y: 299}, {width: 0.2, height: 0.1}), {x: 0.8, y: 0.9, width: 0.2, height: 0.1});
  assert.throws(() => placement.placeField!({x: 0, y: 0, width: 0, height: 100}, {x: 0, y: 0}, {width: 0.2, height: 0.1}));
});

test('moving an existing field preserves the pointer grab offset for precise small moves', () => {
  assert.equal(typeof placement.moveField, 'function', 'precise field movement is not implemented');
  const page = {x: 100, y: 200, width: 200, height: 100};
  const original = {x: 0.2, y: 0.3, width: 0.25, height: 0.1};
  const unchanged = placement.moveField!(page, {x: 165, y: 235}, original, {x: 0.125, y: 0.05});
  assert.ok(Math.abs(unchanged.x - original.x) < 1e-12 && Math.abs(unchanged.y - original.y) < 1e-12);
  const moved = placement.moveField!(page, {x: 166, y: 236}, original, {x: 0.125, y: 0.05});
  assert.ok(Math.abs(moved.x - 0.205) < 1e-12 && Math.abs(moved.y - 0.31) < 1e-12);
});

test('fixed editor boxes use PDF points independently of page dimensions', async()=>{
 const {editorFieldSize}=await import('../ui/field-placement.ts');
 assert.deepEqual(editorFieldSize({width:600,height:900}),{width:.25,height:34/900});
 assert.deepEqual(editorFieldSize({width:300,height:450}),{width:.5,height:34/450});
 assert.throws(()=>editorFieldSize({width:100,height:20}));
});

test('moving to another PDF page preserves the physical field size',async()=>{
 const {sizeOnPage}=await import('../ui/field-placement.ts');
 assert.deepEqual(sizeOnPage({width:.25,height:.03},{width:600,height:900},{width:300,height:450}),{width:.5,height:.06});
 assert.throws(()=>sizeOnPage({width:.5,height:.1},{width:600,height:900},{width:200,height:80}));
});

test('new-field preview and drop share a centered grab point at each page scale and clamp at edges', async()=>{
 const {newFieldPlacement}=await import('../ui/field-placement.ts');
 const points={width:600,height:900}, page={x:100,y:200,width:300,height:450};
 assert.deepEqual(newFieldPlacement(page,{x:250,y:400},points),{x:.375,y:191.5/450,width:.25,height:34/900});
 const edge=newFieldPlacement(page,{x:100,y:200},points);assert.equal(edge.x,0);assert.equal(edge.y,0);
 const other=newFieldPlacement({x:0,y:0,width:600,height:900},{x:300,y:450},{width:300,height:450});
 assert.equal(other.width,.5);assert.equal(other.height,34/450);assert.equal(other.x,.25);
});
