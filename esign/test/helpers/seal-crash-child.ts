import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {writeSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sealDynamicSyntheticWorkspace,sealSyntheticWorkspace} from '../../scripts/synthetic-seal-orchestration.ts';
const [workspace,temp,mode]=process.argv.slice(2);
const privateKey=createPrivateKey(await readFile(join(temp,'kms-private.pem')));
const publicKey=createPublicKey(privateKey).export({type:'spki',format:'der'});
const deps={
 roots:await readFile(join(temp,'root.pem')),
 aws:async(args,message)=>args[0]==='get-public-key'?{KeyId:'fixture-key',KeySpec:'ECC_NIST_P256',KeyUsage:'SIGN_VERIFY',SigningAlgorithms:['ECDSA_SHA_256'],PublicKey:publicKey.toString('base64')}:{KeyId:'fixture-key',SigningAlgorithm:'ECDSA_SHA_256',Signature:sign('sha256',message!,privateKey).toString('base64')},
 timestamp:async()=>{writeSync(1,'timestamp-ready\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);throw new Error('unreachable');}
};
if(mode==='dynamic') {
 const data=JSON.parse(await readFile(join(workspace,'fixture'),'utf8'));
 const fixture={...data,artifacts:data.artifacts.map((s:string)=>new Uint8Array(Buffer.from(s,'base64')))};
 await sealDynamicSyntheticWorkspace(workspace,fixture,deps);
} else await sealSyntheticWorkspace(workspace,deps);
