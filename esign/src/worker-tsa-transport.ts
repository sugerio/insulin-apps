/** Unmounted transport for independently authorized synthetic digests. No RFC3161 evidence is verified here. */
type Options = {
 endpoint:string;
 allowedEndpoints:readonly string[];
 timeoutMs:number;
 authorizeSynthetic:(endpoint:string,imprint:Uint8Array)=>Promise<boolean>;
 fetch:(request:Request)=>Promise<Response>;
};
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const getLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'length')!.get!;
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
const tlv=(tag:number,value:Uint8Array)=>{if(value.length>=128)throw new Error('Invalid timestamp request');return concat(new Uint8Array([tag,value.length]),value);};

export function syntheticTimestampQuery(imprint:Uint8Array,nonce:Uint8Array):Uint8Array<ArrayBuffer>{
 if(imprint.length!==32||nonce.length!==16||nonce[0]!==1)throw new Error('Invalid synthetic timestamp query');
 const algorithm=new Uint8Array([0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00]);
 return tlv(0x30,concat(new Uint8Array([0x02,0x01,0x01]),tlv(0x30,concat(algorithm,tlv(0x04,imprint))),tlv(0x02,nonce),new Uint8Array([0x01,0x01,0xff])));
}
/** The injected authorizer and fetch are trusted boundaries, not proof of synthetic provenance or endpoint safety. */
export async function requestAuthorizedSyntheticTimestamp(input:Uint8Array,options:Options):Promise<{status:'UNVERIFIED';response:Uint8Array;imprint:Uint8Array;nonce:Uint8Array;query:Uint8Array}>{ 
 if(!(input instanceof Uint8Array)||!(getBuffer.call(input) instanceof ArrayBuffer)||getLength.call(input)!==32)throw new Error('Invalid timestamp imprint');
 const imprint=new Uint8Array(32);imprint.set(input);
 let url:URL;try{url=new URL(options.endpoint);}catch{throw new Error('Invalid TSA configuration');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.href!==options.endpoint||!Array.isArray(options.allowedEndpoints)||!options.allowedEndpoints.includes(url.href)||typeof options.fetch!=='function'||typeof options.authorizeSynthetic!=='function'||!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>10000)throw new Error('Invalid TSA configuration');
 const endpoint=url.href,fetcher=options.fetch,authorize=options.authorizeSynthetic,timeout=options.timeoutMs;
 const nonce=crypto.getRandomValues(new Uint8Array(16));nonce[0]=1;
 const query=syntheticTimestampQuery(imprint,nonce);
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const work=async()=>{
   if(await authorize(endpoint,new Uint8Array(imprint))!==true||controller.signal.aborted)throw new Error('Synthetic timestamp not authorized');
   const request=new Request(endpoint,{method:'POST',headers:{'content-type':'application/timestamp-query','accept':'application/timestamp-reply'},body:query,redirect:'manual',signal:controller.signal});
   const response=await fetcher(request);
   if(response.status!==200||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/timestamp-reply'||!response.body)throw new Error('TSA response rejected');
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>65536){void reader.cancel();throw new Error('TSA response too large');}chunks.push(item.value);}
   if(size===0)throw new Error('TSA response rejected');
   return {status:'UNVERIFIED' as const,response:concat(...chunks),imprint,nonce,query};
  };
  return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('TSA timeout'));},timeout);})]);
 }finally{if(timer!==undefined)clearTimeout(timer);}
}
