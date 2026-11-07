// Offline proposal only. No account access, deployment, or verification of assertions.
import {readFileSync} from 'node:fs';

try {
 if(process.argv.length!==3) throw Error();
 const v=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const keys=['subdomain','candidate','management','editor','recipient','page','namesAvailable','namespaceIds','budgetNamespaceIds'];
 if(!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k))) throw Error();
 const label=(s:unknown)=>typeof s==='string' && /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(s);
 if(![v.subdomain,v.candidate,v.management,v.editor,v.recipient,v.page].every(label) || new Set([v.candidate,v.management,v.editor,v.recipient,v.page]).size!==5 || v.namesAvailable!==true) throw Error();
 if(!Array.isArray(v.namespaceIds) || v.namespaceIds.length!==3 || v.namespaceIds.some((x:unknown)=>typeof x!=='string'||!/^[1-9][0-9]{0,14}$/.test(x)) || new Set(v.namespaceIds).size!==3) throw Error();
 if(!Array.isArray(v.budgetNamespaceIds) || v.budgetNamespaceIds.length!==3 || v.budgetNamespaceIds.some((x:unknown)=>typeof x!=='string'||!/^[1-9][0-9]{0,14}$/.test(x)) || new Set([...v.namespaceIds,...v.budgetNamespaceIds]).size!==6) throw Error();
 const origin=(name:string)=>`https://${name}.${v.subdomain}.workers.dev`;
 const base=(name:string,main:string,workers_dev:boolean,flags:string[]=[])=>({name,main,compatibility_date:'2026-01-01',...(flags.length?{compatibility_flags:flags}:{}),workers_dev,preview_urls:false});
 const gateway=(name:string,kind:string,entrypoint:string,ns:string,budgetNs:string,limit:number,publicIngress:boolean,vars?:object)=>({
  ...base(name,`./src/${kind}-gateway.ts`,publicIngress,kind==='recipient'?[]:['streams_enable_constructors']),
  services:[{binding:`PRIVATE_${kind.toUpperCase()}`,service:v.candidate,entrypoint}],
  ratelimits:[{name:'RATE_LIMITER',namespace_id:ns,simple:{limit,period:60}},{name:'LOCATION_RATE_LIMITER',namespace_id:budgetNs,simple:{limit,period:60}}],...(vars?{vars}:{})
 });
 const result={
  management:gateway(v.management,'management','PrivateManagement',v.namespaceIds[0],v.budgetNamespaceIds[0],20,false),
  editor:gateway(v.editor,'editor','PrivateEditor',v.namespaceIds[1],v.budgetNamespaceIds[1],40,true,{TRUSTED_EDITOR_ORIGINS:origin(v.page)}),
  recipient:gateway(v.recipient,'recipient','PrivateRecipient',v.namespaceIds[2],v.budgetNamespaceIds[2],60,true,{TRUSTED_RECIPIENT_ORIGINS:origin(v.page)}),
  page:{...base(v.page,'./dist-candidate-assets/worker.mjs',true),assets:{directory:'./dist-candidate-assets/client',binding:'ASSETS',run_worker_first:true},vars:{EDITOR_GATEWAY_ORIGIN:origin(v.editor),RECIPIENT_GATEWAY_ORIGIN:origin(v.recipient)}}
 };
 console.log(JSON.stringify(result,null,2));
} catch {console.error('Invalid offline topology input; no deployment approval.');process.exitCode=1;}
