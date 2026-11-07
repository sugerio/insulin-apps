import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beginUploadAttempt,initializeUploadCompletion,lockUploadInvestigation,uploadCompletionState} from '../scripts/upload-completion-state.ts';

test('upload completion markers fail closed for old, partial and interrupted instances',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'upload-completion-state-test-'));
 try {
  assert.equal(await uploadCompletionState(dir,undefined,true),'INVESTIGATE');
  await initializeUploadCompletion(dir);assert.equal(await uploadCompletionState(dir,undefined,true),'FRESH');
  await beginUploadAttempt(dir);assert.equal(await uploadCompletionState(dir,undefined,true),'ATTEMPTED');
  await assert.rejects(beginUploadAttempt(dir));
  await lockUploadInvestigation(dir);await lockUploadInvestigation(dir);
  assert.equal(await uploadCompletionState(dir,undefined,true),'INVESTIGATE');
 } finally {await rm(dir,{recursive:true,force:true});}
 const partial=await mkdtemp(join(tmpdir(),'upload-completion-state-test-'));
 try {await initializeUploadCompletion(partial);await writeFile(join(partial,'seal-workspace'),'partial');assert.equal(await uploadCompletionState(partial,undefined,true),'INVESTIGATE');}
 finally {await rm(partial,{recursive:true,force:true});}
});

test('preflight crash persists investigation before evidence checking',async()=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {fileURLToPath}=await import('node:url');
 const dir=await mkdtemp(join(tmpdir(),'upload-preflight-crash-test-'));
 try {
  await initializeUploadCompletion(dir);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/upload-preflight-crash-child.ts',import.meta.url)),dir],{stdio:['ignore','pipe','pipe']});
  const first=await Promise.race([once(child.stdout,'data').then(v=>v[0].toString()),once(child,'exit').then(()=>{throw new Error('child exited before preflight');})]);
  assert.match(first,/preflight-entered/);child.kill('SIGKILL');assert.equal((await once(child,'exit'))[1],'SIGKILL');
  assert.equal(await uploadCompletionState(dir,undefined,true),'INVESTIGATE');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('failed investigation marker cannot erase unfinished preflight; safe unsigned may retry',async()=>{
 const {runUploadPreflight}=await import('../scripts/upload-completion-state.ts');
 const {mkdir}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'upload-preflight-failure-test-'));
 try {
  await initializeUploadCompletion(dir);
  assert.equal(await runUploadPreflight(dir,async()=> 'UNSIGNED'),'UNSIGNED');
  assert.equal(await uploadCompletionState(dir,undefined,true),'FRESH');
  assert.equal(await runUploadPreflight(dir,async()=> 'UNSIGNED'),'UNSIGNED');
  assert.equal(await uploadCompletionState(dir,undefined,true),'FRESH');
  await assert.rejects(runUploadPreflight(dir,async()=>{throw new Error('integrity failure');}));
  await mkdir(join(dir,'upload-investigate'));
  await assert.rejects(lockUploadInvestigation(dir));
  await rm(join(dir,'upload-investigate'),{recursive:true});
  assert.equal(await uploadCompletionState(dir,undefined,true),'INVESTIGATE');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('failed post-attempt evidence inspection remains blocked even if investigation marker cannot be written',async()=>{
 const {runUploadInspection}=await import('../scripts/upload-completion-state.ts');const {mkdir}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'upload-inspection-failure-test-'));
 try {
  await initializeUploadCompletion(dir);await beginUploadAttempt(dir);
  await assert.rejects(runUploadInspection(dir,async()=>{throw new Error('verified evidence unavailable');}));
  await mkdir(join(dir,'upload-investigate'));await assert.rejects(lockUploadInvestigation(dir));
  await rm(join(dir,'upload-investigate'),{recursive:true});
  assert.equal(await uploadCompletionState(dir,undefined,true),'INVESTIGATE');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('state inspection records a durable guard before validating state',async()=>{
 const {runUploadInspection}=await import('../scripts/upload-completion-state.ts');const dir=await mkdtemp(join(tmpdir(),'upload-state-inspection-test-'));
 try {
  await initializeUploadCompletion(dir);
  assert.equal(await runUploadInspection(dir,async id=>uploadCompletionState(dir,id,true)),'FRESH');
  await writeFile(join(dir,'upload-protocol-v2'),'invalid');
  await assert.rejects(runUploadInspection(dir,async id=>uploadCompletionState(dir,id,true)));
  await writeFile(join(dir,'upload-protocol-v2'),'esign upload completion protocol v2\n');
  assert.equal(await uploadCompletionState(dir,undefined,true),'INVESTIGATE');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('durably committed marker cleanup does not authorize a restarted host',{skip:typeof process.getuid==='function' && process.getuid()===0},async()=>{
 const {chmodSync}=await import('node:fs');const {chmod,readdir,stat}=await import('node:fs/promises');
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {publishStep}=await import('../scripts/synthetic-seal-storage.ts');
 const dir=await mkdtemp(join(tmpdir(),'upload-cleanup-double-failure-'));const warnings:string[]=[];const warn=console.warn;console.warn=(...args:unknown[])=>warnings.push(args.join(' '));
 try {
  await initializeUploadCompletion(dir);const id='0123456789abcdef0123456789abcdef';
  const start=Buffer.from('upload completion preflight started v1\n'),safe=Buffer.from('unsigned preflight verified v1\n');
  const exact=(expected:Buffer)=>(actual:Buffer)=>assert.deepEqual(actual,expected);
  await publishStep(dir,`upload-check-${id}`,start,exact(start));
  let returned=false,publicationError:unknown;
  try {await publishStep(dir,`upload-check-ok-${id}`,safe,exact(safe),()=>chmodSync(dir,0o500));returned=true;} catch(error) {publicationError=error;}
  await assert.rejects(lockUploadInvestigation(dir));
  await chmod(dir,0o700);
  assert.equal(returned,true,`durable marker was misreported as failed: ${String(publicationError)}`);
  assert.ok(warnings.length>0,'cleanup failure must be reported without exposing paths');assert.ok(warnings.every(w=>!w.includes(dir)));
  const temporary=(await readdir(dir)).filter(name=>name.startsWith(`.upload-check-ok-${id}-`));assert.equal(temporary.length,1);
  assert.deepEqual(await readFile(join(dir,temporary[0])),safe);
  assert.equal((await stat(join(dir,temporary[0]))).ino,(await stat(join(dir,`upload-check-ok-${id}`))).ino);
  const moduleUrl=new URL('../scripts/upload-completion-state.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {uploadCompletionState} from ${JSON.stringify(moduleUrl)};console.log(await uploadCompletionState(process.argv[1]));`,dir],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b.toString());assert.equal((await once(child,'exit'))[0],0);assert.equal(output.trim(),'INVESTIGATE');
 } finally {console.warn=warn;await chmod(dir,0o700).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
