/** Unmounted transport for a fixed synthetic fixture only; this does not verify RFC3161. */
type Options = { endpoint:string; allowedEndpoints:readonly string[]; fetch:(request:Request)=>Promise<Response>; timeoutMs:number };
const fixture = new TextEncoder().encode('esign fixed synthetic timestamp transport fixture v1');
const concat = (...parts:Uint8Array[]) => { const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out; };
const tlv = (tag:number,value:Uint8Array) => {if(value.length>=128)throw new Error('Synthetic query too large');return concat(new Uint8Array([tag,value.length]),value);};

export async function requestSyntheticTimestamp(options:Options):Promise<{status:'UNVERIFIED_SYNTHETIC_RESPONSE';response:Uint8Array;imprint:Uint8Array;nonce:Uint8Array}> {
  let url:URL;
  try {url=new URL(options.endpoint);} catch {throw new Error('Invalid TSA configuration');}
  if(url.protocol!=='https:' || url.username || url.password || url.hash || url.search || url.href!==options.endpoint || !options.allowedEndpoints.includes(url.href) || typeof options.fetch!=='function' || !Number.isInteger(options.timeoutMs) || options.timeoutMs<1 || options.timeoutMs>10000) throw new Error('Invalid TSA configuration');
  const imprint=new Uint8Array(await crypto.subtle.digest('SHA-256',fixture));
  const nonce=crypto.getRandomValues(new Uint8Array(16));nonce[0]=1;
  const sha256Algorithm=new Uint8Array([0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00]);
  const query=tlv(0x30,concat(new Uint8Array([0x02,0x01,0x01]),tlv(0x30,concat(sha256Algorithm,tlv(0x04,imprint))),tlv(0x02,nonce),new Uint8Array([0x01,0x01,0xff])));
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const work=async()=>{
      const request=new Request(url.href,{method:'POST',headers:{'content-type':'application/timestamp-query','accept':'application/timestamp-reply'},body:query,redirect:'manual',signal:controller.signal});
      const response=await options.fetch(request);
      if(response.status!==200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/timestamp-reply' || !response.body)throw new Error('TSA response rejected');
      const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0;
      while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>65536){void reader.cancel();throw new Error('TSA response too large');}chunks.push(item.value);}
      if(size===0)throw new Error('TSA response rejected');
      return {status:'UNVERIFIED_SYNTHETIC_RESPONSE' as const,response:concat(...chunks),imprint,nonce};
    };
    return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('TSA timeout'));},options.timeoutMs);})]);
  } finally {if(timer!==undefined)clearTimeout(timer);}
}
