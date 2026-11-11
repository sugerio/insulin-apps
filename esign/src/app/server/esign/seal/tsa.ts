import * as asn1 from 'asn1js';
import {BasicConstraints,Certificate,ContentInfo,ExtKeyUsage,SignedData,TimeStampResp,TSTInfo} from 'pkijs';

/**
 * RFC 3161 timestamps for the managed seal (managed.ts): the query sent to the TSA, the
 * verification of its response, and the DigiCert TSA the seal trusts (config.ts).
 */

// --- The timestamp query -----------------------------------------------------------------------
// Version 1, a SHA-256 message imprint, a 16-byte nonce and certReq true, DER-encoded.
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
const tlv=(tag:number,value:Uint8Array)=>{if(value.length>=128)throw new Error('Invalid timestamp request');return concat(new Uint8Array([tag,value.length]),value);};

/** `imprint` is a SHA-256 digest; `nonce` is 16 bytes whose first byte is 1, so it is a positive DER INTEGER of fixed length. */
export function timestampQuery(imprint:Uint8Array,nonce:Uint8Array):Uint8Array<ArrayBuffer>{
 if(imprint.length!==32||nonce.length!==16||nonce[0]!==1)throw new Error('Invalid timestamp query');
 const algorithm=new Uint8Array([0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00]);
 return tlv(0x30,concat(new Uint8Array([0x02,0x01,0x01]),tlv(0x30,concat(algorithm,tlv(0x04,imprint))),tlv(0x02,nonce),new Uint8Array([0x01,0x01,0xff])));
}

// --- Verifying the response --------------------------------------------------------------------
/** missingAccuracyMs: accept a token without accuracy (e.g. DigiCert's), taking this as its uncertainty. */
type Policy={missingAccuracyMs?:number;roots:Uint8Array[];now:number;maxAgeMs:number;maxFutureSkewMs:number;allowedPolicies:string[];allowedIssuerSpkiSha256:string[];checkRevocation:(chain:Uint8Array[],window:{earliest:number;latest:number;checkedAt:number})=>Promise<boolean>};
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
/**
 * Verifies an RFC 3161 timestamp response over SHA-256(`input`) with `nonce`, and returns the
 * token's time. The managed seal (managed.ts) calls it when sealing and on every later
 * verification, with the policy built from the DigiCert trust below. The policy (roots, accepted TSA policies
 * and signers, clock window, revocation check) is trusted configuration, never request input.
 */
export async function verifyRfc3161Timestamp(response:Uint8Array,input:Uint8Array,nonce:Uint8Array,policy:Policy):Promise<{status:'VERIFIED';time:number}>{
 const bytes=copy(response,65536),data=copy(input,4096),expectedNonce=copy(nonce,16);
 if(expectedNonce.length!==16||!policy||!Array.isArray(policy.roots)||!policy.roots.length||policy.roots.length>5||typeof policy.checkRevocation!=='function'||!Number.isSafeInteger(policy.now)||!Number.isSafeInteger(policy.maxAgeMs)||policy.maxAgeMs<0||policy.maxAgeMs>86400000||!Number.isSafeInteger(policy.maxFutureSkewMs)||policy.maxFutureSkewMs<0||policy.maxFutureSkewMs>300000||!Array.isArray(policy.allowedPolicies)||!policy.allowedPolicies.length||!Array.isArray(policy.allowedIssuerSpkiSha256)||!policy.allowedIssuerSpkiSha256.length||policy.allowedIssuerSpkiSha256.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))throw new Error('Timestamp policy missing');
 const roots=policy.roots.map(x=>new Certificate({schema:parse(copy(x,16384))}));
 const {now,maxAgeMs,maxFutureSkewMs,checkRevocation}=policy,allowedPolicies=[...policy.allowedPolicies],allowedIssuers=[...policy.allowedIssuerSpkiSha256];
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
 // The pin is the CA that issued the signer, not the signer: the TSA replaces its signing certificate
 // on its own schedule, and only its CA issues them.
 const issuerSpkiHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(verified.certificatePath[1].subjectPublicKeyInfo.toSchema().toBER(false)))),x=>x.toString(16).padStart(2,'0')).join('');
 if(!allowedIssuers.includes(issuerSpkiHash))throw new Error('Unauthorized TSA issuer');
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
 return {status:'VERIFIED',time:at};
}

// --- DigiCert's public TSA ---------------------------------------------------------------------
/**
 * Trust for RFC 3161 timestamps from DigiCert's public TSA (http://timestamp.digicert.com),
 * fixed in code so that a changed endpoint or certificate can never be accepted silently.
 * Observed 2026-11-06: signer "DigiCert SHA256 RSA4096 Timestamp Responder 2026 1" (valid to
 * 2037-11-04), issued by "DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1", under
 * DigiCert Trusted Root G4. Tokens carry no accuracy field. DigiCert's commercial terms for
 * this free service are not confirmed, and revocation is not checked: see docs/architecture.md.
 */

