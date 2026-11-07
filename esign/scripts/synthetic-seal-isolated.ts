import {unstable_splitSqlQuery} from 'wrangler';
/** Isolated synthetic-only Worker instance. No browser-provided template or recipient data. */
import { readdir,readFile,mkdtemp,realpath,lstat,open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,dirname,join } from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import app from '../src/worker.ts';
import { finalizeLocalTestEvidence } from '../src/local-test-evidence.ts';
import { withLocalTestOtp } from './local-otp-display.ts';

const origin=process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS==='YES' ? 'http://127.0.0.1:5174' : 'http://127.0.0.1:5173';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type State={secret:string;sealKey:string;otpKey:string;envelopeId:string;source:string};
export async function createIsolatedSyntheticEnvelope(resume?:string) {
 return createIsolatedEnvelope('synthetic',undefined,resume);
}

export async function createIsolatedUploadedEnvelope(bytes:Uint8Array|undefined,resume?:string) {
 if(!resume) {
  if(!bytes || bytes.length<8 || bytes.length>1024*1024 || Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-')throw new Error('Invalid uploaded PDF size or header');
  const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false});
  if(pdf.getPageCount()<1 || pdf.getPageCount()>100)throw new Error('Invalid uploaded PDF page count');
 } else if(bytes) throw new Error('Cannot replace uploaded PDF');
 return createIsolatedEnvelope('uploaded',bytes,resume);
}

