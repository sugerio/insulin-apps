/** Explicitly enabled, fixture-only local experiment. No envelope or document input. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createSyntheticWorkspace,sealSyntheticWorkspace } from './synthetic-seal-orchestration.ts';
import { verifySyntheticSeal } from './synthetic-seal-verify.ts';
import { awsProfile } from './aws-profile.ts';

async function main() {
 if(process.env.ESIGN_SYNTHETIC_SEAL!=='YES') throw new Error('Opt-in required');
 const args=process.argv.slice(2);
 if(args[0]==='verify' && args.length===4) {
  const result=await verifySyntheticSeal(args[1],args[2],await readFile(args[3]));
  console.log(JSON.stringify({mode:'SYNTHETIC TEST ONLY',...result}));return;
 }
 if(!((args[0]==='start' && args.length===1) || (args[0]==='resume' && args.length===2))) throw new Error('Invalid arguments');
 const dir=args[0]==='start'?await createSyntheticWorkspace():args[1];
 console.log(`Synthetic workspace: ${dir}`);
 const roots=await readFile('/etc/ssl/cert.pem');
 const exec=promisify(execFile);
 const result=await sealSyntheticWorkspace(dir,{
  roots,
  aws:async argv=>{
   try {const {stdout}=await exec('aws',['kms',...argv,'--profile',awsProfile(),'--region','us-west-2','--output','json','--no-cli-pager'],{timeout:60000,maxBuffer:1024*1024,env:{...process.env,AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'}});return JSON.parse(stdout);}
   catch {throw new Error('KMS request failed');}
  },
  timestamp:async request=>{
   const result=await fetch('http://timestamp.digicert.com',{method:'POST',headers:{'content-type':'application/timestamp-query'},body:Uint8Array.from(request),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!result.ok || !result.body) throw new Error('TSA request failed');
   const chunks:Uint8Array[]=[];let size=0;
   for await(const chunk of result.body) {size+=chunk.length;if(size>1024*1024) throw new Error('TSA response too large');chunks.push(chunk);}
   return Buffer.concat(chunks);
  }
 });
 console.log(JSON.stringify({mode:'SYNTHETIC TEST ONLY',...result}));
}
main().catch(error=>{
 const safe=/^(Opt-in required|Invalid arguments|Invalid workspace location|Invalid workspace permissions|KMS request failed|TSA request failed|TSA response too large|RFC3161 response verification failed|Existing evidence conflicts|Invalid signature|Unexpected KMS metadata|Unexpected KMS signature metadata|Unexpected KMS public key)$/;
 const message=error instanceof Error && safe.test(error.message)?`${error.message}; preserve any workspace for investigation.`:'Synthetic seal failed; preserve the workspace for investigation. No production completion is claimed.';
 console.error(message);process.exitCode=1;
});
