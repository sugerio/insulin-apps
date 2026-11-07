import {requestAuthorizedSyntheticTimestamp} from './worker-tsa-transport.ts';
import {verifyRfc3161Candidate} from './worker-rfc3161-verifier.ts';

type Transport=Parameters<typeof requestAuthorizedSyntheticTimestamp>[1];
type Policy=Parameters<typeof verifyRfc3161Candidate>[3];
const typedArray=Object.getPrototypeOf(Uint8Array.prototype);
const buffer=Object.getOwnPropertyDescriptor(typedArray,'buffer')!.get!;
const length=Object.getOwnPropertyDescriptor(typedArray,'length')!.get!;
function snapshot(input:Uint8Array,max:number):Uint8Array<ArrayBuffer>{
 if(!(input instanceof Uint8Array)||!(buffer.call(input) instanceof ArrayBuffer))throw new Error('Invalid synthetic timestamp input');
 const n=length.call(input) as number;if(!n||n>max)throw new Error('Invalid synthetic timestamp input');const out=new Uint8Array(n);out.set(input);return out;
}
/** Unmounted test-only composition; trusted dependencies must establish synthetic provenance and revocation. */
export async function verifyAuthorizedSyntheticTimestampCandidate(input:Uint8Array,transport:Transport,policy:Policy):Promise<{status:'VERIFIED_SYNTHETIC_TEST_CANDIDATE';time:number;query:Uint8Array;response:Uint8Array;nonce:Uint8Array}>{ 
 const data=snapshot(input,4096);
 if(!transport||!Array.isArray(transport.allowedEndpoints))throw new Error('Synthetic transport configuration missing');
 const fixedTransport={endpoint:transport.endpoint,allowedEndpoints:[...transport.allowedEndpoints],timeoutMs:transport.timeoutMs,authorizeSynthetic:transport.authorizeSynthetic,fetch:transport.fetch};
 if(!policy||!Array.isArray(policy.roots)||!policy.roots.length||policy.roots.length>5||typeof policy.checkRevocation!=='function'||!Number.isSafeInteger(policy.now)||!Number.isSafeInteger(policy.maxAgeMs)||policy.maxAgeMs<0||policy.maxAgeMs>86400000||!Number.isSafeInteger(policy.maxFutureSkewMs)||policy.maxFutureSkewMs<0||policy.maxFutureSkewMs>300000||!Array.isArray(policy.allowedPolicies)||!policy.allowedPolicies.length||policy.allowedPolicies.some(x=>typeof x!=='string')||!Array.isArray(policy.allowedSignerSpkiSha256)||!policy.allowedSignerSpkiSha256.length||policy.allowedSignerSpkiSha256.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))throw new Error('Synthetic timestamp policy missing');
 const fixedPolicy={roots:policy.roots.map(r=>snapshot(r,16384)),now:policy.now,maxAgeMs:policy.maxAgeMs,maxFutureSkewMs:policy.maxFutureSkewMs,allowedPolicies:[...policy.allowedPolicies],allowedSignerSpkiSha256:[...policy.allowedSignerSpkiSha256],checkRevocation:policy.checkRevocation};
 const imprint=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
 const result=await requestAuthorizedSyntheticTimestamp(imprint,fixedTransport);
 const verified=await verifyRfc3161Candidate(result.response,data,result.nonce,fixedPolicy);
 return {status:'VERIFIED_SYNTHETIC_TEST_CANDIDATE',time:verified.time,query:result.query,response:result.response,nonce:result.nonce};
}
