// Registers a tenant with the E-sign Worker: the tenant (typically the host's organization id),
// a new management API key (only its SHA-256 is stored) and the host origins allowed to embed
// the editor. The recipient signing page is the Worker's own, the same for every tenant.
//
//   node scripts/provision-tenant.ts --tenant <id> --console-origin <origin> [--console-origin ...]
//     --key-file <path> (--local [--persist-to <dir>] | --remote --config <file>) [--dry-run]
//
// The key is written once to --key-file (mode 0600, never overwritten) and never printed.
// --remote changes a Cloudflare D1 database: run it only with authorization for that account. Its
// --config is the deployment's generated configuration (`node scripts/deploy.ts --config-only`).
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {frameAncestors} from '../src/signing-page.ts';

export type ProvisionPlan = {tenantId:string;keyHash:string;consoleOrigins:string[]};

const bareOrigin=(value:string)=>frameAncestors(value).length===1;

/** Idempotent SQL; a second run with a new key adds that key next to the existing ones. */
export function provisioningSql(plan:ProvisionPlan):string {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(plan.tenantId))throw new Error('invalid tenant id');
  if(!/^[0-9a-f]{64}$/.test(plan.keyHash))throw new Error('invalid key hash');
  if(!plan.consoleOrigins.length||!plan.consoleOrigins.every(bareOrigin))throw new Error('invalid console origin');
  // Every value is validated above to contain no quote, so quoting is enough.
  const q=(value:string)=>`'${value}'`;
  return [
    `INSERT OR IGNORE INTO tenants (id) VALUES (${q(plan.tenantId)});`,
    `INSERT OR IGNORE INTO api_keys (key_hash,tenant_id) VALUES (${q(plan.keyHash)},${q(plan.tenantId)});`,
    ...plan.consoleOrigins.map(origin=>`INSERT OR IGNORE INTO editor_allowed_origins (tenant_id,origin) VALUES (${q(plan.tenantId)},${q(origin)});`),
  ].join('\n')+'\n';
}

export type ProvisionArgs = {tenantId:string;consoleOrigins:string[];keyFile:string;target:'--local'|'--remote';config:string|undefined;persistTo?:string;dryRun:boolean};

export function parseProvisionArgs(argv:string[]):ProvisionArgs {
  const out:Partial<ProvisionArgs>&{consoleOrigins:string[];targets:string[]}={consoleOrigins:[],targets:[],dryRun:false};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i],value=()=>{const v=argv[++i];if(v===undefined)throw new Error(`${flag} needs a value`);return v;};
    if(flag==='--tenant')out.tenantId=value();
    else if(flag==='--console-origin')out.consoleOrigins.push(value());
    else if(flag==='--key-file')out.keyFile=value();
    else if(flag==='--config')out.config=value();
    else if(flag==='--persist-to')out.persistTo=value();
    else if(flag==='--local'||flag==='--remote')out.targets.push(flag);
    else if(flag==='--dry-run')out.dryRun=true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if(out.targets.length!==1)throw new Error('pass exactly one of --local or --remote');
  if(!out.tenantId||!out.keyFile||!out.consoleOrigins.length)throw new Error('--tenant, --console-origin and --key-file are required');
  if(out.persistTo&&out.targets[0]!=='--local')throw new Error('--persist-to is for --local only');
  if((out.targets[0]==='--remote')!==!!out.config)throw new Error('--config is required with --remote, and only then');
  return {tenantId:out.tenantId,consoleOrigins:out.consoleOrigins,keyFile:out.keyFile,target:out.targets[0] as ProvisionArgs['target'],config:out.config,...(out.persistTo?{persistTo:out.persistTo}:{}),dryRun:out.dryRun};
}

function main(args:ProvisionArgs){
  if(args.dryRun){
    process.stdout.write(provisioningSql({tenantId:args.tenantId,keyHash:'0'.repeat(64),consoleOrigins:args.consoleOrigins}).replace('0'.repeat(64),'<sha256 of the new key>'));
    return;
  }
  const key=randomBytes(32).toString('hex');
  const sql=provisioningSql({tenantId:args.tenantId,keyHash:createHash('sha256').update(key).digest('hex'),consoleOrigins:args.consoleOrigins});
  // Write the key first, so that a registered key is never lost; 'wx' refuses to overwrite.
  writeFileSync(args.keyFile,key+'\n',{mode:0o600,flag:'wx'});
  const dir=mkdtempSync(join(tmpdir(),'esign-provision-'));
  try {
    const file=join(dir,'provision.sql');writeFileSync(file,sql,{mode:0o600});
    const result=spawnSync('npx',['wrangler','d1','execute','DB',args.target,...(args.config?['--config',args.config]:[]),...(args.persistTo?['--persist-to',args.persistTo]:[]),'--file',file],{stdio:'inherit'});
    if(result.status!==0)throw new Error(`wrangler d1 execute failed; the key in ${args.keyFile} was not registered`);
  } finally {rmSync(dir,{recursive:true,force:true});}
  process.stdout.write(`Registered tenant ${args.tenantId}; its key is in ${args.keyFile}\n`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {main(parseProvisionArgs(process.argv.slice(2)));}
  catch(error){process.stderr.write(`${(error as Error).message}\n`);process.exit(1);}
}
