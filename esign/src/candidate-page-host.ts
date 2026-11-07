type Manifest = {recipientOrigin:string; editorOrigin:string; files:Record<string,{sha256:string;length:number;type:string}>};
type Environment = {HOST_ENABLED?:string; RECIPIENT_GATEWAY_ORIGIN?:string; EDITOR_GATEWAY_ORIGIN?:string; ASSETS?:{fetch(request:Request):Promise<Response>}};
declare const __CANDIDATE_MANIFEST__: Manifest;

function exactHttps(value:string):boolean {
 try { const url=new URL(value); return url.protocol==='https:' && url.origin===value && !url.username && !url.password; } catch { return false; }
}
export function createCandidatePageHost(manifest:Manifest) {
 return {async fetch(request:Request, env:Environment):Promise<Response> {
  const missing=()=>new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  const unavailable=()=>new Response('Unavailable',{status:503,headers:{'cache-control':'no-store'}});
  if(env.HOST_ENABLED!=='true' || request.method!=='GET') return missing();
  const url=new URL(request.url);
  if(url.search || !Object.hasOwn(manifest.files,url.pathname)) return missing();
  if(!exactHttps(manifest.recipientOrigin)||!exactHttps(manifest.editorOrigin)||env.RECIPIENT_GATEWAY_ORIGIN!==manifest.recipientOrigin||env.EDITOR_GATEWAY_ORIGIN!==manifest.editorOrigin||!env.ASSETS) return unavailable();
  const file=manifest.files[url.pathname];
  let timer:ReturnType<typeof setTimeout>|undefined;let expired=false;
  const cancelBody=(body:ReadableStream<Uint8Array>|null)=>{try {if(body) void body.cancel().catch(()=>{});} catch { /* Cancellation is best effort. */ }};
  const deadline=new Promise<null>(resolve=>{timer=setTimeout(()=>{expired=true;resolve(null);},10000);});
  try {
   const fetch=env.ASSETS.fetch(new Request(url.origin+url.pathname)).then(response=>{if(expired) cancelBody(response.body);return response;});
   const response=await Promise.race([fetch,deadline]);
   if(!response) return unavailable();
   if(response.status!==200 || !Number.isSafeInteger(file.length) || file.length<0 || !response.body) {cancelBody(response.body);return unavailable();}
   const bytes=new Uint8Array(file.length);
   const reader=response.body.getReader();let complete=false;
   try {
    const read=async()=>{
     let offset=0;let chunks=0;
     while(true) {
      const {value,done}=await reader.read();
      if(done) return offset===bytes.length;
      if(++chunks>65536 || value.byteLength>bytes.length-offset) return false;
      bytes.set(value,offset);offset+=value.byteLength;
     }
    };
    const valid=await Promise.race([read(),deadline]);
    if(!valid) return unavailable();
    complete=true;
   } finally {
    if(!complete) {try {void reader.cancel().catch(()=>{});} catch { /* Cancellation is best effort. */ }}
    reader.releaseLock();
   }
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
   if(digest!==file.sha256) return unavailable();
   const html=url.pathname==='/candidate.html'||url.pathname==='/candidate-editor.html';
   return new Response(bytes,{headers:{'content-type':file.type,'cache-control':html?'no-store':'public, max-age=31536000, immutable','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${manifest.recipientOrigin} ${manifest.editorOrigin}; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`}});
  } catch { return unavailable(); } finally {if(timer) clearTimeout(timer);}
 }};
}
export default createCandidatePageHost(typeof __CANDIDATE_MANIFEST__ === 'undefined' ? {recipientOrigin:'',editorOrigin:'',files:{}} : __CANDIDATE_MANIFEST__);
