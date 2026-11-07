export function consumeEditorFragment(location:{hash:string;pathname:string;search:string},history:{replaceState:(data:unknown,unused:string,url:string)=>void}):string {
  const code=location.hash.slice(1);
  history.replaceState(null,'',location.pathname+location.search);
  if(!/^[a-f0-9]{64}$/.test(code))throw new Error('Invalid editor link');
  return code;
}
// The demo uses its fixed loopback Workers locally and its own HTTPS origin in the cloud.
export function editorDemoURL(hostOrigin:string,rawURL:string,sessionId:string):string {
  const localWorkers:Record<string,string>={'http://127.0.0.1:5173':'http://127.0.0.1:8787','http://127.0.0.1:5197':'http://127.0.0.1:8797'};
  const host=new URL(hostOrigin);
  const expected=localWorkers[hostOrigin] ?? (host.protocol==='https:' && host.origin===hostOrigin ? hostOrigin : '');
  const url=new URL(rawURL);
  if(!expected||url.origin!==expected||url.username||url.password||url.search||!/^\/editor\/page\/[a-f0-9]{64}$/.test(url.pathname)||!/^#[a-f0-9]{64}$/.test(url.hash)||sessionId!==url.pathname.split('/').pop())throw new Error('Invalid editor URL');
  return url.href;
}
export function editorSavedMessage(event:{origin:string;source:unknown;data:unknown},origin:string,source:unknown):boolean {
  const data=event.data;
  return !!source&&event.origin===origin&&event.source===source&&!!data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===1&&(data as {type?:unknown}).type==='esign.editor.saved';
}
