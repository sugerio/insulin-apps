import {resolve,join,dirname} from 'node:path';
import {readdir,readFile,mkdir,realpath,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build as bundle} from 'esbuild';
import {build} from 'vite';

function gatewayOrigin(name:string):string {
 const value=process.env[name];
 if(!value)throw new Error(`${name} must be an exact HTTPS origin`);
 let url:URL;
 try {url=new URL(value);} catch {throw new Error(`${name} must be an exact HTTPS origin`);}
 if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)throw new Error(`${name} must be an exact HTTPS origin`);
 return value;
}
const previewSetting=process.env.ESIGN_CANDIDATE_SYNTHETIC_PREVIEW;
if(previewSetting && previewSetting!=='YES')throw new Error('ESIGN_CANDIDATE_SYNTHETIC_PREVIEW must be YES or unset');
const syntheticPreview=previewSetting==='YES';
const recipient=gatewayOrigin('VITE_CANDIDATE_GATEWAY_ORIGIN');
const editor=gatewayOrigin('VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN');
if(process.env.NODE_ENV && process.env.NODE_ENV!=='production')throw new Error('NODE_ENV must be production');
process.env.NODE_ENV='production';
const outDir=resolve(process.argv[2]??'dist-candidate-assets');
if(await realpath(dirname(outDir))!==dirname(outDir))throw new Error('Output parent must not contain symlinks');
// Exclusive creation ensures the build never clears or overwrites an existing directory.
await mkdir(outDir);
if(syntheticPreview) {
 await mkdir(join(outDir,'client'));
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Test only preview</title></head><body><main><h1>TEST ONLY</h1><p>Services, verification email and signing are unavailable. Do not enter or upload real data.</p></main></body></html>';
 for(const page of ['candidate.html','candidate-editor.html'])await writeFile(join(outDir,'client',page),html);
} else {
 await build({configFile:false,root:resolve('ui'),publicDir:false,define:{'import.meta.env.VITE_CANDIDATE_GATEWAY_ORIGIN':JSON.stringify(recipient),'import.meta.env.VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN':JSON.stringify(editor)},build:{outDir:join(outDir,'client'),emptyOutDir:false,rollupOptions:{input:{candidate:resolve('ui/candidate.html'),candidateEditor:resolve('ui/candidate-editor.html')}}}});
}

const files:Record<string,{sha256:string;length:number;type:string}>={};
const types:Record<string,string>={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',woff:'font/woff',woff2:'font/woff2',png:'image/png',svg:'image/svg+xml'};
async function collect(dir:string,prefix:string):Promise<void> {
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  const name=prefix+'/'+entry.name;
  if(entry.isDirectory()) { if(prefix!==''||entry.name!=='assets') throw Error('Unexpected directory'); await collect(join(dir,entry.name),name); continue; }
  if(!entry.isFile() || !(prefix==='' ? ['candidate.html','candidate-editor.html'].includes(entry.name) : /^assets$/.test(prefix.slice(1)) && /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(entry.name))) throw Error('Unexpected candidate asset: '+name);
  const type=types[entry.name.split('.').pop()!]; if(!type) throw Error('Unsupported candidate asset type: '+name);
  const bytes=await readFile(join(dir,entry.name));
  files[name]={sha256:createHash('sha256').update(bytes).digest('hex'),length:bytes.length,type};
 }
}
await collect(join(outDir,'client'),'');
if(!files['/candidate.html']||!files['/candidate-editor.html']) throw Error('Missing candidate page');
await bundle({entryPoints:['src/candidate-page-host.ts'],outfile:join(outDir,'worker.mjs'),bundle:true,format:'esm',platform:'browser',define:{__CANDIDATE_MANIFEST__:JSON.stringify({recipientOrigin:recipient,editorOrigin:editor,files})}});

if(recipient===editor) await bundle({entryPoints:['src/consolidated-worker.ts'],outfile:join(outDir,'consolidated-worker.mjs'),bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],define:{__CANDIDATE_MANIFEST__:JSON.stringify({recipientOrigin:recipient,editorOrigin:editor,files})}});
