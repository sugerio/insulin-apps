import { constants } from 'node:fs';
import { lstat,open,readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { publishStep } from './synthetic-seal-storage.ts';

const protocol=Buffer.from('esign upload completion protocol v2\n');
const preflightStart=Buffer.from('upload completion preflight started v1\n');
const preflightSafe=Buffer.from('unsigned preflight verified v1\n');
const inspectionStart=Buffer.from('upload evidence inspection started v1\n');
const inspectionSafe=Buffer.from('upload evidence inspection verified v1\n');
const exact=(expected:Buffer)=>(value:Buffer)=>{if(!value.equals(expected))throw new Error('Invalid upload completion marker');};

async function exists(dir:string,name:string) {
 try {const f=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);try {if(!(await f.stat()).isFile())throw new Error('Invalid marker');return true;}finally{await f.close();}}
 catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
export async function initializeUploadCompletion(dir:string) {await publishStep(dir,'upload-protocol-v2',protocol,exact(protocol));}
// Markers describe observations, not a durable authorization to resume after a host restart.
export async function uploadCompletionState(dir:string,activeInspection?:string,createdInThisHost=false) {
 if(!createdInThisHost)return 'INVESTIGATE' as const;
 try {await lstat(join(dir,'upload-investigate'));return 'INVESTIGATE' as const;} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!await exists(dir,'upload-protocol-v2'))return 'INVESTIGATE' as const;
 const f=await open(join(dir,'upload-protocol-v2'),constants.O_RDONLY|constants.O_NOFOLLOW);try {exact(protocol)(await f.readFile());}finally{await f.close();}
 const names=await readdir(dir),starts=new Set<string>(),safe=new Set<string>(),inspectionStarts=new Set<string>(),inspectionPassed=new Set<string>();
 for(const name of names) {
  if(!name.startsWith('upload-check-') && !name.startsWith('upload-inspect-'))continue;
  const match=/^upload-(check|inspect)-(ok-)?([a-f0-9]{32})$/.exec(name);if(!match)throw new Error('Invalid inspection marker');
  const inspection=match[1]==='inspect',passed=Boolean(match[2]);
  const expected=inspection ? (passed?inspectionSafe:inspectionStart) : (passed?preflightSafe:preflightStart);
  const file=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await file.stat();if(!stat.isFile() || stat.size>128)throw new Error('Invalid inspection marker');exact(expected)(await file.readFile());}finally {await file.close();}
  (inspection ? (passed?inspectionPassed:inspectionStarts) : (passed?safe:starts)).add(match[3]);
 }
 if([...safe].some(id=>!starts.has(id)) || [...inspectionPassed].some(id=>!inspectionStarts.has(id)) || [...inspectionStarts].some(id=>!inspectionPassed.has(id) && id!==activeInspection))return 'INVESTIGATE' as const;
 const pending=[...starts].filter(id=>!safe.has(id)).length;
 if(await exists(dir,'upload-attempt'))return pending<=1 ? 'ATTEMPTED' as const : 'INVESTIGATE' as const;
 if(pending!==0)return 'INVESTIGATE' as const;
 if(await exists(dir,'seal-workspace'))return 'INVESTIGATE' as const;
 return 'FRESH' as const;
}
async function createOnce(dir:string,name:string) {
 const f=await open(join(dir,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try {await f.writeFile('locked\n');await f.sync();} finally {await f.close();}
 const parent=await open(dir,constants.O_RDONLY);try {await parent.sync();}finally {await parent.close();}
}
export async function beginUploadAttempt(dir:string) {await createOnce(dir,'upload-attempt');}
export async function runUploadPreflight(dir:string,check:()=>Promise<'UNSIGNED'|'FINAL'>,testFault?:{afterSafeLink?:()=>void;beforeSafeWinnerValidation?:()=>void}) {
 const id=randomBytes(16).toString('hex');
 await publishStep(dir,`upload-check-${id}`,preflightStart,exact(preflightStart));
 const phase=await check();
 if(phase==='UNSIGNED') {let validations=0;await publishStep(dir,`upload-check-ok-${id}`,preflightSafe,value=>{exact(preflightSafe)(value);if(++validations===2)testFault?.beforeSafeWinnerValidation?.();},testFault?.afterSafeLink);}
 else if(phase==='FINAL')await beginUploadAttempt(dir);
 else throw new Error('Invalid preflight result');
 return phase;
}
export async function runUploadInspection<T>(dir:string,check:(id:string)=>Promise<T>,testFault?:{afterSafeLink?:()=>void;beforeSafeWinnerValidation?:()=>void}) {
 const id=randomBytes(16).toString('hex');
 await publishStep(dir,`upload-inspect-${id}`,inspectionStart,exact(inspectionStart));
 const result=await check(id);
 let validations=0;await publishStep(dir,`upload-inspect-ok-${id}`,inspectionSafe,value=>{exact(inspectionSafe)(value);if(++validations===2)testFault?.beforeSafeWinnerValidation?.();},testFault?.afterSafeLink);
 return result;
}
export async function lockUploadInvestigation(dir:string) {
 try {await createOnce(dir,'upload-investigate');}catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const f=await open(join(dir,'upload-investigate'),constants.O_RDONLY|constants.O_NOFOLLOW);try {if(!(await f.stat()).isFile())throw new Error('Invalid investigation marker');}finally {await f.close();}}
}
