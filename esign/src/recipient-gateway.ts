type RecipientGatewayEnv = {
  RECIPIENT_GATEWAY_ENABLED?: string;
  TRUSTED_RECIPIENT_ORIGINS?: string;
  LOCATION_RATE_LIMITER?: { limit(options: {key: string}): Promise<{success: boolean}> };
  RATE_LIMITER?: { limit(options: {key: string}): Promise<{success: boolean}> };
  PRIVATE_RECIPIENT?: { fetch(request: Request): Promise<Response> };
};
const paths = new Set(['/v1/page-sessions/exchange','/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign']);
const exposed = ['content-type','x-signature-width','x-signature-height','x-signature-preview','x-text-width','x-text-height','x-text-preview','x-date-preview-id','x-preview-text'];
const base = {'cache-control':'no-store','x-content-type-options':'nosniff'};
const error = (status:number, code:string) => Response.json({error:code},{status,headers:base});
function clientIp(value:string|null):string|null {
  if (!value || value.length>45) return null;
  if (/^[0-9.]+$/.test(value)) {
    const parts=value.split('.');
    return parts.length===4 && parts.every(p=>/^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p)<=255) ? value : null;
  }
  if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(':')) return null;
  try {return new URL(`http://[${value}]/`).hostname.slice(1,-1);} catch {return null;}
}
function trustedOrigins(value:string|undefined): Set<string>|null {
  if (!value) return null;
  const origins=value.split(',');
  if (origins.some(origin=>{try {const url=new URL(origin); return url.protocol!=='https:' || url.origin!==origin;} catch {return true;}})) return null;
  return new Set(origins);
}
// The IP must be supplied by the Cloudflare edge, not by a caller-controlled forwarding header.
async function handleRecipientGateway(request:Request, env:RecipientGatewayEnv, trustedClientIp:string|null):Promise<Response> {
  const origins=trustedOrigins(env.TRUSTED_RECIPIENT_ORIGINS), ip=clientIp(trustedClientIp);
  if (env.RECIPIENT_GATEWAY_ENABLED!=='true' || !env.PRIVATE_RECIPIENT || !env.RATE_LIMITER || !env.LOCATION_RATE_LIMITER || !origins || !ip) return error(503,'unavailable');
  try {const result=await env.LOCATION_RATE_LIMITER.limit({key:'gateway-location-budget'}); if(result?.success===false) return error(429,'rate_limited'); if(result?.success!==true) return error(503,'unavailable');} catch {return error(503,'unavailable');}
  try {const result=await env.RATE_LIMITER.limit({key:ip}); if(result?.success===false) return error(429,'rate_limited'); if(result?.success!==true) return error(503,'unavailable');} catch {return error(503,'unavailable');}
  const url=new URL(request.url);
  if(url.protocol!=='https:') return error(400,'invalid_request');
  if(!paths.has(url.pathname) || url.search || !['POST','OPTIONS'].includes(request.method)) return error(404,'not_found');
  const origin=request.headers.get('origin');
  if(!origin || !origins.has(origin)) return error(403,'forbidden');
  const cors={'access-control-allow-origin':origin,'vary':'Origin'};
  if(request.method==='OPTIONS') {
    const requested=(request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    if(request.headers.get('access-control-request-method')!=='POST' || requested.some(x=>x!=='content-type')) return error(403,'forbidden');
    return new Response(null,{status:204,headers:{...base,...cors,'access-control-allow-methods':'POST','access-control-allow-headers':'content-type'}});
  }
  if(request.headers.has('authorization')) return error(403,'forbidden');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return error(415,'invalid_content_type');
  try {
    const reader=request.body?.getReader(); const chunks:Uint8Array[]=[]; let size=0;
    if(reader) for(;;) {const part=await reader.read(); if(part.done) break; size+=part.value.byteLength; if(size>4096) {await reader.cancel(); return error(413,'body_too_large');} chunks.push(part.value);}
    const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let body:unknown; try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {return error(400,'invalid_request');}
    if(!body || typeof body!=='object' || Array.isArray(body)) return error(400,'invalid_request');
    const data=body as Record<string,unknown>;
    if(Object.hasOwn(data,'origin') && data.origin!==origin) return error(400,'invalid_request');
    data.origin=origin;
    const serialized=JSON.stringify(data);
    if(new TextEncoder().encode(serialized).byteLength>4096) return error(413,'body_too_large');
    const forwarded=new Request(`https://private-recipient.internal${url.pathname}`,{method:'POST',headers:{'content-type':'application/json'},body:serialized});
    const response=await env.PRIVATE_RECIPIENT.fetch(forwarded);
    const headers=new Headers({...base,...cors,'access-control-expose-headers':exposed.filter(h=>h!=='content-type').join(', ')});
    for(const name of exposed) {const value=response.headers.get(name); if(value) headers.set(name,value);}
    return new Response(response.body,{status:response.status,headers});
  } catch {return error(503,'unavailable');}
}
export async function fetchRecipientGateway(request:Request, env:RecipientGatewayEnv, trustedClientIp:string|null=null):Promise<Response> {
  const response=await handleRecipientGateway(request,env,trustedClientIp);
  const origin=request.headers.get('origin');
  if (new URL(request.url).protocol==='https:' && origin && trustedOrigins(env.TRUSTED_RECIPIENT_ORIGINS)?.has(origin)) {
    const headers=new Headers(response.headers); headers.set('access-control-allow-origin',origin); headers.set('vary','Origin');
    return new Response(response.body,{status:response.status,headers});
  }
  return response;
}
export default {fetch(request:Request,env:RecipientGatewayEnv) {return fetchRecipientGateway(request,env,request.headers.get('cf-connecting-ip'));}};
