import {unstable_splitSqlQuery} from 'wrangler';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {Hono} from 'hono';
import workerApp, {managementAuth,createV3TestApp} from '../src/worker.ts';
import {allowedHostRequest} from './local-host.ts';
import {mountEditorRoutes} from '../src/editor-routes.ts';
import {createEditorDemoSources,createEditorDemoSession} from './editor-local-demo-source.ts';
import {withLocalTestOtp} from './local-otp-display.ts';

if(process.env.ESIGN_EDITOR_URL_DEMO!=='YES')throw new Error('Set ESIGN_EDITOR_URL_DEMO=YES for the isolated synthetic local demo');
const v3Demo=process.env.ESIGN_EDITOR_V3_DEMO==='YES';
const uiOrigin=v3Demo?'http://127.0.0.1:5197':'http://127.0.0.1:5173';
function localPort(value:string|undefined,fallback:number){const port=value===undefined?fallback:Number(value);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid local port');return port;}
const workerPort=localPort(process.env.ESIGN_EDITOR_DEMO_WORKER_PORT,v3Demo?8797:8787),hostPort=localPort(process.env.ESIGN_EDITOR_DEMO_HOST_PORT,v3Demo?8798:8788),workerOrigin=`http://127.0.0.1:${workerPort}`;
if(v3Demo&&(!process.env.ESIGN_EDITOR_DEMO_STATE||workerPort===hostPort||[5173,8787,8788,5197].includes(workerPort)||[5173,8787,8788,5197].includes(hostPort)))throw new Error('V3 demo requires separate explicit state and isolated ports');
const state=resolve(process.env.ESIGN_EDITOR_DEMO_STATE || '.wrangler/editor-url-demo');
await mkdir(state,{recursive:true,mode:0o700});
if(v3Demo){const marker=join(state,'local-v3-demo-marker'),entries=await readdir(state);if(!entries.includes('local-v3-demo-marker')){if(entries.length)throw new Error('V3 demo requires empty or previously marked state');await writeFile(marker,'local-v3-demo-only\n',{mode:0o600,flag:'wx'});}else if(await readFile(marker,'utf8')!=='local-v3-demo-only\n')throw new Error('Invalid V3 demo state');}
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],d1Persist:join(state,'d1'),r2Persist:join(state,'r2')});
const db=await mf.getD1Database('DB');
await db.prepare('CREATE TABLE IF NOT EXISTS local_demo_migrations (name TEXT PRIMARY KEY NOT NULL)').run();
for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
 if(await db.prepare('SELECT name FROM local_demo_migrations WHERE name=?').bind(name).first())continue;
 const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch([...unstable_splitSqlQuery(sql).map(s=>db.prepare(s)),db.prepare('INSERT INTO local_demo_migrations(name) VALUES (?)').bind(name)]);
}
const secretPath=join(state,'local-keys.json');
try {await writeFile(secretPath,JSON.stringify({key:randomBytes(32).toString('hex'),otp:randomBytes(32).toString('hex'),seal:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});} catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
const secrets=JSON.parse(await readFile(secretPath,'utf8')) as {key:string;otp:string;seal:string};
if(![secrets.key,secrets.otp,secrets.seal].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw new Error('Invalid local demo keys');
const key=secrets.key,hash=createHash('sha256').update(key).digest('hex');
await db.prepare("INSERT OR IGNORE INTO tenants(id) VALUES ('editor-demo')").run();await db.prepare("INSERT OR IGNORE INTO api_keys(key_hash,tenant_id) VALUES (?,'editor-demo')").bind(hash).run();await db.prepare("INSERT OR IGNORE INTO editor_allowed_origins VALUES ('editor-demo',?)").bind(uiOrigin).run();await db.prepare("INSERT OR IGNORE INTO tenant_page_origins VALUES ('editor-demo',?)").bind(uiOrigin).run();
const assetsDir=resolve('dist-ui');
const assets={fetch:async(request:Request)=>{try{const path=new URL(request.url).pathname;if(!/^\/(editor\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(path))return new Response(null,{status:404});const data=await readFile(join(assetsDir,path));const type=path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(path)?'text/javascript':'application/octet-stream';return new Response(data,{headers:{'content-type':type}});}catch{return new Response(null,{status:404});}}};
const env={DB:db,ARTIFACTS:await mf.getR2Bucket('ARTIFACTS'),TEST_MAIL:await mf.getR2Bucket('TEST_MAIL'),LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:secrets.otp,LOCAL_TEST_SEAL_KEY:secrets.seal,ASSETS:assets};
const sources=createEditorDemoSources(true);const app=new Hono<any>();mountEditorRoutes(app,managementAuth,{downloadSource:sources.download});app.get('/assets/*',c=>assets.fetch(c.req.raw));app.route('/',v3Demo?createV3TestApp():workerApp);
async function body(req:IncomingMessage){const chunks:Buffer[]=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>5*1024*1024+65536)throw new Error('Too large');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
function headers(req:IncomingMessage){const result=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&key!=='host'&&key!=='connection')result.set(key,Array.isArray(value)?value.join(','):value);return result;}
async function send(res:ServerResponse,response:Response){res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
const worker=createServer(async(req,res)=>{try{if(req.headers.host!==`127.0.0.1:${workerPort}`)return void res.writeHead(403).end();const payload=await body(req),h=headers(req);let response=await app.fetch(new Request(workerOrigin+(req.url??'/'),{method:req.method,headers:h,...(req.method==='POST'?{body:payload}:{})}),env);if(req.method==='POST'&&req.url==='/v1/signing/otp')response=await withLocalTestOtp(response,env.TEST_MAIL);await send(res,response);}catch{res.writeHead(503).end();}});
const host=createServer(async(req,res)=>{try{
 if(req.headers.host!==`127.0.0.1:${hostPort}`||req.headers['x-local-esign']!=='1'||(req.headers.origin&&req.headers.origin!==uiOrigin)||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))return void res.writeHead(403).end();
 const path=req.url??'',method=req.method??'';if(method==='POST'&&req.headers.origin!==uiOrigin)return void res.writeHead(403).end();
 const payload=await body(req);let response:Response;
 if(method==='POST'&&path==='/host/editor-demo-session'){
  const form=await new Request(uiOrigin+path,{method,headers:headers(req),body:payload}).formData();const file=form.get('file');if(!(file instanceof File))return void res.writeHead(400).end();const roles=JSON.parse(String(form.get('roles')));
  response=await createEditorDemoSession(sources,new Uint8Array(await file.arrayBuffer()),roles,async sessionBody=>app.fetch(new Request(workerOrigin+'/v1/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:sessionBody}),env),uiOrigin);
 }else if((method==='POST'&&path==='/host/template-editing-sessions')||(method==='GET'&&/^\/host\/template-editing-sessions\/[a-f0-9]{64}$/.test(path))){
  let data=payload;if(method==='POST'){const input=JSON.parse(payload.toString()) as {roles?:unknown;sourceTemplateId?:unknown;sourceUrl?:unknown};data=Buffer.from(JSON.stringify({allowedParentOrigin:uiOrigin,roles:input.roles,...(input.sourceTemplateId===undefined?{}:{sourceTemplateId:input.sourceTemplateId}),...(input.sourceUrl===undefined?{}:{sourceUrl:input.sourceUrl})}));}
  response=await app.fetch(new Request(workerOrigin+'/v1'+path.slice('/host'.length),{method,headers:{authorization:`Bearer ${key}`,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:data}:{})}),env);
 }else if(allowedHostRequest(req.headers,method,path,hostPort,uiOrigin) && !path.startsWith('/host/synthetic/') && !path.startsWith('/host/upload/')){
  const forwardHeaders=new Headers(headers(req));forwardHeaders.set('authorization',`Bearer ${key}`);
  response=await app.fetch(new Request(workerOrigin+'/v1'+path.slice('/host'.length),{method,headers:forwardHeaders,...(method==='POST'?{body:payload}:{})}),env);
 }else return void res.writeHead(404).end();
 res.setHeader('cache-control','no-store');await send(res,response);
 }catch{res.writeHead(503).end();}});
worker.listen(workerPort,'127.0.0.1');host.listen(hostPort,'127.0.0.1');
console.log(v3Demo?'LOCAL SYNTHETIC V3 URL DEMO ONLY. D1/R2 persist locally. Never deploy.':'LOCAL SYNTHETIC URL DEMO ONLY. Open /editor-host.html. D1/R2 persist locally. Never deploy.');
async function stop(){worker.close();host.close();await mf.dispose();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
