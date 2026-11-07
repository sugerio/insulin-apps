/** Fixed AWS CLI and DigiCert adapters for explicit local synthetic tests only. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import { awsProfile } from './aws-profile.ts';

export async function realSyntheticDependencies() {
 const roots=await readFile('/etc/ssl/cert.pem');
 const exec=promisify(execFile);
 return {
  roots,
  aws:async(argv:string[])=>{
   const publicKey=argv.length===3 && argv[0]==='get-public-key' && argv[1]==='--key-id' && argv[2]==='alias/esign-local-test-signing';
   const sign=argv.length===9 && argv[0]==='sign' && argv[1]==='--key-id' && argv[2]==='alias/esign-local-test-signing' && argv[3]==='--message' && /^fileb:\/\/.+\/esign-kms-digest-[a-zA-Z0-9]+\/digest$/.test(argv[4]) && argv[5]==='--message-type' && argv[6]==='DIGEST' && argv[7]==='--signing-algorithm' && argv[8]==='ECDSA_SHA_256';
   if(!publicKey && !sign)throw new Error('Invalid KMS command');
   try {const {stdout}=await exec('aws',['kms',...argv,'--profile',awsProfile(),'--region','us-west-2','--output','json','--no-cli-pager'],{timeout:60000,maxBuffer:1024*1024,env:{...process.env,AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'}});return JSON.parse(stdout) as Record<string,unknown>;}
   catch {throw new Error('KMS request failed');}
  },
  timestamp:async(request:Buffer)=>{
   const response=await fetch('http://timestamp.digicert.com',{method:'POST',headers:{'content-type':'application/timestamp-query'},body:Uint8Array.from(request),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!response.ok || !response.body)throw new Error('TSA request failed');
   const chunks:Uint8Array[]=[];let size=0;
   for await(const chunk of response.body) {size+=chunk.length;if(size>1024*1024)throw new Error('TSA response too large');chunks.push(chunk);}
   return Buffer.concat(chunks);
  }
 };
}
