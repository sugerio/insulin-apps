/** Experimental atomic step primitive; not yet a complete recovery protocol. */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function publishStep(dir:string,name:string,candidate:Buffer,validate:(bytes:Buffer)=>void|Promise<void>,afterPublish?:()=>void):Promise<Buffer> {
  if(!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid step name');
  const target=join(dir,name);
  async function readExisting() {
    const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {if(!(await file.stat()).isFile()) throw new Error('Invalid step file');const value=await file.readFile();await validate(value);return value;}
    finally {await file.close();}
  }
  try {
    const existing=await readExisting();
    const directory=await open(dir,constants.O_RDONLY);
    try {await directory.sync();} finally {await directory.close();}
    return existing;
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  await validate(candidate);
  const temporary=join(dir,`.${name}-${randomBytes(16).toString('hex')}`);
  const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {await file.writeFile(candidate);await file.sync();} finally {await file.close();}
  let committed=false,failed=false;
  try {
    try {await link(temporary,target);} catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
    afterPublish?.();
    const directory=await open(dir,constants.O_RDONLY);
    try {await directory.sync();} finally {await directory.close();}
    const winner=await readExisting();
    committed=true;
    return winner;
  } catch(error) {failed=true;throw error;}
  finally {
    try {await unlink(temporary);}
    catch(error) {
      // A validated, directory-synced winner is committed; the private temporary file is retained for investigation.
      if(committed || failed) {try {console.warn(`Local evidence temporary cleanup failed for ${name}; preserve the private workspace.`);} catch {}}
      else throw error;
    }
  }
}
