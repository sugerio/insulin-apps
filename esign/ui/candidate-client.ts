type LocationParts = {origin:string;pathname:string;search:string;hash:string};
type HistoryReplacement = {replaceState(data:unknown, unused:string, url?:string|URL|null):void};
export function takeCandidateCode(location:LocationParts, history:HistoryReplacement):string|null {
 const hash=location.hash; history.replaceState(null,'',location.pathname);
 const params=new URLSearchParams(hash.slice(1));
 if(location.search || [...params.keys()].length!==1 || params.getAll('code').length!==1) return null;
 const code=params.get('code'); return code && /^[a-f0-9]{64}$/.test(code) ? code : null;
}
function httpsOrigin(value:string):boolean {try {const url=new URL(value);return url.protocol==='https:' && url.origin===value;} catch{return false;}}
export class CandidateRequestError extends Error {
 readonly status:number;
 constructor(status:number) {super('Candidate request unavailable');this.status=status;}
}
export class CandidateBrowserClient {
 private token=''; private gateway:string; private send:typeof fetch;
 constructor(gateway:string, pageOrigin:string, send:typeof fetch=fetch) {if(!httpsOrigin(gateway)||!httpsOrigin(pageOrigin))throw new Error('Invalid candidate origin');this.gateway=gateway;this.send=(...args)=>send(...args);}
 private async post(path:string, body:object):Promise<Response> {
  const response=await this.send(this.gateway+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
  if(!response.ok) throw new CandidateRequestError(response.status); return response;
 }
 async exchange(code:string):Promise<void> {if(!/^[a-f0-9]{64}$/.test(code))throw new Error('Invalid code');const result=await (await this.post('/v1/page-sessions/exchange',{code})).json() as {token?:unknown};if(typeof result.token!=='string'||!/^[a-f0-9]{64}$/.test(result.token))throw new Error('Invalid session');this.token=result.token;}
 request(path:string,body:Record<string,unknown>):Promise<Response> {if(!this.token || !['/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign'].includes(path))throw new Error('Unavailable');return this.post(path,{...body,token:this.token});}
}
