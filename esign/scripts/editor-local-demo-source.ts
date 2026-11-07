import {randomBytes} from 'node:crypto';

const maxBytes=5*1024*1024;
const prefix='https://editor-source.invalid/';

/** A private in-memory test registry, not a network downloader or production adapter. */
export function createEditorDemoSources(enabled:boolean,now:()=>number=Date.now){
 if(!enabled)throw new Error('Explicit local demo mode required');
 const entries=new Map<string,{bytes:Uint8Array;expires:number;timer:ReturnType<typeof setTimeout>}>();
 const remove=(token:string)=>{const entry=entries.get(token);if(entry){clearTimeout(entry.timer);entries.delete(token);}};
 const sweep=()=>{for(const [key,value] of entries)if(value.expires<=now())remove(key);};
 return {
  issue(bytes:Uint8Array){sweep();if(bytes.length<5||bytes.length>maxBytes||entries.size>=16)throw new Error('Invalid local demo source');const token=randomBytes(32).toString('hex');const timer=setTimeout(()=>remove(token),30000);timer.unref();entries.set(token,{bytes:new Uint8Array(bytes),expires:now()+30000,timer});return prefix+token;},
  discard(url:string){if(url.startsWith(prefix))remove(url.slice(prefix.length));},
  async download(url:string,signal:AbortSignal){sweep();if(signal.aborted||!/^https:\/\/editor-source\.invalid\/[a-f0-9]{64}$/.test(url))throw new Error('Local demo source unavailable');const token=url.slice(prefix.length),entry=entries.get(token);remove(token);if(!entry||entry.expires<=now())throw new Error('Local demo source unavailable');return new Uint8Array(entry.bytes);},
 };
}

export async function createEditorDemoSession(sources:ReturnType<typeof createEditorDemoSources>,bytes:Uint8Array,roles:unknown,create:(body:string)=>Promise<Response>,parentOrigin='http://127.0.0.1:5173'):Promise<Response>{
 const url=sources.issue(bytes);
 try{return await create(JSON.stringify({allowedParentOrigin:parentOrigin,roles,sourceUrl:url}));}finally{sources.discard(url);}
}
