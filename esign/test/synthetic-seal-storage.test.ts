import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { publishStep } from '../scripts/synthetic-seal-storage.ts';

test('concurrent nondeterministic outputs reuse and verify a single atomic winner',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'esign-step-test-'));
  try {
    const valid=(b:Buffer)=>{if(!['first','second'].includes(b.toString())) throw new Error('invalid');};
    const results=await Promise.all([publishStep(dir,'signature',Buffer.from('first'),valid),publishStep(dir,'signature',Buffer.from('second'),valid)]);
    assert.deepEqual(results[0],results[1]);assert.deepEqual(results[0],await readFile(join(dir,'signature')));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('asynchronous verification must finish before a candidate can be published',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'esign-step-test-'));
  try {
    await assert.rejects(publishStep(dir,'token',Buffer.from('bad'),async()=>{throw new Error('invalid token');}),/invalid token/);
    await assert.rejects(readFile(join(dir,'token')), {code:'ENOENT'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('actual SIGKILL after hard-link publication recovers and concurrent processes share a winner',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'esign-step-test-'));
  const helper=fileURLToPath(new URL('./helpers/seal-publish-child.ts',import.meta.url));
  const child=(mode:string,value:string,workspace=dir)=>spawn(process.execPath,[helper,workspace,mode,value],{stdio:['ignore','pipe','pipe']});
  try {
    const crashed=child('pause','first');
    const chunk=await Promise.race([once(crashed.stdout,'data').then(x=>x[0]),once(crashed,'exit').then(()=>{throw new Error('child exited before publication');})]);assert.match(chunk.toString(),/published/);
    crashed.kill('SIGKILL');const [code,signal]=await once(crashed,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
    const valid=(b:Buffer)=>{if(!['first','second'].includes(b.toString())) throw new Error('invalid');};
    assert.equal((await publishStep(dir,'signature',Buffer.from('second'),valid)).toString(),'first');
    const race=join(dir,'race');await mkdir(race);
    const [one,two]=[child('normal','first',race),child('normal','second',race)];
    let a='',b='';one.stdout.on('data',x=>{a+=x.toString();});two.stdout.on('data',x=>{b+=x.toString();});
    const exits=await Promise.all([once(one,'exit'),once(two,'exit')]);assert.deepEqual(exits.map(x=>x[0]),[0,0]);
    const winner=(await readFile(join(race,'signature'))).toString();assert.equal(a,`winner=${winner}\n`);assert.equal(b,a);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('recovery after a crash at publication reuses the winner and rejects corruption',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'esign-step-test-'));
  try {
    const valid=(b:Buffer)=>{if(b.toString()!=='valid') throw new Error('invalid');};
    await assert.rejects(publishStep(dir,'step',Buffer.from('valid'),valid,()=>{throw new Error('crash');}),/crash/);
    assert.equal((await publishStep(dir,'step',Buffer.from('different'),valid)).toString(),'valid');
    await writeFile(join(dir,'step'),'corrupt');
    await assert.rejects(publishStep(dir,'step',Buffer.from('valid'),valid),/invalid/);
    assert.equal((await readFile(join(dir,'step'))).toString(),'corrupt');
    await assert.rejects(publishStep(dir,'../escape',Buffer.from('valid'),valid));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('cleanup failure never hides an unverified publication error',{skip:typeof process.getuid==='function' && process.getuid()===0},async()=>{
 const {chmodSync}=await import('node:fs');const {chmod}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'esign-step-cleanup-failure-'));const warn=console.warn;const warnings:string[]=[];console.warn=(...args:unknown[])=>warnings.push(args.join(' '));
 try {
  let checks=0;
  await assert.rejects(publishStep(dir,'step',Buffer.from('candidate'),()=>{if(++checks===2)throw new Error('winner verification failed');},()=>chmodSync(dir,0o500)),/winner verification failed/);
  await chmod(dir,0o700);assert.equal((await readFile(join(dir,'step'))).toString(),'candidate');assert.ok(warnings.length>0);
 } finally {console.warn=warn;await chmod(dir,0o700).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('concurrent cleanup failures retain winner and losing private candidate without changing the winner',{skip:typeof process.getuid==='function' && process.getuid()===0},async()=>{
 const {chmodSync}=await import('node:fs');const {chmod,readdir}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'esign-step-concurrent-cleanup-'));const warn=console.warn;const warnings:string[]=[];console.warn=(...args:unknown[])=>warnings.push(args.join(' '));
 let checks=0,releaseCandidates!:()=>void,releaseWinners!:()=>void;
 const candidatesReady=new Promise<void>(r=>{releaseCandidates=r;}),winnersReady=new Promise<void>(r=>{releaseWinners=r;});
 const valid=async(bytes:Buffer)=>{
  assert.ok(['first','second'].includes(bytes.toString()));const index=++checks;
  if(index<=2){if(index===2)releaseCandidates();await candidatesReady;}
  else {if(index===4){chmodSync(dir,0o500);releaseWinners();}await winnersReady;}
 };
 try {
  const results=await Promise.all([publishStep(dir,'step',Buffer.from('first'),valid),publishStep(dir,'step',Buffer.from('second'),valid)]);
  await chmod(dir,0o700);assert.deepEqual(results[0],results[1]);assert.deepEqual(results[0],await readFile(join(dir,'step')));
  const temps=(await readdir(dir)).filter(name=>name.startsWith('.step-'));assert.equal(temps.length,2);assert.equal(warnings.length,2);
  assert.deepEqual((await Promise.all(temps.map(name=>readFile(join(dir,name))))).map(value=>value.toString()).sort(),['first','second']);
 } finally {releaseCandidates();releaseWinners();console.warn=warn;await chmod(dir,0o700).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
