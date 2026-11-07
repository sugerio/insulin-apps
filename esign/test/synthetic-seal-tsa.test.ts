import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTimestampRequest, verifyTimestampResponse } from '../scripts/synthetic-seal-tsa.ts';

const run=(args:string[],cwd:string)=>execFileSync('openssl',args,{cwd,stdio:'pipe'});
test('RFC3161 verifier checks granted status, imprint, nonce, signature and independent trust anchor',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'esign-tsa-test-'));
  try {
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],dir);
    run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Synthetic TSA'],dir);
    await writeFile(join(dir,'extensions.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
    run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','extensions.cnf','-out','tsa.pem'],dir);
    await writeFile(join(dir,'serial'),'01\n');
    await writeFile(join(dir,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\naccuracy=secs:1\nordering=no\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n');
    const signature=Buffer.from('fixed synthetic signature'),nonce=Buffer.from('0102030405060708090a0b0c0d0e0f10','hex');
    const request=makeTimestampRequest(signature,nonce);
    await writeFile(join(dir,'request.tsq'),request);
    run(['ts','-reply','-config','tsa.cnf','-queryfile','request.tsq','-out','response.tsr'],dir);
    const response=await readFile(join(dir,'response.tsr')),roots=await readFile(join(dir,'root.pem'));
    await verifyTimestampResponse(signature,nonce,request,response,roots);
    await assert.rejects(verifyTimestampResponse(signature,nonce,request,Buffer.concat([response,Buffer.from('x')]),roots));
    await assert.rejects(verifyTimestampResponse(Buffer.from('changed'),nonce,request,response,roots));
    await assert.rejects(verifyTimestampResponse(signature,Buffer.alloc(16,7),request,response,roots));
    await assert.rejects(verifyTimestampResponse(signature,nonce,request,Buffer.from('bad'),roots));
    const bad=Buffer.from(response);bad[bad.length-1]^=1;
    await assert.rejects(verifyTimestampResponse(signature,nonce,request,bad,roots));
    await assert.rejects(verifyTimestampResponse(signature,nonce,request,response,Buffer.from('not a trust root')));
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','other.key','-out','other.pem','-subj','/CN=Other Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE'],dir);
    const other=await readFile(join(dir,'other.pem'));
    const old=process.env.SSL_CERT_FILE;process.env.SSL_CERT_FILE=join(dir,'root.pem');
    try {await assert.rejects(verifyTimestampResponse(signature,nonce,request,response,other));}
    finally {if(old===undefined) delete process.env.SSL_CERT_FILE;else process.env.SSL_CERT_FILE=old;}
    const badStatus=Buffer.from(response);const status=badStatus.indexOf(Buffer.from('3003020100','hex'));
    assert.ok(status>=0);badStatus[status+4]=2;
    await assert.rejects(verifyTimestampResponse(signature,nonce,request,badStatus,roots));
    await assert.rejects(verifyTimestampResponse(signature,Buffer.alloc(0),request,response,roots));
    const wrongQuery=Buffer.from(request);wrongQuery[wrongQuery.length-1]^=1;
    await assert.rejects(verifyTimestampResponse(signature,nonce,wrongQuery,response,roots));
  } finally {await rm(dir,{recursive:true,force:true});}
});
