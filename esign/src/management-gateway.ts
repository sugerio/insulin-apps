import {readCandidateUpload} from './candidate-upload-body.ts';
type GatewayEnv = {
  MANAGEMENT_GATEWAY_ENABLED?: string;
  LOCATION_RATE_LIMITER?: { limit(options: {key: string}): Promise<{success: boolean}> };
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  PRIVATE_MANAGEMENT?: { fetch(request: Request): Promise<Response> };
};
const baseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string) => Response.json({error: code}, {status, headers: baseHeaders});
const task = '[A-Za-z0-9_-]{1,128}';
const view = new RegExp(`^/v1/envelopes/${task}/tasks/${task}/recipient-view$`);
const emptyPost = new RegExp(`^/v1/envelopes/${task}/tasks/${task}/(?:recipient-revoke|jobs/${task}/recover)$`);
const prepare = new RegExp(`^/v1/envelopes/${task}/prepare$`);
const lookup = new RegExp(`^/v1/envelopes/${task}/tasks/${task}/job$`);
const taskList = new RegExp(`^/v1/envelopes/${task}/tasks$`);

function normalizedClientIp(value: string | null): string | null {
  if (!value || value.length > 45) return null;
  if (/^[0-9.]+$/.test(value)) {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
    return value;
  }
  if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(':')) return null;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
}

// trustedClientIp must come from the Cloudflare edge, never from a caller-controlled forwarding header.
export async function fetchManagementGateway(request: Request, env: GatewayEnv, trustedClientIp: string | null = null): Promise<Response> {
  if (env.MANAGEMENT_GATEWAY_ENABLED !== 'true' || !env.PRIVATE_MANAGEMENT || !env.RATE_LIMITER || !env.LOCATION_RATE_LIMITER) return error(503, 'unavailable');
  const ip = normalizedClientIp(trustedClientIp);
  if (!ip) return error(503, 'unavailable');
  try {const result=await env.LOCATION_RATE_LIMITER.limit({key:'gateway-location-budget'}); if(result?.success===false) return error(429,'rate_limited'); if(result?.success!==true) return error(503,'unavailable');} catch {return error(503,'unavailable');}
  try {
    const decision = await env.RATE_LIMITER.limit({key: ip});
    if (decision?.success === false) return error(429, 'rate_limited');
    if (decision?.success !== true) return error(503, 'unavailable');
  } catch { return error(503, 'unavailable'); }
  const url = new URL(request.url);
  if (url.protocol !== 'https:') return error(400, 'invalid_request');
  const isEditorIssue = request.method === 'POST' && url.pathname === '/v1/editor-sessions';
  const isView = request.method === 'POST' && view.test(url.pathname);
  const isCreate = request.method === 'POST' && url.pathname === '/v1/envelopes';
  const isTemplate = request.method === 'POST' && url.pathname === '/v1/templates';
  const isPrepare = request.method === 'POST' && prepare.test(url.pathname);
  const allowed = isEditorIssue || isTemplate || isCreate || isPrepare || isView || (request.method === 'POST' && emptyPost.test(url.pathname)) ||
    (request.method === 'GET' && (url.pathname === '/v1/me' || /^\/v1\/editor-sessions\/[a-f0-9]{64}\/result$/.test(url.pathname) || taskList.test(url.pathname) || lookup.test(url.pathname)));
  if (!allowed || url.search) return error(404, 'not_found');
  if (request.headers.has('origin')) return error(403, 'forbidden');
  const authorization = request.headers.get('authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) return error(401, 'unauthorized');
  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (isCreate && (!/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey) || request.headers.get('content-type') !== 'application/json')) return error(400, 'invalid_request');
  if (isEditorIssue) {
    if (request.headers.get('content-type') !== 'application/json') return error(415,'invalid_content_type');
    try {
      const bytes=await readCandidateUpload(request.body,10000,4096);
      const response=await env.PRIVATE_MANAGEMENT.fetch(new Request('https://private-management.internal/v1/editor-sessions',{method:'POST',headers:{authorization,'content-type':'application/json'},body:Uint8Array.from(bytes).buffer}));
      const headers=new Headers(baseHeaders); const type=response.headers.get('content-type'); if(type) headers.set('content-type',type);
      return new Response(response.body,{status:response.status,headers});
    } catch {return error(503,'unavailable');}
  }
  if (isTemplate) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    try {
      let size = 0;
      reader = request.body?.getReader();
      const source = reader;
      const bounded = source ? new ReadableStream<Uint8Array>({
        async pull(controller) { const part=await source.read(); if(part.done){finished=true;controller.close();return;} const remaining=5*1024*1024+65537-size; if(part.value.byteLength>=remaining){controller.enqueue(part.value.subarray(0,remaining));controller.close();finished=true;void source.cancel().catch(()=>{});return;} size+=part.value.byteLength; controller.enqueue(part.value); },
        cancel(reason) { finished=true; return source.cancel(reason); }
      }, {highWaterMark:0}) : undefined;
      const headers = new Headers({authorization});
      for (const name of ['content-type', 'idempotency-key']) { const value=request.headers.get(name); if(value !== null) headers.set(name,value); }
      const forwarded = new Request(`https://private-management.internal${url.pathname}`, {method:'POST',headers,...(bounded ? {body:bounded,duplex:'half'} : {})} as RequestInit);
      const response = await env.PRIVATE_MANAGEMENT.fetch(forwarded);
      const resultHeaders = new Headers(baseHeaders); const contentType=response.headers.get('content-type'); if(contentType) resultHeaders.set('content-type',contentType);
      return new Response(response.body,{status:response.status,headers:resultHeaders});
    } catch { return error(503,'unavailable'); }
    finally { if (reader) { if (!finished) void reader.cancel().catch(()=>{}); reader.releaseLock(); } }
  }
  const limit = isView || isCreate ? 4096 : 0;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) { await reader.cancel(); return error(413, 'body_too_large'); }
        chunks.push(part.value);
      }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers({authorization});
    if (isView || isCreate) headers.set('content-type', 'application/json');
    if (isCreate) headers.set('idempotency-key', idempotencyKey);
    const forwarded = new Request(`https://private-management.internal${url.pathname}`, {
      method: request.method, headers, ...(size ? {body: bytes} : {})
    });
    const response = await env.PRIVATE_MANAGEMENT.fetch(forwarded);
    const resultHeaders = new Headers(baseHeaders);
    const contentType = response.headers.get('content-type');
    if (contentType) resultHeaders.set('content-type', contentType);
    return new Response(response.body, {status: response.status, headers: resultHeaders});
  } catch { return error(503, 'unavailable'); }
}
export default { fetch(request: Request, env: GatewayEnv) {
  return fetchManagementGateway(request, env, request.headers.get('cf-connecting-ip'));
} };