async function createIsolatedEnvelope(mode:'synthetic'|'uploaded',uploaded?:Uint8Array,resume?:string) {
 const parent=await realpath(tmpdir()),prefix=`esign-isolated-${mode}-`,directory=resume ?? await mkdtemp(join(parent,prefix));
 if(dirname(directory)!==parent || !new RegExp(`^${prefix}[a-zA-Z0-9]+$`).test(basename(directory)))throw new Error('Invalid isolated directory');
 const stat=await lstat(directory);
 if(!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || (process.getuid && stat.uid!==process.getuid()))throw new Error('Invalid isolated directory permissions');
 let state:State|undefined;
 if(resume) {
  const file=await open(join(directory,'state'),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {state=JSON.parse(await file.readFile('utf8')) as State;} finally {await file.close();}
  if(!state || !/^[a-f0-9]{64}$/.test(state.secret) || !/^[a-f0-9]{64}$/.test(state.sealKey) || !/^[a-f0-9]{64}$/.test(state.otpKey) || !/^[a-f0-9-]{36}$/.test(state.envelopeId) || typeof state.source!=='string')throw new Error('Invalid isolated state');
 }
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],d1Persist:join(directory,'d1'),r2Persist:join(directory,'r2')});
 try {
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS'),mail=await mf.getR2Bucket('TEST_MAIL');
  if(!state) {
   for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
    const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
   }
  }
  const secret=state?.secret ?? randomBytes(32).toString('hex'),sealKey=state?.sealKey ?? randomBytes(32).toString('hex'),otpKey=state?.otpKey ?? randomBytes(32).toString('hex');
  if(!state) {
   await db.prepare("INSERT INTO tenants VALUES ('synthetic')").run();
   await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'synthetic')").bind(digest(Buffer.from(secret))).run();
   await db.prepare("INSERT INTO tenant_page_origins VALUES ('synthetic',?)").bind(origin).run();
  }
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:otpKey,LOCAL_TEST_SEAL_KEY:sealKey};
  const invoke=async(path:string,init:RequestInit={},management=false)=>{
   const headers=new Headers(init.headers);headers.set('origin',origin);if(management)headers.set('authorization',`Bearer ${secret}`);
   return app.fetch(new Request('http://localhost'+path,{...init,headers}),env);
  };
  const requireStatus=async(response:Response,status:number)=>{if(response.status!==status)throw new Error(`Synthetic setup failed (${response.status})`);return response;};
  let bytes:Uint8Array,envelope:{id:string};
  if(state) {bytes=new Uint8Array(Buffer.from(state.source,'base64'));envelope={id:state.envelopeId};}
  else {
   if(mode==='uploaded') bytes=Uint8Array.from(uploaded!);
   else {const pdf=await PDFDocument.create();pdf.addPage();bytes=Uint8Array.from(await pdf.save());}
   const form=new FormData();form.set('file',new File([Uint8Array.from(bytes)],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["ana","marcus"]');
   const template=await (await requireStatus(await invoke('/v1/templates',{method:'POST',body:form},true),201)).json() as {id:string};
   const create={templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]};
   envelope=await (await requireStatus(await invoke('/v1/envelopes',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'generated'},body:JSON.stringify(create)},true),201)).json() as {id:string};
   await requireStatus(await invoke(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST'},true),204);
   const file=await open(join(directory,'state'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try {await file.writeFile(JSON.stringify({secret,sealKey,otpKey,envelopeId:envelope.id,source:Buffer.from(bytes).toString('base64')}));await file.sync();} finally {await file.close();}
   const dir=await open(directory,constants.O_RDONLY);try {await dir.sync();}finally {await dir.close();}
  }
  const base=`/v1/envelopes/${envelope.id}`;
  await requireStatus(await invoke(base,{},true),200);
  async function request(path:string,init:RequestInit={}) {
   const method=init.method ?? 'GET';
   const management=(method==='GET' && (path===base || path===`${base}/final-pdf` || path===`${base}/delivery-pdf` || path===`${base}/certificate`)) || (method==='POST' && (path===`${base}/process` || path===`${base}/finalize` || new RegExp(`^${base}/tasks/[a-zA-Z0-9-]+/recipient-view$`).test(path)));
   const recipient=(method==='POST' && ['/v1/page-sessions/exchange','/v1/signing/otp','/v1/signing/otp/verify','/v1/signing/sign'].includes(path)) || (method==='GET' && ['/v1/signing/current','/v1/signing/pdf'].includes(path));
   if(!management && !recipient)return new Response(null,{status:403});
   const response=await invoke(path,init,management);
   return method==='POST' && path==='/v1/signing/otp' ? withLocalTestOtp(response,mail) : response;
  }
  async function completionPhase() {
   const row=await db.prepare(`SELECT e.status,t.object_key AS template_key,a.id,a.object_key,a.sha256 FROM envelopes e
    JOIN templates t ON t.id=e.template_id AND t.tenant_id=e.tenant_id JOIN artifacts a ON a.envelope_id=e.id
    WHERE e.id=? AND e.tenant_id='synthetic'`).bind(envelope.id).first<{status:string;template_key:string;id:string;object_key:string;sha256:string}>();
   if(!row)throw new Error('Missing source');
   if(row.status==='FINALIZING' || row.status==='COMPLETED')return 'FINAL' as const;
   if(row.status!=='IN_PROGRESS')throw new Error('Invalid state');
   const records=await db.prepare('SELECT COUNT(*) AS n FROM signature_records WHERE envelope_id=?').bind(envelope.id).first<{n:number}>();
   if(!records || records.n!==0)throw new Error('Partial signing requires investigation');
   const events=await db.prepare('SELECT COUNT(*) AS n FROM signature_events WHERE envelope_id=?').bind(envelope.id).first<{n:number}>();
   const tasks=(await db.prepare('SELECT status,routing_order FROM tasks WHERE envelope_id=? ORDER BY routing_order').bind(envelope.id).all<{status:string;routing_order:number}>()).results;
   if(!events || events.n!==0 || tasks.length!==2 || tasks[0].status!=='ACTIVE' || tasks[0].routing_order!==1 || tasks[1].status!=='PENDING' || tasks[1].routing_order!==2 || row.id!==`d0:${envelope.id}` || row.object_key!==`envelopes/${envelope.id}/d0.pdf` || row.sha256!==digest(bytes))throw new Error('Invalid unsigned evidence');
   for(const key of [row.template_key,row.object_key]) {const object=await bucket.get(key);if(!object || digest(new Uint8Array(await object.arrayBuffer()))!==row.sha256)throw new Error('Source integrity failure');}
   const objects=await bucket.list({prefix:`envelopes/${envelope.id}/`,limit:1000});
   if(objects.truncated || objects.objects.length!==1 || objects.objects[0].key!==row.object_key)throw new Error('Unexpected evidence');
   return 'UNSIGNED' as const;
  }
  async function evidence() {
   const unsupported=await db.prepare('SELECT 1 FROM signature_events WHERE envelope_id=? AND event_version<>1 LIMIT 1').bind(envelope.id).first();
   if(unsupported)throw new Error('Real KMS/TSA sealing does not support positioned v2 signatures');
   const delivery=await request(`${base}/delivery-pdf`);if(delivery.status!==200)throw new Error('Synthetic envelope incomplete');
   const checked=await finalizeLocalTestEvidence(db,bucket as unknown as R2Bucket,'synthetic',envelope.id,new TextEncoder().encode(sealKey),true);
   if(!checked?.source || checked.signatures.length!==2 || checked.source.sha256!==digest(bytes))throw new Error('Synthetic evidence mismatch');
   const artifacts:Uint8Array[]=[];
   for(const key of [checked.source.object_key,...checked.signatures.map(row=>row.object_key)]) {const object=await bucket.get(key);if(!object)throw new Error('Synthetic artifact missing');artifacts.push(new Uint8Array(await object.arrayBuffer()));}
   artifacts.push(new Uint8Array(await delivery.arrayBuffer()));
   return {envelopeId:envelope.id,source:checked.source,signatures:checked.signatures,artifacts};
  }
  async function existingDelivery() {
   const checked=await finalizeLocalTestEvidence(db,bucket as unknown as R2Bucket,'synthetic',envelope.id,new TextEncoder().encode(sealKey),true);
   if(!checked || checked.signatures.length!==2 || checked.source?.sha256!==digest(bytes))throw new Error('Evidence mismatch');
   const {readExistingUploadedDelivery}=await import('./upload-existing-delivery.ts');
   const delivery=await readExistingUploadedDelivery(bucket as unknown as R2Bucket,envelope.id,checked.finalSha256);
   const artifacts:Uint8Array[]=[];
   for(const row of [checked.source,...checked.signatures]) {
    const object=await bucket.get(row.object_key);if(!object)throw new Error('Evidence artifact missing');
    const artifact=new Uint8Array(await object.arrayBuffer());
    if(digest(artifact)!==row.sha256)throw new Error('Evidence artifact mismatch');
    artifacts.push(artifact);
   }
   artifacts.push(delivery);
   const {checkExistingUploadedWorkspace}=await import('./synthetic-seal-orchestration.ts');
   await checkExistingUploadedWorkspace(directory,{envelopeId:envelope.id,source:checked.source,signatures:checked.signatures,artifacts});
   return delivery;
  }
  return {directory,envelopeId:envelope.id,request,completionPhase,evidence,existingDelivery,dispose:()=>mf.dispose()};
 } catch(error) {await mf.dispose();throw error;}
}
