/** RFC3161 verification for synthetic test evidence; revocation is not checked. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

function tlv(tag:number,value:Buffer) {
  if(value.length>=128) throw new Error('DER value too long');
  return Buffer.concat([Buffer.from([tag,value.length]),value]);
}
export function fixtureTimestampNonce(signature:Buffer):Buffer {
  if(!signature.length) throw new Error('Invalid signature');
  return createHash('sha256').update('esign-synthetic-tsa-nonce-v1\n').update(signature).digest().subarray(0,16);
}
export function makeTimestampRequest(signature:Buffer,nonce:Buffer):Buffer {
  if(!signature.length || nonce.length!==16) throw new Error('Invalid timestamp request input');
  const digest=createHash('sha256').update(signature).digest();
  const algorithm=Buffer.from('300d06096086480165030402010500','hex');
  const imprint=tlv(0x30,Buffer.concat([algorithm,tlv(0x04,digest)]));
  let integer=nonce;while(integer.length>1 && integer[0]===0) integer=integer.subarray(1);
  if(integer[0]&0x80) integer=Buffer.concat([Buffer.from([0]),integer]);
  return tlv(0x30,Buffer.concat([Buffer.from('020101','hex'),imprint,tlv(0x02,integer),Buffer.from('0101ff','hex')]));
}
function hasCompleteDerSequence(bytes:Buffer):boolean {
  if(bytes.length<2 || bytes[0]!==0x30)return false;
  const first=bytes[1];
  if(first<128)return bytes.length===first+2;
  const count=first&0x7f;
  if(count===0 || count>4 || bytes.length<2+count || bytes[2]===0)return false;
  let length=0;for(let i=0;i<count;i++)length=length*256+bytes[2+i];
  return length>=128 && bytes.length===2+count+length;
}
export async function verifyTimestampResponse(signature:Buffer,nonce:Buffer,request:Buffer,response:Buffer,roots:Buffer):Promise<void> {
  if(!request.equals(makeTimestampRequest(signature,nonce)) || !hasCompleteDerSequence(response) || !roots.length) throw new Error('Invalid timestamp inputs');
  const dir=await mkdtemp(join(tmpdir(),'esign-ts-verify-'));
  try {
    await Promise.all([writeFile(join(dir,'request'),request,{mode:0o600}),writeFile(join(dir,'response'),response,{mode:0o600}),writeFile(join(dir,'roots'),roots,{mode:0o600})]);
    const exec=promisify(execFile);
    try {
      await exec('openssl',['ts','-verify','-queryfile',join(dir,'request'),'-in',join(dir,'response'),'-CAfile',join(dir,'roots')],{timeout:15000,maxBuffer:1024*1024});
    } catch (error) {throw new Error('RFC3161 response verification failed',{cause:error});}
  } finally {await rm(dir,{recursive:true,force:true});}
}
