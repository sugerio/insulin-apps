import {readCandidateUpload} from './candidate-upload-body.ts';
type EditorGatewayEnv = {
  EDITOR_GATEWAY_ENABLED?: string;
  TRUSTED_EDITOR_ORIGINS?: string;
  LOCATION_RATE_LIMITER?: { limit(options: {key: string}): Promise<{success: boolean}> };
  RATE_LIMITER?: { limit(options: {key: string}): Promise<{success: boolean}> };
  PRIVATE_EDITOR?: { fetch(request: Request): Promise<Response> };
};
const paths = new Set(['/v1/editor-sessions/exchange','/v1/editor-sessions/context','/v1/editor-sessions/save']);
const exposed = ['content-type'];
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
async function handleEditorGateway(request:Request, env:EditorGatewayEnv, trustedClientIp:string|null):Promise<Response> {
  const origins=trustedOrigins(env.TRUSTED_EDITOR_ORIGINS), ip=clientIp(trustedClientIp);
  if (env.EDITOR_GATEWAY_ENABLED!=='true' || !env.PRIVATE_EDITOR || !env.RATE_LIMITER || !env.LOCATION_RATE_LIMITER || !origins || !ip) return error(503,'unavailable');
  try {const result=await env.LOCATION_RATE_LIMITER.limit({key:'gateway-location-budget'}); if(result?.success===false) return error(429,'rate_limited'); if(result?.success!==true) return error(503,'unavailable');} catch {return error(503,'unavailable');}
  try {const result=await env.RATE_LIMITER.limit({key:ip}); if(result?.success===false) return error(429,'rate_limited'); if(result?.success!==true) return error(503,'unavailable');} catch {return error(503,'unavailable');}
  const url=new URL(request.url);
  if(url.protocol!=='https:') return error(400,'invalid_request');
  if(!paths.has(url.pathname) || url.search || !['POST','OPTIONS'].includes(request.method)) return error(404,'not_found');
  const origin=request.headers.get('origin');
  if(!origin || !origins.has(origin)) return error(403,'forbidden');
  const cors={'access-control-allow-origin':origin,'vary':'Origin'};
  const save=url.pathname==='/v1/editor-sessions/save';
  if(request.method==='OPTIONS') {
    const requested=(request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    if(request.headers.get('access-control-request-method')!=='POST' || requested.some(x=>!(save?['content-type','x-editor-token','idempotency-key']:['content-type']).includes(x))) return error(403,'forbidden');
    return new Response(null,{status:204,headers:{...base,...cors,'access-control-allow-methods':'POST','access-control-allow-headers':save?'content-type, x-editor-token, idempotency-key':'content-type'}});
  }
  if(request.headers.has('authorization')) return error(403,'forbidden');
  if(save) {
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let finished=false;
    try {
      let size=0;reader=request.body?.getReader();const source=reader;
      const bounded=source?new ReadableStream<Uint8Array>({async pull(controller){const part=await source.read();if(part.done){finished=true;controller.close();return;}const remaining=5*1024*1024+65537-size;if(part.value.byteLength>=remaining){controller.enqueue(part.value.subarray(0,remaining));controller.close();finished=true;void source.cancel().catch(()=>{});return;}size+=part.value.byteLength;controller.enqueue(part.value);},cancel(reason){finished=true;return source.cancel(reason);}},{highWaterMark:0}):undefined;
      const headers=new Headers({origin});for(const name of ['content-type','x-editor-token','idempotency-key']){const value=request.headers.get(name);if(value!==null)headers.set(name,value);}
      const response=await env.PRIVATE_EDITOR.fetch(new Request('https://private-editor.internal/v1/editor-sessions/save',{method:'POST',headers,...(bounded?{body:bounded,duplex:'half'}:{})} as RequestInit));
      const resultHeaders=new Headers({...base,...cors});const type=response.headers.get('content-type');if(type)resultHeaders.set('content-type',type);return new Response(response.body,{status:response.status,headers:resultHeaders});
    }catch{return error(503,'unavailable');}finally{if(reader){if(!finished)void reader.cancel().catch(()=>{});reader.releaseLock();}}
  }
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return error(415,'invalid_content_type');
  try {
    const bytes=await readCandidateUpload(request.body,10000,4096);
    let body:unknown; try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {return error(400,'invalid_request');}
    if(!body || typeof body!=='object' || Array.isArray(body)) return error(400,'invalid_request');
    const data=body as Record<string,unknown>;
    if(Object.hasOwn(data,'origin') && data.origin!==origin) return error(400,'invalid_request');
    data.origin=origin;
    const serialized=JSON.stringify(data);
    if(new TextEncoder().encode(serialized).byteLength>4096) return error(413,'body_too_large');
    const forwarded=new Request(`https://private-editor.internal${url.pathname}`,{method:'POST',headers:{'content-type':'application/json'},body:serialized});
    const response=await env.PRIVATE_EDITOR.fetch(forwarded);
    const headers=new Headers({...base,...cors,'access-control-expose-headers':exposed.filter(h=>h!=='content-type').join(', ')});
    for(const name of exposed) {const value=response.headers.get(name); if(value) headers.set(name,value);}
    return new Response(response.body,{status:response.status,headers});
  } catch {return error(503,'unavailable');}
}
export async function fetchEditorGateway(request:Request, env:EditorGatewayEnv, trustedClientIp:string|null=null):Promise<Response> {
  const response=await handleEditorGateway(request,env,trustedClientIp);
  const origin=request.headers.get('origin');
  if (new URL(request.url).protocol==='https:' && origin && trustedOrigins(env.TRUSTED_EDITOR_ORIGINS)?.has(origin)) {
    const headers=new Headers(response.headers); headers.set('access-control-allow-origin',origin); headers.set('vary','Origin');
    return new Response(response.body,{status:response.status,headers});
  }
  return response;
}
export default {fetch(request:Request,env:EditorGatewayEnv) {return fetchEditorGateway(request,env,request.headers.get('cf-connecting-ip'));}};