export const DIGICERT_TSA_URL = 'http://timestamp.digicert.com';
export const DIGICERT_TSA_POLICY = '2.16.840.1.114412.7.1';
/**
 * SHA-256 of the SubjectPublicKeyInfo of each CA whose timestamping certificates are accepted:
 * "DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1" (valid to 2038-01-14). DigiCert
 * replaces the signing certificate under it without notice; a new CA needs its hash added here,
 * and the old one kept, so seals made under it still verify.
 */
export const DIGICERT_TSA_ISSUERS = ['6806f8c7f9c356a294a28796c4db6425d132ca877bf4fded0c2bb00e38807c28'];
/** Uncertainty assumed for a token without an accuracy field. */
export const DIGICERT_MISSING_ACCURACY_MS = 1000;

/** DigiCert Trusted Root G4 (self-signed), DER, base64. */
const DIGICERT_TRUSTED_ROOT_G4 = 'MIIFkDCCA3igAwIBAgIQBZsbV56OITLiOQe9p3d1XDANBgkqhkiG9w0BAQwFADBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1MTIwMDAwWjBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC/5pBzaN675F1KPDAiMGkz7MKnJS7JIT3yithZwuEppz1Yq3aaza57G4QNxDAf8xukOBbrVsaXbR2rsnnyyhHS5F/WBTxSD1Ifxp4VpX6+n6lXFllVcq9ok3DCsrp1mWpzMpTREEQQLt+C8weE5nQ7bXHiLQwb7iDVySAdYyktzuxeTsiT+CFhmzTrBcZe7FsavOvJz82sNEBfsXpm7nfISKhmV1efVFiODCu3T6cw2Vbuyntd463JT17lNecxy9qTXtyOj4DatpGYQJB5w3jHtrHEtWoYOAMQjdjUN6QuBX2I9YI+EJFwq1WCQTLX2wRzKm6RAXwhTNS8rhsDdV14Ztk6MUSaM0C/CNdaSaTC5qmgZ92kJ7yhTzm1EVgX9yRcRo9k98FpiHaYdj1ZXUJ2h4mXaXpI8OCiEhtmmnTK3kse5w5jrubU75KSOp493ADkRSWJtppEGSt+wJS00mFt6zPZxd9LBADMfRyVw4/3IbKyEbe7f/LVjHAsQWCqsWMYRJUadmJ+9oCw++hkpjPRiQfhvbfmQ6QYuKZ3AeEPlAwhHbJUKSWJbOUOUlFHdL4mrLZBdd56rF+NP8m800ERElvlEFDrMcXKchYiCd98THU/Y+whX8QgUWtvsauGi0/C1kVfnSD8oR7FwI+isX4KJpn15GkvmB0t9dmpsh3lGwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQU7NfjgtJxXWRM3y5nP+e6mK4cD08wDQYJKoZIhvcNAQEMBQADggIBALth2X2pbL4XxJEbw6GiAI3jZGgPVs93rnD5/ZpKmbnJeFwMDF/k5hQpVgs2SV1EY+CtnJYYZhsjDT156W1r1lT40jzBQ0CuHVD1UvyQO7uYmWlrx8GnqGikJ9yd+SeuMIW59mdNOj6PWTkiU0TryF0Dyu1Qen1iIQqAyHNm0aAFYF/opbSnr6j3bTWcfFqK1qI4mfN4i/RN0iAL3gTujJtHgXINwBQy7zBZLq7gcfJW5GqXb5JQbZaNaHqasjYUegbyJLkJEVDXCLG4iXqEI2FCKeWjzaIgQdfRnGTZ6iahixTXTBmyUEFxPT9NcCOGDErcgdLMMpSEDQgJlxxPwO5rIHQw0uA5NBCFIRUBCOhVMt5xSdkoF1BN5r5N0XWs0Mr7QbhDparTwwVETyw2m+L64kW4I1NsBm9nVX9GtUw/bihaeSbSpKhil9Ie4u1Ki7wb/UdKDd9nZn6yW0HQO+T0O/QEY+nvwlQAUaCKKsnOeMzV6ocEGLPOr0mIr/OSmbaz5mEP0oUA51Aa5BuVnRmhuZyxm7EAHu/QD09CbMkKvO5D+jpxpchNJqU1/YldvIViHTLSoCtU7ZpXwdv6EM8Zt4tKG48BtieVU+i2iW1bvGjUI+iLUaJW+fCmgKDWHrO8Dw9TdSmq6hN35N6MgSGtBxBHEa2HPQfRdbzP82Z+';

export const digicertRoots = (): Uint8Array[] => [Uint8Array.from(atob(DIGICERT_TRUSTED_ROOT_G4), c => c.charCodeAt(0))];
