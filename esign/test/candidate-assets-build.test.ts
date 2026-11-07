import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readdir,readFile,rm,writeFile,symlink,realpath,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('candidate asset build requires exact HTTPS gateway origins and excludes demo pages',async()=>{
 const parent=await mkdtemp(join(await realpath(tmpdir()),'candidate-assets-'));
 const dir=join(parent,'build');
 try {
  const run=(env:Record<string,string>)=>spawnSync(process.execPath,['scripts/build-candidate-assets.ts',dir],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:'',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'',...env}});
  assert.notEqual(run({}).status,0);
  assert.notEqual(run({VITE_CANDIDATE_GATEWAY_ORIGIN:'https://gateway.example.test/path',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'}).status,0);
  const result=run({VITE_CANDIDATE_GATEWAY_ORIGIN:'https://gateway.example.test',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual((await readdir(dir)).sort(),['client','worker.mjs']);
  for(const page of ['candidate.html','candidate-editor.html'])assert.match(await readFile(join(dir,'client',page),'utf8'),/\/assets\//);
  assert.ok((await readdir(join(dir,'client','assets'))).length>0);
  const worker=(await import(`file://${join(dir,'worker.mjs')}?test=${Date.now()}`)).default;
  const origin={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://gateway.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'};
  let tamper=false;
  const env={...origin,ASSETS:{fetch:async(request:Request)=>{try {const data=await readFile(join(dir,'client',new URL(request.url).pathname));return new Response(tamper?Buffer.from('changed'):data);} catch {return new Response(null,{status:404});}}}};
  for(const path of ['/candidate.html','/candidate-editor.html']) assert.equal((await worker.fetch(new Request('https://pages.example.test'+path),env)).status,200);
  for(const path of ['/','/index.html','/demo.html','/assets/not-generated.js']) assert.equal((await worker.fetch(new Request('https://pages.example.test'+path),env)).status,404);
  tamper=true;assert.equal((await worker.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);

 } finally {await rm(parent,{recursive:true,force:true});}
});

test('candidate asset build rejects existing and symlinked output paths without deleting sentinels',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'candidate-safety-'));
 try {
  const source=join(dir,'source');await mkdir(source);await writeFile(join(source,'sentinel'),'keep');
  const link=join(dir,'link');await symlink(source,link);
  const env={...process.env,NODE_ENV:'production',VITE_CANDIDATE_GATEWAY_ORIGIN:'https://gateway.example.test',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'};
  for(const output of [source,dir,link,join(link,'build'),'.','..']) {
   const result=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env});
   assert.notEqual(result.status,0,`accepted ${output}`);
   assert.equal(await readFile(join(source,'sentinel'),'utf8'),'keep');
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('candidate asset build rejects incompatible NODE_ENV before creating output',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'candidate-env-'));
 try {
  const output=join(dir,'build');
  const result=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env:{...process.env,NODE_ENV:'development',VITE_CANDIDATE_GATEWAY_ORIGIN:'https://gateway.example.test',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'}});
  assert.notEqual(result.status,0);assert.deepEqual(await readdir(dir),[]);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('unset NODE_ENV produces the same assets as production',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'candidate-production-'));
 try {
  const env={...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:'https://gateway.example.test',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'};
  delete env.NODE_ENV;
  for(const [name,nodeEnv] of [['unset',undefined],['production','production']] as const) {
   const childEnv={...env};if(nodeEnv)childEnv.NODE_ENV=nodeEnv;
   const result=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',join(dir,name)],{encoding:'utf8',env:childEnv});
   assert.equal(result.status,0,result.stderr);
  }
  async function snapshot(path:string):Promise<Record<string,string>> {
   const result:Record<string,string>={};
   for(const entry of await readdir(path,{withFileTypes:true})) {
    if(entry.isDirectory())for(const [name,value] of Object.entries(await snapshot(join(path,entry.name))))result[entry.name+'/'+name]=value;
    else result[entry.name]=(await readFile(join(path,entry.name))).toString('base64');
   }
   return result;
  }
  assert.deepEqual(await snapshot(join(dir,'unset')),await snapshot(join(dir,'production')));
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('synthetic preview is static, inert and served through the built manifest',async()=>{
 const parent=await mkdtemp(join(await realpath(tmpdir()),'candidate-preview-'));
 try {
  const env={...process.env,NODE_ENV:'production',VITE_CANDIDATE_GATEWAY_ORIGIN:'https://gateway.example.test',VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ESIGN_CANDIDATE_SYNTHETIC_PREVIEW:'YES'};
  const output=join(parent,'preview');
  const result=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);
  assert.deepEqual((await readdir(join(output,'client'))).sort(),['candidate-editor.html','candidate.html']);
  const worker=(await import(`file://${join(output,'worker.mjs')}`)).default;
  let calls=0;const hostEnv={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:env.VITE_CANDIDATE_GATEWAY_ORIGIN,EDITOR_GATEWAY_ORIGIN:env.VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN,ASSETS:{fetch:async(req:Request)=>{calls++;return new Response(await readFile(join(output,'client',new URL(req.url).pathname)));}}};
  for(const path of ['/candidate.html','/candidate-editor.html']) {
   const response=await worker.fetch(new Request('https://pages.example.test'+path),hostEnv);assert.equal(response.status,200);
   assert.match(response.headers.get('content-security-policy')!,/script-src 'self'/);
   const html=await response.text();assert.match(html,/TEST ONLY/);assert.match(html,/services, verification email and signing are unavailable/i);assert.match(html,/do not enter or upload real data/i);
   assert.doesNotMatch(html,/<script\b|<form\b|<input\b|<iframe\b|request a new session|open a new session/i);
  }
  assert.equal(calls,2);
  const invalid=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',join(parent,'invalid')],{encoding:'utf8',env:{...env,ESIGN_CANDIDATE_SYNTHETIC_PREVIEW:'yes'}});assert.notEqual(invalid.status,0);
  const normal=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',join(parent,'normal')],{encoding:'utf8',env:{...env,ESIGN_CANDIDATE_SYNTHETIC_PREVIEW:''}});assert.equal(normal.status,0,normal.stderr);
  for(const page of ['candidate.html','candidate-editor.html']){const html=await readFile(join(parent,'normal/client',page),'utf8');assert.doesNotMatch(html,/TEST ONLY/);assert.match(html,/<script\b/);}
 } finally {await rm(parent,{recursive:true,force:true});}
});
