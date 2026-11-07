import {isValidOtpEmailAddress} from './cloudflare-otp-mail.ts';

type SinkEnv={INTERNAL_DEMO_EMAIL_DOMAIN?:string;SEND_EMAIL?:{send(message:{from:string;to:string;subject:string;text:string}):Promise<unknown>};INTERNAL_DEMO_OTP_ENABLED?:string;INTERNAL_DEMO_OTP_DELIVERY_MODE?:string;INTERNAL_DEMO_OTP_FROM?:string;INTERNAL_DEMO_OTP_PEPPER?:string;INTERNAL_DEMO_OTP_WINDOW_MS?:string;INTERNAL_DEMO_OTP_TENANT_LIMIT?:string;INTERNAL_DEMO_OTP_DATABASE_LIMIT?:string;INTERNAL_DEMO_STRICT_RECIPIENTS?:string;INTERNAL_DEMO_STRICT_BINDING_RESTRICTIONS_ATTESTED?:string;INTERNAL_DEMO_SINK_TEST_ENABLED?:string;INTERNAL_DEMO_SINK_TEST_ATTESTED?:string;INTERNAL_DEMO_SINK_TEST_ADDRESS?:string;INTERNAL_DEMO_SINK_TEST_SUBJECT?:string;INTERNAL_DEMO_SINK_TEST_ISOLATED?:string;INTERNAL_DEMO_SINK_TEST_BINDING_RESTRICTIONS_ATTESTED?:string};
/** The internal email domain (INTERNAL_DEMO_EMAIL_DOMAIN, e.g. the organization's own); none configured admits nobody. */
export function internalEmailDomain(env:{INTERNAL_DEMO_EMAIL_DOMAIN?:string}):string|null {
 const domain=(env.INTERNAL_DEMO_EMAIL_DOMAIN??'').trim();
 return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)?domain:null;
}
/** An address exactly at the internal email domain (not a subdomain), with a plain local part. */
export function isInternalAddress(env:{INTERNAL_DEMO_EMAIL_DOMAIN?:string},value:unknown):value is string {
 const domain=internalEmailDomain(env);if(!domain||typeof value!=='string'||value.length>254)return false;
 const at=value.lastIndexOf('@');
 return at>0&&value.slice(at+1)===domain&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(value.slice(0,at));
}
const internalAddress=(env:SinkEnv)=>(value:unknown):value is string=>isInternalAddress(env,value);
function strictRecipients(env:SinkEnv):string[] {
 let data:unknown;try{data=JSON.parse(env.INTERNAL_DEMO_STRICT_RECIPIENTS??'');}catch{throw Error('Unavailable');}
 if(!Array.isArray(data)||data.length<1||data.length>20||!data.every(internalAddress(env))||new Set(data).size!==data.length)throw Error('Unavailable');return data;
}
export function internalDemoStrictRecipientAllowed(env:SinkEnv,email:string):boolean {
 return env.INTERNAL_DEMO_OTP_ENABLED!=='true'||env.INTERNAL_DEMO_OTP_DELIVERY_MODE!=='STRICT'||strictRecipients(env).includes(email);
}
/** Runtime attestations do not prove documents are synthetic or binding restrictions are effective. */
export function internalDemoSinkPolicy(env:SinkEnv):{address:string;subject:string}|null {
 const {INTERNAL_DEMO_SINK_TEST_ENABLED:enabled,INTERNAL_DEMO_SINK_TEST_ATTESTED:attested,INTERNAL_DEMO_SINK_TEST_ADDRESS:address,INTERNAL_DEMO_SINK_TEST_SUBJECT:subject,INTERNAL_DEMO_SINK_TEST_ISOLATED:isolated,INTERNAL_DEMO_SINK_TEST_BINDING_RESTRICTIONS_ATTESTED:restricted}=env;
 const sinkAbsent=(enabled===undefined||enabled==='false')&&attested===undefined&&address===undefined&&subject===undefined&&isolated===undefined&&restricted===undefined;
 if(env.INTERNAL_DEMO_OTP_ENABLED!=='true'&&env.INTERNAL_DEMO_OTP_DELIVERY_MODE===undefined&&sinkAbsent&&env.INTERNAL_DEMO_STRICT_RECIPIENTS===undefined&&env.INTERNAL_DEMO_STRICT_BINDING_RESTRICTIONS_ATTESTED===undefined)return null;
 const pepper=typeof env.INTERNAL_DEMO_OTP_PEPPER==='string'?new TextEncoder().encode(env.INTERNAL_DEMO_OTP_PEPPER):new Uint8Array();
 if(env.INTERNAL_DEMO_OTP_ENABLED!=='true'||!env.SEND_EMAIL||typeof env.SEND_EMAIL.send!=='function'||!env.INTERNAL_DEMO_OTP_FROM||!isValidOtpEmailAddress(env.INTERNAL_DEMO_OTP_FROM)||pepper.length<32||pepper.length>256)throw Error('Unavailable');
 if(env.INTERNAL_DEMO_OTP_DELIVERY_MODE==='STRICT') {
  if(!sinkAbsent||env.INTERNAL_DEMO_STRICT_BINDING_RESTRICTIONS_ATTESTED!=='true')throw Error('Unavailable');
  strictRecipients(env);return null;
 }
 if(env.INTERNAL_DEMO_OTP_DELIVERY_MODE!=='SINK_TEST'||env.INTERNAL_DEMO_STRICT_RECIPIENTS!==undefined||env.INTERNAL_DEMO_STRICT_BINDING_RESTRICTIONS_ATTESTED!==undefined||env.INTERNAL_DEMO_OTP_WINDOW_MS!=='86400000'||env.INTERNAL_DEMO_OTP_TENANT_LIMIT!=='2'||env.INTERNAL_DEMO_OTP_DATABASE_LIMIT!=='2'||enabled!=='true'||attested!=='true'||isolated!=='true'||restricted!=='true'||!internalAddress(env)(address)||typeof subject!=='string'||!/^[\x21-\x7e]{1,256}$/.test(subject))throw Error('Unavailable');
 return {address,subject};
}
