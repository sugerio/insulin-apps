import {syntheticTimestampQuery} from './worker-tsa-transport.ts';

const ENDPOINT = 'http://timestamp.digicert.com/';
const FIXTURE = 'esign fixed synthetic DigiCert connectivity test v1\n';
const TIMEOUT_MS = 10000;
const MAX_RESPONSE = 65536;
const MAX_CHUNKS = 65536;
type Options = {enabled?: boolean; fetch: (request: Request) => Promise<Response>};

/** Unmounted connectivity experiment. The response is not verified evidence. */
export async function requestFixedDigiCertTimestamp(options: Options): Promise<{status:'UNVERIFIED'; query:Uint8Array; response:Uint8Array}> {
 if (!options || Object.keys(options).some(key => key !== 'enabled' && key !== 'fetch') || options.enabled !== true || typeof options.fetch !== 'function') throw new Error('Fixed DigiCert transport disabled or invalid configuration');
 const fetcher = options.fetch;
 const imprint = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(FIXTURE)));
 const nonce = crypto.getRandomValues(new Uint8Array(16)); nonce[0] = 1;
 const query = syntheticTimestampQuery(imprint, nonce);
 const controller = new AbortController();
 let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 let expired = false;
 const cancel = (body: ReadableStream<Uint8Array> | null) => { if (body) void body.cancel().catch(() => {}); };
 let timer: ReturnType<typeof setTimeout> | undefined;
 const work = async () => {
  const request = new Request(ENDPOINT, {method:'POST', headers:{'content-type':'application/timestamp-query','accept':'application/timestamp-reply'}, body:query, redirect:'manual', signal:controller.signal});
  const response = await fetcher(request);
  if (expired) { cancel(response.body); throw new Error('TSA timeout'); }
  if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/timestamp-reply' || !response.body) { cancel(response.body); throw new Error('TSA response rejected'); }
  reader = response.body.getReader();
  const output = new Uint8Array(MAX_RESPONSE); let size=0, chunks=0;
  try {
   while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (++chunks > MAX_CHUNKS || part.value.length > MAX_RESPONSE-size) throw new Error('TSA response limit exceeded');
    output.set(part.value,size); size+=part.value.length;
   }
   if (!size) throw new Error('TSA response rejected');
   return {status:'UNVERIFIED' as const, query, response:output.slice(0,size)};
  } finally {
   if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); reader=undefined; }
  }
 };
 try {
  return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true; controller.abort(); if(reader) void reader.cancel().catch(()=>{}); reject(new Error('TSA timeout'));},TIMEOUT_MS);})]);
 } finally { if(timer!==undefined) clearTimeout(timer); }
}
