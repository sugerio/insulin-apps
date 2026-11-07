const maxBytes=5*1024*1024;

type DownloadOptions={fetch?:typeof fetch;signal?:AbortSignal;timeoutMs?:number};

/** Download in the host browser only; never send a URL to the E-sign backend. */
export async function downloadEditorPdf(value:string,options:DownloadOptions={}):Promise<Blob>{
 const controller=new AbortController();
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const abort=()=>controller.abort();
 const timer=setTimeout(abort,options.timeoutMs??15000);
 options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted)abort();
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error();
  const aborted=new Promise<never>((_,reject)=>{if(controller.signal.aborted)reject(new Error());else controller.signal.addEventListener('abort',()=>reject(new Error()),{once:true});});
  const work=async()=>{
   const response=await (options.fetch??fetch)(url.href,{mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
   if(!response.ok||response.redirected||!response.body)throw new Error();
   const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw new Error();
   reader=response.body.getReader();const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
   while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>maxBytes)throw new Error();chunks.push(new Uint8Array(result.value));}
   const blob=new Blob(chunks,{type:'application/pdf'});
   if(size<5||await blob.slice(0,5).text()!=='%PDF-')throw new Error();
   return blob;
  };
  return await Promise.race([work(),aborted]);
 }catch{throw new Error('PDF download failed. Check the HTTPS URL, CORS, size and expiry.');}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}
