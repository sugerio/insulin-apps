import * as asn1 from 'asn1js';
import {BasicConstraints,Certificate,ContentInfo,ExtKeyUsage,SignedData,TimeStampResp,TSTInfo} from 'pkijs';

/** missingAccuracyMs: accept a token without accuracy (e.g. DigiCert's), taking this as its uncertainty. */
type Policy={missingAccuracyMs?:number;roots:Uint8Array[];now:number;maxAgeMs:number;maxFutureSkewMs:number;allowedPolicies:string[];allowedSignerSpkiSha256:string[];checkRevocation:(chain:Uint8Array[],window:{earliest:number;latest:number;checkedAt:number})=>Promise<boolean>};
const SHA256='2.16.840.1.101.3.4.2.1',RSA='1.2.840.113549.1.1.1',SHA256_RSA='1.2.840.113549.1.1.11',SHA384_RSA='1.2.840.113549.1.1.12';
const eq=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const copy=(v:Uint8Array,max:number)=>{if(!(v instanceof Uint8Array)||!(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'buffer')!.get!.call(v) instanceof ArrayBuffer))throw new Error('Invalid input');const n=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'length')!.get!.call(v) as number;if(!n||n>max)throw new Error('Invalid input');const out=new Uint8Array(n);out.set(v);return out;};
function screenDer(bytes:Uint8Array):void {
 let nodes=0;
 const read=(start:number,end:number,depth:number):number=>{
  if(depth>24||++nodes>4096||start>=end)throw new Error('Invalid DER');
  let p=start;const tag=bytes[p++],constructed=!!(tag&32);if((tag&31)===31)throw new Error('Unsupported DER tag');
  if(p>=end)throw new Error('Invalid DER');const first=bytes[p++];let len=first;
  if(first&128){const count=first&127;if(!count||count>3||p+count>end||bytes[p]===0)throw new Error('Invalid DER length');len=0;for(let i=0;i<count;i++)len=len*256+bytes[p++];if(len<128)throw new Error('Nonminimal DER length');}
  const stop=p+len;if(stop>end)throw new Error('Truncated DER');
  if((tag&192)===0){const number=tag&31;if(number===0||(constructed&&number!==16&&number!==17)||(!constructed&&(number===16||number===17)))throw new Error('Invalid DER type');
   if(number===2&&(len===0||(len>1&&((bytes[p]===0&&(bytes[p+1]&128)===0)||(bytes[p]===255&&(bytes[p+1]&128)!==0)))))throw new Error('Invalid DER integer');
   if(number===1&&(len!==1||(bytes[p]!==0&&bytes[p]!==255)))throw new Error('Invalid DER boolean');
  }
  if(constructed){let previous:Uint8Array|undefined;while(p<stop){const start=p;p=read(p,stop,depth+1);if(tag===0x31){const current=bytes.subarray(start,p);if(previous){let i=0;while(i<previous.length&&i<current.length&&previous[i]===current[i])i++;if(i===current.length&&i<previous.length||i<previous.length&&i<current.length&&previous[i]>current[i])throw new Error('Unsorted DER set');}previous=current;}}if(p!==stop)throw new Error('Invalid DER content');}
  return stop;
 };
 if(read(0,bytes.length,0)!==bytes.length)throw new Error('Trailing DER');
}
const parse=(bytes:Uint8Array<ArrayBuffer>)=>{screenDer(bytes);const p=asn1.fromBER(bytes.buffer);if(p.offset!==bytes.length||!(p.result instanceof asn1.Sequence))throw new Error('Invalid ASN.1');return p.result;};
const der=(c:Certificate)=>new Uint8Array(c.toSchema().toBER(false));
/** Unmounted test candidate: injected policy is a trusted infrastructure boundary, not an end-user assertion. */
export async function verifyRfc3161Candidate(response:Uint8Array,input:Uint8Array,nonce:Uint8Array,policy:Policy):Promise<{status:'VERIFIED_TEST_CANDIDATE';time:number}>{
 const bytes=copy(response,65536),data=copy(input,4096),expectedNonce=copy(nonce,16);
 if(expectedNonce.length!==16||!policy||!Array.isArray(policy.roots)||!policy.roots.length||policy.roots.length>5||typeof policy.checkRevocation!=='function'||!Number.isSafeInteger(policy.now)||!Number.isSafeInteger(policy.maxAgeMs)||policy.maxAgeMs<0||policy.maxAgeMs>86400000||!Number.isSafeInteger(policy.maxFutureSkewMs)||policy.maxFutureSkewMs<0||policy.maxFutureSkewMs>300000||!Array.isArray(policy.allowedPolicies)||!policy.allowedPolicies.length||!Array.isArray(policy.allowedSignerSpkiSha256)||!policy.allowedSignerSpkiSha256.length||policy.allowedSignerSpkiSha256.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))throw new Error('Timestamp policy missing');
 const roots=policy.roots.map(x=>new Certificate({schema:parse(copy(x,16384))}));
 const {now,maxAgeMs,maxFutureSkewMs,checkRevocation}=policy,allowedPolicies=[...policy.allowedPolicies],allowedSigners=[...policy.allowedSignerSpkiSha256];
 const tsp=new TimeStampResp({schema:parse(bytes)});
 if(tsp.status.status!==0||tsp.status.failInfo||!tsp.timeStampToken||tsp.timeStampToken.contentType!==ContentInfo.SIGNED_DATA)throw new Error('Timestamp response rejected');
 const signed=new SignedData({schema:tsp.timeStampToken.content});
 if(signed.signerInfos.length!==1||!signed.certificates||signed.certificates.length>5||signed.encapContentInfo.eContentType!=='1.2.840.113549.1.9.16.1.4'||!signed.encapContentInfo.eContent)throw new Error('Unsupported CMS');
 const info=new TSTInfo({schema:parse(copy(signed.encapContentInfo.eContent.valueBlock.valueHexView,16384))});
 const at=info.genTime.getTime(),imprint=new Uint8Array(await crypto.subtle.digest('SHA-256',data)),accuracy=info.accuracy;
 const missing=policy.missingAccuracyMs;
 if(missing!==undefined&&(!Number.isSafeInteger(missing)||missing<1||missing>60000))throw new Error('Invalid policy');
 if(!accuracy&&missing===undefined)throw new Error('Invalid timestamp accuracy');
 if(accuracy&&([accuracy.seconds,accuracy.millis,accuracy.micros].every(x=>x===undefined)||!Number.isInteger(accuracy.seconds??0)||(accuracy.seconds??0)<0||(accuracy.seconds??0)>86400||[accuracy.millis,accuracy.micros].some(x=>x!==undefined&&(!Number.isInteger(x)||x<1||x>999))))throw new Error('Invalid timestamp accuracy');
 const uncertainty=accuracy?(accuracy.seconds??0)*1000+(accuracy.millis??0)+Math.ceil((accuracy.micros??0)/1000):missing!;
 if(info.version!==1||!allowedPolicies.includes(info.policy)||!Number.isSafeInteger(at)||at-uncertainty<now-maxAgeMs||at+uncertainty>now+maxFutureSkewMs||info.messageImprint.hashAlgorithm.algorithmId!==SHA256||!eq(info.messageImprint.hashedMessage.valueBlock.valueHexView,imprint)||!info.nonce||!eq(info.nonce.valueBlock.valueHexView,expectedNonce)||info.extensions?.length)throw new Error('Timestamp facts rejected');
 const signer=signed.signerInfos[0];if(signer.digestAlgorithm.algorithmId!==SHA256||![RSA,SHA256_RSA].includes(signer.signatureAlgorithm.algorithmId)||!signer.signedAttrs)throw new Error('Unsupported signer algorithm');
 screenDer(new Uint8Array(signer.signedAttrs.encodedValue));
 const attrs=signer.signedAttrs.attributes;for(const oid of ['1.2.840.113549.1.9.3','1.2.840.113549.1.9.4','1.2.840.113549.1.9.16.2.47'])if(attrs.filter(a=>a.type===oid).length!==1)throw new Error('Required CMS attributes missing');
 const ctype=attrs.find(a=>a.type==='1.2.840.113549.1.9.3')!;if(ctype.values.length!==1||!(ctype.values[0] instanceof asn1.ObjectIdentifier)||ctype.values[0].valueBlock.toString()!=='1.2.840.113549.1.9.16.1.4')throw new Error('Invalid CMS content type');
 const digestAttr=attrs.find(a=>a.type==='1.2.840.113549.1.9.4')!;if(digestAttr.values.length!==1||!(digestAttr.values[0] instanceof asn1.OctetString)||digestAttr.values[0].valueBlock.valueHexView.length!==32)throw new Error('Invalid CMS message digest attribute');
 // A token may also carry a cross-signed copy of a pinned root (DigiCert sends Trusted Root G4
 // issued by Assured ID Root CA); path building would follow it and fail. Keep the pinned anchor.
 const rootSubjects=roots.map(r=>new Uint8Array(r.subject.toSchema().toBER(false))),rootDers=roots.map(der);
 signed.certificates=signed.certificates.filter(c=>!(c instanceof Certificate)||!rootSubjects.some(subject=>eq(new Uint8Array(c.subject.toSchema().toBER(false)),subject))||rootDers.some(r=>eq(der(c),r)));
 const verified=await signed.verify({signer:0,data:data.buffer,checkChain:true,passedWhenNotRevValues:true,trustedCerts:roots,extendedMode:true});
 if(verified.signatureVerified!==true||verified.signerCertificateVerified!==true||!verified.signerCertificate||verified.certificatePath.length<2||!eq(der(verified.signerCertificate),der(verified.certificatePath[0])))throw new Error('Invalid CMS signature or chain');
 const cert=verified.signerCertificate,exts=cert.extensions??[],eku=exts.filter(x=>x.extnID==='2.5.29.37');
 const spkiHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false)))),x=>x.toString(16).padStart(2,'0')).join('');
 if(!allowedSigners.includes(spkiHash))throw new Error('Unauthorized TSA signer');
 if(eku.length!==1||!eku[0].critical||!(eku[0].parsedValue instanceof ExtKeyUsage)||eku[0].parsedValue.keyPurposes.length!==1||eku[0].parsedValue.keyPurposes[0]!=='1.3.6.1.5.5.7.3.8')throw new Error('Invalid TSA EKU');
 const constraints=exts.filter(x=>x.extnID==='2.5.29.19'),usage=exts.filter(x=>x.extnID==='2.5.29.15');
 if(constraints.length!==1||!(constraints[0].parsedValue instanceof BasicConstraints)||constraints[0].parsedValue.cA||usage.length!==1||!usage[0].critical)throw new Error('Invalid TSA key constraints');
 const ku=asn1.fromBER(Uint8Array.from(usage[0].extnValue.valueBlock.valueHexView));if(ku.offset!==usage[0].extnValue.valueBlock.valueHexView.length||!(ku.result instanceof asn1.BitString)||!(ku.result.valueBlock.valueHexView[0]&0x80))throw new Error('Invalid TSA key usage');
 const ess=attrs.find(a=>a.type==='1.2.840.113549.1.9.16.2.47')!;
 const seq=ess.values[0] as asn1.Sequence;const certs=seq?.valueBlock?.value?.[0] as asn1.Sequence;const certId=certs?.valueBlock?.value?.[0] as asn1.Sequence;const hashValue=certId?.valueBlock?.value?.[0];
 if(ess.values.length!==1||!(seq instanceof asn1.Sequence)||!(certs instanceof asn1.Sequence)||certs.valueBlock.value.length!==1||!(certId instanceof asn1.Sequence)||certId.valueBlock.value.length!==1||!(hashValue instanceof asn1.OctetString)||!eq(hashValue.valueBlock.valueHexView,new Uint8Array(await crypto.subtle.digest('SHA-256',der(cert)))))throw new Error('Invalid ESS signer binding');
 for(const [index,c] of verified.certificatePath.entries()){
  const seen=new Set<string>();for(const ext of c.extensions??[]){if(seen.has(ext.extnID))throw new Error('Duplicate certificate extension');seen.add(ext.extnID);const allowed=index===0?['2.5.29.15','2.5.29.19','2.5.29.37']:['2.5.29.15','2.5.29.19'];if(ext.critical&&!allowed.includes(ext.extnID))throw new Error('Unsupported critical certificate extension');}
  if(at-uncertainty<c.notBefore.value.getTime()||at+uncertainty>c.notAfter.value.getTime())throw new Error('Certificate outside timestamp window');if(!(c.signatureAlgorithm.algorithmId===SHA256_RSA||(index>0&&c.signatureAlgorithm.algorithmId===SHA384_RSA))||c.subjectPublicKeyInfo.algorithm.algorithmId!==RSA)throw new Error('Unsupported certificate algorithm');const key=await crypto.subtle.importKey('spki',new Uint8Array(c.subjectPublicKeyInfo.toSchema().toBER(false)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},true,['verify']);if((key.algorithm as RsaKeyAlgorithm).modulusLength<2048)throw new Error('Weak RSA key');}
 if(await checkRevocation(verified.certificatePath.map(der),{earliest:at-uncertainty,latest:at+uncertainty,checkedAt:now})!==true)throw new Error('Revocation policy failed');
 return {status:'VERIFIED_TEST_CANDIDATE',time:at};
}
