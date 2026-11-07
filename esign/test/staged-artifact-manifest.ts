import assert from 'node:assert/strict';
import {lstat,readdir} from 'node:fs/promises';
import {join,parse,resolve,relative,sep} from 'node:path';

async function checkedPath(path:string,kind:'file'|'directory'):Promise<void> {
 const absolute=resolve(path), root=parse(absolute).root;
 let current=root;
 for(const component of relative(root,absolute).split(sep).filter(Boolean)) {
  current=join(current,component);
  const stat=await lstat(current);
  assert.ok(!stat.isSymbolicLink(),`symlink: ${current}`);
  assert.ok(current===absolute ? (kind==='file' ? stat.isFile() : stat.isDirectory()) : stat.isDirectory(),`unexpected path type: ${current}`);
 }
}

export async function validateStagedPaths(root:string):Promise<void> {
 await checkedPath(root,'directory');
 for(const path of ['SHA256.txt','wrangler.json','build/consolidated-worker.mjs','build/worker.mjs']) await checkedPath(join(root,path),'file');
 await stagedAssetPaths(join(root,'build/client'));
}

export async function stagedAssetPaths(directory:string):Promise<string[]> {
 await checkedPath(directory,'directory');
 const paths:string[]=[];
 for(const entry of await readdir(directory,{withFileTypes:true})) {
  if(entry.isDirectory()) for(const child of await stagedAssetPaths(join(directory,entry.name))) paths.push(`${entry.name}/${child}`);
  else {assert.ok(!entry.isSymbolicLink(),`symlink: ${join(directory,entry.name)}`); assert.ok(entry.isFile(),`non-file asset: ${entry.name}`); paths.push(entry.name);}
 }
 return paths.sort();
}

export function validateStagedManifest(manifest:string,assets:string[]):Map<string,string> {
 const pins=new Map<string,string>();
 for(const line of manifest.trimEnd().split('\n')) {
  const match=/^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(match,`invalid manifest line: ${line}`);
  assert.ok(!pins.has(match[2]),`duplicate manifest path: ${match[2]}`); pins.set(match[2],match[1]);
 }
 const expected=['wrangler.json','build/consolidated-worker.mjs','build/worker.mjs',...assets.map(p=>'build/client/'+p)].sort();
 assert.deepEqual([...pins.keys()].sort(),expected,'manifest must pin exactly the Worker, config and all staged assets');
 return pins;
}
