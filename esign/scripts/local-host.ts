import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const alternatePorts=process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS==='YES';
const origin = alternatePorts ? 'http://127.0.0.1:5174' : 'http://127.0.0.1:5173';
const port=alternatePorts ? 8789 : 8788;
const id = '[a-zA-Z0-9-]+';
const routes: [string, RegExp][] = [
  ['POST', /^\/host\/template-editing-sessions$/], ['POST', /^\/host\/template-editing-sessions\/[a-f0-9]{64}\/source$/], ['GET', /^\/host\/template-editing-sessions\/[a-f0-9]{64}$/],
  ['POST', /^\/host\/templates$/], ['GET', /^\/host\/templates(?:\?cursor=[A-Za-z0-9_-]{0,128})?$/], ['GET', new RegExp(`^/host/templates/${id}$`)], ['POST', /^\/host\/envelopes$/],
  ['GET', new RegExp(`^/host/envelopes/${id}$`)],
  ['GET', new RegExp(`^/host/envelopes/${id}/(final-pdf|certificate|delivery-pdf|delivery-metadata)$`)],
  ['POST', new RegExp(`^/host/envelopes/${id}/(prepare|process|finalize)$`)],
  ['POST', new RegExp(`^/host/envelopes/${id}/tasks/${id}/recipient-view$`)],
  ['POST', /^\/host\/synthetic\/create$/],
  ['POST', /^\/host\/upload\/(create|resume)$/],
  ['GET', new RegExp(`^/host/upload/envelopes/${id}(/(final-pdf|delivery-pdf|existing-delivery-pdf|certificate))?$`)],
  ['POST', new RegExp(`^/host/upload/envelopes/${id}/(process|finalize|seal|complete)$`)],
  ['POST', new RegExp(`^/host/upload/envelopes/${id}/tasks/${id}/recipient-view$`)],
  ['POST', new RegExp(`^/host/upload/envelopes/${id}/v1/(page-sessions/exchange|signing/(otp|otp/verify|sign))$`)],
  ['GET', new RegExp(`^/host/upload/envelopes/${id}/v1/signing/(current|pdf)$`)],
  ['GET', new RegExp(`^/host/synthetic/envelopes/${id}(/(final-pdf|delivery-pdf|certificate))?$`)],
  ['POST', new RegExp(`^/host/synthetic/envelopes/${id}/(process|finalize|seal)$`)],
  ['POST', new RegExp(`^/host/synthetic/envelopes/${id}/tasks/${id}/recipient-view$`)],
  ['POST', /^\/host\/synthetic\/v1\/(page-sessions\/exchange|signing\/(otp|otp\/verify|sign))$/],
  ['GET', /^\/host\/synthetic\/v1\/signing\/(current|pdf)$/],
];
export function allowedHostRequest(headers: Record<string, string | string[] | undefined>, method: string, path: string, expectedPort=port,expectedOrigin=origin) {
  return headers.host === `127.0.0.1:${expectedPort}` && headers['x-local-esign'] === '1' &&
    (!headers.origin || headers.origin === expectedOrigin) &&
    (!headers['sec-fetch-site'] || headers['sec-fetch-site'] === 'same-origin') &&
    routes.some(([m, pattern]) => m === method && pattern.test(path));
}
export function editorHostSessionBody(body:string,parentOrigin:string):string {
  const input:unknown=JSON.parse(body);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid session');
  const {roles,sourceTemplateId,sourceUrl}=input as {roles?:unknown;sourceTemplateId?:unknown;sourceUrl?:unknown};
  return JSON.stringify({allowedParentOrigin:parentOrigin,roles,...(sourceTemplateId===undefined?{}:{sourceTemplateId}),...(sourceUrl===undefined?{}:{sourceUrl})});
}
export function startLocalHost(key: string,options:{syntheticDependencies?:()=>Promise<import('./synthetic-seal-orchestration.ts').Dependencies>;port?:number;onUploadStatusProbe?:()=>Promise<void>;onUploadPreflight?:()=>Promise<void>;onUploadCompletionSafeMarker?:{afterSafeLink?:()=>void;beforeSafeWinnerValidation?:()=>void}}={}) {
  if (process.env.ESIGN_LOCAL_HOST !== 'true' || !/^[A-Za-z0-9_-]{32,256}$/.test(key)) throw new Error('Explicit ESIGN_LOCAL_HOST=true and local key required');
  const syntheticEnabled=process.env.ESIGN_SYNTHETIC_SEAL==='YES';
  const uploads=new Map<string,Awaited<ReturnType<typeof import('./synthetic-seal-isolated.ts').createIsolatedUploadedEnvelope>>>();
  const uploadEnabled=process.env.ESIGN_UPLOAD_SEAL==='YES';
  let resuming=false;
  const uploadBusy=new Set<string>();
  const uploadFaults=new Set<string>();
  const resumedUploads=new Set<string>();
  let isolated:Promise<Awaited<ReturnType<typeof import('./synthetic-seal-isolated.ts').createIsolatedSyntheticEnvelope>>>|undefined;
  const getIsolated=()=>isolated ??= import('./synthetic-seal-isolated.ts').then(async m=>{
    const instance=await m.createIsolatedSyntheticEnvelope(process.env.ESIGN_SYNTHETIC_INSTANCE || undefined);
    console.log(`Synthetic instance (retain for restart): ${instance.directory}`);
    return instance;
  });
  const server=createServer(async (req, res) => {
    const path = req.url ?? '';
    res.setHeader('Cache-Control', 'no-store');
    if (!allowedHostRequest(req.headers, req.method ?? '', path, (server.address() as import('node:net').AddressInfo).port)) { res.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 5 * 1024 * 1024 + 65536) throw new Error('too large'); chunks.push(chunk); }
      if(path.startsWith('/host/upload/')) {
        if(!uploadEnabled) {res.writeHead(404).end();return;}
        if((req.method==='POST' && req.headers.origin!==origin) ||
           (req.method==='GET' && req.headers.origin!==undefined && req.headers.origin!==origin)) {res.writeHead(403).end();return;}
        if(path==='/host/upload/create' || path==='/host/upload/resume') {
          const resume=path.endsWith('/resume');
          if(resume ? (size!==0 || !process.env.ESIGN_UPLOAD_INSTANCE) : (req.headers['content-type']!=='application/pdf' || size>1024*1024 || size<8)) {res.writeHead(400).end();return;}
          if(resume && (resuming || [...uploads.values()].some(value=>value.directory===process.env.ESIGN_UPLOAD_INSTANCE))) {res.writeHead(409).end();return;}
          let instance;
          if(resume)resuming=true;
          try {const module=await import('./synthetic-seal-isolated.ts');instance=await module.createIsolatedUploadedEnvelope(resume ? undefined : Buffer.concat(chunks),resume ? process.env.ESIGN_UPLOAD_INSTANCE : undefined);}
          catch {res.writeHead(400).end('Invalid PDF or instance');return;}
          finally {if(resume)resuming=false;}
          if(!resume) {const {initializeUploadCompletion}=await import('./upload-completion-state.ts');await initializeUploadCompletion(instance.directory);}
          if(uploads.has(instance.envelopeId)) {await instance.dispose();res.writeHead(409).end();return;}
          if(resume)resumedUploads.add(instance.envelopeId);
          uploads.set(instance.envelopeId,instance);
          console.log(`Uploaded instance (retain for restart): ${instance.directory}`);
          res.setHeader('content-type','application/json');res.end(JSON.stringify({id:instance.envelopeId,mode:'UPLOADED PDF LOCAL TEST',...(resume?{sealStatus:'INVESTIGATE',readOnly:true}:{})}));return;
        }
        const match=path.match(/^\/host\/upload\/envelopes\/([a-zA-Z0-9-]+)(.*)$/);
        const instance=match && uploads.get(match[1]);
        if(!instance || !match) {res.writeHead(404).end();return;}
        const suffix=match[2],base=`/v1/envelopes/${instance.envelopeId}`;
        if(req.method==='GET' && suffix==='/existing-delivery-pdf') {
          if(uploadBusy.has(instance.envelopeId)) {res.writeHead(409).end();return;}
          uploadBusy.add(instance.envelopeId);
          try {
            const bytes=await instance.existingDelivery();
            res.writeHead(200,{'content-type':'application/pdf','content-disposition':'inline; filename="delivery-local-test.pdf"','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'same-origin'}).end(bytes);
          } catch {res.writeHead(503).end();} finally {uploadBusy.delete(instance.envelopeId);}
          return;
        }
        // A prior process may have observed an unrecordable storage error after publishing a safe marker.
        if(resumedUploads.has(instance.envelopeId)) {
          if(req.method==='GET' && suffix==='') {const current=await instance.request(base);if(!current.ok){res.writeHead(current.status).end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({...await current.json(),sealStatus:'INVESTIGATE'}));return;}
          if(req.method==='GET' && (suffix==='/final-pdf' || suffix==='/certificate')) {
            const result=await instance.request(base+suffix);res.statusCode=result.status;
            for(const name of ['content-type','content-disposition','x-content-type-options']) {const value=result.headers.get(name);if(value)res.setHeader(name,value);}
            res.end(Buffer.from(await result.arrayBuffer()));return;
          }
          res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'INVESTIGATE',retryable:false}));return;
        }
        if(uploadFaults.has(instance.envelopeId)) {
          if(req.method==='GET' && suffix==='') {const current=await instance.request(base);if(!current.ok){res.writeHead(current.status).end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({...await current.json(),sealStatus:'INVESTIGATE'}));return;}
          res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'INVESTIGATE',retryable:false}));return;
        }
        if(uploadBusy.has(instance.envelopeId)) {
          if(req.method==='GET' && suffix==='') {
            const current=await instance.request(base);
            if(!current.ok) {res.writeHead(current.status).end();return;}
            res.setHeader('content-type','application/json');res.end(JSON.stringify({...await current.json(),sealStatus:'IN_PROGRESS'}));return;
          }
          res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'IN_PROGRESS',retryable:false}));return;
        }
        uploadBusy.add(instance.envelopeId);
        try {
        if((req.method==='POST' && suffix!=='/complete' && suffix!=='/seal') || (req.method==='GET' && suffix==='/delivery-pdf')) {
          try {
            const {uploadCompletionState,lockUploadInvestigation,runUploadInspection}=await import('./upload-completion-state.ts');
            const allowed=await runUploadInspection(instance.directory,async id=>{
              const state=await uploadCompletionState(instance.directory,id,true);
              if(state==='FRESH')return true;
              if(state!=='ATTEMPTED' || req.method!=='GET')return false;
              const {uploadedSealStatus}=await import('./synthetic-seal-orchestration.ts');
              const dependencies=options.syntheticDependencies ?? (await import('./synthetic-seal-remote.ts')).realSyntheticDependencies;
              const result=await uploadedSealStatus(instance.directory,instance.evidence,(await dependencies()).roots);
              if(result.sealStatus!=='SEALED_LOCAL_TEST')throw new Error('Incomplete attempt');
              return true;
            });
            if(!allowed) {res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'INVESTIGATE',retryable:false}));return;}
          } catch {uploadFaults.add(instance.envelopeId);res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'INVESTIGATE',retryable:false}));return;}
        }
        if(suffix==='/complete') {
          let authorized=false;
          try {const value=JSON.parse(Buffer.concat(chunks).toString());authorized=req.headers['content-type']==='application/json' && value && Object.keys(value).length===1 && value.authorizeDisclosure===true;} catch {}
          if(!authorized) {res.writeHead(403).end();return;}
          const {uploadCompletionState,runUploadPreflight,runUploadInspection,lockUploadInvestigation}=await import('./upload-completion-state.ts');
          const investigate=async()=>{try {await lockUploadInvestigation(instance.directory);} catch {uploadFaults.add(instance.envelopeId);console.error('Upload investigation marker unavailable; instance blocked.');} res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'INVESTIGATE',retryable:false}));};
          try {
            const preflight=await runUploadInspection(instance.directory,async id=>{
              const state=await uploadCompletionState(instance.directory,id,true);
              if(state==='INVESTIGATE')return {kind:'INVESTIGATE' as const};
              if(state==='ATTEMPTED') {
                const {uploadedSealStatus}=await import('./synthetic-seal-orchestration.ts');
                const dependencies=options.syntheticDependencies ?? (await import('./synthetic-seal-remote.ts')).realSyntheticDependencies;
                const seal=await uploadedSealStatus(instance.directory,instance.evidence,(await dependencies()).roots);
                if(seal.sealStatus!=='SEALED_LOCAL_TEST')throw new Error('Incomplete attempt');
                return {kind:'SEALED' as const,seal};
              }
              const phase=await runUploadPreflight(instance.directory,async()=>{await options.onUploadPreflight?.();return instance.completionPhase();});
              return {kind:phase};
            },options.onUploadCompletionSafeMarker);
            if(preflight.kind==='INVESTIGATE') {await investigate();return;}
            if(preflight.kind==='SEALED') {res.setHeader('content-type','application/json');res.end(JSON.stringify({mode:'UPLOADED PDF TEST ONLY',envelopeId:instance.envelopeId,...preflight.seal}));return;}
            if(preflight.kind==='UNSIGNED') {res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({sealStatus:'NOT_READY',retryable:true}));return;}
            const finalized=await instance.request(`${base}/finalize`,{method:'POST'});
            if(finalized.status!==204)throw new Error('Finalization failed');
            const fixture=await instance.evidence();
            const {bindUploadedWorkspace,sealUploadedWorkspace,markUploadedComplete}=await import('./synthetic-seal-orchestration.ts');
            const workspace=await bindUploadedWorkspace(instance.directory,fixture);
            console.log(`Uploaded evidence workspace (retain for verification): ${workspace}`);
            const dependencies=options.syntheticDependencies ?? (await import('./synthetic-seal-remote.ts')).realSyntheticDependencies;
            const result=await sealUploadedWorkspace(workspace,fixture,await dependencies());
            await markUploadedComplete(workspace);
            res.setHeader('content-type','application/json');res.end(JSON.stringify({mode:'UPLOADED PDF TEST ONLY',...result,envelopeId:instance.envelopeId,sealStatus:'SEALED_LOCAL_TEST',workspace}));return;
          } catch {await investigate();return;}
        }
        if(suffix==='') {
          const response=await instance.request(base);
          if(!response.ok) {res.writeHead(response.status).end();return;}
          let seal:{sealStatus:string;workspace?:string};
          try {
            {
              await options.onUploadStatusProbe?.();
              const {uploadCompletionState,lockUploadInvestigation,runUploadInspection}=await import('./upload-completion-state.ts');
              seal=await runUploadInspection(instance.directory,async id=>{
                const state=await uploadCompletionState(instance.directory,id,true);
                if(state==='FRESH')return {sealStatus:'NOT_SEALED'};
                if(state==='INVESTIGATE')return {sealStatus:'INVESTIGATE'};
                const {uploadedSealStatus}=await import('./synthetic-seal-orchestration.ts');
                const dependencies=options.syntheticDependencies ?? (await import('./synthetic-seal-remote.ts')).realSyntheticDependencies;
                const result=await uploadedSealStatus(instance.directory,instance.evidence,(await dependencies()).roots);
                if(result.sealStatus!=='SEALED_LOCAL_TEST')throw new Error('Incomplete attempt');
                return result;
              });
            }
          } catch {try {const {lockUploadInvestigation}=await import('./upload-completion-state.ts');await lockUploadInvestigation(instance.directory);} catch {uploadFaults.add(instance.envelopeId);console.error('Upload investigation marker unavailable; instance blocked.');} seal={sealStatus:'INVESTIGATE'};}
          res.setHeader('content-type','application/json');res.end(JSON.stringify({...await response.json(),...seal}));return;
        }
        if(suffix==='/seal') {res.writeHead(403).end();return;}
        const target=suffix.startsWith('/v1/') ? suffix : base+suffix;
        const forwarded:Record<string,string>={};
        if(req.headers['content-type'])forwarded['content-type']=req.headers['content-type'];
        if(req.headers.authorization)forwarded.authorization=req.headers.authorization;
        const response=await instance.request(target,{method:req.method,headers:forwarded,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
        res.statusCode=response.status;
        for(const name of ['content-type','content-disposition','x-content-type-options']) {const value=response.headers.get(name);if(value)res.setHeader(name,value);}
        res.end(Buffer.from(await response.arrayBuffer()));return;
        } finally {uploadBusy.delete(instance.envelopeId);}
      }
      if(path.startsWith('/host/synthetic/')) {
        if(!syntheticEnabled) {res.writeHead(404).end();return;}
        if(path==='/host/synthetic/create') {
          if(size) {res.writeHead(400).end();return;}
          const instance=await getIsolated();
          res.setHeader('content-type','application/json');res.end(JSON.stringify({id:instance.envelopeId,mode:'SERVER-GENERATED SYNTHETIC ONLY'}));return;
        }
        if(!isolated) {res.writeHead(404).end();return;}
        const instance=await getIsolated();
        if(path===`/host/synthetic/envelopes/${instance.envelopeId}/seal`) {
          if(size) {res.writeHead(400).end();return;}
          const fixture=await instance.evidence();
          const {bindDynamicSyntheticWorkspace,sealDynamicSyntheticWorkspace}=await import('./synthetic-seal-orchestration.ts');
          const workspace=await bindDynamicSyntheticWorkspace(instance.directory,fixture);
          console.log(`Synthetic evidence workspace (retain for verification): ${workspace}`);
          const dependencies=options.syntheticDependencies ?? (await import('./synthetic-seal-remote.ts')).realSyntheticDependencies;
          const result=await sealDynamicSyntheticWorkspace(workspace,fixture,await dependencies());
          res.setHeader('content-type','application/json');res.end(JSON.stringify({mode:'SYNTHETIC TEST ONLY',workspace,...result}));return;
        }
        const target=path.startsWith('/host/synthetic/v1/') ? path.slice('/host/synthetic'.length) : '/v1'+path.slice('/host/synthetic'.length);
        const forwarded:Record<string,string>={};
        if(req.headers['content-type'])forwarded['content-type']=req.headers['content-type'];
        if(req.headers.authorization)forwarded.authorization=req.headers.authorization;
        const response=await instance.request(target,{method:req.method,headers:forwarded,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
        res.statusCode=response.status;
        for(const name of ['content-type','content-disposition','x-content-type-options']) {const value=response.headers.get(name);if(value)res.setHeader(name,value);}
        res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if ((path === '/host/template-editing-sessions' || /^\/host\/template-editing-sessions\/[a-f0-9]{64}\/source$/.test(path)) && req.method === 'POST' && req.headers.origin !== origin) {res.writeHead(403).end();return;}
      const headers: Record<string, string> = {authorization: `Bearer ${key}`};
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      if (req.headers['idempotency-key']) headers['idempotency-key'] = String(req.headers['idempotency-key']);
      let body=Buffer.concat(chunks);
      if(path==='/host/template-editing-sessions' && req.method==='POST'){try{body=Buffer.from(editorHostSessionBody(body.toString('utf8'),origin));}catch{res.writeHead(400).end();return;}}
      const response = await fetch(`http://127.0.0.1:8787/v1${path.slice(5)}`, {method:req.method, headers, ...(req.method === 'POST' ? {body} : {})});
      res.statusCode = response.status;
      for (const name of ['content-type','content-disposition','x-content-type-options']) { const value = response.headers.get(name); if (value) res.setHeader(name,value); }
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502).end('Local backend unavailable'); }
  });
  server.on('close',()=>{void isolated?.then(instance=>instance.dispose()).catch(()=>{});for(const instance of uploads.values())void instance.dispose();});
  return server.listen(options.port ?? port, '127.0.0.1');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startLocalHost(process.env.ESIGN_LOCAL_KEY ?? '');
