import { writeSync } from 'node:fs';
import { publishStep } from '../../scripts/synthetic-seal-storage.ts';
const [dir,mode,value]=process.argv.slice(2);
const validate=(bytes:Buffer)=>{if(!['first','second'].includes(bytes.toString())) throw new Error('invalid');};
const winner=await publishStep(dir,'signature',Buffer.from(value),validate,mode==='pause'?()=>{writeSync(1,'published\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}:undefined);
writeSync(1,`winner=${winner.toString()}\n`);
